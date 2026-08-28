import { isPlainObject } from "@/storage/shapeGuards";

/**
 * SEC-F007-001: SupabaseアクセストークンのJWTから`session_id` claimを取り出すためだけの
 * 最小限のデコーダ。署名検証は行わない（サーバー側の認可判断の代用にはせず、
 * 端末内でのセッション識別子の比較にのみ使うため）。
 * atob/Buffer/TextDecoderのいずれにも依存せず、RN Hermes・Jest/Node・ブラウザの
 * どの実行環境でも同じ結果になるよう、base64のデコード自体を自前実装する。
 */
const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Decode(input: string): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const char of input) {
    if (char === "=") break;
    const value = BASE64_CHARS.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}

/**
 * JWTのpayload部分（第2セグメント）を解析する。形式不正・JSON解析失敗時はnullを返す
 * （呼び出し元は安全側にフォールバックする）。
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) base64 += "=";
    const json = base64Decode(base64);
    const parsed = JSON.parse(json);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * SupabaseアクセストークンのJWTから`session_id` claim（認証セッションを一意に識別する、
 * ユーザーIDとは別のID）を取り出す。取得できない場合（トークン形式不正・claim欠落等）はnull。
 * この値はローカルの状態分離用識別子としてのみ使い、サーバー側の認可判断には使わない
 * （認可は引き続きSupabaseのRLSを正本とする）。
 */
export function extractSessionIdFromAccessToken(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const sessionId = payload?.session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}
