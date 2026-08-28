import { useRef } from "react";
import {
  AuthIdentity,
  authIdentityKey,
  isCurrentAuthIdentity,
} from "@/auth/authSessionIdentityStore";
import { useAuthIdentity } from "@/auth/useAuthIdentity";

/**
 * P0148 (SEC-F007-005) §1/§5: 「1回のAI依頼（intent → request → result → reward）は、
 * その依頼を始めた**正確な1つの {userId, sessionInstanceId}** に属する」という不変条件を
 * 構造として表現する型と関数群。
 *
 * 従来の実装は、hookが「今のidentityKey」を毎レンダー読み直し、identityが変わったら
 * 「新しい持ち主の依頼として読み込み直す」動きだった。これは前の持ち主の入力内容
 * （route paramに載ったまま）を新しい持ち主として自動送信することを許してしまう。
 *
 * ここで導入する `AiOperationOwner` は**1つの意図につき一度だけ確定して二度と変わらない**
 * （P0148ではprocessing画面のマウント時点で捕捉していたが、P0150で
 * 「明示的なユーザー操作の時点」へ移した——`src/ai/aiIntentHandoffStore.ts`）。
 * 現在の権威identityがこれと一致しなくなった瞬間、その依頼はstaleであり、
 *   - 新しいidentityへ再束縛しない
 *   - 新しいidentityとして送信しない
 *   - 新しいidentityのアカウント副作用を発火しない
 *   - 新しいidentityのデータとして表示しない
 * 新しいidentityがAI依頼を行えるのは、**新しい明示的なユーザー操作**からのみ。
 */
export type AiOperationOwner = AuthIdentity;

/**
 * - `capturing`: まだ「誰の依頼か」が確定していない（送信も復元もしない）。
 *   P0150以降は「明示的操作の時点で捕捉された所有者を、まだ受け取れていない」状態を指す
 *   （例: intentが未解決／不正／期限切れ）。
 * - `owned`: 捕捉した所有者が今も権威identityと一致する（通常動作）。
 * - `stale`: 権威identityが所有者と異なる。このマウントの依頼は破棄対象。
 */
export type AiOwnerDisposition = "capturing" | "owned" | "stale";

/**
 * 非同期境界（await直後・副作用の直前）用の判定。React stateやclosureではなく、
 * 常に `getCurrentAuthIdentity()` からfreshに読む。
 */
export function isAiOperationOwnerCurrent(owner: AiOperationOwner | null | undefined): boolean {
  return isCurrentAuthIdentity(owner);
}

export interface AiOperationOwnership {
  /** マウント中に一度だけ確定する不変の所有者。未確定の間はnull。 */
  owner: AiOperationOwner | null;
  disposition: AiOwnerDisposition;
  /** render時点の権威identity（表示maskの判定に使う）。 */
  currentIdentity: AuthIdentity;
  currentIdentityKey: string;
  /** 所有者のキー。owner-tagged stateのタグとして使う（未確定の間はcurrentと同じ）。 */
  ownerIdentityKey: string;
}

/**
 * 「1つの明示的なユーザー意図」に対する**外部で捕捉済みの所有者**と、現在の権威identityとの
 * 関係（owned / stale / capturing）を算出する。
 *
 * P0150 (SEC-F007-006) の根本修正:
 *   P0148のこの関数は `readyToCapture` が真になった最初のレンダーで
 *   **「その時点の権威identity」を所有者として捕捉**していた。所有者を確定する場所が
 *   「明示的なユーザー操作」ではなく「画面のマウント」だったため、送信操作から
 *   processing画面のマウントまでの間にidentityが切り替わると、前の持ち主の入力が
 *   新しい持ち主の依頼として再束縛されてしまった（＝ナビゲーションが所有権を
 *   奪える構造だった）。
 *
 *   現在この関数は**所有者を一切捕捉しない**。所有者は明示的操作の時点で
 *   `aiIntentHandoffStore.publishAiIntent` によって確定され、`readAiIntent` を
 *   通してのみ（＝現在の権威identityが完全一致するときだけ）取り出せる。
 *   ここは受け取った所有者を1回だけrefへ固定し、以後は「今の権威identityと
 *   一致しているか」だけを判定する。
 *
 * refへの書き込みはこの遅延初期化1回だけで、以後は読み取り専用
 * （既存の `identityKeyRef.current = identityKey` と同じ、render中のref初期化パターン）。
 * 一度確定した所有者は、あとから別の所有者が渡されても**差し替えない**
 * （1つの意図＝1つの不変の所有者。別の意図は別のマウントで扱う）。
 */
export function useAiOperationOwner(
  capturedOwner: AiOperationOwner | null
): AiOperationOwnership {
  const currentIdentity = useAuthIdentity();
  const ownerRef = useRef<AiOperationOwner | null>(null);
  if (ownerRef.current === null && capturedOwner !== null) {
    // authSessionIdentityStoreは値を書き換えず、常に新しいオブジェクトへ差し替えるため、
    // ここで保持した参照は以後の変更に影響されない（不変の所有者になる）。
    ownerRef.current = capturedOwner;
  }
  const owner = ownerRef.current;
  const currentKey = authIdentityKey(currentIdentity);
  const ownerKey = owner ? authIdentityKey(owner) : currentKey;
  const disposition: AiOwnerDisposition =
    owner === null ? "capturing" : ownerKey === currentKey ? "owned" : "stale";
  return {
    owner,
    disposition,
    currentIdentity,
    currentIdentityKey: currentKey,
    ownerIdentityKey: ownerKey,
  };
}
