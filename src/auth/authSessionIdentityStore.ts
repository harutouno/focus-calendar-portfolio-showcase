/**
 * SEC-F007-001 必須修正2: 認証セッションの識別情報（userId・sessionInstanceId）を、
 * React state（AuthContext）とは別に、React外の同期モジュールとして保持する。
 *
 * 目的: sharedNotificationCoordinator（Stage 2）が「現在の所有者は誰か」を判定する際、
 * AppDataContextのuseEffectがコミット後に更新するのを待たずに済むようにする。
 * AuthContextは、onAuthStateChange/getSessionの結果を受け取った"同じ同期処理内"で、
 * React state（setState）を呼ぶより前にこのストアを更新する。これにより、
 * 通知coordinatorの所有者判定はEffectの実行タイミングに一切依存しない。
 *
 * このストア自体はReactに依存しない、モジュールスコープの単純な可変状態＋購読者リストであり、
 * 「初期化以外でレンダー中にref.currentを読み書きしない」というReactのルールとは無関係
 * （Reactのレンダーサイクルの外側にある、意図的なグローバル同期ストアのため）。
 */
export interface AuthIdentity {
  userId: string | null;
  /** Supabase JWTのsession_id claim。取得できなかった異常なセッションではnull。 */
  sessionInstanceId: string | null;
}

const INITIAL_IDENTITY: AuthIdentity = { userId: null, sessionInstanceId: null };

let current: AuthIdentity = INITIAL_IDENTITY;
const listeners = new Set<(identity: AuthIdentity) => void>();

/**
 * REVISE対応（第9ラウンド、P2）: 個々のlistener呼び出しをtry/catchで隔離する。
 * sharedNotificationCoordinator自身のコールバックは既に内部でtry/catchしているが、
 * 将来この関数を購読する別のコードが例外を投げた場合、その1つの失敗のせいで
 * ループが中断し、後続のlistener（AuthContextのReact state発行を含む可能性がある）が
 * 呼ばれなくなるのを防ぐ。currentの更新自体は先に確定させ、この関数自体は
 * 何が起きても例外を投げない。
 */
export function setCurrentAuthIdentity(identity: AuthIdentity): void {
  // P0148 (SEC-F007-005): 値が同じなら「変化していない」ものとして何もしない。
  // このストアは`useSyncExternalStore`（src/auth/useAuthIdentity.ts）のスナップショット
  // 供給元でもあり、getSnapshotは「同じ状態なら同じ参照」を返す必要がある。
  // 同一内容でも毎回新しいオブジェクトへ差し替えると、Reactからは毎回「変化した」と
  // 見え、購読しているコンポーネントが不要に再レンダーされる（呼び出し元がレンダー中に
  // 呼ぶような経路では再レンダーのループにもなりうる）。identityの実際の変化だけを
  // 通知するのが、このストアの本来の契約でもある。
  if (current.userId === identity.userId && current.sessionInstanceId === identity.sessionInstanceId) {
    return;
  }
  current = identity;
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (e) {
      if (__DEV__) {
        console.warn("[authSessionIdentityStore] identity変更リスナーで例外が発生しました", e);
      }
    }
  }
}

export function getCurrentAuthIdentity(): AuthIdentity {
  return current;
}

/**
 * P0148 (SEC-F007-005): 2つのidentityが「完全に同一」かを判定する純粋関数。
 * userIdだけの一致では同一ユーザーの別セッション（再ログイン）を区別できないため、
 * 必ず userId と sessionInstanceId の**両方**を厳密比較する。
 * `sharedMutationIdentity.isCurrentSharedMutationIdentity` と同じ判定だが、あちらは
 * 非nullのuserId/sessionInstanceIdしか表現できない型のため、ゲスト（未ログイン）を
 * 含むAIライフサイクルではこちらを使う。
 */
export function isSameAuthIdentity(a: AuthIdentity, b: AuthIdentity): boolean {
  return a.userId === b.userId && a.sessionInstanceId === b.sessionInstanceId;
}

/** 指定identityが、現在の権威identityと完全一致するか。nullは常にfalse（fail-closed）。 */
export function isCurrentAuthIdentity(identity: AuthIdentity | null | undefined): boolean {
  if (!identity) return false;
  return isSameAuthIdentity(current, identity);
}

/**
 * identityを比較・mask用の文字列キーへ変換する純粋関数。
 * 既存のAI hookが使っていた `${userId ?? "null"}:${sessionInstanceId ?? "null"}` と同じ形式
 * （P0050/P0051のowner-tagged stateとの互換性を保つため形式を変えない）。
 */
export function authIdentityKey(identity: AuthIdentity): string {
  return `${identity.userId ?? "null"}:${identity.sessionInstanceId ?? "null"}`;
}

export function subscribeToAuthIdentity(listener: (identity: AuthIdentity) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** テスト専用: モジュールスコープの状態をリセットする。本番コードから呼ばない。 */
export function __resetAuthIdentityStoreForTests(): void {
  current = INITIAL_IDENTITY;
  listeners.clear();
}
