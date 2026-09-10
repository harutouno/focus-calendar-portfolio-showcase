/**
 * 予定メモへの画像添付機能（フェーズ1: 型定義）。
 * 端末内予定・共有（クラウド）予定の両方で共通に使うドメイン型。
 * プラン種別は新規に作らず、既存の PremiumStatus（"free"|"premium"）をそのまま使う。
 */

/** 許可する画像MIMEタイプ。拡張子だけでなくこの値そのもので判定する。 */
export type AttachmentMimeType = "image/jpeg" | "image/png" | "image/webp";

/** 添付1件の登録状態。"uploading"はクラウド添付のアップロード中のみ使用する。 */
export type AttachmentUploadStatus = "uploading" | "ready" | "failed";

/**
 * 予定に添付された画像1件（ドメイン型）。
 * uri: 端末内予定は永続コピー済みのfile:// URI。クラウド添付は表示のたびに取得する
 *      短時間署名付きURL（未取得時はundefined。DB/AsyncStorageへ永続保存しない）。
 */
export interface EventAttachment {
  id: string;
  eventId: string;
  uri?: string;
  thumbnailUri?: string;
  mimeType: AttachmentMimeType;
  byteSize: number;
  width?: number;
  height?: number;
  sortOrder: number;
  uploadStatus: AttachmentUploadStatus;
  createdAt: string;
}

/**
 * フェーズ2の画像処理パイプライン（選択→向き補正→リサイズ→再エンコード→EXIF除去）が
 * 生成する結果の型。フェーズ1時点では未実装だが、repository層のインターフェースが
 * この形を前提にできるよう先に定義しておく。
 */
export interface ProcessedImage {
  /** 圧縮・再エンコード後の画像の端末内一時ファイルURI */
  localUri: string;
  /** サムネイル（生成した場合のみ） */
  thumbnailLocalUri?: string;
  mimeType: AttachmentMimeType;
  byteSize: number;
  width: number;
  height: number;
}

/**
 * 添付1件の画面内ドラフト状態。
 *
 * - "processing": 選択直後、圧縮処理中（予定保存の前後どちらでも使う）。
 * - "draft-ready": 圧縮済みで、アプリ管理領域のドラフト用ディレクトリに保存済み。
 *   予定本体がまだ保存されていないため、Storage/DB/端末内の正式な添付repositoryへは
 *   一切登録していない状態（events行を参照する外部キーを持つ行を、events行が存在しない
 *   うちに作らないための必須の中間状態）。
 * - "draft-failed": 圧縮・権限・形式等、予定保存前の処理で失敗した（同じidのまま再試行可能）。
 * - "committing": 予定本体の保存に成功した後、正式な添付（Storageアップロード+DB登録、または
 *   端末内正式領域への移動+メタデータ登録）を行っている最中。
 * - "commit-failed": 予定は保存済みだが、この添付の正式登録には失敗した（同じidのまま再試行可能。
 *   予定本体の削除・再作成は行わない）。
 */
export type AttachmentDraftStatus =
  | "processing"
  | "draft-ready"
  | "draft-failed"
  | "committing"
  | "commit-failed";

/** 添付操作の失敗理由。UI側で文言を出し分けるための分類（section 28対応）。 */
export type AttachmentErrorReason =
  | "permission-denied"
  | "unsupported-format"
  | "decode-failed"
  | "too-large-after-compression"
  | "event-limit"
  | "total-quota"
  | "offline"
  | "upload-failed"
  | "save-failed"
  | "delete-failed"
  | "load-failed";

/**
 * 共有（クラウド）予定の画像添付について、supabaseのget_attachment_quota_status RPCが
 * 返す状態(FP-004)。所有者の資格詳細(user_entitlementsの行・billingステータス・source・
 * starts_at/expires_at)は一切含まない——枚数・容量の上限と現在値、追加可否だけを表す。
 */
export interface AttachmentQuotaStatus {
  maxFilesPerEvent: number;
  maxFileSizeBytes: number;
  totalStorageLimitBytes: number;
  currentEventFileCount: number;
  currentUsedBytes: number;
  remainingBytes: number;
  canUpload: boolean;
}

export interface AttachmentDraft {
  /**
   * Crypto.randomUUID()で画像選択時に1回だけ生成し、以後の再試行（圧縮のやり直し・
   * 正式登録のやり直しのどちらでも）では絶対に再生成しない。この値がそのまま
   * 正式登録時のEventAttachment.id・Storageパスの一部として使われる（冪等キー）。
   */
  id: string;
  /**
   * ドラフトファイルの保存先ディレクトリを識別するID。予定のevent_idとは概念上別物であり、
   * events行が存在しない段階のファイルは必ずこのIDの下（attachments/drafts/{draftSessionId}/）
   * に置く。正式なevent_idを外部キーとして参照する場所には一切登場させない。
   */
  draftSessionId: string;
  /** ピッカーの選択結果（圧縮からやり直す場合に使う。ピッカーを開き直さない） */
  sourceUri: string;
  sourceMimeType: string;
  sourceWidth: number;
  sourceHeight: number;
  /** 圧縮成功後、ドラフト用ディレクトリへコピーした後のfile:// URI */
  localDraftUri?: string;
  mimeType?: AttachmentMimeType;
  byteSize?: number;
  width?: number;
  height?: number;
  status: AttachmentDraftStatus;
  errorReason?: AttachmentErrorReason;
  sortOrder: number;
}
