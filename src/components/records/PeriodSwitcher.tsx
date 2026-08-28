import React from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";

export interface PeriodSwitcherOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: PeriodSwitcherOption<T>[];
  selected: T;
  onSelect: (value: T) => void;
}

/**
 * 集中記録・分析画面の期間切替（今日／直近7日／直近30日、プレミアムは追加でthisWeek〜custom）。
 * 無料/プレミアムでどのoptionsを渡すかは呼び出し元（app/records.tsx）がFOCUS_ANALYTICS_LIMITSを見て決める。
 * このコンポーネント自体はプラン判定を持たない、純粋な選択UI。
 */
export function PeriodSwitcher<T extends string>({ options, selected, onSelect }: Props<T>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      {options.map((opt) => {
        const isSelected = opt.value === selected;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onSelect(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            accessibilityLabel={opt.label}
            style={[styles.pill, isSelected && styles.pillSelected]}
          >
            <Text style={[styles.pillText, isSelected && styles.pillTextSelected]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.sm,
  },
  content: {
    paddingHorizontal: spacing.lg,
    gap: spacing.xs,
  },
  pill: {
    minHeight: minTapSize - 8,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    marginRight: spacing.xs,
  },
  pillSelected: {
    backgroundColor: colors.primary,
  },
  pillText: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  pillTextSelected: {
    color: colors.textInverse,
  },
});
