import AsyncStorage from "@react-native-async-storage/async-storage";
import { writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";
import { isPlainObject, isString } from "./shapeGuards";

/**
 * Round 13（SEC-F007-004/SEC-F007-001残存、P1-2）: 共有カレンダー添付画像の
 * create()/remove()が、副作用（Storageアップロード・soft delete・Storage削除・hard delete）を
 * 開始する前に必ず永続化する「意図（intent）」。stale化を検知した時点では、現在アクティブな
 * セッションが誰のものか分からない（既にB相当かもしれない）ため、その場でStorage操作を
 * 一切行わない——代わりに、副作用を始める直前に記録しておいたこのintentだけを頼りに、
 * 後から同じownerUserIdで再ログインしたセッション（sessionInstanceIdは問わない）が
 * `retryPendingAttachmentCleanups()`経由で安全に再試行する。
 *
 * - "create-intent": Storageアップロード開始前に記録する。DB登録（event_attachments行の
 *   upsert）が実際に成功したかどうかは、再試行時にattachmentIdでDB行の存在を確認する
 *   ことで判定する（行が存在すればStorageには触れずintentだけ除去、存在しなければ
 *   Storageオブジェクトを削除してからintentを除去）。
 * - "delete-intent": remove()開始前（soft delete前）に、DBから取得・検証したstoragePathと
 *   ともに記録する。再試行時はDB行（soft delete済みでも物理削除前なら取得できる）から
 *   再取得したeventId/storagePathとintentの全フィールドが完全一致した場合のみ削除を進める。
 * - "legacy-delete-unresolved": Round12（v1）のinterrupted-delete形式
 *   （ownerUserId+attachmentIdのみ、storagePathを持たない）から安全に移行できなかった
 *   残留データ。パスを静的に確定できないため、再試行時にattachmentId基準でDB行を
 *   問い合わせて解決を試みる（解決できなければ隔離したまま次回に持ち越す）。
 */
export type PendingAttachmentCleanupTarget =
  | {
      kind: "create-intent";
      ownerUserId: string;
      calendarId: string;
      eventId: string;
      attachmentId: string;
      storagePath: string;
    }
  | {
      kind: "delete-intent";
      ownerUserId: string;
      calendarId: string;
      eventId: string;
      attachmentId: string;
      storagePath: string;
    }
  | { kind: "legacy-delete-unresolved"; ownerUserId: string; attachmentId: string };

const STORAGE_PATH_PATTERN = /^([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/original\.jpg$/;

/** storagePathが`{calendarId}/{eventId}/{attachmentId}/original.jpg`の正規形式と完全一致するかを検証する。 */
export function isValidAttachmentStoragePath(path: string): boolean {
  return STORAGE_PATH_PATTERN.test(path);
}

/** 正規形式のstoragePathからcalendarId/eventId/attachmentIdを取り出す（旧v1データの移行専用）。 */
function parseAttachmentStoragePath(
  path: string
): { calendarId: string; eventId: string; attachmentId: string } | null {
  const m = STORAGE_PATH_PATTERN.exec(path);
  if (!m) return null;
  return { calendarId: m[1], eventId: m[2], attachmentId: m[3] };
}

function targetKey(t: PendingAttachmentCleanupTarget): string {
  return `${t.kind}::${t.ownerUserId}::${t.attachmentId}`;
}

function hasStoragePathFields(
  t: PendingAttachmentCleanupTarget
): t is Extract<PendingAttachmentCleanupTarget, { kind: "create-intent" | "delete-intent" }> {
  return t.kind === "create-intent" || t.kind === "delete-intent";
}

/**
 * Round14（P1-2）: targetKeyが一致する既存エントリと新規登録要求が、全フィールドまで
 * 完全一致するかを検証する（衝突検知用）。kind/ownerUserId/attachmentIdはキー自体で
 * 既に一致確認済みのため、create-intent/delete-intentが持つ残りのフィールド
 * （calendarId/eventId/storagePath）だけを追加で比較する。
 */
function isSameTarget(a: PendingAttachmentCleanupTarget, b: PendingAttachmentCleanupTarget): boolean {
  if (a.kind !== b.kind || a.ownerUserId !== b.ownerUserId || a.attachmentId !== b.attachmentId) {
    return false;
  }
  if (hasStoragePathFields(a) && hasStoragePathFields(b)) {
    return a.calendarId === b.calendarId && a.eventId === b.eventId && a.storagePath === b.storagePath;
  }
  return true;
}

/**
 * storagePathが、同一エントリのcalendarId/eventId/attachmentIdから再構築した値と
 * 完全一致するかを検証する（改変されたローカルデータで別の添付を指すpathを
 * 混入させられないようにするため、形式チェックだけでなく値の一貫性まで確認する）。
 */
function isConsistentIntentShape(t: {
  calendarId: string;
  eventId: string;
  attachmentId: string;
  storagePath: string;
}): boolean {
  const expected = `${t.calendarId}/${t.eventId}/${t.attachmentId}/original.jpg`;
  return t.storagePath === expected;
}

/**
 * 1件の生要素を検証済みターゲットへ変換する。不正な形の場合はnullを返す
 * （strict版リーダーはnullが1件でもあれば例外を投げ、空配列へフォールバックしない）。
 * Round12（v1）形式との後方互換移行も担う。
 */
function parseTargetEntry(item: unknown): PendingAttachmentCleanupTarget | null {
  if (!isPlainObject(item)) return null;
  if (!isString(item.ownerUserId) || item.ownerUserId.length === 0) return null;

  if (item.kind === "create-intent" || item.kind === "delete-intent") {
    if (
      isString(item.calendarId) &&
      item.calendarId.length > 0 &&
      isString(item.eventId) &&
      item.eventId.length > 0 &&
      isString(item.attachmentId) &&
      item.attachmentId.length > 0 &&
      isString(item.storagePath) &&
      isValidAttachmentStoragePath(item.storagePath) &&
      isConsistentIntentShape({
        calendarId: item.calendarId,
        eventId: item.eventId,
        attachmentId: item.attachmentId,
        storagePath: item.storagePath,
      })
    ) {
      return {
        kind: item.kind,
        ownerUserId: item.ownerUserId,
        calendarId: item.calendarId,
        eventId: item.eventId,
        attachmentId: item.attachmentId,
        storagePath: item.storagePath,
      };
    }
    return null;
  }

  if (item.kind === "legacy-delete-unresolved") {
    if (isString(item.attachmentId) && item.attachmentId.length > 0) {
      return { kind: "legacy-delete-unresolved", ownerUserId: item.ownerUserId, attachmentId: item.attachmentId };
    }
    return null;
  }

  // Round12（v1）形式: {kind:"orphaned-upload", ownerUserId, storagePath} は、pathが
  // 既に正規形式ならcalendarId/eventId/attachmentIdを静的に復元できるため、
  // その場でcreate-intentへ安全に移行する。
  if (item.kind === "orphaned-upload") {
    if (isString(item.storagePath) && isValidAttachmentStoragePath(item.storagePath)) {
      const parsed = parseAttachmentStoragePath(item.storagePath);
      if (parsed) {
        return { kind: "create-intent", ownerUserId: item.ownerUserId, storagePath: item.storagePath, ...parsed };
      }
    }
    return null;
  }

  // Round12（v1）形式: {kind:"interrupted-delete", ownerUserId, attachmentId} は
  // storagePathを持たず静的に復元できないため、隔離対象として移行する
  // （削除は実行せず、再試行時にDB照会で解決を試みる）。
  if (item.kind === "interrupted-delete") {
    if (isString(item.attachmentId) && item.attachmentId.length > 0) {
      return { kind: "legacy-delete-unresolved", ownerUserId: item.ownerUserId, attachmentId: item.attachmentId };
    }
    return null;
  }

  return null;
}

/**
 * notificationRepository.tsのgetPendingOwnerCleanupTargetsStrictと同じ設計。
 * AsyncStorage読込み・JSON解析・配列形状・各要素の形状のいずれかが不正な場合は例外を投げ、
 * 空配列へフォールバックしない（read-modify-writeの「読込み障害＝0件」誤認を防ぐため、
 * add/remove双方の内部読込みにもこのstrict版だけを使う）。値が全く保存されていない場合
 * （初回起動等、正当な「pending無し」状態）のみ空配列を返す。
 */
async function readTargetsStrict(): Promise<PendingAttachmentCleanupTarget[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.pendingAttachmentStorageCleanup);
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("pendingAttachmentStorageCleanupのJSON解析に失敗しました");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("pendingAttachmentStorageCleanupの形式が不正です（配列ではありません）");
  }
  const targets: PendingAttachmentCleanupTarget[] = [];
  for (const item of parsed) {
    const target = parseTargetEntry(item);
    if (!target) {
      throw new Error("pendingAttachmentStorageCleanupに不正な要素が含まれています");
    }
    targets.push(target);
  }
  return targets;
}

/** 他の変更操作とは独立した、この一覧専用の直列化チェーン（read-modify-writeの競合防止）。 */
let pendingAttachmentCleanupChain: Promise<void> = Promise.resolve();

function enqueuePendingAttachmentCleanupOp<T>(op: () => Promise<T>): Promise<T> {
  const run = pendingAttachmentCleanupChain.then(op);
  pendingAttachmentCleanupChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * 現在「未完了」として記録されているクリーンアップ対象一覧を返す（重複無し）。
 * 読込み自体が失敗した場合（AsyncStorage障害・JSON破損・不正要素混入）は例外を投げる
 * （呼び出し元は「0件」と誤認せず、この回の処理を諦める設計にすること）。
 */
export function getPendingAttachmentCleanups(): Promise<PendingAttachmentCleanupTarget[]> {
  return enqueuePendingAttachmentCleanupOp(() => readTargetsStrict());
}

/**
 * 対象を一覧へ追加する。storagePath/attachmentIdの形式が不正な場合は、無音でスキップせず
 * 例外を投げる（Round13、Stage2: 呼び出し元の実装ミスを早期に発見できるようにするため、
 * 以前のno-op設計から変更した）。既存の読込み自体が失敗した場合も同様に例外を投げる
 * （空配列とみなして上書きし、既存の未完了対象を消してしまわないようにするため）。
 *
 * Round14（P1-2）: 同じキー（kind+ownerUserId+attachmentId）の既存エントリが既にある場合、
 * 全フィールドが完全一致すれば冪等な成功として扱うが、一部でも異なれば衝突として例外を
 * 投げる（改変・別添付の取り違えを無音で上書きしないため）。
 */
export function addPendingAttachmentCleanup(target: PendingAttachmentCleanupTarget): Promise<void> {
  return enqueuePendingAttachmentCleanupOp(async () => {
    if (
      (target.kind === "create-intent" || target.kind === "delete-intent") &&
      !isConsistentIntentShape(target)
    ) {
      throw new Error("不正な添付クリーンアップ対象です（storagePathがcalendarId/eventId/attachmentIdと一致しません）");
    }
    if (target.kind === "legacy-delete-unresolved" && target.attachmentId.length === 0) {
      throw new Error("不正な添付クリーンアップ対象です（attachmentIdが空です）");
    }
    const current = await readTargetsStrict();
    const key = targetKey(target);
    const existing = current.find((t) => targetKey(t) === key);
    if (existing) {
      if (isSameTarget(existing, target)) return; // 全フィールド完全一致: 冪等に成功扱い
      throw new Error(
        "添付クリーンアップ対象が衝突しています（同一キーで内容が異なるintentが既に存在します）"
      );
    }
    await writeJSON(STORAGE_KEYS.pendingAttachmentStorageCleanup, [...current, target]);
  });
}

/** 対象を一覧から除去する（cleanup成功を確認した後にのみ呼ぶこと）。書込み失敗時は例外を投げる。 */
export function removePendingAttachmentCleanup(target: PendingAttachmentCleanupTarget): Promise<void> {
  return enqueuePendingAttachmentCleanupOp(async () => {
    const current = await readTargetsStrict();
    const key = targetKey(target);
    const next = current.filter((t) => targetKey(t) !== key);
    if (next.length === current.length) return;
    await writeJSON(STORAGE_KEYS.pendingAttachmentStorageCleanup, next);
  });
}

/** 指定したownerUserIdに属する対象だけを返す（同じuserIdが再ログインした時の再試行用）。 */
export async function getPendingAttachmentCleanupsForOwner(
  ownerUserId: string
): Promise<PendingAttachmentCleanupTarget[]> {
  const all = await getPendingAttachmentCleanups();
  return all.filter((t) => t.ownerUserId === ownerUserId);
}
