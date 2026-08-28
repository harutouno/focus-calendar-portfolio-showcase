import React from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { FocusTask } from "@/types/event";
import { useAppData } from "@/context/AppDataContext";
import {
  FocusTaskForm,
  FocusTaskFormValue,
} from "@/components/forms/FocusTaskForm";
import { generateId } from "@/utils/id";
import { todayLocalDateString } from "@/utils/date";
import { resolveDefaultCalendarId, resolveDefaultEventStart } from "@/utils/time";

export default function NewFocusTaskScreen() {
  const router = useRouter();
  const { saveEvent, userCalendars, sharedCalendars, lastUsedCalendarId, recordLastUsedCalendar } =
    useAppData();
  // Stage I-8.7: 日別予定一覧から遷移した場合、その日を初期値にする（未指定なら今日）。
  // 開始時刻は通常予定（app/event/new.tsx）と共通のresolveDefaultEventStartを使い、
  // 固定値ではなく現在時刻を初期値にする。
  const params = useLocalSearchParams<{ date?: string }>();
  const { date, startTime } = resolveDefaultEventStart(params, todayLocalDateString());
  const initial: FocusTaskFormValue = {
    title: "",
    date,
    startTime,
    durationMinutes: 60,
    restrictedApps: [],
    notificationMinutes: 10,
    repeatType: "none",
    unlockConditionType: "none",
    unlockCount: 30,
    memo: "",
    calendarId: resolveDefaultCalendarId(lastUsedCalendarId, userCalendars, sharedCalendars),
  };

  const handleSave = async (value: FocusTaskFormValue) => {
    const now = new Date().toISOString();
    const event: FocusTask = {
      id: generateId("evt"),
      kind: "focus",
      title: value.title.trim(),
      date: value.date,
      startTime: value.startTime,
      durationMinutes: value.durationMinutes,
      restrictedApps: value.restrictedApps,
      unlockCondition: {
        type: value.unlockConditionType,
        count:
          value.unlockConditionType === "calculation"
            ? value.unlockCount
            : undefined,
      },
      calendarId: value.calendarId,
      shareWith: [],
      notification: {
        enabled: value.notificationMinutes >= 0,
        minutesBefore: Math.max(value.notificationMinutes, 0),
      },
      repeat: { type: value.repeatType },
      memo: value.memo.trim() || undefined,
      completed: false,
      createdAt: now,
      updatedAt: now,
    };
    await saveEvent(event);
    await recordLastUsedCalendar(value.calendarId);
    router.back();
  };

  return (
    <FocusTaskForm
      initial={initial}
      isEditing={false}
      userCalendars={userCalendars}
      sharedCalendars={sharedCalendars}
      onSave={handleSave}
      onViewRecords={() => router.push("/records")}
    />
  );
}
