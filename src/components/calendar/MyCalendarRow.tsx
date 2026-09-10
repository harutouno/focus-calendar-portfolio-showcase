import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CoverImage } from "./CoverImage";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { UserCalendar } from "@/types/event";

interface Props {
  calendar: UserCalendar;
  visible: boolean;
  onToggleVisible: () => void;
  onPressMenu: () => void;
}

/**
 * マイカレンダー画面の「追加マイカレンダー」一覧の1行。
 * 表示ON/OFFは複数同時に選択可能（ラジオボタンではない）で、既存の正本（overlaySettings）を
 * そのままトグルするだけ（このコンポーネント自身は状態を持たない）。
 */
export function MyCalendarRow({ calendar, visible, onToggleVisible, onPressMenu }: Props) {
  const { t } = useLocale();
  return (
    <View style={styles.row}>
      <Pressable
        style={styles.checkArea}
        onPress={onToggleVisible}
        hitSlop={8}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: visible }}
        accessibilityLabel={`${calendar.name}${
          visible ? t("calendarVisibilityChips.suffixShowing") : t("calendarVisibilityChips.suffixHidden")
        }`}
      >
        <Ionicons
          name={visible ? "checkmark-circle" : "ellipse-outline"}
          size={22}
          color={visible ? colors.primary : colors.borderStrong}
        />
      </Pressable>
      <Pressable style={styles.tapArea} onPress={onPressMenu} accessibilityRole="button">
        <View style={styles.cover}>
          <CoverImage uri={calendar.coverImageUri} color={calendar.color} icon="person-outline" iconSize={16} />
        </View>
        <View style={styles.textWrap}>
          <View style={styles.nameRow}>
            <View style={[styles.colorDot, { backgroundColor: calendar.color }]} />
            <Text style={styles.name} numberOfLines={1}>
              {calendar.name}
            </Text>
          </View>
        </View>
      </Pressable>
      <Pressable
        hitSlop={8}
        style={styles.menuButton}
        onPress={onPressMenu}
        accessibilityRole="button"
        accessibilityLabel={t("overlay.rowMenuA11y", { name: calendar.name })}
      >
        <Ionicons name="ellipsis-vertical" size={18} color={colors.textTertiary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: minTapSize + 8,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  checkArea: {
    width: minTapSize - 12,
    height: minTapSize - 12,
    alignItems: "center",
    justifyContent: "center",
  },
  cover: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  tapArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: minTapSize,
  },
  textWrap: {
    flex: 1,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  colorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  name: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textPrimary,
    flexShrink: 1,
  },
  menuButton: {
    width: minTapSize - 8,
    height: minTapSize - 8,
    alignItems: "center",
    justifyContent: "center",
  },
});
