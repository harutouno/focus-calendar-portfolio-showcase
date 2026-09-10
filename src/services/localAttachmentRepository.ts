import { Directory, File, Paths } from "expo-file-system";
import { EventAttachment, ProcessedImage } from "@/types/attachment";
import {
  getEventAttachments,
  removeEventAttachment,
  removeEventAttachmentsForEvent,
  saveEventAttachment,
} from "@/storage/eventAttachmentsRepository";
import { LocalAttachmentSaveContext, LocalEventAttachmentRepository } from "./attachmentRepository";

/**
 * 端末内予定（ローカルカレンダー）の添付画像。圧縮済みファイルをアプリ専用の永続領域
 * （attachments/events/{eventId}/{attachmentId}.jpg）へコピーし、メタデータは
 * eventAttachmentsRepository.ts（AsyncStorage）へ登録する。
 * 写真ライブラリの一時URIをそのまま保存しない——localImageStorage.ts（カレンダーカバー画像）と
 * 同じ「永続コピーして初めて保存したと言える」方針を、複数枚・予定単位のディレクトリへ拡張する。
 */

function eventsRootDirectory(): Directory {
  return new Directory(Paths.document, "attachments", "events");
}

/**
 * DATA-F002-003: `target`が`root`配下（root自身を含む）に実際に解決されているかを確認する。
 * eventIdは通常generateId()由来またはevents行の既存IDだが、削除経路（remove/
 * deleteLocalEventAttachmentsDirectory）は改変されたAsyncStorageデータ経由でも
 * 呼ばれうるため、`../`等で添付領域の外側を指すURIが構築されていないことを、
 * 実際に削除する直前に確認する。
 */
function isWithinRoot(root: Directory, target: Directory): boolean {
  return target.uri === root.uri || target.uri.startsWith(`${root.uri}/`);
}

function eventAttachmentsDirectory(eventId: string): Directory {
  const dir = new Directory(eventsRootDirectory(), eventId);
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  return dir;
}

function attachmentFileName(attachmentId: string): string {
  return `${attachmentId}.jpg`;
}

export const localAttachmentRepository: LocalEventAttachmentRepository = {
  async list(eventId: string): Promise<EventAttachment[]> {
    return getEventAttachments(eventId);
  },

  async create(
    processed: ProcessedImage,
    context: LocalAttachmentSaveContext
  ): Promise<EventAttachment> {
    const destination = new File(
      eventAttachmentsDirectory(context.eventId),
      attachmentFileName(context.id)
    );
    if (destination.exists) {
      destination.delete();
    }
    const source = new File(processed.localUri);
    source.copy(destination);

    const attachment: EventAttachment = {
      id: context.id,
      eventId: context.eventId,
      uri: `${destination.uri}?t=${Date.now()}`,
      mimeType: processed.mimeType,
      byteSize: processed.byteSize,
      width: processed.width,
      height: processed.height,
      sortOrder: context.sortOrder,
      uploadStatus: "ready",
      createdAt: new Date().toISOString(),
    };
    await saveEventAttachment(attachment);
    return attachment;
  },

  /**
   * DATA-F002-004: メタデータの削除を先に永続化してから、ファイルを削除する
   * （逆順にすると、ファイル削除が成功した直後にメタデータの保存が失敗した場合、
   * 既に存在しないファイルを参照するメタデータだけが残ってしまう）。メタデータの
   * 削除自体が失敗した場合はここで例外が伝播し、ファイルには一切触れない
   * （呼び出し元には「削除できなかった」ことがそのまま伝わる）。メタデータ削除が
   * 成功した後のファイル削除の失敗は、孤立ファイルとして残すだけに留め、
   * 呼び出し元へは伝播させない（添付の「削除」というユーザーから見た操作自体は
   * 既に成功しているため）。
   */
  async remove(attachmentId: string, eventId: string): Promise<void> {
    await removeEventAttachment(attachmentId);
    const root = eventsRootDirectory();
    const dir = new Directory(root, eventId);
    if (isWithinRoot(root, dir)) {
      const file = new File(dir, attachmentFileName(attachmentId));
      if (file.exists) {
        try {
          file.delete();
        } catch (e) {
          if (__DEV__) {
            console.warn(
              "[localAttachmentRepository] 添付ファイルの削除に失敗しました（メタデータは削除済み、孤立ファイルとして残存）",
              e instanceof Error ? e.name : "unknown"
            );
          }
        }
      }
    }
  },

  async resolveDisplayUri(attachment: EventAttachment): Promise<string | null> {
    return attachment.uri ?? null;
  },
};

/**
 * 予定に属する添付ディレクトリを丸ごと削除する。用途は2つ：
 * ①予定削除時（section 22、添付が永久に残り続けないようにする。DATA-F002-003で
 *   eventService.removeLocalEvent/removeLocalEventsBulkへ実際に配線した）
 * ②新規予定作成をキャンセルした場合の一時ファイル掃除（section 20、draftEventId配下）
 * 存在しなくてもエラーにしない。eventIdが添付領域の外側を指すよう改変されていた場合は、
 * 安全側としてディレクトリ削除自体を行わない。
 *
 * DATA-F002-004: メタデータの削除を先に永続化してから、ディレクトリを削除する
 * （逆順だと、ディレクトリ削除が成功した直後にメタデータの保存が失敗した場合、
 * 既に存在しないファイルを参照するメタデータだけが残ってしまう）。メタデータの
 * 削除自体が失敗した場合はここで例外が伝播し、ディレクトリには一切触れない。
 * メタデータ削除が成功した後のディレクトリ削除の失敗は、孤立ディレクトリとして
 * 残すだけに留め、呼び出し元（eventService.ts）へは伝播させない
 * （呼び出し元は既にこの関数全体を`.catch()`でベストエフォート扱いしているが、
 * ここで先に握りつぶすことで、メタデータは既に正しく削除済みであることを
 * ログ上でも区別できるようにする）。
 */
export async function deleteLocalEventAttachmentsDirectory(eventId: string): Promise<void> {
  await removeEventAttachmentsForEvent(eventId);
  const root = eventsRootDirectory();
  const dir = new Directory(root, eventId);
  if (isWithinRoot(root, dir) && dir.exists) {
    try {
      dir.delete();
    } catch (e) {
      if (__DEV__) {
        console.warn(
          "[localAttachmentRepository] 添付ディレクトリの削除に失敗しました（メタデータは削除済み、孤立ディレクトリとして残存）",
          e instanceof Error ? e.name : "unknown"
        );
      }
    }
  }
}
