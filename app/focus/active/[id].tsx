import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useKeepAwake } from "expo-keep-awake";
import { FocusTask, isFocusTask } from "@/types/event";
import { useAppData } from "@/context/AppDataContext";
import { useFocusSession } from "@/hooks/useFocusSession";
import { formatRemainingClock } from "@/services/focusTimerEngine";
import { canEditEvent } from "@/utils/permissions";
import { abandonActiveFocusSession, getActiveSessionConflict } from "@/storage/focusSessionRepository";
import { isBeforeScheduledStart } from "@/utils/focusSchedule";
import { colors } from "@/theme/colors";
import { minTapSize, spacing } from "@/theme/spacing";
import { LoadingView } from "@/components/common/LoadingView";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { CircularGauge } from "@/components/focus/CircularGauge";
import { RestrictedAppsList } from "@/components/focus/RestrictedAppsList";
import { useLocale } from "@/context/LocaleContext";
import { toFriendlyMessage } from "@/utils/friendlyError";

function showSaveFailedAlert(t: ReturnType<typeof useLocale>["t"], e: unknown) {
  Alert.alert(
    t("common.saveFailedTitle"),
    toFriendlyMessage(e instanceof Error ? e.message : undefined, t("friendlyError.localPersistenceFailed"), t)
  );
}

