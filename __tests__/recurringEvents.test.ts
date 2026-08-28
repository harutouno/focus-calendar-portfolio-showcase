import { NormalEvent } from "@/types/event";
import { selectRecurringTargets } from "@/utils/recurringEvents";

function buildEvent(
  id: string,
  overrides: Partial<NormalEvent> = {}
): NormalEvent {
  const now = new Date().toISOString();
  return {
    id,
    kind: "normal",
    title: "ジム",
    date: "2026-08-02",
    startTime: "10:00",
    endTime: "11:00",
    allDay: false,
    calendarId: "cal-1",
    shareWith: [],
    notification: { enabled: false, minutesBefore: 0 },
    repeat: { type: "none" },
    completed: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("selectRecurringTargets", () => {
  function buildSeries(groupId: string, count: number): NormalEvent[] {
    return Array.from({ length: count }, (_, i) =>
      buildEvent(`evt-${i}`, { recurringGroupId: groupId, recurrenceIndex: i })
    );
  }

  it("recurringGroupIdが無い通常予定は、scopeによらずbaseEvent単体のみを返す", () => {
    const normal = buildEvent("normal-1");
    const allEvents = [normal, ...buildSeries("group-x", 3)];

    expect(selectRecurringTargets(allEvents, normal, "single")).toEqual([normal]);
    expect(selectRecurringTargets(allEvents, normal, "following")).toEqual([normal]);
    expect(selectRecurringTargets(allEvents, normal, "all")).toEqual([normal]);
  });

  it('"single"はscopeに関わらずbaseEvent単体のみを返す（繰り返し予定でも）', () => {
    const series = buildSeries("group-1", 5);
    const base = series[2];
    const result = selectRecurringTargets(series, base, "single");
    expect(result).toEqual([base]);
  });

  it('"all"は同じrecurringGroupIdを持つ全予定を返す（recurrenceIndexに関わらず）', () => {
    const series = buildSeries("group-2", 5);
    const base = series[2]; // recurrenceIndex = 2
    const result = selectRecurringTargets(series, base, "all");
    expect(result).toHaveLength(5);
    expect(result.map((e) => e.id).sort()).toEqual(series.map((e) => e.id).sort());
  });

  it('"following"はrecurrenceIndexがbaseEvent以上の予定のみを返す', () => {
    const series = buildSeries("group-3", 5); // index 0..4
    const base = series[2]; // recurrenceIndex = 2
    const result = selectRecurringTargets(series, base, "following");
    expect(result.map((e) => e.recurrenceIndex).sort()).toEqual([2, 3, 4]);
  });

  it('"following"を最初の予定(recurrenceIndex=0)で選ぶと"all"と同じ結果になる', () => {
    const series = buildSeries("group-4", 4);
    const base = series[0];
    const result = selectRecurringTargets(series, base, "following");
    expect(result).toHaveLength(4);
  });

  it('"following"を最後の予定で選ぶと自分自身のみを返す', () => {
    const series = buildSeries("group-5", 4); // index 0..3
    const base = series[3];
    const result = selectRecurringTargets(series, base, "following");
    expect(result.map((e) => e.id)).toEqual([base.id]);
  });

  it("別のrecurringGroupIdの予定は対象に含まれない", () => {
    const seriesA = buildSeries("group-a", 3);
    const seriesB = buildSeries("group-b", 3);
    const allEvents = [...seriesA, ...seriesB];
    const base = seriesA[0];

    const all = selectRecurringTargets(allEvents, base, "all");
    expect(all.every((e) => e.recurringGroupId === "group-a")).toBe(true);
    expect(all).toHaveLength(3);

    const following = selectRecurringTargets(allEvents, base, "following");
    expect(following.every((e) => e.recurringGroupId === "group-a")).toBe(true);
  });
});
