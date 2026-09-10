import { EventAttachment } from "@/types/attachment";
import { readJSON, writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";
import { hasId, readRawArray } from "./arrayRepository";
import {
  isFiniteNumber,
  isNonEmptyString,
  isOneOf,
  isPlainObject,
  isString,
  isValidIsoDateTimeString,
  StoredDataValidationError,
} from "./shapeGuards";

/**
 * 端末内予定（ローカルカレンダー）に添付された画像のメタデータ。
 * 実ファイルの保存・削除（expo-file-system経由のコピー処理）はフェーズ2で追加する
 * localAttachmentRepository.ts の責務とし、ここでは常に「既にfile://で渡された
 * URIを持つメタデータ」をAsyncStorageへ読み書きするだけに留める
 * （eventsRepository.ts と同じ薄いJSON読み書きパターン）。
 */

const MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const UPLOAD_STATUSES = ["uploading", "ready", "failed"] as const;

/** DATA-F002-002: 壊れた要素だけを一覧から除外できるよう、配列フィルタで使う。 */
function isValidEventAttachment(value: unknown): value is EventAttachment {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isNonEmptyString(value.eventId)) return false;
  if (!isOneOf(value.mimeType, MIME_TYPES)) return false;
  if (!isFiniteNumber(value.byteSize)) return false;
  if (!isFiniteNumber(value.sortOrder)) return false;
  if (!isOneOf(value.uploadStatus, UPLOAD_STATUSES)) return false;
  if (!isValidIsoDateTimeString(value.createdAt)) return false;
  if (value.uri !== undefined && !isString(value.uri)) return false;
  if (value.thumbnailUri !== undefined && !isString(value.thumbnailUri)) return false;
  if (value.width !== undefined && !isFiniteNumber(value.width)) return false;
  if (value.height !== undefined && !isFiniteNumber(value.height)) return false;
  return true;
}

async function getAllEventAttachments(): Promise<EventAttachment[]> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.eventAttachments, []);
  if (!Array.isArray(raw)) {
    throw new StoredDataValidationError("eventAttachments", "not_array");
  }
  const valid = raw.filter(isValidEventAttachment);
  if (valid.length !== raw.length && __DEV__) {
    console.warn(`[eventAttachmentsRepository] ${raw.length - valid.length}件の不正な添付データを除外しました`);
  }
  return valid;
}

export async function getEventAttachments(eventId: string): Promise<EventAttachment[]> {
  const all = await getAllEventAttachments();
  return all
    .filter((a) => a.eventId === eventId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * idが一致すれば置き換え、なければ追加する（eventsRepository.saveEventと同じ意味論）。
 * DATA-F002-004: getAllEventAttachments()（形状検証済み）ではなく生の配列を読み直し、
 * この保存操作とは無関係な不正要素をStorageから消してしまわないようにする。
 */
/**
 * [P0130 F073-SERIALIZATION-CLOSURE-001] `eventAttachments` キーのRMWを直列化する
 * module-level single-writer チェーン。
 *
 * 3つのwriter（save / remove / removeForEvent）はいずれも
 *   readRawArray -> 派生 -> writeJSON
 * であり、`await` を跨ぐ。P0129が指摘したとおり、これらを跨いで共有する上位権威が
 * 本番呼び出し元（useEventAttachments / localAttachmentRepository / イベント削除経路）に
 * 存在しないため、2つの操作が同じ古いスナップショットを読み、後勝ちで
 * 相手の成功済み変更を消し得た。
 *
 * 設計はこのリポジトリ群で確立済みの `enqueueSyncQueueOp` /
 * `registryMutationChain` / `pendingRequestWriteQueue` と同一:
 * - キー単位。アプリ全体のストレージmutexにはしない。
 * - 新しい永続状態を増やさない。
 * - operationがrejectしてもチェーンは次へ進む（poisonしない）。エラーは呼び出し元へ伝播する。
 */
let eventAttachmentsWriteQueue: Promise<void> = Promise.resolve();

function enqueueEventAttachmentsOp<T>(operation: () => Promise<T>): Promise<T> {
  const result = eventAttachmentsWriteQueue.then(operation, operation);
  eventAttachmentsWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export function saveEventAttachment(
  attachment: EventAttachment
): Promise<EventAttachment[]> {
  return enqueueEventAttachmentsOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.eventAttachments, "eventAttachments");
    const all = raw.filter(isValidEventAttachment);
    const preservedInvalid = raw.filter(
      (el) => !isValidEventAttachment(el) && !hasId(el, attachment.id)
    );
    const idx = all.findIndex((a) => a.id === attachment.id);
    let next: EventAttachment[];
    if (idx >= 0) {
      next = [...all];
      next[idx] = attachment;
    } else {
      next = [...all, attachment];
    }
    await writeJSON(STORAGE_KEYS.eventAttachments, [...next, ...preservedInvalid]);
    return next;
  });
}

export function removeEventAttachment(id: string): Promise<EventAttachment[]> {
  return enqueueEventAttachmentsOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.eventAttachments, "eventAttachments");
    const all = raw.filter(isValidEventAttachment);
    const preservedInvalid = raw.filter((el) => !isValidEventAttachment(el) && !hasId(el, id));
    const next = all.filter((a) => a.id !== id);
    await writeJSON(STORAGE_KEYS.eventAttachments, [...next, ...preservedInvalid]);
    return next;
  });
}

/**
 * 予定削除時に、その予定に属する添付メタデータを一括で消す（section 22対応）。
 * DATA-F002-004: 同じeventIdを持つ不正な形状の要素（この予定の孤立した壊れた添付情報）は
 * 削除対象に含める一方、他の予定に属する不正要素は無関係なため保持する。
 */
export function removeEventAttachmentsForEvent(
  eventId: string
): Promise<EventAttachment[]> {
  return enqueueEventAttachmentsOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.eventAttachments, "eventAttachments");
    const all = raw.filter(isValidEventAttachment);
    const preservedInvalid = raw.filter(
      (el) => !isValidEventAttachment(el) && !(isPlainObject(el) && el.eventId === eventId)
    );
    const next = all.filter((a) => a.eventId !== eventId);
    await writeJSON(STORAGE_KEYS.eventAttachments, [...next, ...preservedInvalid]);
    return next;
  });
}

/** 端末内添付の総使用容量（バイト）。無料/プレミアムの総容量上限判定に使う。 */
export async function getLocalAttachmentsTotalBytes(): Promise<number> {
  const all = await getAllEventAttachments();
  return all.reduce((sum, a) => sum + a.byteSize, 0);
}
