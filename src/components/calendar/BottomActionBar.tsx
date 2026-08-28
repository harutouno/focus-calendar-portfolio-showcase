import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  onPressOverlay: () => void;
  onPressFocus: () => void;
  /** 未指定の場合、AIボタン自体を表示しない（v1.0ではRemote AI未デプロイのため非表示にする用途） */
  onPressAI?: () => void;
  onPressCalendars: () => void;
  onPressActivity: () => void;
  focusActive?: boolean;
}

/** カレンダー画面下部の主要操作: 重ねる / 集中 / AI */
export function BottomActionBar({
  onPressOverlay,
  onPressFocus,
  onPressAI,
  onPressCalendars,
  onPressActivity,
  focusActive,
}: Props) {
  const { t } = useLocale();
  return (
    <View style={styles.container}>
      <Pressable style={styles.item} onPress={onPressOverlay}>
        <Ionicons name="layers-outline" size={22} color={colors.textSecondary} />
        <Text style={styles.label}>{t("bottomActionBar.overlay")}</Text>
      </Pressable>

      <Pressable style={styles.item} onPress={onPressCalendars}>
        <Ionicons name="calendar-outline" size={22} color={colors.textSecondary} />
        <Text style={styles.label}>{t("bottomActionBar.calendar")}</Text>
      </Pressable>

      <Pressable style={styles.focusItem} onPress={onPressFocus}>
        <View style={[styles.focusPill, focusActive && styles.focusPillActive]}>
          <Ionicons
            name={focusActive ? "lock-closed" : "lock-closed-outline"}
            size={18}
            color={colors.textInverse}
          />
          <Text style={styles.focusLabel}>{t("bottomActionBar.focus")}</Text>
        </View>
      </Pressable>

      {onPressAI && (
        <Pressable style={styles.item} onPress={onPressAI}>
          <Ionicons name="sparkles-outline" size={22} color={colors.textSecondary} />
          <Text style={styles.label}>{t("bottomActionBar.ai")}</Text>
        </Pressable>
      )}
      <Pressable style={styles.item} onPress={onPressActivity}>
        <View><Ionicons name="notifications-outline" size={22} color={colors.textSecondary} /><View style={styles.unreadDot} /></View>
        <Text style={styles.label}>{t("bottomActionBar.activity")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    backgroundColor: colors.surface,
  },
  item: {
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    minHeight: minTapSize,
    gap: 2,
  },
  label: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  focusItem: {
    flex: 1.25,
    alignItems: "center",
    justifyContent: "center",
    minHeight: minTapSize,
  },
  focusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  focusPillActive: {
    backgroundColor: colors.focus,
  },
  focusLabel: {
    color: colors.textInverse,
    fontSize: 14,
    fontWeight: "700",
  },
  unreadDot: { position: "absolute", right: -2, top: -1, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.warning },
});
