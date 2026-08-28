import { useEffect, useRef } from "react";
import { useAuthOptional } from "@/context/AuthContext";

/**
 * SEC-F006-001: 認証済み→未認証への実際の遷移（ログアウト）を検知した瞬間にだけ
 * callbackを呼ぶ。初回マウント時に既に未ログインだった場合（ゲスト利用の初回起動、
 * AuthProviderが無いツリーでの利用を含む）や、未ログインのまま再レンダーされる場合には
 * 呼ばない（無関係なローカルデータを無条件に消さないため）。認証状態がまだ確定していない
 * 間（loading中）は判定を保留する。
 */
export function useOnLogout(callback: () => void): void {
  const auth = useAuthOptional();
  const userId = auth?.user?.id ?? null;
  const authLoading = auth?.loading ?? false;
  const prevUserIdRef = useRef<string | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (authLoading) return;
    if (prevUserIdRef.current && !userId) {
      callbackRef.current();
    }
    prevUserIdRef.current = userId;
  }, [userId, authLoading]);
}
