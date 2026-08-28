import { AppEvent, FocusSessionRecord } from "@/types/event";
import {
  addDays,
  addMonths,
  countConsecutiveDaysBackward,
  formatLocalDate,
  getWeekDates,
  getWeekday,
  parseLocalDateString,
  weekdayLabelByIndex,
} from "@/utils/date";
import { formatDuration } from "@/utils/time";
import { SupportedLocale, TFunction, TranslationKey, translate } from "@/i18n/translations";
import { FOCUS_ANALYTICS_MIN_SAMPLE_FOR_BEST } from "@/constants/focusAnalyticsLimits";

/**
 * 既定のt（引数省略時のフォールバック）。既存呼び出し元との後方互換のため、
 * 端末ロケールに依存する`t()`ではなく、常に日本語を返す関数にする
 * （既存のこのファイルのテストが日本語ラベルをそのまま検証しているため、
 * テスト環境の既定ロケール（en扱い）に引きずられて破壊的変更にならないようにする）。
 */
function defaultJaT(key: TranslationKey, vars?: Record<string, string | number>): string {
  return translate("ja", key, vars);
}

/**
 * Stage I-7: Focus履歴からの統計計算（純粋関数のみ、React/Repositoryに非依存）。
 *
 * 集計対象の定義（完了・中断区分について）:
 * FocusSessionRecordには`completedFully: boolean`という完了・中断の区分が既に存在し、
 * useFocusTimer.finish()は完了(true)・中断(false)のどちらでも同じ履歴配列へ記録を追加する
 * （履歴を保存する時点では除外していない＝これが「現行履歴の意味」）。
 * このファイルの統計関数は、「実績として保存された記録」= completedFully===true の記録のみを
 * 集計対象とする（Stage I-7の指示に明記された、今月集計の条件を全関数に一貫して適用した）。
 * 既存の src/utils/records.ts（totalAchievedMinutes/weeklyHours等）は完了・中断を区別せず
 * 全件を対象にしており、これは今回一切変更していない（表示結果を変えない方針のため）。
 */

function isAchievedRecord(record: FocusSessionRecord): boolean {
  return record.completedFully === true;
}

/** レコードのローカル日付("YYYY-MM-DD")。startedAtの文字列切り出しは行わない（タイムゾーン誤集計防止）。 */
function localDateOf(record: FocusSessionRecord): string {
  return formatLocalDate(new Date(record.startedAt));
}

/**
 * 2026-08: 集中実績の正本はcreditedFocusSeconds（resolveCreditedFocusSeconds経由）に統一する。
 * actualMinutesは完了ボタンを押すまでの待機時間を含み得るため、成果分析には使わない
 * （下のresolveCreditedFocusSeconds定義を参照）。複数レコードを合算する際は必ず秒単位で
 * 累積し、分への変換は最後に1回だけ行う（レコードごとに個別へ分丸めしてから合計すると、
 * 短い記録が多いほど丸め誤差が蓄積するため）。
 */
function sumCreditedSecondsForMonth(
  records: FocusSessionRecord[],
  year: number,
  month: number
): number {
  let totalSeconds = 0;
  for (const r of records) {
    if (!isAchievedRecord(r)) continue;
    const started = new Date(r.startedAt);
    if (started.getFullYear() === year && started.getMonth() === month) {
      totalSeconds += resolveCreditedFocusSeconds(r);
    }
  }
  return totalSeconds;
}

function sumMinutesForMonth(
  records: FocusSessionRecord[],
  year: number,
  month: number
): number {
  return Math.round(sumCreditedSecondsForMonth(records, year, month) / 60);
}

/**
 * 分単位の所要時間を安全に「n時間m分」表記へ整形する。
 * 既存のformatDuration（utils/time.ts）をそのまま再利用しつつ、NaN・負数を0分へ丸めてから渡す
 * （formatDuration自体は既存の呼び出し元への影響を避けるため変更しない）。
 */
export function formatFocusDuration(minutes: number, locale: SupportedLocale = "ja"): string {
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  return formatDuration(safeMinutes, locale);
}

/** 今月（referenceDateの年月）の集中時間（分）。当月1日から現在までの実績記録を合算する。 */
export function getMonthlyFocusMinutes(
  records: FocusSessionRecord[],
  referenceDate: Date = new Date()
): number {
  return sumMinutesForMonth(records, referenceDate.getFullYear(), referenceDate.getMonth());
}

