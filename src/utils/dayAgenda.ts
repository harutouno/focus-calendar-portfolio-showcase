import { AppEvent, isNormalEvent } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";
import { TFunction } from "@/i18n/translations";

/**
 * 日別予定一覧（Stage I-8.7）の抽出・並び順・登録者表示ロジック。
 * すべてUIから独立した純粋関数にし、MonthView側に同じロジックを重複させない。
 *
 * 繰り返し予定について: このアプリでは繰り返し予定も「各回が完全に独立したイベント行として
 * event.dateを持つ」という設計（ARCHITECTURE.md参照）のため、単純に event.date === date で
 * 絞り込むだけで、その日に発生する回だけが自然に対象になる（別途の展開処理は不要）。
 */

function isAllDay(event: AppEvent): boolean {
  return isNormalEvent(event) && event.allDay;
}

function endTimeOf(event: AppEvent): string {
  return isNormalEvent(event) ? event.endTime : "";
}

/**
 * 表示順の安定した比較関数。
 * 終日予定を先頭にし、以降は開始時刻→終了時刻→作成日時→id の順で決定的に並べる
 * （同時刻の予定が複数あっても、呼び出しのたびに順序が変わらないようにするため）。
 */
export function compareAgendaEvents(a: AppEvent, b: AppEvent): number {
  const aAllDay = isAllDay(a);
  const bAllDay = isAllDay(b);
  if (aAllDay !== bAllDay) return aAllDay ? -1 : 1;

  if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;

  const aEnd = endTimeOf(a);
  const bEnd = endTimeOf(b);
  if (aEnd !== bEnd) return aEnd < bEnd ? -1 : 1;

  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;

  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * 指定日付の予定だけを取り出し、表示順に並べて返す。
 * 呼び出し側で `filterVisibleEvents`（表示切り替え）を先に適用した配列を渡す想定。
 */
export function selectEventsForDate(events: AppEvent[], date: string): AppEvent[] {
  return events.filter((e) => e.date === date).sort(compareAgendaEvents);
}

export interface EventRegistrantInfo {
  /** 表示ラベル（自分向けラベル または 共有カレンダー名） */
  label: string;
  isOwn: boolean;
  calendarName?: string;
  calendarColor?: string;
}

/**
 * 予定の「誰が登録したか」表示情報を返す。
 * 現状のデータ層（AppEvent/Supabaseの行）には登録者個人を特定する情報が
 * クライアント側まで届いていないため、登録者名の推測はせず、
 * 自分の予定は自分向けラベル（t("dayAgendaRow.selfLabel")）、共有予定は共有カレンダー名のみを返す。
 */
export function getEventRegistrantInfo(
  event: AppEvent,
  sharedCalendars: JoinedCalendarSummary[],
  t: TFunction
): EventRegistrantInfo {
  const shared = sharedCalendars.find((s) => s.calendar.id === event.calendarId);
  if (!shared) {
    return { label: t("dayAgendaRow.selfLabel"), isOwn: true };
  }
  return {
    label: shared.calendar.name,
    isOwn: false,
    calendarName: shared.calendar.name,
    calendarColor: shared.calendar.color,
  };
}
