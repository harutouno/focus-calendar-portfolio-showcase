import React, { useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { NormalEvent, UserCalendar } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";
import { BulkSaveResult } from "@/context/AppDataContext";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { FieldRow } from "./FieldRow";
import { PickerModal, PickerOption } from "./PickerModal";
import { TextEditModal } from "./TextEditModal";
import { DateTimePickerModal } from "./DateTimePickerModal";
import { getNotificationPresets } from "@/constants/options";
import {
  formatLocalDate,
  parseLocalDateString,
  todayLocalDateString,
  weekdayLabelByIndex,
} from "@/utils/date";
import { combineDateAndTime, resolveEndDate } from "@/utils/time";
import { validateBulkEventRange, hasErrors } from "@/utils/validation";
import { getDatesInRangeByWeekday } from "@/utils/recurringDates";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { useLocale } from "@/context/LocaleContext";
import { STALE_SHARED_MUTATION_IDENTITY_MESSAGE } from "@/auth/sharedMutationIdentity";
import { computeBulkAttemptFingerprint } from "@/utils/bulkAttemptFingerprint";
import { beginOrResumeBulkAttempt, resolveBulkAttempt } from "@/storage/bulkAttemptJournalRepository";
import { classifyCalendarOwnership } from "@/utils/calendarOwnership";

/** onSave内でidentityがstale化/欠落した場合の合図。NormalEventForm.tsxと同じ規約。 */
function isStaleMutationError(e: unknown): boolean {
  return e instanceof Error && e.message === STALE_SHARED_MUTATION_IDENTITY_MESSAGE;
}

interface Props {
  userCalendars: UserCalendar[];
  /** ログイン中に参加している共有カレンダー（viewerは予定を作成できないため選択肢から除く） */
  sharedCalendars?: JoinedCalendarSummary[];
  onSave: (events: NormalEvent[]) => Promise<BulkSaveResult>;
  /**
   * [P0080 DATA-F017-001] 一括作成attemptの永続化journalを所有者ごとに分離するための
   * 現在の認証ユーザーID。ローカル（デバイス内）カレンダー宛ての一括作成では未ログイン
   * でも動作するため、その場合はnullを渡す（省略時はnullとして扱う）。
   */
  ownerUserId?: string | null;
}

type ActiveModal =
  | null
  | "title"
  | "memo"
  | "startDate"
  | "endDate"
  | "startTime"
  | "endTime"
  | "weekdays"
  | "calendar"
  | "notification";

/** プレビュー表示する日付の件数（それ以降は「他N件」とまとめる） */
const PREVIEW_LIMIT = 5;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** "2026/08/02（日）"（en: "2026/08/02 (Sun)"）形式のプレビュー表示用フォーマット */
function formatPreviewDate(dateStr: string, locale: "ja" | "en"): string {
  const d = parseLocalDateString(dateStr);
  const datePart = `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  const weekday = weekdayLabelByIndex(d.getDay(), locale);
  return locale === "ja" ? `${datePart}（${weekday}）` : `${datePart} (${weekday})`;
}

/**
 * 一括作成（期間・曜日指定）フォーム。端末内カレンダー・共有カレンダーの両方に対応し、
 * 実際の保存はonSave（AppDataContext.saveEventsBulk）に委ね、種別を意識しない。
 */
export function BulkEventForm({ userCalendars, sharedCalendars = [], onSave, ownerUserId = null }: Props) {
  const { t, locale } = useLocale();
  const today = todayLocalDateString();
  const [title, setTitle] = useState("");
  const [memo, setMemo] = useState("");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("11:00");
  const [calendarId, setCalendarId] = useState("main");
  // -1 = 通知なし（NOTIFICATION_PRESETSと同じ規約）。一括作成される全予定へ同じ設定を保存する。
  const [notificationMinutes, setNotificationMinutes] = useState(-1);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * [P0076 QA-F017対応] handleSubmitの二重送信ガード。従来の`if (saving...) return`は
   * savingがuseStateであるため、同一レンダーのクロージャ内で同期的に2回handleSubmitが
   * 呼ばれた場合（レンダーが挟まる前の連続タップ）に両方の呼び出しが同じ「まだfalseの
   * saving」を読んでしまい機能しない（実測で再現確認済み——一括作成予定が2倍生成される）。
   * refは同期的に即時反映されるため、レンダーを挟まない連続呼び出しでも確実にガードできる。
   */
  const submittingRef = useRef(false);
  /**
   * [P0078 TEST-F013-F015-F017-001 / F017critical → P0080 DATA-F017-001で永続化に拡張]
   * 一括作成の論理的なattemptのid安定性。以前はhandleSubmitの中でgroupId・各evt.idを
   * 毎回generateId()し直しており、onSave（saveEventsBulk経由のSupabase upsert）が
   * 応答不明（response-lost）でrejectした場合、ユーザーが同じフォームインスタンス上で
   * 「保存」を再度押すと全く別のid組で再送していた——1回目が実はサーバー側で既に
   * commitしていた場合、2回目が別idの重複バッチとしてDBに残ってしまう
   * （正本§6の禁止する重複バグ）。P0078ではuseRef（同一マウント内でのみ有効）で
   * これを解消したが、[P0080 DATA-F017-001]の要件（プロセス強制終了・再起動・
   * フォームの再マウントをまたいだ耐久性）を満たすには不十分だった。
   * bulkAttemptJournalRepository（AsyncStorage永続化）へ置き換え、handleSubmitの
   * 最初に必ずbeginOrResumeBulkAttemptを呼ぶ（同じfingerprintのpending attemptが
   * 永続化されていればそれをそのまま再利用し、無ければ新規発行して即座に永続化する）。
   * attemptIdは結果が判明した時点（成功/確実な失敗）でresolveBulkAttemptへ渡し、
   * journalから除去する——それまでは常にAsyncStorage上にpendingのまま残るため、
   * アプリの強制終了直後にも同じfingerprintでの再送はこのレコードのid組を再利用できる。
   * 永続化そのものがこの安定性を担うため、以前のuseRefのような「同一マウント内限定」の
   * キャッシュはもう不要（handleSubmit内のローカル変数だけで足りる）。
   */

  const editableSharedCalendars = sharedCalendars.filter((s) => s.role !== "viewer");
  /**
   * [P0082 DATA-F017-003 F017-E] bulkAttemptJournalRepositoryのowner scopeは、propの
   * ownerUserId（＝現在ログイン中のユーザーID）をそのまま使うのではなく、実際の
   * 保存先calendarIdの分類（local/shared）に一致させる。以前はログイン中のユーザーが
   * 端末内（ローカル）カレンダーへ一括作成しても、journalレコードのownerUserIdへ常に
   * クラウドのuser.idを紐づけていた——ローカルカレンダーの永続化ドメイン（端末内・
   * アカウント非依存）と食い違う（例: 別アカウントへの切替後は元のattemptを二度と
   * 見つけられなくなる・意図しない所有者境界を持ち込む）。calendarIdが"unknown"
   * （分類不能）の場合は、実際の保存（onSave）自体がAppDataContext側のより厳密な
   * classifyCalendarOwnershipでいずれにせよ例外化されるため、journal scopeの決定は
   * 従来どおりownerUserIdプロパティへ安全側でフォールバックする。
   */
  const journalOwnerUserId =
    classifyCalendarOwnership(calendarId, userCalendars, sharedCalendars) === "local" ? null : ownerUserId;
  const calendarOption =
    userCalendars.find((c) => c.id === calendarId) ??
    editableSharedCalendars.find((s) => s.calendar.id === calendarId)?.calendar;
  const notificationPresets = getNotificationPresets(t);
  const notificationLabel =
    notificationPresets.find((p) => p.minutes === notificationMinutes)?.label ?? t("options.notificationNone");

  const errors = useMemo(
    () =>
      validateBulkEventRange(
        {
          title,
          calendarId,
          startDate,
          endDate,
          weekdays,
          startTime,
          endTime,
        },
        t
      ),
    [title, calendarId, startDate, endDate, weekdays, startTime, endTime, t]
  );

  // 件数計算方法: Stage Aで作成した getDatesInRangeByWeekday をそのまま呼び出す
  // （上限超過・開始日>終了日等は例外を投げるため、プレビューでは空配列として扱い、
  // 実際のエラーメッセージは validateBulkEventRange の errors.range 側に表示する）
  const previewDates = useMemo(() => {
    if (!startDate || !endDate || weekdays.length === 0) return [];
    try {
      return getDatesInRangeByWeekday({ startDate, endDate, weekdays }, t);
    } catch {
      return [];
    }
  }, [startDate, endDate, weekdays, t]);

  const weekdayLabel =
    weekdays.length === 0
      ? t("bulkEventForm.weekdayFallback")
      : [...weekdays]
          .sort((a, b) => a - b)
          .map((w) => weekdayLabelByIndex(w, locale))
          .join(t("restrictedAppsList.listSeparator"));

  const handleSubmit = async () => {
    // [P0076 QA-F017] 同期的な二重呼び出し（レンダーを挟まない連続タップ等）を
    // validationより前に最初にブロックする（レンダーの有無に依存しない同期ref）。
    if (submittingRef.current) return;
    submittingRef.current = true;

    setSubmitted(true);
    if (hasErrors(errors)) {
      submittingRef.current = false;
      return;
    }
    setSaving(true);
    try {
      // [P0080 DATA-F017-001] フォームの入力内容だけから決定的なfingerprintを計算し、
      // beginOrResumeBulkAttemptへ渡す。同じ内容の再送（プロセス強制終了・再起動・
      // フォームの再マウントをまたぐ場合を含む）であれば、永続化済みの同じattemptId・
      // recurringGroupId・event id組がそのまま返る（P0078のbulkAttemptRefが担っていた
      // 「同一マウント内でのid安定性」を、マウントをまたいだ耐久性へ拡張したもの）。
      const fingerprint = computeBulkAttemptFingerprint({
        title,
        calendarId,
        startDate,
        endDate,
        weekdays,
        startTime,
        endTime,
        memo,
        notificationMinutes,
      });
      const attempt = await beginOrResumeBulkAttempt({
        ownerUserId: journalOwnerUserId,
        calendarId,
        fingerprint,
        dates: previewDates,
      });
      const { attemptId, recurringGroupId, eventIds } = attempt;
      const now = new Date().toISOString();
      const trimmedTitle = title.trim();
      const trimmedMemo = memo.trim();
      // [P0078 CORRECT-F016-001] 各回のendDateはresolveEndDateだけを正本として、
      // 生成対象日(date)ごとに個別に求める（一括作成のstartDate/endDate＝対象期間とは
      // 別概念。混同しない）。
      const events: NormalEvent[] = previewDates.map((date, index) => {
        const resolvedEndDate = resolveEndDate(date, startTime, endTime);
        return {
          id: eventIds[index],
          kind: "normal",
          title: trimmedTitle,
          date,
          startTime,
          endTime,
          endDate: resolvedEndDate === date ? undefined : resolvedEndDate,
          allDay: false,
          location: undefined,
          memo: trimmedMemo || undefined,
          calendarId,
          shareWith: [],
          notification: {
            enabled: notificationMinutes >= 0,
            minutesBefore: Math.max(notificationMinutes, 0),
          },
          repeat: { type: "none" },
          recurringGroupId,
          recurrenceIndex: index,
          completed: false,
          createdAt: now,
          updatedAt: now,
        };
      });
      const result = await onSave(events);
      // [P0080 DATA-F017-001] 「確実に全件コミット済み」または「確実に全件が同期キューへ
      // 積めた」と分類できた場合のみjournalから除去する。それ以外（部分成功・一部のみ
      // キュー投入等、判別が曖昧なケース）は意図的にpendingのまま残す——次回同じ
      // fingerprintでの再送が、このattemptのid組を安全に再利用できるようにするため
      // （resolveBulkAttemptを呼び忘れた場合と同じ安全側の扱い）。
      if (result.failureCount === 0) {
        await resolveBulkAttempt(attemptId, journalOwnerUserId, "committed");
      } else if (result.enqueuedCount === events.length) {
        await resolveBulkAttempt(attemptId, journalOwnerUserId, "queued");
      }
      submittingRef.current = false;
      setSaving(false);
    } catch (e) {
      // Round14、P1-4: identityがstale化/欠落した場合（onSave内部のsaveEventsBulkが
      // 投げる）は、他の保存フローと同様に失敗Alertを出さず静かに終了する
      // （画面はidentity変化により既にremountされているはず）。
      // Round15、P1-4: 以前はfinallyでsetSaving(false)を無条件に呼んでいたため、
      // stale化した古いHookインスタンス側でも状態更新が発生していた。remount前提の
      // 他の保存フロー（NormalEventForm.tsx等）と同じく、stale終了時はsetSavingを呼ばない
      // （submittingRefも同様に据え置く——この画面インスタンスは破棄される想定）。
      if (isStaleMutationError(e)) {
        // [P0082 DATA-F017-002] 以前はstale例外を検知した時点で無条件に"no_commit"として
        // journalから除去していたが、これは誤り（正本の禁止事項）だった: staleは
        // ネットワーク呼び出しより前だけでなく、後（応答待機中の切替）でも起こりうる
        // ——onSave内部（eventService.saveSharedEventsBulk等）はrunCurrentSharedMutationの
        // 仕組み上、実際のリクエスト送信（＝サーバー側で既にコミット済みの可能性がある）
        // より後にもstale再検証を行う。「送信されたかどうか」を判別できる型付きの
        // 下位レイヤー結果が無い以上、安全な既定はjournalを一切解決せずpendingのまま
        // 残すこと（正本§4.A「it is acceptable to leave a truly pre-dispatch stale
        // attempt pending because reusing its IDs later is safe」）。次回同じ
        // fingerprintでの再送（新しいidentityでの再試行を含む）が、このattemptの
        // id組を安全に再利用する。
        return;
      }
      submittingRef.current = false;
      setSaving(false);
      Alert.alert(
        t("common.saveFailedTitle"),
        toFriendlyMessage(e instanceof Error ? e.message : undefined, t("bulkEventForm.saveErrorFallback"), t)
      );
    }
  };

  return (
    <View style={styles.container}>
      <ScreenHeader
        title={t("bulkEventForm.headerTitle")}
        right={
          <PrimaryButton
            label={t("common.save")}
            onPress={handleSubmit}
            loading={saving}
            disabled={saving || previewDates.length === 0}
            style={styles.saveButton}
          />
        }
      />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <SectionCard>
          <FieldRow
            icon="pencil-outline"
            label={t("bulkEventForm.titleLabel")}
            value={title}
            placeholder={t("common.notEntered")}
            onPress={() => setActiveModal("title")}
            errorText={submitted ? errors.title : undefined}
          />
          <FieldRow
            icon="document-text-outline"
            label={t("bulkEventForm.descriptionLabel")}
            value={memo}
            placeholder={t("common.notEntered")}
            onPress={() => setActiveModal("memo")}
          />
        </SectionCard>

        <SectionCard>
          <FieldRow
            icon="calendar-outline"
            label={t("bulkEventForm.startDateLabel")}
            value={formatPreviewDate(startDate, locale)}
            onPress={() => setActiveModal("startDate")}
            errorText={submitted ? errors.startDate : undefined}
          />
          <FieldRow
            icon="calendar-outline"
            label={t("bulkEventForm.endDateLabel")}
            value={formatPreviewDate(endDate, locale)}
            onPress={() => setActiveModal("endDate")}
            errorText={submitted ? errors.endDate : undefined}
          />
          <FieldRow
            icon="repeat-outline"
            label={t("bulkEventForm.weekdayLabel")}
            value={weekdayLabel}
            onPress={() => setActiveModal("weekdays")}
            errorText={submitted ? errors.weekdays : undefined}
          />
          <FieldRow
            icon="time-outline"
            label={t("common.startTime")}
            value={startTime}
            onPress={() => setActiveModal("startTime")}
            errorText={submitted ? errors.startTime : undefined}
          />
          <FieldRow
            icon="time-outline"
            label={t("common.endTime")}
            value={endTime}
            onPress={() => setActiveModal("endTime")}
            errorText={submitted ? errors.endTime : undefined}
          />
        </SectionCard>

        <SectionCard>
          <FieldRow
            icon="notifications-outline"
            label={t("common.notification")}
            value={notificationLabel}
            onPress={() => setActiveModal("notification")}
          />
        </SectionCard>

        <SectionCard>
          <FieldRow
            icon="albums-outline"
            label={t("bulkEventForm.targetCalendarLabel")}
            value={calendarOption?.name ?? t("options.mainCalendar")}
            onPress={() => setActiveModal("calendar")}
            errorText={submitted ? errors.calendarId : undefined}
          />
        </SectionCard>

        <SectionCard>
          <View style={styles.summaryBox}>
            {errors.range ? (
              <Text style={styles.summaryError}>{errors.range}</Text>
            ) : (
              <Text style={styles.summaryCount}>
                {t("bulkEventForm.previewCountText", { count: previewDates.length })}
              </Text>
            )}
            {previewDates.length > 0 && (
              <View style={styles.previewList}>
                {previewDates.slice(0, PREVIEW_LIMIT).map((d) => (
                  <Text key={d} style={styles.previewItem}>
                    {formatPreviewDate(d, locale)}
                  </Text>
                ))}
                {previewDates.length > PREVIEW_LIMIT && (
                  <Text style={styles.previewMore}>
                    {t("common.moreCount", { count: previewDates.length - PREVIEW_LIMIT })}
                  </Text>
                )}
              </View>
            )}
          </View>
        </SectionCard>
      </ScrollView>

      <TextEditModal
        visible={activeModal === "title"}
        title={t("bulkEventForm.titleLabel")}
        initialValue={title}
        placeholder={t("bulkEventForm.titlePlaceholder")}
        onClose={() => setActiveModal(null)}
        onSubmit={setTitle}
      />
      <TextEditModal
        visible={activeModal === "memo"}
        title={t("bulkEventForm.descriptionLabel")}
        initialValue={memo}
        placeholder={t("bulkEventForm.descriptionPlaceholder")}
        multiline
        onClose={() => setActiveModal(null)}
        onSubmit={setMemo}
      />
      <DateTimePickerModal
        visible={activeModal === "startDate"}
        title={t("bulkEventForm.startDateLabel")}
        mode="date"
        value={parseLocalDateString(startDate)}
        onClose={() => setActiveModal(null)}
        onConfirm={(d) => setStartDate(formatLocalDate(d))}
      />
      <DateTimePickerModal
        visible={activeModal === "endDate"}
        title={t("bulkEventForm.endDateLabel")}
        mode="date"
        value={parseLocalDateString(endDate)}
        onClose={() => setActiveModal(null)}
        onConfirm={(d) => setEndDate(formatLocalDate(d))}
      />
      <DateTimePickerModal
        visible={activeModal === "startTime"}
        title={t("common.startTime")}
        mode="time"
        minuteInterval={1}
        value={combineDateAndTime(startDate, startTime)}
        onClose={() => setActiveModal(null)}
        onConfirm={(d) => setStartTime(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`)}
      />
      <DateTimePickerModal
        visible={activeModal === "endTime"}
        title={t("common.endTime")}
        mode="time"
        minuteInterval={1}
        value={combineDateAndTime(endDate, endTime)}
        onClose={() => setActiveModal(null)}
        onConfirm={(d) => setEndTime(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`)}
      />
      <PickerModal
        visible={activeModal === "weekdays"}
        title={t("bulkEventForm.weekdayModalTitle")}
        multiple
        options={Array.from({ length: 7 }, (_, index) => ({
          id: String(index),
          label: t("bulkEventForm.weekdayOptionSuffix", { label: weekdayLabelByIndex(index, locale) }),
        }))}
        selectedIds={weekdays.map(String)}
        onClose={() => setActiveModal(null)}
        onApply={(ids) => setWeekdays(ids.map(Number))}
      />
      <PickerModal
        visible={activeModal === "notification"}
        title={t("common.notification")}
        options={notificationPresets.map<PickerOption>((p) => ({
          id: String(p.minutes),
          label: p.label,
        }))}
        selectedIds={[String(notificationMinutes)]}
        onClose={() => setActiveModal(null)}
        onApply={(ids) => setNotificationMinutes(Number(ids[0]))}
      />
      <PickerModal
        visible={activeModal === "calendar"}
        title={t("bulkEventForm.targetCalendarLabel")}
        options={[
          ...[{ id: "main", name: t("options.mainCalendar") }, ...userCalendars].map<PickerOption>((c) => ({
            id: c.id,
            label: c.name,
          })),
          ...editableSharedCalendars.map<PickerOption>((s) => ({
            id: s.calendar.id,
            label: s.calendar.name,
            helperText: t("common.shared"),
          })),
        ]}
        selectedIds={[calendarId]}
        onClose={() => setActiveModal(null)}
        onApply={(ids) => setCalendarId(ids[0])}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scrollContent: { paddingVertical: spacing.md, paddingBottom: spacing.xxl },
  saveButton: { paddingHorizontal: spacing.md, minHeight: 36 },
  summaryBox: { padding: spacing.lg },
  summaryCount: { fontSize: 16, fontWeight: "700", color: colors.textPrimary },
  summaryError: { fontSize: 14, fontWeight: "700", color: colors.warning },
  previewList: { marginTop: spacing.sm, gap: 4 },
  previewItem: { fontSize: 13, color: colors.textSecondary },
  previewMore: { fontSize: 12, color: colors.textTertiary, marginTop: 2 },
});
