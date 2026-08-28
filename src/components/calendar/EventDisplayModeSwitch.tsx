import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";
import { EventDisplayMode } from "@/utils/eventDisplayMode";

const SEGMENT_OPTIONS: { mode: Exclude<EventDisplayMode, "hideAll">; labelKey: TranslationKey }[] = [
  { mode: "eventsOnly", labelKey: "calendars.eventDisplayEventsOnly" },
  { mode: "both", labelKey: "calendars.eventDisplayBoth" },
  { mode: "focusOnly", labelKey: "calendars.eventDisplayFocusOnly" },
];

const SUMMARY_KEY: Record<EventDisplayMode, TranslationKey> = {
  eventsOnly: "calendars.eventDisplaySummaryEventsOnly",
  both: "calendars.eventDisplaySummaryBoth",
  focusOnly: "calendars.eventDisplaySummaryFocusOnly",
  hideAll: "calendars.eventDisplaySummaryHideAll",
};

interface Props {
  value: EventDisplayMode;
  onChange: (mode: EventDisplayMode) => void;
}

/**
 * マイカレンダー画面の「表示する予定」切替。既存のoverlaySettings（showNormalEvents/showTasks）を
 * src/utils/eventDisplayMode.tsの純粋関数経由で読み書きするだけで、新しいstate・保存キーは
 * 一切持たない（正本は呼び出し元がoverlaySettingsから渡すvalueのみ）。
 * 「すべて非表示」は既存ユーザーが元々取り得たOFF/OFF状態を壊さず残すための追加選択肢として、
 * 3択セグメントとは別の小さな行に分けている（3択のいずれにも属さない状態のため）。
 * チェックを外すと「両方」へ戻る（新しい記憶state無しで決定的に振る舞わせるための既定値）。
 */
export function EventDisplayModeSwitch({ value, onChange }: Props) {
  const { t } = useLocale();
  const isHideAll = value === "hideAll";
  return (
    <View>
      <Text style={styles.sectionLabel}>{t("calendars.eventDisplaySectionTitle")}</Text>
      <View style={styles.segment}>
        {SEGMENT_OPTIONS.map((opt) => {
          const active = value === opt.mode;
          return (
            <Pressable
              key={opt.mode}
              onPress={() => onChange(opt.mode)}
              style={[styles.segmentItem, active && styles.segmentItemActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{t(opt.labelKey)}</Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable
        style={styles.hideAllRow}
        onPress={() => onChange(isHideAll ? "both" : "hideAll")}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isHideAll }}
      >
        <Ionicons
          name={isHideAll ? "checkbox" : "square-outline"}
          size={18}
          color={isHideAll ? colors.primary : colors.borderStrong}
        />
        <Text style={styles.hideAllText}>{t("calendars.eventDisplayHideAll")}</Text>
      </Pressable>
      <Text style={styles.summary}>{t(SUMMARY_KEY[value])}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textTertiary,
    marginBottom: spacing.sm,
  },
  segment: {
    flexDirection: "row",
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    padding: 2,
  },
  segmentItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  segmentItemActive: {
    backgroundColor: colors.primary,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  segmentTextActive: {
    color: colors.textInverse,
  },
  hideAllRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingVertical: spacing.xs,
  },
  hideAllText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  summary: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: spacing.sm,
    lineHeight: 16,
  },
});
