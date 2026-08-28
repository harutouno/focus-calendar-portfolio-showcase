import {
  MAX_GENERATED_DATES,
  MAX_RANGE_DAYS,
  getDatesInRangeByWeekday,
} from "@/utils/recurringDates";

/**
 * テスト対象と同じロジックを流用せず、素朴なDate反復による独立参照実装。
 * 「実装のバグ」ではなく「仕様通りの日付」であることを検証するために使う。
 */
function referenceGenerate(startDate: string, endDate: string, weekdays: number[]): string[] {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const cursor = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const set = new Set(weekdays);
  const result: string[] = [];
  while (cursor.getTime() <= end.getTime()) {
    if (set.has(cursor.getDay())) {
      const y = cursor.getFullYear();
      const m = `${cursor.getMonth() + 1}`.padStart(2, "0");
      const d = `${cursor.getDate()}`.padStart(2, "0");
      result.push(`${y}-${m}-${d}`);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function addDaysNative(dateStr: string, amount: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + amount);
  const yy = dt.getFullYear();
  const mm = `${dt.getMonth() + 1}`.padStart(2, "0");
  const dd = `${dt.getDate()}`.padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

describe("getDatesInRangeByWeekday", () => {
  it("ユーザー提示の例（2026-08-01〜2026-10-31、毎週日曜）を正しく生成する", () => {
    const startDate = "2026-08-01";
    const endDate = "2026-10-31";
    const result = getDatesInRangeByWeekday({ startDate, endDate, weekdays: [0] });
    expect(result).toEqual(referenceGenerate(startDate, endDate, [0]));
    // 昇順であること
    expect([...result].sort()).toEqual(result);
    // 重複がないこと
    expect(new Set(result).size).toBe(result.length);
    // 日曜日以外が含まれていないこと
    for (const d of result) {
      const [y, m, day] = d.split("-").map(Number);
      expect(new Date(y, m - 1, day).getDay()).toBe(0);
    }
  });

  it("複数曜日（月・水・金）を選択できる", () => {
    const startDate = "2026-08-01";
    const endDate = "2026-08-14";
    const result = getDatesInRangeByWeekday({ startDate, endDate, weekdays: [1, 3, 5] });
    expect(result).toEqual(referenceGenerate(startDate, endDate, [1, 3, 5]));
  });

  it("開始日・終了日そのものが対象曜日なら両端を含む", () => {
    // 2026-08-02は日曜日
    const result = getDatesInRangeByWeekday({
      startDate: "2026-08-02",
      endDate: "2026-08-02",
      weekdays: [0],
    });
    expect(result).toEqual(["2026-08-02"]);
  });

  it("単日範囲で対象曜日と一致しなければ空配列を返す", () => {
    // 2026-08-03は月曜日 → 日曜(0)は含まれない
    const result = getDatesInRangeByWeekday({
      startDate: "2026-08-03",
      endDate: "2026-08-03",
      weekdays: [0],
    });
    expect(result).toEqual([]);
  });

  it("曜日の重複指定は無視される（[0,0,3] は [0,3] と同じ結果）", () => {
    const startDate = "2026-08-01";
    const endDate = "2026-08-31";
    const withDup = getDatesInRangeByWeekday({ startDate, endDate, weekdays: [0, 0, 3] });
    const withoutDup = getDatesInRangeByWeekday({ startDate, endDate, weekdays: [0, 3] });
    expect(withDup).toEqual(withoutDup);
  });

  it("開始日が終了日より後ならエラーを投げる", () => {
    expect(() =>
      getDatesInRangeByWeekday({ startDate: "2026-08-10", endDate: "2026-08-01", weekdays: [0] })
    ).toThrow();
  });

  it("曜日が未選択ならエラーを投げる", () => {
    expect(() =>
      getDatesInRangeByWeekday({ startDate: "2026-08-01", endDate: "2026-08-31", weekdays: [] })
    ).toThrow();
  });

  it("不正な曜日値（範囲外・非整数）はエラーを投げる", () => {
    expect(() =>
      getDatesInRangeByWeekday({ startDate: "2026-08-01", endDate: "2026-08-31", weekdays: [-1] })
    ).toThrow();
    expect(() =>
      getDatesInRangeByWeekday({ startDate: "2026-08-01", endDate: "2026-08-31", weekdays: [7] })
    ).toThrow();
    expect(() =>
      getDatesInRangeByWeekday({ startDate: "2026-08-01", endDate: "2026-08-31", weekdays: [3.5] })
    ).toThrow();
  });

  it("月またぎ（月末→翌月）を正しく処理する", () => {
    const startDate = "2026-01-28";
    const endDate = "2026-02-04";
    const result = getDatesInRangeByWeekday({ startDate, endDate, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(result).toEqual(referenceGenerate(startDate, endDate, [0, 1, 2, 3, 4, 5, 6]));
    expect(result).toEqual([
      "2026-01-28",
      "2026-01-29",
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
      "2026-02-03",
      "2026-02-04",
    ]);
  });

  it("年またぎ（年末→年始）を正しく処理する", () => {
    const startDate = "2026-12-28";
    const endDate = "2027-01-04";
    const result = getDatesInRangeByWeekday({ startDate, endDate, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(result).toEqual(referenceGenerate(startDate, endDate, [0, 1, 2, 3, 4, 5, 6]));
    expect(result).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
      "2027-01-04",
    ]);
  });

  it("うるう年の2月29日を正しく含む（2028年はうるう年）", () => {
    const startDate = "2028-02-25";
    const endDate = "2028-03-03";
    const result = getDatesInRangeByWeekday({ startDate, endDate, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(result).toEqual(referenceGenerate(startDate, endDate, [0, 1, 2, 3, 4, 5, 6]));
    expect(result).toContain("2028-02-29");
    expect(result).toEqual([
      "2028-02-25",
      "2028-02-26",
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
      "2028-03-02",
      "2028-03-03",
    ]);
  });

  it("平年の2月（2026年はうるう年でない）は2/28の次が3/1になる", () => {
    const startDate = "2026-02-25";
    const endDate = "2026-03-03";
    const result = getDatesInRangeByWeekday({ startDate, endDate, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(result).toEqual(referenceGenerate(startDate, endDate, [0, 1, 2, 3, 4, 5, 6]));
    expect(result).not.toContain("2026-02-29");
    expect(result).toEqual([
      "2026-02-25",
      "2026-02-26",
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
    ]);
  });

  it(`期間はMAX_RANGE_DAYS(${MAX_RANGE_DAYS}日)まではエラーにならない`, () => {
    const startDate = "2026-01-01";
    const endDate = addDaysNative(startDate, MAX_RANGE_DAYS - 1); // 合計MAX_RANGE_DAYS日
    expect(() =>
      getDatesInRangeByWeekday({ startDate, endDate, weekdays: [0] })
    ).not.toThrow();
  });

  it(`期間がMAX_RANGE_DAYS(${MAX_RANGE_DAYS}日)を超えるとエラーを投げる`, () => {
    const startDate = "2026-01-01";
    const endDate = addDaysNative(startDate, MAX_RANGE_DAYS); // 合計MAX_RANGE_DAYS+1日
    expect(() =>
      getDatesInRangeByWeekday({ startDate, endDate, weekdays: [0] })
    ).toThrow();
  });

  it(`生成件数はMAX_GENERATED_DATES(${MAX_GENERATED_DATES}件)まではエラーにならない`, () => {
    const startDate = "2026-01-01";
    const endDate = addDaysNative(startDate, MAX_GENERATED_DATES - 1); // 全曜日選択でちょうどMAX_GENERATED_DATES件
    const result = getDatesInRangeByWeekday({
      startDate,
      endDate,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    });
    expect(result.length).toBe(MAX_GENERATED_DATES);
  });

  it(`生成件数がMAX_GENERATED_DATES(${MAX_GENERATED_DATES}件)を超えるとエラーを投げる`, () => {
    const startDate = "2026-01-01";
    const endDate = addDaysNative(startDate, MAX_GENERATED_DATES); // 全曜日選択でMAX_GENERATED_DATES+1件
    expect(() =>
      getDatesInRangeByWeekday({ startDate, endDate, weekdays: [0, 1, 2, 3, 4, 5, 6] })
    ).toThrow();
  });
});
