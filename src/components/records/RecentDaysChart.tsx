import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { DailyFocusPoint, formatFocusDuration } from "@/utils/focusStats";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  points: DailyFocusPoint[];
}

const CHART_HEIGHT = 120;

/**
 * 無料版でも表示する直近7日間の集中時間グラフ（仕様19番）。完了記録のみを対象にした
 * DailyFocusPointを描画する。既存のWeeklyBarChartと同じ「Viewで組んだ棒グラフ」方針を踏襲しつつ、
 * 今日を色だけに頼らず文字ラベルでも識別できるようにし、各棒にアクセシビリティラベルを付与する。
 */
export function RecentDaysChart({ points }: Props) {
  const { t, locale } = useLocale();
  const max = Math.max(1, ...points.map((p) => p.totalCreditedSeconds));

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t("records.recentDaysChartTitle")}</Text>
      <View style={styles.chart}>
        {points.map((p) => {
          const height = Math.max(2, (p.totalCreditedSeconds / max) * CHART_HEIGHT);
          const durationLabel = formatFocusDuration(Math.round(p.totalCreditedSeconds / 60), locale);
          return (
            <View
              key={p.dateKey}
              style={styles.barColumn}
              accessible
              accessibilityLabel={t("records.recentDaysChartBarA11y", {
                day: p.label,
                duration: durationLabel,
              })}
            >
              {p.totalCreditedSeconds > 0 && <Text style={styles.barValue}>{durationLabel}</Text>}
              <View style={styles.barTrack}>
                <View style={[styles.bar, { height }, p.isToday && styles.barToday]} />
              </View>
              <Text style={[styles.barLabel, p.isToday && styles.barLabelToday]}>{p.label}</Text>
              {/* 今日は色だけに頼らず、文字でも明示する */}
              {p.isToday && <Text style={styles.todayMarker}>{t("records.todayMarker")}</Text>}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  chart: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  barColumn: {
    alignItems: "center",
    flex: 1,
  },
  barValue: {
    fontSize: 10,
    color: colors.textSecondary,
    marginBottom: 2,
  },
  barTrack: {
    height: CHART_HEIGHT,
    width: 18,
    justifyContent: "flex-end",
  },
  bar: {
    width: "100%",
    backgroundColor: colors.primary,
    borderRadius: 4,
  },
  barToday: {
    backgroundColor: colors.focus,
  },
  barLabel: {
    marginTop: 4,
    fontSize: 11,
    color: colors.textSecondary,
  },
  barLabelToday: {
    fontWeight: "700",
    color: colors.textPrimary,
  },
  todayMarker: {
    marginTop: 1,
    fontSize: 9,
    fontWeight: "700",
    color: colors.focus,
  },
});
