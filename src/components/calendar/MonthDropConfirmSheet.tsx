import React, { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppEvent, isNormalEvent } from "@/types/event";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { FieldRow } from "@/components/forms/FieldRow";
import { DateTimePickerModal } from "@/components/forms/DateTimePickerModal";
import { formatDayTitle } from "@/utils/date";
import { combineDateAndTime } from "@/utils/time";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  visible: boolean;
  event: AppEvent | null;
  /** ドラッグで移動した先の日付 */
  newDate: string;
  onCancel: () => void;
  /** 「この時刻で保存」: 現在編集中の時刻で保存する */
  onSaveWithTime: (time: string) => void;
  /** 「元の時刻のまま保存」: 編集内容を破棄し、元の開始時刻のまま保存する */
  onSaveWithOriginalTime: () => void;
}

/**
 * 月表示でドラッグして日付を変えたあと、時刻を確認・調整するための確認シート。
 * キャンセルすると一切保存しない（呼び出し側は元の位置に戻す）。
 */
export function MonthDropConfirmSheet({
  visible,
  event,
  newDate,
  onCancel,
  onSaveWithTime,
  onSaveWithOriginalTime,
}: Props) {
  const { t, locale } = useLocale();
  const [draftTime, setDraftTime] = useState(event?.startTime ?? "09:00");
  const [timePickerVisible, setTimePickerVisible] = useState(false);

  useEffect(() => {
    if (visible && event) setDraftTime(event.startTime);
  }, [visible, event]);

  if (!event) return null;

  const originalTimeLabel = isNormalEvent(event)
    ? `${event.startTime}${t("common.rangeSeparator")}${event.endTime}`
    : `${event.startTime}${t("common.rangeSeparator")}${t("monthDropConfirm.focusDurationKept")}`;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t("monthDropConfirm.title")}</Text>
            <Pressable onPress={onCancel} hitSlop={8} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <View style={styles.summary}>
            <Text style={styles.eventTitle} numberOfLines={1}>
              {event.title}
            </Text>
            <Text style={styles.summaryLine}>
              {t("monthDropConfirm.originalTimeLabel", { time: originalTimeLabel })}
            </Text>
            <Text style={styles.summaryLine}>
              {t("monthDropConfirm.newDateLabel", { date: formatDayTitle(newDate, locale) })}
            </Text>
          </View>

          <FieldRow
            icon="time-outline"
            label={t("common.startTime")}
            value={draftTime}
            onPress={() => setTimePickerVisible(true)}
          />

          <View style={styles.actions}>
            <PrimaryButton
              label={t("monthDropConfirm.confirmButton")}
              onPress={() => onSaveWithTime(draftTime)}
              style={styles.actionButton}
            />
            <PrimaryButton
              label={t("monthDropConfirm.keepOriginalButton")}
              variant="secondary"
              onPress={onSaveWithOriginalTime}
              style={styles.actionButton}
            />
            <PrimaryButton
              label={t("common.cancel")}
              variant="ghost"
              onPress={onCancel}
              style={styles.actionButton}
            />
          </View>
        </View>
      </View>

      <DateTimePickerModal
        visible={timePickerVisible}
        title={t("common.startTime")}
        mode="time"
        minuteInterval={15}
        value={combineDateAndTime(newDate, draftTime)}
        onClose={() => setTimePickerVisible(false)}
        onConfirm={(d) => {
          const h = d.getHours();
          const m = d.getMinutes();
          setDraftTime(`${h < 10 ? "0" + h : h}:${m < 10 ? "0" + m : m}`);
        }}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  closeBtn: {
    width: minTapSize,
    height: minTapSize,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -spacing.sm,
  },
  summary: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 4,
  },
  eventTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 2,
  },
  summaryLine: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  actions: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  actionButton: {
    marginTop: 0,
  },
});
