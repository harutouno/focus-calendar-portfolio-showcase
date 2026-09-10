import {
  SharedOperationIdentity,
  assertCurrentSharedMutationIdentity,
  isCurrentSharedMutationIdentity,
} from "@/auth/sharedMutationIdentity";
import {
  downloadAttachmentBytes,
  uploadAttachmentBytesRaw,
  deleteAttachmentStorageObject,
} from "./remoteAttachmentRepository";
import { runSerializedMigrationDestinationStage, runSerializedMigrationSourceCleanup } from "./cloudAttachmentRepository";
import { PendingAttachmentMigrationAttachment, buildCanonicalAttachmentPath } from "@/storage/attachmentMigrationRepository";

/**
 * P0034（QA-F007 C14、client migration core、6節・13節・15節）: C14 migrationの
 * destination Storage staging・source/destination Storage exact cleanupの低レベル
 * primitives。既存のC09〜C13安全機構（per-target coordinator・identity gate・
 * exact-path検証）を、migration専用のnarrow exportとattachmentMigrationRepositoryの
 * durable recordへ組み合わせる形で再利用する（C09〜C13自体は変更しない）。
 *
 * ここでの関数は、呼び出し元（attachmentMigrationService.ts）が既に対応する
 * durable recordのphase/flagを更新した後に呼ぶことを前提とする（6節: 副作用の前に
 * 必ずrecordを永続化する）。この層自体はdurable recordの読み書きを一切行わない
 * （orchestrator層の責務）。
 */

/** identityがstaleなまま呼ばれた場合。呼び出し元はdurable recordを変更せず、次回retryへ委ねること。 */
export class AttachmentMigrationStaleError extends Error {
  readonly code = "attachment-migration-stale" as const;
  constructor(context: string) {
    super(`attachment migration operation became stale (${context})`);
    this.name = "AttachmentMigrationStaleError";
  }
}

/** durable recordのpathとcallerが渡したcalendar/event/attachmentIdから再構築したpathが一致しない場合。fail-closed。 */
export class AttachmentMigrationPathMismatchError extends Error {
  readonly code = "attachment-migration-path-mismatch" as const;
  constructor(context: string) {
    super(`attachment migration storage path mismatch, refusing to act (${context})`);
    this.name = "AttachmentMigrationPathMismatchError";
  }
}

/**
 * 6節: destination Storage staging（download + upload）。source cloud attachmentの
 * バイトを読み、target calendarのexact final pathへupload:true でupsertする。
 * `.copy()`/`.move()`は使わない（design lock）。
 *
 * 呼び出し元は、この関数を呼ぶ前に該当attachmentのdurable recordが既に
 * `destinationStaging`（あるいはそれ以前の永続化済みphase）であることを保証すること
 * （6節: before first remote side effect、recordを先に永続化）。
 *
 * response lost（upload成功・呼び出し元での結果受信が不明）でも、retryは同じ
 * destination ID/pathへ再度upsertするだけで安全（new IDを再生成しない）。
 */
export async function stageDestinationAttachment(
  attachment: Pick<
    PendingAttachmentMigrationAttachment,
    "sourceAttachmentId" | "destinationAttachmentId" | "sourceStoragePath" | "destinationStoragePath" | "mimeType"
  >,
  context: { sourceCalendarId: string; targetCalendarId: string; eventId: string },
  identity: SharedOperationIdentity
): Promise<void> {
  const expectedSource = buildCanonicalAttachmentPath(
    context.sourceCalendarId,
    context.eventId,
    attachment.sourceAttachmentId
  );
  const expectedDestination = buildCanonicalAttachmentPath(
    context.targetCalendarId,
    context.eventId,
    attachment.destinationAttachmentId
  );
  if (attachment.sourceStoragePath !== expectedSource || attachment.destinationStoragePath !== expectedDestination) {
    throw new AttachmentMigrationPathMismatchError("stageDestinationAttachment");
  }

  return runSerializedMigrationDestinationStage(identity.userId, attachment.destinationAttachmentId, async () => {
    assertCurrentSharedMutationIdentity(identity); // ①開始時

    let bytes: ArrayBuffer;
    try {
      bytes = await downloadAttachmentBytes(attachment.sourceStoragePath, identity);
    } catch (e) {
      if (isCurrentSharedMutationIdentity(identity)) throw e; // 通常失敗はそのまま伝播（retry対象）
      throw new AttachmentMigrationStaleError("download");
    }

    if (!isCurrentSharedMutationIdentity(identity)) {
      throw new AttachmentMigrationStaleError("post-download");
    }

    try {
      await uploadAttachmentBytesRaw(attachment.destinationStoragePath, bytes, attachment.mimeType, identity);
    } catch (e) {
      if (isCurrentSharedMutationIdentity(identity)) throw e;
      throw new AttachmentMigrationStaleError("upload");
    }

    if (!isCurrentSharedMutationIdentity(identity)) {
      // uploadはサーバー側で成功している可能性がある。呼び出し元はdestinationStaged=trueへ
      // 更新できないが、次回retryが同じdestination ID/pathへ再度upsertするだけで安全。
      throw new AttachmentMigrationStaleError("post-upload");
    }
  });
}

