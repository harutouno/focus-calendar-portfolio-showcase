/**
 * 祝日を計算する国・地域。表示言語(SupportedLocale)とは完全に独立した設定値。
 * "NONE"は「祝日を表示しない」を表す。
 */
export type HolidayRegion = "JP" | "US" | "GB" | "NONE";

export interface HolidayRegionOption {
  region: HolidayRegion;
  /** date-holidaysが実際にサポートする国コード。"NONE"の場合はundefined（データ取得自体を行わない）。 */
  countryCode?: string;
}

/**
 * UIの選択肢はこの配列だけから生成する。祝日データソース（日本は独自アルゴリズム、
 * 米国・英国はdate-holidaysパッケージ）が正式にサポートする地域だけをここに列挙し、
 * 未対応の国を選択肢として見せないことを保証する唯一の場所にする。
 */
export const SUPPORTED_HOLIDAY_REGIONS: HolidayRegionOption[] = [
  { region: "JP", countryCode: "JP" },
  { region: "US", countryCode: "US" },
  { region: "GB", countryCode: "GB" },
  { region: "NONE" },
];
