import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "@/theme/colors";
import { radius } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";

export type CalendarViewMode = "month" | "week" | "day";

const OPTION_KEYS: { mode: CalendarViewMode; labelKey: TranslationKey }[] = [
  { mode: "month", labelKey: "viewSwitcher.month" },
  { mode: "week", labelKey: "viewSwitcher.week" },
  { mode: "day", labelKey: "viewSwitcher.day" },
];

interface Props {
  value: CalendarViewMode;
  onChange: (mode: CalendarViewMode) => void;
}

export function ViewSwitcher({ value, onChange }: Props) {
  const { t } = useLocale();
  const options = OPTION_KEYS.map((o) => ({ mode: o.mode, label: t(o.labelKey) }));
  return (
    <View style={styles.container}>
      {options.map((opt) => {
        const active = value === opt.mode;
        return (
          <Pressable
            key={opt.mode}
            onPress={() => onChange(opt.mode)}
            style={[styles.item, active && styles.itemActive]}
          >
            <Text style={[styles.text, active && styles.textActive]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    padding: 2,
  },
  item: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  itemActive: {
    backgroundColor: colors.primary,
  },
  text: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  textActive: {
    color: colors.textInverse,
  },
});
