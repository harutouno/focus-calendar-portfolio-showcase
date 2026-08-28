import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppDataProvider, useAppData } from "@/context/AppDataContext";
import { STORAGE_KEYS } from "@/storage/keys";
import { NormalEvent } from "@/types/event";
import { LocaleProvider } from "@/context/LocaleContext";
import { BASE_CALENDAR_ID } from "@/constants/options";
import { addDays } from "@/utils/date";

/**
 * [P0086 QA-F099] updateRecurringEvents（following/all編集）は、baseEventから
 * startTime/endTimeを他のsibling occurrenceへ伝播するが、以前は各siblingのendDateを
 * 一切再計算せず、siblingが元々持っていた（古いstartTime/endTime基準の）endDateを
 * そのまま残していた。同日完結の系列を日またぎへ編集する（またはその逆）と、
 * baseEvent自身は正しくendDateが更新されるが、following/allに含まれる他のsiblingは
 * 新しいstartTime/endTimeと矛盾したendDateのまま書込まれ、canonical write validator
 * （isValidAppEvent、[P0086 SPEC-F016-001]で強化済み）に拒否されていた。本テストは
 * ローカルカレンダー（BASE_CALENDAR_ID）の予定を使い、実際のupdateRecurringEvents→
 * saveEventsBulk→eventsRepository.saveEventsの実チェーンで、各siblingのendDateが
 * そのsibling自身のdate基準で正しく再計算されることを確認する。
 */

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    isSupabaseConfigured: false,
    session: null,
    signInWithMagicLink: jest.fn(),
    signOut: jest.fn(),
  }),
}));

jest.mock("@/services/notificationService", () => ({
  scheduleNotification: jest.fn().mockResolvedValue(undefined),
  cancelNotification: jest.fn().mockResolvedValue(undefined),
  scheduleNotifications: jest.fn().mockResolvedValue(undefined),
  cancelNotifications: jest.fn().mockResolvedValue(undefined),
  reconcileNotifications: jest.fn().mockResolvedValue(undefined),
  scheduleNotificationRequestingPermission: jest.fn().mockResolvedValue("scheduled"),
  scheduleNotificationsRequestingPermission: jest.fn().mockResolvedValue("scheduled"),
}));

jest.mock("@/lib/supabaseClient", () => ({
  isSupabaseConfigured: false,
  supabase: {
    from: jest.fn(),
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn().mockReturnThis(),
    })),
    removeChannel: jest.fn(),
  },
}));

jest.mock("@react-native-community/netinfo", () => ({
  fetch: jest.fn().mockResolvedValue({ isConnected: false }),
  addEventListener: jest.fn(() => () => {}),
}));

const GROUP_ID = "grp-f099";

function buildNormalEvent(overrides: Partial<NormalEvent> & Pick<NormalEvent, "id" | "date">): NormalEvent {
  const now = new Date().toISOString();
  return {
    kind: "normal",
    title: "毎週ミーティング",
    startTime: "10:00",
    endTime: "11:00",
    allDay: false,
    calendarId: BASE_CALENDAR_ID,
    shareWith: [],
    notification: { enabled: false, minutesBefore: 0 },
    repeat: { type: "weekly" },
    completed: false,
    createdAt: now,
    updatedAt: now,
    recurringGroupId: GROUP_ID,
    ...overrides,
  } as NormalEvent;
}

function renderAppData() {
  return renderHook(() => useAppData(), {
    wrapper: ({ children }) => (
      <LocaleProvider>
        <AppDataProvider>{children}</AppDataProvider>
      </LocaleProvider>
    ),
  });
}

