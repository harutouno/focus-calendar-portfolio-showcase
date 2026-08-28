import { getLocales } from "expo-localization";
import { HolidayRegion, SUPPORTED_HOLIDAY_REGIONS } from "@/types/holidayRegion";
import { getStoredHolidayRegion, saveStoredHolidayRegion } from "@/storage/holidayRegionRepository";
import { HolidayRegionService } from "@/services/holidayRegionService";

const SUPPORTED_HOLIDAY_REGION_VALUES: readonly HolidayRegion[] = SUPPORTED_HOLIDAY_REGIONS.map(
  (option) => option.region
);

/** 保存値が公式サポート対象（JP/US/GB/NONE）以外（破損データ・将来バージョンの未知の値等）でないことを確認する。 */
function isSupportedHolidayRegion(value: unknown): value is HolidayRegion {
  return (
    typeof value === "string" &&
    (SUPPORTED_HOLIDAY_REGION_VALUES as readonly string[]).includes(value)
  );
}

/**
 * 端末のOS地域設定（GPSではない）+ AsyncStorageによるHolidayRegionServiceの実装。
 * deviceLocaleService.tsと同じ「初回のみ判定→即座に保存→以後は保存値優先」の設計。
 */
export class DeviceHolidayRegionService implements HolidayRegionService {
  async getInitialHolidayRegion(): Promise<HolidayRegion> {
    const stored = await getStoredHolidayRegion();
    if (isSupportedHolidayRegion(stored)) return stored;
    const detected = detectSupportedRegionFromDevice();
    await saveStoredHolidayRegion(detected);
    return detected;
  }

  async setHolidayRegion(region: HolidayRegion): Promise<void> {
    await saveStoredHolidayRegion(region);
  }
}

/**
 * 端末のOS地域設定（Settingsアプリの言語・地域、位置情報は一切使わない）から、
 * このアプリが正式にサポートする祝日地域を1つだけ判定する。
 * 対応する地域が無ければ、無条件で日本へ固定せず"NONE"（祝日を表示しない）を返す
 * （ユーザー指示: 「無条件で日本へ固定しないでください」）。
 * 同期関数のため、HolidayRegionContext.tsxの初期state（useState初期化子）からも
 * 直接呼べる（LocaleContext.tsxがgetDeviceLocale()を同様に使うのと同じパターン。
 * 保存済みの値の確認を待たずに妥当な初期表示ができ、起動直後に祝日が一瞬消えたり
 * 誤った地域の祝日が一瞬出たりするちらつきを避けられる）。
 */
export function detectSupportedRegionFromDevice(): HolidayRegion {
  const deviceRegionCode = getLocales()[0]?.regionCode?.toUpperCase();
  if (!deviceRegionCode) return "NONE";
  const match = SUPPORTED_HOLIDAY_REGIONS.find(
    (option) => option.countryCode === deviceRegionCode
  );
  return match?.region ?? "NONE";
}

export const holidayRegionService: HolidayRegionService = new DeviceHolidayRegionService();
