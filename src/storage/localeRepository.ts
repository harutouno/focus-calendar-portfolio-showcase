import { SupportedLocale } from "@/i18n/translations";
import { readJSON, writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";

/** ユーザーが選択した表示言語の永続化。判定・初回起動ロジックはlocaleService側の責務。 */
export async function getStoredLocale(): Promise<SupportedLocale | null> {
  return readJSON<SupportedLocale | null>(STORAGE_KEYS.locale, null);
}

export async function saveStoredLocale(locale: SupportedLocale): Promise<void> {
  await writeJSON(STORAGE_KEYS.locale, locale);
}
