import {
  MAX_VISIBLE_CALENDARS,
  toggleCalendarVisibility,
  dedupePreserveOrder,
} from "@/utils/calendarVisibility";

/**
 * マイカレンダー＋共有カレンダー合計で同時に表示ONできる件数（5個）の純粋関数テスト。
 * 種別を区別せず、visibleCalendarIdsの要素数だけで判定することを検証する。
 */
describe("toggleCalendarVisibility", () => {
  it("上限未満ならONへ追加できる", () => {
    const result = toggleCalendarVisibility(["a", "b"], "c");
    expect(result).toEqual({ status: "applied", visibleCalendarIds: ["a", "b", "c"] });
  });

  it("既にONのカレンダーを指定するとOFFへ切り替わる（上限に関係なく常に成功する）", () => {
    const fiveIds = ["a", "b", "c", "d", "e"];
    const result = toggleCalendarVisibility(fiveIds, "c");
    expect(result).toEqual({ status: "applied", visibleCalendarIds: ["a", "b", "d", "e"] });
  });

  it("ちょうど5個目はONにできる", () => {
    const result = toggleCalendarVisibility(["a", "b", "c", "d"], "e");
    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.visibleCalendarIds).toHaveLength(MAX_VISIBLE_CALENDARS);
    }
  });

  it("6個目をONにしようとするとlimitReachedを返し、対象カレンダーもONにしない", () => {
    const fiveIds = ["a", "b", "c", "d", "e"];
    const result = toggleCalendarVisibility(fiveIds, "f");
    expect(result).toEqual({ status: "limitReached" });
  });

  it("既に6個以上ONの既存状態でも、OFF操作は常に成功する（自動削減はしない）", () => {
    const sixIds = ["a", "b", "c", "d", "e", "f"];
    const result = toggleCalendarVisibility(sixIds, "a");
    expect(result).toEqual({
      status: "applied",
      visibleCalendarIds: ["b", "c", "d", "e", "f"],
    });
  });

  it("既に6個以上ONの既存状態で、さらに新しいカレンダーをONにしようとするとlimitReachedになる", () => {
    const sixIds = ["a", "b", "c", "d", "e", "f"];
    const result = toggleCalendarVisibility(sixIds, "g");
    expect(result).toEqual({ status: "limitReached" });
  });

  it("空配列からでもONにできる", () => {
    const result = toggleCalendarVisibility([], "main");
    expect(result).toEqual({ status: "applied", visibleCalendarIds: ["main"] });
  });

  // [P0094 CORRECT-F020-001] 重複IDが上限判定を偽って消費しないことを検証する。
  it("重複IDが混入していても、実際にONなのは4個ぶんなら5個目を追加できる（重複が上限を偽って消費しない）", () => {
    const withDuplicate = ["a", "a", "b", "c", "d"];
    const result = toggleCalendarVisibility(withDuplicate, "e");
    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.visibleCalendarIds).toEqual(["a", "b", "c", "d", "e"]);
    }
  });

  it("重複除去後にちょうど5個なら、6個目はlimitReachedになる（重複を数えて誤って通さない）", () => {
    const withDuplicate = ["a", "a", "b", "c", "d", "e"];
    const result = toggleCalendarVisibility(withDuplicate, "f");
    expect(result).toEqual({ status: "limitReached" });
  });

  it("重複していたIDをOFFにすると、重複分も含めて1つに畳まれて消える", () => {
    const withDuplicate = ["a", "b", "a", "c"];
    const result = toggleCalendarVisibility(withDuplicate, "a");
    expect(result).toEqual({ status: "applied", visibleCalendarIds: ["b", "c"] });
  });
});

describe("dedupePreserveOrder", () => {
  it("初出の順序を保ったまま重複だけを除去する", () => {
    expect(dedupePreserveOrder(["a", "b", "a", "c", "b", "d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("重複が無ければ元の順序のまま返す", () => {
    expect(dedupePreserveOrder(["x", "y", "z"])).toEqual(["x", "y", "z"]);
  });

  it("空配列なら空配列を返す", () => {
    expect(dedupePreserveOrder([])).toEqual([]);
  });
});
