import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "@/theme/colors";
import { radius } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";

export type CalendarTabKey = "personal" | "shared" | "invitations";

const OPTION_KEYS: { key: CalendarTabKey; labelKey: TranslationKey }[] = [
  { key: "personal", labelKey: "calendars.tabPersonal" },
  { key: "shared", labelKey: "calendars.tabShared" },
  { key: "invitations", labelKey: "calendars.tabInvitations" },
];

const BADGE_OVERFLOW_MAX = 99;

interface Props {
  value: CalendarTabKey;
  onChange: (key: CalendarTabKey) => void;
  /** 「招待」タブ右上に表示する未処理招待の件数。0または未指定ならバッジを表示しない */
  invitationsBadgeCount?: number;
}

/**
 * カレンダー一覧画面の「個人／共有／招待」切替（月/週/日切替のViewSwitcher.tsxと同じパターン）。
 * 招待タブだけ、未処理招待の件数バッジを右上に重ねて表示できる（他2タブにはバッジは無い）。
 * バッジはposition: "absolute"のため、タブの高さ・幅には一切影響しない。
 */
export function CalendarTabs({ value, onChange, invitationsBadgeCount }: Props) {
  const { t } = useLocale();
  const options = OPTION_KEYS.map((o) => ({ key: o.key, label: t(o.labelKey) }));
  return (
    <View style={styles.container}>
      {options.map((opt) => {
        const active = value === opt.key;
        const badgeCount = opt.key === "invitations" ? invitationsBadgeCount ?? 0 : 0;
        const showBadge = badgeCount > 0;
        const badgeText =
          badgeCount > BADGE_OVERFLOW_MAX ? t("calendars.invitationsBadgeOverflow") : String(badgeCount);
        const accessibilityLabel = showBadge
          ? t("calendars.tabInvitationsA11yWithCount", { count: badgeCount })
          : opt.label;
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            style={[styles.item, active && styles.itemActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={accessibilityLabel}
          >
            <Text style={[styles.text, active && styles.textActive]}>{opt.label}</Text>
            {/* Pressable自体にaccessibilityLabelを設定済みのため、子要素は自動的に単一の
                アクセシビリティ要素へ統合される（バッジの数字が別要素として二重に読み上げられない）。 */}
            {showBadge && (
              <View style={styles.badge}>
                <Text style={styles.badgeText} numberOfLines={1}>
                  {badgeText}
                </Text>
              </View>
            )}
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
    flex: 1,
    alignItems: "center",
    paddingVertical: 8,
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
  badge: {
    position: "absolute",
    top: -4,
    right: 8,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: colors.warning,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: colors.surfaceAlt,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.textInverse,
  },
});