export interface MonthlyComparisonStat {
  currentMinutes: number;
  previousMinutes: number;
  /**
   * 前月比（%、整数、四捨五入）。前月が0分・今月も0分なら0。
   * 前月が0分・今月が1分以上の場合は「新規」を表すnull。
   */
  changePercent: number | null;
}

/** 今月と前月の集中時間を比較する。 */
export function getPreviousMonthComparison(
  records: FocusSessionRecord[],
  referenceDate: Date = new Date()
): MonthlyComparisonStat {
  const currentMinutes = getMonthlyFocusMinutes(records, referenceDate);
  const previousMonthDateStr = addMonths(formatLocalDate(referenceDate), -1);
  const [prevYearStr, prevMonthStr] = previousMonthDateStr.split("-");
  const previousMinutes = sumMinutesForMonth(
    records,
    parseInt(prevYearStr, 10),
    parseInt(prevMonthStr, 10) - 1
  );

  let changePercent: number | null;
  if (previousMinutes === 0 && currentMinutes === 0) {
    changePercent = 0;
  } else if (previousMinutes === 0) {
    changePercent = null;
  } else {
    changePercent = Math.round(((currentMinutes - previousMinutes) / previousMinutes) * 100);
  }

  return { currentMinutes, previousMinutes, changePercent };
}

export interface MonthlyFocusStat {
  /** "2026-07" 形式。ソート・キー用途。 */
  key: string;
  /** "7月" 形式の短いラベル。 */
  label: string;
  minutes: number;
}

/** 過去12か月分（当月を含む、連続12か月）の月別集中時間を古い順で返す。0分の月も含む。 */
export function getLast12MonthsFocus(
  records: FocusSessionRecord[],
  referenceDate: Date = new Date(),
  locale: SupportedLocale = "ja"
): MonthlyFocusStat[] {
  const refDateStr = formatLocalDate(referenceDate);
  const stats: MonthlyFocusStat[] = [];
  for (let i = 11; i >= 0; i--) {
    const monthDateStr = addMonths(refDateStr, -i);
    const [yearStr, monthStr] = monthDateStr.split("-");
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10) - 1;
    const label =
      locale === "en"
        ? new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date(year, month, 1))
        : `${month + 1}月`;
    stats.push({
      key: `${yearStr}-${monthStr}`,
      label,
      minutes: sumMinutesForMonth(records, year, month),
    });
  }
  return stats;
}

export interface TaskFocusStat {
  taskId: string;
  title: string;
  minutes: number;
}

const UNKNOWN_TASK_KEY = "__unknown__";
const OTHER_TASK_KEY = "__other__";

/**
 * taskId単位に集計し、集中時間の多い順に並べる。上位`limit`件を超える分は「その他」として合算する。
 * タイトルはtaskIdごとに最新（startedAtが最も新しい）記録のtaskTitleを優先し、
 * それが空の場合のみeventsをtaskIdで検索して補完する。入力配列はどちらも変更しない。
 */
export function getFocusByTask(
  records: FocusSessionRecord[],
  events: AppEvent[] = [],
  limit = 5,
  t: TFunction = defaultJaT
): TaskFocusStat[] {
  const groups = new Map<string, { seconds: number; latest: FocusSessionRecord }>();

  for (const r of records) {
    if (!isAchievedRecord(r)) continue;
    const key = r.taskId && r.taskId.trim() ? r.taskId : UNKNOWN_TASK_KEY;
    const seconds = resolveCreditedFocusSeconds(r);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { seconds, latest: r });
      continue;
    }
    existing.seconds += seconds;
    if (new Date(r.startedAt).getTime() > new Date(existing.latest.startedAt).getTime()) {
      existing.latest = r;
    }
  }

  const resolveTitle = (key: string, latest: FocusSessionRecord): string => {
    if (key === UNKNOWN_TASK_KEY) return t("records.unknownTask");
    if (latest.taskTitle && latest.taskTitle.trim()) return latest.taskTitle;
    const event = events.find((e) => e.id === key);
    return event?.title && event.title.trim() ? event.title : t("records.unknownTask");
  };

  // 分への変換は最後の1回だけ行う（レコード単位・タスク単位の途中経過は秒のまま保持し、
  // 短い記録が多いほど誤差が蓄積する「個別に丸めてから合計」を避ける）。
  const statsWithSeconds = Array.from(groups.entries()).map(([taskId, g]) => ({
    taskId,
    title: resolveTitle(taskId, g.latest),
    seconds: g.seconds,
  }));

  statsWithSeconds.sort((a, b) => b.seconds - a.seconds);

  const toStat = ({
    taskId,
    title,
    seconds,
  }: {
    taskId: string;
    title: string;
    seconds: number;
  }): TaskFocusStat => ({ taskId, title, minutes: Math.round(seconds / 60) });

  if (statsWithSeconds.length <= limit) return statsWithSeconds.map(toStat);

  const top = statsWithSeconds.slice(0, limit).map(toStat);
  const otherSeconds = statsWithSeconds.slice(limit).reduce((sum, s) => sum + s.seconds, 0);
  top.push({
    taskId: OTHER_TASK_KEY,
    title: t("records.otherTasks"),
    minutes: Math.round(otherSeconds / 60),
  });
  return top;
}

