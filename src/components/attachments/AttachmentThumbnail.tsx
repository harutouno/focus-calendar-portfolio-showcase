import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { AttachmentDraft, EventAttachment } from "@/types/attachment";

const THUMBNAIL_SIZE = 72;

type Props =
  | {
      kind: "ready";
      attachment: EventAttachment;
      index: number;
      isDeleting: boolean;
      resolveDisplayUri: (attachment: EventAttachment) => Promise<string | null>;
      /** Round13、P2: identity・保存先カレンダー等の文脈。変化のたびに再取得しlatest-winsで反映する。 */
      scopeKey: string;
      onPress: () => void;
      onDelete: () => void;
    }
  | {
      kind: "draft";
      draft: AttachmentDraft;
      index: number;
      onRetry: () => void;
      onRemove: () => void;
    };

/** 1枚分の添付表示。正式登録済み（ready）とドラフト（processing/draft-ready/draft-failed/committing/commit-failed）の両方を扱う。 */
export function AttachmentThumbnail(props: Props) {
  const { t } = useLocale();
  const [thumbUri, setThumbUri] = useState<string | null>(
    props.kind === "draft" ? props.draft.localDraftUri ?? props.draft.sourceUri : null
  );

  // Round13、P2: requestTokenRefによるlatest-wins。attachment.id・resolveDisplayUri・
  // scopeKeyのいずれかが変化するたびに要求を新しいtoken扱いにし、effect開始時点でthumbUriを
  // 一旦nullへ戻す（scope/resolver変化後に旧URIを表示し続けないため）。resolve完了時は
  // token一致・マウント中であることを確認してからのみ反映する（catch時も同様）。
  const requestTokenRef = useRef(0);
  const readyAttachmentId = props.kind === "ready" ? props.attachment.id : null;
  const readyResolveDisplayUri = props.kind === "ready" ? props.resolveDisplayUri : null;
  const readyScopeKey = props.kind === "ready" ? props.scopeKey : null;
  useEffect(() => {
    if (props.kind !== "ready") return;
    const token = ++requestTokenRef.current;
    let cancelled = false;
    setThumbUri(null);
    props
      .resolveDisplayUri(props.attachment)
      .then((uri) => {
        if (cancelled || requestTokenRef.current !== token) return;
        setThumbUri(uri);
      })
      .catch(() => {
        // Round 12（SEC-F007-004、P1-5）: resolveDisplayUriはidentityがstale化した場合に
        // 例外を投げるようになった（EventAttachmentSection.openPreviewと同じ契約）。
        // サムネイル表示は補助的な機能のため、失敗時は単に表示しないだけに留め、未処理の
        // Promise拒否を残さないためだけにcatchする（エラー表示は行わない、古いURIも保持しない）。
        if (cancelled || requestTokenRef.current !== token) return;
        setThumbUri(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kind==="ready"のときだけattachment.id/resolveDisplayUri/scopeKeyで再取得する
  }, [readyAttachmentId, readyResolveDisplayUri, readyScopeKey]);

  useEffect(() => {
    if (props.kind === "draft") {
      setThumbUri(props.draft.localDraftUri ?? props.draft.sourceUri);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kind==="draft"のときだけ更新する
  }, [props.kind === "draft" ? props.draft.localDraftUri : null]);

  const label = t("attachments.thumbnailA11y", { index: props.index + 1 });

  if (props.kind === "draft") {
    const { draft, onRetry, onRemove } = props;
    const isFailed = draft.status === "draft-failed" || draft.status === "commit-failed";
    const isBusy = draft.status === "processing" || draft.status === "committing";
    // 予定保存前（draft-ready）は正式なアップロード先へ何も送っていないため、
    // 「アップロード済み」と誤解されないよう「未保存」バッジを表示する。
    const isPendingUnsaved = draft.status === "draft-ready";
    return (
      <View style={styles.tile}>
        {thumbUri && <Image source={{ uri: thumbUri }} style={styles.image} />}
        {isBusy && (
          <View style={styles.overlay}>
            <ActivityIndicator color={colors.textInverse} />
          </View>
        )}
        {isPendingUnsaved && (
          <View style={styles.pendingBadge}>
            <Text style={styles.pendingBadgeText}>{t("attachments.pendingBadge")}</Text>
          </View>
        )}
        {isFailed && (
          <View style={[styles.overlay, styles.failedOverlay]}>
            <Ionicons name="warning-outline" size={20} color={colors.textInverse} />
            <View style={styles.failedActions}>
              <Pressable
                onPress={onRetry}
                accessibilityRole="button"
                accessibilityLabel={t("attachments.retryButtonA11y")}
                style={styles.failedActionButton}
                hitSlop={8}
              >
                <Ionicons name="refresh" size={16} color={colors.textInverse} />
              </Pressable>
              <Pressable
                onPress={onRemove}
                accessibilityRole="button"
                accessibilityLabel={t("attachments.deleteButtonA11y")}
                style={styles.failedActionButton}
                hitSlop={8}
              >
                <Ionicons name="trash-outline" size={16} color={colors.textInverse} />
              </Pressable>
            </View>
          </View>
        )}
      </View>
    );
  }

  const { isDeleting, onPress, onDelete } = props;
  return (
    <Pressable
      style={styles.tile}
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={label}
    >
      {thumbUri && <Image source={{ uri: thumbUri }} style={styles.image} />}
      {isDeleting && (
        <View style={styles.overlay}>
          <ActivityIndicator color={colors.textInverse} />
        </View>
      )}
      {!isDeleting && (
        <Pressable
          style={styles.deleteButton}
          onPress={onDelete}
          accessibilityRole="button"
          accessibilityLabel={t("attachments.deleteButtonA11y")}
          hitSlop={12}
        >
          <Ionicons name="close-circle" size={22} color={colors.textInverse} />
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: colors.surfaceAlt,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(17,20,27,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  failedOverlay: {
    gap: spacing.xs,
  },
  failedActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  failedActionButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  deleteButton: {
    position: "absolute",
    top: 0,
    right: 0,
    padding: spacing.xs,
  },
  pendingBadge: {
    position: "absolute",
    left: 2,
    bottom: 2,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: "rgba(17,20,27,0.6)",
  },
  pendingBadgeText: {
    fontSize: 9,
    fontWeight: "700",
    color: colors.textInverse,
  },
});
