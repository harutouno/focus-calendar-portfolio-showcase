import { usePremiumContextOptional } from "@/context/PremiumContext";

/**
 * Premium（広告非表示など）の判定を1箇所に集約するための差し込み口。
 * 実体はPremiumContext（src/context/PremiumContext.tsx）が保持し、このフックは
 * そこから読み取るだけの薄いアダプタ。呼び出し側（AdPlaceholder等）は
 * このフックの中身がスタブから実際の判定へ変わったことを一切意識しなくてよい。
 *
 * PremiumProviderの外（多くの既存画面テストが該当）で呼ばれた場合はfalseにフォールバックする
 * （useLocale()のように例外を投げない）。これは今回のスコープに無関係な既存テストを
 * 壊さないための意図的な設計判断——フォールバックしても「広告を表示する」という
 * 従来どおり安全側の挙動になるだけで、実アプリ（必ずPremiumProvider配下で動く）の
 * 挙動には影響しない。
 */
export function usePremiumStatus(): boolean {
  const ctx = usePremiumContextOptional();
  return ctx?.isPremium ?? false;
}
