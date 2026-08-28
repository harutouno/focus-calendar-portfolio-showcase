/**
 * Magic Link経由（app/auth/callback.tsx）で受け取るreturnToクエリを、
 * アプリ内の既知のルートだけに限定するための純粋関数。
 * 不正な値・未知の値・空値は常に"/account"へフォールバックする。
 *
 * 許可するルート（既存の正常経路のみ、新規ルートは追加しない）:
 * - "/account"（デフォルトの戻り先）
 * - "/calendars"（app/calendars.tsxの未ログイン時サインイン導線）
 * - "/invite/<token>"（app/invite/[token].tsxの未ログイン時サインイン導線）
 */

const STATIC_ALLOWED_RETURN_PATHS = new Set<string>(["/account", "/calendars"]);

const DEFAULT_RETURN_PATH = "/account";

function isAllowedInvitePath(path: string): boolean {
  const match = /^\/invite\/([^/]+)$/.exec(path);
  return !!match && match[1].length > 0;
}

export function resolveReturnToPath(returnTo: string | undefined | null): string {
  if (!returnTo) return DEFAULT_RETURN_PATH;
  if (STATIC_ALLOWED_RETURN_PATHS.has(returnTo)) return returnTo;
  if (isAllowedInvitePath(returnTo)) return returnTo;
  return DEFAULT_RETURN_PATH;
}
