import React from "react";
import { Alert } from "react-native";
import { act, render, waitFor } from "@testing-library/react-native";
import CalendarInviteScreen from "../app/calendar/[id]/invite";
import CalendarSettingsScreen from "../app/calendar/[id]/settings";
import { CalendarInvite, JoinedCalendarSummary } from "@/types/sharing";
import { UserCalendar } from "@/types/event";
import { LocaleProvider } from "@/context/LocaleContext";
import { setCurrentAuthIdentity as mockSetCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";

/**
 * P0178 CLIENT children — CORRECT-F024-003 の client 側 2 子問題。
 *
 * ```text
 * CLIENT-B  INVITE_ISSUANCE_SCOPE をクライアントが判定できない
 *           （fetchInvites が invitee_email を取ってこない）
 *           -> targeted 招待を generic viewer-link 権威と誤分類する
 *           -> generic リンクを得るためだけに他人宛の招待を失効させる
 *
 * CLIENT-C  再発行中に古い lastLink（既に supersede 済み）を Clipboard へ出せる
 * ```
 *
 * 4 概念の分離は `src/utils/inviteAuthority.ts` に純関数として置いてある。
 * 本ファイルは**画面の実挙動**がその分離に従うことを検証する。
 */

jest.mock("expo-localization", () => ({
  getLocales: () => [{ languageCode: "ja", languageTag: "ja-JP" }],
}));

jest.mock("@expo/vector-icons", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createElement } = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  return {
    Ionicons: (props: { name: string; [key: string]: unknown }) =>
      createElement(Text, props, props.name),
  };
});

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "shared-1" }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

jest.mock("expo-linking", () => ({ createURL: (path: string) => `focuscalendar://${path}` }));

const mockClipboardSetStringAsync = jest.fn().mockResolvedValue(undefined);
jest.mock("expo-clipboard", () => ({
  setStringAsync: (...args: unknown[]) => mockClipboardSetStringAsync(...args),
}));

