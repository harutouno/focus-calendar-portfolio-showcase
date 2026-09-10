import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { PremiumStatus } from "@/types/premium";
import { getServices } from "@/services/registry";
import { useAuthOptional } from "@/context/AuthContext";

/**
 * 単独実装(2026-08): 全クライアント機能が同じuser_entitlements由来のプレミアム状態を
 * 参照するための統合PremiumContext。判定自体は常にサーバー（premiumService経由の
 * get_my_premium_status、実体はmigration 0015）を正本とし、クライアントから送られる
 * isPremiumやplanは一切信用しない。開発用オーバーライドは表示専用の上乗せであり、
 * サーバー取得そのものは止めない（詳細はsetDevPremiumOverrideの説明を参照）。
 */
export type PremiumFetchStatus = "loading" | "ready" | "error";

interface PremiumContextValue {
  /** サーバー検証済み（またはDEVオーバーライド適用後）の表示用プラン。 */
  plan: PremiumStatus;
  /**
   * plan === "premium" のショートカット。未検証、または検証済みだった資格が
   * 期限切れと判明した場合はfalseになる。同一ユーザーの有効な検証済みpremiumが、
   * 一時的な取得失敗（status==="error"）だけでfalseへ落ちることはない。
   */
  isPremium: boolean;
  /**
   * "loading"=初回検証中（このユーザーをまだ一度も検証できていない）。
   * "ready"=最新の検証済み値を表示中。
   * "error"=直近の取得に失敗した（"ready"+freeとは区別する。再試行はrefresh()で行う）。
   */
  status: PremiumFetchStatus;
  expiresAt: string | null;
  /** 手動再試行・将来の購入完了後の即時反映用。過剰なポーリングの代わりに明示的に呼ぶ。 */
  refresh: () => Promise<void>;
  /** 開発専用のプレミアム状態切替。本番ビルドではpremiumService側が何もしない安全策になっている。 */
  setDevPremiumOverride: (status: PremiumStatus | null) => void;
  /** __DEV__かつ開発用オーバーライドが設定されている間だけtrue。UI側で識別表示するために公開する。 */
  isDevOverrideActive: boolean;
}

const PremiumContext = createContext<PremiumContextValue | null>(null);

/** verifiedUserRefの初期値。null（「未ログインとして検証済み」）と区別するための番人値。 */
const NOT_YET_VERIFIED = Symbol("not-yet-verified");

