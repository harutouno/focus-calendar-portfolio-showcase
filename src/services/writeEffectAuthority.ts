/**
 * [P0164] 書き込み効果の権威（write-effect authority）— 共有失敗ドメインの中核。
 *
 * 根本不変条件:
 *
 * ```text
 * NO_ERROR != EFFECT_APPLIED
 *
 * 特定の行/オブジェクトへ効果を及ぼすことが意味的に必須な mutation は、
 * 権威ある効果証跡なしに primary success を報告してはならない。
 * RLS による不可視は「グローバルな不在」の証明ではない。
 * ```
 *
 * この不変条件が要るのは、本プロジェクトの RLS ポリシーの大半が
 * **USING 句で対象行を絞り込む**形だからである。権限が無い・行が無い場合、
 * PostgREST の UPDATE/DELETE は「0 件が条件に一致した」という扱いになり
 * **エラーを一切返さない**。`.select()` を付けなければ
 * `{ data: null, error: null }` が返るだけで、クライアントには
 * 「適用された」と「1 行も変わっていない」を区別する情報が届かない。
 *
 * 既に同型の欠陥が 3 度見つかっている:
 *   - P0080 F015  events の phantom deletion
 *   - P0162 CORRECT-F022-001  calendars の phantom rename
 *   - P0164（本バッチ） calendar_members / calendars の残り
 *
 * ## 分類語彙
 *
 * 各 write は「primary success を名乗るために何の証跡が要るか」で分類する。
 * 分類は **関数名からではなく、実際の呼び出し形と対象ポリシーから**行う。
 *
 * | 分類 | 意味 |
 * |---|---|
 * | `EFFECT_REQUIRED` | 意図した行/オブジェクトへ効果が及んだ証明が要る |
 * | `IDEMPOTENT_ABSENCE_OK` | 効果 0 でも、**権威をもって不在が分かる場合に限り**成功 |
 * | `BEST_EFFORT_SECONDARY` | 効果無しが意図的に非 primary。primary success として報告しない |
 * | `RETURNING_CONFIRMED` | 既存の `.select()` / RPC 返却契約が効果を証明済み |
 * | `SERVER_EXPLICIT_OUTCOME` | RPC/サーバ関数が型付きの明示 outcome を返す |
 */

/**
 * 行に効果を及ぼす write の結果。
 *
 * - `applied`      … 実際に 1 行以上へ効果が及んだ（権威あり）
 * - `already-absent` … 対象が既に無いことを**権威をもって**確認できた
 *                      （＝呼び出し元が対象集合を読めており、その中に対象が居ない）
 * - `blocked`      … 0 行だが対象はまだ見えている＝拒否が**確定**している
 * - `unconfirmed`  … 0 行かつ対象を確認できない。**不在と断定してはならない**
 *                     （削除済みなのか読取権を失ったのか区別できない）
 */
export type WriteEffectOutcome = "applied" | "already-absent" | "blocked" | "unconfirmed";

export interface WriteEffectResult {
  outcome: WriteEffectOutcome;
}

/**
 * 0 行だったときの読み戻し結果から outcome を決める共通判定。
 *
 * `canObserveTargetSet` は「呼び出し元が対象集合そのものを観測できたか」。
 * 観測できていない場合、対象が見つからないことは**不在の証明にならない**ので
 * 必ず `unconfirmed` になる（RLS 不可視 != グローバル不在）。
 */
export function classifyZeroRowEffect(params: {
  canObserveTargetSet: boolean;
  targetStillPresent: boolean;
}): Exclude<WriteEffectOutcome, "applied"> {
  if (!params.canObserveTargetSet) return "unconfirmed";
  return params.targetStillPresent ? "blocked" : "already-absent";
}

/**
 * ユーザー向け文言は既存の `toFriendlyMessage` で解決される。
 * `permission` を含むものは `friendlyError.notAuthorized` へ、
 * それ以外は呼び出し元の fallback へ落ちる（新規 i18n キーは追加していない）。
 */
export const SHARED_MEMBER_WRITE_BLOCKED_MESSAGE = "shared_member_write_permission_denied";
export const SHARED_MEMBER_WRITE_UNCONFIRMED_MESSAGE = "shared_member_write_result_unconfirmed";
export const SHARED_CALENDAR_LEAVE_BLOCKED_MESSAGE = "shared_calendar_leave_permission_denied";
export const SHARED_CALENDAR_LEAVE_UNCONFIRMED_MESSAGE = "shared_calendar_leave_result_unconfirmed";
