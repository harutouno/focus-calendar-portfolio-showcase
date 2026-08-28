/**
 * Demo AI の導線（メニュー・ホーム画面下部タブ・/aiルート）を表示するかどうか。
 * false にすると提出版から AI 画面を非表示にできる。
 */
export const AI_SUPPORT_FEATURE_ENABLED = true;

/**
 * 「運営を応援する」導線（メニュー・/support画面）を表示するかどうか。
 * app/support.tsxは実際の決済（IAP）に未接続のダミー画面（Alert表示のみ）のため、
 * ストア提出版では必ずfalseにする。実際のIAP実装が完了するまでfalseのまま維持すること。
 */
export const SUPPORT_TIER_FEATURE_ENABLED = false;