jest.mock("react-native/Libraries/Share/Share", () => {
  const share = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, share, default: { share } };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock で差し替えた実体を直接参照する
const mockShare = require("react-native/Libraries/Share/Share").share as jest.Mock;

// Portfolio Edition: 画像ピッカー・署名 URL は公開版に含まれないため mock も不要。

let mockSharedCalendars: JoinedCalendarSummary[] = [];
let mockUserCalendars: UserCalendar[] = [];
jest.mock("@/context/AppDataContext", () => ({
  useAppData: () => ({
    sharedCalendars: mockSharedCalendars,
    userCalendars: mockUserCalendars,
    favoriteCalendarIds: [],
    toggleFavoriteCalendar: jest.fn(),
    updateUserCalendar: jest.fn().mockResolvedValue(undefined),
    removeUserCalendar: jest.fn().mockResolvedValue(undefined),
    updateSharedCalendar: jest.fn().mockResolvedValue(undefined),
    deleteSharedCalendar: jest.fn().mockResolvedValue(undefined),
    refreshShared: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => {
    mockSetCurrentAuthIdentity({ userId: "user-1", sessionInstanceId: "session-1" });
    return { user: { id: "user-1" }, sessionInstanceId: "session-1" };
  },
}));

const mockCreateInvite = jest.fn();
const mockRevokeInvite = jest.fn();
const mockFetchInvites = jest.fn();
const mockFetchCalendarMembers = jest.fn();
const mockFetchSharedCalendarMemberLimitStatus = jest.fn();
jest.mock("@/services/calendarService", () => ({
  createInvite: (...args: unknown[]) => mockCreateInvite(...args),
  revokeInvite: (...args: unknown[]) => mockRevokeInvite(...args),
  fetchInvites: (...args: unknown[]) => mockFetchInvites(...args),
  fetchCalendarMembers: (...args: unknown[]) => mockFetchCalendarMembers(...args),
  fetchSharedCalendarMemberLimitStatus: (...args: unknown[]) =>
    mockFetchSharedCalendarMemberLimitStatus(...args),
  removeMember: jest.fn(),
  updateMemberRole: jest.fn(),
}));


// ── ヘルパー ─────────────────────────────────────────────────────────

interface TestNode {
  props: Record<string, unknown>;
  parent: TestNode | null;
}

function findEnabledHandler(
  node: TestNode,
  prop: "onPress" | "onValueChange"
): (...args: never[]) => unknown {
  let cur: TestNode | null = node;
  while (cur) {
    const handler = (cur.props as Record<string, unknown>)[prop];
    if (typeof handler === "function" && (cur.props as { disabled?: boolean }).disabled !== true) {
      return handler as (...args: never[]) => unknown;
    }
    cur = cur.parent;
  }
  throw new Error(`enabled ${prop} handler not found`);
}

/** 要素が（祖先も含めて）disabled になっているか。 */
function isDisabled(node: TestNode): boolean {
  let cur: TestNode | null = node;
  while (cur) {
    if ((cur.props as { disabled?: boolean }).disabled === true) return true;
    cur = cur.parent;
  }
  return false;
}

/** Switch の現在値を読む。 */
function switchValue(node: TestNode): boolean | undefined {
  let cur: TestNode | null = node;
  while (cur) {
    const v = (cur.props as { value?: unknown }).value;
    if (typeof v === "boolean") return v;
    cur = cur.parent;
  }
  return undefined;
}

function buildSummary(): JoinedCalendarSummary {
  return {
    calendar: {
      id: "shared-1",
      name: "家族の予定",
      color: "#2E5FE8",
      ownerId: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    role: "owner",
    memberCount: 1,
    memberPreviews: [],
  };
}

/** Alice 宛の TARGETED viewer 招待。generic リンクでは決してない。 */
function buildTargetedAliceViewerInvite(): CalendarInvite {
  return {
    id: "inv-targeted-alice",
    calendarId: "shared-1",
    role: "viewer",
    createdBy: "user-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    inviteeEmail: "alice@example.com",
  };
}

function renderSettings() {
  return render(
    <LocaleProvider>
      <CalendarSettingsScreen />
    </LocaleProvider>
  );
}
function renderInvite() {
  return render(
    <LocaleProvider>
      <CalendarInviteScreen />
    </LocaleProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSetCurrentAuthIdentity({ userId: "user-1", sessionInstanceId: "session-1" });
  mockSharedCalendars = [buildSummary()];
  mockUserCalendars = [];
  mockFetchInvites.mockResolvedValue([]);
  mockFetchCalendarMembers.mockResolvedValue([]);
  mockClipboardSetStringAsync.mockResolvedValue(undefined);
  mockShare.mockResolvedValue(undefined);
  mockRevokeInvite.mockResolvedValue(undefined);
  mockFetchSharedCalendarMemberLimitStatus.mockResolvedValue({
    memberLimit: 5,
    currentMemberCount: 1,
    activeInviteCount: 0,
    usedSlotCount: 1,
    remainingSlots: 4,
    limitReached: false,
  });
});

// ════════════════════════════════════════════════════════════════════
// CLIENT-B — generic と targeted の分離
// ════════════════════════════════════════════════════════════════════

describe("P0178 CLIENT-B: generic viewer-link と targeted 招待の分離", () => {
  it("B1: targeted な Alice 宛 viewer 招待しか無いとき、generic Switch は OFF", async () => {
    mockFetchInvites.mockResolvedValue([buildTargetedAliceViewerInvite()]);
    const { findByLabelText } = renderSettings();
    await waitFor(() => expect(mockFetchInvites).toHaveBeenCalled());

    const toggle = (await findByLabelText("招待リンクを有効にする")) as unknown as TestNode;
    // generic viewer-link は存在しないので OFF でなければならない。
    expect(switchValue(toggle)).toBe(false);
  });

  it("B2: targeted 招待しか無いとき、generic リンクの Copy/Share は targeted を失効させない", async () => {
    mockFetchInvites.mockResolvedValue([buildTargetedAliceViewerInvite()]);
    mockCreateInvite.mockResolvedValue({
      invite: { ...buildTargetedAliceViewerInvite(), id: "inv-generic-new", inviteeEmail: undefined },
      token: "tok-generic",
    });
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

    const { findByText } = renderSettings();
    await waitFor(() => expect(mockFetchInvites).toHaveBeenCalled());

    // generic リンクがまだ無い状態では Copy/Share は押せない（disabled）。
    // 押せてしまう場合でも、targeted 招待を revoke してはならない。
    const copyNode = (await findByText("リンクをコピー")) as unknown as TestNode;
    if (!isDisabled(copyNode)) {
      await act(async () => {
        await findEnabledHandler(copyNode, "onPress")();
      });
    }

    const revokedIds = mockRevokeInvite.mock.calls.map((c) => c[0]);
    expect(revokedIds).not.toContain("inv-targeted-alice");
    alertSpy.mockRestore();
  });

  it("B3: generic viewer リンクが存在するときは Switch が ON になる（正しい肯定側）", async () => {
    mockFetchInvites.mockResolvedValue([
      {
        id: "inv-generic-viewer",
        calendarId: "shared-1",
        role: "viewer",
        createdBy: "user-1",
        createdAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      } as CalendarInvite,
    ]);
    const { findByLabelText } = renderSettings();
    await waitFor(() => expect(mockFetchInvites).toHaveBeenCalled());
    const toggle = (await findByLabelText("招待リンクを有効にする")) as unknown as TestNode;
    expect(switchValue(toggle)).toBe(true);
  });

  it("B4: 受諾済みでも未取消・未期限切れの generic リンクは現在の資格として ON のまま", async () => {
    // token 受諾経路（0020 G2）は accepted_at を拒否しないため、
    // 受諾済み generic link は依然として「今の招待リンク」である。
    mockFetchInvites.mockResolvedValue([
      {
        id: "inv-generic-accepted",
        calendarId: "shared-1",
        role: "viewer",
        createdBy: "user-1",
        createdAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        acceptedAt: "2026-08-02T00:00:00.000Z",
      } as CalendarInvite,
    ]);
    const { findByLabelText } = renderSettings();
    await waitFor(() => expect(mockFetchInvites).toHaveBeenCalled());
    const toggle = (await findByLabelText("招待リンクを有効にする")) as unknown as TestNode;
    expect(switchValue(toggle)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// CLIENT-C — 再発行中に死んだ lastLink を出さない
// ════════════════════════════════════════════════════════════════════

describe("P0178 CLIENT-C: 再発行中の lastLink コピー抑止", () => {
  it("C1: 発行が in-flight の間、Copy Last Link は Clipboard へ書かず成功 Alert も出さない", async () => {
    // 1 回目の発行で lastLink = A を確定させる。
    mockCreateInvite.mockResolvedValueOnce({
      invite: { id: "inv-a", calendarId: "shared-1", role: "editor", createdBy: "", createdAt: "", expiresAt: "" },
      token: "tok-A",
    });
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

    const { findByText } = renderInvite();
    const createPress = findEnabledHandler(
      (await findByText("編集者として招待")) as unknown as TestNode,
      "onPress"
    );
    await act(async () => {
      await createPress();
    });
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalledTimes(1));

    // 等価な再発行 B を開始し、応答を遅延させる（server は既に commit して A を supersede した想定）。
    let resolveB: () => void = () => {};
    mockCreateInvite.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveB = () =>
            resolve({
              invite: { id: "inv-b", calendarId: "shared-1", role: "editor", createdBy: "", createdAt: "", expiresAt: "" },
              token: "tok-B",
            });
        })
    );

    const copyNode = (await findByText("最後に作成したリンクをコピー")) as unknown as TestNode;
    mockClipboardSetStringAsync.mockClear();
    alertSpy.mockClear();

    await act(async () => {
      void createPress(); // B を開始（await しない＝in-flight のまま）
    });

    // in-flight の間に Copy Last Link を押す。
    // ハンドラ参照は発行開始前に取得済み——**描画由来の disabled だけでは不十分**であり、
    // ハンドラ側の同期権威が無ければここで A がコピーされてしまう。
    await act(async () => {
      const handler = (copyNode.props as Record<string, unknown>).onPress;
      if (typeof handler === "function") await (handler as () => unknown)();
      let cur: TestNode | null = copyNode.parent;
      while (cur) {
        const h = (cur.props as Record<string, unknown>).onPress;
        if (typeof h === "function") {
          await (h as () => unknown)();
          break;
        }
        cur = cur.parent;
      }
    });

    expect(mockClipboardSetStringAsync).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();

    // B が着地したあとは通常どおり操作できる（恒久ロックアウトではない）。
    await act(async () => {
      resolveB();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalledTimes(2));
    alertSpy.mockRestore();
  });

  it("C2: 発行が完了していれば Copy Last Link は通常どおり動作する", async () => {
    /**
     * [P0180 / CORRECT-F024-003-D] **セットアップのみの変更。表明は変えていない。**
     *
     * 本テストの主張は「発行が完了していれば Copy Last Link は通常どおり動作する」であり、
     * 「権威スナップショットに存在しない招待でもコピーできる」ではない。
     * P0180 以降、コピーは外部化の直前に権威スナップショットで inviteId の現行性を確認する。
     * ファイル先頭の beforeEach の `mockFetchInvites` は常に `[]` を返すため、そのままでは
     * 発行済みの inv-a が権威上は存在しないことになり、正しく stale と判定されてしまう。
     * よって「発行が完了している」という前提そのものをスナップショットにも反映させる。
     *
     * 呼び出し回数に依存しないよう、発行前は `[]`・発行後は当該行、という実挙動どおりの
     * 実装で固定する（`mockResolvedValueOnce` だと初期ロードの回数に結果が左右されるうえ、
     * 発行前から一覧に行が現れると「編集者として招待」がボタンと行見出しで重複する）。
     */
    let issued = false;
    mockCreateInvite.mockImplementation(async () => {
      issued = true;
      return {
        invite: { id: "inv-a", calendarId: "shared-1", role: "editor", createdBy: "", createdAt: "", expiresAt: "" },
        token: "tok-A",
      };
    });
    mockFetchInvites.mockImplementation(async () =>
      issued
        ? [
            {
              id: "inv-a",
              calendarId: "shared-1",
              role: "editor",
              createdBy: "user-1",
              createdAt: "2026-08-01T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          ]
        : []
    );
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const { findByText } = renderInvite();
    const createPress = findEnabledHandler(
      (await findByText("編集者として招待")) as unknown as TestNode,
      "onPress"
    );
    await act(async () => {
      await createPress();
    });
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalledTimes(1));

    mockClipboardSetStringAsync.mockClear();
    const copyPress = findEnabledHandler(
      (await findByText("最後に作成したリンクをコピー")) as unknown as TestNode,
      "onPress"
    );
    await act(async () => {
      await copyPress();
    });
    await waitFor(() => expect(mockClipboardSetStringAsync).toHaveBeenCalledTimes(1));
    expect(mockClipboardSetStringAsync).toHaveBeenCalledWith("focuscalendar://invite/tok-A");
    alertSpy.mockRestore();
  });
});
