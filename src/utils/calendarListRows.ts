import { CalendarRole, JoinedCalendarSummary } from "@/types/sharing";
import { AppEvent } from "@/types/event";
import { TFunction, TranslationKey, translate } from "@/i18n/translations";

function defaultJaT(key: TranslationKey, vars?: Record<string, string | number>): string {
  return translate("ja", key, vars);
}

export interface ClassifiedSharedCalendars {
  /** 自分がownerで、他に誰も参加していない共有カレンダー */
  solo: JoinedCalendarSummary[];
  /** 自分がownerで、他のメンバーもいる共有カレンダー */
  owner: JoinedCalendarSummary[];
  /** 招待を受けて参加している（owner以外の）共有カレンダー */
  joined: JoinedCalendarSummary[];
}

/**
 * 共有カレンダー一覧を、一覧画面の「マイカレンダー」「参加中」区分に必要な3種類へ分類する。
 * 「自分のみ」と「オーナー」の区分はDBに明示的なフラグがあるわけではなく、memberCountからの推測。
 */
export function classifySharedCalendars(
  sharedCalendars: JoinedCalendarSummary[]
): ClassifiedSharedCalendars {
  const ownedShared = sharedCalendars.filter((s) => s.role === "owner");
  const solo = ownedShared.filter((s) => s.memberCount <= 1);
  const owner = ownedShared.filter((s) => s.memberCount > 1);
  const joined = sharedCalendars.filter((s) => s.role !== "owner");
  return { solo, owner, joined };
}

/**
 * 権限（owner/editor/viewer）の単語だけの翻訳キー。app/calendar/[id]/settings.tsxの
 * 既存ROLE_LABEL_KEYと同じ対応表で、共有タブ再設計のSharedCalendarRow等でも再利用する。
 */
export const ROLE_LABEL_KEY: Record<CalendarRole, TranslationKey> = {
  owner: "calendarRole.owner",
  editor: "calendarRole.editor",
  viewer: "calendarRole.viewer",
};

/** 参加中カレンダー行のステータス文言（例: "編集者・参加者8人"） */
export function joinedStatusLabel(
  role: CalendarRole,
  memberCount: number,
  t: TFunction = defaultJaT
): string {
  return t("calendarDetail.subtitleShared", { role: t(ROLE_LABEL_KEY[role]), count: memberCount });
}

/** オーナー（複数人）カレンダー行のステータス文言（例: "オーナー・参加者4人"） */
export function ownerStatusLabel(memberCount: number, t: TFunction = defaultJaT): string {
  return t("calendarDetail.subtitleShared", {
    role: t(ROLE_LABEL_KEY.owner),
    count: memberCount,
  });
}

/** 自分がownerで他に誰も参加していない共有カレンダー行のステータス文言（例: "オーナー（自分のみ）"） */
export function soloOwnerStatusLabel(t: TFunction = defaultJaT): string {
  return t("calendars.ownerSoloLabel");
}

/**
 * カレンダー一覧のカードに表示する「次の予定、または予定件数」の1行要約。
 * - 今日以降の予定があれば、日付が最も近いものを「次の予定: MM/DD タイトル」の形で返す
 * - 今日以降の予定が無く、過去の予定のみある場合は「予定N件」を返す
 * - そのカレンダーの予定が1件も無い場合は「予定なし」を返す
 * calendarIdが一致する予定だけを対象にする（他カレンダーの予定は無視する）。
 */
export function nextEventSummary(
  events: AppEvent[],
  calendarId: string,
  todayDateString: string,
  t: TFunction = defaultJaT
): string {
  const calendarEvents = events.filter((e) => e.calendarId === calendarId);
  if (calendarEvents.length === 0) return t("calendars.noEventsLabel");

  const upcoming = calendarEvents
    .filter((e) => e.date >= todayDateString)
    .sort((a, b) => (a.date === b.date ? (a.startTime < b.startTime ? -1 : 1) : a.date < b.date ? -1 : 1));

  if (upcoming.length > 0) {
    const next = upcoming[0];
    return t("calendars.nextEventLabel", {
      date: next.date.slice(5).replace("-", "/"),
      title: next.title,
    });
  }

  return t("calendars.eventCountLabel", { count: calendarEvents.length });
}

/**
 * 共有カレンダー名の部分一致検索（大小文字・全角半角の単純な差は無視、日本語はそのまま比較）。
 * 所有／参加中どちらの一覧にも同じ関数を使い、区分自体は変えない
 * （呼び出し側がsolo/owner/joinedそれぞれの配列へこの関数を個別に適用する）。
 * データそのものは書き換えない純粋関数。
 */
export function filterSharedCalendarsByQuery(
  summaries: JoinedCalendarSummary[],
  query: string
): JoinedCalendarSummary[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return summaries;
  return summaries.filter((s) => s.calendar.name.toLocaleLowerCase().includes(normalized));
}
