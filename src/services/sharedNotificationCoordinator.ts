import { AppEvent } from "@/types/event";
import {
  AuthIdentity,
  getCurrentAuthIdentity,
  subscribeToAuthIdentity,
} from "@/auth/authSessionIdentityStore";
import {
  NotificationEventEntry,
  NotificationScheduleOutcome,
  cancelAllSharedNotificationsForOwner as cancelAllSharedNotificationsForOwnerLowLevel,
  cancelNotification as cancelNotificationLowLevel,
  cancelNotifications as cancelNotificationsLowLevel,
  discoverSharedNotificationIdentitiesFromOsMetadata,
  ensureNotificationPermissionAsync,
  getPendingOwnerCleanupTargetsStrict,
  reconcileNotifications as reconcileNotificationsLowLevel,
  repairCorruptNotificationRegistryIfNeeded as repairCorruptNotificationRegistryIfNeededLowLevel,
  retryPendingOwnerNotificationCleanups as retryPendingOwnerNotificationCleanupsLowLevel,
  scheduleNotification as scheduleNotificationLowLevel,
  scheduleNotifications as scheduleNotificationsLowLevel,
} from "@/services/notificationService";
import type { NotificationRegistryRepairResult } from "@/storage/notificationRepository";

/**
 * REVISE対応（第9ラウンド、P1-1）: 未解決クリーンアップの対象。`identity`は特定の
 * 所有者・セッションの組（同一ユーザーの別セッションを巻き込まない、セッション単位の
 * ブロック・cleanup）を表す。`legacy-owner`は本ラウンド以前に永続化された、セッション情報を
 * 持たない旧形式のエントリ（後方互換のため、全セッション分をまとめて対象にする）。
 */
type PendingCleanupTarget =
  | { kind: "identity"; ownerUserId: string; sessionInstanceId: string }
  | { kind: "legacy-owner"; ownerUserId: string };

function pendingTargetKey(target: PendingCleanupTarget): string {
  return target.kind === "identity"
    ? `identity:${target.ownerUserId}:${target.sessionInstanceId}`
    : `legacy-owner:${target.ownerUserId}`;
}

/**
 * SEC-F007-001 Stage 2: 共有予定に関わるローカル通知操作（schedule/cancel/reconcile）の
 * 唯一の入口。useSharedCalendarSync.ts・AppDataContext.tsxのいずれからもnotificationServiceの
 * schedule/cancel/reconcileを直接呼ばず、必ずこのモジュールを経由することで、
 * 「同じ共有通知を操作する複数のwriter」が生まれないようにする
 * （eventService.tsは通知に一切触れず、保存/削除の成否だけを返す設計へ変更した）。
 *
 * 所有者判定は、React stateやuseEffectの実行タイミングではなく、
 * authSessionIdentityStore（AuthContextが認証イベントと同じ同期処理内で更新する、
 * React外の同期ストア）の現在値と比較して行う。これにより、Reactの再レンダー・
 * コミット・Effectの実行を一切待たずに「今も自分が最新の所有者か」を判定できる。
 *
 * 全ての操作は単一のPromiseチェーンで直列化する（notificationService.reconcileNotifications
 * 自体のチェーンとは別に、coordinator側でも直列化することで、同じイベントループ内で
 * 発行された複数の共有通知operationが意図しない順序で並行実行されるのを防ぐ）。
 *
 * REVISE対応（第8ラウンド、P1-1〜P1-4）: 以前は、所有者切替を検知して新identityを
 * blockedにする処理（旧prepareSharedNotificationIdentity）を、AppDataContextの
 * useEffect（コミット後にしか実行されない）から明示的に呼び出す設計だった。認証identityが
 * authSessionIdentityStoreへ反映されてからこのEffectが実際に実行されるまでの間、
 * 新しいidentityがまだblockedになっていない窓が存在していた。このモジュール自身が
 * authSessionIdentityStore.subscribeToAuthIdentityを直接購読し、identityの変化と
 * 完全に同じ同期経路（setCurrentAuthIdentity内のリスナー呼び出し、Reactのコミット・
 * Effectより必ず先に実行される）でblockedIdentitiesを更新する設計へ変更した。
 * AppDataContext側のEffectはもはやcleanupの起点ではなく、barrier解除の通知を受けて
 * UIの再構築トリガー（reconcileRequestCounterの更新）を行うだけの購読側になった。
 */

