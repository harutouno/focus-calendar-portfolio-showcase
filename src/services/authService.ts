import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import { isSupabaseConfigured, supabase } from "@/lib/supabaseClient";
import { getCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";
import {
  captureAuthenticatedRequestSnapshot,
  createPinnedAuthenticatedClient,
  toExactAuthenticatedIdentity,
} from "@/auth/authenticatedRequestSnapshot";

/**
 * Supabase Authまわりのサービス層。AuthContext.tsx・app/auth/callback.tsxが
 * @/lib/supabaseClient を直接importしていた箇所をここへ集約する
 * （画面・状態管理からSupabaseへの直接依存をゼロにするため）。
 * 挙動・エラー文言はAuthContext.tsxに元々あったものと完全に同一のまま移設している。
 *
 * 2026-08: Google/Appleネイティブサインインを追加。どちらもSupabaseの
 * `signInWithIdToken()`でセッションを作る点は共通のため、メール・Google・Apple
 * いずれのログイン後処理（プロフィール補完 = ensureProfile）も1つの関数に集約し、
 * 認証方式ごとに重複実装しない。
 */

export { isSupabaseConfigured };

const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const GOOGLE_ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;

/**
 * Googleネイティブサインインに必要な設定が、現在の実行プラットフォームで揃っているか。
 * iOS・Android・Webを同じ運用方針で扱う：
 * - Webクライアントは全プラットフォーム共通で必須（IDトークンの発行元）。
 * - iOSはさらにiOSクライアントID（app.config.tsのURL Scheme導出に使用）が必要。
 * - Androidはさらに（コード上は参照しないが）Androidクライアント用の環境変数が
 *   入力済みであることを「Android向け設定が完了している」の判定に使う。
 * いずれか未設定の間、そのプラットフォームではログインボタン自体を表示しない
 * （app/auth/sign-in.tsx側でこの値を使って非表示にする。無効化ではなく非表示）。
 */
export const isGoogleSignInConfigured =
  Boolean(GOOGLE_WEB_CLIENT_ID) &&
  (Platform.OS === "ios"
    ? Boolean(GOOGLE_IOS_CLIENT_ID)
    : Platform.OS === "android"
      ? Boolean(GOOGLE_ANDROID_CLIENT_ID)
      : true);

const GENERIC_OAUTH_ERROR =
  "ログインに失敗しました。時間をおいて再度お試しください。";

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

/**
 * 戻り値の関数を呼ぶとunsubscribeする。
 * eventも渡す（AuthContext.tsxがSIGNED_IN時にensureProfile()を1回だけ呼ぶために使う。
 * 既存の呼び出し元はeventを受け取らなくても動くよう、コールバックの第1引数はsessionのまま）。
 */
export function onAuthStateChange(
  callback: (session: Session | null, event: AuthChangeEvent) => void
): () => void {
  const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
    callback(nextSession, event);
  });
  return () => subscription.subscription.unsubscribe();
}

/** メール内のリンクを開いた場合の戻り先URLを組み立てる（診断表示用にも使う）。 */
export function buildAuthCallbackRedirectUrl(returnTo?: string): string {
  return Linking.createURL("auth/callback", {
    queryParams: returnTo ? { returnTo } : undefined,
  });
}

/**
 * Magic Linkメールを送信する。returnToはログイン完了後に戻る画面のパス。
 * redirectToは実際にemailRedirectToへ渡した値（診断表示用。認証フロー自体には影響しない）。
 */
export async function signInWithMagicLink(
  email: string,
  returnTo?: string
): Promise<{ error?: string; redirectTo?: string }> {
  if (!isSupabaseConfigured) return { error: "Supabase未設定です" };
  // メール内のリンクを開いた場合の戻り先。未指定だとSupabase側のデフォルト
  // Site URL（localhostなど）に飛んで接続エラーになるため明示する。
  // Expo Go実行中は exp://... 、開発ビルド/本番では focuscalendar://... になる。
  const redirectTo = buildAuthCallbackRedirectUrl(returnTo);
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: redirectTo,
    },
  });
  return error ? { error: error.message, redirectTo } : { redirectTo };
}

let googleSignInConfigured = false;