export default function FocusActiveScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const { events, loading, saveEvent, sharedCalendars, refreshFocusHistory } = useAppData();
  const { id, autostart, source } = useLocalSearchParams<{
    id: string;
    autostart?: string;
    /** "notification" のときだけ、開始時刻より前は自動開始しない（通知経由のautostartのみガードする）。
     *  予定詳細画面の「集中を開始」ボタン等、他の経路からの早期開始は従来どおり許可する。 */
    source?: string;
  }>();
  // 通知経由のautostartが開始時刻前だったため、集中セッションを作らず案内だけ表示する状態。
  const [blockedBeforeStart, setBlockedBeforeStart] = useState(false);

  // 集中中は画面スリープを防止する。画面を離れると自動的に解除される。
  useKeepAwake();

  const task = useMemo(
    () => events.find((e) => e.id === id && isFocusTask(e)) as FocusTask | undefined,
    [events, id]
  );

  const isShared = useMemo(
    () => sharedCalendars.some((s) => s.calendar.id === task?.calendarId),
    [sharedCalendars, task]
  );

  // 集中モードを最後まで完了したときだけ呼ばれる（途中終了では呼ばれない）。
  // FocusTaskの completed を AppDataContext.saveEvent 経由で更新する
  // （Repositoryへ直接書き込まない。useFocusSession自体はAppDataContextに依存しない設計を維持）。
  // viewer権限の共有予定は勝手に完了更新しない。元予定が既に存在しない場合も安全にスキップする
  // （分析記録は呼び出し元のuseFocusSession.complete()で既に保存済みのため失われない）。
  const handleFocusCompleted = useCallback(async () => {
    if (!task) return;
    if (!canEditEvent(task, sharedCalendars)) return;
    try {
      await saveEvent({ ...task, completed: true, updatedAt: new Date().toISOString() });
    } catch (e) {
      console.warn("[FocusActiveScreen] 元予定の完了更新に失敗しました", e);
    }
  }, [task, saveEvent, sharedCalendars]);

  const timer = useFocusSession(id, handleFocusCompleted);
  const { isLoaded, session, start } = timer;
  const startedRef = useRef(false);

  useEffect(() => {
    if (
      autostart === "1" &&
      !startedRef.current &&
      isLoaded &&
      !session &&
      task
    ) {
      // 通知経由のautostartだけ、現在時刻が予定開始時刻より前なら自動開始しない
      // （端末時刻のずれ・通知の配信遅延・古い通知データを考慮し、画面側で最終確認する）。
      // 予定詳細画面の「集中を開始」ボタン等、他の経路からの早期開始はこのガードの対象外。
      if (source === "notification" && isBeforeScheduledStart(task, Date.now())) {
        startedRef.current = true;
        setBlockedBeforeStart(true);
        return;
      }
      startedRef.current = true;
      (async () => {
        // [P0130 DATA-F073-010] 通知経由のautostartでも、判定を読めなかった場合は
        // 「競合なし」とみなして開始してはならない。
        let conflict: Awaited<ReturnType<typeof getActiveSessionConflict>>;
        try {
          conflict = await getActiveSessionConflict(task.id);
        } catch (e) {
          if (__DEV__) {
            console.warn("[focusActive] 競合判定を読めなかったため自動開始を中止しました", e);
          }
          return;
        }
        if (conflict) {
          Alert.alert(
            t("focusActive.conflictTitle"),
            t("focusActive.conflictMessage", { title: conflict.titleSnapshot }),
            [
              {
                text: t("focusActive.conflictGoToActive"),
                onPress: () =>
                  router.replace({
                    pathname: "/focus/active/[id]",
                    params: { id: conflict.sourceEventId },
                  }),
              },
              {
                text: t("focusActive.conflictEndAndStartNew"),
                style: "destructive",
                onPress: async () => {
                  try {
                    await abandonActiveFocusSession();
                    await refreshFocusHistory();
                    await start(task, isShared ? "shared" : "local");
                  } catch (e) {
                    // 終了処理に失敗した場合、古いセッションが残ったまま新規開始してしまうと
                    // 状態が壊れるため、ここでは新規開始まで進めずエラーだけを知らせる。
                    showSaveFailedAlert(t, e);
                  }
                },
              },
              {
                text: t("focusActive.conflictCancelNewStart"),
                style: "cancel",
                onPress: () => router.back(),
              },
            ]
          );
          return;
        }
        await start(task, isShared ? "shared" : "local");
      })();
    }
  }, [autostart, isLoaded, session, start, task, isShared, router, t, source, refreshFocusHistory]);

  if (loading || !timer.isLoaded) return <LoadingView />;

  if (!task) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.notFound}>{t("focusDetail.notFoundText")}</Text>
      </SafeAreaView>
    );
  }

  // 通知経由のautostartが開始時刻前だった場合の安全な案内（内部時刻・デバッグ情報は出さない）。
  if (blockedBeforeStart) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Ionicons name="time-outline" size={48} color={colors.textTertiary} />
          <Text style={styles.title}>{task.title}</Text>
          <Text style={styles.subTitle}>
            {t("focusActive.notYetStartableMessage", { start: task.startTime })}
          </Text>
          <PrimaryButton
            label={t("common.close")}
            onPress={() => router.back()}
            style={{ marginTop: spacing.xl }}
          />
        </View>
      </SafeAreaView>
    );
  }

  const handleManualStart = async () => {
    // [P0130 DATA-F073-010] 競合判定の読み取りが失敗した場合、
    // 「競合なし」とみなして開始してはならない（進行中セッションを上書きし得る）。
    // 判定できないときは開始を認可せず、そのまま何もしない（再試行可能）。
    let conflict: Awaited<ReturnType<typeof getActiveSessionConflict>>;
    try {
      conflict = await getActiveSessionConflict(task.id);
    } catch (e) {
      if (__DEV__) {
        console.warn("[focusActive] 競合判定を読めなかったため開始を中止しました", e);
      }
      return;
    }
    if (conflict) {
      Alert.alert(
        t("focusActive.conflictTitle"),
        t("focusActive.conflictMessage", { title: conflict.titleSnapshot }),
        [
          {
            text: t("focusActive.conflictGoToActive"),
            onPress: () =>
              router.replace({
                pathname: "/focus/active/[id]",
                params: { id: conflict.sourceEventId },
              }),
          },
          {
            text: t("focusActive.conflictEndAndStartNew"),
            style: "destructive",
            onPress: async () => {
              try {
                await abandonActiveFocusSession();
                await refreshFocusHistory();
                await start(task, isShared ? "shared" : "local");
              } catch (e) {
                showSaveFailedAlert(t, e);
              }
            },
          },
          { text: t("focusActive.conflictCancelNewStart"), style: "cancel" },
        ]
      );
      return;
    }
    await start(task, isShared ? "shared" : "local");
  };

  if (!session) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.title}>{task.title}</Text>
          <Text style={styles.subTitle}>
            {t("focusActive.preStartDescription", { start: task.startTime, duration: task.durationMinutes })}
          </Text>
          <PrimaryButton
            label={t("focusActive.startButton")}
            onPress={handleManualStart}
            style={{ marginTop: spacing.xl }}
          />
          <PrimaryButton
            label={t("common.close")}
            variant="ghost"
            onPress={() => router.back()}
            style={{ marginTop: spacing.sm }}
          />
        </View>
      </SafeAreaView>
    );
  }

  const handleEarlyExit = () => {
    const penalty =
      task.unlockCondition.type === "calculation"
        ? t("focusActive.unlockPenaltyText", { count: task.unlockCondition.count ?? 0 })
        : "";
    Alert.alert(
      t("focusActive.cancelConfirmTitle"),
      t("focusActive.cancelConfirmMessage", { penalty }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("focusActive.endButton"),
          style: "destructive",
          onPress: async () => {
            try {
              await timer.cancel();
              // 中断でも履歴には1件追加されるため、Context側のfocusHistoryを最新化する
              // （completedの更新は行わない＝途中終了では変更しない）。
              await refreshFocusHistory();
              router.back();
            } catch (e) {
              // 保存に失敗した場合は画面を閉じず、この画面に留まって再試行できるようにする。
              showSaveFailedAlert(t, e);
            }
          },
        },
      ]
    );
  };

  const handleMenuPress = () => {
    Alert.alert(
      t("focusActive.menuTitle"),
      undefined,
      [
        { text: t("focusActive.endEarlyButton"), style: "destructive", onPress: handleEarlyExit },
        { text: t("common.cancel"), style: "cancel" },
      ]
    );
  };

  const handleComplete = async () => {
    try {
      await timer.complete();
      await refreshFocusHistory();
    } catch (e) {
      showSaveFailedAlert(t, e);
      return;
    }
    // 「閉じる」はAlertを閉じるだけで、画面自体は閉じない（session.status==="completed"の
    // 既存完了カード表示はこのAlert表示時点で既に裏側でレンダリング済みのため、
    // ここで何もしなければそのまま completed カードに留まる）。
    Alert.alert(t("focusActive.completedTitle"), undefined, [
      { text: t("common.close"), style: "cancel" },
      {
        text: t("focusActive.viewRecordsButton"),
        onPress: () => router.replace("/records"),
      },
    ]);
  };

  // 終端状態（completed/cancelled）: 集中結果を簡潔に表示し、閉じるだけの画面にする。
  if (session.status === "completed" || session.status === "cancelled") {
    const isCompleted = session.status === "completed";
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Ionicons
            name={isCompleted ? "checkmark-circle" : "close-circle-outline"}
            size={64}
            color={isCompleted ? colors.meeting : colors.textTertiary}
          />
          <Text style={styles.title}>
            {isCompleted ? t("focusActive.completedTitle") : t("focusActive.cancelledTitle")}
          </Text>
          <Text style={styles.subTitle}>{session.titleSnapshot}</Text>
          <PrimaryButton
            label={t("common.close")}
            onPress={() => router.back()}
            style={{ marginTop: spacing.xl }}
          />
        </View>
      </SafeAreaView>
    );
  }

  const statusLabel =
    session.status === "paused"
      ? t("focusActive.statusPaused")
      : session.status === "ready_to_complete"
        ? t("focusActive.statusReady")
        : t("focusActive.statusRunning");

  const interruptionMinutes = Math.round(timer.elapsedMs >= 0 ? session.totalPausedDurationMs / 60000 : 0);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <PressableClose onPress={() => router.back()} label={t("common.close")} />
        <Text style={styles.headerTitle}>{t("focusActive.screenTitle")}</Text>
        <PressableMenu onPress={handleMenuPress} label={t("focusActive.menuA11y")} />
      </View>

      <View style={styles.taskBadge}>
        <Ionicons name="lock-closed" size={13} color={colors.primaryStrong} style={{ marginRight: 4 }} />
        <Text style={styles.taskBadgeText}>{t("focusActive.inProgressLabel")}</Text>
      </View>
      <Text style={styles.taskTitle}>{session.titleSnapshot}</Text>
      <Text style={styles.rangeText}>
        {t("focusActive.rangeSummary", { start: task.startTime, duration: task.durationMinutes })}
      </Text>

      <CircularGauge
        progress={timer.progress}
        primaryText={formatRemainingClock(timer.remainingMs)}
        secondaryText={`/ ${formatRemainingClock(session.plannedDurationMs)}`}
      />

      <View style={[styles.statusPill, session.status === "paused" && styles.statusPillPaused]}>
        <Text style={styles.statusPillText}>{statusLabel}</Text>
      </View>

      <View style={styles.statsRow}>
        <StatCell
          icon="time-outline"
          label={t("focusActive.statElapsed")}
          value={formatRemainingClock(timer.elapsedMs)}
        />
        <StatCell
          icon="pause-circle-outline"
          label={t("focusActive.statInterruptions")}
          value={t("focusActive.statCountSuffix", { count: session.interruptionCount })}
        />
        <StatCell
          icon="hourglass-outline"
          label={t("focusActive.statPausedDuration")}
          value={t("focusActive.statMinutesSuffix", { count: interruptionMinutes })}
        />
        <StatCell
          icon="flag-outline"
          label={t("focusActive.statPlanned")}
          value={t("focusActive.statMinutesSuffix", { count: task.durationMinutes })}
        />
      </View>

      <RestrictedAppsList appIds={task.restrictedApps} />

      <View style={styles.actions}>
        <PrimaryButton
          label={session.status === "paused" ? t("focusActive.resumeButton") : t("focusActive.pauseButton")}
          variant="secondary"
          onPress={() => (session.status === "paused" ? timer.resume() : timer.pause())}
        />
        <PrimaryButton
          label={t("focusActive.completeButton")}
          variant="primary"
          onPress={handleComplete}
          disabled={!timer.isReadyToComplete}
          style={{ marginTop: spacing.sm }}
        />
        {!timer.isReadyToComplete && (
          <Text style={styles.completeHint}>{t("focusActive.completeHint")}</Text>
        )}
        {task.unlockCondition.type === "calculation" && (
          <Text style={styles.unlockNote}>
            {t("focusActive.unlockNote", { count: task.unlockCondition.count ?? 0 })}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

function PressableClose({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={styles.headerIconButton}
    >
      <Ionicons name="close" size={24} color={colors.textPrimary} />
    </Pressable>
  );
}

function PressableMenu({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={styles.headerIconButton}
    >
      <Ionicons name="ellipsis-horizontal" size={22} color={colors.textPrimary} />
    </Pressable>
  );
}

function StatCell({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.statCell}>
      <Ionicons name={icon} size={16} color={colors.primary} />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface,
    alignItems: "center",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  notFound: {
    marginTop: spacing.xxl,
    textAlign: "center",
    color: colors.textSecondary,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  headerIconButton: {
    width: minTapSize,
    height: minTapSize,
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    margin: 0,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: colors.textPrimary,
    textAlign: "center",
  },
  subTitle: {
    marginTop: spacing.sm,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
  },
  taskBadge: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.lg,
    backgroundColor: colors.primarySoft,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  taskBadgeText: {
    color: colors.primaryStrong,
    fontWeight: "700",
    fontSize: 13,
  },
  taskTitle: {
    marginTop: spacing.sm,
    fontSize: 22,
    fontWeight: "800",
    color: colors.textPrimary,
    textAlign: "center",
  },
  rangeText: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: 13,
    marginBottom: spacing.md,
  },
  statusPill: {
    marginTop: spacing.md,
    backgroundColor: colors.primarySoft,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  statusPillPaused: {
    backgroundColor: colors.surfaceAlt,
  },
  statusPillText: {
    color: colors.primaryStrong,
    fontWeight: "700",
    fontSize: 13,
  },
  statsRow: {
    flexDirection: "row",
    width: "100%",
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    justifyContent: "space-between",
  },
  statCell: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  statValue: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.textPrimary,
    marginTop: 2,
  },
  statLabel: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  actions: {
    width: "100%",
    paddingHorizontal: spacing.xl,
    marginTop: spacing.xl,
    marginBottom: spacing.lg,
  },
  completeHint: {
    marginTop: spacing.xs,
    fontSize: 12,
    color: colors.textTertiary,
    textAlign: "center",
  },
  unlockNote: {
    marginTop: spacing.sm,
    fontSize: 12,
    color: colors.textTertiary,
    textAlign: "center",
  },
});
