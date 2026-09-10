import { getAttachmentLimits, getLocalAttachmentTotalBytes } from "@/constants/attachmentLimits";
import { PremiumStatus } from "@/types/premium";
import { EventAttachment } from "@/types/attachment";

/**
 * 画像添付のクライアント側事前チェック（表示・選択前・保存前チェックで共通利用する）。
 * ここでの判定はUI表示・無駄なアップロードを避けるためのものであり、最終的な権限・枚数・
 * 総容量の判定は常にサーバー側（クラウド添付はDBのRLS/トリガー、端末内添付は
 * eventAttachmentsRepository.tsの実データ）で行う。
 */
export type AttachmentLimitCheck =
  | { allowed: true }
  | { allowed: false; reason: "event-limit" | "total-quota" | "image-too-large" };

/** 画像を選ぶ前に呼ぶ: これ以上添付できるか（枚数のみ。容量は選択・圧縮後にしか分からない）。 */
export function canAddMoreImages(
  currentCount: number,
  plan: PremiumStatus
): AttachmentLimitCheck {
  const limits = getAttachmentLimits(plan);
  if (currentCount >= limits.maxImagesPerEvent) {
    return { allowed: false, reason: "event-limit" };
  }
  return { allowed: true };
}

/**
 * 圧縮後の画像を保存する前に呼ぶ: 1枚の容量・総容量の両方を確認する。
 * 端末内（マイカレンダー）予定専用（呼び出し元はuseEventAttachments.tsの
 * !isCloudEvent分岐のみ）。総容量はgetLocalAttachmentTotalBytes()（FP-009で
 * クラウド側と分離済み）を使う。クラウド（共有カレンダー）予定の総容量判定は
 * get_attachment_quota_status RPC（サーバー側）が正本のため、ここでは扱わない。
 */
export function canSaveProcessedImage(
  byteSize: number,
  currentTotalBytes: number,
  plan: PremiumStatus
): AttachmentLimitCheck {
  const limits = getAttachmentLimits(plan);
  if (byteSize > limits.maxBytesPerImage) {
    return { allowed: false, reason: "image-too-large" };
  }
  if (currentTotalBytes + byteSize > getLocalAttachmentTotalBytes(plan)) {
    return { allowed: false, reason: "total-quota" };
  }
  return { allowed: true };
}

/** 有効な添付（削除済みでないもの）のbyte_size合計。フェーズ3の使用容量表示でも再利用する。 */
export function sumAttachmentBytes(attachments: EventAttachment[]): number {
  return attachments.reduce((sum, a) => sum + a.byteSize, 0);
}

/**
 * 実際に適用するプランを解決する。
 * クラウド添付（共有カレンダーの予定）は、操作中ユーザー本人のdevicePlan
 * （PremiumContext由来）を一切参照しない。共有カレンダーの画像上限は「予定を
 * 編集している本人」ではなく「カレンダー所有者」のプランで決まるため、
 * useEventAttachments.tsがsupabase/migrations/0017のget_attachment_quota_status
 * RPCから取得したcloudOwnerPlan（未取得時はnull）をそのまま渡す。未取得時は
 * 安全側のfreeにフォールバックする。
 * 端末内（ローカル）予定は既存の開発用プレミアム切替（devicePlan）にそのまま従う
 * （こちらは今回のFP-004の対象外で変更しない）。
 */
export function getEffectiveAttachmentPlan(
  isCloudEvent: boolean,
  devicePlan: PremiumStatus,
  cloudOwnerPlan: PremiumStatus | null
): PremiumStatus {
  if (!isCloudEvent) return devicePlan;
  return cloudOwnerPlan ?? "free";
}
