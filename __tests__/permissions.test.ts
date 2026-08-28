import { NormalEvent } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";
import { canEditEvent, dragDisabledReason } from "@/utils/permissions";
import { translate } from "@/i18n/translations";

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
  translate("ja", key, vars);

function buildEvent(calendarId: string): NormalEvent {
  const now = new Date().toISOString();
  return {
    id: "evt-1",
    kind: "normal",
    title: "予定",
    date: "2026-07-22",
    startTime: "10:00",
    endTime: "11:00",
    allDay: false,
    calendarId,
    shareWith: [],
    notification: { enabled: true, minutesBefore: 10 },
    repeat: { type: "none" },
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
}

function buildSummary(
  calendarId: string,
  role: JoinedCalendarSummary["role"]
): JoinedCalendarSummary {
  return {
    calendar: {
      id: calendarId,
      name: "共有カレンダー",
      color: "#2E5FE8",
      ownerId: "owner-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    role,
    memberCount: 2,
    memberPreviews: [],
  };
}

describe("canEditEvent", () => {
  it("端末内カレンダー（sharedCalendarsに存在しない）は常に編集可能", () => {
    const event = buildEvent("main");
    expect(canEditEvent(event, [])).toBe(true);
    expect(dragDisabledReason(event, [], t)).toBeNull();
  });

  it("共有カレンダーのownerは編集可能", () => {
    const event = buildEvent("cal-1");
    const summaries = [buildSummary("cal-1", "owner")];
    expect(canEditEvent(event, summaries)).toBe(true);
  });

  it("共有カレンダーのeditorは編集可能", () => {
    const event = buildEvent("cal-1");
    const summaries = [buildSummary("cal-1", "editor")];
    expect(canEditEvent(event, summaries)).toBe(true);
  });

  it("共有カレンダーのviewerは編集不可で、理由が返る", () => {
    const event = buildEvent("cal-1");
    const summaries = [buildSummary("cal-1", "viewer")];
    expect(canEditEvent(event, summaries)).toBe(false);
    expect(dragDisabledReason(event, summaries, t)).toMatch(/閲覧のみ/);
  });

  it("別カレンダーの権限情報は影響しない", () => {
    const event = buildEvent("cal-2");
    const summaries = [buildSummary("cal-1", "viewer")];
    expect(canEditEvent(event, summaries)).toBe(true);
  });
});
