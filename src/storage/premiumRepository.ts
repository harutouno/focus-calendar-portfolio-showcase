import { PremiumStatus } from "@/types/premium";
import { readJSON, writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";
import { isOneOf } from "./shapeGuards";

const PREMIUM_STATUSES = ["free", "premium"] as const;

/**
 * 開発専用のプレミアム状態オーバーライドの永続化。
 * 本番ビルドでこの値を読むかどうかの判断はremotePremiumService.ts側の責務
 * （このRepository自体はどのビルドでも同じ読み書きを行うだけの薄いラッパー）。
 * DATA-F002-002: Category C。不正な形状（"free"/"premium"以外の値）は安全にnullへ。
 */
export async function getDevPremiumOverride(): Promise<PremiumStatus | null> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.devPremiumOverride, null);
  if (raw === null) return null;
  return isOneOf(raw, PREMIUM_STATUSES) ? raw : null;
}

/** 開発専用のデバッグ機能（Category C）のため、保存失敗を呼び出し元へ伝播させない。 */
export async function saveDevPremiumOverride(status: PremiumStatus | null): Promise<void> {
  await writeJSON(STORAGE_KEYS.devPremiumOverride, status).catch(() => {});
}