export interface WeekdayFocusStat {
  /** 0=月, 1=火, ..., 6=日（月曜始まり、このファイル固有の並び） */
  weekday: number;
  label: string;
  minutes: number;
}

/** Date.getDay()（0=日曜始まり）を月曜始まりのインデックス（0=月曜）へ変換する。 */
function toMondayFirstIndex(sundayFirstIndex: number): number {
  return (sundayFirstIndex + 6) % 7;
}

/** 月曜始まりのインデックス（0=月曜）をDate.getDay()（0=日曜始まり）へ戻す。 */
function toSundayFirstIndex(mondayFirstIndex: number): number {
  return (mondayFirstIndex + 1) % 7;
}

/** 過去8週間（当日を含む56日間）を対象に、月曜始まりの曜日別集中時間を集計する。 */
export function getFocusByWeekday(
  records: FocusSessionRecord[],
  referenceDate: Date = new Date(),
  locale: SupportedLocale = "ja"
): { stats: WeekdayFocusStat[]; topWeekday: WeekdayFocusStat } {
  const refDateStr = formatLocalDate(referenceDate);
  const cutoffDateStr = addDays(refDateStr, -55);
  const secondsByWeekday = new Array(7).fill(0) as number[];

  for (const r of records) {
    if (!isAchievedRecord(r)) continue;
    const dateStr = localDateOf(r);
    if (dateStr < cutoffDateStr || dateStr > refDateStr) continue;
    const idx = toMondayFirstIndex(getWeekday(dateStr));
    secondsByWeekday[idx] += resolveCreditedFocusSeconds(r);
  }

  // 分への変換は曜日ごとの合計が確定した最後の1回だけ行う。
  const stats: WeekdayFocusStat[] = secondsByWeekday.map((seconds, i) => ({
    weekday: i,
    label: weekdayLabelByIndex(toSundayFirstIndex(i), locale),
    minutes: Math.round(seconds / 60),
  }));

  let topWeekday = stats[0];
  for (const s of stats) {
    if (s.minutes > topWeekday.minutes) topWeekday = s;
  }

  return { stats, topWeekday };
}

export type TimeOfDayPeriod = "morning" | "afternoon" | "evening" | "midnight";

export interface TimeOfDayFocusStat {
  period: TimeOfDayPeriod;
  label: string;
  minutes: number;
}

const TIME_OF_DAY_KEYS: { period: TimeOfDayPeriod; labelKey: "records.periodMorning" | "records.periodAfternoon" | "records.periodEvening" | "records.periodMidnight" }[] = [
  { period: "morning", labelKey: "records.periodMorning" },
  { period: "afternoon", labelKey: "records.periodAfternoon" },
  { period: "evening", labelKey: "records.periodEvening" },
  { period: "midnight", labelKey: "records.periodMidnight" },
];

/**
 * 開始時刻を4つの時間帯へ分類する。
 * 朝5:00-11:59 / 昼12:00-16:59 / 夜17:00-21:59 / 深夜22:00-4:59（日をまたぐ）。
 */
function classifyTimeOfDay(hour: number, minute: number): TimeOfDayPeriod {
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes >= 5 * 60 && totalMinutes <= 11 * 60 + 59) return "morning";
  if (totalMinutes >= 12 * 60 && totalMinutes <= 16 * 60 + 59) return "afternoon";
  if (totalMinutes >= 17 * 60 && totalMinutes <= 21 * 60 + 59) return "evening";
  return "midnight";
}