/** GoogleSignin.configure()は複数回呼んでも害はないが、無駄な呼び出しを避けるため1回だけにする。 */
function ensureGoogleSignInConfigured(): void {
  if (googleSignInConfigured) return;
  GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    iosClientId: GOOGLE_IOS_CLIENT_ID || undefined,
  });
  googleSignInConfigured = true;
}

/**
 * Googleのネイティブサインイン（@react-native-google-signin/google-signin）。
 * idTokenをSupabaseの signInWithIdToken() へ渡すだけで、Web版のOAuthリダイレクトは使わない
 * （ディープリンク・app/auth/callback.tsxを一切経由しない）。
 * ユーザーがキャンセルした場合は cancelled:true を返す（エラー表示しないための区別）。
 */
export async function signInWithGoogle(): Promise<{
  error?: string;
  cancelled?: boolean;
  session?: Session;
}> {
  if (!isSupabaseConfigured) return { error: "Supabase未設定です" };
  if (!isGoogleSignInConfigured) return { error: "Googleログインの設定が完了していません" };
  try {
    ensureGoogleSignInConfigured();
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      return { cancelled: true };
    }
    const idToken = response.data.idToken;
    if (!idToken) {
      return { error: GENERIC_OAUTH_ERROR };
    }
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: "google",
      token: idToken,
    });
    if (error) return { error: GENERIC_OAUTH_ERROR };
    // P0047(C18): この呼び出し自身が確立した正確なSessionをそのまま返す
    // （後からgetSession()等で改めて推測しない）。
    return data.session ? { session: data.session } : { error: GENERIC_OAUTH_ERROR };
  } catch (e) {
    if (isErrorWithCode(e) && e.code === statusCodes.SIGN_IN_CANCELLED) {
      return { cancelled: true };
    }
    return { error: GENERIC_OAUTH_ERROR };
  }
}

/**
 * この端末でApple Sign-Inボタンを表示してよいか（iOSかつOSがネイティブ機能を
 * サポートしている場合のみtrue）。Androidでは常にfalse。
 * app/auth/sign-in.tsx側でこの値を使ってボタンを非表示にする（無効化ではなく非表示）。
 * isAvailableAsync()自体が失敗した場合も安全側でfalseを返す。
 */
export async function isAppleSignInAvailableAsync(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Appleのネイティブサインイン（expo-apple-authentication、iOS専用）。
 * リプレイ攻撃対策として、ランダムなrawNonceを生成しSHA256でハッシュ化した値をAppleへ渡し、
 * Supabase側にはrawNonceをそのまま渡す（identityToken内のnonceハッシュとSupabase側で照合される）。
 * 氏名はApple側の仕様で初回認証時にしか返らないため、取得できた場合だけこの場で
 * user_metadataへ書き込む（以後のensureProfile()が「まだ既定値のときだけ」補完に使う）。
 * ユーザーがキャンセルした場合（ERR_REQUEST_CANCELED）は cancelled:true を返す。
 */
export async function signInWithApple(): Promise<{
  error?: string;
  cancelled?: boolean;
  session?: Session;
}> {
  if (!isSupabaseConfigured) return { error: "Supabase未設定です" };
  try {
    const rawNonce = Crypto.randomUUID();
    const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
    if (!credential.identityToken) {
      return { error: GENERIC_OAUTH_ERROR };
    }
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: "apple",
      token: credential.identityToken,
      nonce: rawNonce,
    });
    if (error) return { error: GENERIC_OAUTH_ERROR };
    if (!data.session) return { error: GENERIC_OAUTH_ERROR };

    const fullName = [credential.fullName?.givenName, credential.fullName?.familyName]
      .filter((part): part is string => !!part)
      .join(" ");
    if (fullName) {
      // 失敗してもログイン自体は成立しているため、エラーをここで表に出さない。
      await supabase.auth.updateUser({ data: { full_name: fullName } }).catch(() => undefined);
    }
    // P0047(C18): この呼び出し自身が確立した正確なSessionをそのまま返す。
    return { session: data.session };
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ERR_REQUEST_CANCELED") {
      return { cancelled: true };
    }
    return { error: GENERIC_OAUTH_ERROR };
  }
}

/** このアプリが認識する認証プロバイダーの識別子。Supabase側の文字列表現と一致させる。 */
export type AuthProviderId = "email" | "google" | "apple";

