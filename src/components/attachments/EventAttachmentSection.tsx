import React, { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";
import { getAttachmentLimits } from "@/constants/attachmentLimits";
import { PremiumStatus } from "@/types/premium";
import { AttachmentDraft, AttachmentErrorReason, EventAttachment } from "@/types/attachment";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { AttachmentPreviewModal } from "./AttachmentPreviewModal";

export interface EventAttachmentSectionProps {
  attachments: EventAttachment[];
  drafts: AttachmentDraft[];
  deletingIds: Set<string>;
  maxImagesPerEvent: number;
  plan: PremiumStatus;
  /**
   * マイカレンダー予定（端末内保存）かクラウド（共有カレンダー）予定かの区別。
   * FP-009(2026-08)で総容量が保存場所ごとに分離されたため、"total-quota"エラーの
   * 文言をどちらの上限（端末内50MB/1GB、共有20MB/200MB）として表示するかの判定に使う。
   */
  isCloudEvent: boolean;
  lastError: AttachmentErrorReason | null;
  onAddImage: () => void;
  /** ドラフト（draft-failed/commit-failed）の再試行。IDはdraft.id */
  onRetry: (id: string) => void;
  /** ドラフト・正式登録済み添付のどちらの削除も、このIDで一元的に受け付ける */
  onRemove: (id: string) => void;
  resolveDisplayUri: (attachment: EventAttachment) => Promise<string | null>;
  /**
   * Round13、P2: identity・保存先カレンダーの識別子など、サムネイル表示を無効化すべき
   * 「文脈」を表す値。呼び出し元（NormalEventForm）が変化のたびに新しい値を渡すことで、
   * AttachmentThumbnail側のlatest-wins判定に使う（省略時は空文字列として扱う）。
   */
  scopeKey?: string;
}

function errorMessageKey(
  reason: AttachmentErrorReason,
  plan: PremiumStatus,
  isCloudEvent: boolean
): TranslationKey {
  switch (reason) {
    case "permission-denied":
      return "attachments.errorPermissionDenied";
    case "unsupported-format":
      return "attachments.errorUnsupportedFormat";
    case "decode-failed":
      return "attachments.errorDecodeFailed";
    case "too-large-after-compression":
      return "attachments.errorTooLarge";
    case "event-limit":
      return plan === "free" ? "attachments.errorEventLimitFree" : "attachments.errorEventLimitPremium";
    case "total-quota":
      // FP-009(2026-08): 端末内(マイカレンダー)予定と共有(クラウド)予定で総容量の数値が
      // 異なるため、混同を避けるため保存場所ごとに別の文言キーを用意する。
      if (isCloudEvent) {
        return plan === "free"
          ? "attachments.errorTotalQuotaCloudFree"
          : "attachments.errorTotalQuotaCloudPremium";
      }
      return plan === "free"
        ? "attachments.errorTotalQuotaLocalFree"
        : "attachments.errorTotalQuotaLocalPremium";
    case "offline":
      return "attachments.errorOffline";
    case "upload-failed":
      return "attachments.errorUploadFailed";
    case "save-failed":
      return "attachments.errorSaveFailed";
    case "delete-failed":
      return "attachments.errorDeleteFailed";
    case "load-failed":
    default:
      return "attachments.errorLoadFailed";
  }
}

/**
 * 予定作成・編集画面の「添付画像」セクション。メモ欄の下に配置する。
 * Storage操作・圧縮・容量集計・通知文言は一切ここに書かない
 * （すべてuseEventAttachments/各repository/attachmentQuotaServiceへ委譲する）。
 */
export function EventAttachmentSection(props: EventAttachmentSectionProps) {
  const { t } = useLocale();
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  // Round 12（SEC-F007-004、P1-5）: 連続タップ・identity切替直前のタップ等でresolveDisplayUriの
  // 呼び出しが重複した場合、最後の要求の結果だけを反映する（out-of-order応答対策）。
  const previewRequestRef = useRef(0);
  // Round13、P2: openPreviewは非同期関数のため、呼び出された時点のpropsをクロージャで
  // 保持したままawaitする（React関数コンポーネントの通常の仕組み）。取得を待っている間に
  // 添付が削除された（新しいpropsで再レンダーされた）ことを検知するには、レンダーごとに
  // 同期するrefが必要（identityRef等、このコードベース内の既存パターンと同じ）。
  const attachmentsRef = useRef(props.attachments);
  attachmentsRef.current = props.attachments;

  // Round14、P2: scopeKey（identity・保存先カレンダー等の文脈）が変化した場合、進行中の
  // openPreview要求を無効化し、既に開いているプレビューも閉じる（古いidentity/カレンダーの
  // 添付を新しい文脈のまま表示し続けないため）。
  useEffect(() => {
    previewRequestRef.current += 1;
    setPreviewUri(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKeyの変化だけで発火する（マウント時の初回発火は初期値がnullのため実害なし）
  }, [props.scopeKey]);

  // P0022（QA-F007 Batch3.2、9節）: AttachmentThumbnailと同じく、進行中のopenPreview()が
  // このコンポーネント自体のunmount（画面remount含む）後に解決した場合でもsetPreviewUriを
  // 反映しない。previewRequestRefをインクリメントするだけで、openPreview側の
  // `previewRequestRef.current !== requestToken`チェックが自然に不一致となる
  // （closePreviewの実装と同じ仕組みをunmount時にも適用する）。
  useEffect(() => {
    return () => {
      previewRequestRef.current += 1;
    };
  }, []);

  const activeCount =
    props.attachments.length + props.drafts.filter((d) => d.status !== "draft-failed").length;
  const canAddMore = activeCount < props.maxImagesPerEvent;
  const maxBytesMb = Math.round(getAttachmentLimits(props.plan).maxBytesPerImage / (1024 * 1024));

  // 正式登録済みの添付は、削除するとStorage/DBへ実際に影響するため確認を挟む。
  // まだ正式登録されていないドラフトの削除は即時実行してよい（onRemove側で判定・分岐する）。
  const confirmDeleteReady = (attachmentId: string) => {
    Alert.alert(t("attachments.deleteConfirmTitle"), t("attachments.deleteConfirmMessage"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: () => props.onRemove(attachmentId) },
    ]);
  };

  const openPreview = async (attachment: EventAttachment) => {
    const requestToken = ++previewRequestRef.current;
    // Round14、P2: 呼び出された時点のscopeKeyを捕捉し、取得完了時点のscopeKeyと比較する
    // （取得を待っている間にidentity・保存先カレンダー等の文脈が変化した場合、request-token・
    // scopeKey・添付が一覧にまだ存在するかの3つすべてを確認してからのみ反映する）。
    const requestScopeKey = props.scopeKey ?? "";
    try {
      const uri = await props.resolveDisplayUri(attachment);
      // 後発の要求に追い越されていた場合（別の画像をタップ済み・プレビューを閉じた後等）は、
      // 今awaitしていた結果を反映しない。
      if (previewRequestRef.current !== requestToken) return;
      if ((props.scopeKey ?? "") !== requestScopeKey) return;
      // Round13、P2: 取得を待っている間に対象の添付自体が削除されていた場合、URIの取得自体は
      // 成功していてもプレビューを開かない（一覧から既に消えた添付のプレビューが後から
      // 開いてしまうことを防ぐ）。
      if (!attachmentsRef.current.some((a) => a.id === attachment.id)) return;
      setPreviewUri(uri);
    } catch {
      // identity切替によるstale例外・通信失敗のいずれも、プレビューを開けないだけに留める
      // （補助的な機能のため、ここで未処理のPromise拒否を残さないことが目的でエラーAlertは出さない）。
    }
  };

  const closePreview = () => {
    // 進行中のopenPreview（await中）がもしあれば、その結果を無効化してから閉じる。
    previewRequestRef.current += 1;
    setPreviewUri(null);
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>{t("attachments.sectionLabel")}</Text>
        <Text style={styles.count}>
          {t("attachments.countFraction", { current: activeCount, max: props.maxImagesPerEvent })}
        </Text>
      </View>

      {props.lastError && (
        <Text style={styles.errorText}>
          {t(errorMessageKey(props.lastError, props.plan, props.isCloudEvent), { mb: maxBytesMb })}
        </Text>
      )}

      <View style={styles.grid}>
        {props.attachments.map((attachment, index) => (
          <AttachmentThumbnail
            key={attachment.id}
            kind="ready"
            attachment={attachment}
            index={index}
            isDeleting={props.deletingIds.has(attachment.id)}
            resolveDisplayUri={props.resolveDisplayUri}
            scopeKey={props.scopeKey ?? ""}
            onPress={() => openPreview(attachment)}
            onDelete={() => confirmDeleteReady(attachment.id)}
          />
        ))}
        {props.drafts.map((draft, index) => (
          <AttachmentThumbnail
            key={draft.id}
            kind="draft"
            draft={draft}
            index={props.attachments.length + index}
            onRetry={() => props.onRetry(draft.id)}
            onRemove={() => props.onRemove(draft.id)}
          />
        ))}
        {canAddMore &&
          (activeCount === 0 ? (
            <Pressable
              style={styles.addButtonWide}
              onPress={props.onAddImage}
              accessibilityRole="button"
              accessibilityLabel={t("attachments.addButtonA11y")}
            >
              <Ionicons name="add" size={18} color={colors.primary} />
              <Text style={styles.addButtonWideLabel}>{t("attachments.addButton")}</Text>
            </Pressable>
          ) : (
            <Pressable
              style={styles.addButtonTile}
              onPress={props.onAddImage}
              accessibilityRole="button"
              accessibilityLabel={t("attachments.addButtonA11y")}
            >
              <Ionicons name="add" size={28} color={colors.primary} />
            </Pressable>
          ))}
      </View>

      <AttachmentPreviewModal visible={previewUri !== null} uri={previewUri} onClose={closePreview} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  label: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  count: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  errorText: {
    fontSize: 12,
    color: colors.warning,
    marginBottom: spacing.sm,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  addButtonTile: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceAlt,
  },
  addButtonWide: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    minHeight: minTapSize,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    backgroundColor: colors.surfaceAlt,
  },
  addButtonWideLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.primary,
  },
});
