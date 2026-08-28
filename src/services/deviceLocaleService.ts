import { getDeviceLocale, SupportedLocale } from "@/i18n/translations";
import { getStoredLocale, saveStoredLocale } from "@/storage/localeRepository";
import { LocaleService } from "@/services/localeService";

const SUPPORTED_LOCALES: readonly SupportedLocale[] = ["ja", "en"];

/** 保存値が"ja"/"en"以外（破損データ・将来バージョンの未知の値等）でないことを確認する。 */
function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** AsyncStorage + 端末ロケール判定によるLocaleServiceの実装。 */
export class DeviceLocaleService implements LocaleService {
  async getInitialLocale(): Promise<SupportedLocale> {
    const stored = await getStoredLocale();
    if (isSupportedLocale(stored)) return stored;
    const detected = getDeviceLocale();
    await saveStoredLocale(detected);
    return detected;
  }

  async setLocale(locale: SupportedLocale): Promise<void> {
    await saveStoredLocale(locale);
  }
}

export const localeService: LocaleService = new DeviceLocaleService();