/** 過去8週間（当日を含む56日間）を対象に、開始時刻ベースの時間帯別集中時間を集計する。 */
export function getFocusByTimeOfDay(
  records: FocusSessionRecord[],
  referenceDate: Date = new Date(),
  t: TFunction = defaultJaT
): { stats: TimeOfDayFocusStat[]; topPeriod: TimeOfDayFocusStat } {
  const refDateStr = formatLocalDate(referenceDate);
  const cutoffDateStr = addDays(refDateStr, -55);
  const secondsByPeriod: Record<TimeOfDayPeriod, number> = {
    morning: 0,
    afternoon: 0,
    evening: 0,
    midnight: 0,
  };

  for (const r of records) {
    if (!isAchievedRecord(r)) continue;
    const started = new Date(r.startedAt);
    const dateStr = formatLocalDate(started);
    if (dateStr < cutoffDateStr || dateStr > refDateStr) continue;
    const period = classifyTimeOfDay(started.getHours(), started.getMinutes());
    secondsByPeriod[period] += resolveCreditedFocusSeconds(r);
  }

  // 分への変換は時間帯ごとの合計が確定した最後の1回だけ行う。
  const stats: TimeOfDayFocusStat[] = TIME_OF_DAY_KEYS.map(({ period, labelKey }) => ({
    period,
    label: t(labelKey),
    minutes: Math.round(secondsByPeriod[period] / 60),
  }));

  let topPeriod = stats[0];
  for (const s of stats) {
    if (s.minutes > topPeriod.minutes) topPeriod = s;
  }

  return { stats, topPeriod };
}

/**
 * 2026-08: 集中記録・分析システム（無料/プレミアム分析）向けに追加した純粋関数群。
 *
 * 上のセクション（getMonthlyFocusMinutes〜getFocusByTimeOfDay）は既存の画面から
 * 呼ばれている実装で、シグネチャ・集計対象・戻り値を一切変更していない
 * （actualMinutesベースのまま。既存テストの期待値と挙動を壊さないため）。
 * 以下の新しい関数は、正しく計画時間でクランプされた `creditedFocusSeconds` を使い、
 * 無料/プレミアム分析画面（新しいapp/records.tsx）専用に追加したものである。
 * 「新旧で集計値の基準が異なる」という非対称性は完了報告で明記する。
 */

/**
 * 正式な集中秒数を取り出す。creditedFocusSecondsが無い旧レコードは
 * plannedDurationSeconds（無ければplannedMinutes*60）を代用する（仕様27番の後方互換規定）。
 */
export function resolveCreditedFocusSeconds(record: FocusSessionRecord): number {
  if (typeof record.creditedFocusSeconds === "number" && Number.isFinite(record.creditedFocusSeconds)) {
    return Math.max(0, record.creditedFocusSeconds);
  }
  const plannedSeconds =
    typeof record.plannedDurationMs === "number" && Number.isFinite(record.plannedDurationMs)
      ? record.plannedDurationMs / 1000
      : Number.isFinite(record.plannedMinutes)
        ? record.plannedMinutes * 60
        : 0;
  return Math.max(0, Math.round(plannedSeconds));
}

/**
 * 完了/中断が確定した時点のローカル日付キー。localDateKeyが無い旧レコードはendedAtから導出する
 * （dateKeyはscheduledStartAt由来の別物のため使わない）。
 */
export function resolveLocalDateKey(record: FocusSessionRecord): string {
  if (record.localDateKey) return record.localDateKey;
  return formatLocalDate(new Date(record.endedAt));
}

export type ResolvedCalendarType = "my" | "shared" | "unknown";

export function resolveCalendarType(record: FocusSessionRecord): ResolvedCalendarType {
  if (record.sourceType === "local") return "my";
  if (record.sourceType === "shared") return "shared";
  return "unknown";
}

/** calendarNameSnapshotが無い旧レコード・削除済みカレンダーはunknownLabelを使う。 */
export function resolveCalendarName(record: FocusSessionRecord, unknownLabel: string): string {
  return record.calendarNameSnapshot && record.calendarNameSnapshot.trim()
    ? record.calendarNameSnapshot
    : unknownLabel;
}

export type FocusAnalyticsPeriod =
  | "today"
  | "last7Days"
  | "last30Days"
  | "thisWeek"
  | "thisMonth"
  | "thisYear"
  | "allTime";

export interface DateKeyRange {
  /** 両端を含む(inclusive) */
  startDateKey: string;
  endDateKey: string;
}

/**
 * 期間指定をローカル日付の範囲へ変換する。allTimeはnull（範囲指定なし＝全件）を返す。
 * 「今週」の起点はこのアプリの既存週表示（src/utils/date.ts の getWeekDates、日曜始まり）と
 * 同じ曜日を使う。独自に月曜始まり等へ変えない。
 */
