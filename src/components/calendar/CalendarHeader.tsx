import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { minTapSize, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { ViewSwitcher, CalendarViewMode } from "./ViewSwitcher";

interface Props {
  title: string;
  viewMode: CalendarViewMode;
  onChangeViewMode: (mode: CalendarViewMode) => void;
  onPressMenu: () => void;
  onPressAdd: () => void;
  onPressTitle: () => void;
  onPressLanguage: () => void;
  onNavigatePrevious: () => void;
  onNavigateNext: () => void;
  onPressToday: () => void;
}

export function CalendarHeader({
  title,
  viewMode,
  onChangeViewMode,
  onPressMenu,
  onPressAdd,
  onPressTitle,
  onPressLanguage,
  onNavigatePrevious,
  onNavigateNext,
  onPressToday,
}: Props) {
  const { t } = useLocale();
  return (
    <View style={styles.container}>
      <View style={styles.topRow}><Pressable
        onPress={onPressMenu}
        style={styles.iconButton}
        accessibilityLabel={t("calendarHeader.menuLabel")}
        hitSlop={6}
      >
        <Ionicons name="menu" size={26} color={colors.textPrimary} />
      </Pressable>
      <Pressable style={styles.titleButton} onPress={onPressTitle} accessibilityLabel={t("calendarHeader.selectMonthLabel")}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
      </Pressable>
      <Pressable
        onPress={onPressAdd}
        style={styles.addButton}
        accessibilityLabel={t("calendarHeader.addLabel")}
        hitSlop={6}
      >
        <Ionicons name="add" size={24} color={colors.textInverse} />
      </Pressable>
      <Pressable
        onPress={onPressLanguage}
        style={styles.trailingIconButton}
        accessibilityLabel={t("calendarHeader.languageA11yLabel")}
        hitSlop={6}
      >
        <Ionicons name="globe-outline" size={24} color={colors.textPrimary} />
      </Pressable></View>
      <View style={styles.bottomRow}>
        <Pressable
          style={styles.navButton}
          onPress={onNavigatePrevious}
          accessibilityRole="button"
          accessibilityLabel={t("calendarHeader.previousMonthLabel")}
        >
          <Ionicons name="chevron-back" size={20} color={colors.textPrimary} />
        </Pressable>
        <Pressable
          style={styles.todayButton}
          onPress={onPressToday}
          accessibilityRole="button"
          accessibilityLabel={t("calendarHeader.todayA11yLabel")}
        >
          <Text style={styles.todayText}>{t("calendarHeader.todayLabel")}</Text>
        </Pressable>
        <Pressable
          style={styles.navButton}
          onPress={onNavigateNext}
          accessibilityRole="button"
          accessibilityLabel={t("calendarHeader.nextMonthLabel")}
        >
          <Ionicons name="chevron-forward" size={20} color={colors.textPrimary} />
        </Pressable>
        <ViewSwitcher value={viewMode} onChange={onChangeViewMode} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
  },
  topRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  bottomRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs },
  iconButton: {
    width: minTapSize,
    height: minTapSize,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -spacing.sm,
  },
  trailingIconButton: {
    width: minTapSize,
    height: minTapSize,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -spacing.sm,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  titleButton: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 3, minHeight: minTapSize },
  navButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 19, backgroundColor: colors.surfaceAlt },
  todayButton: { height: 38, paddingHorizontal: spacing.sm, alignItems: "center", justifyContent: "center" },
  todayText: { color: colors.primary, fontWeight: "700" },
  addButton: {
    width: minTapSize,
    height: minTapSize,
    borderRadius: minTapSize / 2,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: "auto",
  },
});
