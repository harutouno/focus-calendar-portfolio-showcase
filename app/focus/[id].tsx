import React, { useMemo } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { FocusTask, isFocusTask } from "@/types/event";
import { useAppData } from "@/context/AppDataContext";
import {
  FocusTaskForm,
  FocusTaskFormValue,
} from "@/components/forms/FocusTaskForm";
import { LoadingView } from "@/components/common/LoadingView";
import { abandonActiveFocusSession, getActiveSessionConflict } from "@/storage/focusSessionRepository";
import { colors } from "@/theme/colors";
import { useLocale } from "@/context/LocaleContext";
import { toFriendlyMessage } from "@/utils/friendlyError";

export default function EditFocusTaskScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const {
    events,
    saveEvent,
    removeEvent,
    loading,
    userCalendars,
    sharedCalendars,
    recordLastUsedCalendar,
    refreshFocusHistory,
  } = useAppData();
  const { id } = useLocalSearchParams<{ id: string }>();

  const task = useMemo(
    () => events.find((e) => e.id === id && isFocusTask(e)) as FocusTask | undefined,
    [events, id]
  );

  if (loading) return <LoadingView />;

  if (!task) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>{t("focusDetail.notFoundText")}</Text>
      </View>
    );
  }

  const initial: FocusTaskFormValue = {
    title: task.title,
    date: task.date,
    startTime: task.startTime,
    durationMinutes: task.durationMinutes,
    restrictedApps: task.restrictedApps,
    notificationMinutes: task.notification.enabled ? task.notification.minutesBefore : -1,
    repeatType: task.repeat.type,
    unlockConditionType: task.unlockCondition.type,
    unlockCount: task.unlockCondition.count ?? 30,
    memo: task.memo ?? "",
    calendarId: task.calendarId,
  };

  const handleSave = async (value: FocusTaskFormValue) => {
    const updated: FocusTask = {
      ...task,
      title: value.title.trim(),
      date: value.date,
      startTime: value.startTime,
      durationMinutes: value.durationMinutes,
      restrictedApps: value.restrictedApps,
      unlockCondition: {
        type: value.unlockConditionType,
        count:
          value.unlockConditionType === "calculation"
            ? value.unlockCount
            : undefined,
      },
      calendarId: value.calendarId,
      notification: {
        enabled: value.notificationMinutes >= 0,
        minutesBefore: Math.max(value.notificationMinutes, 0),
      },
      repeat: { type: value.repeatType },
      memo: value.memo.trim() || undefined,
      updatedAt: new Date().toISOString(),
    };
    await saveEvent(updated);
    await recordLastUsedCalendar(value.calendarId);
    router.back();
  };

  const handleDelete = async () => {
    await removeEvent(task.id, task.calendarId);
    router.back();
  };

  const handleStartFocus = async () => {
    // 既に別の予定を集中中の場合は、そちらを差し置いて新しいセッションを開始しない
    // （アクティブセッションは常に1件のみ許可する。実際の開始処理自体は
    // /focus/active/[id]側でも同じ判定を行う二重ガードになっているが、ここで先に
    // 案内することでボタンを押した直後に画面が跳ね返るような体験を避ける）。
    // [P0130 DATA-F073-010] 判定を読めなかった場合は開始へ進ませない
    // （/focus/active/[id]側の二重ガードも同じ契約でfail-closedする）。
    let conflict: Awaited<ReturnType<typeof getActiveSessionConflict>>;
    try {
      conflict = await getActiveSessionConflict(task.id);
    } catch (e) {
      if (__DEV__) {
        console.warn("[focusDetail] 競合判定を読めなかったため開始を中止しました", e);
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
              router.push({
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
                router.push({
                  pathname: "/focus/active/[id]",
                  params: { id: task.id, autostart: "1" },
                });
              } catch (e) {
                // 終了処理に失敗した場合、古いセッションが残ったまま新規開始してしまうと
                // 状態が壊れるため、ここでは新規開始まで進めずエラーだけを知らせる。
                Alert.alert(
                  t("common.saveFailedTitle"),
                  toFriendlyMessage(
                    e instanceof Error ? e.message : undefined,
                    t("friendlyError.localPersistenceFailed"),
                    t
                  )
                );
              }
            },
          },
          { text: t("focusActive.conflictCancelNewStart"), style: "cancel" },
        ]
      );
      return;
    }
    router.push({
      pathname: "/focus/active/[id]",
      params: { id: task.id, autostart: "1" },
    });
  };

  return (
    <FocusTaskForm
      initial={initial}
      isEditing
      userCalendars={userCalendars}
      sharedCalendars={sharedCalendars}
      onSave={handleSave}
      onDelete={handleDelete}
      onStartFocus={handleStartFocus}
      completed={task.completed}
    />
  );
}

const styles = StyleSheet.create({
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
  },
  notFoundText: {
    color: colors.textSecondary,
    fontSize: 15,
  },
});
