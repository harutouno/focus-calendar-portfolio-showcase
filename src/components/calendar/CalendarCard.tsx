import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CoverImage } from "./CoverImage";
import { Avatar } from "@/components/common/Avatar";
import { MemberPreview } from "@/types/sharing";
import { useSignedCoverUrl } from "@/hooks/useSignedCoverUrl";
import { colors } from "@/theme/colors";
import { minTapSize, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";

const MAX_CARD_AVATARS = 3;

interface Props {
  name: string;
  color: string;
  coverImageUrl?: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** カレンダーの種別・役割を表す1行（例: "端末内"、"オーナー・参加者4人"、"招待リンクを管理"） */
  statusText: string;
  memberPreviews?: MemberPreview[];
  /** 次の予定または予定件数の1行。chevronOnly時は表示しない */
  eventSummary?: string;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onPress: () => void;
  accessibilityLabel: string;
  /**
   * 招待タブの「招待リンクを管理」行など、簡易表示にする場合はtrue。
   * スター・予定要約・メンバーアバターを出さず、カバー・名前・statusText・chevronだけにする。
   */
  chevronOnly?: boolean;
}

/** カレンダー一覧（個人／共有／招待タブ）で共通利用するカード。カード全体タップで詳細へ遷移する。 */
export function CalendarCard({
  name,
  color,
  coverImageUrl,
  icon,
  statusText,
  memberPreviews,
  eventSummary,
  isFavorite,
  onToggleFavorite,
  onPress,
  accessibilityLabel,
  chevronOnly,
}: Props) {
  const { t } = useLocale();
  const coverUri = useSignedCoverUrl(coverImageUrl);
  return (
    <Pressable
      style={styles.card}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.cover}>
        <CoverImage uri={coverUri} color={color} icon={icon} iconSize={20} />
      </View>
      <View style={styles.textCol}>
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
        <Text style={styles.status} numberOfLines={1}>{statusText}</Text>
        {!chevronOnly && eventSummary && (
          <Text style={styles.eventSummary} numberOfLines={1}>{eventSummary}</Text>
        )}
        {!chevronOnly && memberPreviews && memberPreviews.length > 0 && (
          <View style={styles.memberAvatarRow}>
            {memberPreviews.slice(0, MAX_CARD_AVATARS).map((m, index) => (
              <Avatar
                key={m.userId}
                uri={m.avatarUrl}
                label={m.displayName ?? "?"}
                size={20}
                style={[styles.memberAvatar, index > 0 && styles.memberAvatarOverlap]}
              />
            ))}
          </View>
        )}
      </View>
      {!chevronOnly && onToggleFavorite && (
        <Pressable
          hitSlop={8}
          style={styles.starButton}
          onPress={onToggleFavorite}
          accessibilityLabel={isFavorite ? t("calendars.menuRemoveFavorite") : t("calendars.menuAddFavorite")}
        >
          <Ionicons
            name={isFavorite ? "star" : "star-outline"}
            size={18}
            color={isFavorite ? colors.favorite : colors.textTertiary}
          />
        </Pressable>
      )}
      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: minTapSize + 20,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  cover: { width: 44, height: 44, borderRadius: 12, overflow: "hidden" },
  textCol: { flex: 1 },
  name: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  status: { fontSize: 12, color: colors.textTertiary, marginTop: 2 },
  eventSummary: { fontSize: 12, color: colors.textSecondary, marginTop: 3 },
  memberAvatarRow: { flexDirection: "row", marginTop: 6 },
  memberAvatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  memberAvatarOverlap: { marginLeft: -6 },
  starButton: {
    minWidth: minTapSize - 12,
    minHeight: minTapSize - 12,
    alignItems: "center",
    justifyContent: "center",
  },
});
