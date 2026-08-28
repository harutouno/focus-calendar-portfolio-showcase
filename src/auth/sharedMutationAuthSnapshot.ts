import { SupabaseClient } from "@supabase/supabase-js";
import {
  captureAuthenticatedRequestSnapshot,
  createPinnedAuthenticatedClient,
} from "@/auth/authenticatedRequestSnapshot";
import {
  SharedMutationIdentity,
  STALE_SHARED_MUTATION_IDENTITY_MESSAGE,
  assertCurrentSharedMutationIdentity,
} from "@/auth/sharedMutationIdentity";

/**
 * [P0080 AUTH-F013-F017-001] インストール済み@supabase/supabase-js（2.110.8）の
 * `SupabaseClient._getSessionToken()`は、fetch実行のたびに`this.accessToken`
 * （未設定ならambient session）を読み直す実装になっている（証跡:
 * node_modules/@supabase/supabase-js/src/SupabaseClient.ts）。つまり、共有予定の
 * mutation/readback（upsertSharedEvent・F014 CAS RPC・CAS再照会read・deleteSharedEvent・
 * bulk upsert・bulk delete）がグローバルな`supabase`クライアントをそのまま使う限り、
 *
 *   ローカルidentity確認A → awaitで生じる境界 → 認証がBへ切替 → 実際のHTTPリクエストは
 *   その時点のambient session（B）のJWTを積む
 *
 * という、request-levelのTOCTOUが起こりうる。本モジュールは、1つの論理的な共有mutation
 * attemptの開始時点で1回だけ
 * access_tokenを捕捉し、その後は（同じattempt内の複数回の呼び出しであっても）
 * 一切読み直さない、request-scopedなSupabaseClientを提供する。
 *
 * トークンはメモリ上でのみ受け渡し、AsyncStorage/SecureStore/同期キューレコード/
 * ログ/エラー/evidenceのいずれにも書き込まない（呼び出し元はSharedMutationAuthSnapshot
 * オブジェクト自体を永続化・ログ出力してはならない）。
 *
 * P0150 (SEC-F007-007): 実装本体を機能横断の共通プリミティブ
 * `src/auth/authenticatedRequestSnapshot.ts` へ移し、本モジュールはそこへ委譲する
 * 薄いラッパになった。**公開API・引数・戻り値・例外メッセージ
 * （STALE_SHARED_MUTATION_IDENTITY_MESSAGE）・捕捉手順の意味論はいずれも変更していない**
 * （正本 §4: 既存の受理済み共有mutationを名前の整理のために不安定化させない）。
 */
export interface SharedMutationAuthSnapshot extends SharedMutationIdentity {
  accessToken: string;
}

/**
 * 捕捉手順（正本§2の1〜7）:
 *   1. 既存のSharedMutationIdentityから開始する。
 *   2. この捕捉のためだけに、現在のSupabase認証セッションを正確に読む
 *      （ambientな`supabase`クライアントのauth.getSession()——ローカル状態の
 *      推測ではなく、SDKが保持する実際のセッションそのもの）。
 *   3. セッションのuser.id === identity.userIdであることを要求する。
 *   4. ローカルsessionInstanceId（権威あるauthSessionIdentityStore経由）が
 *      まだ一致することを要求する。
 *   5. access_tokenを捕捉する。
 *   6. 捕捉直後にもう一度ローカルidentityを再確認する。
 *   7. 捕捉後は、この論理的なremote attempt内でトークンを一切差し替えない
 *      （呼び出し元は同じSharedMutationAuthSnapshotを使い回す）。
 * いずれかの条件を満たさない場合は、通常のstale専用メッセージで例外を投げる
 * （呼び出し元の既存isStaleMutationError契約とそのまま統合される）。
 *
 * P0150: 手順2〜7は `captureAuthenticatedRequestSnapshot` が同じ順序・同じ判定で行う。
 * 手順1（開始前のassert）は、共有mutation固有の判定関数
 * `assertCurrentSharedMutationIdentity` をそのまま使い続ける（権威・メッセージともに同一）。
 */
export async function captureSharedMutationAuthSnapshot(
  identity: SharedMutationIdentity
): Promise<SharedMutationAuthSnapshot> {
  assertCurrentSharedMutationIdentity(identity);
  const snapshot = await captureAuthenticatedRequestSnapshot(identity, {
    staleMessage: STALE_SHARED_MUTATION_IDENTITY_MESSAGE,
  });
  return {
    userId: snapshot.userId,
    sessionInstanceId: snapshot.sessionInstanceId,
    accessToken: snapshot.accessToken,
  };
}

/**
 * `auth.accessToken`オプションでSupabaseClientを構成すると、SDK内部は
 * `this.auth`を「アクセスすると必ず例外を投げるProxy」に差し替える（正本§3の
 * 「no auth API usage on the scoped client」を、この請け負いクライアント自身が
 * コード上強制する形になる——証跡: SupabaseClient.tsのコンストラクタ）。
 * `this.fetch`（`.from()`・`.rpc()`が使う）は`_getSessionToken()`経由でこの
 * `accessToken`コールバックを最優先するため、ambient sessionへは一切フォールバック
 * しない。プロジェクトURL/anon keyはグローバルクライアントと同一のものを使う。
 * persistSession/autoRefreshTokenは無効化する（このクライアントは1回の論理的な
 * remote attemptの間だけ存在する使い捨てであり、AsyncStorageへの二重書込み・
 * バックグラウンドでのトークン更新を一切必要としない）。
 */
export function createPinnedSharedClient(auth: SharedMutationAuthSnapshot): SupabaseClient {
  return createPinnedAuthenticatedClient(auth);
}

/**
 * P0154 (SEC-AUTH-TRANSPORT-001): **1回のリモート送出に対して、正確な所有者へ pin された
 * クライアントを用意して実行する**ための唯一の入口。
 *
 * 根本原因（正本 §0）:
 *
 * ```text
 * ローカルのidentityチェック != HTTP/Storage の認可identity
 * ```
 *
 * `.rpc()` だけでなく **PostgREST（`.from().insert/update/upsert/delete()`）と
 * Storage（`.upload()/.remove()`）も** 同じ `_getSessionToken()` を通る。したがって
 * 「送出の瞬間に ambient セッションを読み直す」経路は transport の種類を問わず
 * すべて request-level TOCTOU を持つ。
 *
 * 本ヘルパを使うと、呼び出し側は「捕捉を忘れる」ことが構造的にできない
 * （pinned クライアントは `send` の引数としてしか手に入らない）。
 * 捕捉に失敗した場合（identityが既に変わっている・SDKセッション不一致など）は
 * `captureSharedMutationAuthSnapshot` が stale 例外を投げ、**リモート送出は一切行われない**
 * （fail-closed）。
 *
 * 複数のリモート送出を含む1つの論理操作では、本ヘルパを送出ごとに呼ばず、
 * `captureSharedMutationAuthSnapshot` を1回だけ呼んで
 * `createPinnedSharedClient` の戻り値を操作全体で共有すること（正本 §3）。
 */
export async function withPinnedSharedClient<T>(
  identity: SharedMutationIdentity,
  // PostgREST/Storage のビルダーは Promise ではなく PromiseLike（thenable）を返すため、
  // `client.from(...).update(...)` をそのまま返せるよう PromiseLike で受ける。
  send: (client: SupabaseClient) => PromiseLike<T>
): Promise<T> {
  const auth = await captureSharedMutationAuthSnapshot(identity);
  return send(createPinnedSharedClient(auth));
}
