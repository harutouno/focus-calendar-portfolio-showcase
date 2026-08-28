import { UserCalendar } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";
import { classifySharedCalendars } from "@/utils/calendarListRows";
import { BASE_CALENDAR_ID } from "@/constants/options";

/**
 * Portfolio Edition のカレンダー作成上限。
 * 基本カレンダーは数えず、追加で作る個人カレンダーと所有する共有カレンダーを
 * それぞれこの固定値で制限する。共有カレンダーの最終的な上限は DB 側でも強制する。
 */
export const MY_CALENDAR_LIMIT = 3;
export const SHARED_CALENDAR_LIMIT = 3;

/** 削除できない基本カレンダー（自分一人用）かどうか。 */
export function isBaseCalendar(calendarId: string): boolean {
  return calendarId === BASE_CALENDAR_ID;
}

/** ユーザーが新規作成できる追加マイカレンダーの上限（基本カレンダーは含まない）。 */
export function getMyCalendarLimit(): number {
  return MY_CALENDAR_LIMIT;
}

/** ユーザーが作成した追加マイカレンダーの数（基本カレンダーを除く）。 */
export function totalMyCalendars(userCalendars: UserCalendar[]): number {
  return userCalendars.filter((c) => !isBaseCalendar(c.id)).length;
}

/** あと何個マイカレンダーを作成できるか。上限超過中は負数にせず0を返す。 */
export function remainingMyCalendars(userCalendars: UserCalendar[]): number {
  return Math.max(0, getMyCalendarLimit() - totalMyCalendars(userCalendars));
}

/** 現在の合計数のまま、マイカレンダーを新規作成してよいか。 */
export function canCreateMyCalendar(userCalendars: UserCalendar[]): boolean {
  return totalMyCalendars(userCalendars) < getMyCalendarLimit();
}

/**
 * 自分がownerとして所有している共有カレンダーの件数（招待されて参加しているだけの
 * editor/viewerカレンダーは含めない）。classifySharedCalendarsのsolo+ownerの合算。
 */
export function countOwnedSharedCalendars(sharedCalendars: JoinedCalendarSummary[]): number {
  const { solo, owner } = classifySharedCalendars(sharedCalendars);
  return solo.length + owner.length;
}
