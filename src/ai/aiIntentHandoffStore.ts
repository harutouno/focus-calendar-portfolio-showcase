import {
  AuthIdentity,
  getCurrentAuthIdentity,
  isCurrentAuthIdentity,
  isSameAuthIdentity,
  subscribeToAuthIdentity,
} from "@/auth/authSessionIdentityStore";
import { generateId } from "@/utils/id";

/**
 * P0150 (SEC-F007-006) §3: 「1回の明示的なAI依頼（intent）」を、
 * **その依頼を行った正確な `{userId, sessionInstanceId}` に束縛したまま**
 * 画面遷移をまたいで受け渡すためのプロセス内一時ストア。
 *
 * 何が壊れていたか:
 *   P0148は所有者をprocessing画面の**マウント時点**で捕捉していた。しかし
 *   「送信」という明示的なユーザー操作を行うのはAIホーム画面であり、ホームは
 *   生の入力文字列だけをrouteパラメータに載せてpushしていた。送信操作から
 *   processingのマウントまでの間にidentityが切り替わると、
 *     - Aの私的な入力がBの依頼として送信され
 *     - Bの利用回数が消費され
 *     - Aの入力がBの保留中依頼として端末に永続化される
 *   という経路が残っていた（routeパラメータは所有者を持たず、Reactのstateリセットや
 *   owner maskingの外側にあるため、タイミング条件を足すだけでは閉じない）。
 *
 * 契約（正本 §3）:
 *   - ルートが運ぶのは `intentId` だけ。生の入力文字列は運ばない。
 *   - エントリは明示的操作の時点の正確な `{userId, sessionInstanceId}` を持つ。
 *   - 読み出しは**現在の権威identityがその所有者と完全一致したときだけ**成功する。
 *     所有者検証を迂回できる読み出しAPIは存在しない（呼び出し元に
 *     「現在のidentity」を渡させる形にもしない——渡された値を信用しないため）。
 *   - 不正・未知・期限切れのIDは常に「意図なし」。呼び出し元は既存の安全な
 *     空/戻り経路（AIホームへ戻る）へ倒す。
 *   - identityが変わった時点で、新しい所有者のものでないエントリは同期的に破棄する。
 *   - 件数・時間の両方で上限を持ち、無制限に増えない。
 *   - プロセス再起動をまたがない（＝自動的なcross-session replayを作らない）。
 *
 * 読み出しは**破壊的ではない**（consumeしない）。理由:
 *   同一所有者による正当な再マウント（戻る操作・再描画・同一intentの再試行）で
 *   意図が消えると、進行中の論理依頼を取りこぼす（永続化済みrequestIdの再利用が
 *   できなくなり、同じ依頼が2つのrequestIdへ分裂しうる。これはP0148で
 *   自己発見・修正した欠陥と同型）。所有者不一致は常に読み出し失敗であり、
 *   TTL・件数上限・identity変更時の同期破棄で保持範囲は有界に保つ。
 */
export interface AiIntentEntry {
  /** この依頼の不変の所有者（明示的なユーザー操作の時点で捕捉した正確なidentity）。 */
  owner: AuthIdentity;
  /** 利用者の私的な入力。routeには載せず、このストアの中だけで保持する。 */
  input: string;
}

interface StoredAiIntent extends AiIntentEntry {
  publishedAt: number;
}

/** 同時に有効な明示的依頼はごく少数（画面は1件ずつ扱う）。多重遷移の余裕として少しだけ持つ。 */
const MAX_ENTRIES = 8;
/** 遷移のための一時保持であり、長期保管ではない。 */
const TTL_MS = 30 * 60 * 1000;

const entries = new Map<string, StoredAiIntent>();
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
 * import時点の副作用を避けるため、最初のpublishで購読する
 * （`aiResultHandoffStore` と同じ方針。テストのリセットで購読が外れた場合も
 * 次のpublishで張り直される）。
 */
function ensureIdentityPurgeSubscription(): void {
  if (identityPurgeUnsubscribe) return;
  identityPurgeUnsubscribe = subscribeToAuthIdentity((next) => {
    dropEntriesNotOwnedBy(next);
  });
}

/**
 * 明示的なユーザー操作（送信・再開）の時点で、入力とその所有者を登録し、
 * ルートで運ぶための `intentId` を返す。
 *
 * `owner` が既に権威identityでない場合は登録せず `null` を返す（fail-closed）。
 * 呼び出し元は `null` を「遷移してはいけない」と解釈する。
 * 空入力も登録しない（送信可能な依頼ではないため）。
 */
export function publishAiIntent(input: string, owner: AuthIdentity): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  if (!isCurrentAuthIdentity(owner)) return null;
  ensureIdentityPurgeSubscription();
  const now = Date.now();
  dropExpired(now);
  const intentId = generateId("ai_intent");
  entries.set(intentId, { owner, input, publishedAt: now });
  // 挿入順（Mapは挿入順を保つ）で古いものから落とす。
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
  return intentId;
}

/**
 * `intentId` が実在し、かつ**現在の権威identity**がそのエントリの所有者と
 * 完全一致するときだけ、意図（入力＋不変の所有者）を返す。
 *
 * 現在のidentityは引数で受け取らず、この関数の中で `getCurrentAuthIdentity()` から
 * 直接読む（呼び出し元が渡した「現在のidentityのつもりの値」を権威にしない）。
 * 所有者不一致・未知のID・不正な型・期限切れはすべて `null`（＝意図なし）。
 */
export function readAiIntent(intentId: string | null | undefined): AiIntentEntry | null {
  if (typeof intentId !== "string" || intentId.length === 0) return null;
  const entry = entries.get(intentId);
  if (!entry) return null;
  if (Date.now() - entry.publishedAt > TTL_MS) {
    entries.delete(intentId);
    return null;
  }
  if (!isSameAuthIdentity(entry.owner, getCurrentAuthIdentity())) return null;
  return { owner: entry.owner, input: entry.input };
}

/** 明示的な破棄。未知のIDでも安全に何もしない。 */
export function clearAiIntent(intentId: string | null | undefined): void {
  if (typeof intentId !== "string" || intentId.length === 0) return;
  entries.delete(intentId);
}

/** テスト専用: モジュールスコープの状態をリセットする。本番コードから呼ばない。 */
export function __resetAiIntentHandoffStoreForTests(): void {
  entries.clear();
  if (identityPurgeUnsubscribe) {
    identityPurgeUnsubscribe();
    identityPurgeUnsubscribe = null;
  }
}
