/**
 * DATA-F002-002: AsyncStorageから読み込んだunknownの実行時形状検証で共通して使う、
 * 意味のある最小限のtype guard／normalizer群。
 * 汎用スキーマフレームワークは作らず、各Repositoryが自分のデータ形状に合わせて
 * これらを組み合わせて使う（キーごとの検証ロジック自体は各Repositoryファイルに置く）。
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 年月日の組が実在する暦日かどうかを判定する（例: 2月30日、4月31日を拒否する）。
 * `new Date(...)`のロールオーバー（存在しない日付を翌月へ繰り上げる等）に頼らず、
 * 純粋な数値計算だけで判定する（実行環境によるDate解釈の差異を避けるため）。
 */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * DATA-F002-002（日付検証追記分）: "YYYY-MM-DD"形式であり、かつ実在する暦日であることを
 * 検証する（`events.date`等が保存する形式。`src/utils/date.ts`の`formatLocalDate`と対）。
 * `Date.parse()`/`new Date(...)`だけに頼ると、存在しない日付を実行環境によっては
 * 別の日付へ丸めて解釈してしまう場合があるため、年月日それぞれを数値として取り出し、
 * `isValidCalendarDate`で直接判定する。
 */
export function isValidDateOnlyString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return false;
  return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

const TIME_ONLY_PATTERN = /^(\d{2}):(\d{2})$/;

/**
 * "HH:mm"形式（時00〜23、分00〜59、共にゼロ埋め2桁）であることを検証する
 * （`events.startTime`/`endTime`等が保存する形式。`src/utils/time.ts`の`minutesToTime`と対）。
 * "24:00"のような時刻として存在しない値は拒否する。
 */
export function isValidTimeString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIME_ONLY_PATTERN.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

const ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/**
 * ISO8601形式（"YYYY-MM-DDTHH:mm:ss.sssZ"、`Date.prototype.toISOString()`が実際に
 * 生成する形式そのもの）であり、かつ年月日・時分秒の各要素が実在する値であることを
 * 検証する。`events.createdAt`/`updatedAt`、`focusHistory.startedAt`/`endedAt`、
 * `chatHistory.createdAt`、`syncQueue.queuedAt`、
 * `aiPendingRequest.createdAt`等が保存する形式。未来日時であること自体は拒否しない
 * （ドメイン上有効な未来の予定・予約時刻を誤って弾かないため）。
 */
export function isValidIsoDateTimeString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATETIME_PATTERN.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi, s] = match;
  if (!isValidCalendarDate(Number(y), Number(mo), Number(d))) return false;
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

/**
 * 重要データ（Category A）のトップレベル構造そのものが不正（配列のはずが配列でない等）で、
 * 安全に部分復元できない場合に投げる。呼び出し元（AppDataContext.runInitialization等、
 * 既存のROBUST-F001-002 try/catch）が捕捉し、"error"状態へ倒すことを想定する。
 * readJSON自体は変更していないため、JSON構文破損・getItem失敗は従来通りfallbackへ
 * 安全に縮退する（このエラーが投げられるのは、JSON解析には成功したが期待した
 * トップレベル形状ではなかった場合のみ）。
 */
export class StoredDataValidationError extends Error {
  readonly code = "stored_data_invalid_shape" as const;
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`stored_data_invalid_shape: ${key} (${reason})`);
    this.name = "StoredDataValidationError";
    this.key = key;
  }
}
