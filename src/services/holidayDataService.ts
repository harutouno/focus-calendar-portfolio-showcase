import Holidays from "date-holidays";
import { HolidayService } from "@/services/holidayService";
import { computeJapaneseHolidays } from "@/utils/japaneseHolidays";
import { HolidayRegion } from "@/types/holidayRegion";

/**
 * 地域対応のHolidayService実装（2026-09: 表示言語と祝日の国・地域の分離）。
 * - "JP": 既存の日本の祝日アルゴリズム（computeJapaneseHolidays、法令準拠・振替休日/
 *   国民の休日対応済み）をそのまま使う。ロジック・出力とも一切変更していない。
 * - "US"/"GB": date-holidaysパッケージ（無料・完全オフライン・206カ国対応）を使う。
 *   type==="public"（国が定める祝日）のみを対象とし、observance/optional等の
 *   記念日・任意の日は含めない（日本の実装が国民の祝日のみを対象にしているのと
 *   意味を揃えるため）。祝日名は英語の正式名称をそのまま使う（公式な日本語訳が
 *   存在しないため、独自翻訳は作らない）。
 * - "NONE": 空オブジェクトを返す（祝日を表示しない）。
 * 年・地域ごとにキャッシュする（地域を切り替えても、切替後は必ずその地域のデータだけを
 * 参照するため、別地域の古いキャッシュが混ざることはない）。
 */
export class HolidayDataService implements HolidayService {
  private readonly cache = new Map<string, Record<string, string>>();
  private readonly dateHolidaysInstances = new Map<string, Holidays>();

  getHolidaysForYear(year: number, region: HolidayRegion): Record<string, string> {
    const cacheKey = `${region}:${year}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const holidays = this.computeHolidaysForYear(year, region);
    this.cache.set(cacheKey, holidays);
    return holidays;
  }

  private computeHolidaysForYear(year: number, region: HolidayRegion): Record<string, string> {
    if (region === "NONE") return {};
    if (region === "JP") return computeJapaneseHolidays(year);
    return this.computeFromDateHolidays(year, region);
  }

  private computeFromDateHolidays(year: number, countryCode: string): Record<string, string> {
    let instance = this.dateHolidaysInstances.get(countryCode);
    if (!instance) {
      instance = new Holidays(countryCode);
      this.dateHolidaysInstances.set(countryCode, instance);
    }
    const result: Record<string, string> = {};
    for (const holiday of instance.getHolidays(year)) {
      if (holiday.type !== "public") continue;
      const dateOnly = holiday.date.slice(0, 10);
      result[dateOnly] = holiday.name;
    }
    return result;
  }
}

export const holidayService: HolidayService = new HolidayDataService();
