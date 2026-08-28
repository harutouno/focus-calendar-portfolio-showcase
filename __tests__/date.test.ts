import {
  addDays,
  addMonths,
  addMonthsToPreferredDay,
  countConsecutiveDaysBackward,
  formatAgendaDayTitle,
  formatDayTitle,
  formatLocalDate,
  formatMonthTitle,
  getMonthMatrix,
  getWeekDates,
  getWeekday,
  parseLocalDateString,
  resolveCalendarHeaderTitle,
} from "@/utils/date";

describe("date utils", () => {
  it("formatLocalDate と parseLocalDateString は相互変換できる（日ずれなし）", () => {
    const original = "2026-07-22";
    const parsed = parseLocalDateString(original);
    expect(formatLocalDate(parsed)).toBe(original);
  });

  it("addDays は月またぎでも正しく計算する", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("getWeekday は日曜=0, 土曜=6 を返す", () => {
    // 2026-07-19 は日曜日
    expect(getWeekday("2026-07-19")).toBe(0);
    expect(getWeekday("2026-07-25")).toBe(6);
  });

  it("getWeekDates は日曜始まりの7日間を返す", () => {
    const week = getWeekDates("2026-07-22"); // 水曜日
    expect(week).toHaveLength(7);
    expect(week[0]).toBe("2026-07-19");
    expect(week[6]).toBe("2026-07-25");
  });

  it("getMonthMatrix は42マスを返し、当月フラグが正しい", () => {
    const matrix = getMonthMatrix(2026, 6); // 2026年7月 (0始まり月)
    expect(matrix).toHaveLength(42);
    const currentMonthCells = matrix.filter((c) => c.isCurrentMonth);
    expect(currentMonthCells).toHaveLength(31);
  });

  it("formatMonthTitle は年月を日本語で表示する", () => {
    expect(formatMonthTitle("2026-07-22")).toBe("2026年7月");
  });

  it("formatAgendaDayTitle は年を含めず「月日 曜日」形式で表示する（Stage I-8.7）", () => {
    // 2026-07-23 は木曜日（getWeekdayのテストで2026-07-19が日曜と確認済み、+4日）
    expect(formatAgendaDayTitle("2026-07-23")).toBe("7月23日 木曜日");
  });

  describe("countConsecutiveDaysBackward", () => {
    it("起点日から過去へ連続している日数を数える（起点日自体を含む）", () => {
      const dates = new Set(["2026-08-01", "2026-07-31", "2026-07-30"]);
      expect(countConsecutiveDaysBackward(dates, "2026-08-01")).toBe(3);
    });

    it("起点日が含まれていなければ0", () => {
      const dates = new Set(["2026-07-31", "2026-07-30"]);
      expect(countConsecutiveDaysBackward(dates, "2026-08-01")).toBe(0);
    });

    it("途切れた日でカウントを止める", () => {
      const dates = new Set(["2026-08-01", "2026-07-31", "2026-07-29"]); // 7/30が抜けている
      expect(countConsecutiveDaysBackward(dates, "2026-08-01")).toBe(2);
    });
  });
});

/**
 * [QA-F009-F012広範監査] addMonths/getMonthMatrix/getWeekDates/addDaysのうるう年・年またぎ・
 * DST境界の網羅テスト。正本§10の必須項目（leap-year boundary, Jan 31 shorter-month
 * navigation/jump, Dec 31/Jan 1, timezone date differs from UTC date, DST timezone case,
 * hidden-calendar consistency, recurring-event consistency, month/week/day selected-date
 * consistency, no duplicate logical occurrence）のうち、date.tsが担う部分を網羅する。
 */
describe("addMonths（月末クランプ・うるう年・年またぎ）", () => {
  it("うるう年でないFeb: 1/31 + 1ヶ月 は 2/28 にクランプされる（3/3への繰り上がりを起こさない）", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("うるう年のFeb: 1/31 + 1ヶ月 は うるう日2/29 にクランプされる", () => {
    // 2028年はうるう年（4で割り切れ、100で割り切れない）
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });

  it("うるう年でないFebから翌年3月への2ヶ月ジャンプでも月末クランプが正しい", () => {
    expect(addMonths("2026-01-31", 2)).toBe("2026-03-31");
  });

  it("年またぎ: 12月 + 1ヶ月 は翌年1月になる", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("年またぎ: 1月 - 1ヶ月 は前年12月になる（日付が31日でもクランプ不要な組み合わせ）", () => {
    expect(addMonths("2026-01-31", -1)).toBe("2025-12-31");
  });

  it("年またぎ+クランプ: 3/31 - 3ヶ月 は前年12/31（12月は31日まであるためクランプ不要）", () => {
    expect(addMonths("2026-03-31", -3)).toBe("2025-12-31");
  });

  it("[P0074 CORRECT-F009-001] addMonths自体は希望日を記憶しない低レベルのプリミティブ" +
    "のままである（1/31→+1ヶ月→2/28→-1ヶ月→1/28。ナビゲーション層で往復可逆性を" +
    "保つ責務はaddMonthsToPreferredDayが担う——下記describe参照。addMonthsをステート" +
    "フルにしない、という正本§2の制約により、この関数自体の挙動はP0072から変更しない）", () => {
    const forward = addMonths("2026-01-31", 1);
    expect(forward).toBe("2026-02-28");
    const back = addMonths(forward, -1);
    expect(back).toBe("2026-01-28");
  });
});

/**
 * [P0074 CORRECT-F009-001] ナビゲーション層の希望日アンカーパターンを担う
 * addMonthsToPreferredDayの契約テスト。正本§3必須項目を1つずつ検証する。
 * P0072のaddMonths単体テスト（上記）が示す「1/31→2/28→1/28」の往復ドリフトを、
 * 呼び出し元が希望日（31）を明示的に渡し続けることで解消できることを証明する。
 */
describe("addMonthsToPreferredDay（希望日アンカーによる往復可逆な月送り）", () => {
  it("2026-01-31 -> next -> 2026-02-28 -> next -> 2026-03-31", () => {
    const feb = addMonthsToPreferredDay("2026-01-31", 1, 31);
    expect(feb).toBe("2026-02-28");
    const mar = addMonthsToPreferredDay(feb, 1, 31);
    expect(mar).toBe("2026-03-31");
  });

  it("2026-03-31 -> prev -> 2026-02-28 -> prev -> 2026-01-31", () => {
    const feb = addMonthsToPreferredDay("2026-03-31", -1, 31);
    expect(feb).toBe("2026-02-28");
    const jan = addMonthsToPreferredDay(feb, -1, 31);
    expect(jan).toBe("2026-01-31");
  });

  it("うるう年: 2028-01-31 -> next -> 2028-02-29 -> prev -> 2028-01-31", () => {
    const feb29 = addMonthsToPreferredDay("2028-01-31", 1, 31);
    expect(feb29).toBe("2028-02-29");
    const jan = addMonthsToPreferredDay(feb29, -1, 31);
    expect(jan).toBe("2028-01-31");
  });

  it("2026-08-31 -> next -> 2026-09-30 -> next -> 2026-10-31", () => {
    const sep = addMonthsToPreferredDay("2026-08-31", 1, 31);
    expect(sep).toBe("2026-09-30");
    const oct = addMonthsToPreferredDay(sep, 1, 31);
    expect(oct).toBe("2026-10-31");
  });

  it("クランプが発生しない日付（1/15）はそのまま連続して往復する", () => {
    const feb = addMonthsToPreferredDay("2026-01-15", 1, 15);
    expect(feb).toBe("2026-02-15");
    const mar = addMonthsToPreferredDay(feb, 1, 15);
    expect(mar).toBe("2026-03-15");
    const back = addMonthsToPreferredDay(mar, -2, 15);
    expect(back).toBe("2026-01-15");
  });

  it("preferredDayが移動先の月の末日を超える場合はクランプする（過去のクランプ結果を" +
    "preferredDayとして渡した場合の安全側動作の確認）", () => {
    expect(addMonthsToPreferredDay("2026-02-28", 1, 31)).toBe("2026-03-31");
    expect(addMonthsToPreferredDay("2026-02-28", -1, 31)).toBe("2026-01-31");
  });
});

describe("getMonthMatrix（うるう年・年またぎグリッド）", () => {
  it("うるう年2月（2028年、month=1）は2/29を含み、isCurrentMonth=trueになる", () => {
    const matrix = getMonthMatrix(2028, 1);
    const feb29 = matrix.find((c) => c.date === "2028-02-29");
    expect(feb29).toBeDefined();
    expect(feb29?.isCurrentMonth).toBe(true);
    // 3/1はグリッドに含まれる場合でも当月ではない
    const mar1 = matrix.find((c) => c.date === "2028-03-01");
    expect(mar1?.isCurrentMonth).toBe(false);
  });

  it("うるう年でない2月（2026年、month=1）は2/29を含まない", () => {
    const matrix = getMonthMatrix(2026, 1);
    expect(matrix.some((c) => c.date === "2026-02-29")).toBe(false);
    const feb28 = matrix.find((c) => c.date === "2026-02-28");
    expect(feb28?.isCurrentMonth).toBe(true);
  });

  it("12月のグリッド（年またぎ）: 翌年1月へロールした日は年が正しく2027年になり、isCurrentMonth=false", () => {
    const matrix = getMonthMatrix(2026, 11); // 2026年12月
    const rolledIntoNextYear = matrix.filter((c) => c.date.startsWith("2027-01"));
    expect(rolledIntoNextYear.length).toBeGreaterThan(0);
    for (const cell of rolledIntoNextYear) {
      expect(cell.isCurrentMonth).toBe(false);
    }
    // 12/31自体は当月として含まれる
    const dec31 = matrix.find((c) => c.date === "2026-12-31");
    expect(dec31?.isCurrentMonth).toBe(true);
  });

  it("1月のグリッド（年またぎ）: 前年12月末へロールした日は年が正しく前年になり、isCurrentMonth=false", () => {
    const matrix = getMonthMatrix(2027, 0); // 2027年1月
    const rolledIntoPrevYear = matrix.filter((c) => c.date.startsWith("2026-12"));
    expect(rolledIntoPrevYear.length).toBeGreaterThan(0);
    for (const cell of rolledIntoPrevYear) {
      expect(cell.isCurrentMonth).toBe(false);
    }
    const jan1 = matrix.find((c) => c.date === "2027-01-01");
    expect(jan1?.isCurrentMonth).toBe(true);
  });
});

describe("DST境界でのaddDays/getWeekDates（明示的なタイムゾーン変換コードは無いが、" +
  "ローカルウォールクロック基準のDate構築のためDST安全であることを確認する）", () => {
  const originalTZ = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTZ;
  });

  it("米国東部のDST春時間切替日（2026-03-08）をまたいでもaddDaysは日付を飛ばさない・重複させない", () => {
    process.env.TZ = "America/New_York";
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-03-09", -2)).toBe("2026-03-07");
  });

  it("米国東部のDST秋時間切替日（2026-11-01）をまたいでもaddDaysは日付を飛ばさない・重複させない", () => {
    process.env.TZ = "America/New_York";
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("DST切替日を含む週でもgetWeekDatesは重複や欠落のない連続7日間を返す", () => {
    process.env.TZ = "America/New_York";
    const week = getWeekDates("2026-03-08"); // DST切替日を含む週
    expect(week).toHaveLength(7);
    const uniqueDates = new Set(week);
    expect(uniqueDates.size).toBe(7); // 重複なし
    // 連続していることを検証（前日との差が常に1日）
    for (let i = 1; i < week.length; i += 1) {
      expect(addDays(week[i - 1], 1)).toBe(week[i]);
    }
  });

  it("UTC日付とローカル日付がずれるタイムゾーン（UTC-11のPago Pago）でも" +
    "parseLocalDateString/formatLocalDateはローカル日付をそのまま維持する", () => {
    process.env.TZ = "Pacific/Pago_Pago"; // UTC-11、常にUTCより日付が遅れうる
    const parsed = parseLocalDateString("2026-07-23");
    expect(formatLocalDate(parsed)).toBe("2026-07-23");
    // toISOString()（UTC変換）は意図的に使っていないため、UTC日付とは無関係にローカル日付を維持する
    expect(addDays("2026-07-23", 1)).toBe("2026-07-24");
  });
});

/**
 * [P0074 I18N-F009-F011-001] カレンダー画面ヘッダーのタイトル選択がlocaleを正しく
 * 反映することの契約テスト。P0072時点ではformatDayTitle/formatMonthTitleが
 * locale引数なしで呼ばれており常に日本語になっていた（正本§1のバグ）。
 */
describe("resolveCalendarHeaderTitle（ヘッダータイトルのlocale反映）", () => {
  it("英語ロケール・月/週表示: 年月を英語で表示する", () => {
    expect(resolveCalendarHeaderTitle(false, "2026-07-23", "en")).toBe("July 2026");
  });

  it("英語ロケール・日表示: 年月日と曜日を英語で表示する", () => {
    // 2026-07-23 は木曜日
    expect(resolveCalendarHeaderTitle(true, "2026-07-23", "en")).toBe(
      formatDayTitle("2026-07-23", "en")
    );
    expect(resolveCalendarHeaderTitle(true, "2026-07-23", "en")).toContain("Thu");
  });

  it("日本語ロケール（既定値）は従来どおりの表示のまま回帰しない", () => {
    expect(resolveCalendarHeaderTitle(false, "2026-07-23")).toBe("2026年7月");
    expect(resolveCalendarHeaderTitle(true, "2026-07-23")).toBe("2026年7月23日（木）");
    // localeを省略しても既定"ja"になる（既存呼び出し元との後方互換）
    expect(resolveCalendarHeaderTitle(false, "2026-07-23", "ja")).toBe(
      resolveCalendarHeaderTitle(false, "2026-07-23")
    );
  });

  it("isDayView=falseは週表示・月表示のいずれでも同じformatMonthTitle経由になる" +
    "（週表示専用のタイトルロジックは存在しない——app/index.tsx側の実装に合わせる）", () => {
    expect(resolveCalendarHeaderTitle(false, "2026-07-23", "en")).toBe(
      formatMonthTitle("2026-07-23", "en")
    );
  });

  it("locale切り替えはfocusedDateを変えずにタイトルだけ変わる（フォーマット委譲のみで" +
    "副作用が無い純粋関数であることの確認）", () => {
    const ja = resolveCalendarHeaderTitle(false, "2026-07-23", "ja");
    const en = resolveCalendarHeaderTitle(false, "2026-07-23", "en");
    expect(ja).toBe("2026年7月");
    expect(en).toBe("July 2026");
    expect(ja).not.toBe(en);
  });
});
