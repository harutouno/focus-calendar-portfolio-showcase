import React, { useMemo, useRef } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
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
import { fetchAttachmentMigrationSourceRowsForEvent } from "@/services/remoteAttachmentRepository";
import { resolveEndDate } from "@/utils/time";
import {
  planAndRunAttachmentMigration,
  StartAttachmentMigrationInput,
} from "@/services/attachmentMigrationService";
import { AttachmentMigrationTargetEventPatch } from "@/storage/attachmentMigrationRepository";

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
const MIGRATION_CONFLICT_MESSAGE = "P0040_MIGRATION_CONFLICT";
/**
 * P0041（1節 invariant C、3節）: sourceの添付DB全rowのうち1件でもready以外・
 * soft-delete済みが混ざっている（=移行中/削除処理中の過渡状態）場合のmarker。
 * この状態ではsaveEvent・C14のどちらも一切呼ばず、いかなる副作用の前にfail-closedで
 * 拒否する。
 */
const ATTACHMENT_SOURCE_NOT_STABLE_MESSAGE = "P0041_ATTACHMENT_SOURCE_NOT_STABLE";
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
 * P0040（9節）: C14 RPCへ送るtargetEvent patchのwhitelist変換。id/calendarId/
 * createdBy/createdAt/updatedAt・任意フィールドのspreadは一切行わない。
 * durationMinutes/restrictedApps/unlockConditionはFocusTask専用フィールドであり、
 * このscreenが扱うNormalEventには存在しないため常にnullを送る
 * （FocusTask編集は別画面・本batchの対象外）。
 */
