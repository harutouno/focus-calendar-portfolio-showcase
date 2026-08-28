import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AIScheduleSummary } from "@/types/ai";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";
import { formatDayTitle } from "@/utils/date";
import { useLocale } from "@/context/LocaleContext";

export function AiScheduleCard({ schedule }: { schedule: AIScheduleSummary }) {
  const { t, locale } = useLocale();
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="calendar" size={16} color={colors.primary} />
        <Text style={styles.headerText}>{t("aiScheduleCard.header")}</Text>
      </View>
      <Text style={styles.title}>{schedule.title}</Text>
      <Text style={styles.detail}>{formatDayTitle(schedule.date, locale)}</Text>
      <Text style={styles.detail}>
        {schedule.startTime}
        {schedule.endTime ? `${t("common.rangeSeparator")}${schedule.endTime}` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: spacing.xs,
  },
  headerText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: "700",
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  detail: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
});
