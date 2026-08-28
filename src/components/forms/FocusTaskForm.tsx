import React, { useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { UnlockConditionType, UserCalendar } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { FieldRow } from "./FieldRow";
import { PickerModal, PickerOption } from "./PickerModal";
import { TextEditModal } from "./TextEditModal";
import { DateTimePickerModal } from "./DateTimePickerModal";
import {
  getNotificationPresets,
  getRepeatOptions,
  getRestrictedAppOptions,
  getUnlockConditionOptions,
} from "@/constants/options";
import { formatLocalDate, formatDayTitle, parseLocalDateString } from "@/utils/date";
import { combineDateAndTime, formatDuration } from "@/utils/time";
import { validateFocusTask, hasErrors } from "@/utils/validation";
import { useLocale } from "@/context/LocaleContext";
import { toFriendlyMessage } from "@/utils/friendlyError";

const DURATION_PRESETS = [15, 30, 45, 60, 90, 120];
const UNLOCK_COUNT_PRESETS = [10, 20, 30, 50];

/**
 * v1では「制限するアプリ」「途中解除」はOSレベルのアプリ制限・計算問題出題UIが
 * 未実装のため、導線ごと非表示にする（保存データ・型・バリデーション等の実装コードは
 * 削除していない。restrictedApps/unlockConditionTypeは既存の初期値（空配列/"none"）
 * のまま保存される）。将来実装が揃ったらこの値をtrueに戻すだけで、
 * 下記のSectionCardと対応するPickerModal（3箇所）が復活する。
 */
const APP_LOCK_FEATURE_ENABLED = false;

export interface FocusTaskFormValue {
  title: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  restrictedApps: string[];
  notificationMinutes: number;
  repeatType: "none" | "daily" | "weekly" | "monthly" | "yearly";
  unlockConditionType: UnlockConditionType;
  unlockCount: number;
  memo: string;
  calendarId: string;
}

interface Props {
  initial: FocusTaskFormValue;
  isEditing: boolean;
  userCalendars: UserCalendar[];
  /** ログイン中に参加している共有カレンダー（viewerは予定を作成できないため選択肢から除く） */
  sharedCalendars?: JoinedCalendarSummary[];
  onSave: (value: FocusTaskFormValue) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onStartFocus?: () => void;
  /**
   * 2026-08: 集中タスク作成画面から既存の集中記録・分析画面（/records）へのワンタップ導線。
   * 渡された場合のみ、専用の案内カードを表示する（作成画面だけに導線を出すため、
   * app/focus/[id].tsx（編集画面）からは渡さない）。
   */
  onViewRecords?: () => void;
  /**
   * Stage I-6: 表示専用。対象のFocusTaskが集中モード完了済みかどうか（BaseEvent.completed）。
   * 「✓ 完了済み」の表示にのみ使う。ここから完了状態を切り替える操作は提供しない。
   */
  completed?: boolean;
}

type ActiveModal =
  | null
  | "title"
  | "date"
  | "startTime"
  | "duration"
  | "restrictedApps"
  | "notification"
  | "repeat"
  | "unlockType"
  | "unlockCount"
  | "memo"
  | "calendar";

export function FocusTaskForm({
  initial,
  isEditing,
  userCalendars,
  sharedCalendars = [],
  onSave,
  onDelete,
  onStartFocus,
  onViewRecords,
  completed,
}: Props) {
  const { t, locale } = useLocale();
  const [value, setValue] = useState<FocusTaskFormValue>(initial);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  // 二重タップで/recordsを複数回積まないための短い遷移中ガード（画面遷移のライフサイクルには
  // 依存せず、一定時間後に自動で解除する。フォームの値・保存処理には一切影響しない）。
  const navigatingToRecordsRef = useRef(false);
  const handleViewRecords = () => {
    if (!onViewRecords || navigatingToRecordsRef.current) return;
    navigatingToRecordsRef.current = true;
    onViewRecords();
    setTimeout(() => {
      navigatingToRecordsRef.current = false;
    }, 800);
  };

  const editableSharedCalendars = sharedCalendars.filter((s) => s.role !== "viewer");
  const calendarOption =
    userCalendars.find((c) => c.id === value.calendarId) ??
    editableSharedCalendars.find((s) => s.calendar.id === value.calendarId)?.calendar;

  const errors = useMemo(
    () =>
      validateFocusTask(
        {
          title: value.title,
          date: value.date,
          startTime: value.startTime,
          durationMinutes: value.durationMinutes,
        },
        t
      ),
    [value, t]
  );

  const notificationPresets = getNotificationPresets(t);
  const repeatOptions = getRepeatOptions(t);
  const restrictedAppOptions = getRestrictedAppOptions(t);
  const unlockConditionOptions = getUnlockConditionOptions(t);

  const notificationLabel =
    notificationPresets.find((p) => p.minutes === value.notificationMinutes)?.label ??
    t("options.notificationNone");
  const repeatLabel =
    repeatOptions.find((r) => r.value === value.repeatType)?.label ?? t("options.repeatNone");
  const restrictedLabel =
    value.restrictedApps.length === 0
      ? t("common.notSet")
      : value.restrictedApps
          .map((id) => restrictedAppOptions.find((o) => o.id === id)?.name)
          .filter(Boolean)
          .join(t("restrictedAppsList.listSeparator"));
  const unlockTypeLabel =
    unlockConditionOptions.find((o) => o.type === value.unlockConditionType)
      ?.label ?? t("options.unlockConditionNone");

  const handleSubmit = async () => {
    setSubmitted(true);
    if (hasErrors(errors)) return;
    setSaving(true);
    try {
      await onSave(value);
    } catch (e) {
      setSaving(false);
      // common.saveFailedMessageはドラッグ操作で位置が戻る文脈専用の文言のため、
      // フォーム保存の失敗にはtoFriendlyMessage経由の汎用メッセージを使う。
      Alert.alert(
        t("common.saveFailedTitle"),
        toFriendlyMessage(e instanceof Error ? e.message : undefined, t("friendlyError.localPersistenceFailed"), t)
      );
      return;
    }
    setSaving(false);
  };

  const confirmDelete = () => {
    Alert.alert(t("focusTaskForm.deleteConfirmTitle"), t("focusTaskForm.deleteConfirmMessage"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: () => {
          // 同期void/非同期どちらのonDeleteでも失敗を確実に捕捉するため.then()内で呼び出す。
          Promise.resolve()
            .then(() => onDelete?.())
            .catch((e) => {
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
      <ScreenHeader
        title={isEditing ? t("focusTaskForm.editHeaderTitle") : t("focusTaskForm.createHeaderTitle")}
        backLabel={t("common.cancel")}
        right={
          <PrimaryButton
            label={t("focusTaskForm.submitButton")}
            onPress={handleSubmit}
            loading={saving}
            style={styles.saveButton}
          />
        }
      />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <SectionCard>
          <FieldRow
            icon="pencil-outline"
            label={t("focusTaskForm.taskNameLabel")}
            value={value.title}
            placeholder={t("common.notEntered")}
            onPress={() => setActiveModal("title")}
            errorText={submitted ? errors.title : undefined}
            required
          />
          <FieldRow
            icon="calendar-outline"
            label={t("focusTaskForm.executionDateLabel")}
            value={formatDayTitle(value.date, locale)}
            onPress={() => setActiveModal("date")}
            errorText={submitted ? errors.date : undefined}
            required
          />
          <FieldRow
            icon="time-outline"
            label={t("common.startTime")}
            value={value.startTime}
            onPress={() => setActiveModal("startTime")}
            errorText={submitted ? errors.startTime : undefined}
            required
          />
          <FieldRow
            icon="timer-outline"
            label={t("focusTaskForm.durationLabel")}
            value={formatDuration(value.durationMinutes, locale)}
            onPress={() => setActiveModal("duration")}
            errorText={submitted ? errors.durationMinutes : undefined}
            required
          />
        </SectionCard>

        {(userCalendars.length > 0 || editableSharedCalendars.length > 0) && (
          <SectionCard>
            <FieldRow
              icon="albums-outline"
              label={t("focusTaskForm.calendarLabel")}
              value={calendarOption?.name ?? t("calendars.baseCalendarName")}
              onPress={() => setActiveModal("calendar")}
            />
          </SectionCard>
        )}

        {APP_LOCK_FEATURE_ENABLED && (
          <SectionCard>
            <FieldRow
              icon="ban-outline"
              label={t("focusTaskForm.restrictedAppsLabel")}
              value={restrictedLabel}
              onPress={() => setActiveModal("restrictedApps")}
            />
            <FieldRow
              icon="lock-closed-outline"
              label={t("focusTaskForm.midUnlockLabel")}
              value={unlockTypeLabel}
              onPress={() => setActiveModal("unlockType")}
            />
            {value.unlockConditionType === "calculation" && (
              <FieldRow
                icon="calculator-outline"
                label={t("focusTaskForm.unlockConditionLabel")}
                value={t("focusTaskForm.unlockCountSummary", { count: value.unlockCount })}
                onPress={() => setActiveModal("unlockCount")}
              />
            )}
          </SectionCard>
        )}

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

        <SectionCard>
          <FieldRow
            icon="document-text-outline"
            label={t("focusTaskForm.memoLabel")}
            value={value.memo}
            placeholder={t("common.notEntered")}
            onPress={() => setActiveModal("memo")}
          />
        </SectionCard>

        {isEditing && completed && (
          <View style={styles.noticeBox}>
            <FieldRow icon="checkmark-circle" label={t("focusTaskForm.alreadyCompletedLabel")} showChevron={false} />
          </View>
        )}

        <View style={styles.noticeBox}>
          <FieldRow
            icon="lock-closed"
            label={t("focusTaskForm.lockedNoticeLabel")}
            showChevron={false}
          />
        </View>

        {onViewRecords && (
          <View style={styles.recordsLinkWrap}>
            <Pressable
              onPress={handleViewRecords}
              style={({ pressed }) => [
                styles.recordsLinkCard,
                pressed && styles.recordsLinkCardPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t("focusTaskForm.viewRecordsAccessibilityLabel")}
            >
              <Ionicons
                name="stats-chart-outline"
                size={20}
                color={colors.primary}
                style={styles.recordsLinkIcon}
              />
              <Text style={styles.recordsLinkLabel} numberOfLines={2}>
                {t("focusTaskForm.viewRecordsButton")}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>
          </View>
        )}

        {isEditing && onStartFocus && (
          <View style={styles.startButtonWrap}>
            <PrimaryButton label={t("focus.startButton")} onPress={onStartFocus} />
          </View>
        )}

        {isEditing && onDelete && (
          <SectionCard>
            <FieldRow
              icon="trash-outline"
              label={t("focusTaskForm.deleteConfirmTitle")}
              danger
              showChevron={false}
              onPress={confirmDelete}
            />
          </SectionCard>
        )}
      </ScrollView>

      <TextEditModal
        visible={activeModal === "title"}
        title={t("focusTaskForm.taskNameLabel")}
        initialValue={value.title}
        placeholder={t("focusTaskForm.taskNamePlaceholder")}
        onClose={() => setActiveModal(null)}
        onSubmit={(v) => setValue((prev) => ({ ...prev, title: v }))}
      />
      <TextEditModal
        visible={activeModal === "memo"}
        title={t("focusTaskForm.memoLabel")}
        initialValue={value.memo}
        placeholder={t("focusTaskForm.memoPlaceholder")}
        multiline
        onClose={() => setActiveModal(null)}
        onSubmit={(v) => setValue((prev) => ({ ...prev, memo: v }))}
      />
      <DateTimePickerModal
        visible={activeModal === "date"}
        title={t("focusTaskForm.executionDateLabel")}
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
        onConfirm={(d) =>
          setValue((prev) => ({
            ...prev,
            startTime: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
          }))
        }
      />
      <PickerModal
        visible={activeModal === "duration"}
        title={t("focusTaskForm.durationLabel")}
        options={DURATION_PRESETS.map<PickerOption>((m) => ({
          id: String(m),
          label: formatDuration(m, locale),
        }))}
        selectedIds={[String(value.durationMinutes)]}
        onClose={() => setActiveModal(null)}
        onApply={(ids) =>
          setValue((prev) => ({ ...prev, durationMinutes: Number(ids[0]) }))
        }
      />
      {APP_LOCK_FEATURE_ENABLED && (
        <PickerModal
          visible={activeModal === "restrictedApps"}
          title={t("focusTaskForm.restrictedAppsLabel")}
          multiple
          options={restrictedAppOptions.map<PickerOption>((o) => ({
            id: o.id,
            label: o.name,
          }))}
          selectedIds={value.restrictedApps}
          onClose={() => setActiveModal(null)}
          onApply={(ids) => setValue((prev) => ({ ...prev, restrictedApps: ids }))}
        />
      )}
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
            repeatType: ids[0] as FocusTaskFormValue["repeatType"],
          }))
        }
      />
      {APP_LOCK_FEATURE_ENABLED && (
        <PickerModal
          visible={activeModal === "unlockType"}
          title={t("focusTaskForm.unlockConditionModalTitle")}
          options={unlockConditionOptions.map<PickerOption>((o) => ({
            id: o.type,
            label: o.label,
          }))}
          selectedIds={[value.unlockConditionType]}
          onClose={() => setActiveModal(null)}
          onApply={(ids) =>
            setValue((prev) => ({
              ...prev,
              unlockConditionType: ids[0] as UnlockConditionType,
            }))
          }
        />
      )}
      {APP_LOCK_FEATURE_ENABLED && (
        <PickerModal
          visible={activeModal === "unlockCount"}
          title={t("focusTaskForm.unlockCountModalTitle")}
          options={UNLOCK_COUNT_PRESETS.map<PickerOption>((c) => ({
            id: String(c),
            label: t("focusTaskForm.unlockCountOption", { count: c }),
          }))}
          selectedIds={[String(value.unlockCount)]}
          onClose={() => setActiveModal(null)}
          onApply={(ids) =>
            setValue((prev) => ({ ...prev, unlockCount: Number(ids[0]) }))
          }
        />
      )}
      <PickerModal
        visible={activeModal === "calendar"}
        title={t("focusTaskForm.calendarLabel")}
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
  scrollContent: {
    paddingVertical: spacing.md,
    paddingBottom: spacing.xxl,
  },
  saveButton: {
    paddingHorizontal: spacing.md,
    minHeight: 36,
  },
  noticeBox: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    backgroundColor: colors.focusSoft,
    borderRadius: radius.md,
  },
  startButtonWrap: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
  },
  recordsLinkWrap: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    // 画面下部・ホームインジケーターと重ならないよう、ScrollView自体のpaddingBottom
    // （scrollContent.paddingBottom）に加えてこのカード自身にも下マージンを確保する。
    marginBottom: spacing.xl,
  },
  recordsLinkCard: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: minTapSize + 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  recordsLinkCardPressed: {
    opacity: 0.6,
  },
  recordsLinkIcon: {
    marginRight: spacing.sm,
  },
  recordsLinkLabel: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
    color: colors.textPrimary,
  },
});
