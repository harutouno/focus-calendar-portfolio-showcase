import { TFunction } from "@/i18n/translations";

/**
 * Supabase/PostgRESTなどが返す英語のエラーメッセージを、ユーザー向けの表示言語メッセージに変換する。
 * 該当するパターンがなければ呼び出し側が指定したfallbackを返す（fallback自体も呼び出し側で
 * t()を使って翻訳済みの文字列を渡すこと）。
 */
export function toFriendlyMessage(raw: string | undefined, fallback: string, t: TFunction): string {
  if (!raw) return fallback;
  const lower = raw.toLowerCase();

  if (lower.includes("invite not found")) return t("friendlyError.inviteNotFound");
  if (lower.includes("invite revoked")) return t("friendlyError.inviteRevoked");
  if (lower.includes("invite expired")) return t("friendlyError.inviteExpired");

  if (lower.includes("rate limit")) {
    return t("friendlyError.rateLimit");
  }
  if (lower.includes("invalid") && lower.includes("email")) {
    return t("friendlyError.invalidEmail");
  }
  if (
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch")
  ) {
    return t("friendlyError.network");
  }
  if (
    lower.includes("not authorized") ||
    lower.includes("permission") ||
    lower.includes("row-level security")
  ) {
    return t("friendlyError.notAuthorized");
  }
  if (lower.includes("jwt") || lower.includes("session")) {
    return t("friendlyError.session");
  }
  if (lower.includes("owned_shared_calendar_limit_exceeded")) {
    return t("friendlyError.ownedSharedCalendarLimitExceeded");
  }
  if (lower.includes("shared_calendar_member_limit_exceeded")) {
    return t("friendlyError.sharedCalendarMemberLimitExceeded");
  }
  if (lower.includes("local_persistence_write_failed") || lower.includes("local_persistence_remove_failed")) {
    return t("friendlyError.localPersistenceFailed");
  }
  if (lower.includes("shared_event_delete_result_unconfirmed")) {
    return t("friendlyError.sharedEventDeleteUnconfirmed");
  }

  return fallback;
}
