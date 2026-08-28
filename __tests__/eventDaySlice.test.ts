import { eventTouchedDates, getNormalEventDaySlice } from "@/utils/eventDaySlice";
import { AppEvent, FocusTask, NormalEvent } from "@/types/event";

function buildNormalEvent(overrides: Partial<NormalEvent> = {}): NormalEvent {
  const now = new Date().toISOString();
  return {
    id: "evt-1",
    kind: "normal",
    title: "テスト予定",
    date: "2026-08-11",
    startTime: "10:00",
    endTime: "11:00",
    allDay: false,
    calendarId: "cal-1",
    shareWith: [],
    notification: { enabled: true, minutesBefore: 10 },
    repeat: { type: "none" },
    completed: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildFocusTask(overrides: Partial<FocusTask> = {}): FocusTask {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    kind: "focus",
    title: "集中",
    date: "2026-08-11",
    startTime: "19:00",
    durationMinutes: 60,
    restrictedApps: [],
    unlockCondition: { type: "none" },
    calendarId: "cal-1",
    shareWith: [],
    notification: { enabled: true, minutesBefore: 10 },
    repeat: { type: "none" },
    completed: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("getNormalEventDaySlice（P0080 CORRECT-F016-002: 唯一の投影権限）", () => {
  it("正本の必須例: 2026-08-11 23:40 → 2026-08-12 00:40 は開始日23:40-24:00（20分）を返す", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:40",
      endTime: "00:40",
      endDate: "2026-08-12",
    });
    const slice = getNormalEventDaySlice(event, "2026-08-11");
    expect(slice).toEqual({ startMinutes: 23 * 60 + 40, endMinutes: 24 * 60 });
    expect((slice!.endMinutes - slice!.startMinutes)).toBe(20);
  });

  it("正本の必須例: 終了日側は00:00-00:40（40分）を返す", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:40",
      endTime: "00:40",
      endDate: "2026-08-12",
    });
    const slice = getNormalEventDaySlice(event, "2026-08-12");
    expect(slice).toEqual({ startMinutes: 0, endMinutes: 40 });
    expect((slice!.endMinutes - slice!.startMinutes)).toBe(40);
  });

  it("同日で完結する予定は、開始・終了ともに従来どおりの時刻をそのまま返す（回帰）", () => {
    const event = buildNormalEvent({ date: "2026-08-11", startTime: "10:00", endTime: "11:30" });
    const slice = getNormalEventDaySlice(event, "2026-08-11");
    expect(slice).toEqual({ startMinutes: 10 * 60, endMinutes: 11 * 60 + 30 });
  });

  it("23:00→00:00の境界: 開始日は23:00-24:00（60分）", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:00",
      endTime: "00:00",
      endDate: "2026-08-12",
    });
    const slice = getNormalEventDaySlice(event, "2026-08-11");
    expect(slice).toEqual({ startMinutes: 23 * 60, endMinutes: 24 * 60 });
  });

  it("23:00→00:00の境界: 翌日側はちょうど0分のため継続スライスなし（null）", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:00",
      endTime: "00:00",
      endDate: "2026-08-12",
    });
    const slice = getNormalEventDaySlice(event, "2026-08-12");
    expect(slice).toBeNull();
  });

  it("旧実装のフォールバック（end > start ? end : start + 30）は使われない: 23:40開始・00:40終了を開始日で問い合わせても30分固定にはならない", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:40",
      endTime: "00:40",
      endDate: "2026-08-12",
    });
    const slice = getNormalEventDaySlice(event, "2026-08-11");
    // 旧実装なら { start: 1420, end: 1450 }（=00:10、日付境界を超えた不正な値）を返していた。
    expect(slice!.endMinutes).not.toBe(23 * 60 + 40 + 30);
    expect(slice!.endMinutes).toBeLessThanOrEqual(1440);
  });

  it("予定に一切触れない日付を問い合わせるとnullを返す", () => {
    const event = buildNormalEvent({ date: "2026-08-11", startTime: "10:00", endTime: "11:00" });
    expect(getNormalEventDaySlice(event, "2026-08-10")).toBeNull();
    expect(getNormalEventDaySlice(event, "2026-08-12")).toBeNull();
  });

  it("endDateが開始日と同じ値（冗長な同日指定）でも同日として扱う", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "10:00",
      endTime: "11:00",
      endDate: "2026-08-11",
    });
    expect(getNormalEventDaySlice(event, "2026-08-11")).toEqual({
      startMinutes: 10 * 60,
      endMinutes: 11 * 60,
    });
  });
});

describe("eventTouchedDates（P0080 CORRECT-F016-002）", () => {
  it("日付をまたがない通常予定は単一日を返す", () => {
    const event: AppEvent = buildNormalEvent({ date: "2026-08-11" });
    expect(eventTouchedDates(event)).toEqual(["2026-08-11"]);
  });

  it("日付をまたぐ通常予定は開始日・終了日の2件を返す", () => {
    const event: AppEvent = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:40",
      endTime: "00:40",
      endDate: "2026-08-12",
    });
    expect(eventTouchedDates(event)).toEqual(["2026-08-11", "2026-08-12"]);
  });

  it("終日予定（endDate未設定）は単一日を返す", () => {
    const event: AppEvent = buildNormalEvent({ date: "2026-08-11", allDay: true, endDate: undefined });
    expect(eventTouchedDates(event)).toEqual(["2026-08-11"]);
  });

  it("FocusTaskは常に単一日を返す（[P0080]all-day/FocusTask挙動は無変更の要件）", () => {
    const task: AppEvent = buildFocusTask({ date: "2026-08-11" });
    expect(eventTouchedDates(task)).toEqual(["2026-08-11"]);
  });
});