/** identityKey -> Set<pendingTargetKey>（そのidentityが待っている未解決ターゲット群）。 */
const blockedIdentities = new Map<string, Set<string>>();
/** pendingTargetKey -> ターゲット本体（種別・所有者・（あれば）セッション）。 */
const ownersAwaitingCleanup = new Map<string, PendingCleanupTarget>();

function identityKey(userId: string, sessionInstanceId: string): string {
  return `${userId}:${sessionInstanceId}`;
}

function registerPendingTarget(target: PendingCleanupTarget): void {
  ownersAwaitingCleanup.set(pendingTargetKey(target), target);
}

/**
 * REVISE対応（第8ラウンド、P1-2）: アプリ起動直後・モジュール初回読込み直後は、
 * 永続化されたpending一覧・OSメタデータからの残留所有者発見のいずれもまだ行われていない
 * ため、「本当にblockすべき所有者が無い」ことをまだ保証できない。hydrateが成功するまでは
 * isSharedNotificationIdentityReadyが常にfalseを返す（＝いかなる共有通知操作も一切
 * 開始しない）ことで、fail-closedにする。
 *
 * REVISE対応（第9ラウンド、P1-1）: 以前は「pending一覧の読込み失敗のみ」をfail-closedの
 * 判定材料にしており、OSメタデータ側の走査失敗はベストエフォートで無視して
 * barrierHydrated=trueへ進めてしまっていた（＝OS側の残留を見落としたまま「調査完了」と
 * 誤認しうる）。予約済み一覧・表示済み一覧のいずれかの走査が失敗した場合も、pending一覧の
 * 読込み失敗と同様にhydrate自体を未完了のまま維持する。
 */
let barrierHydrated = false;
let hydratePromise: Promise<void> | null = null;

/**
 * REVISE対応（第8ラウンド、P1-2 → 第9ラウンド、P1-1で完全化）: 永続化されたpending一覧
 * （過去にcleanupが完了できなかったターゲット、`{kind:"identity",...}`または
 * `{kind:"legacy-owner",...}`）と、OS予約済み・表示済み通知のV3メタデータから直接発見できる
 * 共有identity（ownerUserId・sessionInstanceIdの組）の両方を、ownersAwaitingCleanupへ登録する。
 * pending一覧はcleanup失敗の明示的な記録のため、現在identityと一致していても登録する
 * （同一所有者が別セッションで再ログインした場合も、旧セッション分の残骸は消す必要がある
 * ため）。OSメタデータからの発見は、pending一覧への保存自体が失敗していた場合の保険
 * （addPendingOwnerCleanup/addPendingIdentityCleanupの書込み失敗）であり、現在ログイン中の
 * 識別情報と「ownerUserId・sessionInstanceIdの両方が完全一致する」場合のみ、その人自身の
 * 正当な通知として除外する（ownerUserIdだけの一致では除外しない——同一ユーザーの別セッション
 * （A/session1）を、現在のA/session2から見て誤って「自分自身の通知」として見逃さないため）。
 *
 * REVISE対応（第9ラウンド、P1-1）: pending一覧の読込みには`getPendingOwnerCleanupTargetsStrict`
 * （ストレージ障害・JSON破損・不正な要素のいずれでも例外を投げる厳格版）を使う。
 * OSメタデータ側も、予約済み一覧・表示済み一覧のいずれかの走査が失敗した場合は
 * `barrierHydrated`をfalseのまま維持する（fail-closed。以前はベストエフォートで
 * 「取得できた方だけ」を使い進めてしまっていた）。
 */
