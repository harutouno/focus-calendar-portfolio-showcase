/**
 * 日付ユーティリティ。
 *
 * 重要: 日付は必ず端末のローカルタイムゾーンで扱う。
 * `toISOString()` は UTC に変換されて日付がずれる場合があるため、
 * 日付文字列(YYYY-MM-DD)の生成には Date の getFullYear/getMonth/getDate のみを使う。
 *
 * 2026-07-29: 表示系関数（formatMonthTitle/formatDayTitle/formatAgendaDayTitle/weekdayLabel）に
 * 末尾オプション引数 locale を追加（既定"ja"、既存呼び出し元は無変更で従来どおり日本語）。
 * 英語表示はIntl.DateTimeFormatで生成する。翻訳辞書のdate.weekday0〜6と曜日の並びを揃えている。
 */
import { SupportedLocale, translate } from "@/i18n/translations";

export const WEEKDAY_LABELS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Date -> "YYYY-MM-DD"（ローカル基準） */
export function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "YYYY-MM-DD" -> Date（ローカル 0:00 として構築。UTC変換を経由しない） */
export function parseLocalDateString(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map((v) => parseInt(v, 10));
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

/** 今日の日付文字列（ローカル） */
export function todayLocalDateString(): string {
  return formatLocalDate(new Date());
}

export function isToday(dateStr: string): boolean {
  return dateStr === todayLocalDateString();
}

export function isSameDate(a: string, b: string): boolean {
  return a === b;
}

export function addDays(dateStr: string, amount: number): string {
  const d = parseLocalDateString(dateStr);
  d.setDate(d.getDate() + amount);
  return formatLocalDate(d);
}

export function addMonths(dateStr: string, amount: number): string {
  const d = parseLocalDateString(dateStr);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + amount);
  // 月末日ずれ防止（例: 1/31 + 1ヶ月 が 3/3 にならないように月末でクランプ）
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return formatLocalDate(d);
}

/**
 * [P0074 CORRECT-F009-001] addMonthsと違い、移動元の日付自体の日ではなく、
 * 呼び出し元（カレンダーナビゲーション層）が保持する「論理的に希望する日」
 * （preferredDay）を優先して使う純粋関数。隠れた状態は一切持たない
 * （同じ引数なら常に同じ結果を返す）——「preferredDayをどう永続化・更新するか」は
 * 呼び出し元の責務であり、この関数自体はステートフルにしない。
 *
 * 例: 1/31から+1ヶ月（addMonthsなら2/28にクランプ、以後28で固定されてしまう）を、
 * preferredDay=31を明示的に渡すことで、2/28（クランプ）→3/31（希望日31を復元）という
 * 往復可逆なナビゲーションを実現するために使う。
 */
export function addMonthsToPreferredDay(
  dateStr: string,
  amount: number,
  preferredDay: number
): string {
  const d = parseLocalDateString(dateStr);
  d.setDate(1);
  d.setMonth(d.getMonth() + amount);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(preferredDay, lastDay));
  return formatLocalDate(d);
}

export function getWeekday(dateStr: string): number {
  return parseLocalDateString(dateStr).getDay();
}

/** 指定日を含む週（日曜始まり）の7日分を返す */
export function getWeekDates(dateStr: string): string[] {
  const weekday = getWeekday(dateStr);
  const sunday = addDays(dateStr, -weekday);
  return Array.from({ length: 7 }, (_, i) => addDays(sunday, i));
}

/**
 * 月表示グリッド用の日付マトリクス（日曜始まり、6週固定 = 42マス）。
 * 前後月の日付も含み、当該月かどうかを isCurrentMonth で返す。
 */
export interface MonthCell {
  date: string;
  isCurrentMonth: boolean;
}

export function getMonthMatrix(year: number, month: number): MonthCell[] {
  const firstOfMonth = new Date(year, month, 1);
  const firstWeekday = firstOfMonth.getDay();
  const gridStart = new Date(year, month, 1 - firstWeekday);

  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return {
      date: formatLocalDate(d),
      isCurrentMonth: d.getMonth() === month,
    };
  });
}

export function formatMonthTitle(dateStr: string, locale: SupportedLocale = "ja"): string {
  const d = parseLocalDateString(dateStr);
  if (locale === "en") {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long" }).format(d);
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

export function formatDayTitle(dateStr: string, locale: SupportedLocale = "ja"): string {
  const d = parseLocalDateString(dateStr);
  if (locale === "en") {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(d);
  }
  const w = WEEKDAY_LABELS_JA[d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
}

/**
 * [P0074 I18N-F009-F011-001] カレンダー画面（app/index.tsx）ヘッダーのタイトル選択ロジック。
 * フォーマット自体はformatDayTitle/formatMonthTitleへそのまま委譲する（ロジックの重複無し）。
 * app/index.tsxから抽出したのは、ヘッダーが「日表示ならformatDayTitle、それ以外
 * （月・週表示）ならformatMonthTitle」というview種別に応じた選択を行っていること、
 * かつlocaleが正しく両方の呼び出しへ渡っていることを、app/index.tsx全体を
 * インポートせずに単体テスト可能にするため。
 */
export function resolveCalendarHeaderTitle(
  isDayView: boolean,
  focusedDate: string,
  locale: SupportedLocale = "ja"
): string {
  return isDayView ? formatDayTitle(focusedDate, locale) : formatMonthTitle(focusedDate, locale);
}

/** 日別予定一覧のヘッダー用表示（例: ja "7月23日 木曜日" / en "July 23, Thursday"）。年は含めない。 */
export function formatAgendaDayTitle(dateStr: string, locale: SupportedLocale = "ja"): string {
  const d = parseLocalDateString(dateStr);
  if (locale === "en") {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      weekday: "long",
    }).format(d);
  }
  const w = WEEKDAY_LABELS_JA[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 ${w}曜日`;
}

export function formatShortDay(dateStr: string): string {
  const d = parseLocalDateString(dateStr);
  return `${d.getDate()}`;
}

export function weekdayLabel(dateStr: string, locale: SupportedLocale = "ja"): string {
  const weekdayKeys = [
    "date.weekday0",
    "date.weekday1",
    "date.weekday2",
    "date.weekday3",
    "date.weekday4",
    "date.weekday5",
    "date.weekday6",
  ] as const;
  return translate(locale, weekdayKeys[getWeekday(dateStr)]);
}

/**
 * activeDatesに含まれる日付を、startDateStrから過去へ連続してカウントする（startDateStr自体を含む）。
 * startDateStrがactiveDatesに無ければ0。「今日に記録が無ければ昨日から」等、起点の選び方は
 * 呼び出し元の方針（src/utils/records.ts の streaksByTask、src/utils/focusStats.ts の
 * computeCurrentStreakDays）に委ね、この関数は「与えられた起点から連続日数を数える」ことだけを行う。
 */
export function countConsecutiveDaysBackward(activeDates: Set<string>, startDateStr: string): number {
  let streak = 0;
  let cursor = startDateStr;
  while (activeDates.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** 曜日インデックス(0=日曜)から曜日ラベルを引く（週ヘッダー等、日付文字列を経由しない場合用）。 */
export function weekdayLabelByIndex(index: number, locale: SupportedLocale = "ja"): string {
  const weekdayKeys = [
    "date.weekday0",
    "date.weekday1",
    "date.weekday2",
    "date.weekday3",
    "date.weekday4",
    "date.weekday5",
    "date.weekday6",
  ] as const;
  return translate(locale, weekdayKeys[((index % 7) + 7) % 7]);
}