describe("AppDataContext（[P0086 QA-F099] updateRecurringEventsのsibling endDate再計算）", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(STORAGE_KEYS.seedApplied, JSON.stringify(true));
  });

  it("同日完結の系列をfollowing/all編集で日またぎへ変更すると、baseEventだけでなく他のsiblingもそれぞれ自身のdate+1へendDateが再計算される", async () => {
    const base = buildNormalEvent({
      id: "f099-base",
      date: "2026-08-10",
      recurrenceIndex: 0,
      endDate: undefined,
    });
    const sibling = buildNormalEvent({
      id: "f099-sibling",
      date: "2026-08-17",
      recurrenceIndex: 1,
      endDate: undefined,
    });
    await AsyncStorage.setItem(STORAGE_KEYS.events, JSON.stringify([base, sibling]));

    const { result } = renderAppData();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    const updatedBase: NormalEvent = {
      ...base,
      startTime: "23:40",
      endTime: "00:40",
      endDate: addDays(base.date, 1),
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      await result.current.updateRecurringEvents(updatedBase, "all");
    });

    const persistedBase = result.current.events.find((e) => e.id === "f099-base") as NormalEvent;
    const persistedSibling = result.current.events.find((e) => e.id === "f099-sibling") as NormalEvent;

    expect(persistedBase.startTime).toBe("23:40");
    expect(persistedBase.endTime).toBe("00:40");
    expect(persistedBase.endDate).toBe(addDays("2026-08-10", 1));

    // [P0086 QA-F099] siblingは自身のdate（2026-08-17）基準で日またぎendDateが
    // 再計算される（baseEventのendDateをそのまま流用するのではなく）。
    expect(persistedSibling.startTime).toBe("23:40");
    expect(persistedSibling.endTime).toBe("00:40");
    expect(persistedSibling.endDate).toBe(addDays("2026-08-17", 1));
  });

  it("日またぎの系列をfollowing/all編集で同日完結へ変更すると、baseEventだけでなく他のsiblingのendDateも未指定へ戻る", async () => {
    const base = buildNormalEvent({
      id: "f099-base2",
      date: "2026-08-10",
      startTime: "23:40",
      endTime: "00:40",
      endDate: addDays("2026-08-10", 1),
      recurrenceIndex: 0,
    });
    const sibling = buildNormalEvent({
      id: "f099-sibling2",
      date: "2026-08-17",
      startTime: "23:40",
      endTime: "00:40",
      endDate: addDays("2026-08-17", 1),
      recurrenceIndex: 1,
    });
    await AsyncStorage.setItem(STORAGE_KEYS.events, JSON.stringify([base, sibling]));

    const { result } = renderAppData();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    const updatedBase: NormalEvent = {
      ...base,
      startTime: "10:00",
      endTime: "11:00",
      endDate: undefined,
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      await result.current.updateRecurringEvents(updatedBase, "all");
    });

    const persistedBase = result.current.events.find((e) => e.id === "f099-base2") as NormalEvent;
    const persistedSibling = result.current.events.find((e) => e.id === "f099-sibling2") as NormalEvent;

    expect(persistedBase.endDate).toBeUndefined();
    // [P0086 QA-F099] siblingの古い（日またぎ時代の）endDateが残ったままにならない。
    expect(persistedSibling.startTime).toBe("10:00");
    expect(persistedSibling.endTime).toBe("11:00");
    expect(persistedSibling.endDate).toBeUndefined();
  });

  it("全日予定のsiblingはstartTime/endTimeが伝播されてもendDateは常にundefinedのまま（[P0086 SPEC-F016-001]の全日ルールと一致）", async () => {
    const base = buildNormalEvent({
      id: "f099-base3",
      date: "2026-08-10",
      startTime: "10:00",
      endTime: "11:00",
      allDay: false,
      endDate: undefined,
      recurrenceIndex: 0,
    });
    const allDaySibling = buildNormalEvent({
      id: "f099-allday-sibling",
      date: "2026-08-17",
      startTime: "00:00",
      endTime: "23:59",
      allDay: true,
      endDate: undefined,
      recurrenceIndex: 1,
    });
    await AsyncStorage.setItem(STORAGE_KEYS.events, JSON.stringify([base, allDaySibling]));

    const { result } = renderAppData();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    const updatedBase: NormalEvent = {
      ...base,
      startTime: "23:40",
      endTime: "00:40",
      endDate: addDays(base.date, 1),
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      await result.current.updateRecurringEvents(updatedBase, "all");
    });

    const persistedAllDaySibling = result.current.events.find(
      (e) => e.id === "f099-allday-sibling"
    ) as NormalEvent;
    expect(persistedAllDaySibling.allDay).toBe(true);
    expect(persistedAllDaySibling.endDate).toBeUndefined();
  });
});
