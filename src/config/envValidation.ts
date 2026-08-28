/**
 * 本番ビルドで、設定を忘れやすい環境変数（.env）の不足を検出するための純粋関数。
 * 実際の値は変更・生成しない（検出のみ）。
 *
 * Portfolio Edition が必要とする環境変数は Supabase の 2 つだけ。
 * OAuth クライアント ID は任意（未設定ならサインインボタンを表示しない）で、
 * 広告・課金・外部 LLM に関する変数はこの版に存在しない。
 */

export interface EnvIssue {
  /** 環境変数名 */
  key: string;
  /** 問題の種類。現在は未設定のみ */
  kind: "missing";
  message: string;
}

interface EnvSnapshot {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

/**
 * 本番ビルドで不足している環境変数を洗い出す（純粋関数、副作用なし）。
 * 呼び出し側（app/_layout.tsx 等）で `__DEV__` が false のときだけ呼び、結果をログへ出す想定。
 */
export function getProductionEnvIssues(env: EnvSnapshot): EnvIssue[] {
  const issues: EnvIssue[] = [];

  if (!env.supabaseUrl) {
    issues.push({
      key: "EXPO_PUBLIC_SUPABASE_URL",
      kind: "missing",
      message: "未設定のため、ログイン・共有カレンダー・招待が利用できません。",
    });
  }
  if (!env.supabaseAnonKey) {
    issues.push({
      key: "EXPO_PUBLIC_SUPABASE_ANON_KEY",
      kind: "missing",
      message: "未設定のため、ログイン・共有カレンダー・招待が利用できません。",
    });
  }

  return issues;
}
