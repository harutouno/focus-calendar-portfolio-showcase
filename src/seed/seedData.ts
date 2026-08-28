import { AppEvent } from "@/types/event";
import { addDays, getWeekday, todayLocalDateString } from "@/utils/date";
import { generateId } from "@/utils/id";
import { readJSON, writeJSON } from "@/storage/storage";
import { STORAGE_KEYS } from "@/storage/keys";
import { getAllEvents, replaceAllEvents } from "@/storage/eventsRepository";
import { FOCUS_CALENDAR_ID } from "@/constants/options";
import { TFunction } from "@/i18n/translations";

/**
 * 初回起動時のみ、reference_images に近い見え方を確認できる少量のデモ予定を投入する。
 * ・二重生成を防ぐため、投入済みフラグを永続化する
 * ・ユーザーが削除しても、フラグが立っている限り再投入しない
 */
function buildSeedEvents(t: TFunction): AppEvent[] {
  const today = todayLocalDateString();
  const now = new Date().toISOString();

  const mk = {
    normal: (
      offsetDays: number,
      title: string,
      start: string,
      end: string,
      calendarId: string
    ): AppEvent => ({
      id: generateId("evt"),
      kind: "normal",
      title,
      date: addDays(today, offsetDays),
      startTime: start,
      endTime: end,
      allDay: false,
      calendarId,
      shareWith: [],
      notification: { enabled: true, minutesBefore: 30 },
      repeat: { type: "none" },
      completed: false,
      createdAt: now,
      updatedAt: now,
    }),
    focus: (
      offsetDays: number,
      title: string,
      start: string,
      durationMinutes: number
    ): AppEvent => ({
      id: generateId("evt"),
      kind: "focus",
      title,
      date: addDays(today, offsetDays),
      startTime: start,
      durationMinutes,
      calendarId: FOCUS_CALENDAR_ID,
      shareWith: [],
      restrictedApps: ["youtube", "x", "game"],
      unlockCondition: { type: "calculation", count: 30 },
      notification: { enabled: true, minutesBefore: 10 },
      repeat: { type: "none" },
      completed: false,
      createdAt: now,
      updatedAt: now,
    }),
  };

  const work = t("seedData.work");
  const meeting = t("seedData.meeting");
  const hospitalVisit = t("seedData.hospitalVisit");
  const novel = t("seedData.novel");
  const awsStudy = t("aiMock.sampleTaskTitle");

  const events: AppEvent[] = [];
  // 平日の仕事
  for (let i = -3; i <= 3; i++) {
    const d = addDays(today, i);
    const weekday = getWeekday(d);
    if (weekday >= 1 && weekday <= 5) {
      events.push(mk.normal(i, work, "09:00", "12:00", "work"));
    }
  }
  events.push(mk.normal(-2, meeting, "10:00", "11:00", "work"));
  events.push(mk.normal(1, meeting, "10:00", "11:00", "work"));
  events.push(mk.normal(3, meeting, "11:00", "12:00", "work"));
  events.push(mk.normal(-3, hospitalVisit, "13:00", "14:00", "health"));
  events.push(mk.normal(0, hospitalVisit, "13:00", "14:00", "health"));
  events.push(mk.normal(-3, hospitalVisit, "19:00", "20:00", "health"));
  events.push(mk.normal(-2, novel, "15:00", "16:00", "hobby"));
  events.push(mk.normal(-2, novel, "17:00", "18:00", "hobby"));
  events.push(mk.normal(0, novel, "17:00", "18:00", "hobby"));

  events.push(mk.focus(-3, awsStudy, "13:00", 60));
  events.push(mk.focus(0, awsStudy, "19:00", 60));
  events.push(mk.focus(1, awsStudy, "15:00", 60));
  events.push(mk.focus(3, awsStudy, "13:00", 60));
  events.push(mk.focus(3, awsStudy, "19:00", 60));

  return events;
}

export async function applySeedDataIfNeeded(t: TFunction): Promise<void> {
  // DATA-F002-002: Category C（補助的データ）。厳密に`=== true`だけを「適用済み」と扱う
  // （不正な形状の値、例えば文字列"false"のような紛らわしい値がtruthy判定で誤って
  // 「適用済み」扱いになってしまう事故を防ぐ）。
  const rawSeedApplied = await readJSON<unknown>(STORAGE_KEYS.seedApplied, false);
  const alreadyApplied = rawSeedApplied === true;
  if (alreadyApplied) return;

  const existing = await getAllEvents();
  if (existing.length === 0) {
    await replaceAllEvents(buildSeedEvents(t));
  }
  await writeJSON(STORAGE_KEYS.seedApplied, true);
}
