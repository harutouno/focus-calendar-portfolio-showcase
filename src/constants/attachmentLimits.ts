import { PremiumStatus } from "@/types/premium";

/**
 * 予定メモへの画像添付の、無料/プレミアムごとの上限。
 * 画面表示・選択前チェック・保存前チェック（クライアント側）は必ずここを参照し、
 * 数字を複数箇所へ直接記述しない。
 *
 * 枚数・1枚あたりサイズ・圧縮目標（このインターフェース）は、端末内（マイカレンダー）予定・
 * クラウド（共有カレンダー）予定のどちらでも同じ値を使う（保存場所による違いは無い）。
 * 一方、総容量（旧maxTotalBytes）だけは保存場所によって値が異なるため、FP-009(2026-08)で
 * このインターフェースから分離し、LOCAL_ATTACHMENT_TOTAL_BYTES/CLOUD_ATTACHMENT_TOTAL_BYTES
 * （本ファイル下部）へ移した。
 *
 * クラウド添付（共有カレンダーの予定）の枚数・1枚あたりサイズは
 * supabase/migrations/0008_event_attachments.sql の enforce_attachment_quota()
 * トリガーへSQLとして複製されている（PL/pgSQLからTS定数を直接参照できないため）。
 * この定数を変更する場合は、そのmigrationの数値も必ず合わせて変更すること。
 */
export interface AttachmentLimits {
  /** 1予定につき添付できる画像の最大枚数（端末内・クラウド共通） */
  maxImagesPerEvent: number;
  /** 1枚あたり、保存処理後（圧縮・再エンコード後）の最大容量（バイト、端末内・クラウド共通） */
  maxBytesPerImage: number;
  /** 圧縮時に最初に狙う長辺の目安（px）。超過時は段階的にさらに縮小する（初期基準値） */
  maxLongEdge: number;
}

export const ATTACHMENT_LIMITS: Record<PremiumStatus, AttachmentLimits> = {
  free: {
    maxImagesPerEvent: 1,
    maxBytesPerImage: 1 * 1024 * 1024,
    maxLongEdge: 1600,
  },
  premium: {
    maxImagesPerEvent: 5,
    maxBytesPerImage: 3 * 1024 * 1024,
    maxLongEdge: 2400,
  },
} as const;

export function getAttachmentLimits(plan: PremiumStatus): AttachmentLimits {
  return ATTACHMENT_LIMITS[plan];
}

/**
 * マイカレンダー予定（端末内保存、AsyncStorage/ファイルシステム）の画像総容量。
 * 端末内画像はSupabase Storageを一切消費しないため、FP-009(2026-08)の正式決定でも
 * 現行値（無料50MB/プレミアム1GB）を維持している。
 */
export const LOCAL_ATTACHMENT_TOTAL_BYTES: Record<PremiumStatus, number> = {
  free: 50 * 1024 * 1024,
  premium: 1024 * 1024 * 1024,
} as const;

export function getLocalAttachmentTotalBytes(plan: PremiumStatus): number {
  return LOCAL_ATTACHMENT_TOTAL_BYTES[plan];
}

/**
 * 共有カレンダー予定（クラウド保存、Supabase Storage）の画像総容量。
 * FP-009(2026-08)の正式決定により、無料運用時のインフラコスト（Supabase Freeの
 * プロジェクト全体1GB枠を考慮）を抑えるため、旧50MB/1GBから20MB/200MBへ縮小した
 * （所有者のプラン基準、判定はFP-004参照）。端末内画像（上記）とは別の値であり、
 * こちらだけを変更しても端末内総容量には影響しない。
 *
 * この値はsupabase/migrations/0017_shared_attachment_premium_quota.sqlの
 * enforce_attachment_quota()・get_attachment_quota_status()へ手動で複製している
 * （PL/pgSQLからTS定数を直接参照できないため）。この定数を変更する場合は、その
 * migrationの数値も必ず合わせて変更すること。
 */
export const CLOUD_ATTACHMENT_TOTAL_BYTES: Record<PremiumStatus, number> = {
  free: 20 * 1024 * 1024,
  premium: 200 * 1024 * 1024,
} as const;

export function getCloudAttachmentTotalBytes(plan: PremiumStatus): number {
  return CLOUD_ATTACHMENT_TOTAL_BYTES[plan];
}