export function PremiumProvider({ children }: { children: React.ReactNode }) {
  // useAuthOptional()はAuthProviderが無い木でもundefinedを返す（例外を投げない）。
  // その場合は「認証情報が取得できない＝未ログイン扱い」として安全側のfreeへ倒す。
  const auth = useAuthOptional();
  const userId = auth?.user?.id ?? null;
  const authLoading = auth?.loading ?? false;

  const [serverPlan, setServerPlan] = useState<PremiumStatus>("free");
  const [serverExpiresAt, setServerExpiresAt] = useState<string | null>(null);
  const [status, setStatus] = useState<PremiumFetchStatus>("loading");
  const [devOverride, setDevOverrideState] = useState<PremiumStatus | null>(null);

  const verifiedUserRef = useRef<string | null | typeof NOT_YET_VERIFIED>(NOT_YET_VERIFIED);
  const requestIdRef = useRef(0);
  // 単独修正(2026-08): refresh()はuserIdだけを依存配列に持つ安定したコールバックのまま
  // 保ちたい（依存を増やすとAppState/マウント時のuseEffectが余計に再発火し、意図しない
  // 自動再取得を招く）。そのため、キャッチ節から「直前の検証済み値」を読むためのrefを
  // 別途持ち、setServerPlan/setServerExpiresAtと必ずセットで更新する。
  const serverPlanRef = useRef<PremiumStatus>("free");
  const serverExpiresAtRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const myRequestId = ++requestIdRef.current;
    const targetUserId = userId;
    const isNewUser = verifiedUserRef.current !== targetUserId;

    if (isNewUser) {
      // 別ユーザー（または初回）の状態を引き継がない。取得が終わるまで安全側のfree/loadingにする。
      setServerPlan("free");
      setServerExpiresAt(null);
      setStatus("loading");
      serverPlanRef.current = "free";
      serverExpiresAtRef.current = null;
    }

    try {
      const entitlement = await getServices().premiumService.getEntitlement(targetUserId);
      if (requestIdRef.current !== myRequestId) return; // 新しいrefreshに追い越された古い応答
      verifiedUserRef.current = targetUserId;
      setServerPlan(entitlement.plan);
      setServerExpiresAt(entitlement.expiresAt);
      serverPlanRef.current = entitlement.plan;
      serverExpiresAtRef.current = entitlement.expiresAt;
      setStatus("ready");
    } catch {
      if (requestIdRef.current !== myRequestId) return;
      if (isNewUser) {
        // このユーザーをまだ一度も検証できていない → premiumを勝手に付与せずfreeのまま
        verifiedUserRef.current = NOT_YET_VERIFIED;
        setServerPlan("free");
        setServerExpiresAt(null);
        serverPlanRef.current = "free";
        serverExpiresAtRef.current = null;
      } else if (
        serverPlanRef.current === "premium" &&
        serverExpiresAtRef.current !== null &&
        new Date(serverExpiresAtRef.current).getTime() <= Date.now()
      ) {
        // 同じユーザーで検証済みだが、その後（クライアント側の時計で見て）有効期限を
        // 過ぎたと判断できる場合は、再取得に失敗してもpremiumを維持しない。
        setServerPlan("free");
        setServerExpiresAt(null);
        serverPlanRef.current = "free";
        serverExpiresAtRef.current = null;
      }
      // 上記のいずれにも該当しない場合（同じユーザーで検証済み・期限内または無期限）は、
      // 直前の値を維持する（一時的な通信失敗で画面ごとに表示がブレないようにする）。
      // statusだけerrorにして"ready"+freeと区別し、再試行可能な状態にする。
      setStatus("error");
    }
  }, [userId]);

  const fetchDevOverride = useCallback(async () => {
    if (!__DEV__) return;
    const stored = await getServices().premiumService.getDevOverride();
    setDevOverrideState(stored);
  }, []);

  // 取得タイミング: マウント時・ユーザーID変化時（ログイン完了/切替/ログアウトを包含）。
  // 認証確認中（authLoading）は待ってから行う（未ログイン確定前にfreeへ倒さないため）。
  useEffect(() => {
    if (authLoading) return;
    void refresh();
    void fetchDevOverride();
  }, [authLoading, refresh, fetchDevOverride]);

  // 単独改善(2026-08): app/ai/index.tsxと同じパターンで、バックグラウンド→フォアグラウンド
  // 復帰時にも再取得する（購入状態が変化した可能性があるタイミングの1つ）。
  // ポーリングは追加しない。
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active" || authLoading) return;
      void refresh();
      void fetchDevOverride();
    });
    return () => subscription.remove();
  }, [authLoading, refresh, fetchDevOverride]);

  useEffect(() => {
    if (__DEV__ && devOverride !== null && devOverride !== serverPlan) {
      // eslint-disable-next-line no-console
      console.log(
        `[PremiumContext] DEV override active: showing "${devOverride}" (server says "${serverPlan}")`
      );
    }
  }, [devOverride, serverPlan]);

  const setDevPremiumOverride = useCallback((next: PremiumStatus | null) => {
    void getServices()
      .premiumService.setDevOverride(next)
      .then(() => setDevOverrideState(next));
  }, []);

  // __DEV__かつオーバーライドが設定されている間だけ表示を差し替える。サーバー側の取得・
  // Remote AIの判定には一切影響しない(7節参照、両者が食い違う場合は上のconsole.logで検知する)。
  const isDevOverrideActive = __DEV__ && devOverride !== null;
  const effectivePlan: PremiumStatus = isDevOverrideActive ? (devOverride as PremiumStatus) : serverPlan;

  const value = useMemo<PremiumContextValue>(
    () => ({
      plan: effectivePlan,
      isPremium: effectivePlan === "premium",
      status,
      expiresAt: serverExpiresAt,
      refresh,
      setDevPremiumOverride,
      isDevOverrideActive,
    }),
    [effectivePlan, status, serverExpiresAt, refresh, setDevPremiumOverride, isDevOverrideActive]
  );

  return <PremiumContext.Provider value={value}>{children}</PremiumContext.Provider>;
}

/** Provider外で呼ばれたら例外を投げる（useLocale()と同じ安全策)。開発用切替UI等、Provider配下でのみ使う。 */
export function usePremiumContext(): PremiumContextValue {
  const ctx = useContext(PremiumContext);
  if (!ctx) {
    throw new Error("usePremiumContext は PremiumProvider の内側で使ってください");
  }
  return ctx;
}

/**
 * usePremiumStatus.ts専用の内部エクスポート。Provider外（既存の多くの画面テスト等）でも
 * 例外を投げずfalse相当にフォールバックしたいため、usePremiumContext()とは別に公開する。
 */
export function usePremiumContextOptional(): PremiumContextValue | null {
  return useContext(PremiumContext);
}
