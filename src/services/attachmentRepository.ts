import { EventAttachment, ProcessedImage } from "@/types/attachment";
import { SharedOperationIdentity } from "@/auth/sharedMutationIdentity";

/**
 * Round 12（SEC-F007-004、P1-1）: ローカル添付とクラウド添付の契約を分離する。
 * 以前は`createdBy`/`calendarId`を任意項目として持つ単一の型（`AttachmentSaveContext`）と
 * 単一のインターフェース（`EventAttachmentRepository`）で両方を扱っており、クラウド処理を
 * 呼ぶのにidentityを渡さなくてもTypeScript上はエラーにならなかった。ここでは
 * storage種別ごとに別の型・別のインターフェースへ分離し、クラウド側はidentity
 * （既存のSharedOperationIdentity、複製しない）を必須にすることで、identity無しでの
 * クラウドAPI呼び出しをコンパイル時エラーにする。
 */

/** 端末内（ローカル）予定の添付保存に必要な情報。identityを一切持たない。 */
export interface LocalAttachmentSaveContext {
  /** 画像選択時に1回だけ生成した添付ID（AttachmentDraft.id）。再試行でも同じ値を使う。 */
  id: string;
  eventId: string;
  sortOrder: number;
}

/**
 * 共有（クラウド）予定の添付保存に必要な情報。identityは必須（optionalにしない）。
 * created_byは常にidentity.userIdから生成する（callerが別のuserIdを指定できるAPIを
 * 残さないため、この型自体にcreatedByフィールドは持たせない）。
 */
export interface CloudAttachmentSaveContext {
  id: string;
  eventId: string;
  sortOrder: number;
  calendarId: string;
  identity: SharedOperationIdentity;
}

/**
 * Round15（P1-2）: 削除対象を一意に識別するための完全な組（attachmentId単体では
 * DB照合済みstoragePathとの全フィールド完全一致を検証できないため、calendarId/eventIdも
 * 必須にする）。呼び出し元（useEventAttachments.ts）は捕捉済みAttachmentOperationScopeの
 * calendarId/eventIdをそのまま渡す。
 */
export interface CloudAttachmentRemoveContext {
  attachmentId: string;
  eventId: string;
  calendarId: string;
  identity: SharedOperationIdentity;
}

/** 端末内予定の添付リポジトリ契約。identityに一切依存しない。 */
export interface LocalEventAttachmentRepository {
  list(eventId: string): Promise<EventAttachment[]>;
  create(processed: ProcessedImage, context: LocalAttachmentSaveContext): Promise<EventAttachment>;
  remove(attachmentId: string, eventId: string): Promise<void>;
  resolveDisplayUri(attachment: EventAttachment): Promise<string | null>;
}

/** 共有（クラウド）予定の添付リポジトリ契約。全メソッドがidentityを必須で受け取る。 */
export interface CloudEventAttachmentRepository {
  list(eventId: string, identity: SharedOperationIdentity): Promise<EventAttachment[]>;
  create(processed: ProcessedImage, context: CloudAttachmentSaveContext): Promise<EventAttachment>;
  remove(context: CloudAttachmentRemoveContext): Promise<void>;
  resolveDisplayUri(
    attachment: EventAttachment,
    identity: SharedOperationIdentity
  ): Promise<string | null>;
}
