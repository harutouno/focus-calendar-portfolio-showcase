import { formatLocalDate, parseLocalDateString } from "./date";
import { t as staticT, TFunction } from "@/i18n/translations";

/**
 * 期間・曜日から、一括作成の対象となる日付一覧を生成する純粋関数群。
 *
 * 重要: 日付は必ずローカルタイムゾーンで扱う。`parseLocalDateString`/`formatLocalDate`
 * （getFullYear/getMonth/getDateのみを使う）を経由し、`toISOString()`等のUTC変換は
 * 一切行わない。日数の差分計算にも`Date.UTC(y,m,d)`同士の差（＝暦日としての差分）を使い、
 * サマータイムの有無に左右されない実装にしている。
 */

export interface DateRangeByWeekdayInput {
  /** 開始日 "YYYY-MM-DD"（範囲に含む） */
  startDate: string;
  /** 終了日 "YYYY-MM-DD"（範囲に含む） */
  endDate: string;
  /** 対象曜日（0=日曜〜6=土曜）。複数選択可、重複は無視される */
  weekdays: number[];
}

/** 一度に指定できる期間の上限（日数）。無制限生成を防ぐための安全策 */
export const MAX_RANGE_DAYS = 366;

/** 一度に生成できる予定件数の上限。期間が上限内でも曜日を複数選ぶと件数は増えるため、別枠で設ける */
export const MAX_GENERATED_DATES = 200;

/**
 * 2つの"YYYY-MM-DD"の間の暦日としての差分（endDate - startDate）を返す。
 * サマータイムの影響を受けないよう、実時刻(ローカルのDateオブジェクト同士の引き算)ではなく、
 * Date.UTC(年,月,日)同士の差分（＝暦日数）で計算する。
 */
function calendarDaysBetween(startDate: string, endDate: string): number {
  const start = parseLocalDateString(startDate);
  const end = parseLocalDateString(endDate);
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endUtc - startUtc) / (24 * 60 * 60 * 1000));
}

/**
 * 開始日・終了日・対象曜日から、条件に合致する日付一覧を昇順・重複なしで返す。
 *
 * 入力:
 * - startDate: 開始日 "YYYY-MM-DD"（範囲に含む）
 * - endDate: 終了日 "YYYY-MM-DD"（範囲に含む）
 * - weekdays: 対象曜日の配列（0=日曜〜6=土曜）。1つ以上必須
 *
 * 出力: 条件に合致する日付の配列（"YYYY-MM-DD"、昇順、重複なし）
 *
 * 例外を投げる条件:
 * - weekdaysが空、または0〜6の範囲外の値を含む場合
 * - startDateがendDateより後の場合
 * - 期間がMAX_RANGE_DAYSを超える場合
 * - 生成される件数がMAX_GENERATED_DATESを超える場合
 */
export function getDatesInRangeByWeekday(
  input: DateRangeByWeekdayInput,
  t: TFunction = staticT
): string[] {
  const { startDate, endDate, weekdays } = input;

  if (weekdays.length === 0) {
    throw new Error(t("validation.weekdayRequired"));
  }
  const weekdaySet = new Set(weekdays);
  for (const w of weekdaySet) {
    if (!Number.isInteger(w) || w < 0 || w > 6) {
      throw new Error(t("recurringDates.weekdayInvalid"));
    }
  }

  const spanDays = calendarDaysBetween(startDate, endDate);
  if (spanDays < 0) {
    throw new Error(t("recurringDates.startBeforeEnd"));
  }
  const totalDaysInclusive = spanDays + 1;
  if (totalDaysInclusive > MAX_RANGE_DAYS) {
    throw new Error(t("recurringDates.rangeTooLong", { max: MAX_RANGE_DAYS }));
  }

  const dates: string[] = [];
  const cursor = parseLocalDateString(startDate);
  for (let i = 0; i < totalDaysInclusive; i++) {
    if (weekdaySet.has(cursor.getDay())) {
      dates.push(formatLocalDate(cursor));
      if (dates.length > MAX_GENERATED_DATES) {
        throw new Error(t("recurringDates.tooManyGenerated", { max: MAX_GENERATED_DATES }));
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}
