import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { MonthlyFocusStat } from "@/utils/focusStats";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  months: MonthlyFocusStat[];
}

const CHART_HEIGHT = 100;
const COLUMN_WIDTH = 34;

/**
 * 過去12か月の集中時間の推移。既存のWeeklyBarChartと同じ「Viewで組んだ簡易棒グラフ」の
 * デザイン方針を踏襲しつつ、12本のバーが小さい画面でも詰まって読めなくならないよう、
 * 横スクロール可能なコンテナに収める（外部チャートライブラリは使用しない）。
 */
export function MonthlyTrendChart({ months }: Props) {
  const { t } = useLocale();
  const max = Math.max(1, ...months.map((m) => m.minutes));
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t("monthlyTrendChart.title")}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.chart}>
          {months.map((m) => {
            const height = Math.max(2, (m.minutes / max) * CHART_HEIGHT);
            const roundedHours = Math.round(m.minutes / 60);
            return (
              <View key={m.key} style={styles.barColumn}>
                {m.minutes > 0 && (
                  <Text style={styles.barValue}>{roundedHours}h</Text>
                )}
                <View style={styles.barTrack}>
                  <View style={[styles.bar, { height }]} />
                </View>
                <Text style={styles.barLabel} numberOfLines={1}>
                  {m.label}
                </Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.xl,
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  chart: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  barColumn: {
    alignItems: "center",
    width: COLUMN_WIDTH,
  },
  barValue: {
    fontSize: 9,
    color: colors.textSecondary,
    marginBottom: 2,
  },
  barTrack: {
    height: CHART_HEIGHT,
    width: 14,
    justifyContent: "flex-end",
  },
  bar: {
    width: "100%",
    backgroundColor: colors.focus,
    borderRadius: 4,
  },
  barLabel: {
    marginTop: 4,
    fontSize: 10,
    color: colors.textSecondary,
  },
});