export function ensureSharedNotificationBarrierHydrated(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    let pendingTargets: PendingCleanupTarget[];
    try {
      pendingTargets = await getPendingOwnerCleanupTargetsStrict();
    } catch (e) {
      console.warn(
        "[sharedNotificationCoordinator] 未完了クリーンアップ一覧の読込みに失敗したため、共有通知をblockしたままにします",
        e
      );
      hydratePromise = null;
      return;
    }
    for (const target of pendingTargets) {
      registerPendingTarget(target);
    }

    const discovery = await discoverSharedNotificationIdentitiesFromOsMetadata();
    if (!discovery.scheduledScanSucceeded || !discovery.presentedScanSucceeded) {
      // REVISE対応（第9ラウンド、P1-1）: OS側の走査が不完全な間は「これ以上の残留は無い」
      // ことを保証できないため、hydrate全体を未完了のまま維持する（fail-closed）。
      console.warn(
        "[sharedNotificationCoordinator] OSメタデータの走査が不完全なため、共有通知をblockしたままにします",
        { scheduledScanSucceeded: discovery.scheduledScanSucceeded, presentedScanSucceeded: discovery.presentedScanSucceeded }
      );
      hydratePromise = null;
      return;
    }
    const current = getCurrentAuthIdentity();
    for (const identity of discovery.identities) {
      if (identity.ownerUserId === current.userId && identity.sessionInstanceId === current.sessionInstanceId) {
        continue;
      }
      registerPendingTarget({
        kind: "identity",
        ownerUserId: identity.ownerUserId,
        sessionInstanceId: identity.sessionInstanceId,
      });
    }

    barrierHydrated = true;
    // REVISE対応（第8ラウンド、P1-2、必須テスト1）: 起動時点で既にidentityが確定して
    // いた場合（再起動をまたいでも同じユーザーがログインしたまま等）、identityの
    // 「変化」イベント自体は一切発生しないため、handleIdentityTransition経由のblocker
    // 登録が行われない。hydrate完了時点の現在identityへ、ここで発見した未解決分すべてを
    // blockerとして直接登録することで、遷移イベントの有無に関わらず一律に保護する
    // （＝pending中の所有者と無関係な別ユーザーがこの時点で既にログイン済みであっても、
    // 未解決分がある間はblockされる）。
    registerCurrentIdentityAsBlockedByPending();
  })();
  return hydratePromise;
}

/**
 * REVISE対応（第8ラウンド、P1-2/P1-3）: 現在のauthSessionIdentityStoreのidentityへ、
 * その時点でownersAwaitingCleanupに残っている「未解決のターゲット」全員をblockerとして
 * 登録する。hydrate完了時・所有者切替時（handleIdentityTransition）の両方から呼ぶ
 * 共通処理。
 */
function registerCurrentIdentityAsBlockedByPending(): void {
  if (ownersAwaitingCleanup.size === 0) return;
  const current = getCurrentAuthIdentity();
  if (!current.userId || !current.sessionInstanceId) return;
  const key = identityKey(current.userId, current.sessionInstanceId);
  const set = blockedIdentities.get(key) ?? new Set<string>();
  for (const targetKey of ownersAwaitingCleanup.keys()) set.add(targetKey);
  blockedIdentities.set(key, set);
}

/** 指定したidentityが、未解決のcleanupでblockされていないかを判定する。 */
export function isSharedNotificationIdentityReady(
  userId: string,
  sessionInstanceId: string
): boolean {
  if (!barrierHydrated) return false;
  const blockers = blockedIdentities.get(identityKey(userId, sessionInstanceId));
  return !blockers || blockers.size === 0;
}

