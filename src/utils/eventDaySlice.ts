import { AppEvent, isFocusTask } from "@/types/event";
import { timeToMinutes } from "@/utils/time";

/**
 * [P0080 CORRECT-F016-002] 通常予定の投影の唯一の権限（single projection authority）。
 * データモデル: start = date+startTime, end = (endDate ?? date)+endTime。
 * 指定した1つの暦日dateに、このNormalEventの時間帯が実際に重なる範囲だけを分単位
 * （0=その日の00:00、1440=その日の24:00）で返す。重ならなければnull。
 *
 * 正本の必須例: 2026-08-11 23:40 → 2026-08-12 00:40 は
 *   2026-08-11: 23:40–24:00（20分）
 *   2026-08-12: 00:00–00:40（40分）
 * の2つのスライスを生む。旧実装（timelineLayout.tsのeventRange）が使っていた
 * `end > start ? end : start + 30` という同日限定のフォールバックは、日付をまたぐ
 * 終了時刻を考慮しないため既知のovernight NormalEventに対して誤った結果を返していた
 * （このフォールバックはここでは一切使わない）。
 *
 * Month/Week/Day表示・タイムラインレイアウトのすべてがこの関数だけを呼ぶことで、
 * 「日付の交差判定」ロジックを複数箇所に重複させない。
 */
export function getNormalEventDaySlice(
  event: { date: string; startTime: string; endTime: string; endDate?: string },
  date: string
): { startMinutes: number; endMinutes: number } | null {
  const effectiveEndDate = event.endDate ?? event.date;
  if (date < event.date || date > effectiveEndDate) return null;
  const startMinutes = event.date === date ? timeToMinutes(event.startTime) : 0;
  const endMinutes = effectiveEndDate === date ? timeToMinutes(event.endTime) : 1440;
  if (endMinutes <= startMinutes) return null;
  return { startMinutes, endMinutes };
}

/**
 * 予定1件が実際に触れる暦日の一覧（開始日・終了日の両方、同日なら1件のみ）を返す。
 * FocusTask・終日予定を含め、endDateを持たない（＝dateと同一日で完結する）予定は
 * 常に単一日。本アプリの通常予定は複数日にまたがる予定を扱わないため、endDateが
 * 存在する場合でも高々2日（開始日・終了日）で足りる
 * （[P0078 CORRECT-F016-001]の正本: 日付繰り上がりは高々1日分）。
 */
export function eventTouchedDates(event: AppEvent): string[] {
  if (isFocusTask(event)) return [event.date];
  const effectiveEndDate = event.endDate ?? event.date;
  return effectiveEndDate === event.date ? [event.date] : [event.date, effectiveEndDate];
}
