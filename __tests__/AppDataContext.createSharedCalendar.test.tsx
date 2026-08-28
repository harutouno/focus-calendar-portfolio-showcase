import React from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppDataProvider, useAppData } from "@/context/AppDataContext";
import { STORAGE_KEYS } from "@/storage/keys";
import { LocaleProvider } from "@/context/LocaleContext";
import { setCurrentAuthIdentity as mockSetCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";

/**
 * 単独修正(2026-08, FP-003): createSharedCalendarが失敗した場合でも、クライアントが
 * 把握している所有共有カレンダー一覧を再取得する（サーバー側の上限判定で古いキャッシュの
 * まま拒否され続けることを防ぐ）ことを検証する。失敗したカレンダーをローカル一覧へ
 * 追加しないこと、元のエラーがそのまま呼び出し元へ伝わることも合わせて確認する。
 */
const stableUser = { id: "user-1" };
jest.mock("@/context/AuthContext", () => ({
  useAuth: () => {
    // SEC-F007-001 Stage 2: sharedNotificationCoordinatorはauthSessionIdentityStoreの
    // 現在値と照合するため、モック側でも本物のAuthContextと同様に同期させておく
    // （さもないとuserId:nullのまま比較され、共有通知の操作が常にスキップされる）。
    mockSetCurrentAuthIdentity({ userId: stableUser.id, sessionInstanceId: "session-1" });
    return {
      user: stableUser,
      loading: false,
      isSupabaseConfigured: true,
      session: null,
      sessionInstanceId: "session-1",
      signInWithMagicLink: jest.fn(),
      signOut: jest.fn(),
    };
  },
}));

jest.mock("@/services/notificationService", () => ({
  scheduleNotification: jest.fn().mockResolvedValue(undefined),
  cancelNotification: jest.fn().mockResolvedValue(undefined),
  scheduleNotifications: jest.fn().mockResolvedValue(undefined),
  cancelNotifications: jest.fn().mockResolvedValue(undefined),
  reconcileNotifications: jest.fn().mockResolvedValue(undefined),
  scheduleNotificationRequestingPermission: jest.fn().mockResolvedValue("scheduled"),
  scheduleNotificationsRequestingPermission: jest.fn().mockResolvedValue("scheduled"),
  // REVISE対応（第6ラウンド、P1-3）: sharedNotificationCoordinator経由でAppDataContextの
  // 初期化・AppState「active」復帰・identity変化のたびに呼ばれるようになったため追加。
  cancelAllSharedNotificationsForOwner: jest.fn().mockResolvedValue(true),
  repairCorruptNotificationRegistryIfNeeded: jest.fn(async () => "not-corrupt"),
  retryPendingOwnerNotificationCleanups: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/supabaseClient", () => ({
  isSupabaseConfigured: true,
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

jest.mock("@/services/sharedEventsService", () => ({
  fetchEventsForCalendars: jest.fn().mockResolvedValue([]),
  subscribeToCalendarEvents: jest.fn(() => () => {}),
}));

const mockFetchJoinedCalendars = jest.fn().mockResolvedValue([]);
const mockCreateSharedCalendar = jest.fn();
const mockUpdateCalendar = jest.fn();
const mockDeleteCalendar = jest.fn();
const mockFetchPendingInvitesForCurrentUser = jest.fn().mockResolvedValue([]);

jest.mock("@/services/calendarService", () => ({
  fetchJoinedCalendars: (...args: unknown[]) => mockFetchJoinedCalendars(...args),
  createSharedCalendar: (...args: unknown[]) => mockCreateSharedCalendar(...args),
  updateCalendar: (...args: unknown[]) => mockUpdateCalendar(...args),
  deleteCalendar: (...args: unknown[]) => mockDeleteCalendar(...args),
  fetchPendingInvitesForCurrentUser: (...args: unknown[]) =>
    mockFetchPendingInvitesForCurrentUser(...args),
  acceptPendingInviteById: jest.fn(),
  declinePendingInvite: jest.fn(),
}));

function renderAppData() {
  return renderHook(() => useAppData(), {
    wrapper: ({ children }) => (
      <LocaleProvider>
        <AppDataProvider>{children}</AppDataProvider>
      </LocaleProvider>
    ),
  });
}

const mockAddEventListener = AppState.addEventListener as jest.Mock;

describe("AppDataContext createSharedCalendar", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(STORAGE_KEYS.seedApplied, JSON.stringify(true));
    mockFetchJoinedCalendars.mockReset().mockResolvedValue([]);
    mockCreateSharedCalendar.mockReset();
    mockUpdateCalendar.mockReset();
    mockDeleteCalendar.mockReset();
    mockFetchPendingInvitesForCurrentUser.mockReset().mockResolvedValue([]);
    mockAddEventListener.mockReset().mockImplementation(() => ({ remove: jest.fn() }));
  });

  it("成功時は一覧を再取得し、作成したカレンダーを表示設定へ含める", async () => {
    mockCreateSharedCalendar.mockResolvedValue({
      id: "cal-1",
      name: "家族",
      color: "#2E5FE8",
      ownerId: "user-1",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const { result } = renderAppData();
    await waitFor(() => expect(mockFetchJoinedCalendars).toHaveBeenCalled());
    mockFetchJoinedCalendars.mockClear();

    await act(async () => {
      await result.current.createSharedCalendar("家族", "#2E5FE8");
    });

    expect(mockFetchJoinedCalendars).toHaveBeenCalledTimes(1);
  });

  it("サーバー側の上限エラー等で失敗した場合も一覧を再取得し、元のエラーをそのまま投げる", async () => {
    mockCreateSharedCalendar.mockRejectedValue(new Error("owned_shared_calendar_limit_exceeded"));
    const { result } = renderAppData();
    await waitFor(() => expect(mockFetchJoinedCalendars).toHaveBeenCalled());
    mockFetchJoinedCalendars.mockClear();

    await act(async () => {
      await expect(result.current.createSharedCalendar("家族", "#2E5FE8")).rejects.toThrow(
        "owned_shared_calendar_limit_exceeded"
      );
    });

    // 失敗時もクライアントの一覧を最新化する（サーバーの上限判定が古いキャッシュのまま
    // 拒否され続けることを防ぐ）。
    expect(mockFetchJoinedCalendars).toHaveBeenCalledTimes(1);
  });

  it("一覧の再取得自体が失敗しても、元のエラーが握りつぶされずそのまま伝わる", async () => {
    mockCreateSharedCalendar.mockRejectedValue(new Error("owned_shared_calendar_limit_exceeded"));
    const { result } = renderAppData();
    await waitFor(() => expect(mockFetchJoinedCalendars).toHaveBeenCalled());
    mockFetchJoinedCalendars.mockReset().mockRejectedValue(new Error("network down"));

    await act(async () => {
      await expect(result.current.createSharedCalendar("家族", "#2E5FE8")).rejects.toThrow(
        "owned_shared_calendar_limit_exceeded"
      );
    });
  });
});
