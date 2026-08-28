/**
 * P0017 Batch1.4: owner-bound端末設定（overlay/favorite/last-used）の永続化操作全体
 * （recovery・safe read・local-only write・owner-bound writeのいずれも）を直列化する、
 * module-level（JSプロセス全体で単一）のPromiseチェーン。
 *
 * P0016まではAppDataContext.tsx内の`useRef`（`localPreferenceChainRef`）を正本にしていたが、
 * これはReactの`AppDataProvider`インスタンスごとに独立しているため、
 * - Providerがremountされる（例: identity-key remountパターン）と直列化が引き継がれない
 * - 複数のProviderインスタンスが同時に存在する状況（テスト・二重mount）でも直列化されない
 * という構造的な穴があった。pending Storage keyそのものはprocess全体でグローバルな
 *単一スロットなので、直列化の正本もReactの外（module-level）に置く必要がある。
 *
 * 満たすべき契約:
 * - Provider remountを跨いで共有される（moduleは一度しかロードされないため自然に満たす）
 * - 2つ以上のProviderインスタンスが存在しても同じchainを共有する
 * - recovery / safe read（readOwnerBoundPreferencesSafely） / local-only write /
 *   owner-bound writeのいずれも、必ずこのenqueueOwnerBoundPreferenceOperationを経由する
 *   （呼び出し元は`ownerBoundPreferenceRepository.ts`とAppDataContext.tsxの
 *   commitOwnerBoundLocalPreferenceImplのみ）
 * - 1つの操作が例外を投げても、chain自体は継続し後続の操作を妨げない
 *   （`.then(fn, fn)`で成功・失敗どちらの経路でも次のenqueueへ進めるようにする）
 * - React側のclosure/stateをこのchainの正本として使わない（moduleスコープの変数のみ）
 */

let ownerBoundPreferenceChain: Promise<unknown> = Promise.resolve();

/**
 * 渡されたoperationを、これまでにenqueueされた全operationの完了（成功・失敗いずれも）を
 * 待ってから実行する。呼び出し元へ返すPromiseは、このoperation自身の結果
 * （成功時はその戻り値、失敗時はそのエラー）をそのまま反映する
 * （chain継続のための内部的な成功/失敗の握りつぶしは、呼び出し元へ見えるPromiseには影響しない）。
 */
export function enqueueOwnerBoundPreferenceOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const run = ownerBoundPreferenceChain.then(operation, operation);
  // chain自体（次のenqueueが待つ対象）は、このoperationの成功/失敗を問わず
  // 「完了した」という事実だけを伝播させる。runの結果（成功値・reject理由）は
  // 呼び出し元へ返すPromise（run自体）にのみ現れ、chainの継続には影響しない。
  ownerBoundPreferenceChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * テスト専用: moduleスコープのchainをリセットする。呼び出し側は、これまでにenqueueした
 * 全operationが実際にsettle（resolve/reject）した後にのみ呼ぶこと
 * （settle前に呼ぶと、その未解決operationの完了を待つ経路が失われる）。本番コードから呼ばない。
 */
export function __resetOwnerBoundPreferenceCoordinatorForTests(): void {
  ownerBoundPreferenceChain = Promise.resolve();
}