export const SHARED_NOTIFICATION_BARRIER_BLOCKED = "blocked-security-barrier" as const;
export type SharedNotificationBarrierBlocked = typeof SHARED_NOTIFICATION_BARRIER_BLOCKED;

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(
  ownerUserId: string,
  sessionInstanceId: string,
  op: (isCurrent: () => boolean) => Promise<T>
): Promise<T | SharedNotificationBarrierBlocked | undefined> {
  const isCurrentOwnerFn = () => {
    const identity = getCurrentAuthIdentity();
    return identity.userId === ownerUserId && identity.sessionInstanceId === sessionInstanceId;
  };
  const run: Promise<T | SharedNotificationBarrierBlocked | undefined> = chain.then(async () => {
    if (!isCurrentOwnerFn()) return undefined;
    // REVISE対応（第8ラウンド、P1-1）: 呼出し時点（enqueue前）だけでなく、実際に
    // このoperationがチェーン上で実行され始める直前にもバリアを再確認する。
    // 呼出し時点ではまだblockされていなくても、他のoperationの実行中にidentityが
    // 変化してblockされることがあるため。
    if (!isSharedNotificationIdentityReady(ownerUserId, sessionInstanceId)) {
      return SHARED_NOTIFICATION_BARRIER_BLOCKED;
    }
    return await op(isCurrentOwnerFn);
  });
  chain = run.catch(() => undefined);
  return run;
}

/**
 * 共有予定1件のローカル通知を予約する（保存が成功した場合に呼ぶ）。権限確認込みで、
 * `scheduleNotificationRequestingPermission`（ローカル予定専用）の共有予定版に相当する。
 * 呼び出し開始時点のownerUserId/sessionInstanceIdをクロージャとして固定し、直列化キューの
 * 順番が回ってきた時点・実際の予約完了直後の両方で所有者を再確認する
 * （notificationService.scheduleNotification内部のisCurrentチェックへ委譲する）。
 * 所有者が既に一致しない場合、またはセキュリティバリアでblock中の場合は、operation自体を
 * 行わず明示的な結果値を返す（undefinedで静かに失うのではなく、blockされたことを
 * 呼び出し元が判別できるようにする）。
 */
export function scheduleSharedEventNotification(
  event: AppEvent,
  ownerUserId: string,
  sessionInstanceId: string
): Promise<NotificationScheduleOutcome | SharedNotificationBarrierBlocked | undefined> {
  if (!isSharedNotificationIdentityReady(ownerUserId, sessionInstanceId)) {
    return Promise.resolve(SHARED_NOTIFICATION_BARRIER_BLOCKED);
  }
  return enqueue(ownerUserId, sessionInstanceId, async (isCurrent) => {
    const ownership = { scope: "shared" as const, ownerUserId, sessionInstanceId };
    if (!event.notification.enabled) {
      await scheduleNotificationLowLevel(event, { isCurrent, ownership });
      return "disabled";
    }
    const permission = await ensureNotificationPermissionAsync();
    if (!isCurrent()) return undefined;
    if (permission !== "granted") {
      await cancelNotificationLowLevel(event.id, { isCurrent, ownership });
      return "permission-denied";
    }
    await scheduleNotificationLowLevel(event, { isCurrent, ownership });
    return "scheduled";
  });
}

