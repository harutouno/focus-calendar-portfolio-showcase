import { FocusSessionRecord } from "@/types/event";
import {
  addDays,
  countConsecutiveDaysBackward,
  formatLocalDate,
  getWeekday,
  todayLocalDateString,
  weekdayLabelByIndex,
} from "@/utils/date";
import { SupportedLocale, TFunction } from "@/i18n/translations";
import { resolveCreditedFocusSeconds } from "@/utils/focusStats";

export interface TaskStreak {
  taskTitle: string;
  currentStreakDays: number;
  totalMinutes: number;
  sessionCount: number;
}

export interface WeeklyPoint {
  date: string;
  label: string;
  hours: number;
}

export interface DayCompletion {
  date: string;
  label: string;
  hasActivity: boolean;
}

function dateOf(record: FocusSessionRecord): string {
  return formatLocalDate(new Date(record.startedAt));
}

export function totalAchievedMinutes(history: FocusSessionRecord[]): number {
  return history.reduce((sum, r) => sum + r.actualMinutes, 0);
}

export function completedCount(history: FocusSessionRecord[]): number {
  return history.filter((r) => r.completedFully).length;
}

/**
 * 2026-08（単独最終修正）: 継続中タスクは正式仕様上「成果分析」に区分され、
 * completedFully===trueの記録だけを対象とする。未完了（中断）記録は継続日数・
 * 達成日・totalMinutes・一覧への出現のいずれにも影響させない
 * （完遂率・中断分析等、成果以外の分析にのみ未完了記録を使う）。
 * そのため最初に正式完了記録だけへ絞り込み、以降のグルーピング・日付集合・
 * 連続日数計算・totalMinutes計算は全てこのachievedRecordsだけを使う。
 */
export function streaksByTask(history: FocusSessionRecord[]): TaskStreak[] {
  const achievedRecords = history.filter((r) => r.completedFully === true);

  const byTask = new Map<string, FocusSessionRecord[]>();
  for (const r of achievedRecords) {
    const list = byTask.get(r.taskTitle) ?? [];
    list.push(r);
    byTask.set(r.taskTitle, list);
  }

  const results: TaskStreak[] = [];
  for (const [taskTitle, records] of byTask.entries()) {
    const activeDates = new Set(records.map(dateOf));
    let cursor = todayLocalDateString();
    // 今日に達成記録が無い場合は、直近の達成日から遡ってカウントする
    if (!activeDates.has(cursor)) {
      const sorted = [...activeDates].sort().reverse();
      if (sorted.length === 0) continue;
      cursor = sorted[0];
    }
    const streak = countConsecutiveDaysBackward(activeDates, cursor);
    // 集中時間の正本はcreditedFocusSeconds（待機時間を含まない）。秒のまま合算し、
    // 最後に1回だけ分へ変換する（個々のレコードやタスク単位で先に丸めてから合計しない）。
    const totalSeconds = records.reduce((sum, r) => sum + resolveCreditedFocusSeconds(r), 0);
    results.push({
      taskTitle,
      currentStreakDays: streak,
      totalMinutes: Math.round(totalSeconds / 60),
      sessionCount: records.length,
    });
  }
  return results.sort((a, b) => b.currentStreakDays - a.currentStreakDays);
}

export function longestCurrentStreak(streaks: TaskStreak[]): number {
  return streaks.reduce((max, s) => Math.max(max, s.currentStreakDays), 0);
}

/** 直近7日間（今日を含む）の日別達成時間（時間単位） */
export function weeklyHours(
  history: FocusSessionRecord[],
  locale: SupportedLocale = "ja"
): WeeklyPoint[] {
  const today = todayLocalDateString();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  return days.map((date) => {
    const minutes = history
      .filter((r) => dateOf(r) === date)
      .reduce((sum, r) => sum + r.actualMinutes, 0);
    // getWeekday はローカル日付文字列を UTC変換せずに解釈するため日ずれが起きない
    const weekday = getWeekday(date);
    return {
      date,
      label: weekdayLabelByIndex(weekday, locale),
      hours: Math.round((minutes / 60) * 10) / 10,
    };
  });
}

/** 過去7日間（今日を含まない、7日前〜昨日）の達成有無 */
export function last7DaysCompletion(
  history: FocusSessionRecord[],
  t: TFunction
): DayCompletion[] {
  const today = todayLocalDateString();
  return Array.from({ length: 7 }, (_, i) => {
    const daysAgo = 7 - i;
    const date = addDays(today, -daysAgo);
    return {
      date,
      label: daysAgo === 1 ? t("records.yesterday") : t("records.daysAgo", { days: daysAgo }),
      hasActivity: history.some((r) => dateOf(r) === date),
    };
  });
}
