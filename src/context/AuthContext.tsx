import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import * as authService from "@/services/authService";
import type { AuthProviderId } from "@/services/authService";
import { extractSessionIdFromAccessToken } from "@/utils/jwt";
import { setCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";

const { isSupabaseConfigured, isGoogleSignInConfigured } = authService;

/**
 * P0047(C18): 明示的なサインイン試行を一意に識別するtoken。単調増加のカウンタで、
 * beginExplicitAuthAttempt()が新しいtokenを発行するたびに、それ以前の全てのtokenは
 * 「自分自身が最終的にどう完了するか（成功／キャンセル／エラー）に関わらず」永久に
 * supersededになる。
 */
export type AuthAttemptToken = number;

/** completeExplicitAuthAttempt()へ渡す、その試行の最終結果。 */
export type AuthAttemptOutcome =
  | { type: "success"; session: Session }
  | { type: "cancelled" }
  | { type: "error" };

/**
 * P0048(C18): completeExplicitAuthAttempt()の戻り値。"accepted"はこのtokenが
 * latestのまま、かつSDK session reconciliationがこのidentity世代へ収束したことまで
 * 保証する（画面側の成功遷移はこれだけをsuccess authorityとして扱う）。"stale"は
 * このtoken（またはそのreconcile要求）が既にsupersededだったことを表す。
 * "failed-closed"はlatestではあったがSDK reconciliationが失敗し、fail-closedで
 * 未認証へ落ちたことを表す——isLatestAuthAttempt(token)だけでは検出できない
 * ケースのため、画面側はこの値でsuccess UIの可否を判定する。
 */
export type AuthAttemptCompletionDisposition = "accepted" | "stale" | "failed-closed";

interface AuthContextValue {
  /** Supabaseの.env設定が済んでいるか（未設定でも個人利用は可能） */
  isSupabaseConfigured: boolean;
  /** Googleネイティブサインインに必要な設定が、現在の実行プラットフォームで揃っているか（未設定ならボタンを非表示にする） */
  isGoogleSignInConfigured: boolean;
  /** この端末でApple Sign-Inボタンを表示してよいか（iOSかつOSがサポートしている場合のみtrue）。Androidでは常にfalse。 */
  isAppleSignInAvailableAsync: () => Promise<boolean>;
  loading: boolean;
  session: Session | null;
  user: User | null;
  /**
   * SEC-F007-001: SupabaseアクセストークンのJWTから取り出した`session_id` claim。
   * `user.id`が同じでも認証セッション自体が置き換わった場合（同一アカウントへの再ログイン等）を
   * 区別するために使う（AppDataContextの共有state所有者判定の一部）。
   * 未ログイン時、またはセッションはあってもsession_idを取得できない異常な状態ではnull。
   * ローカルの状態分離用識別子としてのみ使い、サーバー側の認可判断の代用にはしない
   * （認可は引き続きRLSを正本とする）。
   */
  sessionInstanceId: string | null;
  /**
   * 現在のセッションを開始した認証プロバイダー。未ログイン時はnull。
   * 将来のIdentity Linking・アカウント管理画面（「Googleでログイン中」表示等）向けに公開する。
   */
  currentAuthProvider: AuthProviderId | null;
  /** 現在のユーザーに連携済みの認証プロバイダー一覧。未ログイン時は空配列。 */
  linkedAuthProviders: AuthProviderId[];
  /**
   * Magic Linkメールを送信する。returnToはログイン完了後に戻る画面のパス。
   * redirectToは実際にemailRedirectToへ渡した値（診断表示用。認証フロー自体には影響しない）。
   */
  signInWithMagicLink: (
    email: string,
    returnTo?: string
  ) => Promise<{ error?: string; redirectTo?: string }>;
  /**
   * Googleのネイティブサインイン。キャンセル時はcancelled:trueを返す（エラー表示しないため）。
   * 成功時は実際に確立されたSessionをsessionとして返す（P0047: 呼び出し元がこの
   * 正確なSessionをcompleteExplicitAuthAttempt()へそのまま渡すため。後から
   * getSession()等で改めて推測しない＝並行して他のattemptがSDK状態を書き換えていても
   * 誤ったsessionを拾わない）。
   */
  signInWithGoogle: () => Promise<{ error?: string; cancelled?: boolean; session?: Session }>;
  /** Appleのネイティブサインイン（iOS専用）。キャンセル時はcancelled:trueを返す。成功時はsessionを返す。 */
  signInWithApple: () => Promise<{ error?: string; cancelled?: boolean; session?: Session }>;
  /**
   * P0048(C18): pending中の明示的attemptがあれば、実際のSDK呼び出しを待たず
   * 呼び出し直後に同期的にsupersededにする（SIGNED_OUTイベント到着を待たない）。
   * ネットワークエラーで失敗しても、supersededにした事実は取り消さない。
   *
   * [P0120 Group B / SEC-F007-F008-017] 正常完了（resolve）は次の2条件が**両方**
   * 成立したことを意味する:
   *   (a) `authService.signOut()`がtrueを返した（SDK/ローカルsign-outの成功確認）
   *   (b) この呼び出しが束縛した可視identityが、まだcurrentであるならばログアウト済み
   * (a)を確認できない場合はrejectする（呼び出し元の既存の失敗Alert経路へ到達する）。
   */
  signOut: () => Promise<void>;
  /**
   * P0047(C18): 新しいサインイン試行（Google/Apple/Magic Linkのcallback等、セッションを
   * 確定させうる操作）を開始する直前に呼ぶ。呼ぶたびに、それ以前に発行した全てのtokenを
   * 「自分自身が最終的にどう完了するか（pending/成功/キャンセル/エラー）に関わらず」
   * 永久にsupersededにする。戻り値のtokenを保持しておき、画面側のUI副作用（遷移・
   * Alert等）の直前に isLatestAuthAttempt(token) で確認する。
   */
  beginExplicitAuthAttempt: () => AuthAttemptToken;
  /** tokenがbeginExplicitAuthAttempt()の戻り値のうち最新のものと一致するか（UI gate用）。 */
  isLatestAuthAttempt: (token: AuthAttemptToken) => boolean;
  /**
   * P0047(C18): session-producing呼び出し（signInWithGoogle/signInWithApple/
   * exchangeCodeForSession）の結果が確定した直後に、画面のmount状態に関わらず
   * 必ず1回呼ぶ（security/auth state machineの完了はUIのunmountで止めない）。
   * tokenがまだ最新の場合のみ、outcomeが成功ならexact Sessionをそのままidentityとして
   * 確定する。tokenが既にsupersededな場合は一切公開しない（stale attemptのSIGNED_IN/
   * ensureProfile/AppData初期化を防ぐ）。
   *
   * P0048(C18): SDK session（Supabase SDK内部のbearer session）の収束は、もはや
   * captureした1つのsessionへの単発repairではなく、component単位のsingle-flight
   * reconciliation coordinatorが「現在acceptedなAuthContext session」へ常に
   * 収束させ続ける（詳細はrunSdkReconcileLoop参照）。latestな成功はこの
   * coordinatorがそのidentity世代へ収束するまでPromiseを解決しない（画面側の
   * success遷移がSDK bearerとの整合を安全に前提できるようにするため）。
   * 戻り値のdispositionで判定する:
   * - "accepted": このtokenはlatestのままSDKもこのidentityへ収束した。
   * - "stale": このtoken（またはoutcome自体）は既にsupersededだった。
   * - "failed-closed": latestではあったがSDK reconciliationが失敗し、
   *   fail-closedで未認証へ落ちた（画面はsuccess UIを出してはならない）。
   */
  completeExplicitAuthAttempt: (
    token: AuthAttemptToken,
    outcome: AuthAttemptOutcome
  ) => Promise<AuthAttemptCompletionDisposition>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * SEC-F007-001 必須修正1: session・sessionInstanceIdを別々のuseStateにすると、
 * 片方だけが先に更新された不整合な中間状態が理論上生じうる。両方を1つのstateとして
 * 原子的に更新する（Reactは同一イベントハンドラ内の複数setStateをバッチ処理するため
 * 実害は薄いが、意図を明確にし、将来の変更でも不整合が生じない構造にする）。
 */
interface AuthState {
  loading: boolean;
  session: Session | null;
  sessionInstanceId: string | null;
}

function deriveAuthState(session: Session | null): Omit<AuthState, "loading"> {
  if (!session) return { session: null, sessionInstanceId: null };
  return { session, sessionInstanceId: extractSessionIdFromAccessToken(session.access_token) };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>({
    loading: isSupabaseConfigured,
    session: null,
    sessionInstanceId: null,
  });

  /**
   * REVISE対応（P1-1）: 起動時の`getSession()`と`onAuthStateChange()`は互いに独立した
   * 非同期経路のため、後から開始した`onAuthStateChange`の結果が先に公開された後、
   * 先に開始していた（がより遅く完了した）`getSession()`の結果がそれを上書きしてしまう
   * 競合があった。「最後に開始（発行）された結果だけを公開する」ためのrevisionカウンタを
   * 導入し、公開直前に「自分がまだ最新の発行分か」を確認してからでなければ
   * setCurrentAuthIdentity/setAuthStateのいずれも呼ばない（必須修正2の「同じ認証結果で
   * 両方を更新する」も、この1関数へ一元化することでそのまま維持する）。
   */
  const revisionRef = useRef(0);
  /** 直前に`authSessionIdentityStore`へ公開したidentity。同一identityの重複イベント
   *  （同一session_idでのTOKEN_REFRESHED連打等）では、識別子ストアへの再書込み自体を
   *  スキップする（`session`自体はaccess_token更新等のため毎回setAuthStateで更新する）。 */
  const lastPublishedIdentityRef = useRef<{ userId: string | null; sessionInstanceId: string | null }>({
    userId: null,
    sessionInstanceId: null,
  });
  /**
   * P0048(C18): 直近にacceptされたsessionそのもの（SDK reconciliation coordinatorの
   * "desired"の唯一の情報源。identityと違い、同一identityのTOKEN_REFRESHED等でも
   * 都度更新する）。
   */
  const currentSessionRef = useRef<Session | null>(null);

  /**
   * P0048(C18): 「acceptされたsession（currentSessionRef.current）」の世代番号。
   * acceptされた値がnullも含めて変わるたびに増える。SDK reconciliation coordinatorは
   * 各iterationの開始時にこの値をmyGenerationとして捕捉し、await後に値が変わって
   * いれば（＝自分がawaitしている間に別のacceptが割り込んだ）その結果を
   * final authorityとして扱わずrerunする——captured-session方式の後勝ちレースを
   * 構造的に防ぐ。
   */
  const acceptedSessionGenerationRef = useRef(0);
  /** SDK reconciliation coordinatorがsingle-flightで動作中かどうか。 */
  const sdkReconcileInFlightRef = useRef(false);
  /** 実行中のiteration完了後にもう1周必要という要求フラグ（single-flightのjoin用）。 */
  const sdkReconcileRerunRef = useRef(false);
  /**
   * 特定のgeneration（自分がacceptした世代）への収束を待っているcaller一覧。
   * completeExplicitAuthAttempt()のlatest成功branchだけがこれを使う
   * （stale branchはfire-and-forgetで待たない）。
   */
  const sdkReconcileWaitersRef = useRef<
    {
      generation: number;
      resolve: (disposition: AuthAttemptCompletionDisposition) => void;
    }[]
  >([]);

  /**
   * P0047(C18): 明示的なサインイン試行のtoken世代管理。
   * beginExplicitAuthAttempt()を呼ぶたびに増える単調カウンタで、値が0の間は
   * 「このセッションでまだ一度も明示的な試行が始まっていない」ことを表す
   * （コールドスタートのセッション復元をpassive経路が無条件に受け入れてよい唯一の窓）。
   * 一度でも増えたら最後、それ以前のtokenは自分自身の最終結果（pending/成功/
   * キャンセル/エラー）に関わらず永久にsupersededになる（P1固定: 「N+1が始まった
   * 時点でN以下は永久に無効」という単純な単調比較のみで表現し、P0046のような
   * 「直前の1回との等値判定」に頼らない）。
   */
  const latestAttemptTokenRef = useRef<AuthAttemptToken>(0);

  /**
   * [P0122 / SEC-F007-F008-018] 現在実行中（未解決）の明示ログアウト呼び出しが束縛した
   * identity世代の一覧。signOut()の入口でpushし、（stale時はSDK収束のawait完了後に）
   * finallyで取り除く。
   *
   * これが必要な理由: `authService.signOut()`はSupabase SDKの**グローバルな**current
   * sessionを消す。Aのログアウトがawaitしている間にBがログインすると、Aの呼び出しは
   * supersededになるが、Aが起こしたSDK側のSIGNED_OUTイベントは後から到着しうる。
   * その遅延イベントをpassive経路が素直に受理すると、**より新しいB**の可視identityを
   * nullへ倒してしまう（P0121指摘(b)）。
   *
   * 「束縛世代 < 現在acceptされている世代」の呼び出しが未解決で残っている間に届いた
   * SIGNED_OUT方向のpassiveイベントだけを、その古いログアウトに帰属するものとして
   * 受理しない。**SIGNED_OUTを一律に無視するのではない**——superseded な明示ログアウトが
   * 1つも未解決でなければ、passive SIGNED_OUTは従来どおり正当なログアウトとして扱う。
   * 判定は必ず世代で行い、userIdの一致では行わない（同一ユーザーの新sessionを
   * 見分けられないため）。
   */
  const outstandingSignOutGenerationsRef = useRef<number[]>([]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setCurrentAuthIdentity({ userId: null, sessionInstanceId: null });
      setAuthState({ loading: false, session: null, sessionInstanceId: null });
      return;
    }
    let active = true;

    /**
     * 「明示的なattemptを経由しない」受動的な結果（起動時getSession()の復元、
     * TOKEN_REFRESHED、SIGNED_OUT等）だけを扱う。identityが変わる非null方向の
     * 遷移は、latestAttemptTokenRef.currentが0（＝一度も明示的なattemptが
     * 始まっていない）の間しか受け入れない。一度でも明示的なattemptが始まって以降、
     * 実際のidentity確定は必ずcompleteExplicitAuthAttempt()（呼び出し自身のPromise結果
     * から得た正確なSession）だけを正本とする——onAuthStateChangeにはtokenが無いため、
     * event単体からorigin attemptを推測しない。
     * 戻り値はこの呼び出しが実際にidentityを公開したか（ensureProfile要否の判定用）。
     */
    function publishPassiveResult(nextSession: Session | null, myRevision: number): boolean {
      if (myRevision !== revisionRef.current) return false;
      const derived = deriveAuthState(nextSession);
      const nextUserId = nextSession?.user.id ?? null;
      const last = lastPublishedIdentityRef.current;
      const identityDiffers = last.userId !== nextUserId || last.sessionInstanceId !== derived.sessionInstanceId;
      if (identityDiffers) {
        if (nextUserId === null) {
          // [P0122 / SEC-F007-F008-018] このSIGNED_OUT方向のイベントが、既に
          // supersededになった明示ログアウト（＝より古い世代を束縛したままの
          // 未解決呼び出し）に帰属できる場合は受理しない。受理してしまうと、
          // Aのログアウトが起こしたSDKイベントで、後からログインしたBの可視
          // identityがnullへ倒れる。
          // 実際のSDK側の整合はA自身のstale branchがreconciliation coordinatorへ
          // 収束を要求して回復させる（そこでrestoreSessionが失敗すれば既存の
          // fail-closed経路がidentityをnullへ倒す）。
          const supersededSignOutInFlight = outstandingSignOutGenerationsRef.current.some(
            (boundGeneration) => boundGeneration < acceptedSessionGenerationRef.current
          );
          if (supersededSignOutInFlight) {
            return false;
          }
          // サインアウト方向は常に受け入れる。同時に、まだ結果を待っている
          // pending中の明示的attemptがあればそれも即座にsupersededにする
          // （P0047 section10: logoutはpending attemptをsupersedeする）。
          latestAttemptTokenRef.current += 1;
        } else if (latestAttemptTokenRef.current !== 0) {
          // 一度でも明示的attemptが始まった後の、identityが異なる非nullの
          // passiveイベントは一切信用しない（実際の確定はcompleteExplicitAuthAttempt
          // 側でexact Sessionを使って行う）。
          return false;
        }
        lastPublishedIdentityRef.current = { userId: nextUserId, sessionInstanceId: derived.sessionInstanceId };
        // SEC-F007-001 必須修正2: React state（setAuthState）を公開する前に、
        // React外の同期ストアを先に更新する（通知coordinator等がEffectの実行を待たずに
        // 最新の所有者を判定できるようにするため）。
        setCurrentAuthIdentity({ userId: nextUserId, sessionInstanceId: derived.sessionInstanceId });
        // P0048(C18): acceptされたsessionが（nullも含めて）変わった。SDK reconciliation
        // coordinatorが現在in-flightでawait中なら、この変化をawait後に検知してrerunできる
        // よう世代を進める（新たにreconcileを起動する必要はない——SDKは既にこのイベントの
        // 発生源であり収束済みのため。in-flightな古いreconcileだけがこの世代更新を必要とする）。
        acceptedSessionGenerationRef.current += 1;
      }
      currentSessionRef.current = nextSession;
      setAuthState({ loading: false, ...derived });
      return true;
    }

    const mySessionRevision = ++revisionRef.current;
    authService.getSession().then((nextSession) => {
      if (!active) return;
      publishPassiveResult(nextSession, mySessionRevision);
    });
    const unsubscribe = authService.onAuthStateChange((nextSession, event) => {
      const myRevision = ++revisionRef.current;
      const accepted = publishPassiveResult(nextSession, myRevision);
      // SIGNED_INのときだけensureProfile()を呼ぶ（メール・Google・Apple共通の1箇所）。
      // 実際に公開されたイベントに対してのみ呼ぶ（stale/拒否されたイベントでは呼ばない）。
      if (accepted && event === "SIGNED_IN" && nextSession?.user) {
        void authService.ensureProfile(nextSession.user);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const beginExplicitAuthAttempt = useCallback((): AuthAttemptToken => {
    return ++latestAttemptTokenRef.current;
  }, []);

  const isLatestAuthAttempt = useCallback((token: AuthAttemptToken): boolean => {
    return token === latestAttemptTokenRef.current;
  }, []);

  /**
   * P0048(C18): sdkReconcileWaitersRef上の待機者のうち `generation <= settledGeneration`
   * のものを全て解決する。settledGeneration自身より古い世代を待っていた者は、
   * settledGenerationという「より新しい」acceptに追い越されたので"stale"、
   * settledGenerationそのものを待っていた者はこのiterationの実際のoutcomeを返す。
   */
  const settleSdkReconcileWaiters = useCallback(
    (settledGeneration: number, outcome: "converged" | "failed-closed"): void => {
      const remaining: typeof sdkReconcileWaitersRef.current = [];
      for (const waiter of sdkReconcileWaitersRef.current) {
        if (waiter.generation <= settledGeneration) {
          waiter.resolve(
            waiter.generation < settledGeneration
              ? "stale"
              : outcome === "converged"
                ? "accepted"
                : "failed-closed"
          );
        } else {
          remaining.push(waiter);
        }
      }
      sdkReconcileWaitersRef.current = remaining;
    },
    []
  );

  /**
   * P0048(C18): SDK session reconciliation coordinator本体。single-flight。
   * authority = 「現在acceptedなAuthContext session」(currentSessionRef.current)。
   * 各iterationの開始時に毎回最新のdesiredを読み直す（開始時に1回だけcaptureしない）。
   * await中にacceptされた世代が変わっていたら、そのiterationの結果を最終権威として
   * 扱わずrerunする——captured-session方式の「古いrepairが新しいacceptを後から
   * 上書きする」レースを構造的に防ぐ（P0048 section1/2）。
   */
  const runSdkReconcileLoop = useCallback(async (): Promise<void> => {
    if (sdkReconcileInFlightRef.current) {
      sdkReconcileRerunRef.current = true;
      return;
    }
    sdkReconcileInFlightRef.current = true;
    try {
      for (;;) {
        sdkReconcileRerunRef.current = false;
        const myGeneration = acceptedSessionGenerationRef.current;
        const desired = currentSessionRef.current;
        const ok = desired
          ? await authService.restoreSession(desired)
          : await authService.signOut();

        if (acceptedSessionGenerationRef.current !== myGeneration) {
          // awaitの間に別のacceptが割り込んだ。このiterationの結果はもう
          // myGenerationに対するfinal authorityではない（成功していてもfail-closed
          // 対象にもしない）。最新desiredを対象に再度iterationする。
          continue;
        }

        if (ok) {
          settleSdkReconcileWaiters(myGeneration, "converged");
        } else if (desired) {
          // まだ同じ世代のままrestoreSession(desired)が失敗した＝
          // still-current世代に対する実際の失敗。fail-closed（1回だけ、ローカルを
          // 先にnullへ確定してから）。直後のiterationが自動的にbounded signOut()を
          // 1回だけ試みる（下のbreak判定がgeneration変化を検知して継続するため）。
          lastPublishedIdentityRef.current = { userId: null, sessionInstanceId: null };
          currentSessionRef.current = null;
          acceptedSessionGenerationRef.current = myGeneration + 1;
          setCurrentAuthIdentity({ userId: null, sessionInstanceId: null });
          setAuthState({ loading: false, session: null, sessionInstanceId: null });
          settleSdkReconcileWaiters(myGeneration, "failed-closed");
        } else {
          // desiredが既にnullの状態でのbounded signOut()自体が失敗した。
          // ローカル状態は既にnullで変化がないため、これ以上訂正を試みない
          // （無制限retryを作らない）。
          settleSdkReconcileWaiters(myGeneration, "failed-closed");
        }

        if (!sdkReconcileRerunRef.current && acceptedSessionGenerationRef.current === myGeneration) {
          break;
        }
      }
    } finally {
      sdkReconcileInFlightRef.current = false;
    }
    // 抜けた直後にまだ未解決の待機者やrerun要求が残っていれば（理論上の取りこぼし
    // 防止の保険）、もう一周する。
    if (sdkReconcileRerunRef.current || sdkReconcileWaitersRef.current.length > 0) {
      void runSdkReconcileLoop();
    }
  }, [settleSdkReconcileWaiters]);

  /** stale completionからのfire-and-forgetキック。呼び出し元は結果を待たない。 */
  const requestSdkReconciliation = useCallback((): void => {
    void runSdkReconcileLoop();
  }, [runSdkReconcileLoop]);

  /**
   * latest success completionが、自分がacceptしたgenerationへSDKが実際に収束する
   * （またはfail-closedする）まで待つためのAPI。
   */
  const requestSdkReconciliationForGeneration = useCallback(
    (generation: number): Promise<AuthAttemptCompletionDisposition> => {
      return new Promise((resolve) => {
        sdkReconcileWaitersRef.current.push({ generation, resolve });
        void runSdkReconcileLoop();
      });
    },
    [runSdkReconcileLoop]
  );

  const completeExplicitAuthAttempt = useCallback(
    async (
      token: AuthAttemptToken,
      outcome: AuthAttemptOutcome
    ): Promise<AuthAttemptCompletionDisposition> => {
      if (outcome.type !== "success") {
        return token === latestAttemptTokenRef.current ? "accepted" : "stale";
      }
      if (token !== latestAttemptTokenRef.current) {
        // 見捨てられた（supersededな）試行の遅延成功。identityは一切公開しない。
        // ただしこの呼び出し自身（signInWithIdToken/exchangeCodeForSession）が、
        // AuthContext側の判断とは無関係にSupabase SDK内部のcurrent sessionを
        // outcome.sessionへ既に書き換えてしまっている可能性があるため、単発の
        // captured-session repairではなく、single-flight coordinatorへ「その瞬間の
        // 最新acceptedへ収束させる」よう要求するだけに留める（P0048 section5）。
        // ここではcoordinatorの結果を待たない（stale側のUIは何も変わらないため）。
        requestSdkReconciliation();
        return "stale";
      }
      // latest attemptの正当な成功。呼び出し自身が返した正確なSessionをそのまま
      // 確定する（後からgetSession()等で改めて推測しない）。
      const derived = deriveAuthState(outcome.session);
      const nextUserId = outcome.session.user.id;
      lastPublishedIdentityRef.current = { userId: nextUserId, sessionInstanceId: derived.sessionInstanceId };
      currentSessionRef.current = outcome.session;
      // 以後、この確定より前に発行されていた古いgetSession()/onAuthStateChangeの
      // 結果が後から解決しても上書きできないようにする（既存のrevisionRef保護を再利用）。
      revisionRef.current += 1;
      const myGeneration = ++acceptedSessionGenerationRef.current;
      setCurrentAuthIdentity({ userId: nextUserId, sessionInstanceId: derived.sessionInstanceId });
      setAuthState({ loading: false, ...derived });
      void authService.ensureProfile(outcome.session.user);
      // P0048(C18): SDKがこのgenerationへ実際に収束する（またはfail-closedする）まで
      // 待ってから戻る。並行するstale attemptのrepairが後勝ちでbearerを書き換えて
      // いても、coordinatorがそれを検知してこのgenerationへ再収束させる。
      const disposition = await requestSdkReconciliationForGeneration(myGeneration);
      if (disposition !== "accepted") {
        return disposition;
      }
      // P0049(C18): 「SDKがこのgenerationへ収束したこと」と「このtokenが今なお
      // 最新のexplicit auth intentであること」は別条件——root invariant
      // （N+1が始まった時点でN以下は永久にsuperseded）はNがreconciliation待ちへ
      // 入った後も変わらない。await中にnewer attemptが始まっている、または
      // 成功していてもこのtokenにはもはやsuccess completion/UI authorityを渡さない。
      // このtoken再確認からreturnまでは一切awaitを挟まない（間に他のattemptの
      // 完了処理が割り込む余地をなくすため）。
      // published identity（D）自体はここでnull等に戻さない——剥奪するのは
      // このtokenの完了が持つUI authorityだけで、Dはcurrent accepted sessionとして
      // 残る（supersedeしたEが後でcancel/errorなら、Dがcurrentのままでよい）。
      return token === latestAttemptTokenRef.current ? "accepted" : "stale";
    },
    [requestSdkReconciliation, requestSdkReconciliationForGeneration]
  );

  const signInWithMagicLink = useCallback(
    (email: string, returnTo?: string) => authService.signInWithMagicLink(email, returnTo),
    []
  );

  const signInWithGoogle = useCallback(() => authService.signInWithGoogle(), []);

  const signInWithApple = useCallback(() => authService.signInWithApple(), []);

  const isAppleSignInAvailableAsync = useCallback(
    () => authService.isAppleSignInAvailableAsync(),
    []
  );

  const signOut = useCallback(async () => {
    // P0048(C18) P2: SIGNED_OUTイベント到着（passive経路でのsupersede）を待たず、
    // 呼び出し直後に同期的にpending中の明示的attemptをsupersededにする。
    // ネットワークエラーで実際のsignOut自体が失敗しても、この事実は取り消さない
    // （signOut()自身はcatch-swallowせずbooleanを返す実装のため、ここではtry/catch
    // 不要——投げることはない）。
    latestAttemptTokenRef.current += 1;
    // [P0120 Group B / SEC-F007-F008-017] この呼び出しが束縛するidentity世代。
    // await中に別のacceptが起きた場合（B login／同一ユーザーの新session／passive
    // SIGNED_OUT）は必ずこの世代が進むため、「自分が束縛したidentityがまだcurrentか」を
    // 世代比較1つで判定できる（userId一致だけでは同一ユーザーの新sessionを見分けられない）。
    const invocationGeneration = acceptedSessionGenerationRef.current;
    // [P0122 / SEC-F007-F008-018] この呼び出しがsupersededになった場合に、自分が
    // 起こしたSDK側のSIGNED_OUTでより新しいidentityがnullへ倒れるのを防ぐため、
    // 束縛世代を「未解決の明示ログアウト」として登録しておく（finallyで解除）。
    outstandingSignOutGenerationsRef.current.push(invocationGeneration);
    try {
      // 戻り値がfalse（未確認）であることと、例外で終わることを同じ「未確認」として扱う。
      // 例外をここで畳んでおかないと、staleness判定より前に外へ抜けてしまい、
      // superseded な呼び出しがBに対する誤った失敗として報告されうる。
      const remoteOk = await authService.signOut().catch(() => false);

      // [P0122 / SEC-F007-F008-018] stalenessを**成功・失敗の判定より先に**評価する。
      // P0120では `!remoteOk` のthrowが先にあったため、既にsupersededなAのログアウト失敗が
      // Bのログイン後のUIへ「ログアウトに失敗しました」として届きえた（P0121指摘(c)）。
      if (acceptedSessionGenerationRef.current !== invocationGeneration) {
        // この呼び出しが束縛したidentityは既にcurrentではない。
        // 1) UI権威を一切持たない——成功も失敗も報告しない（可視identityに触れない）。
        // 2) ただし単に return してはならない（P0121指摘(a)）。`authService.signOut()`は
        //    Supabase SDKの**グローバルな**current sessionと永続化storageを消しうるため、
        //    React側がBを表示したままSDK側だけログアウト済み、という乖離が残る。
        //    新しい並行機構を作らず、**既存のSDK reconciliation coordinator**へ
        //    「現在acceptされている世代へ収束する」ことを要求し、その完了まで待つ
        //    （restoreSessionが失敗した場合は、coordinator既存のfail-closedが
        //    可視identityをnullへ倒す）。
        //    収束を待っている間も本呼び出しはoutstandingに残るため、その間に届く
        //    遅延SIGNED_OUTはpassive側で受理されない。
        // 3) 待つか否かは「収束先があるか」で決める:
        //    - 現在acceptされているsessionが非null（＝Bのような新しいidentityがcurrent）:
        //      自分のグローバルsignOutがSDKからBを消した可能性があるため、**収束を待つ**。
        //      待っている間だけpassive SIGNED_OUT抑止が効いている必要があるので、awaitが必須。
        //    - 現在acceptされているsessionがnull（＝既にログアウト方向で一致している）:
        //      隠れた乖離は無い。coordinatorへ収束要求は出すが待たない
        //      （既存のstale success completionと同じfire-and-forget。desired=nullに対する
        //      boundedなsignOut()再試行はcoordinator側の既存契約に委ねる）。
        if (currentSessionRef.current !== null) {
          await requestSdkReconciliationForGeneration(acceptedSessionGenerationRef.current);
        } else {
          requestSdkReconciliation();
        }
        return;
      }

      if (!remoteOk) {
        // [P0120 Group B] SDK/ローカルsign-outの成功を確認できなかった（かつこの呼び出しは
        // まだcurrent）。P0119までは戻り値を捨てて常に正常完了していたため、実際にはSDK内部・
        // 永続化storageのsessionが残っているのに「ログアウトできた」と報告していた。
        // 成功として報告せず、呼び出し元（app/account.tsx）の既存の失敗経路
        // （account.signOutErrorTitle / signOutErrorFallback）へ到達させる。
        // 新しい文言・新しいdurable stateは一切追加しない。
        // pending explicit attemptのsupersedeは上で確定済みであり、ここでは取り消さない。
        throw new Error("sign_out_not_confirmed");
      }
      if (currentSessionRef.current === null) {
        // 束縛世代のまま、既に未ログイン（この呼び出し自体がログアウト状態でのno-op）。
        return;
      }
      // SDK/ローカルsign-outが確認でき、かつこの呼び出しの可視identityがまだcurrentである。
      // 明示ログアウトの完了は「可視identityがログアウト済み」までを含む契約のため、
      // passive SIGNED_OUTイベントの到着を待たずここで確定させる（forceLocal…と同じ手順）。
      lastPublishedIdentityRef.current = { userId: null, sessionInstanceId: null };
      currentSessionRef.current = null;
      acceptedSessionGenerationRef.current += 1;
      setCurrentAuthIdentity({ userId: null, sessionInstanceId: null });
      setAuthState({ loading: false, session: null, sessionInstanceId: null });
    } finally {
      const index = outstandingSignOutGenerationsRef.current.indexOf(invocationGeneration);
      if (index >= 0) {
        outstandingSignOutGenerationsRef.current.splice(index, 1);
      }
    }
  }, [requestSdkReconciliation, requestSdkReconciliationForGeneration]);
  const { loading, session, sessionInstanceId } = authState;
  const user = session?.user ?? null;
  const currentAuthProvider = useMemo(
    () => (user ? authService.getCurrentAuthProvider(user) : null),
    [user]
  );
  const linkedAuthProviders = useMemo(
    () => (user ? authService.getLinkedAuthProviders(user) : []),
    [user]
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      isSupabaseConfigured,
      isGoogleSignInConfigured,
      isAppleSignInAvailableAsync,
      loading,
      session,
      user,
      sessionInstanceId,
      currentAuthProvider,
      linkedAuthProviders,
      signInWithMagicLink,
      signInWithGoogle,
      signInWithApple,
      signOut,
      beginExplicitAuthAttempt,
      isLatestAuthAttempt,
      completeExplicitAuthAttempt,
    }),
    [
      loading,
      session,
      user,
      sessionInstanceId,
      currentAuthProvider,
      linkedAuthProviders,
      signInWithMagicLink,
      signInWithGoogle,
      signInWithApple,
      isAppleSignInAvailableAsync,
      signOut,
      beginExplicitAuthAttempt,
      isLatestAuthAttempt,
      completeExplicitAuthAttempt,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth は AuthProvider の内側で使ってください");
  }
  return ctx;
}

/** AuthProvider の外側では undefined を返すオプショナル版。 */
export function useAuthOptional(): AuthContextValue | undefined {
  return useContext(AuthContext);
}
