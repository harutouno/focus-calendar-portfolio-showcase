import { UserCalendar } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";

export type CalendarOwnership = "local" | "shared" | "unknown";

/**
 * [P0082] AppDataContext.tsxに定義されていたclassifyCalendarOwnershipをそのまま移設した
 * 純粋関数（判定ロジック自体は無変更）。BulkEventForm.tsx（DATA-F017-001の
 * bulkAttemptJournalRepository向けowner scope判定、F017-E）からも同じ判定基準を
 * 再利用できるよう、共有utilへ切り出した。
 *
 * `userCalendars`（端末内に保存された、確実にローカルと判別できるカレンダー一覧）にも
 * `sharedCalendars`にも見つからない場合は"unknown"を返す（呼び出し元が中断するかどうかを
 * 判断する）。両方に一致した場合（データ破損・IDの偶発的衝突等）も、どちらか一方が
 * 正しいという前提を勝手に置かず"unknown"として扱う。
 */
export function classifyCalendarOwnership(
  calendarId: string,
  userCalendars: UserCalendar[],
  sharedCalendars: JoinedCalendarSummary[]
): CalendarOwnership {
  const isLocal = userCalendars.some((c) => c.id === calendarId);
  const isShared = sharedCalendars.some((s) => s.calendar.id === calendarId);
  if (isLocal && isShared) return "unknown";
  if (isLocal) return "local";
  if (isShared) return "shared";
  return "unknown";
}
