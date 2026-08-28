import { AppEvent, isFocusTask } from "@/types/event";
import { timeToMinutes } from "@/utils/time";
import { getNormalEventDaySlice } from "@/utils/eventDaySlice";

export const HOUR_HEIGHT = 60;
export const START_HOUR = 0;
export const END_HOUR = 24;
export const TIMELINE_HEIGHT = (END_HOUR - START_HOUR) * HOUR_HEIGHT;

export interface PositionedEvent {
  event: AppEvent;
  top: number;
  height: number;
  columnIndex: number;
  columnCount: number;
  /**
   * [P0080 CORRECT-F016-002] このブロックが予定の開始日そのものの区間か（true）、
   * 前日から続く継続区間か（false）。継続区間はevent.dateが別の日付を指すため、
   * ドラッグでの時刻変更（applyTimeMove）をこの日付に対して行うと予定の開始日を
   * 誤って書き換えてしまう——呼び出し元（DayView/WeekView）はfalseの場合ドラッグを
   * 無効化する。
   */
  isStartDay: boolean;
}

/**
 * [P0080 CORRECT-F016-002] 指定した暦日dateにおける、この予定の表示区間（分単位）を返す。
 * 通常予定はgetNormalEventDaySlice（唯一の投影権限、src/utils/eventDaySlice.ts）に委譲する
 * ——以前ここにあった`end > start ? end : start + 30`という同日限定フォールバックは、
 * 日付をまたぐ終了時刻（endDate）を一切考慮しない既知の誤りだったため使わない。
 * 呼び出し元は必ずその日に実際に触れる予定だけを渡す（groupEventsByDate/
 * eventTouchedDatesが返した集合）ため、通常予定でsliceがnullになることはない
 * （防御的にnullなら幅0として扱う）。
 */
export function eventRange(
  event: AppEvent,
  date: string
): { start: number; end: number; isStartDay: boolean } {
  if (isFocusTask(event)) {
    const start = timeToMinutes(event.startTime);
    return { start, end: start + Math.max(event.durationMinutes, 15), isStartDay: true };
  }
  const slice = getNormalEventDaySlice(event, date);
  const isStartDay = event.date === date;
  if (!slice) return { start: 0, end: 0, isStartDay };
  return { start: slice.startMinutes, end: slice.endMinutes, isStartDay };
}

/**
 * 指定した1つの暦日dateについて、予定を時間帯が重なるものだけグルーピングし、
 * 横に並べて配置するためのカラム割り当てを行う（簡易な区間分割アルゴリズム）。
 * [P0080 CORRECT-F016-002] dateを必須パラメータへ変更した——呼び出し元は
 * 「この日に実際に表示すべき予定の集合」（前日から続く継続を含む）を渡し、
 * この関数はその日1日分の座標だけを計算する（複数日にまたがる区間計算は
 * getNormalEventDaySlice/eventRangeに一本化されている）。
 */
export function layoutEventsForDay(events: AppEvent[], date: string): PositionedEvent[] {
  const sorted = [...events].sort((a, b) => {
    const ra = eventRange(a, date);
    const rb = eventRange(b, date);
    return ra.start - rb.start;
  });

  const result: PositionedEvent[] = [];
  let cluster: { event: AppEvent; start: number; end: number; isStartDay: boolean }[] = [];
  let clusterEnd = -1;

  const flushCluster = () => {
    if (cluster.length === 0) return;
    // クラスタ内でカラム割り当て
    const columnsEnd: number[] = [];
    const assigned: { event: AppEvent; start: number; end: number; isStartDay: boolean; col: number }[] = [];
    for (const item of cluster) {
      let col = columnsEnd.findIndex((end) => end <= item.start);
      if (col === -1) {
        col = columnsEnd.length;
        columnsEnd.push(item.end);
      } else {
        columnsEnd[col] = item.end;
      }
      assigned.push({ ...item, col });
    }
    const columnCount = columnsEnd.length;
    for (const item of assigned) {
      result.push({
        event: item.event,
        top: (item.start - START_HOUR * 60) * (HOUR_HEIGHT / 60),
        height: Math.max((item.end - item.start) * (HOUR_HEIGHT / 60), 28),
        columnIndex: item.col,
        columnCount,
        isStartDay: item.isStartDay,
      });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const event of sorted) {
    const { start, end, isStartDay } = eventRange(event, date);
    if (cluster.length > 0 && start >= clusterEnd) {
      flushCluster();
    }
    cluster.push({ event, start, end, isStartDay });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flushCluster();

  return result;
}

export function currentTimeTop(): number {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return (minutes - START_HOUR * 60) * (HOUR_HEIGHT / 60);
}