/** 共有予定複数件（一括作成・繰り返しfollowing/all）のローカル通知をまとめて予約する。 */
export function scheduleSharedEventNotifications(
  events: AppEvent[],
  ownerUserId: string,
  sessionInstanceId: string
): Promise<NotificationScheduleOutcome | SharedNotificationBarrierBlocked | undefined> {
  if (!isSharedNotificationIdentityReady(ownerUserId, sessionInstanceId)) {
    return Promise.resolve(SHARED_NOTIFICATION_BARRIER_BLOCKED);
  }
  return enqueue(ownerUserId, sessionInstanceId, async (isCurrent) => {
    if (events.length === 0) return "disabled";
    const ownership = { scope: "shared" as const, ownerUserId, sessionInstanceId };
    if (!events[0].notification.enabled) {
      await scheduleNotificationsLowLevel(events, { isCurrent, ownership });
      return "disabled";
    }
    const permission = await ensureNotificationPermissionAsync();
    if (!isCurrent()) return undefined;
    if (permission !== "granted") {
      await cancelNotificationsLowLevel(
        events.map((e) => e.id),
        { isCurrent, ownership }
      );
      return "permission-denied";
    }
    await scheduleNotificationsLowLevel(events, { isCurrent, ownership });
    return "scheduled";
  });
}

/**
 * 共有予定1件のローカル通知を取り消す。所有者が一致しない、またはセキュリティバリアで
 * block中の場合は明示的にblockされたことを返す（呼び出し元は現状"undefinedは無視してよい"
 * 規約のままで良いが、意図を持って区別したい呼び出し元は戻り値を確認できる）。
 */
export function cancelSharedEventNotification(
  eventId: string,
  ownerUserId: string,
  sessionInstanceId: string
): Promise<SharedNotificationBarrierBlocked | undefined> {
  if (!isSharedNotificationIdentityReady(ownerUserId, sessionInstanceId)) {
    return Promise.resolve(SHARED_NOTIFICATION_BARRIER_BLOCKED);
  }
  return enqueue(ownerUserId, sessionInstanceId, (isCurrent) =>
    cancelNotificationLowLevel(eventId, {
      isCurrent,
      ownership: { scope: "shared", ownerUserId, sessionInstanceId },
    })
  ).then((result) => (result === SHARED_NOTIFICATION_BARRIER_BLOCKED ? result : undefined));
}

/**
 * 共有予定複数件のローカル通知をまとめて取り消す（繰り返し予定の一括削除向け）。
 * cancelSharedEventNotificationと同じくバリア対象。
 */
export function cancelSharedEventNotifications(
  eventIds: string[],
  ownerUserId: string,
  sessionInstanceId: string
): Promise<SharedNotificationBarrierBlocked | undefined> {
  if (!isSharedNotificationIdentityReady(ownerUserId, sessionInstanceId)) {
    return Promise.resolve(SHARED_NOTIFICATION_BARRIER_BLOCKED);
  }
  return enqueue(ownerUserId, sessionInstanceId, (isCurrent) =>
    cancelNotificationsLowLevel(eventIds, {
      isCurrent,
      ownership: { scope: "shared", ownerUserId, sessionInstanceId },
    })
  ).then((result) => (result === SHARED_NOTIFICATION_BARRIER_BLOCKED ? result : undefined));
}

/**
 * ローカル予定＋共有予定を合成して通知を再構築する。ownerUserId/sessionInstanceIdが
 * 呼び出し時点と一致する場合のみ実行され、`remoteEvents`に含まれる予定だけを
 * scope: "shared"として登録する（それ以外はscope: "local"）。
 *
 * REVISE対応（第8ラウンド、P1-4）: 以前はセキュリティバリアでblock中でも、remoteEvents
 * （共有予定分）だけを候補から除外してlocalEvents単独でreconcileNotificationsLowLevelを
 * 呼んでいた。しかしreconcileNotificationsInternalの孤立通知掃除は、対応表・OS予約一覧を
 * scopeを問わず全体スキャンし、「今回の候補（この場合localのみ）に無い対応表エントリ・
 * OS予約」を無条件に取消対象とする。block中に共有予定を候補から除外したまま実行すると、
 * block対象の所有者だけでなく、それとは無関係な（既に確定している）共有通知まで
 * 「候補外」として誤って取消してしまう恐れがあった。block中はreconcile自体を実行せず
 * （どちらのscopeのOS状態にも一切触れない）、明示的にSHARED_NOTIFICATION_BARRIER_BLOCKED
 * を返す。block解除後は、barrier解除の購読（subscribeToSharedNotificationBarrierRelease）
 * 経由でAppDataContext側のreconcileRequestCounterが進み、この単一effectが現在の
 * committed local/remoteEventsで自動的に再実行される（AppState「active」復帰を待たない）。
 */
