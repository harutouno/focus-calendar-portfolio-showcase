import { AIRequestKind } from "@/types/ai";

/**
 * 入力テキストからAIRequestKindを判定する（外部通信を使わない簡易分類）。
 * テンプレートカードの文言はこの判定に確実に一致するよう設計している。
 * 判定順: 機能説明 → Focus分析 → 予定提案 → それ以外は予定作成（既定値）。
 */
const FEATURE_HELP_PATTERN = /使い方|機能|操作|とは|って何|モード/;
const FOCUS_ANALYSIS_PATTERN = /分析|振り返り|傾向/;
// 2026-07-25: 「今日の予定を整理する」「今週の予定を確認する」等のおすすめカード文言が
// 正しく分類されるよう「整理|確認」を追加（予定作成ではなく既存予定の把握・提案が
// 意図に近いため）。既存4件のテンプレート文言の分類結果には影響しない。
const SUGGEST_SCHEDULE_PATTERN = /空き時間|空いて|提案|候補|整理|確認/;

export function classifyAIRequest(input: string): AIRequestKind {
  if (FEATURE_HELP_PATTERN.test(input)) return "feature_help";
  if (FOCUS_ANALYSIS_PATTERN.test(input)) return "focus_analysis";
  if (SUGGEST_SCHEDULE_PATTERN.test(input)) return "suggest_schedule";
  return "create_schedule";
}
