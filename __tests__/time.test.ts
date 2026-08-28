import {
  defaultEndTime,
  formatDuration,
  minutesToTime,
  nowHHMM,
  resolveDefaultCalendarId,
  resolveDefaultEventStart,
  resolveEndDate,
  timeToMinutes,
} from "@/utils/time";
import { UserCalendar } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";

describe("time utils", () => {
  it("timeToMinutes と minutesToTime は相互変換できる", () => {
    expect(timeToMinutes("00:00")).toBe(0);
    expect(timeToMinutes("09:05")).toBe(545);
    expect(timeToMinutes("23:59")).toBe(1439);
    expect(minutesToTime(545)).toBe("09:05");
  });

  it("formatDuration は時間と分を日本語で表示する", () => {
    expect(formatDuration(30)).toBe("30分");
    expect(formatDuration(60)).toBe("1時間");
    expect(formatDuration(90)).toBe("1時間30分");
  });
});

describe("nowHHMM（引数を注入できることの確認）", () => {
  it("引数のDateから分単位で正確なHH:mmを返す", () => {
    expect(nowHHMM(new Date(2026, 6, 30, 15, 26))).toBe("15:26");
    expect(nowHHMM(new Date(2026, 6, 30, 9, 7))).toBe("09:07");
  });
});

describe("resolveDefaultEventStart（新規予定作成の初期値、回帰テスト）", () => {
  const now = new Date(2026, 6, 30, 15, 26); // 2026-07-30 15:26

  it("date/startTimeどちらも未指定なら今日・現在時刻を30分単位へ切り上げて返す（+ボタン等）", () => {
    expect(resolveDefaultEventStart({}, "2026-07-30", now)).toEqual({
      date: "2026-07-30",
      startTime: "15:30",
    });
  });

  it("dateだけ指定されている場合、その日付＋切り上げた現在時刻を返す（月表示→日別一覧の+ボタン）", () => {
    expect(resolveDefaultEventStart({ date: "2026-08-15" }, "2026-07-30", now)).toEqual({
      date: "2026-08-15",
      startTime: "15:30",
    });
  });

  it("startTimeが明示的に指定されている場合はそれを最優先し、丸めない（タイムラインのタップ）", () => {
    expect(
      resolveDefaultEventStart({ date: "2026-07-30", startTime: "14:53" }, "2026-07-30", now)
    ).toEqual({ date: "2026-07-30", startTime: "14:53" });
  });

  it("日付を跨ぐ切り上げ（23:50→翌日00:00）は、日付が未指定（今日として自動決定）の場合のみ日付を繰り上げる", () => {
    const lateNight = new Date(2026, 6, 30, 23, 50); // 2026-07-30 23:50
    expect(resolveDefaultEventStart({}, "2026-07-30", lateNight)).toEqual({
      date: "2026-07-31",
      startTime: "00:00",
    });
  });

  it("表示中の日付が明示されている場合は、時刻の日付跨ぎがあってもその日付を変えない", () => {
    const lateNight = new Date(2026, 6, 30, 23, 50); // 実時刻は23:50
    expect(
      resolveDefaultEventStart({ date: "2026-09-10" }, "2026-07-30", lateNight)
    ).toEqual({ date: "2026-09-10", startTime: "00:00" });
  });
});

