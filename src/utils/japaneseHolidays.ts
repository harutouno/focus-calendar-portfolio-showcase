/**
 * 日本の祝日を計算する純粋関数群（Stage I-8.5）。
 *
 * 外部APIやネットワークに一切依存せず、法律で定められた規則をアルゴリズムとして
 * 実装する（固定日・ハッピーマンデー・春分/秋分の日（近似式）・国民の休日・振替休日）。
 * 端末がオフラインでも常に正しく計算できる（このアプリの「端末内で完結する」設計方針に合わせている）。
 *
 * 既知の制限（完了報告にも記載）:
 * - 春分/秋分の日の算出式は1980〜2099年の範囲で正確とされる近似式を用いる。
 * - 2020年・2021年に祝日特措法で行われたオリンピック開催に伴う一時的な祝日移動
 *   （海の日・スポーツの日・山の日の特例）は対象外（恒久法ではなく単年度の特例のため）。
 * - 敬老の日のハッピーマンデー化（2003年〜）・昭和の日/みどりの日の入れ替え（2007年〜）・
 *   天皇誕生日の2月23日化（2020年〜）以前の年については、現行ルールをそのまま遡って
 *   適用するため、当時の実際の祝日と一致しない場合がある（2019年の天皇誕生日の空白等）。
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function toDateString(year: number, month1based: number, day: number): string {
  return `${year}-${pad2(month1based)}-${pad2(day)}`;
}

function addDaysToDateString(dateStr: string, amount: number): string {
  const [y, m, d] = dateStr.split("-").map((v) => parseInt(v, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + amount);
  return toDateString(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

function getWeekdayOfDateString(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map((v) => parseInt(v, 10));
  return new Date(y, m - 1, d).getDay();
}

/** 春分の日（3月の日付/日）。1980〜2099年の近似式。 */
export function getVernalEquinoxDay(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4);
}

/** 秋分の日（9月の日付/日）。1980〜2099年の近似式。 */
export function getAutumnalEquinoxDay(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4);
}

/** 指定月のn番目の指定曜日（weekday: 0=日〜6=土）の日付（日）を返す（ハッピーマンデー計算用）。 */
export function getNthWeekdayOfMonth(
  year: number,
  month1based: number,
  weekday: number,
  n: number
): number {
  const firstWeekday = new Date(year, month1based - 1, 1).getDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

/** 移動しない固定日・ハッピーマンデー・春分/秋分の日から成る、その年の基本の祝日集合。 */
function computeBaseHolidays(year: number): Record<string, string> {
  const holidays: Record<string, string> = {};
  holidays[toDateString(year, 1, 1)] = "元日";
  holidays[toDateString(year, 1, getNthWeekdayOfMonth(year, 1, 1, 2))] = "成人の日";
  holidays[toDateString(year, 2, 11)] = "建国記念の日";
  if (year >= 2020) {
    holidays[toDateString(year, 2, 23)] = "天皇誕生日";
  }
  holidays[toDateString(year, 3, getVernalEquinoxDay(year))] = "春分の日";
  holidays[toDateString(year, 4, 29)] = "昭和の日";
  holidays[toDateString(year, 5, 3)] = "憲法記念日";
  holidays[toDateString(year, 5, 4)] = "みどりの日";
  holidays[toDateString(year, 5, 5)] = "こどもの日";
  holidays[toDateString(year, 7, getNthWeekdayOfMonth(year, 7, 1, 3))] = "海の日";
  if (year >= 2016) {
    holidays[toDateString(year, 8, 11)] = "山の日";
  }
  holidays[toDateString(year, 9, getNthWeekdayOfMonth(year, 9, 1, 3))] = "敬老の日";
  holidays[toDateString(year, 9, getAutumnalEquinoxDay(year))] = "秋分の日";
  holidays[toDateString(year, 10, getNthWeekdayOfMonth(year, 10, 1, 2))] =
    year >= 2020 ? "スポーツの日" : "体育の日";
  holidays[toDateString(year, 11, 3)] = "文化の日";
  holidays[toDateString(year, 11, 23)] = "勤労感謝の日";
  return holidays;
}

/**
 * 国民の休日: 前日・翌日がともに祝日で、当日が祝日でも日曜でもない日を祝日として追加する。
 * （例: 敬老の日(月)と秋分の日(水)の間に火曜が挟まる「シルバーウィーク」）
 */
function addCitizensHolidays(holidays: Record<string, string>): void {
  const candidates = new Set<string>();
  for (const dateStr of Object.keys(holidays)) {
    candidates.add(addDaysToDateString(dateStr, 1));
  }
  for (const candidate of candidates) {
    if (holidays[candidate]) continue;
    if (getWeekdayOfDateString(candidate) === 0) continue;
    const prev = addDaysToDateString(candidate, -1);
    const next = addDaysToDateString(candidate, 1);
    if (holidays[prev] && holidays[next]) {
      holidays[candidate] = "国民の休日";
    }
  }
}

/**
 * 振替休日: 日曜にあたる祝日の翌日以降で、最初に祝日でない日を振替休日にする
 * （複数日連続で祝日の場合は、祝日でなくなるまで先送りする＝ゴールデンウィークの多日スキップに対応）。
 */
function addSubstituteHolidays(holidays: Record<string, string>): void {
  const sundayHolidayDates = Object.keys(holidays)
    .filter((d) => getWeekdayOfDateString(d) === 0)
    .sort();
  for (const sunday of sundayHolidayDates) {
    let candidate = addDaysToDateString(sunday, 1);
    while (holidays[candidate]) {
      candidate = addDaysToDateString(candidate, 1);
    }
    holidays[candidate] = "振替休日";
  }
}

/** 指定年の日本の祝日を計算する（date: "YYYY-MM-DD" -> 祝日名）。 */
export function computeJapaneseHolidays(year: number): Record<string, string> {
  const holidays = computeBaseHolidays(year);
  addCitizensHolidays(holidays);
  addSubstituteHolidays(holidays);
  return holidays;
}
