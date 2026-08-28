import React from "react";
import { Ionicons } from "@expo/vector-icons";
import { SyncStatus } from "@/types/sharing";
import { colors } from "@/theme/colors";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";

interface Props {
  status: SyncStatus;
  size?: number;
}

const STATUS_LABEL_KEY: Record<SyncStatus, TranslationKey> = {
  synced: "syncStatusBadge.synced",
  pending: "syncStatusBadge.pending",
  error: "syncStatusBadge.error",
};

/** 共有予定の送信状態（同期済み／送信待ち／失敗）を示す小さなアイコン */
export function SyncStatusBadge({ status, size = 11 }: Props) {
  const { t } = useLocale();
  const accessibilityLabel = t(STATUS_LABEL_KEY[status]);
  if (status === "synced") {
    return (
      <Ionicons
        name="cloud-done-outline"
        size={size}
        color={colors.meeting}
        accessibilityLabel={accessibilityLabel}
      />
    );
  }
  if (status === "pending") {
    return (
      <Ionicons
        name="cloud-upload-outline"
        size={size}
        color={colors.textTertiary}
        accessibilityLabel={accessibilityLabel}
      />
    );
  }
  return (
    <Ionicons
      name="warning-outline"
      size={size}
      color={colors.warning}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