export function resolvePeriodRange(
  period: FocusAnalyticsPeriod,
  referenceDate: Date = new Date()
): DateKeyRange | null {
  const todayKey = formatLocalDate(referenceDate);
  switch (period) {
    case "today":
      return { startDateKey: todayKey, endDateKey: todayKey };
    case "last7Days":
      return { startDateKey: addDays(todayKey, -6), endDateKey: todayKey };
    case "last30Days":
      return { startDateKey: addDays(todayKey, -29), endDateKey: todayKey };
    case "thisWeek": {
      const week = getWeekDates(todayKey);
      return { startDateKey: week[0], endDateKey: week[6] };
    }
    case "thisMonth": {
      const y = referenceDate.getFullYear();
      const m = referenceDate.getMonth();
      return {
        startDateKey: formatLocalDate(new Date(y, m, 1)),
        endDateKey: formatLocalDate(new Date(y, m + 1, 0)),
      };
    }
    case "thisYear": {
      const y = referenceDate.getFullYear();
      return { startDateKey: `${y}-01-01`, endDateKey: `${y}-12-31` };
    }
    case "allTime":
    default:
      return null;
  }
}

/**
 * resolveLocalDateKey基準で期間内の記録だけを残す（completedFullyでは絞り込まない）。
 * rangeがnull（allTime）なら全件そのまま返す。
 * 「完了のみ」に絞るかどうかは呼び出し先の各集計関数が個別に判断する
 * （完遂率・中断分析は未完了レコードも必要なため、このファイルの既存関数と同じ設計方針を踏襲）。
 */
export function filterRecordsInRange(
  records: FocusSessionRecord[],
  range: DateKeyRange | null
): FocusSessionRecord[] {
  if (!range) return records;
  return records.filter((r) => {
    const key = resolveLocalDateKey(r);
    return key >= range.startDateKey && key <= range.endDateKey;
  });
}

/**
 * 選択中の期間の直前・同じ日数ぶんの期間を返す（仕様14番の前期間比較用。
 * 例: 8/1〜8/7を選択中なら7/25〜7/31を返す）。allTime（rangeがnull）には
 * 「前期間」という概念自体が無いためnullを返す。
 */
export function resolvePreviousPeriodRange(range: DateKeyRange | null): DateKeyRange | null {
  if (!range) return null;
  const start = parseLocalDateString(range.startDateKey);
  const end = parseLocalDateString(range.endDateKey);
  const lengthDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const previousEnd = addDays(range.startDateKey, -1);
  const previousStart = addDays(previousEnd, -(lengthDays - 1));
  return { startDateKey: previousStart, endDateKey: previousEnd };
}

export interface FocusPeriodSummary {
  totalCreditedSeconds: number;
  completedCount: number;
  /** completedCountが0なら0（NaN/Infinityにしない） */
  averageCreditedSeconds: number;
}

/** 期間内（filterRecordsInRange済み）の完了記録から、集中時間の合計・件数・平均を出す。 */
export function computePeriodSummary(recordsInRange: FocusSessionRecord[]): FocusPeriodSummary {
  const completed = recordsInRange.filter((r) => r.completedFully === true);
  const totalCreditedSeconds = completed.reduce((sum, r) => sum + resolveCreditedFocusSeconds(r), 0);
  const completedCount = completed.length;
  const averageCreditedSeconds =
    completedCount > 0 ? Math.round(totalCreditedSeconds / completedCount) : 0;
  return { totalCreditedSeconds, completedCount, averageCreditedSeconds };
}

export interface FocusCompletionRate {
  completedCount: number;
  /** 期間内の全確定セッション数（focusHistoryは complete()/cancel() 経由のみのため、
   *  scheduled/running/paused/ready_to_completeの記録は構造的に含まれない） */
  finalizedCount: number;
  /** finalizedCountが0ならnull（「データなし」表示用。0%をそのまま返さない） */
  ratePercent: number | null;
}

export function computeCompletionRate(recordsInRange: FocusSessionRecord[]): FocusCompletionRate {
  const finalizedCount = recordsInRange.length;
  const completedCount = recordsInRange.filter((r) => r.completedFully === true).length;
  const ratePercent = finalizedCount === 0 ? null : Math.round((completedCount / finalizedCount) * 100);
  return { completedCount, finalizedCount, ratePercent };
}

export interface FocusPeriodComparison {
  /** null = 前期間データなし（新しく記録された） */
  totalCreditedSecondsChangePercent: number | null;
  completedCountChangePercent: number | null;
  hasPriorData: boolean;
}

