import { AIScheduleSummary } from "@/types/ai";
import { NormalEvent } from "@/types/event";
import { generateId } from "@/utils/id";
import { resolveEndDate } from "@/utils/time";

/**
 * Demo AI が提案した予定サマリを、アプリの正式な予定（NormalEvent）へ変換する。
 *
 * ここは「AI の出力」と「アプリのデータモデル」の境界。AI 側は自由な形を返しうるので、
 * 保存前に必ずこの関数を通し、アプリが保証している不変条件を満たす形へ落とす。
 * 変換できない入力は例外ではなく null を返し、呼び出し元が「追加できない」と
 * 明示できるようにする（fail-closed。壊れた予定を作らない）。
 *
 * 保証すること:
 *   - date / startTime / endTime の形式が想定どおりであること
 *   - endTime が無い場合は開始 1 時間後を既定にする
 *   - 日をまたぐ場合の endDate を time.ts の resolveEndDate に委ねる
 *     （終了時刻が開始時刻以下なら翌日扱い。この判定の正本は 1 箇所だけ）
 *   - id は新規採番し、AI 側の値を一切信用しない
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function addOneHour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  const next = (h + 1) % 24;
  return String(next).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

export interface AiScheduleConversionInput {
  schedule: AIScheduleSummary;
  /** 保存先カレンダー。呼び出し元（画面）が現在の既定カレンダーを渡す。 */
  calendarId: string;
}

export function convertAiScheduleToNormalEvent(
  input: AiScheduleConversionInput
): NormalEvent | null {
  const { schedule, calendarId } = input;
  const title = (schedule.title ?? "").trim();
  if (!title) return null;
  if (!calendarId) return null;
  if (!DATE_RE.test(schedule.date)) return null;
  if (!TIME_RE.test(schedule.startTime)) return null;

  const now = new Date().toISOString();
  const endTime = schedule.endTime && TIME_RE.test(schedule.endTime)
    ? schedule.endTime
    : addOneHour(schedule.startTime);

  return {
    kind: "normal",
    id: generateId("event"),
    title,
    date: schedule.date,
    startTime: schedule.startTime,
    endTime,
    endDate: resolveEndDate(schedule.date, schedule.startTime, endTime),
    allDay: false,
    notification: { enabled: false, minutesBefore: 0 },
    repeat: { type: "none" },
    calendarId,
    shareWith: [],
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
}
