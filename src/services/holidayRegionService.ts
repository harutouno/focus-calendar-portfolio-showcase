import { HolidayRegion } from "@/types/holidayRegion";

/**
 * 祝日の国・地域(ja/enの表示言語とは独立)の取得・保存を抽象化する。
 * localeService.tsと同じ設計方針。
 */
export interface HolidayRegionService {
  /**
   * 起動時に使うべき祝日地域を返す。保存済みの値があればそれを返し、
   * 無ければ端末のOS地域設定（GPSではない）から初期候補を判定し、
   * その結果をその場で保存してから返す（「初回のみ端末地域から判定、以後は
   * ユーザー設定を優先」を満たすための挙動。端末の地域設定が後で変わっても、
   * アプリ内の祝日地域は変わらない）。未対応の地域の場合は"NONE"を返す。
   */
  getInitialHolidayRegion(): Promise<HolidayRegion>;
  /** ユーザーが明示的に選択した祝日地域を保存する。 */
  setHolidayRegion(region: HolidayRegion): Promise<void>;
}
