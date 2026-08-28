/**
 * AIサポート機能の型定義。
 * 本提出版では、入力を分類して DemoAIService が端末内のサンプル応答を返す。
 */

/** AIが担当するリクエストの種別。自由文字列ではなく、常にこの型を経由する。 */
export type AIRequestKind =
  | "create_schedule"
  | "suggest_schedule"
  | "focus_analysis"
  | "feature_help";

export interface AISupportRequest {
  kind: AIRequestKind;
  input: string;
  /** 送信中の依頼と結果を対応付け、再試行時の二重処理を避けるための一意なID。 */
  requestId: string;
}

export interface AIScheduleSummary {
  title: string;
  date: string; // "YYYY-MM-DD"
  startTime: string;
  endTime?: string;
}

export interface AISummaryRow {
  label: string;
  value: string;
}

export type AIResultActionType =
  /** 提案された予定を、確認ダイアログのうえでカレンダーへ追加する */
  | "apply_to_calendar"
  | "view_calendar"
  | "view_records"
  | "regenerate";

export interface AIResultAction {
  type: AIResultActionType;
  label: string;
}

export interface AISupportResponse {
  kind: AIRequestKind;
  headline: string;
  description?: string;
  schedule?: AIScheduleSummary;
  summaryRows?: AISummaryRow[];
  actions: AIResultAction[];
}

export type AIRequestStatus = "idle" | "loading" | "success" | "error";

/** AIサポートの1回のやり取り（質問と結果）の履歴エントリ。 */
export interface AiChatHistoryEntry {
  id: string;
  createdAt: string; // ISO8601
  kind: AIRequestKind;
  input: string;
  response: AISupportResponse;
  /**
   * SEC-F006-001残存修正: この項目を作成した時点の認証ユーザーID。未ログイン
   * （ゲスト・ローカルAI利用）で作成された場合はnull。この項目が無い旧形式データも
   * nullと同じ扱い（ゲストスコープ、常に閲覧可）にする。ログアウト時のStorage削除が
   * 何らかの理由で失敗しても、この所有スコープが現在の認証ユーザーと一致しない項目は
   * 読み込み時に除外され、別ユーザー・未ログイン状態への復元を防ぐ。
   */
  ownerUserId?: string | null;
}
