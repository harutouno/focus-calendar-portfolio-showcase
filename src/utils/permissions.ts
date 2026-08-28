import { AppEvent } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";
import { TFunction } from "@/i18n/translations";

/**
 * ドラッグ（日時変更）を含む編集操作が可能かどうかを判定する。
 * ローカルカレンダー（sharedCalendarsに存在しない）は常に編集可能。
 * 共有カレンダーはowner/editorのみ編集可能、viewerは不可。
 *
 * `src/components/forms/NormalEventForm.tsx` の「予定表」選択肢フィルタと同じ判定基準を
 * イベント単位へ一般化したもの。
 */
export function canEditEvent(
  event: AppEvent,
  sharedCalendars: JoinedCalendarSummary[]
): boolean {
  const shared = sharedCalendars.find((s) => s.calendar.id === event.calendarId);
  if (!shared) return true;
  return shared.role !== "viewer";
}

/** ドラッグできない理由（表示用）。編集可能な場合はnull。 */
export function dragDisabledReason(
  event: AppEvent,
  sharedCalendars: JoinedCalendarSummary[],
  t: TFunction
): string | null {
  const shared = sharedCalendars.find((s) => s.calendar.id === event.calendarId);
  if (!shared) return null;
  if (shared.role === "viewer") return t("permissions.viewerCannotMove");
  return null;
}
