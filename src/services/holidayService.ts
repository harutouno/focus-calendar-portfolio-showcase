import { HolidayRegion } from "@/types/holidayRegion";

/**
 * 祝日データ取得の抽象化（Stage I-8.5、2026-09: 地域対応）。
 * 実装をHolidayDataService以外（将来的に外部データ源等）へ差し替える場合も、
 * 呼び出し側（useHolidays hook・カレンダー画面）はこのインターフェースだけに依存する。
 */
export interface HolidayService {
  /**
   * 指定年・指定地域の祝日一覧を返す（date: "YYYY-MM-DD" -> 祝日名）。
   * region==="NONE"の場合は空オブジェクトを返す実装であること。
   */
  getHolidaysForYear(year: number, region: HolidayRegion): Record<string, string>;
}
