/**
 * マイカレンダー・共有カレンダーを合わせて同時に表示ON（overlaySettings.visibleCalendarIds）
 * にできる件数の上限（無料/プレミアム共通の可読性制限であり、課金上限ではない）。
 *
 * 2026-08: 共有タブ再設計に伴い新規追加。以前は`visibleCalendarIds`に長さの上限が
 * 一切無かった（コード全体をgrepして確認済み）。この関数は「ONにしようとした時だけ」
 * 上限を強制する——既に6個以上ONの既存ユーザーの設定を起動時に勝手に間引いたり、
 * OFF操作を妨げたりすることは絶対にしない（トグル時にしか呼ばれないため自然に満たされる）。
 * カレンダーの種別（自分一人用／追加マイカレンダー／所有共有／参加共有）は区別せず、
 * `visibleCalendarIds`の要素数をそのまま数えるだけにすることで、
 * マイカレンダー画面・共有タブ・/overlay・CalendarVisibilityChipsのどこから
 * トグルしても同じ1つの判定を共有できるようにしている。
 */
export const MAX_VISIBLE_CALENDARS = 5;

export type ToggleVisibilityResult =
  | { status: "applied"; visibleCalendarIds: string[] }
  | { status: "limitReached" };

/**
 * [P0094 CORRECT-F020-001] 同じcalendarIdが重複して含まれている場合、初出の順序を保った
 * まま重複だけを取り除く（並び替え・データ削除は行わない——単に同じ実体を指す重複エントリを
 * 1つに畳むだけ）。
 */
export function dedupePreserveOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

export function toggleCalendarVisibility(
  visibleCalendarIds: readonly string[],
  calendarId: string
): ToggleVisibilityResult {
  // [P0094 CORRECT-F020-001] 上限判定・トグル結果の両方を、重複を畳んだ後の集合から行う。
  // 以前は生の配列長をそのまま上限判定に使っていたため、同じIDが重複しているだけで
  // 実際にはON中のカレンダーが4個以下でも「上限に達した」と誤判定し、新しいカレンダーを
  // 表示できなくなることがあった。
  const deduped = dedupePreserveOrder(visibleCalendarIds);
  const isVisible = deduped.includes(calendarId);
  if (isVisible) {
    return {
      status: "applied",
      visibleCalendarIds: deduped.filter((id) => id !== calendarId),
    };
  }
  if (deduped.length >= MAX_VISIBLE_CALENDARS) {
    return { status: "limitReached" };
  }
  return { status: "applied", visibleCalendarIds: [...deduped, calendarId] };
}
