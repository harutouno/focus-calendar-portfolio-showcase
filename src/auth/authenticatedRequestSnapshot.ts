import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import { extractSessionIdFromAccessToken } from "@/utils/jwt";
import { getCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * src/lib/supabaseClient.ts と同じ既存規約（未設定時はダミーURLでインスタンスだけ作り、
 * 実際の呼び出しは呼び出し元が `isSupabaseConfigured` を確認してガードする）。
 * [P0080 AUTH-F013-F017-001] で sharedMutationAuthSnapshot.ts へ入れた定数を、
 * P0150で汎用モジュールへ移した（値・意味は同一）。
 */
const pinnedClientSupabaseUrl = isSupabaseConfigured ? supabaseUrl : "https://placeholder.supabase.co";
const pinnedClientSupabaseAnonKey = isSupabaseConfigured ? supabaseAnonKey : "placeholder-anon-key";

/**
 * P0150 (SEC-F007-007): 「1つの論理的なリモート試行」に対して**認可を1回だけ捕捉して固定する**
 * ための、機能横断の共通プリミティブ。
 *
 * 背景（正本 §1）:
 *   ローカルのidentityチェックは、リモートの認可保証ではない。
 *   supabase-js の `SupabaseClient._getSessionToken()` は fetch のたびに
 *   「その時点の ambient session」を読み直すため、
 *
 *     ローカル確認「今も所有者Aだ」 → await境界 → 認証がBへ切替 → 実際のHTTPは B のJWTを積む
 *
 *   というrequest-levelのTOCTOUが常に存在する。
 *
 * 本モジュールは、[P0080] で共有mutation向けに実証済みの手順
 * （`src/auth/sharedMutationAuthSnapshot.ts`）と、[P0058] のアカウント削除
 * （`ExplicitDeletionAuthSnapshot`）で用いた考え方を、AI/リワードを含む任意の
 * 「正確な所有者に束縛されたリモート試行」から使えるよう共通化したもの。
 * `sharedMutationAuthSnapshot.ts` は本モジュールへ委譲しつつ、公開API・例外メッセージ・
 * 意味論を一切変えていない（正本 §4「既存の受理済み共有mutationを名前の整理のために
 * 不安定化させない」）。
 *
 * トークンはメモリ上でのみ受け渡す。AsyncStorage/SecureStore/同期キュー/pendingレコード/
 * ログ/エラー/ドキュメント/テストのいずれにも書き込まない（呼び出し元はこの
 * スナップショットオブジェクト自体を永続化・ログ出力してはならない）。
 */
export interface ExactAuthenticatedIdentity {
  userId: string;
  sessionInstanceId: string;
}

export interface AuthenticatedRequestSnapshot extends ExactAuthenticatedIdentity {
  accessToken: string;
}

/**
 * 権威ストア（`authSessionIdentityStore`）の現在値が、指定した正確なidentityと
 * 完全一致するか。userId・sessionInstanceIdの**両方**を厳密比較する
 * （`sharedMutationIdentity.isCurrentSharedMutationIdentity` と同じ判定・同じ権威）。
 */
export function isCurrentExactAuthenticatedIdentity(identity: ExactAuthenticatedIdentity): boolean {
  const current = getCurrentAuthIdentity();
  return current.userId === identity.userId && current.sessionInstanceId === identity.sessionInstanceId;
}

/**
 * 未ログイン・sessionInstanceId不明（JWTのsession_id claimを取得できなかった異常な
 * セッション）を含む一般の `AuthIdentity` から、リモート認可に使える「正確なidentity」を
 * 取り出す。どちらかがnullなら**null**を返す（fail-closed。呼び出し元は
 * 「pinnedな認可を作れない＝リモート試行を行わない」と解釈する）。
 */
export function toExactAuthenticatedIdentity(
  identity: { userId: string | null; sessionInstanceId: string | null } | null | undefined
): ExactAuthenticatedIdentity | null {
  if (!identity) return null;
  if (typeof identity.userId !== "string" || identity.userId.length === 0) return null;
  if (typeof identity.sessionInstanceId !== "string" || identity.sessionInstanceId.length === 0) {
    return null;
  }
  return { userId: identity.userId, sessionInstanceId: identity.sessionInstanceId };
}

/**
 * 捕捉手順（正本 §4）:
 *   1. 期待するuserId・sessionInstanceIdが非nullであること（呼び出し元が
 *      `toExactAuthenticatedIdentity` で保証する型）。
 *   2. 捕捉前に、権威identityと完全一致することを表明する。
 *   3. 実際のSupabase SDKセッションを読む（ローカル状態の推測ではなく、SDKが
 *      保持しているセッションそのもの）。
 *   4. `session.user.id` を検証する。
 *   5. access_tokenからJWTの `session_id` を取り出し、期待する sessionInstanceId と
 *      完全一致することを検証する。
 *   6. access_tokenをメモリ上にだけ捕捉する。
 *   7. 捕捉直後にもう一度、権威identityと完全一致することを表明する。
 * いずれかを満たさない場合は `staleMessage` で例外を投げる（呼び出し元の既存の
 * stale判定契約とそのまま統合できるよう、メッセージは呼び出し元が指定する）。
 */
export async function captureAuthenticatedRequestSnapshot(
  identity: ExactAuthenticatedIdentity,
  options: { staleMessage: string }
): Promise<AuthenticatedRequestSnapshot> {
  const assertCurrent = (): void => {
    if (!isCurrentExactAuthenticatedIdentity(identity)) {
      throw new Error(options.staleMessage);
    }
  };
  assertCurrent();
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) {
    throw new Error(options.staleMessage);
  }
  const session = data.session;
  const sessionInstanceId = extractSessionIdFromAccessToken(session.access_token);
  if (session.user.id !== identity.userId || sessionInstanceId !== identity.sessionInstanceId) {
    throw new Error(options.staleMessage);
  }
  assertCurrent();
  return {
    userId: identity.userId,
    sessionInstanceId: identity.sessionInstanceId,
    accessToken: session.access_token,
  };
}

/**
 * `auth.accessToken` オプションでSupabaseClientを構成すると、SDK内部は `this.auth` を
 * 「アクセスすると必ず例外を投げるProxy」に差し替える（このクライアント上でauth APIを
 * 使えないことがコード上強制される）。`this.fetch`（`.from()`・`.rpc()` が使う）と
 * `this.functionsFetch`（`.functions.invoke()` が使う）はいずれも
 * `_getSessionToken()` 経由でこの `accessToken` コールバックを最優先するため、
 * ambient sessionへは一切フォールバックしない
 * （証跡: node_modules/@supabase/supabase-js の SupabaseClient — `functionsFetch` は
 * `fetchWithAuth(supabaseKey, supabaseUrl, this._getSessionToken.bind(this), ...)`、
 * `get functions()` は `customFetch: this.functionsFetch` を渡す）。
 * つまり共有データへの各リクエストにpinnedな認可がそのまま効く。
 *
 * persistSession/autoRefreshTokenは無効化する（このクライアントは1回の論理的な
 * リモート試行の間だけ存在する使い捨てで、AsyncStorageへの二重書込み・
 * バックグラウンドでのトークン更新を一切必要としない）。
 */
export function createPinnedAuthenticatedClient(
  auth: AuthenticatedRequestSnapshot
): SupabaseClient {
  return createClient(pinnedClientSupabaseUrl, pinnedClientSupabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    accessToken: async () => auth.accessToken,
  });
}