function buildTargetEventPatch(updated: NormalEvent): AttachmentMigrationTargetEventPatch {
  return {
    title: updated.title,
    date: updated.date,
    startTime: updated.startTime,
    endTime: updated.endTime,
    allDay: updated.allDay,
    location: updated.location ?? null,
    durationMinutes: null,
    restrictedApps: null,
    unlockCondition: null,
    notification: updated.notification,
    repeat: updated.repeat,
    memo: updated.memo ?? null,
    completed: updated.completed,
    recurringGroupId: updated.recurringGroupId ?? null,
    recurrenceIndex: updated.recurrenceIndex ?? null,
  };
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
    reflectCommittedSharedEventChange,
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
    // いかなる副作用（event DB write・attachment Storage・RPC・cleanup）の前に拒否する。
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

    // calendar変更を伴う共有→共有の移動。添付manifestをsourceの権威（remote DB）から
    // 取得して初めてfail-closedかC14続行かが決まる。
    // P0042（1節/3節）: 添付が真に0件でもordinary saveEvent()へは絶対にフォールバックしない
    // ——read（ここでのfetch）とUPDATE（saveEvent）が別transactionのままだと、その間に
    // 別端末からの添付INSERTがcommitしてもclient側は検知できず、0019のguardと矛盾した
    // 状態のままlocal optimistic更新・router成功へ進んでしまうTOCTOUが生じる
    // （P0041のバグ）。shared→sharedのcalendar変更は0件を含め常にC14 atomic RPCだけが
    // 成立経路——RPC内部のFOR UPDATE・total row count一致チェックが真の権威。
    // P0040（7節）/P0041（2節）: manifest取得のawaitの直前・直後にidentity gateを置く
    // （fetchAttachmentMigrationSourceRowsForEvent自身もawaitCurrentSharedOperation経由で
    // 内部的に同じ3点チェックを行うが、呼び出し側でも独立に確認する多層防御）。
    if (!isCurrentSharedMutationIdentity(identity)) {
      throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
    }
    // P0041（1節 invariant A/B/C、3節）: UI表示用のdeleted_at絞り込み・ready絞り込みを
    // 一切行わない「全row」を権威として使う。この全rowこそがDBの実態そのものであり、
    // ready-filterした部分集合を「0件」や「移行対象」と誤認してはならない。
    const sourceRows = await fetchAttachmentMigrationSourceRowsForEvent(sourceSnapshot.eventId, identity);
    if (!isCurrentSharedMutationIdentity(identity)) {
      throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
    }

    // invariant C: 1件でもready以外・soft-delete済みが混ざっていれば、移行中/削除処理中の
    // 過渡状態とみなし、いかなる副作用（saveEvent・offline queue・C14 plan・Storage・RPC・
    // navigation）の前にfail-closedで拒否する。「一部だけ移行してready分は後で」も
    // 「readyでない分を無視してordinary saveへフォールバック」も禁止。
    const hasUnstableSourceRow = sourceRows.some(
      (row) => row.uploadStatus !== "ready" || row.deletedAt != null
    );
    if (hasUnstableSourceRow) {
      throw new Error(ATTACHMENT_SOURCE_NOT_STABLE_MESSAGE);
    }

    // Route C（invariant B、P0042で0件も含むよう拡張）: 残ったsourceRows（0件を含む、
    // 全rowがready・deletedAtなしであることは直前で確認済み）でC14 client migration
    // coreのみを使う。前後を問わず通常のevents.upsert()（saveEvent）を一切呼ばない・
    // 二重実行もしない（6節）。manifestはsourceRowsの全件（ready部分集合ではない）。
    // attachments=[]の場合、Client Migration Core側は各stage loopが0回実行され、
    // RPCへはmanifest=[]で1回だけ渡る（0019のempty manifest contractが正当に扱う）。
    const migrationInput: StartAttachmentMigrationInput = {
      ownerUserId: identity.userId,
      eventId: sourceSnapshot.eventId,
      sourceCalendarId: sourceSnapshot.sourceCalendarId,
      targetCalendarId: updated.calendarId,
      // P0040（8節）: expectedUpdatedAtの権威は編集セッション開始時点のsnapshot。
      // new Date()・クライアント保存時刻・target側の値・再fetchした値のいずれも使わない。
      expectedUpdatedAt: sourceSnapshot.expectedUpdatedAt,
      targetEvent: buildTargetEventPatch(updated),
      attachments: sourceRows.map((a) => ({
        sourceAttachmentId: a.id,
        // 8節: destination IDはこの呼び出し元（caller）がplan作成時に一度だけ生成する
        // （attachmentMigrationServiceのAttachmentMigrationPlanAttachmentInputが定める
        // 既存contract。retryはC14 core自身が同じdurable値を再利用するため、
        // ここで毎回生成し直すのはこの最初の1回だけでよい）。
        destinationAttachmentId: Crypto.randomUUID(),
        mimeType: a.mimeType,
        byteSize: a.byteSize,
        width: a.width,
        height: a.height,
        sortOrder: a.sortOrder,
      })),
    };

    const result = await planAndRunAttachmentMigration(migrationInput, identity);

    switch (result.status) {
      case "committed": {
        // P0040（14節）: 反映前に必ず現在identityを再確認する。stale化していれば
        // 反映もnavigationも行わずstale経路へ委ねる（durable recordは保持され、
        // fresh identityでの再開に委ねる——ここで手動のfallbackは行わない）。
        if (!isCurrentSharedMutationIdentity(identity)) {
          throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
        }
        // 反映する値は必ずcommittedUpdatedAt（result由来）。古いexpectedUpdatedAtや
        // updated.updatedAtは使わない。
        reflectCommittedSharedEventChange(
          { ...updated, updatedAt: result.committedUpdatedAt },
          identity.userId,
          identity.sessionInstanceId
        );
        return;
      }
      case "stale":
        throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
      case "pending-retry":
      case "not-found":
        // P0040（13節）: 通常のsave成功として閉じない。events.upsert()への
        // フォールバック・代替move・手動Storage cleanupは一切行わない。
        // 既存のretry lifecycle（15節）が後で自動的に確認・再試行する。
        throw new Error(MIGRATION_PENDING_RETRY_MESSAGE);
      case "conflict":
        // P0040（13節）: identityが既にstaleならAlertを出さない（stale経路を優先）。
        if (!isCurrentSharedMutationIdentity(identity)) {
          throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
        }
        throw new Error(MIGRATION_CONFLICT_MESSAGE);
      default: {
        const exhaustiveCheck: never = result;
        throw exhaustiveCheck;
      }
    }
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
    if (isMarkerError(e, MIGRATION_CONFLICT_MESSAGE)) {
      Alert.alert(t("common.saveFailedTitle"), t("eventDetail.migrationConflictMessage"));
      return;
    }
    if (isMarkerError(e, ATTACHMENT_SOURCE_NOT_STABLE_MESSAGE)) {
      Alert.alert(t("common.saveFailedTitle"), t("eventDetail.attachmentSourceNotStableMessage"));
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
          // fail-closedで拒否する（event DB write 0・attachment Storage 0・
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
