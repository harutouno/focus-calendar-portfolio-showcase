/**
 * SEC-F006-001残存修正: 端末単位で永続化するAI関連データ（chatHistory・
 * aiPendingRequest）の所有者スコープ判定。保存済みの`ownerUserId`は3つの状態を
 * 区別する必要があり、いずれも安全側（復元しない方向）に倒す。
 *
 * - `ownerUserId`が文字列: 認証済みユーザー本人の依頼・履歴。`currentUserId`と
 *   完全一致する場合のみ復元してよい。
 * - `ownerUserId === null`（明示的に保存された値）: 保存時点で未ログインだった、
 *   明示的なゲスト・端末スコープのデータ。`currentUserId`もnull（今も未ログイン）の
 *   場合のみ復元してよい。ログイン済みユーザーへは返さない
 *   （ローカル予定等の「常に端末単位で共有」とは異なり、AIの自由入力・応答は
 *   ログイン済みアカウントの一部として保護する）。
 * - `ownerUserId === undefined`（この保護を導入する前の旧形式データで、
 *   キー自体が存在しない）: 保存時点の所有者が本当にゲストだったのか、当時
 *   ログインしていた別ユーザーだったのかを判別する手段が無い「所有者不明」データ。
 *   未ログイン・同一端末のどのユーザーにも復元しない（別ユーザーのものとして
 *   無条件に扱わない、かつ本人のものとしても無条件に扱わない）。
 */
export function isOwnerScopeVisible(
  ownerUserId: string | null | undefined,
  currentUserId: string | null
): boolean {
  if (ownerUserId === undefined) return false;
  if (ownerUserId === null) return currentUserId === null;
  return ownerUserId === currentUserId;
}
