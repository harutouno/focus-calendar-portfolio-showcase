import { UserCalendar } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";
import { classifySharedCalendars } from "@/utils/calendarListRows";
import { BASE_CALENDAR_ID } from "@/constants/options";

/**
 * マイカレンダー・共有カレンダーの作成上限（無料/プレミアム）。
 * 画面側で数値を重複記述しないよう、ここへ一元化する。
 * プレミアム判定自体は統合済みPremiumContext（usePremiumStatus、user_entitlementsが
 * 正本）を使うが、マイカレンダーはSupabaseに一切保存されないため（FP-011参照）、
 * 件数と上限の突き合わせ自体はクライアント側だけで行う。
 *
 * [P0094 SPEC-F018-001] 削除できない基本カレンダー「自分一人用」（BASE_CALENDAR_ID）は
 * `userCalendars`へ実データとして常に含まれる（withBaseCalendarEnsured参照）が、
 * ユーザーが新規作成できる追加マイカレンダーの3/10上限には**含めない**（P0092までの
 * 単独修正・FP-002は本バッチで反転された。正本はP0091ハンドオフ／P0092ロック済み
 * プロンプト：BASE_CALENDAR_IDはuser-createdスロットを消費しない）。したがって
 * `userCalendars`の物理行数としての妥当な最大値は 無料=base+3=4件、
 * プレミアム=base+10=11件 になる。既にこの上限を超えている既存データがあっても、
 * 資格変更を理由に既存カレンダーを削除することは絶対にしない（新規作成の停止だけに使う）。
 * 招待されて参加しているだけの共有カレンダーは、引き続き所有共有カレンダーの上限に
 * 含めない。これらの判定は画面ごとに個別実装せず、必ず下記の共通関数
 * （isBaseCalendar/totalMyCalendars等/countOwnedSharedCalendars）経由で行う。
 */
export const FREE_MY_CALENDAR_LIMIT = 3;
export const PREMIUM_MY_CALENDAR_LIMIT = 10;
export const FREE_SHARED_CALENDAR_LIMIT = 3;
export const PREMIUM_SHARED_CALENDAR_LIMIT = 10;

/** 削除できない基本カレンダー（自分一人用）かどうか。 */
export function isBaseCalendar(calendarId: string): boolean {
  return calendarId === BASE_CALENDAR_ID;
}

/** プラン別の、ユーザーが新規作成できる追加マイカレンダーの上限（自分一人用は含まない）。 */
export function getMyCalendarLimit(isPremium: boolean): number {
  return isPremium ? PREMIUM_MY_CALENDAR_LIMIT : FREE_MY_CALENDAR_LIMIT;
}

/**
 * [P0094 SPEC-F018-001] ユーザーが作成した追加マイカレンダーの数（自分一人用を除く）。
 * `userCalendars`には自分一人用が実データとして常に含まれる（withBaseCalendarEnsured参照）
 * ため、上限判定にはBASE_CALENDAR_IDを除いた件数を使う。
 */
export function totalMyCalendars(userCalendars: UserCalendar[]): number {
  return userCalendars.filter((c) => !isBaseCalendar(c.id)).length;
}

/** あと何個マイカレンダーを作成できるか。上限超過中は負数にせず0を返す。 */
export function remainingMyCalendars(userCalendars: UserCalendar[], isPremium: boolean): number {
  return Math.max(0, getMyCalendarLimit(isPremium) - totalMyCalendars(userCalendars));
}

/** 現在の合計数のまま、マイカレンダーを新規作成してよいか。 */
export function canCreateMyCalendar(userCalendars: UserCalendar[], isPremium: boolean): boolean {
  return totalMyCalendars(userCalendars) < getMyCalendarLimit(isPremium);
}

/**
 * 旧仕様等により、既に追加マイカレンダー（自分一人用を除く）の上限を超えているかどうか。
 * 超過していても既存カレンダーの削除・非表示は行わない（新規作成の停止だけに使う）。
 */
export function isOverMyCalendarLimit(userCalendars: UserCalendar[], isPremium: boolean): boolean {
  return totalMyCalendars(userCalendars) > getMyCalendarLimit(isPremium);
}

/**
 * 自分がownerとして所有している共有カレンダーの件数（招待されて参加しているだけの
 * editor/viewerカレンダーは含めない）。classifySharedCalendarsのsolo+ownerの合算。
 */
export function countOwnedSharedCalendars(sharedCalendars: JoinedCalendarSummary[]): number {
  const { solo, owner } = classifySharedCalendars(sharedCalendars);
  return solo.length + owner.length;
}