/** 前期間との比較（仕様14番）。前期間が0件なら「増加率」は出さずnullにする。 */
export function computePeriodComparison(
  current: FocusPeriodSummary,
  previous: FocusPeriodSummary
): FocusPeriodComparison {
  const hasPriorData = previous.completedCount > 0 || previous.totalCreditedSeconds > 0;
  const changePercent = (curr: number, prev: number): number | null => {
    if (prev === 0) return curr === 0 ? 0 : null;
    return Math.round(((curr - prev) / prev) * 100);
  };
  return {
    totalCreditedSecondsChangePercent: changePercent(
      current.totalCreditedSeconds,
      previous.totalCreditedSeconds
    ),
    completedCountChangePercent: changePercent(current.completedCount, previous.completedCount),
    hasPriorData,
  };
}

function achievedLocalDateSet(records: FocusSessionRecord[]): Set<string> {
  const dates = new Set<string>();
  for (const r of records) {
    if (r.completedFully === true) dates.add(resolveLocalDateKey(r));
  }
  return dates;
}

/**
 * 現在の連続達成日数（仕様12番）。全履歴（期間フィルタなし）を対象にする。
 * 今日に達成があれば今日から遡る。無ければ昨日から遡る。それも無ければ0
 * （streaksByTaskと違い、「大昔の最後の記録」まで遡って連続扱いにはしない）。
 */
export function computeCurrentStreakDays(
  records: FocusSessionRecord[],
  referenceDate: Date = new Date()
): number {
  const activeDates = achievedLocalDateSet(records);
  const todayKey = formatLocalDate(referenceDate);
  if (activeDates.has(todayKey)) return countConsecutiveDaysBackward(activeDates, todayKey);
  const yesterdayKey = addDays(todayKey, -1);
  if (activeDates.has(yesterdayKey)) return countConsecutiveDaysBackward(activeDates, yesterdayKey);
  return 0;
}

/** これまでで最長の連続達成日数（全履歴対象、現在進行中かどうかは問わない）。 */
export function computeLongestStreakDaysEver(records: FocusSessionRecord[]): number {
  const activeDates = achievedLocalDateSet(records);
  let longest = 0;
  for (const dateKey of activeDates) {
    const prevDay = addDays(dateKey, -1);
    if (activeDates.has(prevDay)) continue; // 連続区間の途中（起点ではない）
    const length = countConsecutiveDaysForward(activeDates, dateKey);
    if (length > longest) longest = length;
  }
  return longest;
}

function countConsecutiveDaysForward(activeDates: Set<string>, startDateStr: string): number {
  let streak = 0;
  let cursor = startDateStr;
  while (activeDates.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, 1);
  }
  return streak;
}

export interface DailyFocusPoint {
  dateKey: string;
  label: string;
  totalCreditedSeconds: number;
  isToday: boolean;
}

/**
 * 直近N日間（今日を含む）の、完了記録のみを対象にした日別集中時間（仕様19番、無料の7日グラフ用）。
 * 記録が無い日も0として含む。既存のweeklyHours（records.ts、完了・中断を区別しない別物）は
 * 変更せず併存させる。
 */
export function getRecentDaysFocus(
  records: FocusSessionRecord[],
  days: number,
  referenceDate: Date = new Date(),
  locale: SupportedLocale = "ja"
): DailyFocusPoint[] {
  const todayKey = formatLocalDate(referenceDate);
  const completed = records.filter((r) => r.completedFully === true);
  return Array.from({ length: days }, (_, i) => {
    const dateKey = addDays(todayKey, i - (days - 1));
    const totalCreditedSeconds = completed
      .filter((r) => resolveLocalDateKey(r) === dateKey)
      .reduce((sum, r) => sum + resolveCreditedFocusSeconds(r), 0);
    return {
      dateKey,
      label: weekdayLabelByIndex(getWeekday(dateKey), locale),
      totalCreditedSeconds,
      isToday: dateKey === todayKey,
    };
  });
}

export interface CalendarFocusStat {
  calendarId: string;
  name: string;
  calendarType: ResolvedCalendarType;
  totalCreditedSeconds: number;
  completedCount: number;
  /** 0-100（整数）。合計が0なら0。 */
  shareOfTotalPercent: number;
}

const UNKNOWN_CALENDAR_KEY = "__unknown_calendar__";

/**
 * カレンダー別の集中時間（仕様21番、期間内・完了記録のみ）。calendarIdで集計するため、
 * 同名の別カレンダーを名前だけで混同しない。削除済みカレンダーはcalendarNameSnapshotで表示する。
 */