export function reconcileSharedNotifications(
  localEvents: AppEvent[],
  remoteEvents: AppEvent[],
  ownerUserId: string,
  sessionInstanceId: string
): Promise<SharedNotificationBarrierBlocked | undefined> {
  if (!isSharedNotificationIdentityReady(ownerUserId, sessionInstanceId)) {
    return Promise.resolve(SHARED_NOTIFICATION_BARRIER_BLOCKED);
  }
  const entries: NotificationEventEntry[] = [
    ...localEvents.map((event) => ({ event, ownership: { scope: "local" as const } })),
    ...remoteEvents.map((event) => ({
      event,
      ownership: { scope: "shared" as const, ownerUserId, sessionInstanceId },
    })),
  ];
  return enqueue(ownerUserId, sessionInstanceId, async (isCurrent) => {
    await reconcileNotificationsLowLevel(entries, { isCurrent });
    return undefined;
  }).then((result) => (result === SHARED_NOTIFICATION_BARRIER_BLOCKED ? result : undefined));
}

/**
 * 所有者切替時に、直前の所有者に属する共有通知（予約済み・対応表登録済み、および
 * 通知センターに表示済みのもの）を一括取消する。特定の（既に過去のものとして確定した）
 * 所有者を明示的に指定して行う操作のため、現在の所有者と比較するisCurrentチェックは
 * 不要（このcoordinatorの他の操作とは異なり、「自分が最新か」を問う操作ではなく、
 * 「指定した過去の所有者の残骸を消す」操作のため）。単一チェーンには合流させ、
 * 他の共有通知operationと同じ順序で直列実行されるようにする。
 *
 * 戻り値はPromise<boolean>（全ステップが成功したか）。呼び出し元がこの値を見なくても、
 * notificationService側が失敗時に自動的にpendingOwnerNotificationCleanup一覧へ記録し、
 * 後で再試行する（retryPendingOwnerNotificationCleanups参照）ため、fire-and-forgetで
 * 呼んでも安全側に倒れる。
 */
