import { convertAiScheduleToNormalEvent } from "@/utils/aiScheduleToEvent";
import { AIScheduleSummary } from "@/types/ai";

/**
 * Demo AI の提案 → 実際の予定 への変換テスト。
 *
 * この変換は「AI の出力」と「アプリのデータモデル」の境界にあり、
 * ここを通らない値が保存されることは無い。したがって、
 *   - 壊れた提案を保存経路へ通さないこと（fail-closed）
 *   - 日をまたぐ終了時刻を正しく翌日として扱うこと
 * の 2 点がこのアプリの不変条件になる。
 */
const base: AIScheduleSummary = {
  title: "英語の勉強",
  date: "2026-08-20",
  startTime: "19:00",
  endTime: "20:00",
};
const CAL = "main";

describe("convertAiScheduleToNormalEvent", () => {
  it("正常な提案を通常予定へ変換する", () => {
    const e = convertAiScheduleToNormalEvent({ schedule: base, calendarId: CAL });
    expect(e).not.toBeNull();
    expect(e!.kind).toBe("normal");
    expect(e!.title).toBe("英語の勉強");
    expect(e!.date).toBe("2026-08-20");
    expect(e!.startTime).toBe("19:00");
    expect(e!.endTime).toBe("20:00");
    expect(e!.endDate).toBe("2026-08-20");
    expect(e!.calendarId).toBe(CAL);
    expect(e!.allDay).toBe(false);
    expect(e!.repeat).toEqual({ type: "none" });
    expect(e!.shareWith).toEqual([]);
  });

  it("id は毎回新規採番され、AI 側の値を持ち込まない", () => {
    const a = convertAiScheduleToNormalEvent({ schedule: base, calendarId: CAL });
    const b = convertAiScheduleToNormalEvent({ schedule: base, calendarId: CAL });
    expect(a!.id).not.toBe(b!.id);
    expect(a!.id.length).toBeGreaterThan(0);
  });

  it("endTime が無い提案には開始 1 時間後を補う", () => {
    const e = convertAiScheduleToNormalEvent({
      schedule: { title: "散歩", date: "2026-08-20", startTime: "07:30" },
      calendarId: CAL,
    });
    expect(e!.endTime).toBe("08:30");
    expect(e!.endDate).toBe("2026-08-20");
  });

  it("終了が開始以下なら翌日終了として endDate を進める", () => {
    const e = convertAiScheduleToNormalEvent({
      schedule: { ...base, startTime: "23:30", endTime: "00:30" },
      calendarId: CAL,
    });
    expect(e!.endDate).toBe("2026-08-21");
  });

  it("23:xx 開始で endTime 未指定なら日付をまたぐ", () => {
    const e = convertAiScheduleToNormalEvent({
      schedule: { title: "夜更かし", date: "2026-08-20", startTime: "23:30" },
      calendarId: CAL,
    });
    expect(e!.endTime).toBe("00:30");
    expect(e!.endDate).toBe("2026-08-21");
  });

  it("タイトルが空なら null を返し、保存経路へ入れない", () => {
    expect(convertAiScheduleToNormalEvent({
      schedule: { ...base, title: "   " }, calendarId: CAL,
    })).toBeNull();
  });

  it("日付の形式が不正なら null を返す", () => {
    expect(convertAiScheduleToNormalEvent({
      schedule: { ...base, date: "2026/08/20" }, calendarId: CAL,
    })).toBeNull();
  });

  it("開始時刻の形式が不正なら null を返す", () => {
    for (const bad of ["25:00", "9:00", "19:60", "", "19-00"]) {
      expect(convertAiScheduleToNormalEvent({
        schedule: { ...base, startTime: bad }, calendarId: CAL,
      })).toBeNull();
    }
  });

  it("保存先カレンダーが無ければ null を返す", () => {
    expect(convertAiScheduleToNormalEvent({ schedule: base, calendarId: "" })).toBeNull();
  });

  it("endTime の形式が不正な場合は無視して 1 時間後を使う（提案自体は捨てない）", () => {
    const e = convertAiScheduleToNormalEvent({
      schedule: { ...base, endTime: "99:99" }, calendarId: CAL,
    });
    expect(e).not.toBeNull();
    expect(e!.endTime).toBe("20:00");
  });
});
