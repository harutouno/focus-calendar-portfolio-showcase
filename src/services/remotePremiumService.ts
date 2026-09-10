import { PremiumStatus } from "@/types/premium";
import { PremiumEntitlement, PremiumService } from "@/services/premiumService";
import { getDevPremiumOverride, saveDevPremiumOverride } from "@/storage/premiumRepository";
import { isSupabaseConfigured, supabase } from "@/lib/supabaseClient";

/**
 * 単独実装(2026-08): 全クライアント機能が同じuser_entitlements由来のプレミアム状態を
 * 参照するための正本実装。判定自体はサーバー（migration 0015のget_my_premium_status、
 * 内部でis_premium_active()を再利用）が行い、クライアントはその結果をそのまま表示する。
 * userIdがnull（未ログイン）またはSupabase未設定の場合はネットワークへ問い合わせず
 * 即座にfreeを返す（個人利用・オフライン時に premium へなる経路が無いことを保証する）。
 */
interface PremiumStatusRow {
  plan: PremiumStatus;
  is_premium: boolean;
  entitlement_status: string | null;
  starts_at: string | null;
  expires_at: string | null;
  checked_at: string;
}

function firstRow<T>(data: unknown): T | undefined {
  return Array.isArray(data) ? (data[0] as T) : (data as T | undefined);
}

export class RemotePremiumService implements PremiumService {
  async getEntitlement(userId: string | null): Promise<PremiumEntitlement> {
    if (!userId || !isSupabaseConfigured) {
      return { plan: "free", expiresAt: null };
    }
    const { data, error } = await supabase.rpc("get_my_premium_status");
    const row = firstRow<PremiumStatusRow>(data);
    if (error || !row) {
      throw new Error("Failed to fetch premium status");
    }
    return {
      plan: row.plan,
      expiresAt: row.expires_at,
    };
  }

  async getDevOverride(): Promise<PremiumStatus | null> {
    if (!__DEV__) return null;
    return getDevPremiumOverride();
  }

  async setDevOverride(status: PremiumStatus | null): Promise<void> {
    if (!__DEV__) return;
    await saveDevPremiumOverride(status);
  }
}

export const premiumService: PremiumService = new RemotePremiumService();