export function cancelAllSharedNotificationsForOwner(ownerUserId: string): Promise<boolean> {
  const run = chain.then(() => cancelAllSharedNotificationsForOwnerLowLevel(ownerUserId));
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * 過去に完了できなかった所有者単位クリーンアップをまとめて再試行する。アプリ初期化時・
 * AppState「active」復帰時・次の所有者切替確定直後の3箇所から呼ぶ想定。他の共有通知
 * operationと同じ単一チェーンへ合流させる。
 */
/**
 * [P0124 QA-F073 / DATA-F073-004] 通知対応表が破損確定している場合のみ、OS状態から
 * 再構築する。他の共有通知operationと同じ単一チェーンへ合流させる（再構築自体は
 * notificationRepository側のregistry mutation chain内で原子的に行われるため、
 * 通常のadd/remove/updateとのlost updateは起きない）。
 * アプリ初期化時・AppState「active」復帰時・identity変更確定直後の3箇所から呼ぶ。
 */
export function repairCorruptNotificationRegistryIfNeeded(): Promise<NotificationRegistryRepairResult> {
  const run = chain.then(() => repairCorruptNotificationRegistryIfNeededLowLevel());
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function retryPendingOwnerNotificationCleanups(): Promise<void> {
  const run = chain.then(() => retryPendingOwnerNotificationCleanupsLowLevel());
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** cleanupが成功したターゲットについて、待機集合・blocked中のidentityの両方から除去する。 */
function resolveOwnerCleanup(target: PendingCleanupTarget): void {
  const key = pendingTargetKey(target);
  ownersAwaitingCleanup.delete(key);
  for (const [identKey, set] of blockedIdentities.entries()) {
    set.delete(key);
    if (set.size === 0) blockedIdentities.delete(identKey);
  }
  notifyBarrierRelease();
}

/**
 * REVISE対応（第8ラウンド、P1-4）: あるidentityへのblockが（部分的にでも）解除された
 * ことをAppDataContext側へ知らせるための購読機構。AppDataContext側はこれを購読し、
 * 既存のreconcileRequestCounter（AppState「active」復帰と同じ仕組み）を進めるだけに
 * とどめる——実際に何をreconcileすべきかの判断は既存の単一effect（committed stateのみを
 * 見る）に委ねる。これにより、barrier解除だけで（AppState「active」復帰を待たずに）
 * 通知の再構築が発火する。
 */
const barrierReleaseListeners = new Set<() => void>();

export function subscribeToSharedNotificationBarrierRelease(listener: () => void): () => void {
  barrierReleaseListeners.add(listener);
  return () => barrierReleaseListeners.delete(listener);
}

function notifyBarrierRelease(): void {
  for (const listener of barrierReleaseListeners) {
    try {
      listener();
    } catch (e) {
      if (__DEV__) {
        console.warn("[sharedNotificationCoordinator] barrier解除リスナーで例外が発生しました", e);
      }
    }
  }
}

/**
 * 過去に成功できなかった所有者単位cleanupを、ownersAwaitingCleanupに残っている分すべて
 * 再試行する。呼び出しのたびにensureSharedNotificationBarrierHydratedも合わせて確認する
 * （hydrate自体が過去に失敗していた場合、ここで再試行の機会を与える）。
 */
export function retrySharedNotificationSecurityBarrier(): Promise<void> {
  const run = chain.then(async () => {
    await ensureSharedNotificationBarrierHydrated();
    if (!barrierHydrated) return;
    const waitingTargets = Array.from(ownersAwaitingCleanup.values());
    for (const target of waitingTargets) {
      const ok =
        target.kind === "identity"
          ? await cancelAllSharedNotificationsForOwnerLowLevel(target.ownerUserId, target.sessionInstanceId)
          : await cancelAllSharedNotificationsForOwnerLowLevel(target.ownerUserId);
      if (ok) resolveOwnerCleanup(target);
    }
  });
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * REVISE対応（第8ラウンド、P1-1）: authSessionIdentityStoreの変化と完全に同じ同期経路で
 * blockedIdentitiesを更新する。setCurrentAuthIdentity内のリスナー呼び出しは同期的
 * （Reactのコミット・Effectより必ず先に実行される）なため、この関数が完了した時点で、
 * 新しいidentityは（前所有者が存在する遷移であれば）既にblocked状態になっている。
 * 例外は外へ投げない（呼び出し元のsetCurrentAuthIdentity・ひいてはAuthContextの
 * React state公開処理を妨げないため）。
 */
function handleIdentityTransition(prev: AuthIdentity, next: AuthIdentity): void {
  const sameIdentity =
    prev.userId === next.userId && prev.sessionInstanceId === next.sessionInstanceId;
  if (sameIdentity) return;

  // REVISE対応（第9ラウンド、P1-1）: 離脱するidentityを、ownerUserIdだけでなく
  // sessionInstanceIdも含めた「セッション単位」のターゲットとして追跡する。以前は
  // ownerUserIdのみを追跡していたため、同一ユーザーが別セッションで再ログインした場合
  // （A/session1→A/session2）、cleanupの対象がA全体（両方のセッション）になっており、
  // 逆にA/session1の残骸が「ownerUserIdが同じA」という理由だけで誤って
  // 自分自身の正常な通知として見逃されうる経路があった。session1のみを対象にすることで、
  // A/session2の正当な通知には一切触れずにA/session1の残骸だけを片付ける。
  if (prev.userId && prev.sessionInstanceId) {
    const target: PendingCleanupTarget = {
      kind: "identity",
      ownerUserId: prev.userId,
      sessionInstanceId: prev.sessionInstanceId,
    };
    registerPendingTarget(target);
    const run = chain.then(() =>
      cancelAllSharedNotificationsForOwnerLowLevel(target.ownerUserId, target.sessionInstanceId)
    );
    chain = run.then(
      (ok) => {
        if (ok) resolveOwnerCleanup(target);
        return undefined;
      },
      () => undefined
    );
  }
  // REVISE対応（第8ラウンド、P1-2/P1-3）: このnext identityへ、直前のターゲットだけでなく
  // 「この時点でownersAwaitingCleanupに残っている未解決のターゲットすべて」をblockerとして
  // 登録する（直前のターゲット自身が上でこの集合へ追加済みのため、これも含まれる）。
  // これにより、無関係な別所有者・別セッションの残留cleanupが未解決のまま新しいidentityが
  // 割り込んできた場合も、その新しいidentityは（自分に無関係な残留であっても）安全側に
  // 倒して解決を待つ。barrierHydrated未完了の間（hydrate自体がまだ終わっていない）に
  // この関数が呼ばれても、ownersAwaitingCleanupの内容自体はhydrateの成否と独立に
  // 安全に参照できる。
  registerCurrentIdentityAsBlockedByPending();
}

let lastKnownIdentity: AuthIdentity = getCurrentAuthIdentity();

/**
 * authSessionIdentityStoreへの購読を（再）確立する。通常はモジュール読込み時に1回だけ
 * 呼べば十分だが、`__resetAuthIdentityStoreForTests()`（authSessionIdentityStore.ts側の
 * テスト専用関数）はリスナー集合ごとクリアするため、テスト環境でそれが呼ばれると
 * モジュール読込み時に張ったこの購読も失われてしまう。`__resetSharedNotificationCoordinatorForTests`
 * からも呼び直すことで、テストの`beforeEach`が
 * `__resetAuthIdentityStoreForTests()` → `__resetSharedNotificationCoordinatorForTests()`の順で
 * 実行される規約（本番の初期化順序とは無関係な、テスト分離のためだけの規約）のもとで、
 * 購読が常に有効な状態を維持する。
 */
function attachAuthIdentitySubscription(): void {
  subscribeToAuthIdentity((next) => {
    const prev = lastKnownIdentity;
    lastKnownIdentity = next;
    try {
      handleIdentityTransition(prev, next);
    } catch (e) {
      if (__DEV__) {
        console.warn("[sharedNotificationCoordinator] identity変化処理で例外が発生しました", e);
      }
    }
  });
}

attachAuthIdentitySubscription();

// モジュール読込み時点で、永続pending一覧・OSメタデータからのhydrateと、その時点で
// 既に記録されている所有者の再試行を1回試みる（AppDataContextの初期化を待たない）。
void retrySharedNotificationSecurityBarrier();

/**
 * テスト専用: モジュールスコープの状態をリセットする。本番コードから呼ばない。
 * jestは1テストファイルにつき1回しかこのモジュールを読み込まないため、
 * barrierHydrated・blockedIdentities等の状態を各テストの前に明示的にリセットできるようにする。
 * `__resetAuthIdentityStoreForTests()`の後に呼ぶことを前提に、authSessionIdentityStoreへの
 * 購読も併せて張り直す（前述のattachAuthIdentitySubscription参照）。
 */
export function __resetSharedNotificationCoordinatorForTests(): void {
  blockedIdentities.clear();
  ownersAwaitingCleanup.clear();
  barrierHydrated = false;
  hydratePromise = null;
  chain = Promise.resolve();
  barrierReleaseListeners.clear();
  lastKnownIdentity = getCurrentAuthIdentity();
  attachAuthIdentitySubscription();
}
