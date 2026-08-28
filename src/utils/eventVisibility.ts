import { AppEvent, OverlaySettings, isFocusTask } from "@/types/event";
import { FOCUS_CALENDAR_ID } from "@/constants/options";
import { eventTouchedDates } from "@/utils/eventDaySlice";

/**
 * 「表示切り替え」設定に基づいて予定を絞り込む純粋関数（Stage I-8.7）。
 * 元々app/index.tsx（月・週・日表示）にだけ書かれていたフィルタをそのまま抽出したもので、
 * 挙動は一切変更していない。日別予定一覧画面もこれを再利用することで、
 * 「月表示で見えている予定と日別一覧の予定を一致させる」ことを保証する。
 */
export function filterVisibleEvents(
  events: AppEvent[],
  overlaySettings: OverlaySettings
): AppEvent[] {
  return events.filter((e) => {
    if (isFocusTask(e)) {
      if (!overlaySettings.showTasks) return false;
      // 2026-07-31より前（予定作成画面でのカレンダー選択拡張前）に保存されたタスクは、
      // 疑似カレンダーID（FOCUS_CALENDAR_ID）に属し、ユーザーが選べるカレンダーへ
      // 紐付いていなかった。visibleCalendarIdsにこの疑似IDが含まれることは無いため、
      // 旧データは後方互換として種類トグルのみで表示し続ける（突然非表示にしない）。
      if (e.calendarId === FOCUS_CALENDAR_ID) return true;
      // 実在のカレンダーIDを持つ新規タスクは、通常予定と同じくカレンダー選択にも従う。
      return overlaySettings.visibleCalendarIds.includes(e.calendarId);
    }
    if (!overlaySettings.showNormalEvents) return false;
    // "main"（既定のマイカレンダー）も含め、すべてのカレンダーを同じ
    // visibleCalendarIdsで統一的に判定する。
    const calendarId = e.calendarId || "main";
    return overlaySettings.visibleCalendarIds.includes(calendarId);
  });
}

/**
 * 予定配列を、その予定が実際に触れる暦日ごとにグルーピングする純粋関数
 * （QA-F009-F012広範監査、[P0080 CORRECT-F016-002]で拡張）。
 * 元々MonthView.tsxだけに書かれていたMapグルーピングをそのまま抽出したもので、
 * 比較関数を含めそれ以外の挙動は変更していない（同時刻の並び順の同点判定を含む）。
 * [P0080 CORRECT-F016-002] 以前はevent.date（開始日）のみでグルーピングしており、
 * 日付をまたぐ通常予定（例: 23:40開始→翌日00:40終了）が終了日側のMap keyには
 * 一切現れなかった（Month/Week表示で継続を発見できない実バグ）。eventTouchedDates
 * （唯一の投影権限、src/utils/eventDaySlice.ts）を使い、開始日・終了日の両方へ
 * 同じ予定を登録する。
 * WeekView.tsxも同じ関数を再利用することで、月表示と週表示が同じ日付に対して
 * 常に同一の予定集合を返すことを構造的に保証する（1回の走査でO(events.length)）。
 * DayView.tsxも同じeventTouchedDatesを使うフィルタへ統一した（timelineLayout.ts参照）。
 */
export function groupEventsByDate(events: AppEvent[]): Map<string, AppEvent[]> {
  const map = new Map<string, AppEvent[]>();
  for (const e of events) {
    for (const d of eventTouchedDates(e)) {
      const list = map.get(d) ?? [];
      list.push(e);
      map.set(d, list);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
  }
  return map;
}