export function getFocusByCalendar(
  recordsInRange: FocusSessionRecord[],
  unknownCalendarLabel: string
): CalendarFocusStat[] {
  const completed = recordsInRange.filter((r) => r.completedFully === true);
  const groups = new Map<
    string,
    { name: string; calendarType: ResolvedCalendarType; totalCreditedSeconds: number; completedCount: number }
  >();

  for (const r of completed) {
    const key = r.calendarId && r.calendarId.trim() ? r.calendarId : UNKNOWN_CALENDAR_KEY;
    const seconds = resolveCreditedFocusSeconds(r);
    const existing = groups.get(key);
    if (existing) {
      existing.totalCreditedSeconds += seconds;
      existing.completedCount += 1;
      continue;
    }
    groups.set(key, {
      name: key === UNKNOWN_CALENDAR_KEY ? unknownCalendarLabel : resolveCalendarName(r, unknownCalendarLabel),
      calendarType: resolveCalendarType(r),
      totalCreditedSeconds: seconds,
      completedCount: 1,
    });
  }

  const grandTotal = Array.from(groups.values()).reduce((sum, g) => sum + g.totalCreditedSeconds, 0);
  const stats: CalendarFocusStat[] = Array.from(groups.entries()).map(([calendarId, g]) => ({
    calendarId,
    name: g.name,
    calendarType: g.calendarType,
    totalCreditedSeconds: g.totalCreditedSeconds,
    completedCount: g.completedCount,
    shareOfTotalPercent:
      grandTotal > 0 ? Math.round((g.totalCreditedSeconds / grandTotal) * 100) : 0,
  }));

  stats.sort((a, b) => b.totalCreditedSeconds - a.totalCreditedSeconds);
  return stats;
}

export interface InterruptionStats {
  /** 期間内で開始されたセッション数（=recordsInRange.length） */
  startedCount: number;
  completedCount: number;
  incompleteCount: number;
  completionRatePercent: number | null;
  totalInterruptions: number;
  /** startedCountが0なら0 */
  averageInterruptions: number;
  /** サンプル不足ならnull（月〜日、月曜=0） */
  mostInterruptedWeekday: number | null;
  mostInterruptedTimeOfDay: TimeOfDayPeriod | null;
}

/** 中断・一時停止の分析（仕様24番、期間内の全確定セッションが対象）。 */
export function getInterruptionStats(recordsInRange: FocusSessionRecord[]): InterruptionStats {
  const startedCount = recordsInRange.length;
  const completedCount = recordsInRange.filter((r) => r.completedFully === true).length;
  const incompleteCount = startedCount - completedCount;
  const completionRatePercent =
    startedCount === 0 ? null : Math.round((completedCount / startedCount) * 100);

  const interruptionCountOf = (r: FocusSessionRecord): number =>
    Number.isFinite(r.interruptionCount) ? (r.interruptionCount as number) : 0;

  const totalInterruptions = recordsInRange.reduce((sum, r) => sum + interruptionCountOf(r), 0);
  const averageInterruptions =
    startedCount > 0 ? Math.round((totalInterruptions / startedCount) * 10) / 10 : 0;

  const byWeekday = new Map<number, { count: number; interruptions: number }>();
  const byTimeOfDay = new Map<TimeOfDayPeriod, { count: number; interruptions: number }>();

  for (const r of recordsInRange) {
    const weekday = toMondayFirstIndex(getWeekday(resolveLocalDateKey(r)));
    const wEntry = byWeekday.get(weekday) ?? { count: 0, interruptions: 0 };
    wEntry.count += 1;
    wEntry.interruptions += interruptionCountOf(r);
    byWeekday.set(weekday, wEntry);

    const started = new Date(r.startedAt);
    const period = classifyTimeOfDay(started.getHours(), started.getMinutes());
    const tEntry = byTimeOfDay.get(period) ?? { count: 0, interruptions: 0 };
    tEntry.count += 1;
    tEntry.interruptions += interruptionCountOf(r);
    byTimeOfDay.set(period, tEntry);
  }

  let mostInterruptedWeekday: number | null = null;
  let bestWeekdayAvg = -1;
  for (const [weekday, v] of byWeekday.entries()) {
    if (v.count < FOCUS_ANALYTICS_MIN_SAMPLE_FOR_BEST) continue;
    const avg = v.interruptions / v.count;
    if (avg > bestWeekdayAvg) {
      bestWeekdayAvg = avg;
      mostInterruptedWeekday = weekday;
    }
  }

  let mostInterruptedTimeOfDay: TimeOfDayPeriod | null = null;
  let bestTimeOfDayAvg = -1;
  for (const [period, v] of byTimeOfDay.entries()) {
    if (v.count < FOCUS_ANALYTICS_MIN_SAMPLE_FOR_BEST) continue;
    const avg = v.interruptions / v.count;
    if (avg > bestTimeOfDayAvg) {
      bestTimeOfDayAvg = avg;
      mostInterruptedTimeOfDay = period;
    }
  }

  return {
    startedCount,
    completedCount,
    incompleteCount,
    completionRatePercent,
    totalInterruptions,
    averageInterruptions,
    mostInterruptedWeekday,
    mostInterruptedTimeOfDay,
  };
}

