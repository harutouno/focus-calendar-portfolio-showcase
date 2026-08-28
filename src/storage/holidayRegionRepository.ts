import { HolidayRegion } from "@/types/holidayRegion";
import { readJSON, writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";

/** ユーザーが選択した祝日の国・地域の永続化。判定・初回起動ロジックはholidayRegionService側の責務。 */
export async function getStoredHolidayRegion(): Promise<HolidayRegion | null> {
  return readJSON<HolidayRegion | null>(STORAGE_KEYS.holidayRegion, null);
}

export async function saveStoredHolidayRegion(region: HolidayRegion): Promise<void> {
  await writeJSON(STORAGE_KEYS.holidayRegion, region);
}
