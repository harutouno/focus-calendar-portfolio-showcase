import React, { useMemo, useRef } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { NormalEvent, isNormalEvent } from "@/types/event";
import { RecurringEditScope, useAppData } from "@/context/AppDataContext";
import { useAuth } from "@/context/AuthContext";
import {
  NormalEventForm,
  NormalEventFormValue,
} from "@/components/forms/NormalEventForm";
import { LoadingView } from "@/components/common/LoadingView";
import { colors } from "@/theme/colors";
import { useLocale } from "@/context/LocaleContext";
import { TFunction } from "@/i18n/translations";
import { toFriendlyMessage } from "@/utils/friendlyError";
import {
  STALE_SHARED_MUTATION_IDENTITY_MESSAGE,
  SharedMutationIdentity,
  isCurrentSharedMutationIdentity,
  runCurrentSharedMutation,
} from "@/auth/sharedMutationIdentity";
import { resolveEndDate } from "@/utils/time";

function isStaleMutationError(e: unknown): boolean {
  return e instanceof Error && e.message === STALE_SHARED_MUTATION_IDENTITY_MESSAGE;
}

/**
 * P0040: C14統合経路の新しい失敗分類。それぞれ既存のcommon.saveFailedTitle Alertへ
 * 異なる本文をマップするためのmarker（18節: 新しいModal/画面は追加しない、
 * 既存のエラー表示を使い分けるだけ）。
 */
const UNSUPPORTED_CROSS_DOMAIN_MOVE_MESSAGE = "P0040_UNSUPPORTED_CROSS_DOMAIN_MOVE";
const UNSUPPORTED_RECURRING_CALENDAR_MOVE_MESSAGE = "P0040_UNSUPPORTED_RECURRING_CALENDAR_MOVE";
const MIGRATION_PENDING_RETRY_MESSAGE = "P0040_MIGRATION_PENDING_RETRY";
/**
 * soft-delete済みが混ざっている（=移行中/削除処理中の過渡状態）場合のmarker。
 * この状態ではsaveEvent・C14のどちらも一切呼ばず、いかなる副作用の前にfail-closedで
 * 拒否する。
 */
/**
 * [P0078 DATA-F014-001] 同一カレンダー内の共有予定編集CAS保存の非committed結果を、
 * 既存のmarker error規約に沿ってhandleSaveFailureへ伝える。conflictは「自分が開いた後に
 * 他の人が先に保存した」ことを意味し、通常の保存失敗Alertとは異なる文言・扱いにする
 * （フォーム入力は保持し、画面遷移もしない——正本§2の要求）。
 */
const NORMAL_EVENT_EDIT_CONFLICT_MESSAGE = "P0078_NORMAL_EVENT_EDIT_CONFLICT";
const NORMAL_EVENT_EDIT_NOT_FOUND_MESSAGE = "P0078_NORMAL_EVENT_EDIT_NOT_FOUND";
const NORMAL_EVENT_EDIT_NOT_AUTHORIZED_MESSAGE = "P0078_NORMAL_EVENT_EDIT_NOT_AUTHORIZED";
const NORMAL_EVENT_EDIT_RETRYABLE_MESSAGE = "P0078_NORMAL_EVENT_EDIT_RETRYABLE";
const NORMAL_EVENT_EDIT_UNKNOWN_MESSAGE = "P0078_NORMAL_EVENT_EDIT_UNKNOWN";

function isMarkerError(e: unknown, message: string): boolean {
  return e instanceof Error && e.message === message;
}


/**
 * P0040（4節）: edit-session immutable source snapshot。編集セッション開始時点の
 * カレンダーID・共有/端末内区分・updated_atを、以後のcalendar picker操作や
 * 共有データrefreshによる再レンダーで一切変えずに保持する。event.id自体が変わる
 * （＝真に別のeventへのscreen遷移）場合のみ再構築してよい。
 */
interface EditSourceSnapshot {
  eventId: string;
  sourceCalendarId: string;
  sourceIsCloud: boolean;
  expectedUpdatedAt: string;
}

/**
 * recurringGroupIdを持つ予定（一括作成された繰り返し予定）の場合に、
 * 編集・削除の適用範囲を選んでもらうダイアログ。選択後にonSelectを呼ぶ。
 * 通常予定（recurringGroupId未設定）ではこのダイアログ自体を呼び出さない。
 */