export interface WeekdayTendencyStat {
  /** 0=月, ..., 6=日（月曜始まり、getFocusByWeekdayと同じ並び） */
  weekday: number;
  startedCount: number;
  completedCount: number;
  totalCreditedSeconds: number;
  completionRatePercent: number | null;
}

/** 曜日別の時間・件数・完遂率（仕様23番、期間内の全確定セッションが対象）。 */
export function getWeekdayTendency(recordsInRange: FocusSessionRecord[]): {
  stats: WeekdayTendencyStat[];
  bestCompletionRateWeekday: number | null;
} {
  const buckets = new Map<number, { started: number; completed: number; seconds: number }>();
  for (const r of recordsInRange) {
    const weekday = toMondayFirstIndex(getWeekday(resolveLocalDateKey(r)));
    const b = buckets.get(weekday) ?? { started: 0, completed: 0, seconds: 0 };
    b.started += 1;
    if (r.completedFully === true) {
      b.completed += 1;
      b.seconds += resolveCreditedFocusSeconds(r);
    }
    buckets.set(weekday, b);
  }

  const stats: WeekdayTendencyStat[] = Array.from({ length: 7 }, (_, weekday) => {
    const b = buckets.get(weekday) ?? { started: 0, completed: 0, seconds: 0 };
    return {
      weekday,
      startedCount: b.started,
      completedCount: b.completed,
      totalCreditedSeconds: b.seconds,
      completionRatePercent: b.started === 0 ? null : Math.round((b.completed / b.started) * 100),
    };
  });

  let bestCompletionRateWeekday: number | null = null;
  let bestRate = -1;
  for (const s of stats) {
    if (s.startedCount < FOCUS_ANALYTICS_MIN_SAMPLE_FOR_BEST || s.completionRatePercent === null) continue;
    if (s.completionRatePercent > bestRate) {
      bestRate = s.completionRatePercent;
      bestCompletionRateWeekday = s.weekday;
    }
  }

  return { stats, bestCompletionRateWeekday };
}

export interface TimeOfDayTendencyStat {
  period: TimeOfDayPeriod;
  startedCount: number;
  completedCount: number;
  totalCreditedSeconds: number;
  completionRatePercent: number | null;
}

/** 時間帯別の時間・件数・完遂率（仕様23番、期間内の全確定セッションが対象）。 */
export function getTimeOfDayTendency(recordsInRange: FocusSessionRecord[]): {
  stats: TimeOfDayTendencyStat[];
  bestCompletionRatePeriod: TimeOfDayPeriod | null;
} {
  const buckets: Record<TimeOfDayPeriod, { started: number; completed: number; seconds: number }> = {
    morning: { started: 0, completed: 0, seconds: 0 },
    afternoon: { started: 0, completed: 0, seconds: 0 },
    evening: { started: 0, completed: 0, seconds: 0 },
    midnight: { started: 0, completed: 0, seconds: 0 },
  };

  for (const r of recordsInRange) {
    const started = new Date(r.startedAt);
    const period = classifyTimeOfDay(started.getHours(), started.getMinutes());
    const b = buckets[period];
    b.started += 1;
    if (r.completedFully === true) {
      b.completed += 1;
      b.seconds += resolveCreditedFocusSeconds(r);
    }
  }

  const stats: TimeOfDayTendencyStat[] = TIME_OF_DAY_KEYS.map(({ period }) => {
    const b = buckets[period];
    return {
      period,
      startedCount: b.started,
      completedCount: b.completed,
      totalCreditedSeconds: b.seconds,
      completionRatePercent: b.started === 0 ? null : Math.round((b.completed / b.started) * 100),
    };
  });

  let bestCompletionRatePeriod: TimeOfDayPeriod | null = null;
  let bestRate = -1;
  for (const s of stats) {
    if (s.startedCount < FOCUS_ANALYTICS_MIN_SAMPLE_FOR_BEST || s.completionRatePercent === null) continue;
    if (s.completionRatePercent > bestRate) {
      bestRate = s.completionRatePercent;
      bestCompletionRatePeriod = s.period;
    }
  }

  return { stats, bestCompletionRatePeriod };
}
