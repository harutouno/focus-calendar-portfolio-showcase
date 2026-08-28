import { getCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";

/**
 * SEC-F007-001 REVISE対応（第8ラウンド、P1-5）: 共有カレンダー・共有予定に関わる
 * 書込み系操作（AppDataContext.tsxの公開メソッド、およびそこから呼ぶ
 * eventService/calendarService/calendarFacadeの共有API）が、開始時点だけでなく
 * 処理の途中（各awaitの後、次の副作用の前）でも一貫して同じ手段で「今も自分が
 * 現在のidentityか」を確認できるようにする共通の型・関数群。AppDataContext.tsx単体に
 * 閉じていた第7ラウンドのassertStillCurrentOwnerを、eventService.ts・calendarService.ts・
 * calendarFacade.tsからも参照できる独立モジュールへ切り出した
 * （AppDataContext.tsxがeventService.ts等をimportする既存の依存方向のため、
 * 逆方向のimportを避けるにはAppDataContext.tsx側に置けない）。
 */
export interface SharedMutationIdentity {
  userId: string;
  sessionInstanceId: string;
}

/**
 * REVISE対応（第11ラウンド、P1-1）: 書込み系（Mutation）だけでなく読取り系（Read）の
 * 共有API（fetchJoinedCalendars等）もidentity契約の対象にするための別名。構造は
 * SharedMutationIdentityと完全に同一（型を複製しない）——呼び出し側のコード上での
 * 意図（書込みか読取りか）を示すためだけのaliasで、実行時の意味・チェック関数は共通のまま。
 */
export type SharedOperationIdentity = SharedMutationIdentity;

export const STALE_SHARED_MUTATION_IDENTITY_MESSAGE =
  "ログイン中のアカウントが処理中に切り替わったため、この操作を続行できませんでした。もう一度お試しください";

/** 指定したidentityが、権威あるauthSessionIdentityStoreの現在値と一致するかを判定する。 */
export function isCurrentSharedMutationIdentity(identity: SharedMutationIdentity): boolean {
  const current = getCurrentAuthIdentity();
  return current.userId === identity.userId && current.sessionInstanceId === identity.sessionInstanceId;
}

/** 一致しない場合は例外を投げる。呼び出し元は副作用（Supabase・Storage・通知・同期キュー等）の直前に呼ぶ。 */
export function assertCurrentSharedMutationIdentity(identity: SharedMutationIdentity): void {
  if (!isCurrentSharedMutationIdentity(identity)) {
    throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
  }
}

/**
 * 共有mutation1件分の実行器。開始前に必ず1回検証し（古いクロージャからの呼び出しを
 * 副作用の前に遮断する、第7ラウンドのassertStillCurrentOwnerと同じ役割）、operation本体へ
 * `assertCurrent`（同じidentityを再検証する関数）を渡す。operation側は、各awaitの直後・
 * 次の副作用（dispatch/refresh/overlay/notification/queue）の前でこれを呼ぶ責任を持つ。
 *
 * REVISE対応（第10ラウンド、P1-3）: 以前はoperation側が最後のassertCurrentを呼び忘れると、
 * 既にidentityが切り替わっていてもstaleな成功結果をそのまま呼び出し元へ返してしまう
 * 余地があった（呼び出し元の規律に依存する設計）。operationが正常終了した直後にも、
 * このrunner自身が無条件でもう一度検証する多層防御を追加した。operation内部の各await間の
 * チェックは引き続きoperation側の責任のまま（このrunnerは開始前と終了直後の2点のみを
 * 保証する）。operationが例外を投げた場合はそのまま伝播させ、この最終検証は行わない
 * （失敗時の後始末は呼び出し元の既存のtry/catch設計に委ねる）。
 */
export async function runCurrentSharedMutation<T>(
  identity: SharedMutationIdentity,
  operation: (assertCurrent: () => void) => Promise<T>
): Promise<T> {
  assertCurrentSharedMutationIdentity(identity);
  const result = await operation(() => assertCurrentSharedMutationIdentity(identity));
  assertCurrentSharedMutationIdentity(identity);
  return result;
}

/**
 * 1回のremote呼出し（1つのPromiseを返す関数）を、開始前・resolve直後・reject時の
 * いずれの経路でも同じ規律でidentity検証する共通ヘルパー（Round13、SEC-F007-004/
 * SEC-F007-001残存対応）。低レベルAPI関数が
 * 「remote呼出し完了後にerrorをthrow/null/falseへ変換してからidentityを確認する」
 * という順序の誤りを個別に埋め込まないよう、この関数自身がoperationのreject時にも
 * 常に「元の例外を投げる前」にidentityを再確認する。stale化と通常のremoteエラーが
 * 同時に起きた場合は常にstale専用の例外を優先する（同一identityのままなら、
 * 元のresolved値または元のエラーをそのまま維持する）。
 */
export async function awaitCurrentSharedOperation<T>(
  identity: SharedMutationIdentity,
  operation: () => Promise<T>
): Promise<T> {
  assertCurrentSharedMutationIdentity(identity);
  let result: T;
  try {
    result = await operation();
  } catch (e) {
    assertCurrentSharedMutationIdentity(identity);
    throw e;
  }
  assertCurrentSharedMutationIdentity(identity);
  return result;
}

/**
 * 画面のローカルstateをidentity単位で完全に分離するための、Reactの`key`remountパターン用
 * ヘルパー（REVISE対応、第10ラウンド、P1-1）。userId+sessionInstanceIdをkey文字列へ
 * 変換するだけの純粋関数（Reactに依存しない）。呼び出し元は、この値を内側コンポーネントへ
 * keyとして渡すことで、identityが変わった最初のコミットで古いidentityのローカルstateを
 * 一切公開せずに済む（Reactは同じ位置の要素のkeyが変わると、古いサブツリーを
 * アンマウントしてから新しいサブツリーをマウントするため、中間状態が観測されない）。
 */
export function buildIdentityRemountKey(
  userId: string | null | undefined,
  sessionInstanceId: string | null | undefined
): string {
  return `${userId ?? "guest"}:${sessionInstanceId ?? "none"}`;
}