/**
 * P0041（6節）: onCancelは省略可能——handleDelete側の既存呼び出しは変更しない
 * （save single-flight lockの解放が必要なのはhandleSave側だけのため）。
 * Alertの「キャンセル」ボタンにはstyle:"cancel"だけでなくonPressも必要——RNの
 * Alert.alertは"cancel"styleのボタンにonPressを渡しても自動では呼ばれないため、
 * 明示的にonCancelを渡さない限りキャンセル時のクリーンアップ（lock解放等）は
 * 一切実行されない。
 */
function askRecurringScope(
  t: TFunction,
  message: string,
  onSelect: (scope: RecurringEditScope) => void,
  onCancel?: () => void
) {
  Alert.alert(t("eventDetail.recurringAlertTitle"), message, [
    { text: t("eventDetail.scopeThisOnly"), onPress: () => onSelect("single") },
    { text: t("eventDetail.scopeThisAndFuture"), onPress: () => onSelect("following") },
    { text: t("eventDetail.scopeAll"), onPress: () => onSelect("all") },
    { text: t("common.cancel"), style: "cancel", onPress: onCancel },
  ]);
}

export default function EditEventScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const { user, sessionInstanceId } = useAuth();
  const {
    events,
    shareTargets,
    userCalendars,
    sharedCalendars,
    saveEvent,
    saveSharedNormalEventWithVersionCheck,
    removeEvent,
    updateRecurringEvents,
    removeRecurringEvents,
    syncStatusByEventId,
    loading,
  } = useAppData();
  const { id } = useLocalSearchParams<{ id: string }>();

  const event = useMemo(
    () => events.find((e) => e.id === id && isNormalEvent(e)) as NormalEvent | undefined,
    [events, id]
  );

  // P0040（4節）: 「render中に計算し、refへcacheし、比較して更新する」React標準の
  // イディオム。event.idが前回と同じ限りsourceSnapshotRefは一切書き換えない
  // （共有データrefreshでeventオブジェクト自体が新しい参照へ差し替わっても、
  // 中身のcalendarId等をsnapshotへ反映させない——4節が明示的に禁止する
  // 「shared-data refreshでsourceCalendarIdがtargetへ追従する」を防ぐ）。
  const sourceSnapshotRef = useRef<EditSourceSnapshot | null>(null);
  /**
   * P0041（5節/6節、invariant D）: 同一edit screenからのsave attemptを1本だけに絞る
   * screen-level同期lock。最初のawaitより前にacquireし、非recurring・recurringの
   * どちらの経路でも、成功・失敗・fail-closedの区別なく必ず解放する（poison防止）。
   * recurring編集ではaskRecurringScopeのAlert表示中もlockを保持し続け、scope選択
   * またはキャンセルのどちらで抜けても解放する。
   */
  const saveAttemptInFlightRef = useRef(false);
  if (
    event &&
    (sourceSnapshotRef.current === null || sourceSnapshotRef.current.eventId !== event.id)
  ) {
    sourceSnapshotRef.current = {
      eventId: event.id,
      sourceCalendarId: event.calendarId,
      sourceIsCloud: sharedCalendars.some((s) => s.calendar.id === event.calendarId),
      expectedUpdatedAt: event.updatedAt,
    };
  }

  if (loading) return <LoadingView />;

  if (!event) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>{t("eventDetail.notFoundText")}</Text>
      </View>
    );
  }

  // eventが存在する時点で、直前のif文により必ずeventId一致のsnapshotが用意されている。
  const sourceSnapshot = sourceSnapshotRef.current as EditSourceSnapshot;

  const isSharedEvent = sharedCalendars.some((s) => s.calendar.id === event.calendarId);
  const syncStatus = isSharedEvent ? syncStatusByEventId[event.id] ?? "synced" : undefined;

  const initial: NormalEventFormValue = {
    title: event.title,
    date: event.date,
    startTime: event.startTime,
    endTime: event.endTime,
    allDay: event.allDay,
    location: event.location ?? "",
    memo: event.memo ?? "",
    calendarId: event.calendarId,
    notificationMinutes: event.notification.enabled
      ? event.notification.minutesBefore
      : -1,
    repeatType: event.repeat.type,
    shareWith: event.shareWith,
  };

  // Round 12（SEC-F007-004、P1-5）: 対象カレンダーが共有の場合、変更後（saveEvent/
  // updateRecurringEvents/removeEvent/removeRecurringEvents）直後にidentityの現在性を
  // 確認してからrouter.back()する（runCurrentSharedMutation）。stale化した場合は
  // STALE_SHARED_MUTATION_IDENTITY_MESSAGEを持つ例外を投げ、呼び出し元がこれを検知して
  // 失敗Alertを出さず・画面遷移もせず静かに終了する。ローカルカレンダーは従来どおり無関係。
  const identity: SharedMutationIdentity | null =
    user?.id && sessionInstanceId ? { userId: user.id, sessionInstanceId } : null;

  /**
   * P0040（6節）: single-event save（非recurring・またはrecurring scope="single"）の
   * 唯一の分岐点。updateRecurringEvents自身のscope="single"分岐が内部で直接saveEventを
   * 呼んでしまうため（investigation, 3節）、両方の呼び出し元がここを必ず経由するように
   * 統一し、「ここでだけ判定してupdateRecurringEventsへ委ねると、following/all経由の
   * single相当ケースがルーティングを迂回する」事故を防ぐ。
   */
  const performSingleEventSave = async (updated: NormalEvent): Promise<void> => {
    const isCloudTarget = sharedCalendars.some((s) => s.calendar.id === updated.calendarId);
    // P0040（4節）: sourceの共有/端末内区分は、liveのevent.calendarIdではなく
    // 編集セッション開始時点のsourceSnapshotから判定する。
    const wasCloudSource = sourceSnapshot.sourceIsCloud;
    const calendarChanged = updated.calendarId !== sourceSnapshot.sourceCalendarId;

    // Route D: 端末内→端末内。C14は一切関与しない。
    if (!wasCloudSource && !isCloudTarget) {
      await saveEvent(updated);
      return;
    }

    // Route E（6節/10節）: 端末内↔共有の相互移動はfail-closed。DATA-F007-005
    // （local↔shared移動の実装）は本batch対象外・明示的に実装禁止のため、
    if (wasCloudSource !== isCloudTarget) {
      throw new Error(UNSUPPORTED_CROSS_DOMAIN_MOVE_MESSAGE);
    }

    // ここから先はsource・targetとも共有カレンダー。identity保護が必須。
    if (!identity) throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);

    // Route A: 同一カレンダー内の共有保存。C14は一切呼ばない（6節）。
    // [P0078 DATA-F014-001] 無条件upsertのsaveEventではなく、編集セッション開始時点の
    // expectedUpdatedAt（sourceSnapshot、event.idが変わらない限り再構築されない）を
    // 用いたCAS保存を使う。他の編集者が先に保存していた場合（conflict）は、いかなる
    // フォーム状態も画面遷移も変更せず、handleSaveFailure側の専用メッセージへ委ねる。
    if (!calendarChanged) {
      await runCurrentSharedMutation(identity, async (assertCurrent) => {
        const outcome = await saveSharedNormalEventWithVersionCheck(
          updated,
          sourceSnapshot.expectedUpdatedAt,
          identity
        );
        assertCurrent();
        switch (outcome) {
          case "committed":
            return;
          case "conflict":
            throw new Error(NORMAL_EVENT_EDIT_CONFLICT_MESSAGE);
          case "not_found":
            throw new Error(NORMAL_EVENT_EDIT_NOT_FOUND_MESSAGE);
          case "not_authorized":
            throw new Error(NORMAL_EVENT_EDIT_NOT_AUTHORIZED_MESSAGE);
          case "retryable":
            throw new Error(NORMAL_EVENT_EDIT_RETRYABLE_MESSAGE);
          case "unknown":
            throw new Error(NORMAL_EVENT_EDIT_UNKNOWN_MESSAGE);
          default: {
            const exhaustiveCheck: never = outcome;
            throw exhaustiveCheck;
          }
        }
      });
      return;
    }

    // Portfolio Edition: 共有→共有のカレンダー移動。
    // 移動対象は予定行だけなので、通常の保存経路をそのまま使う。
    await runCurrentSharedMutation(identity, async (assertCurrent) => {
      await saveEvent(updated);
      assertCurrent();
    });
  };

  const handleSaveFailure = (e: unknown) => {
    if (isStaleMutationError(e)) return;
    if (isMarkerError(e, UNSUPPORTED_CROSS_DOMAIN_MOVE_MESSAGE)) {
      Alert.alert(t("common.saveFailedTitle"), t("eventDetail.unsupportedCrossDomainMoveMessage"));
      return;
    }
    if (isMarkerError(e, UNSUPPORTED_RECURRING_CALENDAR_MOVE_MESSAGE)) {
      Alert.alert(t("common.saveFailedTitle"), t("eventDetail.unsupportedRecurringCalendarMoveMessage"));
      return;
    }
    if (isMarkerError(e, MIGRATION_PENDING_RETRY_MESSAGE)) {
      Alert.alert(t("common.saveFailedTitle"), t("eventDetail.migrationPendingRetryMessage"));
      return;
    }
    if (isMarkerError(e, NORMAL_EVENT_EDIT_CONFLICT_MESSAGE)) {
      Alert.alert(t("eventDetail.editConflictTitle"), t("eventDetail.editConflictMessage"));
      return;
    }
    if (isMarkerError(e, NORMAL_EVENT_EDIT_NOT_FOUND_MESSAGE)) {
      Alert.alert(t("eventDetail.editConflictTitle"), t("eventDetail.editNotFoundMessage"));
      return;
    }
    if (isMarkerError(e, NORMAL_EVENT_EDIT_NOT_AUTHORIZED_MESSAGE)) {
      Alert.alert(t("common.saveFailedTitle"), t("eventDetail.editNotAuthorizedMessage"));
      return;
    }
    if (isMarkerError(e, NORMAL_EVENT_EDIT_RETRYABLE_MESSAGE)) {
      Alert.alert(t("common.saveFailedTitle"), t("eventDetail.editRetryableMessage"));
      return;
    }
    if (isMarkerError(e, NORMAL_EVENT_EDIT_UNKNOWN_MESSAGE)) {
      Alert.alert(t("common.saveFailedTitle"), t("eventDetail.editUnknownOutcomeMessage"));
      return;
    }
    Alert.alert(
      t("common.saveFailedTitle"),
      toFriendlyMessage(e instanceof Error ? e.message : undefined, t("friendlyError.localPersistenceFailed"), t)
    );
  };

  const handleSave = async (value: NormalEventFormValue) => {
    // P0041（5節/6節、invariant D）: lock acquisitionは最初のawaitより前。既に別のsave
    // attemptが進行中（recurring編集ではscope選択Alert表示中も含む）なら、このattempt
    // 自体を即座に無視する（no-op）——二重にsaveEvent/C14を起動しない。
    if (saveAttemptInFlightRef.current) return;
    saveAttemptInFlightRef.current = true;

    // [P0078 CORRECT-F016-001] resolveEndDateだけがendDateの正本。全日予定はdateと同一日
    // （endDateは省略＝undefined、最小表現）のまま変更しない。
    const endDate =
      value.allDay ? undefined : (() => {
        const resolved = resolveEndDate(value.date, value.startTime, value.endTime);
        return resolved === value.date ? undefined : resolved;
      })();
    const updated: NormalEvent = {
      ...event,
      title: value.title.trim(),
      date: value.date,
      startTime: value.allDay ? "00:00" : value.startTime,
      endTime: value.allDay ? "23:59" : value.endTime,
      endDate,
      allDay: value.allDay,
      location: value.location.trim() || undefined,
      memo: value.memo.trim() || undefined,
      calendarId: value.calendarId,
      shareWith: value.shareWith,
      notification: {
        enabled: value.notificationMinutes >= 0,
        minutesBefore: Math.max(value.notificationMinutes, 0),
      },
      repeat: { type: value.repeatType },
      updatedAt: new Date().toISOString(),
    };
    // Round13、P1-4: 保存先（新しいカレンダー）だけでなく、元の予定が共有カレンダーに
    // 属していた場合も、identity保護の対象にする（「共有予定→ローカルカレンダーへの移動」を
    // identity無しで実行しないため。saveEventの実装は、移動元が共有だった場合に古い
    // 共有行の削除等、クラウド側への副作用を伴いうる）。
    const isCloudTarget = sharedCalendars.some((s) => s.calendar.id === value.calendarId);
    const wasCloudSource = sourceSnapshot.sourceIsCloud;
    const needsIdentity = isCloudTarget || wasCloudSource;

    // recurringGroupId未設定（通常予定）は、performSingleEventSave経由でルーティングする
    if (!event.recurringGroupId) {
      try {
        await performSingleEventSave(updated);
      } catch (e) {
        handleSaveFailure(e);
        return;
      } finally {
        // P0041（6節）: 成功・fail-closedの早期return・例外のいずれの経路でも必ず解放する
        // （poison防止。次回の明示的な再試行が必ずsaveを実行できるようにする）。
        saveAttemptInFlightRef.current = false;
      }
      // router.back()直前の最終確認（Round13、P1-4）。performSingleEventSave自体が
      // 例外を投げずに戻った時点で既にidentityは現在値だが、将来この間に別の
      // awaitが追加された場合の回帰を防ぐための明示的な最終ゲート。
      if (needsIdentity && identity && !isCurrentSharedMutationIdentity(identity)) return;
      router.back();
      return;
    }
    // askRecurringScopeはAlertを表示して即座に返る（「キャンセル」選択時はonSelect自体が
    // 呼ばれない）ため、この呼び出し自体をawaitでNormalEventForm側の保存中状態と
    // 連動させることはできない。範囲選択後の保存失敗は、ここで直接検知して知らせる。
    // P0041（6節）: Alert表示中もlockを保持し続け（=ここではまだ解放しない）、
    // scope選択callbackのfinally、またはキャンセル時のonCancelでのみ解放する。
    askRecurringScope(
      t,
      t("eventDetail.editScopeMessage"),
      async (scope) => {
        try {
          // P0040（10節）: calendar変更を伴うfollowing/allは、いかなる副作用の前に
          // C14 plan persist 0・RPC 0・navigation success 0）。「今は一部だけ移動して
          // 残りは後で」は明示的に禁止（10節）——scope選択のこの時点で即座に停止する。
          if (scope !== "single" && updated.calendarId !== sourceSnapshot.sourceCalendarId) {
            handleSaveFailure(new Error(UNSUPPORTED_RECURRING_CALENDAR_MOVE_MESSAGE));
            return;
          }
          if (scope === "single") {
            await performSingleEventSave(updated);
          } else if (needsIdentity) {
            // Round14、P1-4: 同上（fail-closed）。
            if (!identity) throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
            await runCurrentSharedMutation(identity, async (assertCurrent) => {
              await updateRecurringEvents(updated, scope);
              assertCurrent();
            });
            if (!isCurrentSharedMutationIdentity(identity)) return;
          } else {
            await updateRecurringEvents(updated, scope);
          }
          router.back();
        } catch (e) {
          handleSaveFailure(e);
        } finally {
          // P0041（6節）: single/following/all・fail-closedの早期return・例外の
          // いずれの経路でも必ず解放する。
          saveAttemptInFlightRef.current = false;
        }
      },
      () => {
        // P0041（6節）: ユーザーがscope選択Alertをキャンセルした場合も解放する
        // （キャンセルしたまま二度とsaveできなくなる=lock poisonを防ぐ）。
        saveAttemptInFlightRef.current = false;
      }
    );
  };

  const handleDelete = () => {
    const isCloudTarget = sharedCalendars.some((s) => s.calendar.id === event.calendarId);
    // recurringGroupId未設定（通常予定）は、これまで通りremoveEventのみで完結させる
    if (!event.recurringGroupId) {
      // Round14、P1-4: 「if (isCloudTarget && identity) {保護} else {無保護で実行}」という
      // 禁止パターンを避ける。isCloudTargetなのにidentityが無い場合はremoveEventを一切
      // 呼ばず、stale時と同じ経路（.catch）でisStaleMutationErrorが検知して静かに終了する。
      const run = isCloudTarget
        ? identity
          ? runCurrentSharedMutation(identity, async (assertCurrent) => {
              await removeEvent(event.id, event.calendarId);
              assertCurrent();
            })
          : Promise.reject(new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE))
        : removeEvent(event.id, event.calendarId);
      run
        .then(() => {
          // router.back()直前の最終確認（Round13、P1-4）。
          if (isCloudTarget && identity && !isCurrentSharedMutationIdentity(identity)) return;
          router.back();
        })
        .catch((e) => {
          if (isStaleMutationError(e)) return;
          Alert.alert(
            t("common.couldNotDelete"),
            toFriendlyMessage(e instanceof Error ? e.message : undefined, t("friendlyError.localPersistenceFailed"), t)
          );
        });
      return;
    }
    askRecurringScope(
      t,
      t("eventDetail.deleteScopeMessage"),
      async (scope) => {
        try {
          if (isCloudTarget) {
            // Round14、P1-4: 同上（fail-closed）。
            if (!identity) throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
            await runCurrentSharedMutation(identity, async (assertCurrent) => {
              await removeRecurringEvents(event, scope);
              assertCurrent();
            });
            if (!isCurrentSharedMutationIdentity(identity)) return;
          } else {
            await removeRecurringEvents(event, scope);
          }
          router.back();
        } catch (e) {
          if (isStaleMutationError(e)) return;
          Alert.alert(
            t("common.couldNotDelete"),
            toFriendlyMessage(e instanceof Error ? e.message : undefined, t("friendlyError.localPersistenceFailed"), t)
          );
        }
      }
    );
  };

  return (
    <NormalEventForm
      initial={initial}
      shareTargets={shareTargets}
      userCalendars={userCalendars}
      sharedCalendars={sharedCalendars}
      isEditing
      onSave={handleSave}
      onDelete={handleDelete}
      syncStatus={syncStatus}
      eventId={event.id}
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