function normalizeProviderId(provider: string): AuthProviderId | null {
  return provider === "email" || provider === "google" || provider === "apple"
    ? provider
    : null;
}

/**
 * 現在ログイン中のユーザーが「今回のセッションを開始した」認証プロバイダー。
 * 将来のIdentity Linking・アカウント管理画面（例:「Googleでログイン中」表示、
 * 「Appleも連携する」導線）向けに公開する。
 *
 * profilesテーブルへは保存しない設計にしている：
 * - Supabase Auth自身がuser.app_metadata.providerを常に最新の状態で管理しており、
 *   DBへ複製すると同期漏れ（自動リンク等でproviderが変わった場合に古い値が残る）の
 *   リスクがある。
 * - 「どの方式でログインしているか」は本人以外に見せる情報ではないため、他の
 *   カレンダーメンバーも読めるprofilesテーブルに置く必然性がない。
 * AuthContext.tsxが既にsession.userを認証状態の唯一の情報源として扱っているため、
 * それと同じ情報源（Supabaseの生のUserオブジェクト）からその場で導出するのが
 * 最も既存設計に自然な形になる。
 */
export function getCurrentAuthProvider(user: User): AuthProviderId | null {
  const provider = user.app_metadata?.provider;
  return provider ? normalizeProviderId(provider) : null;
}

/**
 * 現在このユーザーに紐づいている（Identity Linkingで連携済みの）認証プロバイダー一覧。
 * 将来「Googleが連携済み／Appleを追加で連携する」のようなアカウント管理UIを作る際に使う想定。
 * user.app_metadata.providersが無い/空の場合は、getCurrentAuthProvider()の値のみを返す
 * （未連携環境やテストダブルでの後方互換のため）。
 */
export function getLinkedAuthProviders(user: User): AuthProviderId[] {
  const providers = user.app_metadata?.providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    const current = getCurrentAuthProvider(user);
    return current ? [current] : [];
  }
  return providers.reduce<AuthProviderId[]>((acc, provider) => {
    const normalized = typeof provider === "string" ? normalizeProviderId(provider) : null;
    if (normalized && !acc.includes(normalized)) acc.push(normalized);
    return acc;
  }, []);
}

/**
 * ログイン方式（メール／Google／Apple）に関わらず、共通で呼ぶプロフィール補完処理。
 * Googleのプロフィール画像・表示名、Apple初回氏名（signInWithApple()がupdateUser()経由で
 * user_metadata.full_nameへ書き込み済み）を「初期値として一度だけ」補完する。
 * 認証方式ごとに判定ロジックを重複させない＝常にこの1関数を通す。
 *
 * 「絶対に上書きしない」を、以下の自己ブートストラップ方式（ratchet）で保証する
 * （display_name_customized_at / avatar_url_customized_at列、migration 0007参照）：
 *   1. customized_atが既に設定済みのフィールドは、内容に関わらず一切触らない。
 *   2. customized_atが未設定でも、値が既に既定値（display_name===email／avatar_urlがnull）
 *      でない場合は、上書きする代わりに今すぐcustomized_atを立てて以後を保護する
 *      （現時点にプロフィール編集画面は存在しないが、過去の手動操作や将来の編集機能を
 *      想定した安全側の判定）。これにより、初回のヒント適用の「次」の呼び出しで
 *      即座にロックされるため、「初期値として一度だけ設定」が自然に実現される。
 *   3. customized_atが未設定かつ値がまだ既定値の場合のみ、ヒントがあれば適用する
 *      （customized_atはこの時点では立てない＝ヒント自体は「編集」ではなく「初期値」のため）。
 * 失敗してもログイン自体には影響させない。
 */
const ENSURE_PROFILE_OWNER_AUTH_UNAVAILABLE = "ensure_profile_owner_auth_unavailable";

