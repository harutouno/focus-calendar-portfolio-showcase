/**
 * [P0120 Group D / ROBUST-POSTPRIMARY-001] post-primary secondary step の共通境界。
 *
 * 不変条件（P0105以来のmaster rule、P0119で受理済み）:
 *
 *     primary mutation が権威的・durable に確定した後は、
 *     二次的な refresh / reload / reconcile / cleanup / presentation の失敗が
 *     primary を「失敗」として再定義してはならない
 *     （明示的にユーザー承認された atomic-success 契約がある場合を除く）。
 *
 * 意図的に**極めて薄い**設計にしている（P0120 §5「narrowest reusable boundary possible.
 * Do not create one giant catch-all helper that hides security or primary failures.」）:
 *
 * - 包んでよいのは「primaryが既にdurableに確定した後の、二次的な1ステップ」だけ。
 * - primary呼び出し自体・pre-primaryの検証は**絶対に包まない**（pre-primary failureを
 *   握りつぶさない）。
 * - identity-stale の security assertion（assertCurrentSharedMutationIdentity 等）も
 *   **絶対に包まない**。呼び出し側はこのヘルパーの外側に置くこと
 *   （このヘルパーはsecurity assertionを一切内包しない）。
 * - UI文言は一切生成しない。失敗は__DEV__のconsole.warnにのみ出す。
 * - `label`は「どのステップを吸収したか」をログと読解の両方で一意にするための必須引数
 *   （匿名のcatch-allにしないための設計上の強制）。
 */
export async function runPostPrimaryStep(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (__DEV__) {
      console.warn(`[postPrimary] ${label}（primary確定後の二次処理）に失敗しました`, e);
    }
  }
}
