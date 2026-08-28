import { AppEvent, FocusSession, FocusSessionStatus, FocusTask, isFocusTask } from "@/types/event";
import { combineDateAndTime } from "@/utils/time";

/** アクティブセッションのうち「進行中とみなせる」状態。この状態のセッションがある間は、
 *  新たな集中対象の検出・案内を行わない（アクティブセッションは常に1件のみ許可するため）。
 *  focusSessionRepository.tsのBLOCKING_STATUSESと同じ定義（依存を増やさないよう複製）。 */
const BLOCKING_STATUSES: FocusSessionStatus[] = [
  "scheduled",
  "running",
  "paused",
  "ready_to_complete",
];

/**
 * 「集中対象になりうる予定」の共通条件（未完了のFocusTask、かつ進行中とみなせる
 * アクティブセッションが無い）。findDueFocusTask/findNextScheduledFocusStartの両方が
 * この関数を通すことで、両者の判定条件が食い違わないようにする。
 */
function eligibleFocusTasks(
  events: AppEvent[],
  activeSession: FocusSession | null
): FocusTask[] {
  if (activeSession && BLOCKING_STATUSES.includes(activeSession.status)) {
    return [];
  }
  return events.filter((e): e is FocusTask => isFocusTask(e) && !e.completed);
}

/** 不正な日付・時刻文字列（parseIntが失敗する等）はNaNになり、以降の比較で
 *  自然に除外される（例外は投げない）。Number.isFiniteで明示的に弾く。 */
function focusStartTimestamp(task: FocusTask): number {
  return combineDateAndTime(task.date, task.startTime).getTime();
}

/** 開始時刻の昇順、同時刻はeventIdの辞書順という決定的な順序で1件を選ぶ。 */
function earliest<T extends { task: FocusTask; ts: number }>(items: T[]): T | undefined {
  return items.sort((a, b) => a.ts - b.ts || a.task.id.localeCompare(b.task.id))[0];
}

/**
 * 開始時刻を過ぎている・未完了の集中予定のうち、最も開始時刻が早いものを1件返す純粋関数。
 * 進行中とみなせるアクティブセッションが既にある場合は、新たな対象を検出しない
 * （呼び出し元はこれを使って、案内バーの表示要否を判定する。
 * 自動遷移は行わず、あくまで「案内するかどうか」の判定だけを担う）。
 *
 * dismissedEventIdsを渡すと、そのeventIdの予定を候補から除外する（2026-08: ユーザーが
 * 一度閉じた予定が、より開始時刻の早い予定として後続の予定を永久に塞いでしまわないための
 * 対応。渡さない場合は除外なし＝従来どおりの挙動）。
 */
export function findDueFocusTask(
  events: AppEvent[],
  nowMs: number,
  activeSession: FocusSession | null,
  dismissedEventIds?: ReadonlySet<string>
): FocusTask | undefined {
  const candidates = eligibleFocusTasks(events, activeSession)
    .filter((task) => !dismissedEventIds?.has(task.id))
    .map((task) => ({ task, ts: focusStartTimestamp(task) }))
    .filter(({ ts }) => Number.isFinite(ts) && ts <= nowMs);
  return earliest(candidates)?.task;
}

export interface NextFocusStart {
  eventId: string;
  scheduledStartTimestamp: number;
}

/**
 * まだ開始時刻が来ていない集中予定のうち、最も開始時刻が近いものを1件返す純粋関数。
 * findDueFocusTaskと同じ適格条件（eligibleFocusTasks）を使うため、両者の判定は
 * 常に整合する。呼び出し元（useDueFocusTaskWatcher）はこれを使って、次に再判定すべき
 * 時刻（setTimeoutの発火目標）を求める。
 */
export function findNextScheduledFocusStart(
  events: AppEvent[],
  nowMs: number,
  activeSession: FocusSession | null
): NextFocusStart | undefined {
  const candidates = eligibleFocusTasks(events, activeSession)
    .map((task) => ({ task, ts: focusStartTimestamp(task) }))
    .filter(({ ts }) => Number.isFinite(ts) && ts > nowMs);
  const winner = earliest(candidates);
  return winner ? { eventId: winner.task.id, scheduledStartTimestamp: winner.ts } : undefined;
}

/**
 * 通知経由のautostartを開始時刻でガードするための純粋関数。
 * now < 予定開始時刻 の間はtrue（＝まだ自動開始してはいけない）。
 * 端末時刻のずれ・通知の配信遅延・古い通知データを考慮し、通知タップ後に画面側で
 * 最終確認するために使う（予定詳細画面からの明示的な早期開始はこのガードの対象外）。
 */
export function isBeforeScheduledStart(
  task: Pick<FocusTask, "date" | "startTime">,
  nowMs: number
): boolean {
  return nowMs < combineDateAndTime(task.date, task.startTime).getTime();
}