/**
 * 13節: source Storage exact cleanup。durable recordのsourceStoragePathが、
 * (sourceCalendarId, eventId, sourceAttachmentId)から再構築した値と完全一致することを
 * 確認してから、そのexact pathだけをStorage DELETEする。DB row不在を「任意path
 * delete許可」の根拠にしない——durable migration recordだけがauthority。
 * P0024のper-target coordinatorでsourceAttachmentId単位に直列化する
 * （既存のlive create/remove/retryと同じattachment targetならそちらと直列化される）。
 */
export async function cleanupSourceAttachmentStorage(
  attachment: Pick<PendingAttachmentMigrationAttachment, "sourceAttachmentId" | "sourceStoragePath">,
  context: { sourceCalendarId: string; eventId: string },
  identity: SharedOperationIdentity
): Promise<boolean> {
  const expected = buildCanonicalAttachmentPath(context.sourceCalendarId, context.eventId, attachment.sourceAttachmentId);
  if (attachment.sourceStoragePath !== expected) {
    throw new AttachmentMigrationPathMismatchError("cleanupSourceAttachmentStorage");
  }

  return runSerializedMigrationSourceCleanup(identity.userId, attachment.sourceAttachmentId, async () => {
    assertCurrentSharedMutationIdentity(identity);
    try {
      return await deleteAttachmentStorageObject(attachment.sourceStoragePath, identity);
    } catch {
      throw new AttachmentMigrationStaleError("source-cleanup");
    }
  });
}

/**
 * 15節: aborted destination cleanup。RPCがdefinite rollbackを返した場合のみ呼ぶこと
 * （unknown RPC時には絶対実行しない——呼び出し元のservice層が分類する）。
 * destination staged objectはDB row無しの非正本のため、durable recordの
 * (targetCalendarId, eventId, destinationAttachmentId)から再構築したexact target
 * pathだけを削除する。sourceAttachmentId単位ではなくdestinationAttachmentId単位で
 * 直列化する（同じstaging操作と競合しないように、staging用coordinatorキーを再利用する）。
 */
export async function cleanupAbortedDestinationStorage(
  attachment: Pick<PendingAttachmentMigrationAttachment, "destinationAttachmentId" | "destinationStoragePath">,
  context: { targetCalendarId: string; eventId: string },
  identity: SharedOperationIdentity
): Promise<boolean> {
  const expected = buildCanonicalAttachmentPath(
    context.targetCalendarId,
    context.eventId,
    attachment.destinationAttachmentId
  );
  if (attachment.destinationStoragePath !== expected) {
    throw new AttachmentMigrationPathMismatchError("cleanupAbortedDestinationStorage");
  }

  return runSerializedMigrationDestinationStage(identity.userId, attachment.destinationAttachmentId, async () => {
    assertCurrentSharedMutationIdentity(identity);
    try {
      return await deleteAttachmentStorageObject(attachment.destinationStoragePath, identity);
    } catch {
      throw new AttachmentMigrationStaleError("abort-destination-cleanup");
    }
  });
}
