import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { CoverImage } from "./CoverImage";
import { PendingInvite } from "@/types/sharing";
import { useSignedCoverUrl } from "@/hooks/useSignedCoverUrl";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";

const ROLE_LABEL_KEY: Record<PendingInvite["role"], TranslationKey> = {
  editor: "calendarRole.editor",
  viewer: "calendarRole.viewer",
};

function formatInvitedDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

interface Props {
  invite: PendingInvite;
  onAccept: () => void;
  onDecline: () => void;
  /** 参加処理中（二重タップ防止のため、参加・拒否どちらのボタンも押せなくする） */
  accepting: boolean;
  /** 拒否処理中（同上） */
  declining: boolean;
}

/**
 * 招待タブに表示する、自分宛てに届いている未処理招待1件分のカード。
 * カバー画像はSharedCalendarRow/CalendarCardと同じuseSignedCoverUrl経由で
 * 署名付きURLを解決する（private Storageの仕組みをそのまま再利用する）。
 */
export function InvitationCard({ invite, onAccept, onDecline, accepting, declining }: Props) {
  const { t } = useLocale();
  const coverUri = useSignedCoverUrl(invite.calendarCoverImageUrl);
  const busy = accepting || declining;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.cover}>
          <CoverImage uri={coverUri} color={invite.calendarColor} icon="people-outline" iconSize={20} />
        </View>
        <View style={styles.textWrap}>
          <Text style={styles.name} numberOfLines={2}>
            {invite.calendarName}
          </Text>
          <Text style={styles.inviter} numberOfLines={1}>
            {t("calendarInvite.invitedBy", {
              name: invite.inviterDisplayName ?? t("calendarInvite.inviterFallbackName"),
            })}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {t(ROLE_LABEL_KEY[invite.role])} ・ {formatInvitedDate(invite.createdAt)}
          </Text>
        </View>
      </View>
      <View style={styles.actionRow}>
        <Pressable
          style={[styles.actionButton, styles.declineButton, busy && styles.actionButtonDisabled]}
          onPress={onDecline}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={declining ? t("calendarInvite.decliningStatus") : t("calendarInvite.declineButton")}
        >
          {declining ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Text style={styles.declineButtonText}>{t("calendarInvite.declineButton")}</Text>
          )}
        </Pressable>
        <Pressable
          style={[styles.actionButton, styles.acceptButton, busy && styles.actionButtonDisabled]}
          onPress={onAccept}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={accepting ? t("calendarInvite.acceptingStatus") : t("calendarInvite.acceptButton")}
        >
          {accepting ? (
            <ActivityIndicator size="small" color={colors.textInverse} />
          ) : (
            <Text style={styles.acceptButtonText}>{t("calendarInvite.acceptButton")}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  headerRow: {
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
  inviter: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  meta: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 1,
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.md,
  },
  actionButton: {
    flex: 1,
    minHeight: minTapSize - 8,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  declineButton: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  declineButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  acceptButton: {
    backgroundColor: colors.primary,
  },
  acceptButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textInverse,
  },
});
