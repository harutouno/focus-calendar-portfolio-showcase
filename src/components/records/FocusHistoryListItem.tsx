import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { FocusSessionRecord } from "@/types/event";
import { nowHHMM } from "@/utils/time";
import { parseLocalDateString } from "@/utils/date";
import {
  formatFocusDuration,
  resolveCalendarName,
  resolveCalendarType,
  resolveCreditedFocusSeconds,
  resolveLocalDateKey,
} from "@/utils/focusStats";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  record: FocusSessionRecord;
}

/**
 * 履歴一覧の1行（仕様20番）。タスク名・カレンダー名・マイ/共有・完了日・開始時刻・
 * 集中時間・ステータス・中断回数を表示する。完了/未完了はアイコン+色の両方で区別し、
 * 色だけに依存しない。
 */
export function FocusHistoryListItem({ record }: Props) {
  const { t, locale } = useLocale();
  const isCompleted = record.completedFully === true;
  const dateKey = resolveLocalDateKey(record);
  const dateLabel = formatShortDateLabel(dateKey);
  const startTimeLabel = nowHHMM(new Date(record.startedAt));
  const durationLabel = formatFocusDuration(
    Math.round(resolveCreditedFocusSeconds(record) / 60),
    locale
  );
  const calendarType = resolveCalendarType(record);
  const calendarName = resolveCalendarName(record, t("records.unknownCalendar"));
  const calendarTypeLabel =
    calendarType === "shared"
      ? t("records.calendarTypeShared")
      : calendarType === "my"
        ? t("records.calendarTypeMy")
        : null;
  const statusLabel = isCompleted ? t("records.completedLabel") : t("records.statusIncomplete");
  const interruptionCount = Number.isFinite(record.interruptionCount)
    ? (record.interruptionCount as number)
    : 0;

  const a11yLabel = t("records.historyItemA11y", {
    title: record.taskTitle,
    date: dateLabel,
    time: startTimeLabel,
    duration: durationLabel,
    status: statusLabel,
  });

  return (
    <View style={styles.row} accessible accessibilityLabel={a11yLabel}>
      <View
        style={[
          styles.statusIcon,
          isCompleted ? styles.statusIconCompleted : styles.statusIconIncomplete,
        ]}
      >
        <Ionicons
          name={isCompleted ? "checkmark-circle" : "alert-circle"}
          size={18}
          color={isCompleted ? colors.meeting : colors.warning}
        />
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {record.taskTitle}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {calendarName}
          {calendarTypeLabel ? `・${calendarTypeLabel}` : ""}・{dateLabel} {startTimeLabel}
        </Text>
        {!isCompleted && interruptionCount > 0 && (
          <Text style={styles.interruptionHint}>
            {t("records.completedCount", { count: interruptionCount })}
          </Text>
        )}
      </View>
      <View style={styles.trailing}>
        <Text style={styles.duration}>{durationLabel}</Text>
        <Text
          style={[
            styles.statusText,
            isCompleted ? styles.statusTextCompleted : styles.statusTextIncomplete,
          ]}
        >
          {statusLabel}
        </Text>
      </View>
    </View>
  );
}

function formatShortDateLabel(dateKey: string): string {
  const d = parseLocalDateString(dateKey);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  statusIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  statusIconCompleted: {
    backgroundColor: colors.meetingSoft,
  },
  statusIconIncomplete: {
    backgroundColor: colors.primarySoft,
  },
  body: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  sub: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
  },
  interruptionHint: {
    fontSize: 11,
    color: colors.warning,
    marginTop: 2,
  },
  trailing: {
    alignItems: "flex-end",
  },
  duration: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "700",
    marginTop: 2,
  },
  statusTextCompleted: {
    color: colors.meeting,
  },
  statusTextIncomplete: {
    color: colors.warning,
  },
});
