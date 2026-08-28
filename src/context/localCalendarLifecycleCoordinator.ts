/**
 * [P0096 DATA-F018-003] 端末内カレンダー一覧（userCalendars）に対するcreate/update/delete
 * 操作全体を直列化する、module-level（JSプロセス全体で単一）のPromiseチェーン。
 *
 * `ownerBoundPreferenceCoordinator.ts`（overlay/favorite/last-used向け）と同じ設計理由・
 * 同じ契約をuserCalendars向けに複製したもの——2つの独立した直列化チェーンを1本化しない
 * 理由は、overlay/favorite/last-usedの直列化はowner-bound（アカウント切替時のstaleな
 * 書込み防止）が主目的なのに対し、こちらはpurely local（DBに一切保存しない端末内カレンダー
 * 一覧）な同時実行の一貫性（lost update防止・上限判定の正しさ）が主目的であり、対象データも
 * 完全に独立しているため。
 *
 * 満たすべき契約:
 * - Provider remountを跨いで共有される（moduleは一度しかロードされないため自然に満たす）
 * - 2つ以上のProviderインスタンスが存在しても同じchainを共有する
 * - addUserCalendar/updateUserCalendar/removeUserCalendarの本体処理は必ずこの
 *   enqueueLocalCalendarLifecycleOperationを経由する（呼び出し元はAppDataContext.tsxのみ）
 * - 1つの操作が例外を投げても、chain自体は継続し後続の操作を妨げない
 *   （`.then(fn, fn)`で成功・失敗どちらの経路でも次のenqueueへ進めるようにする）
 * - React側のclosure/stateをこのchainの正本として使わない（moduleスコープの変数のみ）
 */

let localCalendarLifecycleChain: Promise<unknown> = Promise.resolve();

/**
 * 渡されたoperationを、これまでにenqueueされた全operationの完了（成功・失敗いずれも）を
 * 待ってから実行する。呼び出し元へ返すPromiseは、このoperation自身の結果
 * （成功時はその戻り値、失敗時はそのエラー）をそのまま反映する。
 */
export function enqueueLocalCalendarLifecycleOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const run = localCalendarLifecycleChain.then(operation, operation);
  localCalendarLifecycleChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * テスト専用: moduleスコープのchainをリセットする。呼び出し側は、これまでにenqueueした
 * 全operationが実際にsettle（resolve/reject）した後にのみ呼ぶこと。本番コードから呼ばない。
 */
export function __resetLocalCalendarLifecycleCoordinatorForTests(): void {
  localCalendarLifecycleChain = Promise.resolve();
}
