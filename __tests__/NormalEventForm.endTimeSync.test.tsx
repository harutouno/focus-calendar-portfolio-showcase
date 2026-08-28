import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { NormalEventForm, NormalEventFormValue } from "@/components/forms/NormalEventForm";
import { LocaleProvider } from "@/context/LocaleContext";

/**
 * ⑬ 終了時間の自動連動（新規作成画面専用）の回帰テスト。
 * DateTimePickerModalはネイティブピッカーに依存するため、テスト用の簡易スタブに差し替える
 * （visibleなインスタンスだけが「確定」ボタンを描画し、押すと__setNextConfirmDateで
 * 指定した時刻でonConfirmを呼ぶ）。
 */
jest.mock("expo-localization", () => ({
  getLocales: () => [{ languageCode: "ja", languageTag: "ja-JP" }],
}));

jest.mock("@expo/vector-icons", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mockのファクトリはトップレベルのimportを参照できないため
  const { createElement } = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  return {
    Ionicons: (props: { name: string; [key: string]: unknown }) =>
      createElement(Text, props, props.name),
  };
});

let mockNextConfirmDate = new Date(2026, 6, 30, 0, 0);
function setNextConfirmTime(hours: number, minutes: number) {
  mockNextConfirmDate = new Date(2026, 6, 30, hours, minutes);
}

jest.mock("@/components/forms/DateTimePickerModal", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createElement } = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text } = require("react-native");
  return {
    __esModule: true,
    DateTimePickerModal: ({
      visible,
      title,
      onConfirm,
    }: {
      visible: boolean;
      title: string;
      onConfirm: (d: Date) => void;
    }) => {
      if (!visible) return null;
      return createElement(
        Pressable,
        {
          onPress: () => onConfirm(mockNextConfirmDate),
          accessibilityLabel: `confirm-${title}`,
        },
        createElement(Text, null, `confirm-${title}`)
      );
    },
  };
});

// Round 12（SEC-F007-004、P1-5）: NormalEventFormがidentity（useAuth()のuser/sessionInstanceId）を
// 自前で取得するようになったため、AuthProviderで包む代わりにuseAuth()をモックする。
jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1" }, sessionInstanceId: "session-1" }),
}));

function buildInitial(overrides: Partial<NormalEventFormValue> = {}): NormalEventFormValue {
  return {
    title: "",
    date: "2026-07-30",
    startTime: "15:30",
    endTime: "16:30",
    allDay: false,
    location: "",
    memo: "",
    calendarId: "main",
    notificationMinutes: 30,
    repeatType: "none",
    shareWith: [],
    ...overrides,
  };
}

function renderForm(props: Partial<Parameters<typeof NormalEventForm>[0]> = {}) {
  return render(
    <LocaleProvider>
      <NormalEventForm
        initial={buildInitial()}
        shareTargets={[]}
        userCalendars={[]}
        sharedCalendars={[]}
        isEditing={false}
        onSave={() => {}}
        eventId="test-event-1"
        {...props}
      />
    </LocaleProvider>
  );
}

describe("NormalEventForm（終了時刻の自動連動、新規作成画面）", () => {
  it("開始時刻を変更すると、終了時刻が自動で開始時刻+1時間へ更新される", async () => {
    const { getByLabelText } = renderForm();
    await waitFor(() => {});
    fireEvent.press(getByLabelText(/^開始/));
    setNextConfirmTime(16, 0);
    fireEvent.press(getByLabelText("confirm-開始時刻"));
    expect(getByLabelText(/^終了.*17:00/)).toBeTruthy();
  });

  it("終了時刻を手動編集した後は、開始時刻を変更しても終了時刻は自動更新されない", async () => {
    const { getByLabelText } = renderForm();
    await waitFor(() => {});
    // 終了時刻を手動編集する
    fireEvent.press(getByLabelText(/^終了/));
    setNextConfirmTime(18, 0);
    fireEvent.press(getByLabelText("confirm-終了時刻"));
    expect(getByLabelText(/^終了.*18:00/)).toBeTruthy();

    // その後、開始時刻を変更しても、手動編集済みの終了時刻はそのまま
    fireEvent.press(getByLabelText(/^開始/));
    setNextConfirmTime(16, 0);
    fireEvent.press(getByLabelText("confirm-開始時刻"));
    expect(getByLabelText(/^終了.*18:00/)).toBeTruthy();
  });

  it("編集画面（isEditing）では、開始時刻を変更しても終了時刻を自動更新しない（既存挙動を維持）", async () => {
    const { getByLabelText } = renderForm({ isEditing: true });
    await waitFor(() => {});
    fireEvent.press(getByLabelText(/^開始/));
    setNextConfirmTime(16, 0);
    fireEvent.press(getByLabelText("confirm-開始時刻"));
    expect(getByLabelText(/^終了.*16:30/)).toBeTruthy();
  });
});
