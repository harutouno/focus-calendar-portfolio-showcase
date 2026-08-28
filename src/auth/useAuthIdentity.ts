import { useSyncExternalStore } from "react";
import {
  AuthIdentity,
  authIdentityKey,
  getCurrentAuthIdentity,
  subscribeToAuthIdentity,
} from "@/auth/authSessionIdentityStore";

/**
 * P0148 (SEC-F007-005) §3: 権威あるidentity（authSessionIdentityStore）をReactの
 * render時点から直接読むための唯一の購読フック。
 *
 * なぜAuthContextでは不十分か:
 *   `AuthContext` は `setCurrentAuthIdentity()` を呼んだ**後**に `setAuthState()` する
 *   （src/context/AuthContext.tsx）。つまりストアが先行し、React stateは遅れて追従する。
 *   そのため「AuthContextのclosureから読んだuser/sessionInstanceId」は、
 *   セキュリティ判断（誰として送信するか・誰の副作用を起こすか・誰に表示するか）の
 *   根拠には使えない。`useSyncExternalStore` はストアの購読者としてReactに登録されるため、
 *   ストアが更新された瞬間にrenderがスケジュールされ、**effectの実行を待たずに**
 *   最新の権威identityがrender時点で読める。
 *
 * 二重の権威を作らないこと:
 *   このフックはストアを読むだけで、書き込みは一切行わない。identityを公開する権限は
 *   引き続き `AuthContext` → `setCurrentAuthIdentity()` だけが持つ。
 *
 * AuthContextの用途は残る:
 *   `loading`（セッション復元中かどうか）等、ユーザー向けの表示状態はAuthContextのままでよい。
 *   禁止しているのは「セキュリティ判断をAuthContextのclosureに依存させること」だけ。
 */
export function useAuthIdentity(): AuthIdentity {
  return useSyncExternalStore(
    subscribeToAuthIdentity,
    getCurrentAuthIdentity,
    getCurrentAuthIdentity
  );
}

/** `useAuthIdentity()` の結果をmask/remount用のキー文字列として得る薄いラッパー。 */
export function useAuthIdentityKey(): string {
  return authIdentityKey(useAuthIdentity());
}
