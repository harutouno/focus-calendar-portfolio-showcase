import { AppEvent } from "@/types/event";

/**
 * 繰り返し予定（recurringGroupIdを持つ予定）の編集・削除範囲。
 * - single: 選択した予定のみ
 * - following: recurrenceIndexが選択した予定以上の予定
 * - all: 同じrecurringGroupIdを持つ全予定
 */
export type RecurringEditScope = "single" | "following" | "all";

/**
 * scopeに応じて、baseEventと同じrecurringGroupIdを持つ兄弟予定（allEvents内）から
 * 更新・削除の対象を絞り込む純粋関数。
 *
 * - baseEventにrecurringGroupIdが無い（通常予定）場合、scopeによらずbaseEvent単体を返す
 *   （通常予定は範囲選択の対象外であることをここでも保証する）。
 * - "single": baseEvent単体のみ
 * - "following": 同じrecurringGroupIdの予定のうち、recurrenceIndexがbaseEvent以上のもの
 * - "all": 同じrecurringGroupIdを持つ全予定
 */
export function selectRecurringTargets(
  allEvents: AppEvent[],
  baseEvent: AppEvent,
  scope: RecurringEditScope
): AppEvent[] {
  if (scope === "single" || !baseEvent.recurringGroupId) return [baseEvent];

  const siblings = allEvents.filter((e) => e.recurringGroupId === baseEvent.recurringGroupId);
  if (scope === "all") return siblings;

  const baseIndex = baseEvent.recurrenceIndex ?? 0;
  return siblings.filter((e) => (e.recurrenceIndex ?? 0) >= baseIndex);
}
