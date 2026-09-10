import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CoverImage } from "./CoverImage";
import { Avatar } from "@/components/common/Avatar";
import { JoinedCalendarSummary } from "@/types/sharing";
import { joinedStatusLabel } from "@/utils/calendarListRows";
import { useSignedCoverUrl } from "@/hooks/useSignedCoverUrl";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";

const MAX_ROW_AVATARS = 3;

interface Props {
  summary: JoinedCalendarSummary;
  visible: boolean;
  onToggleVisible: () => void;
  /** カード本体タップ時。既存の共有カレンダー詳細画面（/calendar/[id]）へ遷移させる想定。 */
  onPress: () => void;
  /** 3点メニュータップ時。SharedCalendarActionSheetを開く想定。 */
  onPressMenu: () => void;
}

/**
 * 共有タブの「自分が作成した共有カレンダー」「参加中の共有カレンダー」で共通利用する行。
 * マイカレンダー画面のMyCalendarRowと同じ構造（チェック＋カバー＋テキスト＋3点メニュー）で
 * 統一感を持たせるが、本体タップの遷移先は（MyCalendarRowと異なり）3点メニューではなく
 * 既存の共有カレンダー詳細画面にする——共有カレンダーは既に詳細画面を持っているため。
 * 権限（owner/editor/viewer）による表示の出し分けは行わない（呼び出し側のセクション分けと
 * SharedCalendarActionSheet側の出し分けだけで十分なため、この行自体はrole非依存）。
 */
export function SharedCalendarRow({ summary, visible, onToggleVisible, onPress, onPressMenu }: Props) {
  const { t } = useLocale();
  const { calendar, role, memberCount, memberPreviews } = summary;
  const overflowCount = memberPreviews.length > MAX_ROW_AVATARS ? memberCount - MAX_ROW_AVATARS : 0;
  const coverUri = useSignedCoverUrl(calendar.coverImageUrl);

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
      <Pressable
        style={styles.tapArea}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={t("calendars.rowA11y", {
          name: calendar.name,
          status: joinedStatusLabel(role, memberCount, t),
        })}
      >
        <View style={styles.cover}>
          <CoverImage uri={coverUri} color={calendar.color} icon="people-outline" iconSize={22} />
        </View>
        <View style={styles.textWrap}>
          <Text style={styles.name} numberOfLines={2}>
            {calendar.name}
          </Text>
          <Text style={styles.status} numberOfLines={2}>
            {joinedStatusLabel(role, memberCount, t)}
          </Text>
          {memberPreviews.length > 0 && (
            <View style={styles.avatarRow}>
              {memberPreviews.slice(0, MAX_ROW_AVATARS).map((m, index) => (
                <Avatar
                  key={m.userId}
                  uri={m.avatarUrl}
                  label={m.displayName ?? "?"}
                  size={20}
                  style={[styles.avatar, index > 0 && styles.avatarOverlap]}
                />
              ))}
              {overflowCount > 0 && (
                <View style={[styles.avatar, styles.avatarOverlap, styles.overflowBubble]}>
                  <Text style={styles.overflowText}>+{overflowCount}</Text>
                </View>
              )}
            </View>
          )}
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
    minHeight: minTapSize + 20,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  checkArea: {
    width: minTapSize - 12,
    height: minTapSize - 12,
    alignItems: "center",
    justifyContent: "center",
  },
  tapArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  cover: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  textWrap: {
    flex: 1,
  },
  name: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  status: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
  },
  avatarRow: {
    flexDirection: "row",
    marginTop: 6,
  },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarOverlap: {
    marginLeft: -6,
  },
  overflowBubble: {
    backgroundColor: colors.surfaceAlt,
  },
  overflowText: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  menuButton: {
    width: minTapSize - 8,
    height: minTapSize - 8,
    alignItems: "center",
    justifyContent: "center",
  },
});