export async function ensureProfile(user: User): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    // P0154 (SEC-AUTH-TRANSPORT-001): `profiles` の SELECT / UPDATE はどちらも
    // RLS 上 `auth.uid() = id` で認可される identity-scoped な操作である。
    // read → 判定 → write が **1つのセッションに属する**ことを保証するため、
    // 認可は1回だけ捕捉し、両方の送出で同じ pinned client を使う。
    //
    // 呼び出し順序の前提（P0152 で確認済み）: passive `SIGNED_IN` も
    // 明示認証の成功経路も、`ensureProfile(user)` を呼ぶ前に
    // `setCurrentAuthIdentity(...)` で権威identityを公開している。したがって
    // ブートストラップ用の特例は作らない。
    //
    // 権威identityが `user.id` と一致しない／sessionInstanceId が無い／捕捉に失敗する
    // 場合は、**ベストエフォートのプロフィール補完を行わないだけ**でログインは失敗させない
    // （下の catch と同じ扱い。ambient PostgREST へのフォールバックは行わない）。
    const exactOwner = toExactAuthenticatedIdentity(getCurrentAuthIdentity());
    if (!exactOwner || exactOwner.userId !== user.id) return;
    const client = createPinnedAuthenticatedClient(
      await captureAuthenticatedRequestSnapshot(exactOwner, {
        staleMessage: ENSURE_PROFILE_OWNER_AUTH_UNAVAILABLE,
      })
    );

    const { data: profile, error } = await client
      .from("profiles")
      .select("display_name, avatar_url, display_name_customized_at, avatar_url_customized_at")
      .eq("id", user.id)
      .maybeSingle();
    if (error || !profile) return;

    const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
    const nameHint =
      (metadata.full_name as string | undefined) ?? (metadata.name as string | undefined);
    const avatarHint =
      (metadata.avatar_url as string | undefined) ?? (metadata.picture as string | undefined);

    const nowIso = new Date().toISOString();
    const updates: {
      display_name?: string;
      avatar_url?: string;
      display_name_customized_at?: string;
      avatar_url_customized_at?: string;
    } = {};

    if (!profile.display_name_customized_at) {
      const looksDefault = profile.display_name === user.email;
      if (!looksDefault) {
        updates.display_name_customized_at = nowIso;
      } else if (nameHint) {
        updates.display_name = nameHint;
      }
    }

    if (!profile.avatar_url_customized_at) {
      const looksDefault = !profile.avatar_url;
      if (!looksDefault) {
        updates.avatar_url_customized_at = nowIso;
      } else if (avatarHint) {
        updates.avatar_url = avatarHint;
      }
    }

    if (Object.keys(updates).length === 0) return;

    await client.from("profiles").update(updates).eq("id", user.id);
  } catch {
    // プロフィール補完の失敗はログイン自体を失敗させない。
  }
}

/**
 * P0047(C18): 成否をcallerへ必ず返す（catch-swallow禁止）。呼び出し元（AuthContextの
 * repair/fail-closedロジック）が、この結果に基づいて次のbounded actionを判断するため。
 */
export async function signOut(): Promise<boolean> {
  if (!isSupabaseConfigured) return true;
  try {
    const { error } = await supabase.auth.signOut();
    return !error;
  } catch {
    return false;
  }
}

/**
 * P0047(C18): 見捨てられた（superseded）attemptの遅延成功をAuthContextが拒否した後の
 * 訂正呼び出し。exchangeCodeForSession/signInWithIdTokenは、呼び出した時点でSupabase
 * SDK内部のcurrent session（および永続化されたstorage）をその結果へ書き換えてしまう。
 * これはAuthContext側がその結果の公開を拒否するかどうかとは無関係に起きるため、拒否した
 * だけでは「画面上の表示（React state）は直前のcurrentのまま」でも「SDK内部・永続化された
 * sessionは見捨てられた側のまま」というズレが残る（次回起動時に誤って巻き戻るおそれもある）。
 * 直前まで正しく公開していたsessionを使ってsetSession()で1回だけ訂正する
 * （ループしない・retryしない）。成否をcallerへ必ず返す（catch-swallow禁止）——
 * 呼び出し元は失敗時にfail-closedで未認証へ遷移する。
 */
export async function restoreSession(previous: Session): Promise<boolean> {
  try {
    const { error } = await supabase.auth.setSession({
      access_token: previous.access_token,
      refresh_token: previous.refresh_token,
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * app/auth/callback.tsxが受け取った?code=をセッションへ交換する。成功時は実際に
 * 確立された正確なSessionを返す（P0047: 後からgetSession()等で改めて推測しない）。
 */
export async function exchangeCodeForSession(
  code: string
): Promise<{ error?: string; session?: Session }> {
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return { error: error.message };
  return data.session ? { session: data.session } : { error: "セッションを確立できませんでした" };
}
