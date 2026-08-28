import { eventRange, layoutEventsForDay, HOUR_HEIGHT, START_HOUR } from "@/components/calendar/timelineLayout";
import { FocusTask, NormalEvent } from "@/types/event";

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

describe("eventRange（P0080 CORRECT-F016-002: dateを必須パラメータへ変更）", () => {
  it("同日で完結する通常予定は従来どおりの範囲・isStartDay=trueを返す", () => {
    const event = buildNormalEvent({ date: "2026-08-11", startTime: "10:00", endTime: "11:00" });
    expect(eventRange(event, "2026-08-11")).toEqual({ start: 600, end: 660, isStartDay: true });
  });

  it("日付をまたぐ通常予定: 開始日では23:40〜24:00（isStartDay=true）", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:40",
      endTime: "00:40",
      endDate: "2026-08-12",
    });
    expect(eventRange(event, "2026-08-11")).toEqual({ start: 1420, end: 1440, isStartDay: true });
  });

  it("日付をまたぐ通常予定: 終了日（継続日）では00:00〜00:40（isStartDay=false）", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:40",
      endTime: "00:40",
      endDate: "2026-08-12",
    });
    expect(eventRange(event, "2026-08-12")).toEqual({ start: 0, end: 40, isStartDay: false });
  });

  it("FocusTaskはdurationMinutesベースの範囲を返す（回帰、all-day/FocusTask挙動は無変更）", () => {
    const task = buildFocusTask({ date: "2026-08-11", startTime: "19:00", durationMinutes: 90 });
    expect(eventRange(task, "2026-08-11")).toEqual({ start: 1140, end: 1230, isStartDay: true });
  });
});

describe("layoutEventsForDay（P0080 CORRECT-F016-002: overnight継続の座標計算）", () => {
  it("開始日側のブロックは23:40から24:00まで（20分）の高さを持ち、isStartDay=trueになる", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:40",
      endTime: "00:40",
      endDate: "2026-08-12",
    });
    const positioned = layoutEventsForDay([event], "2026-08-11");
    expect(positioned).toHaveLength(1);
    const item = positioned[0];
    expect(item.isStartDay).toBe(true);
    expect(item.top).toBe((23 * 60 + 40 - START_HOUR * 60) * (HOUR_HEIGHT / 60));
    // 20分 * (HOUR_HEIGHT/60) = 20px は既存の最小高さ28px（タップしやすさのための下限、
    // layoutEventsForDayのMath.max(..., 28)）でクランプされる——このクランプ自体は
    // P0080の対象外の既存仕様のため変更しない。
    expect(item.height).toBe(28);
  });

  it("継続日側のブロックは00:00から00:40まで（40分）の高さを持ち、isStartDay=falseになる", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:40",
      endTime: "00:40",
      endDate: "2026-08-12",
    });
    const positioned = layoutEventsForDay([event], "2026-08-12");
    expect(positioned).toHaveLength(1);
    const item = positioned[0];
    expect(item.isStartDay).toBe(false);
    expect(item.top).toBe(0);
    expect(item.height).toBeCloseTo(40 * (HOUR_HEIGHT / 60));
  });

  it("同日で完結する予定の座標計算は従来どおり変化しない（回帰）", () => {
    const event = buildNormalEvent({ date: "2026-08-11", startTime: "10:00", endTime: "11:00" });
    const positioned = layoutEventsForDay([event], "2026-08-11");
    expect(positioned[0]).toMatchObject({
      top: 600,
      height: 60,
      columnIndex: 0,
      columnCount: 1,
      isStartDay: true,
    });
  });

  it("23:00→00:00境界の予定は、開始日で60分ぶんの高さになる（旧実装の23:59クランプ・end>start?end:start+30フォールバックのいずれも使わない）", () => {
    const event = buildNormalEvent({
      date: "2026-08-11",
      startTime: "23:00",
      endTime: "00:00",
      endDate: "2026-08-12",
    });
    const positioned = layoutEventsForDay([event], "2026-08-11");
    expect(positioned[0].height).toBeCloseTo(60 * (HOUR_HEIGHT / 60));
  });
});
