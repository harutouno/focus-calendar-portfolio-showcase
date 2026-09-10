import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SectionCard } from "@/components/common/SectionCard";
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
 * 誰もが最初から持つ、削除できない基本のマイカレンダー「自分一人用」の独立カード。
 * 追加マイカレンダー一覧（MyCalendarRow）とは別の、常にリスト最上部にある専用カードとして表示する。
 * 削除メニューは持たず、代わりに小さな鍵アイコンで削除不可であることを示す。
 */
export function BaseCalendarCard({ calendar, visible, onToggleVisible, onPressMenu }: Props) {
  const { t } = useLocale();
  return (
    <SectionCard style={styles.card}>
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
          size={26}
          color={visible ? colors.primary : colors.borderStrong}
        />
      </Pressable>
      <Pressable style={styles.tapArea} onPress={onPressMenu} accessibilityRole="button">
        <View style={styles.cover}>
          <CoverImage uri={calendar.coverImageUri} color={calendar.color} icon="person-outline" iconSize={22} />
        </View>
        <View style={styles.textWrap}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {calendar.name}
            </Text>
            <Ionicons name="lock-closed" size={12} color={colors.textTertiary} />
          </View>
          <Text style={styles.subtitle}>{t("calendars.baseCalendarSubtitle")}</Text>
        </View>
      </Pressable>
      <Pressable
        hitSlop={8}
        style={styles.menuButton}
        onPress={onPressMenu}
        accessibilityRole="button"
        accessibilityLabel={t("overlay.rowMenuA11y", { name: calendar.name })}
      >
        <Ionicons name="ellipsis-vertical" size={20} color={colors.textTertiary} />
      </Pressable>
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  checkArea: {
    width: minTapSize - 8,
    height: minTapSize - 8,
    alignItems: "center",
    justifyContent: "center",
  },
  cover: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  tapArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  textWrap: {
    flex: 1,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  name: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textPrimary,
    flexShrink: 1,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
  },
  menuButton: {
    width: minTapSize - 8,
    height: minTapSize - 8,
    alignItems: "center",
    justifyContent: "center",
  },
});