describe("resolveDefaultEventStart 30分切り上げの境界値（回帰テスト）", () => {
  it("15:01→15:30", () => {
    expect(resolveDefaultEventStart({}, "2026-07-30", new Date(2026, 6, 30, 15, 1))).toEqual({
      date: "2026-07-30",
      startTime: "15:30",
    });
  });

  // [P0076 QA-F016] 正本§6が明示的に要求する境界値（切り上げ先の境界1分手前）。
  it("15:29→15:30", () => {
    expect(resolveDefaultEventStart({}, "2026-07-30", new Date(2026, 6, 30, 15, 29))).toEqual({
      date: "2026-07-30",
      startTime: "15:30",
    });
  });

  it("15:30→15:30（変化なし）", () => {
    expect(resolveDefaultEventStart({}, "2026-07-30", new Date(2026, 6, 30, 15, 30))).toEqual({
      date: "2026-07-30",
      startTime: "15:30",
    });
  });

  it("15:31→16:00", () => {
    expect(resolveDefaultEventStart({}, "2026-07-30", new Date(2026, 6, 30, 15, 31))).toEqual({
      date: "2026-07-30",
      startTime: "16:00",
    });
  });

  it("00:00→00:00（変化なし）", () => {
    expect(resolveDefaultEventStart({}, "2026-07-30", new Date(2026, 6, 30, 0, 0))).toEqual({
      date: "2026-07-30",
      startTime: "00:00",
    });
  });

  // 2026-07-31: 実機で「12:08に開いたのに開始時刻が02:01になる」という報告への回帰テスト。
  // 30分切り上げ処理自体はここでも数値として検証し、想定通りであることを確認する
  // （報告された値は、この関数の計算結果としては原理的に発生し得ない：切り上げ結果は
  // 必ず分が00か30になるため。開始/終了・境界値の期待挙動を明文化する）。
  it("12:08→12:30", () => {
    expect(resolveDefaultEventStart({}, "2026-07-31", new Date(2026, 6, 31, 12, 8))).toEqual({
      date: "2026-07-31",
      startTime: "12:30",
    });
  });

  it("12:30→12:30（変化なし）", () => {
    expect(resolveDefaultEventStart({}, "2026-07-31", new Date(2026, 6, 31, 12, 30))).toEqual({
      date: "2026-07-31",
      startTime: "12:30",
    });
  });

  it("12:31→13:00", () => {
    expect(resolveDefaultEventStart({}, "2026-07-31", new Date(2026, 6, 31, 12, 31))).toEqual({
      date: "2026-07-31",
      startTime: "13:00",
    });
  });

  it("23:50→翌日00:00（日付繰り上げ）", () => {
    expect(resolveDefaultEventStart({}, "2026-07-31", new Date(2026, 6, 31, 23, 50))).toEqual({
      date: "2026-08-01",
      startTime: "00:00",
    });
  });

  // [P0076 QA-F016] 正本§6が明示的に要求する境界値（日付繰り上げが発生する最初の分）。
  it("23:31→翌日00:00（日付繰り上げが発生する最初の分）", () => {
    expect(resolveDefaultEventStart({}, "2026-07-31", new Date(2026, 6, 31, 23, 31))).toEqual({
      date: "2026-08-01",
      startTime: "00:00",
    });
  });
});

/**
 * [P0080 DATA-F013-001] params.date/params.startTimeはexpo-routerのルートパラメータ
 * （ディープリンク等、任意の文字列になり得る）。正本§2の必須例をすべて満たすことを検証する:
 * 不正な形式は正規化せず「未指定」と同じフォールバックにする。有効な値はそのまま使う。
 */
describe("resolveDefaultEventStart（P0080 DATA-F013-001、不正なルートパラメータの安全なフォールバック）", () => {
  const now = new Date(2026, 6, 30, 15, 26); // 2026-07-30 15:26 → 30分切り上げで15:30

  it("date=abc（形式が不正）→ 日付は今日にフォールバックする", () => {
    expect(resolveDefaultEventStart({ date: "abc" }, "2026-07-30", now)).toEqual({
      date: "2026-07-30",
      startTime: "15:30",
    });
  });

  it("date=2026-02-30（実在しない暦日）→ 日付は今日にフォールバックする", () => {
    expect(resolveDefaultEventStart({ date: "2026-02-30" }, "2026-07-30", now)).toEqual({
      date: "2026-07-30",
      startTime: "15:30",
    });
  });

  it("startTime=99:99（範囲外）→ 現在時刻の切り上げにフォールバックする", () => {
    expect(resolveDefaultEventStart({ startTime: "99:99" }, "2026-07-30", now)).toEqual({
      date: "2026-07-30",
      startTime: "15:30",
    });
  });

  it("startTime=12:60（分が範囲外）→ 現在時刻の切り上げにフォールバックする", () => {
    expect(resolveDefaultEventStart({ startTime: "12:60" }, "2026-07-30", now)).toEqual({
      date: "2026-07-30",
      startTime: "15:30",
    });
  });

  it("startTime=foo（数値ですらない）→ 現在時刻の切り上げにフォールバックする", () => {
    expect(resolveDefaultEventStart({ startTime: "foo" }, "2026-07-30", now)).toEqual({
      date: "2026-07-30",
      startTime: "15:30",
    });
  });

  it("date=2026-08-11 & startTime=09:07（両方とも有効）→ 1分単位のまま一切変更せず保持する", () => {
    expect(
      resolveDefaultEventStart({ date: "2026-08-11", startTime: "09:07" }, "2026-07-30", now)
    ).toEqual({ date: "2026-08-11", startTime: "09:07" });
  });

  it("date不正・startTime有効 → dateだけ今日へフォールバックし、startTimeはそのまま保持する", () => {
    expect(
      resolveDefaultEventStart({ date: "not-a-date", startTime: "09:07" }, "2026-07-30", now)
    ).toEqual({ date: "2026-07-30", startTime: "09:07" });
  });

  it("date有効・startTime不正 → startTimeは切り上げ現在時刻へフォールバックし、有効なdateはそのまま保持する", () => {
    expect(
      resolveDefaultEventStart({ date: "2026-09-10", startTime: "25:00" }, "2026-07-30", now)
    ).toEqual({ date: "2026-09-10", startTime: "15:30" });
  });
});

