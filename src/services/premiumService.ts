import { PremiumStatus } from "@/types/premium";

/** サーバー（user_entitlements）から取得した、認証済みユーザー自身のプレミアム資格。 */
export interface PremiumEntitlement {
  plan: PremiumStatus;
  expiresAt: string | null;
}

/**
 * プレミアム資格の判定を抽象化する。user_entitlements（Supabase）を唯一の正本とし、
 * 呼び出し側（PremiumContext）はこのインターフェースだけに依存する。
 */
export interface PremiumService {
  /**
   * userIdの資格を取得する。userIdがnull（未ログイン）の場合は必ずfreeを返す
   * （実装側がネットワークへ問い合わせずに保証する）。クライアントから送られる
   * isPremium/planは一切信用せず、サーバーが返した値のみを正本として扱う。
   */
  getEntitlement(userId: string | null): Promise<PremiumEntitlement>;
  /**
   * 開発環境専用の動作確認用オーバーライドの現在値を返す。本番ビルド（__DEV__===false）
   * では常にnull（実装側で保証する）。
   */
  getDevOverride(): Promise<PremiumStatus | null>;
  /**
   * 開発環境専用の動作確認用切替。本番ビルドでは何もしない（実装側で保証する）。
   * 正式な課金状態とは完全に別物のため、UIからは「開発用」であることが明確に分かる
   * 文言でのみ呼び出すこと。
   */
  setDevOverride(status: PremiumStatus | null): Promise<void>;
}
