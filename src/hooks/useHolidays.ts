import { useMemo } from "react";
import { getServices } from "@/services/registry";
import { SupportedLocale, TranslationKey, translate } from "@/i18n/translations";
import { HolidayRegion } from "@/types/holidayRegion";

/** JP地域のgetHolidaysForYear()が返す日本語の祝日名 -> 翻訳キーの対応表 */
const HOLIDAY_NAME_KEY: Record<string, TranslationKey> = {
  "元日": "holiday.newYearsDay",
  "成人の日": "holiday.comingOfAgeDay",
  "建国記念の日": "holiday.nationalFoundationDay",
  "天皇誕生日": "holiday.emperorsBirthday",
  "春分の日": "holiday.vernalEquinoxDay",
  "昭和の日": "holiday.showaDay",
  "憲法記念日": "holiday.constitutionMemorialDay",
  "みどりの日": "holiday.greeneryDay",
  "こどもの日": "holiday.childrensDay",
  "海の日": "holiday.marineDay",
  "山の日": "holiday.mountainDay",
  "敬老の日": "holiday.respectForTheAgedDay",
  "秋分の日": "holiday.autumnalEquinoxDay",
  "スポーツの日": "holiday.sportsDay",
  "体育の日": "holiday.healthAndSportsDay",
  "文化の日": "holiday.cultureDay",
  "勤労感謝の日": "holiday.laborThanksgivingDay",
  "国民の休日": "holiday.citizensHoliday",
  "振替休日": "holiday.substituteHoliday",
};

/**
 * 表示中の日付群（"YYYY-MM-DD"）に必要な年の祝日だけをまとめて返す。
 * 月表示のグリッドは前後月の日付を含むため年をまたぐことがあり、実際に表示されている
 * 日付から必要な年を都度導出することで、年境界でも正しく表示できるようにしている。
 * 週表示・日表示でも同じフックをそのまま再利用できる（表示中の日付を渡すだけでよい設計）。
 *
 * regionは表示言語(locale)とは完全に独立した設定（useHolidayRegion()から渡す）。
 * - region==="NONE"：holidayServiceを呼ばず、常に空オブジェクトを返す（祝日を表示しない）。
 * - region==="JP"：HolidayService自体は常に日本語名を返す（アルゴリズムはja固定）ため、
 *   ここでlocaleに応じた表示名へ変換する（既存ロジックを維持）。
 * - region==="US"/"GB"：date-holidaysが返す英語の正式名称をそのまま使う。公式な日本語訳が
 *   存在しないため、localeに関わらず翻訳しない（不正確な独自翻訳を作らないため）。
 */
export function useHolidays(
  dates: string[],
  locale: SupportedLocale = "ja",
  region: HolidayRegion = "JP"
): Record<string, string> {
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const d of dates) {
      const year = parseInt(d.slice(0, 4), 10);
      if (!Number.isNaN(year)) set.add(year);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [dates]);

  return useMemo(() => {
    if (region === "NONE") return {};
    const merged: Record<string, string> = {};
    const { holidayService } = getServices();
    for (const year of years) {
      Object.assign(merged, holidayService.getHolidaysForYear(year, region));
    }
    if (region !== "JP" || locale === "ja") return merged;
    const translated: Record<string, string> = {};
    for (const [date, name] of Object.entries(merged)) {
      const key = HOLIDAY_NAME_KEY[name];
      translated[date] = key ? translate(locale, key) : name;
    }
    return translated;
  }, [years, locale, region]);
}
