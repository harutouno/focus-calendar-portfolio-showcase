import {
  AuthIdentity,
  getCurrentAuthIdentity,
  isCurrentAuthIdentity,
  isSameAuthIdentity,
  subscribeToAuthIdentity,
} from "@/auth/authSessionIdentityStore";
import { AISupportResponse } from "@/types/ai";
import { generateId } from "@/utils/id";

/**
 * P0148 (SEC-F007-005) §7: AI応答（利用者の自由入力に基づく私的な内容）を
 * **所有者付き・プロセス内一時保持**へ移すためのストア。
 *
 * 従来は `/ai/result` のルートパラメータへ `JSON.stringify(response)` をそのまま載せていた。
 * ルートパラメータは所有者を持たないため、そのルートが残ったままidentityが変わると、
 * 新しい所有者の画面が前の所有者の応答をそのまま描画できてしまう
 * （navigation stateはReactのstateリセットやowner maskingの外側にある）。
 *
 * 契約:
 *   - ルートが運ぶのは `resultId` だけ。生の応答は運ばない。
 *   - エントリは正確な `{userId, sessionInstanceId}` を持つ。
 *   - 読み出しは**完全一致したときだけ**成功する。所有者検証を迂回する読み出しAPIは無い。
 *   - 不正・未知のIDは常に「結果なし」。
 *   - identityが変わった時点で、新しい所有者のものでないエントリは同期的に破棄する
 *     （読み出し時の検証だけに頼らず、前の所有者の応答をメモリ上にも残さない）。
 *   - 件数・時間の両方で上限を持ち、無制限に増えない。
 *   - プロセス再起動をまたがない。復元できない場合は既存の空状態UIで安全に失敗する
 *     （所有者検証を緩めて復元可能にすることはしない）。
 */
interface AiResultEntry {
  owner: AuthIdentity;
  response: AISupportResponse;
  publishedAt: number;
}

/** 直近の結果だけ保持できれば十分（画面は1件ずつ表示する）。多重遷移の余裕として少しだけ持つ。 */
const MAX_ENTRIES = 8;
/** 表示のための一時保持であり、長期保管ではない。 */
const TTL_MS = 30 * 60 * 1000;

const entries = new Map<string, AiResultEntry>();
let identityPurgeUnsubscribe: (() => void) | null = null;

function dropExpired(now: number): void {
  for (const [id, entry] of entries) {
    if (now - entry.publishedAt > TTL_MS) {
      entries.delete(id);
    }
  }
}

function dropEntriesNotOwnedBy(identity: AuthIdentity): void {
  for (const [id, entry] of entries) {
    if (!isSameAuthIdentity(entry.owner, identity)) {
      entries.delete(id);
    }
  }
}

/**
 * import時点の副作用を避けるため、最初のpublishで購読する（他のモジュールスコープ
 * 購読者と同じ方針。テストのリセットで購読が外れた場合も次のpublishで張り直される）。
 */
function ensureIdentityPurgeSubscription(): void {
  if (identityPurgeUnsubscribe) return;
  identityPurgeUnsubscribe = subscribeToAuthIdentity((next) => {
    dropEntriesNotOwnedBy(next);
  });
}

/**
 * 結果を所有者付きで登録し、ルートで運ぶための `resultId` を返す。
 * 指定した所有者が既に権威identityでない場合は登録せず `null` を返す（fail-closed）。
 * 呼び出し元は `null` を「遷移してはいけない」と解釈する。
 */
export function publishAiResult(
  response: AISupportResponse,
  owner: AuthIdentity
): string | null {
  if (!isCurrentAuthIdentity(owner)) return null;
  ensureIdentityPurgeSubscription();
  const now = Date.now();
  dropExpired(now);
  const resultId = generateId("ai_result");
  entries.set(resultId, { owner, response, publishedAt: now });
  // 挿入順（Mapは挿入順を保つ）で古いものから落とす。
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
  return resultId;
}

/**
 * `resultId` と**現在の権威identity**の両方が一致したときだけ応答を返す。
 * 所有者不一致・未知のID・不正な型・期限切れはすべて `null`（＝結果なし）。
 *
 * P0150 (MAINT-AI-001) §6: 以前は呼び出し元が「現在のidentityのつもりの値」を
 * 引数で渡す設計だった。呼び出し元が古い値・別経路で得た値を渡すと、所有者検証が
 * 実質的に無効化されうる（＝安全性が呼び出し元の規律に依存していた）。
 * 現在の権威identityはこの関数の中で `getCurrentAuthIdentity()` から直接読み、
 * 引数では受け取らない。TTL・件数上限・同期purge・不正IDのfail-closed・
 * `resultId`だけを運ぶルート契約はいずれも変更していない。
 */
export function readAiResult(
  resultId: string | null | undefined
): AISupportResponse | null {
  if (typeof resultId !== "string" || resultId.length === 0) return null;
  const entry = entries.get(resultId);
  if (!entry) return null;
  if (Date.now() - entry.publishedAt > TTL_MS) {
    entries.delete(resultId);
    return null;
  }
  if (!isSameAuthIdentity(entry.owner, getCurrentAuthIdentity())) return null;
  return entry.response;
}

/** 明示的な破棄（結果画面から離れる等）。未知のIDでも安全に何もしない。 */
export function clearAiResult(resultId: string | null | undefined): void {
  if (typeof resultId !== "string" || resultId.length === 0) return;
  entries.delete(resultId);
}

/** テスト専用: モジュールスコープの状態をリセットする。本番コードから呼ばない。 */
export function __resetAiResultHandoffStoreForTests(): void {
  entries.clear();
  if (identityPurgeUnsubscribe) {
    identityPurgeUnsubscribe();
    identityPurgeUnsubscribe = null;
  }
}
