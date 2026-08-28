import { AIRequestKind, AiChatHistoryEntry } from "@/types/ai";
import { readJSON, writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";
import { hasId, readRawArray } from "./arrayRepository";
import { isOwnerScopeVisible } from "./ownerScope";
import {
  isNonEmptyString,
  isPlainObject,
  isString,
  isValidIsoDateTimeString,
  StoredDataValidationError,
} from "./shapeGuards";

function isValidOwnerUserId(value: unknown): boolean {
  return value === undefined || value === null || isNonEmptyString(value);
}

/**
 * AIサポートのやり取り履歴（質問と結果）を永続化する。以前から予約されていたが
 * 未使用だった STORAGE_KEYS.chatHistory をそのまま利用する（新しいキーは追加しない）。
 * アプリ再起動後も直近の履歴が残るよう、最大件数を決めて先頭（最新）から保持する。
 */
const MAX_HISTORY_ENTRIES = 20;

const AI_REQUEST_KINDS: readonly AIRequestKind[] = [
  "create_schedule",
  "suggest_schedule",
  "focus_analysis",
  "feature_help",
];

function isValidAiResponse(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!isString(value.headline)) return false;
  if (!Array.isArray(value.actions)) return false;
  return value.actions.every(
    (a) => isPlainObject(a) && isString(a.type) && isString(a.label)
  );
}

/** DATA-F002-002: 壊れた要素だけを一覧から除外できるよう、配列フィルタで使う。 */
function isValidAiChatHistoryEntry(value: unknown): value is AiChatHistoryEntry {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isValidIsoDateTimeString(value.createdAt)) return false;
  if (!(AI_REQUEST_KINDS as readonly string[]).includes(value.kind as string)) return false;
  if (!isString(value.input)) return false;
  if (!isValidAiResponse(value.response)) return false;
  if (!isValidOwnerUserId(value.ownerUserId)) return false;
  return true;
}

/**
 * SEC-F006-001残存修正: currentUserIdは「今、この端末で有効な認証ユーザーID
 * （未ログインならnull）」。所有者スコープの判定自体はisOwnerScopeVisible()に集約し、
 * 「ownerUserIdが無い（旧形式）」「明示的にnull（ゲスト）」「文字列（本人）」の3状態を
 * 区別する（詳細は同関数のコメントを参照）。これにより、ログアウト時の
 * clearAiChatHistory()が何らかの理由で失敗しても、別ユーザー・未ログイン状態・
 * 所有者不明の旧形式データへの復元を読み込み時点で防ぐ（Storage削除の成否に
 * 依存しない永続的な防御）。
 */
export async function getAiChatHistory(
  currentUserId: string | null = null
): Promise<AiChatHistoryEntry[]> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.chatHistory, []);
  if (!Array.isArray(raw)) {
    throw new StoredDataValidationError("chatHistory", "not_array");
  }
  const valid = raw.filter(isValidAiChatHistoryEntry);
  if (valid.length !== raw.length && __DEV__) {
    console.warn(`[aiChatHistoryRepository] ${raw.length - valid.length}件の不正な会話履歴を除外しました`);
  }
  return valid.filter((entry) => isOwnerScopeVisible(entry.ownerUserId, currentUserId));
}

/** 先頭（最新）へ追加し、MAX_HISTORY_ENTRIES件を超えた分は古い方から切り捨てる。 */
/** 会話履歴は再現可能な補助的データ（Category C）のため、保存失敗を呼び出し元へ伝播させない。 */
/**
 * DATA-F002-004: getAiChatHistory()の結果（形状検証済み）ではなく生の配列を読み直し、
 * この保存操作とは無関係な不正要素をStorageから消してしまわないようにする
 * （保持する不正要素自体はMAX_HISTORY_ENTRIESの件数上限の対象外——上限は
 * ユーザーに見える有効な履歴件数の管理であり、不正なゴミデータの保持数とは別の関心事）。
 */
/**
 * [P0130 F073-SERIALIZATION-CLOSURE-001] `chatHistory` キーの全writerを直列化する
 * module-level single-writer チェーン。
 *
 * 対象は3つ:
 *   appendAiChatHistory        （AI応答ごとの追記。best-effort）
 *   clearAiChatHistory         （ログアウト時の全消去。best-effort）
 *
 * P0129の指摘どおり、render時のowner maskingは**漏洩**は防ぐが
 * **永続層の latest-value 意図**は守らない。append と purge/clear が交差すると、
 * 古いスナップショット基準の書き戻しが相手の成功済み変更を消し得た。
 *
 * best-effort（append/clear）と strict（purge）の**失敗方針の違いは維持したまま**、
 * 順序だけを揃える。`enqueueSyncQueueOp` と同一設計。
 */
let chatHistoryWriteQueue: Promise<void> = Promise.resolve();

function enqueueChatHistoryOp<T>(operation: () => Promise<T>): Promise<T> {
  const result = chatHistoryWriteQueue.then(operation, operation);
  chatHistoryWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export function appendAiChatHistory(
  entry: AiChatHistoryEntry
): Promise<AiChatHistoryEntry[]> {
  return enqueueChatHistoryOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.chatHistory, "chatHistory");
    const history = raw.filter(isValidAiChatHistoryEntry);
    const preservedInvalid = raw.filter(
      (el) => !isValidAiChatHistoryEntry(el) && !hasId(el, entry.id)
    );
    const next = [entry, ...history].slice(0, MAX_HISTORY_ENTRIES);
    await writeJSON(STORAGE_KEYS.chatHistory, [...next, ...preservedInvalid]).catch(() => {});
    return next;
  });
}

export function clearAiChatHistory(): Promise<void> {
  return enqueueChatHistoryOp(async () => {
    await writeJSON(STORAGE_KEYS.chatHistory, []).catch(() => {});
  });
}
