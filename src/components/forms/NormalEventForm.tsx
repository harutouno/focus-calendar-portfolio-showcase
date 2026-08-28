import React, { useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { NormalEvent, ShareTarget, UserCalendar } from "@/types/event";
import { JoinedCalendarSummary, SyncStatus } from "@/types/sharing";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { PageLayout } from "@/components/common/PageLayout";
import { FieldRow } from "./FieldRow";
import { PickerModal, PickerOption } from "./PickerModal";
import { TextEditModal } from "./TextEditModal";
import { DateTimePickerModal } from "./DateTimePickerModal";
import {
  getNotificationPresets,
  getRepeatOptions,
} from "@/constants/options";
import { formatLocalDate, formatDayTitle, parseLocalDateString } from "@/utils/date";
import { combineDateAndTime, defaultEndTime } from "@/utils/time";
import { validateNormalEvent, hasErrors } from "@/utils/validation";
import { useLocale } from "@/context/LocaleContext";
import { useAuth } from "@/context/AuthContext";
import { toFriendlyMessage } from "@/utils/friendlyError";
import {
  SharedOperationIdentity,
  STALE_SHARED_MUTATION_IDENTITY_MESSAGE,
  buildIdentityRemountKey,
  isCurrentSharedMutationIdentity,
} from "@/auth/sharedMutationIdentity";

/** onSave/onDelete内でidentityがstale化した場合の合図。呼び出し元はこれを検知したら
 *  失敗Alertを出さず静かに終了する（画面はidentity変化により既にremountされているはず）。 */
function isStaleMutationError(e: unknown): boolean {
  return e instanceof Error && e.message === STALE_SHARED_MUTATION_IDENTITY_MESSAGE;
}

export interface NormalEventFormValue {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  location: string;
  memo: string;
  calendarId: string;
  notificationMinutes: number; // -1 = 通知しない
  repeatType: NormalEvent["repeat"]["type"];
  shareWith: string[];
}

interface Props {
  initial: NormalEventFormValue;
  shareTargets: ShareTarget[];
  userCalendars: UserCalendar[];
  /** ログイン中に参加している共有カレンダー（viewerは予定を作成できないため選択肢から除く） */
  sharedCalendars?: JoinedCalendarSummary[];
  isEditing: boolean;
  /**
   * 新規作成（isEditing=false）では、この関数は予定本体を保存するだけにし、
   * onSaveCompleteを呼ぶ）。編集（isEditing=true）では従来通り、この中で画面遷移まで
   * 行ってよい（画像は既に即時アップロード方式のため、保存タイミングと無関係）。
   */
  onSave: (value: NormalEventFormValue) => void | Promise<void>;
  onSaveComplete?: () => void;
  onDelete?: () => void | Promise<void>;
  /** 編集中の予定が共有カレンダーに属する場合の送信状態（表示のみ。未指定＝端末内予定、または新規作成で未送信） */
  syncStatus?: SyncStatus;
  /**
   * 編集画面は既存のevent.idをそのまま渡す。
   */
  eventId: string;
  /**
   */
}

type ActiveModal =
  | null
  | "title"
  | "location"
  | "memo"
  | "date"
  | "startTime"
  | "endTime"
  | "notification"
  | "repeat"
  | "calendar"
  | "share";

/**
 * Round 12（SEC-F007-004、P1-5）: identity変化のたびに内側のstateful本体を完全remountする、
 * app/calendar/[id]/settings.tsx等と同じ薄いouter/inner分割。TOKEN_REFRESHED等の
 * 同一identity更新ではbuildIdentityRemountKeyの値が変わらないため再マウントされない
 * （値の一致で判定するため、参照が変わるだけでは再マウントされない）。
 */
export function NormalEventForm(props: Props) {
  const { user, sessionInstanceId } = useAuth();
  const identityKey = buildIdentityRemountKey(user?.id, sessionInstanceId);
  // P0040（4節）: eventIdもremount keyへ含める。identity変化だけでなく、真に別のevent
  // （event/[id]のid遷移）を開くたびにも内側のstateful本体を完全remountし、以下で
  // 追加するsource snapshot（sourceCalendarId等）が確実に再構築されるようにする
  // （calendar pickerでのvalue.calendarId変更だけではeventIdは変わらないため、
  // その間はsnapshotが維持される——4節の「event IDが変わる本当のscreen transition時だけ
  // snapshotを再構築する」契約どおり）。
  return <NormalEventFormInner key={`${identityKey}:${props.eventId}`} {...props} />;
}

function NormalEventFormInner({
  initial,
  shareTargets,
  userCalendars,
  sharedCalendars = [],
  isEditing,
  onSave,
  onSaveComplete,
  onDelete,
  syncStatus,
  eventId,
}: Props) {
  const { t, locale } = useLocale();
  const { user, sessionInstanceId } = useAuth();
  const [value, setValue] = useState<NormalEventFormValue>(initial);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [submitted, setSubmitted] = useState(false);
  /**
   * 終了時刻をユーザーが手動編集したかどうか。falseの間は、開始時刻の変更に連動して
   * 終了時刻を自動で「開始時刻+1時間」へ更新し続ける（新規作成の初期値が開始時刻+1時間である
   * ことの延長）。一度でも終了時刻を手動編集したら、以後は自動更新しない。
   * 編集画面（isEditing=true）では、既存の終了時刻は既に確定した値（新規作成時の自動計算・
   * 過去の手動編集のどちらかは区別できない）のため、開始時刻の変更で不用意に上書きしないよう
   * 最初から手動編集済み扱い（true）にする——この自動連動は新規作成画面専用の挙動とする。
   */
  const [endTimeManuallyEdited, setEndTimeManuallyEdited] = useState(isEditing);

  const errors = useMemo(
    () =>
      validateNormalEvent(
        {
          title: value.title,
          date: value.date,
          startTime: value.startTime,
          endTime: value.endTime,
          allDay: value.allDay,
        },
        t
      ),
    [value, t]
  );

  const notificationPresets = getNotificationPresets(t);
  const repeatOptions = getRepeatOptions(t);

  const notificationLabel =
    notificationPresets.find((p) => p.minutes === value.notificationMinutes)
      ?.label ?? t("normalEventForm.notificationFallback");
  const repeatLabel =
    repeatOptions.find((r) => r.value === value.repeatType)?.label ?? t("options.repeatNone");
  const editableSharedCalendars = sharedCalendars.filter((s) => s.role !== "viewer");
  const calendarOption =
    userCalendars.find((c) => c.id === value.calendarId) ??
    editableSharedCalendars.find((s) => s.calendar.id === value.calendarId)?.calendar;
  const shareLabel =
    value.shareWith.length === 0
      ? t("normalEventForm.shareFallback")
      : t("normalEventForm.shareSelectedCount", { count: value.shareWith.length });
  // 選択中の「予定表」が共有カレンダーかどうかで、端末内予定と共有予定を画面上で区別する
  const targetSharedCalendar = editableSharedCalendars.find(
    (s) => s.calendar.id === value.calendarId
  );
  const sharedNoticeText = targetSharedCalendar
    ? isEditing
      ? syncStatus === "error"
        ? t("normalEventForm.sharedNoticeError", { name: targetSharedCalendar.calendar.name })
        : syncStatus === "pending"
        ? t("normalEventForm.sharedNoticePending", { name: targetSharedCalendar.calendar.name })
        : t("normalEventForm.sharedNoticeSynced", { name: targetSharedCalendar.calendar.name })
      : t("normalEventForm.sharedNoticeNew", { name: targetSharedCalendar.calendar.name })
    : null;
  const sharedNoticeIsWarning = isEditing && (syncStatus === "error" || syncStatus === "pending");

  const isCloudEvent = !!targetSharedCalendar;
  /**
   * scope key）をsource calendar（編集開始時点のcalendarId）へ固定する。calendar
   * pickerでvalue.calendarIdが変わっても、保存がコミット（またはC14 migration完了）
   * あるため（5節）。useState初期化子は初回マウント時にしか評価されないため、
   * これ自体がスナップショットとして機能する。新規作成（isEditing=false）は
   * 「source」という概念が無いため対象外——従来通りライブのtargetがそのままplanになる。
   */
  const [editSourceSnapshot] = useState<
    { sourceCalendarId: string; isCloudEventSource: boolean } | null
  >(() => {
    if (!isEditing) return null;
    // P0041（9節）: source domainの共有/端末内判定にrole filterを掛けない。
    // editableSharedCalendars（role!=="viewer"のみ）で判定すると、viewer権限の
    // 共有カレンダーに属する予定へ何らかの経路（他画面・deep link等）で直接編集
    // authorityがlocal repositoryへfallbackしてしまう。target pickerの選択肢
    // （editableSharedCalendars）とsource domainの判定基準は別物として扱う。
    const isInitialCalendarShared = sharedCalendars.some(
      (s) => s.calendar.id === initial.calendarId
    );
    return {
      sourceCalendarId: initial.calendarId,
      isCloudEventSource: isInitialCalendarShared,
    };
  });
  const sourceIsCloudEvent = editSourceSnapshot
    ? editSourceSnapshot.isCloudEventSource
    : isCloudEvent;
  /**
   * P0041（8節）: identity gate（handleSubmitのstale確認）は、target pickerの選択だけで
   * 決めてはならない。sourceが共有だった場合（sourceIsCloudEvent）、targetが
   * 端末内カレンダーへ変更されていても、保存はperformSingleEventSave等のC14統合経路を
   * 通り得るため、shared identityの現在性チェックを飛ばしてはならない。isEditing時は
   * 「sourceが共有 OR targetが共有」のいずれかで真になる。create時はsource概念が無く
   * sourceIsCloudEvent===isCloudEventなので、この式はisCloudEventへ自然に一致する。
   */
  const requiresSharedIdentity = sourceIsCloudEvent || isCloudEvent;
  // Round 12（P1-4/P1-5）: NormalEventFormInnerはidentity変化のたびに完全remountされるため
  // Hook初期化時点でこの値をさらに固定する（identityRef）。
  const userId = user?.id ?? null;
  const identity: SharedOperationIdentity | null = useMemo(
    () => (userId && sessionInstanceId ? { userId, sessionInstanceId } : null),
    [userId, sessionInstanceId]
  );
  const [saving, setSaving] = useState(false);
  /**
   * [P0076 QA-F013対応] handleSubmitの二重送信ガード。savingはuseStateのため、
   * 同一レンダーのクロージャ内で同期的に2回handleSubmitが呼ばれた場合（例:
   * 画面の再レンダーが挟まる前に2回連続でタップされた場合）、両方の呼び出しが
   * 同じ「まだfalseのsaving」を読んでしまい、setSaving(true)によるボタンの
   * disabled化だけでは二重送信を防げない（実測で再現確認済み）。refは同期的に
   * 即時反映されるため、レンダーを挟まない連続呼び出しでも確実にガードできる。
   */
  const submittingRef = useRef(false);
  // Round13、P1-3: isCloudEventがtrueなのにidentityが欠落している場合（画面remount直前の
  // ストレージへ書き込んでしまう実害があるため）。identityをそのまま（nullの可能性を含め）

  // Round14、P1-3: isCloudEvent===trueなのにidentityが無い場合（画面remount直前の短い
  // ローカルストレージから解決しようとして誤動作させないため、fail-closed）。
  // P0040（5節）: sourceIsCloudEventを使う（source固定済み）——targetのisCloudEventではない。
  // Round13、P2: サムネイル・プレビューのlatest-wins判定に使う文脈識別子。
  // identity・保存先カレンダーのいずれかが変化するたびに値が変わる。

  const handleSubmit = async () => {
    // P0024（QA-F007 Batch3.4、11節）: 共有（クラウド）予定は、setSubmitted/setSaving/
    // onSaveのいずれよりも前にidentityの現在性を確認する。auth storeだけがA→Bへ
    // 切り替わり、このフォームインスタンスがまだReact再レンダー（identity-key remount）を
    // Alertのいずれも一切発生させない（画面はまもなくremountされるため）。
    // 通常のcurrent shared form・local formは従来どおり動作する（ローカル予定は
    // requiresSharedIdentity=falseのためこのgateの対象外）。
    // P0041（8節）: targetだけでなくsourceが共有の場合もこのgateの対象にする
    // （requiresSharedIdentity = sourceIsCloudEvent || isCloudEvent）。
    // [P0076 QA-F013] 同期的な二重呼び出し（レンダーを挟まない連続タップ等）を
    // 最初にブロックする。identityチェック・validationより前に置くことで、
    // 以後のどの分岐を通っても2回目の呼び出しはここで確実に止まる。
    if (submittingRef.current) return;
    submittingRef.current = true;

    if (requiresSharedIdentity) {
      if (!identity || !isCurrentSharedMutationIdentity(identity)) {
        submittingRef.current = false;
        return;
      }
    }

    setSubmitted(true);
    if (hasErrors(errors)) {
      submittingRef.current = false;
      return;
    }

    if (isEditing) {
      // （従来通り、画面遷移も含めてonSave側に任せる）。保存失敗時はここで検知して
      // 画面遷移・成功表示を行わず、フォームの入力内容を保持したままエラーを知らせる。
      setSaving(true);
      try {
        await onSave(value);
      } catch (e) {
        // P0022（QA-F007 Batch3.2、8節）: stale判定をsetSaving(false)より前に行う。
        // 以前はsetSaving(false)を無条件で先に呼んでいたため、identityがstale化した
        // （画面がまもなくremountされる）場合でも、この古いフォームインスタンス側で
        // saving stateの更新が発生してしまっていた。
        // Round 12（P1-5）: identityがstale化した場合（onSave内部のrunCurrentSharedMutationが
        // 投げる）は、画面がまもなくidentity変化によりremountされるため、失敗Alertを出さず
        // 静かに終了する（ユーザーには何も起きなかったかのように見せる）。
        if (isStaleMutationError(e)) return;
        submittingRef.current = false;
        setSaving(false);
        Alert.alert(
          t("common.saveFailedTitle"),
          toFriendlyMessage(e instanceof Error ? e.message : undefined, t("friendlyError.localPersistenceFailed"), t)
        );
        return;
      }
      // P0023（QA-F007 Batch3.3、9節）: onSave自体はthrowせずresolveした場合でも、
      // 共有（クラウド）予定についてはawait中にidentityがstale化していないかを
      // setSaving(false)より前に確認する（P0022のcatch側stale判定はそのまま維持）。
      // 以前はresolveした場合の成功パスにこの確認が無く、await中にA→Bが起きても
      // 古いフォームインスタンス側でsetSaving(false)相当のstate更新が発生していた。
      // 通常のcurrent shared editでは従来どおりsetSaving(false)を呼ぶ。
      if (requiresSharedIdentity && identity && !isCurrentSharedMutationIdentity(identity)) return;
      submittingRef.current = false;
      setSaving(false);
      return;
    }

    setSaving(true);
    try {
      await onSave(value);
    } catch (e) {
      // P0022（QA-F007 Batch3.2、8節）: 同上、stale判定をsetSaving(false)より前に行う。
      if (isStaleMutationError(e)) return;
      submittingRef.current = false;
      setSaving(false);
      Alert.alert(t("common.saveFailedTitle"), t("common.saveFailedMessage"));
      return;
    }
    if (requiresSharedIdentity && identity && !isCurrentSharedMutationIdentity(identity)) {
      // onSave自体は成功したが、その直後にidentityがstale化していた場合も同様に静かに終了する。
      // P0022（QA-F007 Batch3.2、8節）: この経路でもsetSaving(false)を呼ばない
      // （既にstale化しているため、古いHookインスタンス側の状態更新を一切行わない）。
      return;
    }

    submittingRef.current = false;
    setSaving(false);

    // Round13、P1-4: onSaveCompleteを同期呼出しする直前の最終ゲート。
    if (requiresSharedIdentity && identity && !isCurrentSharedMutationIdentity(identity)) return;

    onSaveComplete?.();
  };

  const confirmDelete = () => {
    Alert.alert(t("normalEventForm.deleteConfirmTitle"), t("normalEventForm.deleteConfirmMessage"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: () => {
          // onDeleteが同期void/非同期どちらでも、失敗（例外・reject）を確実に捕捉するため
          // .then()の中で呼び出す（Promise.resolve(onDelete?.())だと同期例外を捕捉できない）。
          Promise.resolve()
            .then(() => onDelete?.())
            .catch((e) => {
              // Round13、P1-4: onDelete実装がidentity stale化を検知した例外を投げてきた場合も、
              // 通常の削除失敗Alertへ畳み込まず静かに終了する（画面はidentity変化により
              // 既にremountされているはずのため）。
              if (isStaleMutationError(e)) return;
              Alert.alert(
                t("common.couldNotDelete"),
                toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotDelete"), t)
              );
            });
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <PageLayout
          header={
          <ScreenHeader
            title={isEditing ? t("normalEventForm.editHeaderTitle") : t("normalEventForm.createHeaderTitle")}
            backLabel={t("common.cancel")}
            right={
              <PrimaryButton
                label={t("common.save")}
                onPress={handleSubmit}
                loading={saving}
                style={styles.saveButton}
              />
            }
          />
        }
      >
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {sharedNoticeText && (
          <View style={[styles.sharedNotice, sharedNoticeIsWarning && styles.sharedNoticeWarning]}>
            <Ionicons
              name={sharedNoticeIsWarning ? "warning-outline" : "people-outline"}
              size={16}
              color={sharedNoticeIsWarning ? colors.warning : colors.primary}
            />
            <Text
              style={[styles.sharedNoticeText, sharedNoticeIsWarning && styles.sharedNoticeTextWarning]}
            >
              {sharedNoticeText}
            </Text>
          </View>
        )}
        <SectionCard>
          <FieldRow
            icon="pencil-outline"
            label={t("normalEventForm.titleLabel")}
            value={value.title}
            placeholder={t("common.notEntered")}
            onPress={() => setActiveModal("title")}
            errorText={submitted ? errors.title : undefined}
            required
          />
          <FieldRow
            icon="calendar-outline"
            label={t("normalEventForm.dateLabel")}
            value={formatDayTitle(value.date, locale)}
            onPress={() => setActiveModal("date")}
            errorText={submitted ? errors.date : undefined}
            required
          />
          <FieldRow
            icon="time-outline"
            label={t("normalEventForm.startFieldLabel")}
            value={value.startTime}
            onPress={() => setActiveModal("startTime")}
            errorText={submitted ? errors.startTime : undefined}
            required
          />
          <FieldRow
            icon="time-outline"
            label={t("normalEventForm.endFieldLabel")}
            value={value.endTime}
            onPress={() => setActiveModal("endTime")}
            errorText={submitted ? errors.endTime : undefined}
            required
          />
        </SectionCard>

        <SectionCard>
          <FieldRow
            icon="notifications-outline"
            label={t("common.notification")}
            value={notificationLabel}
            onPress={() => setActiveModal("notification")}
          />
          <FieldRow
            icon="repeat-outline"
            label={t("common.repeat")}
            value={repeatLabel}
            onPress={() => setActiveModal("repeat")}
          />
        </SectionCard>

        {(userCalendars.length > 0 || editableSharedCalendars.length > 0 || shareTargets.length > 0) && <SectionCard>
          {(userCalendars.length > 0 || editableSharedCalendars.length > 0) && <FieldRow
            icon="albums-outline"
            label={t("normalEventForm.calendarLabel")}
            value={calendarOption?.name ?? t("calendars.baseCalendarName")}
            onPress={() => setActiveModal("calendar")}
          />}
          <FieldRow
            icon="people-outline"
            label={t("common.shared")}
            value={shareLabel}
            onPress={() => setActiveModal("share")}
          />
        </SectionCard>}

        <SectionCard>
          <FieldRow
            icon="document-text-outline"
            label={t("normalEventForm.memoLabel")}
            value={value.memo}
            placeholder={t("common.notEntered")}
            onPress={() => setActiveModal("memo")}
          />
        </SectionCard>

        {isEditing && onDelete && (
          <SectionCard>
            <FieldRow
              icon="trash-outline"
              label={t("normalEventForm.deleteConfirmTitle")}
              danger
              showChevron={false}
              onPress={confirmDelete}
            />
          </SectionCard>
        )}
      </ScrollView>
      </PageLayout>

      <TextEditModal
        visible={activeModal === "title"}
        title={t("normalEventForm.titleLabel")}
        initialValue={value.title}
        placeholder={t("normalEventForm.titlePlaceholder")}
        onClose={() => setActiveModal(null)}
        onSubmit={(v) => setValue((prev) => ({ ...prev, title: v }))}
      />
      <TextEditModal
        visible={activeModal === "memo"}
        title={t("normalEventForm.memoLabel")}
        initialValue={value.memo}
        placeholder={t("normalEventForm.memoPlaceholder")}
        multiline
        onClose={() => setActiveModal(null)}
        onSubmit={(v) => setValue((prev) => ({ ...prev, memo: v }))}
      />
      <DateTimePickerModal
        visible={activeModal === "date"}
        title={t("normalEventForm.dateLabel")}
        mode="date"
        value={parseLocalDateString(value.date)}
        onClose={() => setActiveModal(null)}
        onConfirm={(d) => setValue((prev) => ({ ...prev, date: formatLocalDate(d) }))}
      />
      <DateTimePickerModal
        visible={activeModal === "startTime"}
        title={t("common.startTime")}
        mode="time"
        minuteInterval={1}
        value={combineDateAndTime(value.date, value.startTime)}
        onClose={() => setActiveModal(null)}
        onConfirm={(d) => {
          const newStartTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
          setValue((prev) => ({
            ...prev,
            startTime: newStartTime,
            endTime: endTimeManuallyEdited ? prev.endTime : defaultEndTime(newStartTime),
          }));
        }}
      />
      <DateTimePickerModal
        visible={activeModal === "endTime"}
        title={t("common.endTime")}
        mode="time"
        minuteInterval={1}
        value={combineDateAndTime(value.date, value.endTime)}
        onClose={() => setActiveModal(null)}
        onConfirm={(d) => {
          setEndTimeManuallyEdited(true);
          setValue((prev) => ({
            ...prev,
            endTime: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
          }));
        }}
      />
      <PickerModal
        visible={activeModal === "notification"}
        title={t("common.notification")}
        options={notificationPresets.map<PickerOption>((p) => ({
          id: String(p.minutes),
          label: p.label,
        }))}
        selectedIds={[String(value.notificationMinutes)]}
        onClose={() => setActiveModal(null)}
        onApply={(ids) =>
          setValue((prev) => ({ ...prev, notificationMinutes: Number(ids[0]) }))
        }
      />
      <PickerModal
        visible={activeModal === "repeat"}
        title={t("common.repeat")}
        options={repeatOptions.map<PickerOption>((r) => ({
          id: r.value,
          label: r.label,
        }))}
        selectedIds={[value.repeatType]}
        onClose={() => setActiveModal(null)}
        onApply={(ids) =>
          setValue((prev) => ({
            ...prev,
            repeatType: ids[0] as NormalEvent["repeat"]["type"],
          }))
        }
      />
      <PickerModal
        visible={activeModal === "calendar"}
        title={t("normalEventForm.calendarLabel")}
        options={[
          ...userCalendars.map<PickerOption>((c) => ({
            id: c.id,
            label: c.name,
          })),
          ...editableSharedCalendars.map<PickerOption>((s) => ({
            id: s.calendar.id,
            label: s.calendar.name,
            helperText: t("common.shared"),
          })),
        ]}
        selectedIds={[value.calendarId]}
        onClose={() => setActiveModal(null)}
        onApply={(ids) => setValue((prev) => ({ ...prev, calendarId: ids[0] }))}
      />
      <PickerModal
        visible={activeModal === "share"}
        title={t("normalEventForm.shareModalTitle")}
        multiple
        options={shareTargets.map<PickerOption>((s) => ({ id: s.id, label: s.name }))}
        selectedIds={value.shareWith}
        onClose={() => setActiveModal(null)}
        onApply={(ids) => setValue((prev) => ({ ...prev, shareWith: ids }))}
      />
    </View>
  );
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // 領域が広がったとき、ScrollView自体がそれに追従して伸びるようにするため）。
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingVertical: spacing.md,
    paddingBottom: spacing.xxl,
  },
  saveButton: {
    paddingHorizontal: spacing.md,
    minHeight: 36,
  },
  sharedNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: 10,
    backgroundColor: colors.primarySoft,
  },
  sharedNoticeWarning: {
    backgroundColor: colors.warningSoft,
  },
  sharedNoticeText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  sharedNoticeTextWarning: {
    color: colors.textPrimary,
  },
});