describe("defaultEndTime（新規予定作成の終了時刻初期値、回帰テスト）", () => {
  it("開始時刻+1時間を返す", () => {
    expect(defaultEndTime("15:26")).toBe("16:26");
    expect(defaultEndTime("09:07")).toBe("10:07");
    expect(defaultEndTime("12:30")).toBe("13:30");
  });

  it("任意のdurationMinutesを指定できる", () => {
    expect(defaultEndTime("10:00", 30)).toBe("10:30");
  });

  it("[P0078 CORRECT-F016-001] 日付を跨ぐ場合は23:59へクランプせず、翌日の正しい時刻を返す", () => {
    // 正本の境界値（P0078バッチ仕様書の必須ケース）
    expect(defaultEndTime("15:30")).toBe("16:30"); // 同日、跨がない
    expect(defaultEndTime("23:00")).toBe("00:00"); // 翌日ちょうど0時
    expect(defaultEndTime("23:40")).toBe("00:40"); // 翌日（旧実装は誤って23:59を返していた）
    expect(defaultEndTime("23:59")).toBe("00:59"); // 翌日（旧実装は誤って23:59を返していた＝無変化）
  });
});

describe("resolveEndDate（[P0078 CORRECT-F016-001] 終了時刻の暦日を決定する唯一の正本）", () => {
  it("終了時刻が開始時刻より後（同日内）なら同じ日付を返す", () => {
    expect(resolveEndDate("2026-08-11", "15:30", "16:30")).toBe("2026-08-11");
    expect(resolveEndDate("2026-08-11", "09:00", "23:59")).toBe("2026-08-11");
  });

  it("終了時刻が開始時刻以下（日付をまたぐ）なら翌日の日付を返す", () => {
    expect(resolveEndDate("2026-08-11", "23:00", "00:00")).toBe("2026-08-12");
    expect(resolveEndDate("2026-08-11", "23:40", "00:40")).toBe("2026-08-12");
    expect(resolveEndDate("2026-08-11", "23:59", "00:59")).toBe("2026-08-12");
  });

  it("終了時刻が開始時刻とちょうど同時刻の場合は「24時間後」＝翌日扱いにする（同日0分の予定は扱わない仕様）", () => {
    expect(resolveEndDate("2026-08-11", "10:00", "10:00")).toBe("2026-08-12");
  });

  it("月またぎ・年またぎでも正しく繰り上がる", () => {
    expect(resolveEndDate("2026-01-31", "23:30", "00:30")).toBe("2026-02-01");
    expect(resolveEndDate("2026-12-31", "23:30", "00:30")).toBe("2027-01-01");
  });
});

describe("resolveDefaultCalendarId（予定作成画面の既定カレンダー、フェーズ3回帰テスト）", () => {
  const userCalendars: UserCalendar[] = [
    { id: "cal-1", name: "勉強", color: "#8B5CF6", memberNames: [] },
  ];
  const now = new Date().toISOString();
  function buildShared(overrides: Partial<JoinedCalendarSummary> = {}): JoinedCalendarSummary {
    return {
      calendar: {
        id: "shared-1",
        name: "家族",
        color: "#22A06B",
        ownerId: "owner-1",
        createdAt: now,
        updatedAt: now,
      },
      role: "editor",
      memberCount: 2,
      memberPreviews: [],
      ...overrides,
    };
  }

  it("candidateIdが未設定（null）の場合はmainを返す", () => {
    expect(resolveDefaultCalendarId(null, userCalendars, [])).toBe("main");
  });

  it("candidateIdが自分のマイカレンダーとして現存する場合はそれを返す", () => {
    expect(resolveDefaultCalendarId("cal-1", userCalendars, [])).toBe("cal-1");
  });

  it("candidateIdが編集可能な共有カレンダーとして現存する場合はそれを返す", () => {
    const sharedCalendars = [buildShared({ role: "editor" })];
    expect(resolveDefaultCalendarId("shared-1", [], sharedCalendars)).toBe("shared-1");
  });

  it("candidateIdが閲覧のみの共有カレンダーの場合はmainへフォールバックする（作成権限が無いため）", () => {
    const sharedCalendars = [buildShared({ role: "viewer" })];
    expect(resolveDefaultCalendarId("shared-1", [], sharedCalendars)).toBe("main");
  });

  it("candidateIdが削除済み・退出済み等で現存しない場合はmainへフォールバックする", () => {
    expect(resolveDefaultCalendarId("cal-deleted", userCalendars, [])).toBe("main");
  });

  it("candidateIdが\"main\"の場合はそのままmainを返す", () => {
    expect(resolveDefaultCalendarId("main", userCalendars, [])).toBe("main");
  });
});
