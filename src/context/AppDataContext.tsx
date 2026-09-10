import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Alert, AppState } from "react-native";
import {
  AppEvent,
  FocusSessionRecord,
  NormalEvent,
  OverlaySettings,
  ShareTarget,
  UserCalendar,
  isNormalEvent,
} from "@/types/event";
import { JoinedCalendarSummary, PendingInvite, SyncStatus } from "@/types/sharing";
import { getAllEvents } from "@/storage/eventsRepository";
import {
  appendFocusHistory as appendFocusHistoryToStorage,
  deleteFocusHistoryRecord as deleteFocusHistoryRecordFromStorage,
  getFocusHistory,
} from "@/storage/focusSessionRepository";
import {
  getShareTargets,
  getUserCalendarsStrict,
  saveFavoriteCalendarIdsStrict,
  saveLastUsedCalendarIdStrict,
  saveOverlaySettings,
  saveUserCalendars,
} from "@/storage/settingsRepository";
import {
  OwnerBoundPreferenceField,
  buildOwnerBoundMutationId,
  clearPendingOwnerBoundEnvelopeStrict,
  determineFreshOutcome,
  readAndCommitOwnerBoundPreferencesSafely,
  resolveExistingPendingJournal,
  writePendingOwnerBoundEnvelopeStrict,
} from "@/storage/ownerBoundPreferenceRepository";
import { enqueueOwnerBoundPreferenceOperation } from "@/storage/ownerBoundPreferenceCoordinator";
import { enqueueLocalCalendarLifecycleOperation } from "@/context/localCalendarLifecycleCoordinator";
import { applySeedDataIfNeeded } from "@/seed/seedData";
import { withBaseCalendarEnsured } from "@/utils/baseCalendar";
import { classifyCalendarOwnership } from "@/utils/calendarOwnership";
import { BASE_CALENDAR_ID } from "@/constants/options";
import { toggleCalendarVisibility, dedupePreserveOrder, ToggleVisibilityResult } from "@/utils/calendarVisibility";
import { EventDisplayMode, applyEventDisplayMode } from "@/utils/eventDisplayMode";
import { resolveEndDate } from "@/utils/time";
import { runPostPrimaryStep } from "@/utils/postPrimary";
import { deleteLocalCalendarCoverImage } from "@/services/localImageStorage";
import { cleanupOrphanedAttachmentDrafts } from "@/services/attachmentDraftStorage";
import { retryPendingAttachmentCleanups } from "@/services/cloudAttachmentRepository";
import { retryPendingAttachmentMigrations } from "@/services/attachmentMigrationService";
import { useAuth } from "@/context/AuthContext";
import { getCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";
import {
  SharedMutationIdentity,
  STALE_SHARED_MUTATION_IDENTITY_MESSAGE,
  isCurrentSharedMutationIdentity,
  assertCurrentSharedMutationIdentity,
  runCurrentSharedMutation,
} from "@/auth/sharedMutationIdentity";
import {
  SharedMutationAuthSnapshot,
  captureSharedMutationAuthSnapshot,
} from "@/auth/sharedMutationAuthSnapshot";
import { canCreateMyCalendar } from "@/constants/calendarLimits";
import { usePremiumStatus } from "@/hooks/usePremiumStatus";
import {
  AcceptInviteResult,
  acceptPendingInviteById,
  createSharedCalendar as createSharedCalendarRequest,
  declinePendingInvite as declinePendingInviteRequest,
  deleteCalendar as deleteCalendarRequest,
  fetchJoinedCalendars,
  fetchPendingInvitesForCurrentUser,
  updateCalendar as updateCalendarRequest,
} from "@/services/calendarService";
import {
  SHARED_EVENT_DELETE_BLOCKED_MESSAGE,
  fetchEventsForCalendars,
  fetchSharedEventById,
  updateSharedNormalEventWithVersionCheck,
} from "@/services/sharedEventsService";
import * as eventService from "@/services/eventService";
import { useSharedCalendarSync } from "@/hooks/useSharedCalendarSync";
import { useSyncQueueProcessor } from "@/hooks/useSyncQueueProcessor";
import { RecurringEditScope, selectRecurringTargets } from "@/utils/recurringEvents";
import {
  cancelNotification,
  cancelNotifications,
  NotificationEventEntry,
  NotificationScheduleOutcome,
  reconcileNotifications,
} from "@/services/notificationService";
import {
  SHARED_NOTIFICATION_BARRIER_BLOCKED,
  SharedNotificationBarrierBlocked,
  cancelSharedEventNotification,
  cancelSharedEventNotifications,
  reconcileSharedNotifications,
  repairCorruptNotificationRegistryIfNeeded,
  retryPendingOwnerNotificationCleanups,
  retrySharedNotificationSecurityBarrier,
  scheduleSharedEventNotification,
  scheduleSharedEventNotifications,
  subscribeToSharedNotificationBarrierRelease,
} from "@/services/sharedNotificationCoordinator";
import { translate } from "@/i18n/translations";
import { localeService } from "@/services/deviceLocaleService";
import { useLocale } from "@/context/LocaleContext";

/**
 * [P0082 ROBUST-F015-001] removeEventの共有削除経路が「確実な削除」でも「確実な
 * オフライン同期キュー投入」でもない結果（identity切替による保存見送り・補償削除
 * 失敗による後始末保留・想定していない例外——AsyncStorage書込み失敗等）に到達した
 * 場合に投げる、判別可能なメッセージ。durable delete authorityが一切確認できて
 * いないため、"削除されなかった"（definite-failure/SHARED_EVENT_DELETE_BLOCKED_MESSAGE
 * と混同すべきではない）ではなく"結果を確認できなかった"ことを表す（正本§2
 * 「result could not be confirmed」）。friendlyError.tsの"shared_event_delete_result_
 * unconfirmed"部分一致で検出され、専用の案内文へ変換される。
 */
const SHARED_EVENT_DELETE_UNCONFIRMED_MESSAGE = "shared_event_delete_result_unconfirmed";

/**
 * 通知権限が拒否/未許可だった場合のみユーザーへ知らせる。
 * 予定作成・編集・一括作成・集中タスクのすべての保存経路がこの1関数を共通で使うことで、
 * 同じ確認・表示ロジックを重複実装しないようにする。予定自体の保存は常にこの前に完了しているため、
 * ここで何もしなくても保存結果には影響しない。
 */
async function notifyIfNotificationPermissionDenied(
  outcome: NotificationScheduleOutcome | SharedNotificationBarrierBlocked | undefined
): Promise<void> {
  if (outcome !== "permission-denied") return;
  const locale = await localeService.getInitialLocale();
  Alert.alert(
    translate(locale, "appDataContext.notificationFailedTitle"),
    translate(locale, "appDataContext.notificationFailedMessage")
  );
}

/**
 * [P0078 DATA-F014-001] 同一カレンダー内の共有通常予定編集専用CAS保存の結果。
 * "retryable"（送信中にネットワーク断が起き、再照会の結果DBのupdated_atが
 * expectedUpdatedAtのまま変化していない＝このattempt自体はまだ一度もcommitしていないと
 * 確認できた場合）は、同じexpectedUpdatedAtのまま安全に再送してよい。"unknown"は
 * 再照会自体も失敗した、または再照会結果が判定不能だった場合で、成功を主張しない
 * （呼び出し元は自動再送せず、ユーザーの明示的な再操作に委ねる）。
 */
export type NormalEventCasOutcome =
  | "committed"
  | "conflict"
  | "not_found"
  | "not_authorized"
  | "retryable"
  | "unknown";

/**
 * [P0078 DATA-F014-001] CAS呼び出し自体が例外（ネットワーク断等）で失敗した場合の
 * unknown-outcome解消。events.updated_atはサーバー側トリガー（now()）が生成するため
 * クライアントは「自分が書き込むはずだった正確な値」を事前に知り得ない——代わりに
 * 「現在の行の内容がこのattemptで送った内容と完全一致するか」で自分自身のcommitを
 * 判定する（P0043の「zero-plan event snapshot + exact target patch matcher」と同じ
 * 「送信した値との完全一致で自分のattemptを認識する」設計方針を踏襲）。
 */
async function reconcileNormalEventCasAfterTransportLoss(
  event: NormalEvent,
  expectedUpdatedAt: string,
  auth: SharedMutationAuthSnapshot
): Promise<{ resolved: "committed"; updatedAt: string } | { resolved: "conflict" | "retryable" | "unknown" }> {
  let current: AppEvent | null;
  try {
    current = await fetchSharedEventById(event.id, auth);
  } catch {
    return { resolved: "unknown" };
  }
  if (!current || !isNormalEvent(current)) return { resolved: "unknown" };
  if (current.updatedAt === expectedUpdatedAt) return { resolved: "retryable" };
  const fieldsMatch =
    current.title === event.title &&
    current.date === event.date &&
    current.startTime === event.startTime &&
    current.endTime === event.endTime &&
    (current.endDate ?? current.date) === (event.endDate ?? event.date) &&
    current.allDay === event.allDay &&
    (current.location ?? "") === (event.location ?? "") &&
    (current.memo ?? "") === (event.memo ?? "") &&
    current.completed === event.completed &&
    current.notification.enabled === event.notification.enabled &&
    current.notification.minutesBefore === event.notification.minutesBefore &&
    current.repeat.type === event.repeat.type;
  return fieldsMatch ? { resolved: "committed", updatedAt: current.updatedAt } : { resolved: "conflict" };
}

/** 一括保存の結果。呼び出し元（BulkEventForm等）が成功/失敗件数を確認できるようにする */
export interface BulkSaveResult {
  successCount: number;
  failureCount: number;
  failureReason?: string;
  /**
   * REVISE対応（第6ラウンド、P1-1）: failureCountの内訳。オフライン同期キューへ実際に
   * 積まれた（later resync予定の）件数。共有カレンダー向けの一括保存/一括削除でのみ設定され、
   * ローカル予定の一括保存では常にundefined（failureCountが常に0のため）。
   */
  enqueuedCount?: number;
  /**
   * REVISE対応（第6ラウンド、P1-1）: failureCountの内訳。identity変化（操作開始後の
   * ユーザー/セッション切替）により、Storageへの保存自体を行わず破棄された件数。
   * この値が1件でもあれば、対象の予定は「後で同期される」わけではなく実際に失われている
   * ため、呼び出し元は"オフラインなので後で再送されます"のような案内を出してはならない。
   */
  discardedStaleCount?: number;
}

/** 繰り返し予定の編集・削除範囲（"single"|"following"|"all"）。判定ロジックはutils/recurringEvents.tsに集約 */
export type { RecurringEditScope };

/**
 * 単独修正(2026-08、ROBUST-F001-002): 必須ローカルデータ（シード適用・予定・カレンダー等・
 * 集中履歴）の初期化状態。"loading"=まだ完了していない（成功も失敗もしていない）、
 * "ready"=成功し、通常の画面を描画してよい、"error"=失敗し、通常の画面を描画してはいけない
 * （空データを正式データとして表示・保存する事故を防ぐため）。
 */
export type AppDataInitializationStatus = "loading" | "ready" | "error";

interface AppDataContextValue {
  /**
   * 後方互換のため維持する。`initializationStatus !== "ready"`のときtrue
   * （"error"のときもtrueのままにする。falseにしてしまうと、既存の
   * `if (loading) return <LoadingView />; ...通常描画...`という他画面の判定が
   * 「初期化失敗＝完了」と誤認し、空データを通常の予定一覧として描画してしまうため）。
   */
  loading: boolean;
  /** 必須ローカルデータの初期化状態。全ルート共通の初期化ゲート（AppDataInitializationGate）が使う。 */
  initializationStatus: AppDataInitializationStatus;
  /**
   * 初期化失敗後の安全な再試行。既に初期化処理が進行中（初回マウント時・別の再試行呼び出し中）
   * の場合は何もしない（二重実行防止）。既存のAsyncStorageを削除したり、成功していない状態を
   * 上書きしたりはしない。
   */
  retryInitialization: () => Promise<void>;
  events: AppEvent[];
  overlaySettings: OverlaySettings;
  shareTargets: ShareTarget[];
  userCalendars: UserCalendar[];
  /** ログイン中に参加している共有カレンダー（自分の権限つき） */
  sharedCalendars: JoinedCalendarSummary[];
  /** 共有予定1件ごとの送信状態。ローカル予定にはキーが存在しない */
  syncStatusByEventId: Record<string, SyncStatus>;
  loadingShared: boolean;
  /** ログイン中ユーザー宛てに届いている未処理招待。招待タブの一覧・バッジ件数はこの配列が正本 */
  pendingInvites: PendingInvite[];
  loadingPendingInvites: boolean;
  /** 直近のrefreshPendingInvitesが失敗した理由。成功すればnullに戻る。失敗時もpendingInvitesは書き換えない */
  pendingInvitesError: string | null;
  refresh: () => Promise<void>;
  refreshShared: () => Promise<void>;
  refreshPendingInvites: () => Promise<void>;
  /**
   * 招待一覧のカードから参加する。成功したらpendingInvitesから即座に除去し、参加中一覧・
   * 表示設定へ反映する。戻り値の参加先カレンダー名は、呼び出し側の成功メッセージ表示に使う。
   */
  acceptPendingInvite: (inviteId: string) => Promise<AcceptInviteResult>;
  /** 招待一覧のカードから拒否する。成功したらpendingInvitesから即座に除去する（共有カレンダーへは参加しない） */
  declinePendingInvite: (inviteId: string) => Promise<void>;
  saveEvent: (event: AppEvent) => Promise<void>;
  /**
   * 実際にcommitされた後、その結果（新しいcalendarId・新しいupdated_at・送信済みpatch）を
   * ローカルのshared event stateへ反映するための公開API。内部的にはRealtime受信と同じ
   * `REALTIME_EVENT_UPSERT`経路（handleRemoteEventChange）を再利用するが、意味上は別物
   * ——こちらは「自分がまさに今commitしたことを確認済みの結果」を反映するためのもので、
   * 楽観的更新（saveEvent内部の事前反映）でもRealtime購読でもない。呼び出し元
   * （app/event/[id].tsx等）は、反映前に必ず現在identityを再確認してから呼ぶこと。
   */
  reflectCommittedSharedEventChange: (event: AppEvent, ownerUserId: string, sessionInstanceId: string) => void;
  /**
   * [P0078 DATA-F014-001] 共有カレンダー内の通常予定「同一カレンダー内編集」専用のCAS保存。
   * expectedUpdatedAt（編集セッション開始時点のsourceSnapshot.expectedUpdatedAt）と
   * サーバー側の現在のupdated_atが一致する場合にのみ実際に保存する。upsertSharedEventを
   * 経由するsaveEventとは独立した専用経路——conflict/not_found/not_authorizedのいずれも
   * 通常のsaveEvent失敗（オフライン同期キューへの積み込み）へは一切フォールバックしない
   * （正本§2「A version conflict... is not enqueued as a generic offline upsert」）。
   * カレンダー移動を伴う保存には使わない（既存のC14経路のみが対象）。
   */
  saveSharedNormalEventWithVersionCheck: (
    event: NormalEvent,
    expectedUpdatedAt: string,
    identity: SharedMutationIdentity
  ) => Promise<NormalEventCasOutcome>;
  /**
   * 一括作成（期間・曜日指定）で生成した複数の予定をまとめて保存する。
   * 対象カレンダーが端末内か共有かをsaveEventと同じ判定ロジックで自動的に振り分ける
   * （呼び出し側は端末内/共有の違いを意識しなくてよい）。
   */
  saveEventsBulk: (events: AppEvent[]) => Promise<BulkSaveResult>;
  /**
   * 繰り返し予定（recurringGroupIdを持つ予定）の編集。updatedBaseEventは編集対象そのものに
   * 反映したい変更を含む完全なイベントで、scopeが"single"（またはrecurringGroupId未設定）
   * ならsaveEventをそのまま呼ぶだけ。"following"/"all"では、対象となる兄弟予定へ
   * タイトル・説明・開始/終了時刻・通知設定のみを伝播する（日付・calendarId等は各予定のまま）。
   */
  updateRecurringEvents: (
    updatedBaseEvent: AppEvent,
    scope: RecurringEditScope
  ) => Promise<BulkSaveResult>;
  /** 繰り返し予定の削除。scopeの意味はupdateRecurringEventsと同じ */
  removeRecurringEvents: (
    baseEvent: AppEvent,
    scope: RecurringEditScope
  ) => Promise<BulkSaveResult>;
  removeEvent: (id: string, calendarId: string) => Promise<void>;
  /** [P0096 CORRECT-F019-002] 「通常の予定」表示フラグを、直列化された最新値からトグルする。 */
  toggleShowNormalEventsIntent: () => Promise<void>;
  /** [P0096 CORRECT-F019-002] 「集中タスク」表示フラグを、直列化された最新値からトグルする。 */
  toggleShowTasksIntent: () => Promise<void>;
  /** [P0096 CORRECT-F019-002] 表示する予定の種類（3択＋すべて非表示）を、直列化された最新値から設定する。 */
  setEventDisplayModeIntent: (mode: EventDisplayMode) => Promise<void>;
  /**
   * [P0096 CORRECT-F019-002] 「このカレンダーだけ表示」。直列化された最新値のうち
   * showNormalEvents/showTasksは維持したまま、visibleCalendarIdsだけを`[calendarId]`へ
   * 置き換える（既存の意味そのまま）。
   */
  showOnlyCalendarIntent: (calendarId: string) => Promise<void>;
  addUserCalendar: (calendar: UserCalendar) => Promise<void>;
  /** 端末内カレンダーの名前・色を変更する */
  updateUserCalendar: (calendar: UserCalendar) => Promise<void>;
  /** 端末内カレンダーを削除する（紐づく既存予定はそのまま残る） */
  removeUserCalendar: (id: string) => Promise<void>;
  createSharedCalendar: (name: string, color: string) => Promise<void>;
  /** 共有カレンダーの名前・色を変更する（ownerのみ、RLSで保護済み） */
  updateSharedCalendar: (
    calendarId: string,
    updates: { name?: string; color?: string }
  ) => Promise<void>;
  /** 共有カレンダーを削除する（ownerのみ、RLSで保護済み） */
  deleteSharedCalendar: (calendarId: string) => Promise<void>;
  /**
   * 招待参加などで新しく見えるようになったカレンダーを「表示するカレンダー」に加える。
   * ownerIdentityOverrideは、共有化・参加が完了した直後の「そのカレンダー自身」に対して
   * 呼ぶ場合に、呼び出し元が既に検証済みの自分のidentityを明示的に渡すためのオプション引数
   * （省略時は内部のisShared自動判定に委ねる。詳細は実装側のdoc参照）。
   */
  markCalendarVisible: (
    calendarId: string,
    ownerIdentityOverride?: SharedMutationIdentity | null
  ) => Promise<void>;
  /**
   * [P0094 CORRECT-F019-001] 手動UIトグル専用のintentベースの表示切替。呼び出し元は
   * calendarIdだけを渡す（絶対値を事前計算しない）。戻り値のstatusが"limitReached"の
   * 場合、呼び出し元は既存の上限到達アラート文言をそのまま表示する（新しい文言は追加しない）。
   */
  toggleCalendarVisibilityIntent: (calendarId: string) => Promise<ToggleVisibilityResult>;
  /** お気に入りカレンダーのID（端末内のみのローカル設定。DBには保存しない） */
  favoriteCalendarIds: string[];
  toggleFavoriteCalendar: (calendarId: string) => Promise<void>;
  /** 予定作成画面で最後に選択したカレンダーID（端末内のみのローカル設定。次回の初期値に使う） */
  lastUsedCalendarId: string | null;
  recordLastUsedCalendar: (calendarId: string) => Promise<void>;
  /**
   * Stage I-4: 集中モードの完了・中断履歴。focusSessionRepositoryの薄いラッパーとして
   * Contextへ公開する（Repository自体は置き換えない。書込みは必ずこの3関数を経由する）。
   */
  focusHistory: FocusSessionRecord[];
  refreshFocusHistory: () => Promise<void>;
  appendFocusHistory: (record: FocusSessionRecord) => Promise<void>;
  deleteFocusHistoryRecord: (id: string) => Promise<void>;
}

const DEFAULT_OVERLAY: OverlaySettings = {
  showNormalEvents: true,
  showTasks: true,
  visibleCalendarIds: ["main"],
};

/** sharedData.ownerUserIdの初期値。null（「未ログインとして確定済み」）と区別するための番人値。 */
const NOT_YET_DETERMINED = Symbol("not-yet-determined");
type OwnerUserId = string | null | typeof NOT_YET_DETERMINED;

/**
 * SEC-F007-001 最終設計: 共有カレンダー・共有予定・招待に関わる全stateを1つのreducerへ
 * 統合する。所有者（ownerUserId・sessionInstanceId）と要求トークンを同じstateの内側に
 * 持たせることで、非同期処理の完了時に「今も自分が最新の要求か」をReact自身の
 * 更新キューが保証する値（このreducerに渡される`state`引数）だけで判定できる
 * ——refのタイミングや、Effectがいつ実行されるかには一切依存しない。
 *
 * sessionInstanceIdは、user.idが同じままでも認証セッション自体が置き換わった場合
 * （同一アカウントへの再ログイン等）を区別するために持つ（AuthContext.sessionInstanceId、
 * Supabase JWTのsession_id claim由来）。
 */
/**
 * REVISE対応（P2-2、再監査）: 「共有側の取得が確定したか」を表す状態機械。
 * 以前は`sharedSettledRef`という単一のbooleanで表現しており、reducerがactionを
 * 実際に受理したかどうかを確認せずに複数箇所から`true`をセットしていたため、
 * 「stale（追い越された）要求の完了後にも確定扱いになる」「所有者切替直後、実際の取得が
 * 完了する前に確定扱いになる」という2つの問題があった。この状態は必ずreducer経由で
 * （実際にownerMatches・token一致で受理されたactionによってのみ）遷移する。
 * - idle: 所有者が確定して以降、まだ取得を開始していない（OWNER_CHANGED直後）。
 * - loading: SHARED_REQUEST_STARTEDが受理された（取得中）。
 * - succeeded / failed: SHARED_REQUEST_SUCCEEDED / SHARED_REQUEST_FAILEDが受理された。
 */
type SharedLoadStatus = "idle" | "loading" | "succeeded" | "failed";

interface SharedDataState {
  ownerUserId: OwnerUserId;
  sessionInstanceId: string | null;
  /** refreshShared呼び出し1回ごとに発行する一意なトークン。逆順完了を拒否するために使う。 */
  sharedRequestToken: number | null;
  /** refreshPendingInvites呼び出し1回ごとに発行する一意なトークン。 */
  invitesRequestToken: number | null;
  sharedCalendars: JoinedCalendarSummary[];
  remoteEvents: AppEvent[];
  pendingInvites: PendingInvite[];
  pendingInvitesError: string | null;
  loadingShared: boolean;
  loadingPendingInvites: boolean;
  sharedLoadStatus: SharedLoadStatus;
}

const INITIAL_SHARED_DATA: SharedDataState = {
  ownerUserId: NOT_YET_DETERMINED,
  sessionInstanceId: null,
  sharedRequestToken: null,
  invitesRequestToken: null,
  sharedCalendars: [],
  remoteEvents: [],
  pendingInvites: [],
  pendingInvitesError: null,
  loadingShared: false,
  loadingPendingInvites: false,
  sharedLoadStatus: "idle",
};

type SharedDataAction =
  | { type: "OWNER_CHANGED"; nextUserId: string | null; nextSessionInstanceId: string | null }
  | { type: "SHARED_REQUEST_STARTED"; ownerUserId: string; sessionInstanceId: string; token: number }
  | {
      type: "SHARED_CALENDARS_RECEIVED";
      ownerUserId: string;
      sessionInstanceId: string;
      token: number;
      calendars: JoinedCalendarSummary[];
    }
  | {
      type: "SHARED_REQUEST_SUCCEEDED";
      ownerUserId: string;
      sessionInstanceId: string;
      token: number;
      events: AppEvent[];
    }
  | { type: "SHARED_REQUEST_FAILED"; ownerUserId: string; sessionInstanceId: string; token: number }
  | { type: "INVITES_REQUEST_STARTED"; ownerUserId: string; sessionInstanceId: string; token: number }
  | {
      type: "INVITES_REQUEST_SUCCEEDED";
      ownerUserId: string;
      sessionInstanceId: string;
      token: number;
      invites: PendingInvite[];
    }
  | {
      type: "INVITES_REQUEST_FAILED";
      ownerUserId: string;
      sessionInstanceId: string;
      token: number;
      message: string;
    }
  | { type: "REALTIME_EVENT_UPSERT"; ownerUserId: string; sessionInstanceId: string; event: AppEvent }
  | { type: "REALTIME_EVENT_DELETE"; ownerUserId: string; sessionInstanceId: string; eventId: string }
  | { type: "INVITE_REMOVED"; ownerUserId: string; sessionInstanceId: string; inviteId: string };

/** actionが今も現在の所有者（ownerUserId・sessionInstanceId）に属するかを判定する。 */
function ownerMatches(state: SharedDataState, ownerUserId: string, sessionInstanceId: string): boolean {
  return state.ownerUserId === ownerUserId && state.sessionInstanceId === sessionInstanceId;
}

/**
 * REVISE対応（P2 端末内表示設定）: 非同期操作（共有カレンダー作成・削除・招待受諾等）の
 * 開始時点で捕捉したownerUserId・sessionInstanceIdが、完了時点でもまだ現在の認証identityと
 * 一致するかを判定する。authSessionIdentityStore（Reactの外側にある、AuthContextが
 * 認証イベントと同じ同期処理内で更新する権威あるソース）と比較するため、Reactの
 * 再レンダー・コミット・Effectの実行タイミングに一切依存しない。一致しない場合、
 * 呼び出し元は端末内表示設定（overlaySettings）への書込みを行わないことで、操作開始後に
 * 別ユーザーへ切り替わった際に、旧所有者のcalendarIdが新しいユーザーのoverlaySettingsへ
 * 紛れ込むのを防ぐ。
 */
function isStillCurrentOwner(ownerUserId: string, sessionInstanceId: string): boolean {
  return isCurrentSharedMutationIdentity({ userId: ownerUserId, sessionInstanceId });
}

/**
 * REVISE対応（追加確認: session_id欠落時のfail-closed）: 認証ユーザーは存在するが
 * sessionInstanceId（Supabase JWTのsession_idクレーム由来）を取得できていない異常な
 * 認証状態のまま、共有カレンダー・共有予定・招待に関わる書込み系の公開メソッドを
 * 開始しないようにする。サーバー側のRLSに最終判定を委ねるだけでなく、各メソッドの
 * 入口で明示的に拒否することで、ローカル予定処理への意図しないフォールバックや、
 * session_id無しでの共有操作の試行を未然に防ぐ。
 */
function assertSessionReady(sessionInstanceId: string | null): asserts sessionInstanceId is string {
  if (sessionInstanceId === null) {
    throw new Error("認証セッション情報を確認できないため、この操作を行えません");
  }
}

/**
 * REVISE対応（第3ラウンド、P1-4）: calendarIdの保存先を3値で判定する。以前は
 * `isSharedCalendarId`（＝`sharedData.sharedCalendars`に含まれるか）の否定を
 * 「ローカル予定である」証拠として扱い、該当しない場合は無条件に`saveLocalEvent`等の
 * ローカル保存処理へフォールバックしていた。しかし`sharedCalendars`に含まれないことは
 * 「ローカルである」ことの証拠にはならない——`refreshShared()`がまだ完了していない・
 * 取得が失敗した・古い画面が既に参加解除/削除された共有カレンダーのIDを保持している等、
 * 正当な共有予定のcalendarIdが一時的または恒久的に`sharedCalendars`から欠落する状況は
 * 複数あり、その場合に共有予定の内容がローカルStorageへ書き込まれてしまう。
 * `userCalendars`（端末内に保存された、確実にローカルと判別できるカレンダー一覧）にも
 * `sharedCalendars`にも見つからない場合は"unknown"を返し、呼び出し元は必ず例外を投げて
 * 処理を中断する（ローカルへのフォールバックは行わない）。
 *
 * REVISE対応（第6ラウンド、追加確認）: 以前は`userCalendars`側の一致を先に確認し、
 * 一致すれば`sharedCalendars`側は確認せずに"local"を確定させていた。同じcalendarIdが
 * 両方の一覧に存在する（データ破損・IDの偶発的衝突等）場合、本来は安全に判定できない
 * 曖昧な状態のはずが、暗黙に"local"側へ倒れてしまっていた。両方を必ず確認し、
 * 両方に一致した場合は他の未確定ケースと同様に"unknown"として処理を中断する
 * （どちらか一方が正しいという前提を勝手に置かない）。
 */
function reduceSharedData(state: SharedDataState, action: SharedDataAction): SharedDataState {
  switch (action.type) {
    case "OWNER_CHANGED": {
      if (
        action.nextUserId === state.ownerUserId &&
        action.nextSessionInstanceId === state.sessionInstanceId
      ) {
        return state;
      }
      // 所有者（ユーザーIDまたは認証セッション）が変わるたびに、公開中の共有stateを
      // 一律に空へ戻す（A→B・A→null・null→A・A→null→Aのいずれも区別しない。
      // 以前はnullへの遷移だけクリア対象から外れていたが、この一律化によりその欠落を解消する）。
      return {
        ...state,
        ownerUserId: action.nextUserId,
        sessionInstanceId: action.nextSessionInstanceId,
        sharedRequestToken: null,
        invitesRequestToken: null,
        sharedCalendars: [],
        remoteEvents: [],
        pendingInvites: [],
        pendingInvitesError: null,
        loadingShared: false,
        loadingPendingInvites: false,
        sharedLoadStatus: "idle",
      };
    }
    case "SHARED_REQUEST_STARTED": {
      if (!ownerMatches(state, action.ownerUserId, action.sessionInstanceId)) return state;
      return {
        ...state,
        sharedRequestToken: action.token,
        loadingShared: true,
        sharedLoadStatus: "loading",
      };
    }
    case "SHARED_CALENDARS_RECEIVED": {
      if (!ownerMatches(state, action.ownerUserId, action.sessionInstanceId)) return state;
      if (action.token !== state.sharedRequestToken) return state;
      return { ...state, sharedCalendars: action.calendars };
    }
    case "SHARED_REQUEST_SUCCEEDED": {
      if (!ownerMatches(state, action.ownerUserId, action.sessionInstanceId)) return state;
      if (action.token !== state.sharedRequestToken) return state;
      return {
        ...state,
        remoteEvents: action.events,
        loadingShared: false,
        sharedLoadStatus: "succeeded",
      };
    }
    case "SHARED_REQUEST_FAILED": {
      if (!ownerMatches(state, action.ownerUserId, action.sessionInstanceId)) return state;
      if (action.token !== state.sharedRequestToken) return state;
      return { ...state, loadingShared: false, sharedLoadStatus: "failed" };
    }
    case "INVITES_REQUEST_STARTED": {
      if (!ownerMatches(state, action.ownerUserId, action.sessionInstanceId)) return state;
      return { ...state, invitesRequestToken: action.token, loadingPendingInvites: true };
    }
    case "INVITES_REQUEST_SUCCEEDED": {
      if (!ownerMatches(state, action.ownerUserId, action.sessionInstanceId)) return state;
      if (action.token !== state.invitesRequestToken) return state;
      return {
        ...state,
        pendingInvites: action.invites,
        pendingInvitesError: null,
        loadingPendingInvites: false,
      };
    }
    case "INVITES_REQUEST_FAILED": {
      if (!ownerMatches(state, action.ownerUserId, action.sessionInstanceId)) return state;
      if (action.token !== state.invitesRequestToken) return state;
      return { ...state, pendingInvitesError: action.message, loadingPendingInvites: false };
    }
    case "REALTIME_EVENT_UPSERT": {
      if (!ownerMatches(state, action.ownerUserId, action.sessionInstanceId)) return state;
      // 自分が今参加していないカレンダーのイベントは反映しない（解除待ちの旧購読からの
      // 通知が紛れ込んでも取り込まないための防御。所有者一致だけでは、A→null→Aのように
      // 同じカレンダーへ再度参加した場合を区別できないため、sessionInstanceIdの一致も併せて見る）。
      if (!state.sharedCalendars.some((s) => s.calendar.id === action.event.calendarId)) return state;
      const idx = state.remoteEvents.findIndex((e) => e.id === action.event.id);
      const remoteEvents =
        idx >= 0
          ? state.remoteEvents.map((e, i) => (i === idx ? action.event : e))
          : [...state.remoteEvents, action.event];
      return { ...state, remoteEvents };
    }
    case "REALTIME_EVENT_DELETE": {
      if (!ownerMatches(state, action.ownerUserId, action.sessionInstanceId)) return state;
      return { ...state, remoteEvents: state.remoteEvents.filter((e) => e.id !== action.eventId) };
    }
    case "INVITE_REMOVED": {
      if (!ownerMatches(state, action.ownerUserId, action.sessionInstanceId)) return state;
      return { ...state, pendingInvites: state.pendingInvites.filter((i) => i.id !== action.inviteId) };
    }
    default:
      return state;
  }
}

/**
 * P0016 Batch1.3、P1(セクション2): visibleCalendarIdsの変更をprevious/nextの
 * 対称差分（追加された分・削除された分の両方）で捉える。P0015まではnext側だけを見ていたため、
 * 「sharedなIDを外す」操作（next側にはそのIDが存在しない）を構造的にlocal-only扱いして
 * しまい、owner-bound保護が適用されない穴があった。
 */
function computeChangedCalendarIds(previous: string[], next: string[]): string[] {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  const changed: string[] = [];
  for (const id of previous) if (!nextSet.has(id)) changed.push(id);
  for (const id of next) if (!previousSet.has(id)) changed.push(id);
  return changed;
}

/**
 * P0015 Batch1.2、P1: shared calendar IDを含みうる端末内設定（overlay/favorite/
 * last-used）の書込みを、identity-safeに直列化して実行する共通実装。
 *
 * P0017 Batch1.4: 直列化の正本をReactの`useRef`（Provider instance-local）から、
 * module-level coordinator（`ownerBoundPreferenceCoordinator.ts`の
 * `enqueueOwnerBoundPreferenceOperation`）へ移した。Providerがremountされても、
 * 複数のProviderインスタンスが同時に存在しても、同じ1本のchainで直列化される
 * （詳細はコーディネータ側のdoc参照）。
 *
 * ownerIdentityがnull（対象calendarIdがローカル専用、または対象が無い）の場合は
 * ローカル専用操作としてidentity非依存のまま従来通りcommitする。ただし
 * P0017セクション4/6: ローカル専用操作もowner-bound操作と同じ直列化queueを共有し、
 * 新規操作を始める前に必ず既存のpending journal（別のidentityによる未解決の
 * owner-bound操作の残骸）を解決してから進む。これにより「別identityの未解決分を
 * 追い越して先に書いてしまう」ことがなくなる。
 *
 * P0016 Batch1.3、P1(セクション3〜5): ownerIdentityが設定されている場合、
 * durableな単一スロットpending envelope（ownerBoundPreferenceRepository.ts）を使う。
 * - persist()開始前にidentityが現在も有効か確認する（無効ならpersist自体を行わない）。
 * - 実際の値の書込み（persist(nextValue)）より前に、必ずpending envelopeを永続化する。
 * - persist()完了後にも再確認する。staleと判明した場合、修復write
 *   （persistRepairStrict）で書込み開始前の値（previousValue）へ書き戻す。
 *   修復write自体が失敗した場合はenvelopeを残したまま（後で再試行できるように）。
 * - P0017セクション5: persist(nextValue)自体がthrowした場合、従来は無条件にenvelopeを
 *   clearしていたが（＝実際に書けたかどうか不明なまま「未適用」と断定していた）、
 *   determineFreshOutcomeでstorageの実値をfresh readし、applied/not-applied/unknownの
 *   いずれかを判定してから、それぞれに応じた安全な処理（下記）を行う。
 * - propagateOwnerBoundFailure: overlay（Category A）はtrue、favorite/last-used
 *   （Category C）はfalse（既存のbest-effort契約を壊さない）。
 *
 * [P0094 CORRECT-F019-001] previousValue/nextValueは呼び出し元が事前計算した固定値
 * ではなく、`deriveNextValue`という引数無しコールバックとして受け取る。preflight
 * （resolveExistingPendingJournal）解決の直後、このオペレーション自身がenqueue
 * （直列化）されたrun()の内部で初めて呼び出される。coordinator（
 * ownerBoundPreferenceCoordinator.ts）はPromiseチェーンで完全直列化されており、
 * 先行するenqueue済みoperationが（成功・失敗を問わず）settleするまで次のoperationの
 * 本体（このrun()自体）は一切開始されない。commit()は該当フィールドの最新値を
 * 保持するref（呼び出し元でoverlaySettingsRef/favoriteCalendarIdsRefとして定義）を
 * 同期的に更新するため、deriveNextValueは「直前までのenqueue済み全operationが
 * 反映し終えた後の最新値」からnextValueを導出できる——呼び出し時点でReact stateの
 * クロージャへ事前計算した絶対値をそのまま積むと、後続のoperationが同じ古い基準値から
 * 独立に計算した結果で先行操作の結果を上書きしてしまう（lost update）。
 * 戻り値が`{ action: "skip" }`の場合、preflight解決後・persist開始前に何もせず
 * 打ち切る（例: 既に望む状態になっている・上限到達で今回のtoggleを適用しない等）。
 *
 * P0018 Batch1.5:
 * - セクション5: pending envelopeの書込み完了後、main field write（persistStrict）を
 *   呼ぶ前にもう一度identityを再確認する。envelope保存中にstaleになった場合は
 *   main field writeを一切開始しない（「一度書いてからrepair」を禁止する）。
 * - セクション6: 「最終的なidentity確認」と「React commit」の間にawaitを置かない
 *   （main write成功の正常系・persist error後にfresh outcomeがappliedだった場合の
 *   両方で統一。pending clearはcommitの後に行い、失敗してもcommit自体は取り消さない
 *   —— 次回のresolveExistingPendingJournalがcurrent ownerのraw値を確認して
 *   idempotentに解決できるため）。
 * - セクション7: `persist`引数は必ずstrict版（書込み失敗時にthrowする版）を渡すこと。
 *   best-effort版（内部でエラーを握りつぶす版）を渡すと、main write失敗時に
 *   catch節（fresh outcome判定）が一切発火せず、実際には書けていないのに
 *   書けたかのように処理が進んでしまう。外部から見たbest-effort契約
 *   （呼び出し元へエラーを伝播させない）は、この関数自身がlocal-only pathも含めて
 *   `propagateOwnerBoundFailure`で一律担保する。
 * - セクション8: preflightが未解決だった場合の扱いを、`ownerIdentity`のnull/non-null
 *   ではなく`propagateOwnerBoundFailure`で決める。overlay（propagate=true）は
 *   local-only操作であっても明示的に失敗させ、favorite/last-used（propagate=false）は
 *   shared/localを問わずbest-effortでno-opする（silent successにはしない——
 *   Storage/stateへは一切書き込まない）。
 */
type OwnerBoundDeriveOutcome<T> =
  | { action: "commit"; previousValue: T; nextValue: T }
  | { action: "skip" };

/**
 * [P0104 CORRECT-F019-007] commitOwnerBoundLocalPreferenceImplの明示的な内部outcome契約。
 * fresh strict readでdurableなoutcomeが確定した以上、APIの結果はそのdurable outcomeと
 * 一致しなければならない（従来はvoid＋例外のみで、「実際には適用済みなのにreject」
 * 「stale中断なのに呼び出し元wrapperがappliedを返す」の両方の矛盾があった）。
 *
 * - "applied": nextValueがdurableに適用され、React commitも完了した（正常系、および
 *   Rule A: main persistがthrowしたがfresh strict readがappliedを証明し、束縛identityが
 *   現在もcurrentである場合——この場合は輸送層のack喪失エラーをrethrowせず成功として
 *   解決する。適用が確定したdurable操作は成功である）。
 * - "stale-aborted-or-repaired": 束縛identityのstale化により操作が意図的に中断された
 *   （pre-envelope gateでの無副作用中断、またはmain persist後のpreviousValueへの修復成功）。
 *   ユーザーの意図は適用されていない。手動系（propagate=true）のwrapperはこれを
 *   公開の"applied"として返してはならず、既存のcatch経路（既存Alert文言）へ変換する。
 * - "skipped": deriveが{action:"skip"}を返した（既に望む状態・上限到達等）、または
 *   best-effort（propagate=false）契約で失敗を吸収して外形上no-opにした場合。
 * - 失敗・unknown・stale修復未解決（Rule F）はPromise rejectionのまま:
 *   - not-applied（Rule B）: 安全にenvelopeをclearした上でreject。
 *   - unknown（Rule C）: envelopeを保持したままreject。決してapplied/成功として報告しない。
 *   - stale＋repair失敗（Rule F）: envelopeをdurable recovery recordとして保持したままreject。
 */
type OwnerBoundCommitOutcome = "applied" | "stale-aborted-or-repaired" | "skipped";

/**
 * [P0104 CORRECT-F019-007] 手動系（propagate=true）wrapperがstale中断outcomeを既存の
 * 失敗経路へ変換するときに投げる内部エラー。新しいUI文言は追加しない——画面側の既存
 * catchハンドラ（既存Alert）がそのまま発火する。
 */
const OWNER_BOUND_STALE_ABORTED_ERROR = "owner_bound_preference_stale_aborted";

function throwIfStaleAborted(outcome: OwnerBoundCommitOutcome): void {
  if (outcome === "stale-aborted-or-repaired") {
    throw new Error(OWNER_BOUND_STALE_ABORTED_ERROR);
  }
}

function commitOwnerBoundLocalPreferenceImpl<T>(
  field: OwnerBoundPreferenceField,
  ownerIdentity: SharedMutationIdentity | null,
  deriveNextValue: () => OwnerBoundDeriveOutcome<T>,
  persistStrict: (value: T) => Promise<void>,
  persistRepairStrict: (value: T) => Promise<void>,
  commit: (value: T) => void,
  propagateOwnerBoundFailure: boolean
): Promise<OwnerBoundCommitOutcome> {
  // [P0102 SEC-F019-F020-006] local-only（ownerIdentity === null）操作を束縛するdevice auth
  // identityは、enqueue（この関数の呼び出し）時点で同期的に捕捉する。P0100はenqueueされた
  // run()の実行開始時に捕捉していたため、coordinatorキューでの待機中にA→Bへ切り替わると、
  // Aとして呼び出されたlocal-only操作が「Bのidentityで開始されたB自身の操作」として
  // 実行されてしまった（queued-before-start欠陥、P0101指摘）。enqueue時点で捕捉することで、
  // キュー内で待機している間に切り替わった操作は実行開始と同時にstale判定され、一切の
  // 副作用（envelope書込み・main persist・React commit）を起こさない。
  // ownerIdentityが非nullの分岐は、ownerIdentity自体が呼び出し元の呼び出し時点で
  // device auth identityから導出済みのため、従来どおりそれをそのまま束縛に使う。
  const invocationAuthIdentity = getCurrentAuthIdentity();
  const run = async (): Promise<OwnerBoundCommitOutcome> => {
    // P0017セクション4/6・P0018セクション8: 新規操作（ローカル専用を含む）の前に、
    // 必ず既存pendingを解決する。未解決のまま残った場合、この新規操作自体は進めない
    // （古いpendingを新しいenvelopeで上書きしない＝unresolved journal overwriteを防ぐ）。
    // 未解決時の扱いはpropagateOwnerBoundFailureのpolicyで決める（ownerIdentityの
    // null/non-nullでは決めない。overlayはlocal-onlyでも明示失敗、favorite/last-usedは
    // shared/localを問わずbest-effort no-op）。
    const preflight = await resolveExistingPendingJournal();
    if (preflight.stillPending) {
      if (propagateOwnerBoundFailure) {
        throw new Error("owner_bound_preference_pending_unresolved");
      }
      // [P0104 CORRECT-F019-007] best-effortの外形上no-op（Storage/stateへは一切触れていない）。
      return "skipped";
    }

    // [P0094 CORRECT-F019-001] 直列化されたこの時点で初めて最新値からnextValueを
    // 導出する（doc冒頭参照）。
    const derived = deriveNextValue();
    if (derived.action === "skip") {
      return "skipped";
    }
    const { previousValue, nextValue } = derived;

    // [P0102 SEC-F019-F020-006] local-only操作もowner-bound操作と同一のdurable pending
    // transactionモデルへ統一する。分岐ごとの違いは「何のidentityへ束縛するか」と
    // 「どのschemaのenvelopeを書くか」の2点だけで、フロー（envelope書込み→再確認→
    // main persist→fresh outcome判定→再確認→React commit→clear）は完全に共通:
    // - owner-bound: SharedMutationIdentity（isCurrentSharedMutationIdentity）＋
    //   owner-bound-pending-v1（従来どおり無変更）
    // - local-only: enqueue時点のdevice auth identity（getCurrentAuthIdentity()との
    //   両フィールド完全一致。ログアウト状態=null/nullも実在のidentityとして束縛される
    //   ——ログアウト中に開始した操作は、途中でログインが発生（null→A）したらstaleとなり、
    //   Aの操作として完了できない。偽のsentinelユーザーIDは一切使わない）＋
    //   device-auth-pending-v1
    // これにより「main persistは成功したがidentityがstale化した」場合、local-onlyでも
    // storageの実値がpreviousValueへ修復され（stale nextValueはOverlaySettings全体を持つため
    // 共有カレンダーIDを含みうる——変更フィールドがshowTasks等でも同じ）、修復自体が
    // 失敗した場合はenvelopeがdurable recovery recordとして残り、次回の
    // resolveExistingPendingJournalが解決する。
    const isIdentityStale = (): boolean => {
      if (ownerIdentity !== null) {
        return !isCurrentSharedMutationIdentity(ownerIdentity);
      }
      const current = getCurrentAuthIdentity();
      return (
        current.userId !== invocationAuthIdentity.userId ||
        current.sessionInstanceId !== invocationAuthIdentity.sessionInstanceId
      );
    };

    // 従来のowner-bound分岐と同じ位置・同じ意味のpre-envelopeゲート（envelope書込み前に
    // 既にstaleなら、durable recordも副作用も一切残さず終了する。queued-before-startで
    // stale化したlocal-only操作もここで止まる）。
    // [P0104 CORRECT-F019-007 Rule D] 副作用ゼロの中断だが、ユーザーの意図は適用されて
    // いないため"stale-aborted-or-repaired"を返す。手動系（propagate=true）のwrapperは
    // これを公開の"applied"へ変換してはならない（throwIfStaleAbortedで既存のcatch経路へ）。
    if (isIdentityStale()) return "stale-aborted-or-repaired";
    const runGuarded = async (): Promise<OwnerBoundCommitOutcome> => {
      if (ownerIdentity !== null) {
        await writePendingOwnerBoundEnvelopeStrict({
          schema: "owner-bound-pending-v1",
          field,
          ownerUserId: ownerIdentity.userId,
          ownerSessionInstanceId: ownerIdentity.sessionInstanceId,
          previousValue,
          nextValue,
          mutationId: buildOwnerBoundMutationId(),
        });
      } else {
        await writePendingOwnerBoundEnvelopeStrict({
          schema: "device-auth-pending-v1",
          field,
          deviceUserId: invocationAuthIdentity.userId,
          deviceSessionInstanceId: invocationAuthIdentity.sessionInstanceId,
          previousValue,
          nextValue,
          mutationId: buildOwnerBoundMutationId(),
        });
      }
      // P0018セクション5: envelope書込み完了後にもう一度identityを再確認する。
      // envelope保存中にstaleになっていた場合、main field write（persistStrict）を
      // 一切開始しない。
      if (isIdentityStale()) {
        try {
          await persistRepairStrict(previousValue);
        } catch {
          // [P0104 CORRECT-F019-007 Rule F] 修復write自体が失敗。envelopeはdurable
          // recovery recordとして残したまま、手動系（propagate=true）には失敗として
          // 報告する（best-effortは外側のcatchが吸収する）。
          throw new Error(OWNER_BOUND_STALE_ABORTED_ERROR);
        }
        // clearはbest-effort（失敗してもrepair済みのため、次回の
        // resolveExistingPendingJournalがraw===previousValueを確認して冪等にclearできる）。
        await clearPendingOwnerBoundEnvelopeStrict().catch(() => {});
        return "stale-aborted-or-repaired";
      }
      try {
        await persistStrict(nextValue);
      } catch (e) {
        // P0017セクション5: fresh readでoutcomeを判定してから安全に処理する
        // （generic deep equalityではなくフィールドごとのvalidated equality。
        // determineFreshOutcomeのdoc参照）。
        const outcome = await determineFreshOutcome(field, previousValue, nextValue);
        if (outcome === "applied") {
          if (!isIdentityStale()) {
            // P0018セクション6: 実際にはnextValueが書けていた。最終確認とcommitの
            // 間にawaitを置かない（storageと矛盾しないようReact stateも揃える）。
            commit(nextValue);
            await clearPendingOwnerBoundEnvelopeStrict().catch(() => {});
            // [P0104 CORRECT-F019-007 Rule A] fresh strict readがappliedを証明し、
            // 束縛identityが現在もcurrentである。durableに適用が確定した操作は成功で
            // ある——輸送層のack喪失エラー（元の例外e）をrethrowしない。従来はここで
            // throw eしていたため、Storage/ReactともにnextValueなのに呼び出し元へ
            // 「失敗」と報告され、手動UIが既存の失敗Alertを表示し、ユーザーの再試行が
            // 設定を逆へ戻す二次被害を生んでいた。
            return "applied";
          }
          try {
            await persistRepairStrict(previousValue);
          } catch {
            // [P0104 Rule F] stale化した上に修復も失敗。envelopeをdurable recovery
            // recordとして残し、元の例外で失敗として報告する。
            throw e;
          }
          await clearPendingOwnerBoundEnvelopeStrict().catch(() => {});
          // [P0104 Rule E] stale化していたが修復は成功。意図は適用されていない。
          return "stale-aborted-or-repaired";
        }
        if (outcome === "not-applied") {
          // [Rule B] 何も反映されていない。previousValueのままなので修復不要、envelopeだけ消す。
          await clearPendingOwnerBoundEnvelopeStrict().catch(() => {});
        }
        // [Rule B/C] not-appliedは安全にclearした上で、unknownはenvelopeをそのまま残して
        // （fail closed。次回のresolveExistingPendingJournalに委ねる）、いずれも失敗として
        // 報告する。unknownを決してapplied/成功として報告しない。
        throw e;
      }
      if (isIdentityStale()) {
        // [P0102 SEC-F019-F020-006] main persistは成功したがidentityがstale化した。
        // React commitを行わないだけでなく、storageの実値をpreviousValueへ修復する。
        // local-onlyでも同じ（修復しないと、stale nextValue——local-only操作でも
        // OverlaySettings全体を持つため共有カレンダーIDを含みうる——が実値として残り、
        // 次のcurrent identityのrefreshがそれを取り込んでしまう。P0100はこのケースで
        // commit skipのみ行い、storageへstale値を残していた）。
        try {
          await persistRepairStrict(previousValue);
        } catch {
          // [P0104 Rule F] 修復write自体が失敗。envelopeはdurable recovery recordとして
          // 残し（resolveExistingPendingJournalが次回解決を再試行する）、手動系には
          // 失敗として報告する。
          throw new Error(OWNER_BOUND_STALE_ABORTED_ERROR);
        }
        await clearPendingOwnerBoundEnvelopeStrict().catch(() => {});
        // [P0104 Rule E] 修復成功。意図は適用されていない（手動系はappliedとして返さない）。
        return "stale-aborted-or-repaired";
      }
      // P0018セクション6: 最終確認とcommitの間にawaitを置かない。
      commit(nextValue);
      await clearPendingOwnerBoundEnvelopeStrict().catch(() => {});
      return "applied";
    };
    if (propagateOwnerBoundFailure) {
      return runGuarded();
    }
    // [P0104 CORRECT-F019-007] best-effort（propagate=false）は既存契約どおり失敗を吸収する。
    // 吸収した失敗は外形上no-op（呼び出し元は主操作の成否を再定義しない）のため"skipped"。
    return runGuarded().catch(() => "skipped" as const);
  };
  return enqueueOwnerBoundPreferenceOperation(run);
}

const AppDataContext = createContext<AppDataContextValue | undefined>(
  undefined
);

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const { t } = useLocale();
  const { user, loading: authLoading, sessionInstanceId: authSessionInstanceId } = useAuth();
  // 単独修正(2026-08, FP-002): マイカレンダーの追加作成上限（自分一人用を除く。
  // [P0094 SPEC-F018-001]でP0092までの単独修正・FP-002の「自分一人用込み」判定を反転済み。
  // 現在の正本はsrc/constants/calendarLimits.tsのtotalMyCalendars/canCreateMyCalendar参照）を
  // 実作成処理（addUserCalendar）でも最終的に強制するために使う。Provider外ではfalseへ
  const [initializationStatus, setInitializationStatus] =
    useState<AppDataInitializationStatus>("loading");
  // 単独修正(2026-08、ROBUST-F001-002): 二重実行防止用の進行中フラグと、アンマウント後の
  // setState防止用フラグ。必須ローカル初期化は「同時に1回しか走らない」という単純な制約で
  // requestIdカウンタは導入しない。
  const initializingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [localEvents, setLocalEvents] = useState<AppEvent[]>([]);
  const [overlaySettings, setOverlaySettings] =
    useState<OverlaySettings>(DEFAULT_OVERLAY);
  /**
   * [P0094 CORRECT-F019-001] overlaySettings/favoriteCalendarIdsの「直列化キューが
   * 前段のcommitを反映し終えた後の最新値」を保持するref。React stateのuseCallback
   * クロージャは呼び出し時点でしか最新化されないため、rapid-toggle時に後続の
   * commitOwnerBoundLocalPreferenceImpl呼び出しがこのrefを読む（stateではなく）ことで、
   * 先行するenqueue済み操作の結果を上書きしない。更新は必ずcommit()相当のタイミングで
   * setOverlaySettings/setFavoriteCalendarIdsと同期して行う（refresh()の初回読込みも含む）。
   */
  const overlaySettingsRef = useRef(overlaySettings);
  const [shareTargets, setShareTargets] = useState<ShareTarget[]>([]);
  const [userCalendars, setUserCalendars] = useState<UserCalendar[]>([]);
  /**
   * [P0096 DATA-F018-003] userCalendarsの「直列化キュー（
   * enqueueLocalCalendarLifecycleOperation）が前段の操作を反映し終えた後の最新値」を保持する
   * ref。overlaySettingsRef/favoriteCalendarIdsRefと同じ理由・同じ規律——更新は必ず
   * setUserCalendarsと同期したタイミング（同じ関数呼び出し内、awaitを挟まない）で行う
   * （refresh()の初回読込み、addUserCalendar/updateUserCalendar/removeUserCalendarの各
   * 直列化された操作の中）。レンダーのタイミング（useEffect等）には一切依存しない。
   */
  const userCalendarsRef = useRef(userCalendars);
  /**
   * [P0096 DATA-F018-003] isPremiumはレンダーごとのクロージャ値（usePremiumStatus()由来）
   * だが、addUserCalendarの上限判定は直列化された実行時点の最新の資格状態で行いたい
   * （「premium entitlement transition」との競合をふさぐため）。レンダー本体で毎回同期的に
   * 更新するrefを使う（この代入自体はJSXの出力に影響しない副作用の無い操作のため、
   * レンダー中に行っても安全）。isPremiumも同じ理由でisPremiumRef.current（実行時点の
   * 最新の資格状態）を使う。
   */
  // フォールバックするため、PremiumProviderでラップしない既存テストは壊れない。
  const isPremium = usePremiumStatus();
  const isPremiumRef = useRef(isPremium);
  isPremiumRef.current = isPremium;
  const [favoriteCalendarIds, setFavoriteCalendarIds] = useState<string[]>([]);
  const favoriteCalendarIdsRef = useRef(favoriteCalendarIds);
  const [lastUsedCalendarId, setLastUsedCalendarId] = useState<string | null>(null);
  /**
   * [P0102 CORRECT-F019-006] lastUsedCalendarIdの「直列化キューが前段のcommitを反映し
   * 終えた後の最新値」を保持するref（overlaySettingsRef/favoriteCalendarIdsRefと同じ
   * P0094 CORRECT-F019-001パターン）。pending transactionへ書くpreviousValue（＝rollback先）
   * は、React stateのuseCallbackクロージャではなく、直列化されたderiveNextValue実行時点の
   * このrefから導出する。クロージャを使うと、rapid連続呼び出し時にop2のpreviousValueが
   * op1適用前の古い値になり、op2のstale rollbackがop1の結果まで巻き戻してしまう。
   * 更新は必ずcommit()と同期（refresh()の初回読込み含む）。
   */
  const lastUsedCalendarIdRef = useRef(lastUsedCalendarId);

  // Stage I-4: 集中モードの完了・中断履歴。focusSessionRepositoryの薄いラッパー。
  const [focusHistory, setFocusHistory] = useState<FocusSessionRecord[]>([]);

  /**
   * SEC-F007-001 最終設計: sharedCalendars/remoteEvents/pendingInvites/pendingInvitesError/
   * loadingShared/loadingPendingInvites/所有者情報/要求トークンを1つのreducerへ統合する
   * （型・reduceSharedDataの定義はファイル冒頭参照）。
   */
  const [sharedData, dispatchSharedData] = useReducer(reduceSharedData, INITIAL_SHARED_DATA);
  /**
   * [P0096 CORRECT-F020-003] sharedDataの最新値を、Reactのレンダー/コミットのタイミングに
   * 依存せず同期的に追跡するref。useReducerの更新は次のレンダーまで実際のsharedDataへ
   * 反映されないため、素のdispatchSharedDataを呼ぶだけでは、直後に別の非同期処理
   * （stale-ID後始末effectのderiveNextValue等、直列化キューに積まれてから実行されるまでに
   * 遅延がありうる処理）がsharedDataの最新値を読もうとしても、まだ反映されていない可能性が
   * ある。reduceSharedData自体は純粋関数のため、dispatchと全く同じ入力から同じ出力を
   * 独立に計算し、dispatchと同期的に（同じ関数呼び出し内で）refへ書き込む。
   */
  const sharedDataRef = useRef(sharedData);
  const dispatchSharedDataTracked = useCallback((action: SharedDataAction) => {
    sharedDataRef.current = reduceSharedData(sharedDataRef.current, action);
    dispatchSharedData(action);
  }, []);
  const requestTokenCounterRef = useRef(0);

  /**
   * REVISE対応（第3ラウンド、P1-1/P1-2/P1-3）: ローカル予定が「このセッションで一度でも
   * 確定したか」を、refではなく実際のReact state（コミットされた値）として保持する。
   * 通知reconcileを行う唯一の場所（下方の単一effect）がこの値・localEvents・sharedDataの
   * committed値だけを見て判断できるようにするため（refのタイミングに依存する分岐を排除する）。
   * 両方（ローカル・共有）揃うまでは通知reconcileを実行しない。片方だけの不完全な集合で
   * reconcileすると、もう片方（まだ読み込んでいない側）の通知を「候補に無い＝削除された」と
   * 誤認して全取消してしまう事故につながるため。
   */
  const [localSettled, setLocalSettled] = useState(false);
  /**
   * REVISE対応（第3ラウンド、P1-1/P1-2/P1-3）: アプリがフォアグラウンドへ復帰した際に、
   * localEvents・sharedDataのいずれも変化していなくても通知reconcileを再実行させるための
   * トリガー用カウンタ（値そのものに意味は無く、変化したことだけを使う）。AppState
   * リスナー自身はrefを直接読んでreconcileを呼ばず、この値をインクリメントするだけに
   * とどめ、実際の判断・実行は下方の単一effectへ委譲する。
   */
  const [reconcileRequestCounter, setReconcileRequestCounter] = useState(0);

  /**
   * SEC-F007-001 最終設計: 所有者（ownerUserId・sessionInstanceId）が変わるたびに、
   * useEffect（コミット後にしか実行されない）ではなく、レンダー関数の本体で同期的に
   * OWNER_CHANGEDをdispatchする。Reactの「レンダー中にstateを調整する」公式パターンにより、
   * この呼び出しはこのレンダーの出力を破棄して直ちに更新後のstateで再レンダーしてから
   * コミットするため、新しい所有者として最初にコミットされるレンダーの時点で、既に
   * 前所有者の共有カレンダー・共有予定・招待が取り除かれた状態になる。A→B・A→null・
   * null→A・A→null→Aのいずれも区別せず一律に扱う（reduceSharedDataのOWNER_CHANGED参照）。
   * 非同期I/O（refreshShared/refreshPendingInvites/clearSyncQueue/reconcileNotifications）は
   * レンダー中に呼べないため、従来通り下記のuseEffectで行う。
   */
  if (!authLoading) {
    const nextUserId = user?.id ?? null;
    const nextSessionInstanceId = nextUserId ? authSessionInstanceId : null;
    if (sharedData.ownerUserId !== nextUserId || sharedData.sessionInstanceId !== nextSessionInstanceId) {
      dispatchSharedDataTracked({ type: "OWNER_CHANGED", nextUserId, nextSessionInstanceId });
    }
  }

  const {
    syncStatusByEventId: rawSyncStatusByEventId,
    enqueueUpsert,
    enqueueDelete,
    clear: clearSyncQueue,
    purgeStale: purgeStaleSyncQueue,
  } = useSyncQueueProcessor(user?.id ?? null, user?.id ? authSessionInstanceId : null);

  /**
   * SEC-F007-001: useSyncQueueProcessorが返すsyncStatusByEventIdは、同期キューに残っている
   * 全項目（所有者を問わない）からeventIdだけで組み立てられており、ユーザー切替時にも
   * クリアされない（保存形式・flush時の所有者チェック自体はSEC-F002-001で対応済みのため
   * 変更しない）。表示用にここで、現在のremoteEventsに実在するeventIdだけへ絞り込む。
   * これにより、ユーザー切替でremoteEventsが即座に空へ戻るのと同時に、この表示用
   * syncStatusByEventIdも自動的に空へ戻る（旧ユーザーの同期状態バッジが新ユーザーへ
   * 一瞬でも表示され続けることを防ぐ）。
   */
  const syncStatusByEventId = useMemo(() => {
    const remoteEventIds = new Set(sharedData.remoteEvents.map((e) => e.id));
    const filtered: Record<string, SyncStatus> = {};
    for (const [eventId, status] of Object.entries(rawSyncStatusByEventId)) {
      if (remoteEventIds.has(eventId)) {
        filtered[eventId] = status;
      }
    }
    return filtered;
  }, [rawSyncStatusByEventId, sharedData.remoteEvents]);

  const refresh = useCallback(async () => {
    // [P0098 DATA-F018-004] userCalendarsの読込み～base実体化～コミットを丸ごと
    // localCalendarLifecycleCoordinatorへenqueueする。以前はgetUserCalendars()を
    // Promise.allの中でenqueueの外から読み、その後のwithBaseCalendarEnsured・
    // saveUserCalendars・userCalendarsRef.current代入・setUserCalendarsも全て
    // enqueueの外で行っていたため、refresh実行中に別のcreate/update/delete操作
    // （addUserCalendar等）が割り込むと、どちらが後に書き込むかによって片方の結果が
    // 失われる恐れがあった（refresh→create、create→refreshのどちらの実行順序でも
    // 安全でなければならない）。addUserCalendar/updateUserCalendar/removeUserCalendarと
    // 同じ直列化キューにこの読込み～コミットまでを1つの操作として通すことで、
    // 常に「先行するすべての操作が反映し終えた後の最新値」からrefreshが実行される。
    const userCalendarsRefreshPromise = enqueueLocalCalendarLifecycleOperation(async () => {
      // [P0098 DATA-F018-004 追補] ここではtolerantなgetUserCalendars()ではなく
      // strict版を使う。getUserCalendars()内部のreadJSON()はAsyncStorage自体の
      // I/O失敗もJSON解析失敗も区別せず既定値`[]`へ静かに畳んでしまうため、これを
      // そのままこの直列化操作でコミットすると「storageの読込みが一時的に失敗しただけ」
      // なのに「実際にカレンダーが0件だった」と誤解し、既存の有効なメモリ上データを
      // 空配列由来の基本カレンダーのみの配列で上書きしてしまう。I/O失敗の場合だけ
      // ここで例外を投げてenqueueされた操作自体を失敗させ（＝コミットを一切行わない）、
      // 既存のuserCalendarsRef.current/React stateを変更せず温存する。
      // missing/malformed/not-arrayの扱いはgetUserCalendars()と同じ既存の寛容フォールバックの
      // ままで変更しない。
      const strictResult = await getUserCalendarsStrict();
      if (strictResult.kind === "io-error") {
        throw new Error("refresh_user_calendars_read_failed");
      }
      const calendars = strictResult.value;
      // 2026-08: 基本カレンダー「自分一人用」が無ければここで1回だけ実体化する
      // （新規インストール・旧バージョンからの引き継ぎのどちらでも、起動のたびに必ず1件は
      // 存在する状態へ揃える。既に存在する場合はwithBaseCalendarEnsuredが同じ配列参照を
      // 返すため、余計な永続化書き込みは発生しない）。
      const calendarsWithBase = withBaseCalendarEnsured(calendars, t);
      if (calendarsWithBase !== calendars) {
        await saveUserCalendars(calendarsWithBase);
      }
      userCalendarsRef.current = calendarsWithBase;
      setUserCalendars(calendarsWithBase);
    });

    // [P0098 CORRECT-F019-F020-004] overlay/favorite/last-usedの「pending解決→fresh read」
    // だけでなく、Reactへのコミット（ref同期更新＋setState）自体もowner-bound coordinatorの
    // 同一enqueue済み操作の内部で行う（readAndCommitOwnerBoundPreferencesSafely）。
    // 以前はreadOwnerBoundPreferencesSafely()の読込み結果をPromise.all解決後
    // （＝enqueueされた操作が既に完了した後）でコミットしていたため、読込みとコミットの間に
    // 別の新しいintentがこのchainへ割り込んで先にcommitすると、その新しい結果をこの古い
    // refresh由来のスナップショットで上書きしてしまう窓があった。
    //
    // [P0100 SEC-F019-F020-005] この直列化だけでは、refresh()を開始した時点のauth identityと
    // 実際にcommitする時点のauth identityが一致する保証にはならなかった（enqueue待ち・
    // pending journal解決・Storage readのいずれのawaitの間にも識別情報が切り替わりうる）。
    // Reactのclosure/state（useEffectでコミット後にしか更新されないref等）ではなく、
    // 権威があるauthSessionIdentityStoreから、enqueueする直前のidentityをsnapshotとして
    // 取得し、readAndCommitOwnerBoundPreferencesSafely側の4箇所の再検証に渡す
    // （詳細は同関数のdoc参照）。
    const ownerBoundRefreshStartingIdentity = getCurrentAuthIdentity();
    const ownerBoundRefreshPromise = readAndCommitOwnerBoundPreferencesSafely(
      ownerBoundRefreshStartingIdentity,
      (values) => {
        setOverlaySettings(values.overlaySettings);
        overlaySettingsRef.current = values.overlaySettings;
        setFavoriteCalendarIds(values.favoriteCalendarIds);
        favoriteCalendarIdsRef.current = values.favoriteCalendarIds;
        setLastUsedCalendarId(values.lastUsedCalendarId);
        // [P0102 CORRECT-F019-006] lastUsedCalendarIdRefもcommitと同期して最新化する。
        lastUsedCalendarIdRef.current = values.lastUsedCalendarId;
      }
    );

    // events/sharesはowner-bound機構ともuserCalendars直列化キューとも無関係のため、
    // 上記2つのenqueue済み操作とは独立にPromise.allで並行取得する
    // （直列化キューが busy でも、この2つの取得は待たされない）。
    const [evts, shares] = await Promise.all([
      getAllEvents(),
      getShareTargets(),
      userCalendarsRefreshPromise,
      ownerBoundRefreshPromise,
    ]);
    setLocalEvents(evts);
    setShareTargets(shares);
    // REVISE対応（第3ラウンド、P1-1/P1-2/P1-3）: ここで直接reconcileを呼ぶのをやめた。
    // 以前はcurrentOwnerRef/sharedLoadStatusRef（useEffectでのみ同期される、コミット後に
    // しか最新化されないref）を読んで分岐していたため、「authSessionIdentityStoreは既に
    // 新しいidentityを指しているのに、このrefだけがまだ古い値を指している」窓の間に
    // refresh()が完了すると、本来sharedの通知を保持すべき場面で誤ってlocal専用の
    // reconcileNotifications(evts)を呼んでしまい、対応表にある全scopeのエントリのうち
    // evtsの候補に無いものを「もう不要」とみなして取り消してしまう経路があった
    // （reconcileNotificationsは論理キー全体を対象にするため、scopeを問わず巻き込む）。
    // 代わりに、setLocalSettled(true)でReactのcommitted stateを更新するだけにし、
    // 実際のreconcile実行は下方の単一effect（sharedData・localEventsのみを根拠にする）に
    // 一本化する。
    setLocalSettled(true);
    // refreshの参照はtの変化で変わらないようにする（他画面がuseFocusEffect等の依存配列に
    // refreshを含めており、言語切替のたびに予定の再読み込みが誤発火するのを防ぐ、既存の
    // seed適用と同じ方針）。tはbase calendar実体化の初回作成時のみ参照され、既に実体が
    // あれば呼ばれない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshFocusHistory = useCallback(async () => {
    const history = await getFocusHistory();
    setFocusHistory(history);
  }, []);

  const appendFocusHistory = useCallback(async (record: FocusSessionRecord) => {
    const next = await appendFocusHistoryToStorage(record);
    setFocusHistory(next);
  }, []);

  const deleteFocusHistoryRecord = useCallback(async (id: string) => {
    const next = await deleteFocusHistoryRecordFromStorage(id);
    setFocusHistory(next);
  }, []);

  /**
   * 単独修正(2026-08、ROBUST-F001-002): 必須ローカルデータ初期化（シード適用＋refresh＋
   * refreshFocusHistory）をtry/catchで包み、失敗時は例外を握りつぶさず"error"状態へ遷移する
   * （failしても`initializationStatus`を"ready"にはしない＝空データを正式データとして
   * 描画・保存する事故を防ぐ）。マウント時の初回実行と、エラー画面からの再試行の両方から
   * この同じ関数を呼ぶ（ロジックを重複実装しない）。
   * `initializingRef`により、初回実行と再試行、または再試行の連打が同時に走ることを防ぐ
   * （既に進行中なら何もしない）。
   */
  const runInitialization = useCallback(async () => {
    if (initializingRef.current) return;
    initializingRef.current = true;
    if (mountedRef.current) setInitializationStatus("loading");
    // この呼び出しが完了するまでは他のJSコードは一切割り込めない＝新しいドラフト作成との
    // 競合が構造的に発生しない）。清掃は非必須の補助処理のため、専用のtry/catchで隔離し、
    // 失敗してもAppData自体の初期化状態（ready/error）には一切影響させない。
    // REVISE対応（第6ラウンド、P1-3）: 前回起動時までに完了できなかった所有者単位の
    // 共有通知クリーンアップ（cancelAllSharedNotificationsForOwner）をここで再試行する
    // （アプリ再起動をまたいで残り続けないようにする）。必須データの初期化状態
    // （ready/error）には影響させない、非必須のベストエフォート処理。
    // [P0124 DATA-F073-004] 対応表が破損確定している場合のみ、OS状態から再構築する
    // （破損していなければ何も書かない。durable markerは持たない冪等な単一キー修復）。
    repairCorruptNotificationRegistryIfNeeded().catch((e) => {
      if (__DEV__) {
        console.warn("[AppDataContext] 通知対応表の破損復旧に失敗しました", e);
      }
    });
    retryPendingOwnerNotificationCleanups().catch((e) => {
      if (__DEV__) {
        console.warn(
          "[AppDataContext] 未完了の所有者単位通知クリーンアップの再試行に失敗しました",
          e instanceof Error ? e.message : "unknown error"
        );
      }
    });
    // ここでも再試行する（アプリ再起動をまたいで残り続けないようにする）。
    // 自身が現在ログイン中のidentityを自己解決し、未ログイン時は何もしない
    // （self-gate）ため、呼び出し側での追加のidentityチェックは不要。
    // REVISE対応（第7ラウンド、P1-2）: 同じく前回起動時までに解除できなかった
    // 共有通知セキュリティバリア（blockedIdentities）を再試行する。
    retrySharedNotificationSecurityBarrier().catch((e) => {
      if (__DEV__) {
        console.warn(
          "[AppDataContext] 共有通知セキュリティバリアの再試行に失敗しました",
          e instanceof Error ? e.message : "unknown error"
        );
      }
    });
    // DATA-F002-003: 前回プロセスの孤立ドラフト添付ディレクトリを、必須データの復元より前に
    // 同期的に一括削除する（cleanupOrphanedAttachmentDrafts自体は同期処理のため、
    // await不要）。
    try {
      cleanupOrphanedAttachmentDrafts();
    } catch (e) {
      if (__DEV__) {
        console.warn(
          "[AppDataContext] 孤立ドラフト添付の清掃に失敗しました（次回起動時に再試行されます）",
          e instanceof Error ? e.message : "unknown error"
        );
      }
    }
    // Round 12（SEC-F007-004、P1-2）: 共有添付画像のStorage/DB後始末が完了できなかった対象を
    // ここで再試行する。
    retryPendingAttachmentCleanups().catch((e) => {
      if (__DEV__) {
        console.warn(
          "[AppDataContext] 未完了の添付クリーンアップの再試行に失敗しました",
          e instanceof Error ? e.message : "unknown error"
        );
      }
    });
    // P0040（15節）: 前回起動時までに完了できなかったC14 attachment migration
    // （shared calendar間の予定移動）も同様にここで再試行する。retryPendingAttachmentMigrations
    // 自身が現在ログイン中のidentityを自己解決し、未ログイン時は何もしない（self-gate）。
    retryPendingAttachmentMigrations().catch((e) => {
      if (__DEV__) {
        console.warn(
          "[AppDataContext] 未完了の添付migrationの再試行に失敗しました",
          e instanceof Error ? e.message : "unknown error"
        );
      }
    });
    try {
      await applySeedDataIfNeeded(t);
      await Promise.all([refresh(), refreshFocusHistory()]);
      if (mountedRef.current) setInitializationStatus("ready");
    } catch (e) {
      // 開発時のみ、失敗段階の判別に必要な最小限の情報（メッセージのみ）を出す。
      // 予定内容・個人情報・Storageの生データ・スタックトレースは出力しない。
      if (__DEV__) {
        // eslint-disable-next-line no-console -- 開発時のみ、初期化失敗の調査用ログ（本文・個人情報は出力しない）
        console.warn(
          "[AppDataContext] 必須ローカルデータの初期化に失敗しました",
          e instanceof Error ? e.message : "unknown error"
        );
      }
      if (mountedRef.current) setInitializationStatus("error");
    } finally {
      initializingRef.current = false;
    }
    // refresh/refreshFocusHistoryの参照は安定しているため、実質的にtの変化でのみ
    // この関数自体の参照が変わる（再試行ボタンの最新localeが反映されるだけで、
    // 自動的な再実行は起きない＝呼び出しは常にuseEffect（マウント時のみ）と
    // 明示的なretryInitialization呼び出しの2箇所だけ）。
  }, [t, refresh, refreshFocusHistory]);

  useEffect(() => {
    runInitialization();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初回マウント時にのみ実行する（runInitializationの参照変化では再実行しない。再試行は明示的なretryInitialization呼び出しのみで行う）
  }, []);

  /** エラー画面の再試行ボタンから呼ぶ。runInitializationと同じ二重実行防止を共有する。 */
  const retryInitialization = useCallback(() => runInitialization(), [runInitialization]);

  // 後方互換のため維持する`loading`は、"loading"だけでなく"error"のときもtrueにする
  // （ROBUST-F001-002: falseにすると、既存の`if (loading) return <LoadingView />; ...`という
  // 判定を持つ画面が「初期化失敗＝完了」と誤認し、空データを通常の予定一覧として描画して
  // しまうため。実際の失敗表示・再試行導線はAppDataInitializationGateが一箇所で担う）。
  const loading = initializationStatus !== "ready";

  /**
   * SEC-F007-001 最終設計: `sharedData.ownerUserId`/`sessionInstanceId`をuseCallbackの
   * 依存配列に含めることで、呼び出し開始時に常に「現在committedな所有者」をクロージャで
   * 捕捉できる（refのタイミングに依存しない）。requestTokenは呼び出し1回ごとに発行し、
   * `SHARED_REQUEST_STARTED`でstateへ登録する。完了actionはreducer側で
   * owner/session/token全一致を照合するため、このコールバック自身は「追い越されたかどうか」を
   * 判定する必要がない（判定と反映を1つのreducerへ一元化する）。
   */
  /**
   * REVISE対応（第8ラウンド、P1-5）: 開始時だけでなく、fetchJoinedCalendars後・
   * fetchEventsForCalendars前後・各dispatch前にも、権威あるauthSessionIdentityStoreと
   * 照合する。古いクロージャ（別ユーザーへの切替直後に残る、この関数の古い参照）から
   * 呼ばれた場合はもちろん、開始時点では現在のidentityだったこの関数自身が、await境界の
   * 途中でidentityが切り替わった場合も、それ以降のネットワーク呼出し・dispatchを一切
   * 行わない（stale時に「新しい所有者向けのrefresh」へ自動的に読み替えることもしない
   * ——単に打ち切るだけ）。reducer側（reduceSharedData）のowner/session/token一致判定は
   * 既存のまま維持しており、このチェックはそれに加えた開始前の追加防御である
   * （不要なネットワーク呼出し・dispatch自体を未然に減らす）。呼び出し元に対する
   * 「例外を投げない」という既存の公開契約は変えない（unhandled rejectionを増やさないため）。
   */
  const refreshShared = useCallback(async () => {
    const { ownerUserId, sessionInstanceId } = sharedData;
    if (typeof ownerUserId !== "string" || sessionInstanceId === null) return;
    const identity: SharedMutationIdentity = { userId: ownerUserId, sessionInstanceId };
    if (!isCurrentSharedMutationIdentity(identity)) return;
    const token = ++requestTokenCounterRef.current;
    dispatchSharedDataTracked({ type: "SHARED_REQUEST_STARTED", ownerUserId, sessionInstanceId, token });
    try {
      const joined = await fetchJoinedCalendars(identity);
      if (!isCurrentSharedMutationIdentity(identity)) return;
      // 共有カレンダー一覧は、共有予定の取得を待たずここで即座に反映する（元の実装と同じ
      // 2段階更新。1つの完了actionへまとめると、共有予定側の取得が完了するまで
      // sharedCalendarsの表示が遅延してしまうため）。
      dispatchSharedDataTracked({
        type: "SHARED_CALENDARS_RECEIVED",
        ownerUserId,
        sessionInstanceId,
        token,
        calendars: joined,
      });
      if (!isCurrentSharedMutationIdentity(identity)) return;
      const events = await fetchEventsForCalendars(joined.map((j) => j.calendar.id), identity);
      if (!isCurrentSharedMutationIdentity(identity)) return;
      dispatchSharedDataTracked({
        type: "SHARED_REQUEST_SUCCEEDED",
        ownerUserId,
        sessionInstanceId,
        token,
        events,
      });
      // REVISE対応（第3ラウンド、P1-1）: 以前はここで直接reconcileSharedNotificationsを
      // 呼んでいたが、この呼び出しは「上のSHARED_REQUEST_SUCCEEDEDディスパッチがreducer側で
      // 実際に受理されたか（owner/session/token全一致だったか）」を一切確認していなかった。
      // 拒否された場合（＝この要求より新しい要求が既に完了・進行中だった場合）でも、
      // ここで捕まえている（拒否された）古い`events`を使ってreconcileが実行されてしまい、
      // 新しい要求の結果がReact stateには正しく残っているのに、通知だけは古い予定一覧を
      // 元に再構築される、という不整合が生じ得た。reconcileは呼ばず、reducerが実際に
      // 受理した結果である`sharedData.remoteEvents`の変化だけを根拠に動く下方の単一effectへ
      // 委譲する（この関数の呼び出し元がここでawaitを終えても、まだ古い要求のままなら
      // 単一effectは何もしない＝新しい要求の結果が上書きされることはない）。
    } catch {
      if (!isCurrentSharedMutationIdentity(identity)) return;
      dispatchSharedDataTracked({ type: "SHARED_REQUEST_FAILED", ownerUserId, sessionInstanceId, token });
    }
    // sharedData全体ではなく所有者フィールドだけに依存する（sharedData.remoteEvents等の
    // 更新のたびにこの関数自体が再生成され、それを依存配列に含む下記useEffectが
    // 無限に再実行されるのを防ぐため）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedData.ownerUserId, sharedData.sessionInstanceId]);

  /** REVISE対応（第8ラウンド、P1-5）: refreshSharedと同じ理由で開始時・await後を確認する。 */
  const refreshPendingInvites = useCallback(async () => {
    const { ownerUserId, sessionInstanceId } = sharedData;
    if (typeof ownerUserId !== "string" || sessionInstanceId === null) return;
    const identity: SharedMutationIdentity = { userId: ownerUserId, sessionInstanceId };
    if (!isCurrentSharedMutationIdentity(identity)) return;
    const token = ++requestTokenCounterRef.current;
    dispatchSharedDataTracked({ type: "INVITES_REQUEST_STARTED", ownerUserId, sessionInstanceId, token });
    try {
      const invites = await fetchPendingInvitesForCurrentUser(identity);
      if (!isCurrentSharedMutationIdentity(identity)) return;
      dispatchSharedDataTracked({
        type: "INVITES_REQUEST_SUCCEEDED",
        ownerUserId,
        sessionInstanceId,
        token,
        invites,
      });
    } catch (e) {
      if (!isCurrentSharedMutationIdentity(identity)) return;
      // 失敗時はpendingInvitesを一切書き換えない（招待0件として誤表示しない・
      // 既に取得済みの一覧はそのまま維持する。reduceSharedDataのINVITES_REQUEST_FAILED参照）。
      dispatchSharedDataTracked({
        type: "INVITES_REQUEST_FAILED",
        ownerUserId,
        sessionInstanceId,
        token,
        message: e instanceof Error ? e.message : "unknown error",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedData.ownerUserId, sharedData.sessionInstanceId]);

  /**
   * SEC-F007-001: 直前の所有者（userId・sessionInstanceId）を記憶する、effect内でのみ
   * 読み書きするref（レンダー中には一切触れない＝Reactの「refはイベントハンドラー・
   * Effectで使うぶんには問題ない」というルールに従う）。初回解決（null）かどうかだけを
   * 判定するために使い、前所有者の共有通知一括取消しを「実際に前の所有者が存在した遷移」
   * でのみ行う。
   */
  const previousOwnerRef = useRef<{ userId: string | null; sessionInstanceId: string | null } | null>(
    null
  );

  useEffect(() => {
    if (authLoading) return; // 認証状態がまだ確定していない間は何もしない
    const nextUserId = user?.id ?? null;
    const nextSessionInstanceId = nextUserId ? authSessionInstanceId : null;
    const prev = previousOwnerRef.current;
    previousOwnerRef.current = { userId: nextUserId, sessionInstanceId: nextSessionInstanceId };

    /**
     * REVISE対応（P2）: このeffectの依存配列は`user`（オブジェクト参照）を含むため、
     * TOKEN_REFRESHED等でuserId・sessionInstanceIdのいずれも変化しない認証イベント
     * （同じユーザー・同じ認証セッションのまま、sessionオブジェクトの参照だけが更新される
     * 場合）でも再実行されうる。userId・sessionInstanceIdのいずれかが実際に変化した場合
     * （初回解決を含む）だけ、以降の所有者切替処理（前所有者の共有通知一括取消・
     * 共有state再取得・同期キュークリア等）を行う。これにより、TOKEN_REFRESHED等の
     * 同一identity更新のたびに、まだ現在の所有者であるはずの自分自身の共有通知が
     * 不必要に取り消されてしまうことを防ぐ。
     */
    const identityChanged =
      prev === null ||
      prev.userId !== nextUserId ||
      prev.sessionInstanceId !== nextSessionInstanceId;
    if (!identityChanged) return;

    // REVISE対応（第6ラウンド、P1-3）: identity変化のたびに、以前の（今回よりさらに前の）
    // 切替で完了できなかった所有者単位クリーンアップも合わせて再試行する。今回
    // prepareSharedNotificationIdentityが新たにcleanupを起動する場合でも、そちらは非同期に
    // 独自の直列化チェーンで進行するため、ここでの再試行と重複して二重に取り消しても
    // OS側の取消・対応表からの削除はいずれも冪等なため無害。
    // [P0124 DATA-F073-004] 対応表が破損確定している場合のみ、OS状態から再構築する
    // （破損していなければ何も書かない。durable markerは持たない冪等な単一キー修復）。
    repairCorruptNotificationRegistryIfNeeded().catch((e) => {
      if (__DEV__) {
        console.warn("[AppDataContext] 通知対応表の破損復旧に失敗しました", e);
      }
    });
    retryPendingOwnerNotificationCleanups().catch((e) => {
      if (__DEV__) {
        console.warn(
          "[AppDataContext] identity変化時の所有者単位通知クリーンアップ再試行に失敗しました",
          e instanceof Error ? e.message : "unknown error"
        );
      }
    });
    // Round 12（SEC-F007-004、P1-2）: identity変化のたびに、以前の切替で完了できなかった
    // したケースを拾う）。
    // P0040（15節）: identity変化のたび（新しいidentityが同じownerUserIdを再ログインした
    // 何もしないため、ログアウトを含むあらゆるidentity変化でこの呼び出し自体は無条件に
    // 行ってよい（16節: sign-out/null identity → retry 0、を自動的に満たす）。
    // REVISE対応（第7ラウンド、P1-2）: 同じく、以前の切替でまだ解除できていない
    // 共有通知セキュリティバリア（blockedIdentities）も合わせて再試行する。
    // REVISE対応（第8ラウンド、P1-1）: このeffectはコミット後にしか実行されないため、
    // ここでバリアの「開始」を行うと、authSessionIdentityStoreが更新されてから
    // このeffectが実行されるまでの窓の間、新identityがまだblockedになっていない状態が
    // 生まれる。そのためsharedNotificationCoordinator自身がauthSessionIdentityStoreを
    // 直接購読し、identityの変化と完全に同じ同期経路（Reactのコミット・Effectより必ず
    // 先）でバリアを立てるよう変更した（旧prepareSharedNotificationIdentityの呼び出しは
    // 廃止）。このeffectは、既に（ここより前の同期経路で）確定しているバリア状態に対し、
    // 以前の切替から残っている未解決cleanupの再試行機会を追加で与えるだけにとどめる
    // （cleanup開始の起点ではなく、再試行のトリガーの1つ）。
    retrySharedNotificationSecurityBarrier().catch((e) => {
      if (__DEV__) {
        console.warn(
          "[AppDataContext] identity変化時の共有通知セキュリティバリア再試行に失敗しました",
          e instanceof Error ? e.message : "unknown error"
        );
      }
    });
    // 添付クリーンアップも合わせて再試行する（新しいidentityが同じownerUserIdを再ログイン
    // したケースを含む）に、以前の切替で完了できなかったC14 attachment migrationも合わせて
    // 再試行する。retryPendingAttachmentMigrationsは未ログイン（sign-out）時は自己gateで
    // 何もしない。
    retryPendingAttachmentCleanups().catch((e) => {
      if (__DEV__) {
        console.warn(
          "[AppDataContext] identity変化時の添付クリーンアップ再試行に失敗しました",
          e instanceof Error ? e.message : "unknown error"
        );
      }
    });
    retryPendingAttachmentMigrations().catch((e) => {
      if (__DEV__) {
        console.warn(
          "[AppDataContext] identity変化時の添付migration再試行に失敗しました",
          e instanceof Error ? e.message : "unknown error"
        );
      }
    });

    if (nextUserId && nextSessionInstanceId) {
      // REVISE対応（P2-2、再監査）: 以前はここで（初回解決でなければ）sharedSettledRef.current
      // を無条件にtrueへ強制していたが、これは「Bへの切替直後、Bの取得がまだ何も完了して
      // いないのに“共有側は確定済み”として扱われる」バグそのものだった
      // （直後にremoteEventsが空のままreconcileされ、Bの既存の共有通知を誤って
      // 削除しうる）。この強制を廃止し、OWNER_CHANGEDで"idle"にリセットされた
      // sharedLoadStatusが、この直後に呼ぶrefreshShared()の実際の完了
      // （SHARED_REQUEST_SUCCEEDED/FAILED）によってのみ"succeeded"/"failed"へ
      // 遷移するのを待つ。
      refreshShared();
      refreshPendingInvites();
      // REVISE対応（第6ラウンド、P1-2）: 以前は直接切替（prev!==null）の場合のみ
      // clearSyncQueue()（全消去）を呼んでいたが、これは「起動直後から既にBでログイン
      // 済みだった」場合（prev===null）を対象外にしていたため、以前のA・旧セッションの
      // 未送信項目（予定のタイトル・メモ等を含むAppEvent全体を保持している）が、
      // ログアウト時の消去が何らかの理由で失敗していた場合に無期限に残り続けうる。
      // 全消去（現在identity自身の正当な未送信分まで巻き込む）ではなく、現在の
      // userId/sessionInstanceId「以外」の項目・旧形式項目だけを選択的に除去する
      // purgeStaleSyncQueueへ統一し、prev===null（起動直後の初回解決）・prev!==null
      // （直接切替）のいずれでも常に呼ぶ（現在identity自身の未送信分は保持されるため、
      // 「元から同じ人だった」ケースを誤って壊さない）。
      purgeStaleSyncQueue(nextUserId, nextSessionInstanceId);
    } else {
      // ログアウト時・sessionInstanceIdが異常で取得できない時は、未送信キューを必ずクリアする
      // （共有state自体は、レンダー中のOWNER_CHANGEDにより既に空になっている）。
      // REVISE対応（第3ラウンド、P1-1/P1-2/P1-3）: ここでreconcileNotificationsを直接
      // 呼ぶのをやめた。ownerUserIdは既にレンダー中のOWNER_CHANGEDでnullへ確定しているため、
      // 下方の単一effectがsharedData.ownerUserId===nullを検知して自動的にlocal専用の
      // reconcileを行う（localSettled/localEventsは実際のReact stateなので、この効果が
      // 発火する時点で両方とも最新のcommitted値を参照できる）。
      clearSyncQueue();
    }
  }, [
    authLoading,
    user,
    authSessionInstanceId,
    refreshShared,
    refreshPendingInvites,
    clearSyncQueue,
    purgeStaleSyncQueue,
  ]);

  // Stage H-6: アプリがフォアグラウンドへ復帰した際にも通知を再構築する
  // （バックグラウンド中に過去化した通知の整理、ローリングウィンドウの繰り上げのため）。
  // 2026-08: 招待タブの未処理件数も、高頻度ポーリングを追加せずこのタイミングに相乗りして
  // 再取得する（ユーザーがアプリを開いたままバックグラウンドへ回った間に届いた新着招待を反映）。
  // REVISE対応（第3ラウンド、P1-1/P1-2/P1-3）: リスナー自身はrefを直接読んでreconcileを
  // 呼ばず、reconcileRequestCounterを進めるだけにとどめる。実際にreconcileするかどうか・
  // どちらのモードで行うかの判断は、下方の単一effect（committed stateだけを見る）に委ねる。
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      setReconcileRequestCounter((c) => c + 1);
      refreshPendingInvites();
      // REVISE対応（第6ラウンド、P1-3）: 前回までに完了できなかった所有者単位の
      // 共有通知クリーンアップを、AppState「active」復帰のタイミングにも相乗りして
      // 再試行する（アプリを閉じずバックグラウンドに置いたまま復帰した場合も拾う）。
      // [P0124 DATA-F073-004] 対応表が破損確定している場合のみ、OS状態から再構築する
    // （破損していなければ何も書かない。durable markerは持たない冪等な単一キー修復）。
    repairCorruptNotificationRegistryIfNeeded().catch((e) => {
      if (__DEV__) {
        console.warn("[AppDataContext] 通知対応表の破損復旧に失敗しました", e);
      }
    });
    retryPendingOwnerNotificationCleanups().catch((e) => {
        if (__DEV__) {
          console.warn(
            "[AppDataContext] AppState復帰時の所有者単位通知クリーンアップ再試行に失敗しました",
            e instanceof Error ? e.message : "unknown error"
          );
        }
      });
      // 復帰のタイミングに相乗りする。
      // single-flight+rerunにより、identity変化effectと近い時間帯に発火しても
      // 重複したremote副作用にはならない。
      // REVISE対応（第7ラウンド、P1-2）: 同じく、共有通知セキュリティバリアの再試行にも
      // AppState「active」復帰のタイミングに相乗りする。
      retrySharedNotificationSecurityBarrier().catch((e) => {
        if (__DEV__) {
          console.warn(
            "[AppDataContext] AppState復帰時の共有通知セキュリティバリア再試行に失敗しました",
            e instanceof Error ? e.message : "unknown error"
          );
        }
      });
      // Round 12（SEC-F007-004、P1-2）: 同じく、添付クリーンアップの再試行にもAppState「active」
      // 復帰のタイミングに相乗りする。
      retryPendingAttachmentCleanups().catch((e) => {
        if (__DEV__) {
          console.warn(
            "[AppDataContext] AppState復帰時の添付クリーンアップ再試行に失敗しました",
            e instanceof Error ? e.message : "unknown error"
          );
        }
      });
      // P0040（15節）: 同じく、C14 attachment migrationの再試行にもAppState「active」
      // 復帰のタイミングに相乗りする。retryPendingAttachmentMigrations自身のmodule-level
      // single-flight+rerunにより、identity変化effectと近い時間帯に発火しても
      // 重複したremote副作用にはならない。
      retryPendingAttachmentMigrations().catch((e) => {
        if (__DEV__) {
          console.warn(
            "[AppDataContext] AppState復帰時の添付migration再試行に失敗しました",
            e instanceof Error ? e.message : "unknown error"
          );
        }
      });
    });
    return () => subscription.remove();
  }, [refreshPendingInvites]);

  /**
   * REVISE対応（第8ラウンド、P1-4）: sharedNotificationCoordinatorのセキュリティバリアが
   * （いずれかの所有者のcleanup成功により）解除された通知を購読し、AppState「active」
   * 復帰と同じ仕組み（reconcileRequestCounterのインクリメント）で下方の単一effectへ
   * 再構築を促す。この購読自体は「何を」reconcileすべきかを一切判断しない
   * （UI側の再構築トリガーに徹する）——判断は既存の単一effect（committed stateのみを見る）
   * に委ねたままにする。これにより、block中に保留されていた共有通知の再構築が、
   * AppState「active」復帰を待たずに（barrier解除の直後に）発火する。
   */
  useEffect(() => {
    return subscribeToSharedNotificationBarrierRelease(() => {
      setReconcileRequestCounter((c) => c + 1);
    });
  }, []);

  const joinedCalendarIds = useMemo(
    () => sharedData.sharedCalendars.map((s) => s.calendar.id),
    [sharedData.sharedCalendars]
  );

  /**
   * SEC-F007-001 最終設計: Realtimeコールバック・同期呼び出し（saveEvent等の楽観反映）の
   * どちらも、このコールバックを通じて`REALTIME_EVENT_UPSERT`/`_DELETE`をdispatchする。
   * 所有者一致・カレンダー所属チェックはreducer側（reduceSharedData）で行うため、
   * このコールバック自身はrefを一切参照しない（`useSharedCalendarSync`が購読開始時点の
   * ownerUserId/sessionInstanceIdを引数として渡してくるため、常にその購読が張られた
   * 時点の所有者情報がここへ渡る）。
   */
  const handleRemoteEventChange = useCallback(
    (event: AppEvent, ownerUserId: string, sessionInstanceId: string) => {
      dispatchSharedDataTracked({ type: "REALTIME_EVENT_UPSERT", ownerUserId, sessionInstanceId, event });
    },
    [dispatchSharedDataTracked]
  );

  const handleRemoteEventDelete = useCallback(
    (eventId: string, ownerUserId: string, sessionInstanceId: string) => {
      dispatchSharedDataTracked({ type: "REALTIME_EVENT_DELETE", ownerUserId, sessionInstanceId, eventId });
    },
    [dispatchSharedDataTracked]
  );

  useSharedCalendarSync(
    joinedCalendarIds,
    typeof sharedData.ownerUserId === "string" ? sharedData.ownerUserId : "",
    sharedData.sessionInstanceId ?? "",
    handleRemoteEventChange,
    handleRemoteEventDelete
  );

  /**
   * REVISE対応（第3ラウンド、P1-1/P1-2/P1-3）: 通知reconcileを行う唯一の場所。
   * `refresh()`・`refreshShared()`・所有者切替effect・AppState復帰effectのいずれからも
   * 直接reconcileを呼ばなくなり、この単一effectへ集約した。判断材料はすべて実際に
   * コミットされたReact state（`localEvents`・`localSettled`・`sharedData.*`）のみで、
   * refのタイミングに依存する分岐は一切行わない。
   *
   * - `sharedData.ownerUserId`がNOT_YET_DETERMINED（認証状態がまだ解決していない）間は
   *   何もしない。
   * - `sharedData.ownerUserId === null`（ログアウトが確定済み）なら、ローカル予定だけを
   *   根拠にreconcileする（この時点で共有側のエントリは`cancelAllSharedNotificationsForOwner`
   *   （所有者切替effect）により別途取消済みのはずのため、ローカル専用reconcileが対応表の
   *   共有エントリを巻き込んでも安全）。
   * - ログイン中（`ownerUserId`が文字列）は、`sharedData.sharedLoadStatus === "succeeded"`
   *   の場合のみ、ローカル予定＋直近に成功した共有予定でreconcileする。REVISE対応
   *   （第3ラウンド、P1-2）: "failed"（取得失敗）を確定済みデータとして扱わない
   *   ——取得が失敗しただけで、Bの既存の共有通知が実際に無くなったわけではないため、
   *   空集合を確定データとして渡して誤って削除してしまうことを防ぐ。"loading"/"idle"の
   *   間も同様に何もしない（取得中の一時的な状態を確定扱いしない）。
   * - `reconcileRequestCounter`（AppState復帰時にインクリメントされる）を依存配列に含める
   *   ことで、他の値が変化していなくても定期的にreconcileを再実行できるようにする
   *   （バックグラウンド中に過去化した通知の整理・ローリングウィンドウの繰り上げのため）。
   *
   * `reconcileNotifications`/`reconcileSharedNotifications`自体が差分ベースで冪等なため、
   * 実質的な変更が無い場合の再実行は安全側の無駄な照合で済む（P1-1: refreshShared自身は
   * もうreconcileを呼ばないため、拒否されたstale要求の結果がここに紛れ込むことはない
   * ——このeffectが読むのは常にreducerが実際に受理した最新の`sharedData.remoteEvents`のみ）。
   */
  useEffect(() => {
    if (!localSettled) return;
    if (sharedData.ownerUserId === NOT_YET_DETERMINED) return;
    if (sharedData.ownerUserId === null) {
      // REVISE対応（第4ラウンド、P2）: reconcileNotificationsの引数がAppEvent[]から
      // NotificationEventEntry[]（{event, ownership}の組）へ変わったため、ここでも
      // ownershipを明示的に付与する（未ログイン時はすべてlocal scope）。
      // REVISE対応（第5ラウンド、P1-1）: 以前はisCurrentを渡していなかったため、
      // 未ログイン状態で開始したこのreconcileが、移行待機・権限確認・OS一覧取得等の
      // await境界の途中でユーザーBがログインしても止まらず、そのまま完走できた。
      // reconcileNotificationsInternalは「予約対象（今回の候補）に含まれない対応表
      // エントリ」を差分として取り消すため、完走してしまうとBが既に持つ正当な共有通知
      // （この呼び出しのローカル専用候補には含まれない）まで誤って取り消しうる。
      // authSessionIdentityStoreを直接参照し、「開始時点と同じく引き続き未ログイン
      // （userId===null）である」ことを各await境界で再確認するisCurrentを渡すことで、
      // 処理開始後にログインが完了した場合は以降の処理を打ち切るようにする。
      const isCurrent = () => getCurrentAuthIdentity().userId === null;
      const localEntries: NotificationEventEntry[] = localEvents.map((event) => ({
        event,
        ownership: { scope: "local" },
      }));
      reconcileNotifications(localEntries, { isCurrent });
      return;
    }
    if (sharedData.sharedLoadStatus !== "succeeded" || sharedData.sessionInstanceId === null) {
      return;
    }
    reconcileSharedNotifications(
      localEvents,
      sharedData.remoteEvents,
      sharedData.ownerUserId,
      sharedData.sessionInstanceId
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconcileRequestCounterは値そのものではなく変化のみをトリガーとして使う
  }, [
    localSettled,
    localEvents,
    sharedData.ownerUserId,
    sharedData.sessionInstanceId,
    sharedData.sharedLoadStatus,
    sharedData.remoteEvents,
    reconcileRequestCounter,
  ]);

  const saveEvent = useCallback(
    async (event: AppEvent) => {
      // REVISE対応（第3ラウンド、P1-4）: calendarIdの保存先を3値で判定し、"unknown"
      // （ローカルとも共有とも確認できない）は必ず例外で停止する。ローカルへの
      // フォールバックは行わない（詳細はclassifyCalendarOwnershipのdoc参照）。
      const classification = classifyCalendarOwnership(
        event.calendarId,
        userCalendars,
        sharedData.sharedCalendars
      );
      if (classification === "unknown") {
        throw new Error("この予定の保存先カレンダーを特定できないため、保存できません");
      }
      if (classification === "shared") {
        if (!user || typeof sharedData.ownerUserId !== "string") {
          throw new Error("共有予定の保存にはログインが必要です");
        }
        assertSessionReady(sharedData.sessionInstanceId);
        const ownerUserId = sharedData.ownerUserId;
        const sessionInstanceId = sharedData.sessionInstanceId;
        // REVISE対応（第8ラウンド、P1-5）: 開始前チェック（assertStillCurrentOwner相当）を
        // SharedMutationIdentity/runCurrentSharedMutation経由へ統一する。identityは
        // eventService.saveSharedEvent自身へも渡り、そちらでも独立に検証される
        // （P2、呼び出し元の申告をそのまま信頼しない）。
        const identity: SharedMutationIdentity = { userId: ownerUserId, sessionInstanceId };
        assertCurrentSharedMutationIdentity(identity);
        handleRemoteEventChange(event, ownerUserId, sessionInstanceId);
        // [P0080 AUTH-F013-F017-001] 実際のfetch送信直前にauth snapshotを1回だけ捕捉する。
        const auth = await captureSharedMutationAuthSnapshot(identity);
        // 共有予定の保存が成功した場合のみ、この端末のローカル通知をsharedNotificationCoordinator
        // 経由で予約する（通知APIの失敗はここでも外へ伝播しないため、保存成功の判定には影響しない）。
        const saveResult = await eventService.saveSharedEvent(event, {
          auth,
          enqueueUpsert,
        });
        if (saveResult === "saved") {
          const outcome = await scheduleSharedEventNotification(event, ownerUserId, sessionInstanceId);
          notifyIfNotificationPermissionDenied(outcome);
        } else if (saveResult === "discarded-stale" || saveResult === "stale-cleanup-pending") {
          // REVISE対応（第6ラウンド、P1-1）: 保存にもオフラインキューへの積み込みにも
          // 失敗した（操作開始後にログイン中のアカウントが切り替わったため）。呼び出し元
          // （画面）へ「保存されなかった」ことを明示的に伝える（成功したかのように
          // router.back()等が実行されないよう、例外を投げる）。
          // REVISE対応（第7ラウンド、P1-1）: "stale-cleanup-pending"（補償削除自体も
          // 失敗し、後始末が保留中）も同じ「保存されなかった」失敗として扱う——
          // Storageに実際に残っているかどうかに関わらず、この呼び出し元にとっては
          // どちらも「今回の保存操作は完了しなかった」という点で同じ意味を持つ。
          throw new Error(
            "ログイン中のアカウントが処理中に切り替わったため、この予定は保存されませんでした。もう一度お試しください"
          );
        }
        return;
      }
      // classification === "local"
      const { events: next, notificationOutcome } = await eventService.saveLocalEvent(event);
      setLocalEvents(next);
      notifyIfNotificationPermissionDenied(notificationOutcome);
    },
    [
      user,
      userCalendars,
      sharedData.ownerUserId,
      sharedData.sessionInstanceId,
      sharedData.sharedCalendars,
      handleRemoteEventChange,
      enqueueUpsert,
    ]
  );

  /**
   * [P0078 DATA-F014-001] 実装本体。committedの場合のみhandleRemoteEventChangeで
   * ローカルキャッシュへ反映し、saveEventの共有分岐と同じく通知の再予約
   * （scheduleSharedEventNotification + notifyIfNotificationPermissionDenied）も行う
   * ——これにより「開始時刻・通知設定を編集した場合は通知も再予約される」という
   * 既存の（saveEvent経由の）契約をこの専用経路でも維持する。
   */
  const saveSharedNormalEventWithVersionCheck = useCallback(
    async (
      event: NormalEvent,
      expectedUpdatedAt: string,
      identity: SharedMutationIdentity
    ): Promise<NormalEventCasOutcome> => {
      assertCurrentSharedMutationIdentity(identity);
      // [P0080 AUTH-F013-F017-001] 同一の論理attempt（RPC本体+輸送層failure後の再照会read）で
      // 同じauth snapshotを使い回す（正本§2:「同じattempt内でトークンを差し替えない」）。
      const auth = await captureSharedMutationAuthSnapshot(identity);
      const finalizeCommitted = async (updatedAt: string): Promise<NormalEventCasOutcome> => {
        const committedEvent: NormalEvent = { ...event, updatedAt };
        handleRemoteEventChange(committedEvent, identity.userId, identity.sessionInstanceId);
        const notifOutcome = await scheduleSharedEventNotification(
          committedEvent,
          identity.userId,
          identity.sessionInstanceId
        );
        await notifyIfNotificationPermissionDenied(notifOutcome);
        return "committed";
      };
      try {
        const rpcOutcome = await updateSharedNormalEventWithVersionCheck(event, expectedUpdatedAt, auth);
        assertCurrentSharedMutationIdentity(identity);
        if (rpcOutcome.outcome === "committed") {
          return await finalizeCommitted(rpcOutcome.updatedAt);
        }
        return rpcOutcome.outcome;
      } catch (e) {
        // stale化（assertCurrentSharedMutationIdentity起因かどうかに関わらず、現在identityと
        // 一致しなくなっていれば）は、他のsaveEvent等と同じ既知のメッセージで統一して投げ、
        // 呼び出し元のisStaleMutationErrorが確実に検知できるようにする。
        if (!isCurrentSharedMutationIdentity(identity)) {
          throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
        }
        void e;
        // それ以外（ネットワーク断等の輸送層failure）は再照会で解消を試みる。
        const reconciled = await reconcileNormalEventCasAfterTransportLoss(event, expectedUpdatedAt, auth);
        if (!isCurrentSharedMutationIdentity(identity)) {
          throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
        }
        if (reconciled.resolved === "committed") {
          return await finalizeCommitted(reconciled.updatedAt);
        }
        return reconciled.resolved;
      }
    },
    [handleRemoteEventChange]
  );

  const saveEventsBulk = useCallback(
    async (events: AppEvent[]): Promise<BulkSaveResult> => {
      if (events.length === 0) return { successCount: 0, failureCount: 0 };
      const baseCalendarId = events[0].calendarId;
      // REVISE対応（第5ラウンド、P1-3）: 以前はevents[0]のcalendarIdだけで保存先を
      // 判定し、残りの予定を検証していなかった。呼び出し元の不具合等で配列に異なる
      // calendarIdの予定が混在した場合、後続の予定が誤った保存先（本来ローカルの予定が
      // 共有APIへ送信される、逆に共有の予定が端末Storageへ保存される等）へ送られうる。
      // 公開関数の入口で全件のcalendarIdが一致することを検証し、1件でも異なれば
      // 副作用（楽観更新・Storage・Supabase・通知・同期キュー）に一切触れる前に
      // 例外で停止する（UIが常に同一カレンダーの配列を渡すという前提だけに依存しない）。
      if (events.some((e) => e.calendarId !== baseCalendarId)) {
        throw new Error("一括保存対象の予定が複数のカレンダーにまたがっているため、保存できません");
      }
      const classification = classifyCalendarOwnership(
        baseCalendarId,
        userCalendars,
        sharedData.sharedCalendars
      );
      if (classification === "unknown") {
        throw new Error("この予定の保存先カレンダーを特定できないため、保存できません");
      }
      if (classification === "shared") {
        if (!user || typeof sharedData.ownerUserId !== "string") {
          throw new Error("共有予定の保存にはログインが必要です");
        }
        assertSessionReady(sharedData.sessionInstanceId);
        const ownerUserId = sharedData.ownerUserId;
        const sessionInstanceId = sharedData.sessionInstanceId;
        // REVISE対応（第8ラウンド、P1-5）: saveEventと同じ理由でSharedMutationIdentityを使う。
        const identity: SharedMutationIdentity = { userId: ownerUserId, sessionInstanceId };
        assertCurrentSharedMutationIdentity(identity);
        events.forEach((event) => handleRemoteEventChange(event, ownerUserId, sessionInstanceId));
        // [P0080 AUTH-F013-F017-001] 実際のfetch送信直前にauth snapshotを1回だけ捕捉する。
        const auth = await captureSharedMutationAuthSnapshot(identity);
        // upsertSharedEventsBulkは1回のSQL文のため全件成功/全件失敗のいずれかにしかならない
        // （sharedEventsService.tsのコメント参照）。全件成功した場合のみこの端末の通知を
        // sharedNotificationCoordinator経由でまとめて予約する（Stage H-6: 共有一括作成・
        // 共有繰り返し編集following/allの既知ギャップ解消）。
        const { result, queueOutcome } = await eventService.saveSharedEventsBulk(events, {
          auth,
          enqueueUpsert,
        });
        if (result.failureCount === 0) {
          const outcome = await scheduleSharedEventNotifications(events, ownerUserId, sessionInstanceId);
          notifyIfNotificationPermissionDenied(outcome);
          return result;
        }
        // REVISE対応（第6ラウンド、P1-1）: failureCountの内訳（enqueuedCount/
        // discardedStaleCount）を呼び出し元へそのまま伝える。以前はfailureCountの
        // 存在だけを見て「いずれ再送される」と一律に案内していたが、identity変化により
        // 一部（または全部）が実際には破棄されている場合がある。
        return {
          ...result,
          enqueuedCount: queueOutcome.enqueuedCount,
          discardedStaleCount: queueOutcome.discardedStaleCount,
        };
      }
      // classification === "local"（一括作成・繰り返し編集のfollowing/allはこの関数を経由する）。
      // 通知予約の一部失敗は一括保存結果に影響させない（戻り値も使わないため、
      // 下のreturnは常に保存結果のみを表す）。
      const { events: next, notificationOutcome } = await eventService.saveLocalEventsBulk(
        events
      );
      setLocalEvents(next);
      notifyIfNotificationPermissionDenied(notificationOutcome);
      return { successCount: events.length, failureCount: 0 };
    },
    [
      user,
      userCalendars,
      sharedData.ownerUserId,
      sharedData.sessionInstanceId,
      sharedData.sharedCalendars,
      handleRemoteEventChange,
      enqueueUpsert,
    ]
  );

  const events = useMemo(
    () => [...localEvents, ...sharedData.remoteEvents],
    [localEvents, sharedData.remoteEvents]
  );

  const removeEvent = useCallback(
    async (id: string, calendarId: string) => {
      // REVISE対応（第3ラウンド、P1-4）: 以前は「idがsharedData.remoteEventsに現在
      // 含まれているか」だけで共有/ローカルを判定していた。remoteEventsは取得タイミングに
      // 依存する不完全な signal のため、正当な共有予定でも一時的にここへ含まれていない
      // 場合（取得未完了・Realtime反映の遅延等）があり、その場合は下のローカル削除
      // （実体が無ければ実質no-op）へ静かにフォールバックしてしまっていた
      // ——サーバー側の共有予定は削除されないまま、ユーザーには失敗の兆候が一切見えない。
      // 呼び出し元（画面）が必ず保持しているcalendarIdを引数として受け取り、
      // classifyCalendarOwnershipで確定的に判定する。
      const classification = classifyCalendarOwnership(
        calendarId,
        userCalendars,
        sharedData.sharedCalendars
      );
      if (classification === "unknown") {
        throw new Error("この予定の削除元カレンダーを特定できないため、削除できません");
      }
      if (classification === "shared") {
        if (typeof sharedData.ownerUserId !== "string") {
          throw new Error("共有予定の削除にはログインが必要です");
        }
        assertSessionReady(sharedData.sessionInstanceId);
        const ownerUserId = sharedData.ownerUserId;
        const sessionInstanceId = sharedData.sessionInstanceId;
        // REVISE対応（第8ラウンド、P1-5）: 開始前チェックに加え、通知取消
        // （cancelSharedEventNotification、内部でawaitを含む）とeventService.removeSharedEvent
        // （実際のSupabase削除/オフラインキュー投入）の間にもう一度確認する。runCurrentSharedMutation
        // により、この関数全体が同一のSharedMutationIdentity契約を通る。
        const identity: SharedMutationIdentity = { userId: ownerUserId, sessionInstanceId };
        // [P0080 F015] 削除が確実にブロックされていたことが後で判明した場合に、楽観的に
        // 消したローカル状態・通知を復旧できるよう、削除前のイベント実体を控えておく
        // （events自体はこのフック本体より後ろで定義されるが、useCallbackの実行時点では
        // 既に初期化済みのためクロージャとして参照できる）。
        const eventSnapshot = events.find((e) => e.id === id) ?? null;
        return runCurrentSharedMutation(identity, async (assertCurrent) => {
          // [P0082 ROBUST-F015-001] auth捕捉を楽観的な削除UI/通知取消より前に行う
          // （正本§2 Capture ordering）。ここで失敗すれば楽観的な変更はまだ一切
          // 発生していないため、復元は不要（pre-dispatchのidentity不一致はrunner自身の
          // 開始前チェックか、この捕捉自体の内部チェックのいずれかで例外化する）。
          const auth = await captureSharedMutationAuthSnapshot(identity);
          assertCurrent();

          handleRemoteEventDelete(id, ownerUserId, sessionInstanceId);

          // [P0082 ROBUST-F015-001] 「リモート削除が確定した」または「削除意図が確実に
          // オフラインキューへ永続化された」以外のあらゆる結果で、楽観的に消したイベント・
          // 通知を復元する。identityが既に切り替わっている場合は復元しない
          // （この画面インスタンス自体が破棄される想定のため——既存のidentity-remount
          // パターンにより、sharedData.remoteEventsは切替時に既にクリアされる。古い
          // identityの下で復元しても意味を持たない、というdefinite-failure分岐の
          // 既存の規律をそのまま踏襲する）。
          const restoreOptimisticDeleteIfStillCurrent = async () => {
            if (!isCurrentSharedMutationIdentity(identity) || !eventSnapshot) return;
            handleRemoteEventChange(eventSnapshot, ownerUserId, sessionInstanceId);
            // [P0088 ROBUST-F015-005] ここでのスケジュール再試行が例外を投げる（またはblocked
            // を返す）ことがあっても、直前のhandleRemoteEventChangeでイベントデータ自体は
            // 既に committed React state（sharedData.remoteEvents）へ復元済みである。この状態
            // 変化により、下方の唯一のreconcile effect（1449行目以降、reconcileRequestCounter・
            // sharedData.remoteEventsを依存配列に持つ）が再実行され、`reconcileSharedNotifications`
            // が差分ベースで通知の再構築を試みる（notificationService.reconcileNotificationsInternal
            // は登録対象にあってOS/対応表に無い通知を検出して再予約する——冪等・diff-based）。
            // barrier解除時（subscribeToSharedNotificationBarrierRelease）・AppState「active」
            // 復帰時（reconcileRequestCounter++）のいずれでもこの単一effectが再実行されるため、
            // ここでの一時的な失敗は自己修復される。この関数自身はこの一時的な失敗を握りつぶし、
            // 例外を外へ伝播させない（呼び出し元の catch ブロックがUNCONFIRMED_MESSAGEを
            // 投げる既存の意図を、ここでの再スケジュール失敗によって「別のエラー形状」で
            // 上書きしてしまわないようにするため）。
            try {
              const outcome = await scheduleSharedEventNotification(
                eventSnapshot,
                ownerUserId,
                sessionInstanceId
              );
              notifyIfNotificationPermissionDenied(outcome);
            } catch (e) {
              if (__DEV__) {
                console.warn(
                  "[AppDataContext] ロールバック時の通知再スケジュールに失敗しました（イベントデータ自体は復元済み。barrier解除/AppState復帰時のreconcileで自動的に再試行されます）",
                  e
                );
              }
            }
          };

          let removeResult:
            | "deleted"
            | "enqueued"
            | "discarded-stale"
            | "stale-cleanup-pending"
            | "definite-failure";
          try {
            // この端末のUIからは既に削除済みとして見えるため、Supabase側の削除が成功したか
            // オフラインキューへ積まれたかに関わらず、この端末の通知は取り消す
            // （成功後にしか取り消さないと、キュー再送が完了するまで消えたはずの予定の通知が
            // 残ってしまう）。sharedNotificationCoordinator経由で行う。
            const cancelResult = await cancelSharedEventNotification(id, ownerUserId, sessionInstanceId);
            assertCurrent();
            if (cancelResult === SHARED_NOTIFICATION_BARRIER_BLOCKED) {
              // [P0088 ROBUST-F015-004] 通知取消がセキュリティバリアでblockされ、実際には
              // 何も取り消されていない（古い通知が残っている可能性がある）。blockedを
              // successとして扱わず、remote一括削除・キュー投入のいずれへも進まない
              // （conservative——正本§4「Conservative preferred behavior」）。以下のcatch節が
              // 既存のrestore + UNCONFIRMED_MESSAGE経路を担う（同じ経路を再利用するだけで、
              // 新しいエラー文言は追加しない）。
              throw new Error(SHARED_EVENT_DELETE_UNCONFIRMED_MESSAGE);
            }
            removeResult = await eventService.removeSharedEvent(id, calendarId, {
              enqueueDelete,
              auth,
            });
          } catch (e) {
            if (e instanceof Error && e.message === STALE_SHARED_MUTATION_IDENTITY_MESSAGE) {
              // assertCurrent()自身が投げた、通常のidentity切替検知。既存の規約通り
              // 復元は試みず、そのまま伝播させる（呼び出し元はisStaleMutationErrorで
              // 検知しAlertを出さず静かに終了する——この画面インスタンスは破棄される想定）。
              throw e;
            }
            // [P0082 ROBUST-F015-001] 想定していない例外（enqueueDelete自体のAsyncStorage
            // 書込み失敗等、queue storage failure）。durable delete authorityが一切
            // 確認できていないため、復元してから「結果を確認できなかった」ことを表す
            // 専用のメッセージを投げる（"削除されなかった"ではなく"確認できなかった"を
            // 伝える——正本§2「result could not be confirmed」）。
            await restoreOptimisticDeleteIfStillCurrent();
            throw new Error(SHARED_EVENT_DELETE_UNCONFIRMED_MESSAGE);
          }

          if (removeResult === "deleted" || removeResult === "enqueued") {
            // remote削除が確定した、またはoffline同期キューへ確実に永続化できた
            // （durable owner-bound delete intentが確認済み）——ローカル削除が
            // authoritativeとして確定してよい、唯一の2状態。
            return;
          }
          // discarded-stale / stale-cleanup-pending / definite-failure:
          // いずれも「確実な削除」でも「確実な永続化キュー投入」でもない。復元してから
          // それぞれ区別できる例外を投げる。
          await restoreOptimisticDeleteIfStillCurrent();
          if (removeResult === "definite-failure") {
            // [P0080 F015] RLSにより削除が確実にブロックされたことが確認できた
            // （例: 削除実行までの間にeditor権限を喪失した）。
            throw new Error(SHARED_EVENT_DELETE_BLOCKED_MESSAGE);
          }
          // discarded-stale / stale-cleanup-pending: identityが変化しenqueueDelete自体が
          // 保存を行わなかった、または保存できたが補償削除に失敗し後始末が保留中。
          // いずれも「削除されたかどうか確認できない」不明な状態として扱う。
          throw new Error(SHARED_EVENT_DELETE_UNCONFIRMED_MESSAGE);
        });
      }
      // classification === "local"
      const next = await eventService.removeLocalEvent(id);
      setLocalEvents(next);
      await cancelNotification(id);
    },
    [
      userCalendars,
      sharedData.sharedCalendars,
      sharedData.ownerUserId,
      sharedData.sessionInstanceId,
      handleRemoteEventDelete,
      handleRemoteEventChange,
      enqueueDelete,
      events,
    ]
  );

  /**
   * P0015 Batch1.2、P1-1（残存ギャップ対応）: 第2引数ownerIdentityOverrideは、
   * createSharedCalendar/acceptPendingInvite・app/invite/[token].tsxのように「共有化・
   * 参加が完了した直後の、そのカレンダー自身」に対してmarkCalendarVisibleを呼ぶ場合に使う。
   * これらの呼び出し元は、この関数を呼び出す時点で既に検証済みの自分自身のidentityを
   * 持っているが、markCalendarVisible自身の自動判定は、呼び出し元のクロージャが捕捉した
   * （refreshShared()のdispatchより前の）古いsharedData.sharedCalendars/userCalendars
   * スナップショットを参照するため、「今回の操作で初めて確定したカレンダー」を構造的に
   * 判定できない（クロージャは実行中に自動更新されない）。呼び出し元が確実なidentityを
   * 明示的に渡せる抜け道を用意する。
   *
   * P0018 Batch1.5セクション9: 第2引数はtri-stateに拡張した。
   * - 省略（undefined）: 従来どおりclassifyCalendarOwnershipによる自動判定を使う。
   * - SharedMutationIdentity: そのidentityをowner-boundとして使う（既存契約）。
   * - null: 「このIDは確実にlocalである」という明示指定（自動判定を行わない）。
   *   addUserCalendar直後の呼び出しのように、setUserCalendars()の状態反映が
   *   まだ効いていない古いuserCalendarsクロージャの下でmarkCalendarVisibleを呼ぶと、
   *   自動判定が新規作成直後のIDを見つけられず誤ってunknown（fail closed）と
   *   判定してしまうため、このケース専用の明示的な抜け道として追加した。
   *
   * [P0096 ROBUST-F018-F020-004] この関数の全呼び出し元（addUserCalendar/
   * createSharedCalendar/acceptPendingInvite/app/invite/[token].tsx）は例外なく
   * 「主操作（ローカル作成・共有作成・招待受諾）が既にdurableに確定した後」の副次的な
   * 自動表示のためだけにこの関数を呼ぶ。この自動表示（表示設定への反映）が失敗しても、
   * 既に確定した主操作そのものを失敗として報告してはならない
   * （ユーザーに再作成・再受諾を促してはいけない——実体は既に作られている）。そのため
   * commitOwnerBoundLocalPreferenceImplへは常にpropagateOwnerBoundFailure=falseを渡し、
   * 保存失敗・pending journal未解決のいずれでも例外を投げずbest-effortでno-opする
   * （favorite/last-used同様のCategory C的scope。identity stale時の安全性
   * ——別ownerへ書き込まない・repairする——は従来どおりpropagateの値に関係なく機能する）。
   */
  const markCalendarVisible = useCallback(
    async (calendarId: string, ownerIdentityOverride?: SharedMutationIdentity | null) => {
      let ownerIdentity: SharedMutationIdentity | null;
      if (ownerIdentityOverride !== undefined) {
        ownerIdentity = ownerIdentityOverride;
      } else {
        const classification = classifyCalendarOwnership(calendarId, userCalendars, sharedData.sharedCalendars);
        if (classification === "unknown") {
          throw new Error("calendar_ownership_unknown");
        }
        if (classification === "shared") {
          if (typeof sharedData.ownerUserId !== "string" || sharedData.sessionInstanceId === null) {
            throw new Error("calendar_ownership_unknown");
          }
          ownerIdentity = { userId: sharedData.ownerUserId, sessionInstanceId: sharedData.sessionInstanceId };
        } else {
          ownerIdentity = null;
        }
      }
      // [P0094 CORRECT-F019-001] 既に表示中かどうかの判定・5個上限の判定・次の値の計算を
      // すべて呼び出し時点のoverlaySettingsクロージャではなく、直列化された時点の最新値
      // （overlaySettingsRef.current）から行う。P0092 QA-F020: 新規マイカレンダー作成・
      // 共有カレンダー作成・招待受諾による自動表示も、overlay.tsx/CalendarVisibilityChips.tsx/
      // calendars.tsxの手動トグルと同じtoggleCalendarVisibility（マイ＋共有合計5個までの
      // 同時表示上限）を必ず経由させる。上限に達している場合はカレンダー本体の作成・参加
      // 自体は成功させたまま、自動表示だけを静かにスキップする
      // （新しいUI文言・Alertは追加しない。ユーザーは後で手動でONにできる）。
      await commitOwnerBoundLocalPreferenceImpl<OverlaySettings>(
        "overlaySettings",
        ownerIdentity,
        () => {
          const latest = overlaySettingsRef.current;
          if (latest.visibleCalendarIds.includes(calendarId)) {
            return { action: "skip" };
          }
          const toggleResult = toggleCalendarVisibility(latest.visibleCalendarIds, calendarId);
          if (toggleResult.status === "limitReached") {
            return { action: "skip" };
          }
          return {
            action: "commit",
            previousValue: latest,
            nextValue: { ...latest, visibleCalendarIds: toggleResult.visibleCalendarIds },
          };
        },
        saveOverlaySettings,
        saveOverlaySettings,
        (value) => {
          overlaySettingsRef.current = value;
          setOverlaySettings(value);
        },
        false
      );
    },
    [userCalendars, sharedData.sharedCalendars, sharedData.ownerUserId, sharedData.sessionInstanceId]
  );

  /**
   * [P0094 CORRECT-F019-001] 手動UIトグル（app/calendars.tsx, app/overlay.tsx,
   * CalendarVisibilityChips.tsx）専用の、intentベースの表示切替。呼び出し元は
   * toggleCalendarVisibilityを事前に自前で計算してから絶対値のvisibleCalendarIdsを
   * 積むのではなく、この関数へcalendarIdだけを渡す。直列化された時点の最新値から
   * トグル結果を導出するため、連続した2回の切替が互いを上書きしない
   * （markCalendarVisible定義のdoc冒頭・commitOwnerBoundLocalPreferenceImpl定義のdoc参照）。
   * 戻り値は既存のtoggleCalendarVisibility/ToggleVisibilityResultと同じ形にし、呼び出し元は
   * 既存のlimitReachedアラート文言をそのまま流用する（新しい文言は追加しない）。
   */
  const toggleCalendarVisibilityIntent = useCallback(
    async (calendarId: string): Promise<ToggleVisibilityResult> => {
      const classification = classifyCalendarOwnership(calendarId, userCalendars, sharedData.sharedCalendars);
      if (classification === "unknown") {
        throw new Error("calendar_ownership_unknown");
      }
      let ownerIdentity: SharedMutationIdentity | null;
      if (classification === "shared") {
        if (typeof sharedData.ownerUserId !== "string" || sharedData.sessionInstanceId === null) {
          throw new Error("calendar_ownership_unknown");
        }
        ownerIdentity = { userId: sharedData.ownerUserId, sessionInstanceId: sharedData.sessionInstanceId };
      } else {
        ownerIdentity = null;
      }
      let limitReached = false;
      const outcome = await commitOwnerBoundLocalPreferenceImpl<OverlaySettings>(
        "overlaySettings",
        ownerIdentity,
        () => {
          const latest = overlaySettingsRef.current;
          const toggleResult = toggleCalendarVisibility(latest.visibleCalendarIds, calendarId);
          if (toggleResult.status === "limitReached") {
            limitReached = true;
            return { action: "skip" };
          }
          return {
            action: "commit",
            previousValue: latest,
            nextValue: { ...latest, visibleCalendarIds: toggleResult.visibleCalendarIds },
          };
        },
        saveOverlaySettings,
        saveOverlaySettings,
        (value) => {
          overlaySettingsRef.current = value;
          setOverlaySettings(value);
        },
        true
      );
      if (limitReached) {
        return { status: "limitReached" };
      }
      // [P0104 CORRECT-F019-007] stale中断された手動操作を{status:"applied"}として
      // 返さない（従来はここが無条件appliedだったため、意図的に中断・修復された操作が
      // 「適用済み」として画面へ報告されていた）。既存のcatch経路（既存Alert文言）へ変換する。
      throwIfStaleAborted(outcome);
      return { status: "applied", visibleCalendarIds: overlaySettingsRef.current.visibleCalendarIds };
    },
    [userCalendars, sharedData.sharedCalendars, sharedData.ownerUserId, sharedData.sessionInstanceId]
  );

  /**
   * [P0096 CORRECT-F019-002] app/overlay.tsxの「通常の予定」表示トグル専用intent。
   * showNormalEvents/showTasksはvisibleCalendarIds（＝カレンダーの所有権）に一切触れない
   * ため、変更対象IDが無ければownerIdentity: nullとする既存の挙動と
   * 同じくCategory C的scopeとして常にownerIdentity: nullで直列化する。手動UIトグルのため
   * 既存のtoggleCalendarVisibilityIntent同様、失敗はpropagateOwnerBoundFailure=trueで
   * 呼び出し元へ伝える（新しいUI文言は追加しない——既存のcatchハンドラのままでよい）。
   */
  const toggleShowNormalEventsIntent = useCallback(async () => {
    // [P0104 CORRECT-F019-007] 手動操作のためstale中断を成功として解決しない
    // （throwIfStaleAborted→既存catch経路。confirmed-applied ack喪失は成功として解決される）。
    throwIfStaleAborted(
      await commitOwnerBoundLocalPreferenceImpl<OverlaySettings>(
        "overlaySettings",
        null,
        () => {
          const latest = overlaySettingsRef.current;
          return {
            action: "commit",
            previousValue: latest,
            nextValue: { ...latest, showNormalEvents: !latest.showNormalEvents },
          };
        },
        saveOverlaySettings,
        saveOverlaySettings,
        (value) => {
          overlaySettingsRef.current = value;
          setOverlaySettings(value);
        },
        true
      )
    );
  }, []);

  /** [P0096 CORRECT-F019-002] app/overlay.tsxの「集中タスク」表示トグル専用intent。設計理由はtoggleShowNormalEventsIntent参照。 */
  const toggleShowTasksIntent = useCallback(async () => {
    // [P0104 CORRECT-F019-007] 設計理由はtoggleShowNormalEventsIntent参照。
    throwIfStaleAborted(
      await commitOwnerBoundLocalPreferenceImpl<OverlaySettings>(
        "overlaySettings",
        null,
        () => {
          const latest = overlaySettingsRef.current;
          return {
            action: "commit",
            previousValue: latest,
            nextValue: { ...latest, showTasks: !latest.showTasks },
          };
        },
        saveOverlaySettings,
        saveOverlaySettings,
        (value) => {
          overlaySettingsRef.current = value;
          setOverlaySettings(value);
        },
        true
      )
    );
  }, []);

  /**
   * [P0096 CORRECT-F019-002] app/calendars.tsxの表示モード切替専用intent。純粋関数
   * applyEventDisplayMode（既存、無変更）をoverlaySettingsRef.currentへ適用するだけで、
   * この関数もshowNormalEvents/showTasksしか変更しないためownerIdentity: nullで扱う
   * （設計理由はtoggleShowNormalEventsIntent参照）。
   */
  const setEventDisplayModeIntent = useCallback(async (mode: EventDisplayMode) => {
    // [P0104 CORRECT-F019-007] 設計理由はtoggleShowNormalEventsIntent参照。
    throwIfStaleAborted(
      await commitOwnerBoundLocalPreferenceImpl<OverlaySettings>(
        "overlaySettings",
        null,
        () => {
          const latest = overlaySettingsRef.current;
          return {
            action: "commit",
            previousValue: latest,
            nextValue: applyEventDisplayMode(latest, mode),
          };
        },
        saveOverlaySettings,
        saveOverlaySettings,
        (value) => {
          overlaySettingsRef.current = value;
          setOverlaySettings(value);
        },
        true
      )
    );
  }, []);

  /**
   * [P0096 CORRECT-F019-002] SharedCalendarActionSheet.tsxの「このカレンダーだけ表示」
   * 専用intent。toggleCalendarVisibilityIntentと同じownership分類ロジック
   * （computeChangedCalendarIds＋classifyCalendarOwnershipによる変更対象IDのfail-closed
   * 判定）を、呼び出し元のReact state closure（userCalendars/sharedData.sharedCalendars/
   * overlaySettings）ではなく、呼び出し時点で最新のref値
   * （userCalendarsRef.current/sharedDataRef.current/overlaySettingsRef.current）から行う。
   * 次の値そのもの（visibleCalendarIds: [calendarId]）はderiveNextValue内部で改めて
   * overlaySettingsRef.currentから合成するため、showNormalEvents/showTasksなど無関係な
   * フィールドは直列化キューを通過する間に確定した最新値がそのまま保たれる。
   *
   * [P0098 SEC-F019-003] 以前はcomputeChangedCalendarIdsが返す「変更対象ID（対称差分）」
   * だけをownership判定していた。show-onlyの対象calendarId自身が既に表示ON中だった場合
   * （例: visible=[main, shared-S]でtarget=shared-S）、対称差分には「表示OFFになるID
   * （main）」しか現れず、既に表示中で変化しないshared-S自身は差分に含まれない。この結果、
   * 差分の全IDがlocal分類ならownerIdentity=nullのまま共有カレンダーの状態を書き込んでしまい、
   * A→B切替時のstale write防御（isCurrentSharedMutationIdentity）を経由しない経路が
   * 生まれていた。target calendarId自身のownershipは、差分に現れるかどうかに関わらず
   * 必ず単独でも判定に含める（対称差分の判定と合わせて評価する）。
   */
  const showOnlyCalendarIntent = useCallback(async (calendarId: string) => {
    const latestUserCalendars = userCalendarsRef.current;
    const latestSharedData = sharedDataRef.current;
    const targetClassification = classifyCalendarOwnership(
      calendarId,
      latestUserCalendars,
      latestSharedData.sharedCalendars
    );
    const changedIds = computeChangedCalendarIds(
      overlaySettingsRef.current.visibleCalendarIds,
      [calendarId]
    );
    const changedClassifications = changedIds.map((cid) =>
      classifyCalendarOwnership(cid, latestUserCalendars, latestSharedData.sharedCalendars)
    );
    const classifications = [targetClassification, ...changedClassifications];
    if (classifications.some((c) => c === "unknown")) {
      throw new Error("calendar_ownership_unknown");
    }
    let ownerIdentity: SharedMutationIdentity | null = null;
    if (classifications.some((c) => c === "shared")) {
      if (typeof latestSharedData.ownerUserId !== "string" || latestSharedData.sessionInstanceId === null) {
        throw new Error("calendar_ownership_unknown");
      }
      ownerIdentity = {
        userId: latestSharedData.ownerUserId,
        sessionInstanceId: latestSharedData.sessionInstanceId,
      };
    }
    // [P0104 CORRECT-F019-007] 手動操作のためstale中断を成功として解決しない
    // （設計理由はtoggleShowNormalEventsIntent参照）。
    throwIfStaleAborted(
      await commitOwnerBoundLocalPreferenceImpl<OverlaySettings>(
        "overlaySettings",
        ownerIdentity,
        () => {
          const latest = overlaySettingsRef.current;
          return {
            action: "commit",
            previousValue: latest,
            nextValue: { ...latest, visibleCalendarIds: [calendarId] },
          };
        },
        saveOverlaySettings,
        saveOverlaySettings,
        (value) => {
          overlaySettingsRef.current = value;
          setOverlaySettings(value);
        },
        true
      )
    );
  }, []);

  /**
   * [P0094 CORRECT-F020-001] visibleCalendarIdsに残った、既に存在しないカレンダーID
   * （ローカル削除・共有カレンダー削除・参加解除・招待失効等で消えたもの）を、ローカル一覧
   * （userCalendars）と共有一覧（sharedData.sharedCalendars）の両方が権威ある状態になった
   * 時点でだけ後始末する（重複IDの除去も併せて行う）。
   *
   * - ログインしていない場合（!user）は共有カレンダーが構造的に存在しえないため、常に
   *   権威があるとみなす（userCalendarsだけを基準にする）。
   * - ログインしている場合、直近のrefreshSharedが実際に成功した
   *   （sharedData.sharedLoadStatus === "succeeded"）ときだけ実行する。loadingShared中は
   *   もちろん、"failed"（直近の取得失敗でsharedCalendarsが古いままの可能性がある）や
   *   "idle"（まだ一度も取得していない）のときも一切間引かない
   *   （正当な共有カレンダーのIDを誤って消してしまうことを防ぐ）。
   * - 書込みはcommitOwnerBoundLocalPreferenceImplを経由し、現在のログイン識別情報
   *   （ログインしていなければnull）をownerIdentityとして渡す。既存の
   *   isCurrentSharedMutationIdentityチェックにより、書込み中にアカウントが切り替わった
   *   場合は自動的にno-op/repairされる（他のowner-bound書込みと同じ保証）。
   *
   * [P0096 CORRECT-F020-003] 上記のvalidIds算出は、このeffectがスケジュールされた時点の
   * レンダークロージャ（引数のuserCalendars/sharedData.sharedCalendars）からではなく、
   * 直列化されたderiveNextValue内部で、実行時点の最新の権威
   * （userCalendarsRef.current / sharedDataRef.current.sharedCalendars /
   * sharedDataRef.current.sharedLoadStatus）から改めて再計算する。理由:
   * commitOwnerBoundLocalPreferenceImplはowner-bound直列化キューを経由するため、
   * enqueueされてから実際にderiveNextValueが実行されるまでの間に、先行する別の
   * owner-bound操作の完了を待つ可能性がある。その待機中に新しいカレンダーがローカル
   * 作成されたり共有カレンダーがrefreshされたりしていた場合、スケジュール時点でstale
   * だった（存在しないと判定された）IDが実行時点では有効になっている可能性があり、
   * 古いvalidIdsのままderiveすると正当なカレンダーのvisibleCalendarIdsエントリを
   * 誤って間引いてしまう。
   *
   * また、実行時点でgetCurrentAuthIdentity()がスケジュール時点に捕捉したidentityと
   * 一致しない場合（アカウント切替等でowner/session/authorityが変化した場合）は、この
   * 実行を静かにskipする——このidentity変化は必ずuser/authSessionInstanceIdのdeps変化
   * として新しいeffect実行を誘発するため、正しいvalidIds・ownerIdentityでの後始末は
   * 次のeffect実行に委ねられる（古いidentity・古いrefスナップショットの組み合わせで
   * 誤ったvalidIdsを計算してしまう事故を防ぐ）。
   */
  useEffect(() => {
    if (initializationStatus !== "ready") return;
    const sharedMembershipAuthoritativeAtSchedule =
      !user || sharedData.sharedLoadStatus === "succeeded";
    if (!sharedMembershipAuthoritativeAtSchedule) return;

    const scheduledIdentity = getCurrentAuthIdentity();
    const scheduledForUserId = scheduledIdentity.userId;
    const scheduledForSessionInstanceId = scheduledIdentity.sessionInstanceId;

    // [P0094 CORRECT-F020-001, P0096 CORRECT-F020-003] 実際に間引く必要があるかどうかを、
    // 直列化キュー（commitOwnerBoundLocalPreferenceImpl・resolveExistingPendingJournalを
    // 含む）へ触れる前に安価に判定する（このeffect本体のクロージャ値による事前判定であり、
    // 古くても安全側にしか働かない——プレチェックがfalseなら何もしないだけで、
    // プレチェックがtrueならcommit経路の中でrefベースの最新値から正しく再計算される）。
    const precheckValidIds = new Set<string>([
      ...userCalendars.map((c) => c.id),
      ...sharedData.sharedCalendars.map((s) => s.calendar.id),
    ]);
    const currentIds = overlaySettingsRef.current.visibleCalendarIds;
    const precheckCleaned = dedupePreserveOrder(currentIds).filter((id) => precheckValidIds.has(id));
    const precheckUnchanged =
      precheckCleaned.length === currentIds.length &&
      precheckCleaned.every((id, i) => id === currentIds[i]);
    if (precheckUnchanged) return;

    const ownerIdentity: SharedMutationIdentity | null =
      user && authSessionInstanceId !== null
        ? { userId: user.id, sessionInstanceId: authSessionInstanceId }
        : null;
    if (user && authSessionInstanceId === null) return;

    commitOwnerBoundLocalPreferenceImpl<OverlaySettings>(
      "overlaySettings",
      ownerIdentity,
      () => {
        const nowIdentity = getCurrentAuthIdentity();
        if (
          nowIdentity.userId !== scheduledForUserId ||
          nowIdentity.sessionInstanceId !== scheduledForSessionInstanceId
        ) {
          return { action: "skip" };
        }
        const sharedSnapshot = sharedDataRef.current;
        const sharedMembershipAuthoritativeNow =
          !scheduledForUserId || sharedSnapshot.sharedLoadStatus === "succeeded";
        if (!sharedMembershipAuthoritativeNow) {
          return { action: "skip" };
        }
        const validIdsNow = new Set<string>([
          ...userCalendarsRef.current.map((c) => c.id),
          ...sharedSnapshot.sharedCalendars.map((s) => s.calendar.id),
        ]);
        const latest = overlaySettingsRef.current;
        const cleaned = dedupePreserveOrder(latest.visibleCalendarIds).filter((id) =>
          validIdsNow.has(id)
        );
        const unchanged =
          cleaned.length === latest.visibleCalendarIds.length &&
          cleaned.every((id, i) => id === latest.visibleCalendarIds[i]);
        if (unchanged) {
          return { action: "skip" };
        }
        return {
          action: "commit",
          previousValue: latest,
          nextValue: { ...latest, visibleCalendarIds: cleaned },
        };
      },
      saveOverlaySettings,
      saveOverlaySettings,
      (value) => {
        overlaySettingsRef.current = value;
        setOverlaySettings(value);
      },
      false
    ).catch(() => {});
  }, [
    initializationStatus,
    userCalendars,
    sharedData.sharedCalendars,
    sharedData.sharedLoadStatus,
    user,
    authSessionInstanceId,
  ]);

  /**
   * [P0096 DATA-F018-003] addUserCalendar/updateUserCalendar/removeUserCalendarの本体
   * （storage書込み＋React state反映）はすべてenqueueLocalCalendarLifecycleOperationへ
   * enqueueし、直前にenqueueされた全操作の完了を待ってから実行する。重複ID判定・
   * 3/10上限判定は、enqueue時点のuserCalendarsクロージャではなく、直列化された実行時点の
   * userCalendarsRef.current（＝先行するすべての操作が反映し終えた後の最新値）に対して
   * 行う——これにより、2つの同時create呼び出しが互いのnextを上書きして片方のカレンダーを
   * 失う・重複IDチェックをすり抜ける・上限判定が古い件数のまま行われる、のいずれも防ぐ。
   */
  const addUserCalendar = useCallback(async (calendar: UserCalendar) => {
    // 単独修正(2026-08, FP-002): UIの事前チェック（NewCalendarModal）を回避して
    // この関数を直接呼んでも、上限・自分一人用IDの偽装を防ぐ最終防波堤。
    await enqueueLocalCalendarLifecycleOperation(async () => {
      const latest = userCalendarsRef.current;
      if (latest.some((c) => c.id === calendar.id)) {
        throw new Error("my_calendar_duplicate_id");
      }
      if (!canCreateMyCalendar(latest, isPremiumRef.current)) {
        throw new Error("my_calendar_limit_exceeded");
      }
      const next = [...latest, calendar];
      await saveUserCalendars(next);
      userCalendarsRef.current = next;
      setUserCalendars(next);
    });
    // [P0096 ROBUST-F018-F020-004] 新規作成したマイカレンダーは最初から「表示設定」に
    // 含めておく（既定でON）が、これは新規作成という主操作が既に確定した後の副次的・
    // best-effort操作である（markCalendarVisible自体がpropagateOwnerBoundFailure=false
    // のため例外を投げないが、念のため二重に握りつぶす）。このIDが確実にlocalであることは
    // 上の直列化操作で既に確定しているため、明示的にnull（＝local確定）を渡す。
    await markCalendarVisible(calendar.id, null).catch(() => {});
  }, [markCalendarVisible]);

  const updateUserCalendar = useCallback(async (calendar: UserCalendar) => {
    await enqueueLocalCalendarLifecycleOperation(async () => {
      const latest = userCalendarsRef.current;
      const next = latest.map((c) => (c.id === calendar.id ? calendar : c));
      await saveUserCalendars(next);
      userCalendarsRef.current = next;
      setUserCalendars(next);
    });
  }, []);

  const removeUserCalendar = useCallback(async (id: string) => {
    // [P0094 ROBUST-F018-002] 削除できない基本カレンダー（自分一人用）は、UI側
    // （CalendarActionSheet.tsx）で削除行自体を出していないだけで、この権威となる関数
    // 自体には歯止めが無かった。ここが最終防波堤——storage/React state/カバー画像削除/
    // 表示設定クリーンアップのいずれも一切行わず、新しいUI文言・エラーも追加しない
    // （既存の「何も起きない」契約のまま無条件でno-opにする）。
    if (id === BASE_CALENDAR_ID) {
      return;
    }
    let removedCoverImageUri: string | undefined;
    await enqueueLocalCalendarLifecycleOperation(async () => {
      const latest = userCalendarsRef.current;
      const removed = latest.find((c) => c.id === id);
      removedCoverImageUri = removed?.coverImageUri;
      const next = latest.filter((c) => c.id !== id);
      await saveUserCalendars(next);
      userCalendarsRef.current = next;
      setUserCalendars(next);
    });
    // [P0096] カレンダー削除本体（storage書込み＋React state反映）が直列化された操作の中で
    // 既に確定した"後"にだけ、カバー画像削除・表示設定クリーンアップを行う
    // （削除本体がまだcommitされていない段階でカバー画像を先に消してしまうと、
    // 万一削除本体側が失敗した場合に画像だけ失われた不整合な状態になりうるため）。
    // 端末内に保存したカバー画像ファイルも一緒に破棄する（存在しなくてもエラーにならない冪等操作）。
    // [P0120 Group D / D9 ROBUST-POSTPRIMARY-001-C13] ただし「存在しない」以外の実FS削除
    // エラーはlocalImageStorage.ts側でthrowされる。カレンダー削除本体は直前の直列化操作で
    // 既にdurableに確定しているため、この後始末の失敗を削除の失敗として再定義してはならない
    // （呼び出し元 CalendarActionSheet.tsx / settings.tsx はcatchで「削除できませんでした」を
    // 表示する＝実際には削除済みなのに失敗と伝える偽の失敗になっていた。G-16と同型）。
    // 削除順序（durable削除の"後"にだけカバーを消す）・冪等性は変更しない。
    await runPostPrimaryStep("マイカレンダー削除後のカバー画像後始末", () =>
      deleteLocalCalendarCoverImage(removedCoverImageUri)
    );
    // 表示設定に残っていても実害はないが、掃除しておく（共有カレンダー削除時と同じ方針）。
    // P0017 Batch1.4、P1(セクション6): 以前はここでsaveOverlaySettings/setOverlaySettingsを
    // 直接呼び、owner-bound coordinatorを迂回していた（direct local writer）。他のoverlay
    // 書込みと同じcommitOwnerBoundLocalPreferenceImpl経由にすることで、未解決の
    // pending journal（別identityの操作分）を追い越して上書きしないようにする
    // （このIDは常にuserCalendars＝ローカル専用カレンダーのため、ownerIdentityは常にnull）。
    // P0018 Batch1.5セクション8: このcleanupは「カレンダー削除本体が既に成功した後の
    // 非本質的な後始末」であるため、既存の削除成功をfalse failureに見せないよう
    // propagateOwnerBoundFailure=falseへ変更した（best-effort。UI文言は変更しない）。
    // [P0094 CORRECT-F019-001] 直列化された時点の最新値からskip判定・次の値を導出する
    // （呼び出し前のoverlaySettingsクロージャによる事前判定はしない）。
    await commitOwnerBoundLocalPreferenceImpl<OverlaySettings>(
      "overlaySettings",
      null,
      () => {
        const latest = overlaySettingsRef.current;
        if (!latest.visibleCalendarIds.includes(id)) {
          return { action: "skip" };
        }
        return {
          action: "commit",
          previousValue: latest,
          nextValue: {
            ...latest,
            visibleCalendarIds: latest.visibleCalendarIds.filter((cid) => cid !== id),
          },
        };
      },
      saveOverlaySettings,
      saveOverlaySettings,
      (value) => {
        overlaySettingsRef.current = value;
        setOverlaySettings(value);
      },
      false
    );
  }, []);

  const toggleFavoriteCalendar = useCallback(
    async (calendarId: string) => {
      const classification = classifyCalendarOwnership(calendarId, userCalendars, sharedData.sharedCalendars);
      let ownerIdentity: SharedMutationIdentity | null;
      if (classification === "unknown") {
        // P0018セクション9: best-effort API（Category C）はunknownの場合、
        // 呼び出し元へ保存失敗を誤伝播させないためsilent no-opにするが、
        // Storage/stateへは絶対に書き込まない。
        return;
      }
      if (classification === "shared") {
        if (typeof sharedData.ownerUserId !== "string" || sharedData.sessionInstanceId === null) {
          return;
        }
        ownerIdentity = { userId: sharedData.ownerUserId, sessionInstanceId: sharedData.sessionInstanceId };
      } else {
        ownerIdentity = null;
      }
      // [P0094 CORRECT-F019-001] favoriteCalendarIdsRef.currentを直列化された時点の
      // 最新値として使い、トグル結果をそこから導出する（連続したtoggleFavoriteCalendar
      // 呼び出しが互いのtoggleを上書きしないようにするため）。
      await commitOwnerBoundLocalPreferenceImpl<string[]>(
        "favoriteCalendarIds",
        ownerIdentity,
        () => {
          const latest = favoriteCalendarIdsRef.current;
          const nextValue = latest.includes(calendarId)
            ? latest.filter((id) => id !== calendarId)
            : [...latest, calendarId];
          return { action: "commit", previousValue: latest, nextValue };
        },
        // P0018セクション7: main writeの成否をcommitOwnerBoundLocalPreferenceImpl内部の
        // fresh outcome判定に使うため、失敗を握りつぶすbest-effort版（saveFavoriteCalendarIds）
        // ではなく必ずstrict版を渡す（外部へのbest-effort契約はpropagateOwnerBoundFailure=false
        // が別途担保する）。
        saveFavoriteCalendarIdsStrict,
        saveFavoriteCalendarIdsStrict,
        (value) => {
          favoriteCalendarIdsRef.current = value;
          setFavoriteCalendarIds(value);
        },
        false
      );
    },
    [userCalendars, sharedData.sharedCalendars, sharedData.ownerUserId, sharedData.sessionInstanceId]
  );

  const recordLastUsedCalendar = useCallback(
    async (calendarId: string) => {
      const classification = classifyCalendarOwnership(calendarId, userCalendars, sharedData.sharedCalendars);
      let ownerIdentity: SharedMutationIdentity | null;
      if (classification === "unknown") {
        // P0018セクション9: 上のtoggleFavoriteCalendarと同じ理由でsilent no-op。
        return;
      }
      if (classification === "shared") {
        if (typeof sharedData.ownerUserId !== "string" || sharedData.sessionInstanceId === null) {
          return;
        }
        ownerIdentity = { userId: sharedData.ownerUserId, sessionInstanceId: sharedData.sessionInstanceId };
      } else {
        ownerIdentity = null;
      }
      // [P0102 CORRECT-F019-006] previousValue（pending transactionのrollback先）は
      // React closureのlastUsedCalendarIdではなく、直列化されたderive実行時点の
      // lastUsedCalendarIdRef.current（＝直前までのenqueue済み操作が反映し終えた
      // 最新のserialized authority）から導出する。closureを使うと、rapid連続呼び出し時に
      // op2のpreviousValueがop1適用前の古い値になり、op2のstale rollbackがop1の結果まで
      // 巻き戻してしまう（overlaySettings/favoriteのP0094 CORRECT-F019-001と同型）。
      await commitOwnerBoundLocalPreferenceImpl<string | null>(
        "lastUsedCalendarId",
        ownerIdentity,
        () => ({
          action: "commit",
          previousValue: lastUsedCalendarIdRef.current,
          nextValue: calendarId,
        }),
        // P0018セクション7: toggleFavoriteCalendarと同じ理由でstrict版を渡す。
        saveLastUsedCalendarIdStrict,
        saveLastUsedCalendarIdStrict,
        (value) => {
          lastUsedCalendarIdRef.current = value;
          setLastUsedCalendarId(value);
        },
        false
      );
    },
    [userCalendars, sharedData.sharedCalendars, sharedData.ownerUserId, sharedData.sessionInstanceId]
  );

  const createSharedCalendar = useCallback(
    async (name: string, color: string) => {
      if (!user) throw new Error("共有カレンダーの作成にはログインが必要です");
      // REVISE対応（追加確認: session_id欠落時のfail-closed）
      assertSessionReady(authSessionInstanceId);
      // REVISE対応（P2）: 操作開始時点の所有者identityを固定しておき、作成完了後に
      // 現在のidentityと突き合わせる（下記isStillCurrentOwner呼び出し）。
      const ownerUserId = user.id;
      const ownerSessionInstanceId = authSessionInstanceId;
      // REVISE対応（第7ラウンド、P1-3）: Supabase呼び出しを開始する前に、権威ある
      // authSessionIdentityStoreと照合する（従来の完了後チェックだけでは、開始時点で
      // 既に古いクロージャからの呼び出しだった場合を防げない）。
      // REVISE対応（第8ラウンド、P1-5）: SharedMutationIdentityを使う。
      // calendarService.createSharedCalendar自身もこのidentityを独立に検証する（P2）。
      const identity: SharedMutationIdentity = { userId: ownerUserId, sessionInstanceId: ownerSessionInstanceId };
      assertCurrentSharedMutationIdentity(identity);
      try {
        const calendar = await createSharedCalendarRequest(name, color, identity);
        // REVISE対応（P0014 Batch1.1、P1-2）: remote完了直後にも再確認する。以前はここで
        // staleになっていてもrefreshShared()（自身がstale時にsilent returnする）を
        // 呼んだあとそのまま正常returnしてしまい、呼び出し元（画面）が「作成成功」として
        // 扱ってしまう恐れがあった（実際には新しいidentity向けの一覧・表示設定への
        // 反映が一切行われていない）。
        assertCurrentSharedMutationIdentity(identity);
        await refreshShared();
        // REVISE対応（P0014 Batch1.1、P1-2）: refreshShared()後にも再確認する
        // （refreshShared自身のsilent-return契約はそのまま維持しつつ、この関数自身は
        // 「stale時に正常returnしない」契約へ揃える）。
        assertCurrentSharedMutationIdentity(identity);
        // 作成したカレンダーは最初から「表示するカレンダー」に含めておく。ただし、
        // 作成開始からこの時点までの間に別ユーザーへ切り替わっていた場合は、新しい
        // ユーザーのoverlaySettingsへ古い所有者のcalendarIdを書き込まないよう、
        // 完了時点で現在の所有者と一致する場合のみ行う。
        if (
          ownerSessionInstanceId !== null &&
          isStillCurrentOwner(ownerUserId, ownerSessionInstanceId)
        ) {
          // P0015 Batch1.2、P1-1（残存ギャップ対応）: identityを明示的に渡す（詳細は
          // markCalendarVisible定義のdoc参照）。
          await markCalendarVisible(calendar.id, identity);
          // REVISE対応（P0014 Batch1.1、P1-2）: markCalendarVisible後・正常return直前にも
          // 再確認する。
          assertCurrentSharedMutationIdentity(identity);
        }
      } catch (e) {
        // 単独修正(2026-08, FP-003): サーバー側の上限判定（0016）で拒否された場合等、
        // クライアントが把握している件数が古い可能性があるため、失敗時も一覧を
        // 再取得しておく（失敗したカレンダーをローカル状態へ足すことはない。
        // refreshShared自体の失敗は元のエラー表示を妨げないよう握りつぶす）。
        const originalError = e;
        await refreshShared().catch(() => {});
        // P0015 Batch1.2、P1: このbest-effort refreshShared待機中にidentityがstale化
        // した場合、元のremote createエラーではなくstale専用のエラーを優先してthrowする
        // （呼び出し元・画面が、実際には別ユーザーへ切り替わっただけなのに元のcreate失敗
        // Alertを表示してしまうのを防ぐ）。同一identityのままrefreshShared自体が失敗した
        // だけの場合は、この行は何もせず元のエラーがそのままthrowされる。
        assertCurrentSharedMutationIdentity(identity);
        throw originalError;
      }
    },
    [user, authSessionInstanceId, refreshShared, markCalendarVisible]
  );

  const updateSharedCalendar = useCallback(
    async (calendarId: string, updates: { name?: string; color?: string }) => {
      if (!user) throw new Error("共有カレンダーの更新にはログインが必要です");
      // REVISE対応（追加確認: session_id欠落時のfail-closed）
      assertSessionReady(authSessionInstanceId);
      // REVISE対応（第7ラウンド、P1-3）: Supabase呼び出しを開始する前に検証する。
      // REVISE対応（第8ラウンド、P1-5）: SharedMutationIdentityを使う。
      // calendarService.updateCalendar自身もこのidentityを独立に検証する（P2）。
      const identity: SharedMutationIdentity = { userId: user.id, sessionInstanceId: authSessionInstanceId };
      assertCurrentSharedMutationIdentity(identity);
      await updateCalendarRequest(calendarId, updates, identity);
      // REVISE対応（P0014 Batch1.1、P1-2）: remote完了直後にも再確認する。
      assertCurrentSharedMutationIdentity(identity);
      await refreshShared();
      // REVISE対応（P0014 Batch1.1、P1-2）: refreshShared()後・正常return直前にも再確認する。
      assertCurrentSharedMutationIdentity(identity);
    },
    [user, authSessionInstanceId, refreshShared]
  );

  const deleteSharedCalendar = useCallback(
    async (calendarId: string) => {
      if (!user) throw new Error("共有カレンダーの削除にはログインが必要です");
      // REVISE対応（追加確認: session_id欠落時のfail-closed）
      assertSessionReady(authSessionInstanceId);
      // REVISE対応（P2）: 操作開始時点の所有者identityを固定しておく。
      const ownerUserId = user.id;
      const ownerSessionInstanceId = authSessionInstanceId;
      // REVISE対応（第7ラウンド、P1-3）: Supabase呼び出しを開始する前に検証する。
      // REVISE対応（第8ラウンド、P1-5）: SharedMutationIdentityを使う。
      // calendarService.deleteCalendar自身もこのidentityを独立に検証する（P2）。
      const identity: SharedMutationIdentity = { userId: ownerUserId, sessionInstanceId: ownerSessionInstanceId };
      assertCurrentSharedMutationIdentity(identity);
      await deleteCalendarRequest(calendarId, identity);
      // REVISE対応（P0014 Batch1.1、P1-2）: remote完了直後にも再確認する。
      assertCurrentSharedMutationIdentity(identity);
      await refreshShared();
      // REVISE対応（P0014 Batch1.1、P1-2）: refreshShared()後にも再確認する
      // （以前はここでstaleになっていても正常returnしてしまい、呼び出し元が
      // 「削除成功」として扱ってしまう恐れがあった）。
      assertCurrentSharedMutationIdentity(identity);
      // 表示設定からの掃除は、削除完了時点でもまだ操作開始時点と同じ所有者である場合のみ
      // 行う（別ユーザーへ切り替わっていた場合、新しいユーザーのoverlaySettingsを
      // 誤って書き換えないため）。一致しない場合は掃除自体を新所有者のログイン時状態に
      // 委ねる（overlaySettingsに残っていても、対応する共有カレンダー自体は既に
      // sharedCalendarsから消えているため実害はない）。
      if (
        ownerUserId !== null &&
        ownerSessionInstanceId !== null &&
        isStillCurrentOwner(ownerUserId, ownerSessionInstanceId)
      ) {
        // P0015 Batch1.2、P1: この保存自体もowner-bound local preferenceヘルパーを経由させ、
        // 保存中に別ユーザーへ切り替わった場合はcommit（React state反映）を行わず、
        // 既に永続化済みの場合は書込み前の値へ書き戻す（他のoverlay書込みと同じ直列化
        // チェーンに乗せることで、書込み順序の安全性も共有する）。
        // [P0094 CORRECT-F019-001] 直列化された時点の最新値からskip判定・次の値を導出する。
        // [P0104 CORRECT-F019-007] このcall siteはpropagate=trueだが、戻り値のoutcomeは
        // 意図的に消費しない（throwIfStaleAbortedを呼ばない）: 主操作（remote削除）は
        // この時点で既にdurableに確定しており、副次的な表示設定掃除がstale中断されても
        // 削除自体を失敗として報告してはならない（P0096 ROBUST-F018-F020-004の
        // primary-outcome契約と同じ理由）。
        // [P0120 Group D / D3 ROBUST-POSTPRIMARY-001-C03 / G-02] P0104はstale中断だけを
        // 扱っており、**persist失敗のreject経路がそのまま呼び出し元へ伝播していた**
        // （preflight未解決・persistStrict失敗・repair失敗）。remote削除は既に確定済みなので、
        // 表示設定掃除の失敗も削除の失敗として再定義してはならない。
        // 吸収はこのcall siteだけで行い、commitOwnerBoundLocalPreferenceImpl内部の契約
        // （propagate=trueのpreflight fail・durable journalの保持）は一切変更しない
        // ——journalは残るため、次回のresolveExistingPendingJournalが冪等に解決する。
        await runPostPrimaryStep("共有カレンダー削除後の表示設定クリーンアップ", () =>
          commitOwnerBoundLocalPreferenceImpl<OverlaySettings>(
            "overlaySettings",
            { userId: ownerUserId, sessionInstanceId: ownerSessionInstanceId },
            () => {
              const latest = overlaySettingsRef.current;
              if (!latest.visibleCalendarIds.includes(calendarId)) {
                return { action: "skip" };
              }
              return {
                action: "commit",
                previousValue: latest,
                nextValue: {
                  ...latest,
                  visibleCalendarIds: latest.visibleCalendarIds.filter((cid) => cid !== calendarId),
                },
              };
            },
            saveOverlaySettings,
            saveOverlaySettings,
            (value) => {
              overlaySettingsRef.current = value;
              setOverlaySettings(value);
            },
            true
          ).then(() => undefined)
        );
      }
    },
    [user, authSessionInstanceId, refreshShared]
  );

  const acceptPendingInvite = useCallback(
    async (inviteId: string): Promise<AcceptInviteResult> => {
      // 失敗時はここで例外が呼び出し元へ伝播し、pendingInvitesには一切触れない
      // （カードを消さない・バッジ件数を減らさない、を自然に満たす）。
      const { ownerUserId, sessionInstanceId } = sharedData;
      if (typeof ownerUserId !== "string") {
        throw new Error("招待の受諾にはログインが必要です");
      }
      // REVISE対応（追加確認: session_id欠落時のfail-closed）
      assertSessionReady(sessionInstanceId);
      // REVISE対応（第7ラウンド、P1-3）: Supabase呼び出しを開始する前に検証する。
      // REVISE対応（第8ラウンド、P1-5）: SharedMutationIdentityを使う。
      // calendarService.acceptPendingInviteById自身もこのidentityを独立に検証する（P2）。
      const identity: SharedMutationIdentity = { userId: ownerUserId, sessionInstanceId };
      assertCurrentSharedMutationIdentity(identity);
      const result = await acceptPendingInviteById(inviteId, identity);
      // REVISE対応（P0014 Batch1.1、P1-2）: remote完了直後・INVITE_REMOVED dispatch前にも
      // 再確認する。INVITE_REMOVEDのreducer側自体は既にownerMatchesで安全（stale時は
      // no-op）だが、この関数自身が「stale時に正常returnしない」契約を満たすには
      // ここで打ち切る必要がある（呼び出し元がAcceptInviteResultを正常な結果として
      // 扱ってしまうのを防ぐ）。
      assertCurrentSharedMutationIdentity(identity);
      if (typeof ownerUserId === "string" && sessionInstanceId !== null) {
        dispatchSharedDataTracked({ type: "INVITE_REMOVED", ownerUserId, sessionInstanceId, inviteId });
      }
      // 既存のトークン招待受諾フロー（app/invite/[token].tsx）と全く同じ2関数を再利用し、
      // 参加中一覧・表示設定への反映ロジックを重複実装しない。refreshShared自身が
      // 呼び出し時点の最新の所有者情報を読むため、切替後に呼ばれても新所有者用に
      // 安全に動作する。
      await refreshShared();
      // REVISE対応（P0014 Batch1.1、P1-2）: refreshShared()後にも再確認する。
      assertCurrentSharedMutationIdentity(identity);
      // REVISE対応（P2）: markCalendarVisibleへのoverlaySettings書込みは、受諾開始時点
      // （上でownerUserId/sessionInstanceIdとして固定済み）の所有者が、受諾完了時点でも
      // まだ現在の所有者である場合のみ行う（切替後の窓で別ユーザーのoverlaySettingsへ
      // 古い所有者のcalendarIdが紛れ込むのを防ぐ）。
      if (
        typeof ownerUserId === "string" &&
        sessionInstanceId !== null &&
        isStillCurrentOwner(ownerUserId, sessionInstanceId)
      ) {
        // P0015 Batch1.2、P1-1（残存ギャップ対応）: identityを明示的に渡す（詳細は
        // markCalendarVisible定義のdoc参照）。
        await markCalendarVisible(result.calendarId, identity);
        // REVISE対応（P0014 Batch1.1、P1-2）: markCalendarVisible後・正常return直前にも
        // 再確認する。
        assertCurrentSharedMutationIdentity(identity);
      }
      return result;
    },
    [sharedData, refreshShared, markCalendarVisible, dispatchSharedDataTracked]
  );

  const declinePendingInvite = useCallback(
    async (inviteId: string): Promise<void> => {
      // 失敗時はここで例外が呼び出し元へ伝播し、pendingInvitesには一切触れない。
      const { ownerUserId, sessionInstanceId } = sharedData;
      if (typeof ownerUserId !== "string") {
        throw new Error("招待の辞退にはログインが必要です");
      }
      // REVISE対応（追加確認: session_id欠落時のfail-closed）
      assertSessionReady(sessionInstanceId);
      // REVISE対応（第7ラウンド、P1-3）: Supabase呼び出しを開始する前に検証する。
      // REVISE対応（第8ラウンド、P1-5）: SharedMutationIdentityを使う。
      // calendarService.declinePendingInvite自身もこのidentityを独立に検証する（P2）。
      const identity: SharedMutationIdentity = { userId: ownerUserId, sessionInstanceId };
      assertCurrentSharedMutationIdentity(identity);
      await declinePendingInviteRequest(inviteId, identity);
      // REVISE対応（P0014 Batch1.1、P1-2）: remote完了直後・INVITE_REMOVED dispatch前にも
      // 再確認する（acceptPendingInviteと同じ理由）。
      assertCurrentSharedMutationIdentity(identity);
      if (typeof ownerUserId === "string" && sessionInstanceId !== null) {
        dispatchSharedDataTracked({ type: "INVITE_REMOVED", ownerUserId, sessionInstanceId, inviteId });
      }
    },
    [sharedData, dispatchSharedDataTracked]
  );

  const updateRecurringEvents = useCallback(
    async (updatedBaseEvent: AppEvent, scope: RecurringEditScope): Promise<BulkSaveResult> => {
      if (scope === "single" || !updatedBaseEvent.recurringGroupId) {
        // 通常予定・単発編集は既存のsaveEventをそのまま使う（新しいロジックを増やさない）
        await saveEvent(updatedBaseEvent);
        return { successCount: 1, failureCount: 0 };
      }
      const targets = selectRecurringTargets(events, updatedBaseEvent, scope);
      if (targets.length <= 1) {
        await saveEvent(updatedBaseEvent);
        return { successCount: 1, failureCount: 0 };
      }
      const now = new Date().toISOString();
      // 伝播するのはタイトル・説明・開始/終了時刻・通知設定のみ。日付・calendarId・repeat等、
      // 各予定固有の項目はそれぞれの予定のまま変更しない。
      // [P0086 QA-F099] startTime/endTimeを伝播するだけでは、各siblingが元々持っていた
      // endDateが古いまま（siblingごとの元のstartTime/endTimeから導出された値）残ってしまう。
      // 例えば同日完結(endDate=undefined)だった予定を日またぎに編集すると、baseEvent自身は
      // 正しくendDateが設定されるが、following/all配下の他のsiblingは新しいstartTime/endTimeと
      // 矛盾したendDateのまま書込まれ、canonical writeバリデータ（isValidAppEvent）に
      // 拒否されてしまう。各siblingごとに、そのsibling自身のdateと今回伝播される
      // startTime/endTimeからresolveEndDateで改めてendDateを導出し直す
      // （app/event/new.tsx・app/event/[id].tsx・BulkEventForm.tsxと同じ
      // 「resolvedがdateと同じならundefined」という既存の最小表現規約）。
      const updatedEvents = targets.map((e) => {
        if (e.id === updatedBaseEvent.id) return updatedBaseEvent;
        if (!isNormalEvent(e) || !isNormalEvent(updatedBaseEvent)) return e;
        const endDate = e.allDay
          ? undefined
          : (() => {
              const resolved = resolveEndDate(e.date, updatedBaseEvent.startTime, updatedBaseEvent.endTime);
              return resolved === e.date ? undefined : resolved;
            })();
        return {
          ...e,
          title: updatedBaseEvent.title,
          memo: updatedBaseEvent.memo,
          startTime: updatedBaseEvent.startTime,
          endTime: updatedBaseEvent.endTime,
          endDate,
          notification: updatedBaseEvent.notification,
          updatedAt: now,
        };
      });
      return saveEventsBulk(updatedEvents);
    },
    [events, saveEvent, saveEventsBulk]
  );

  const removeRecurringEvents = useCallback(
    async (baseEvent: AppEvent, scope: RecurringEditScope): Promise<BulkSaveResult> => {
      const targets = selectRecurringTargets(events, baseEvent, scope);
      if (targets.length <= 1) {
        await removeEvent(baseEvent.id, baseEvent.calendarId);
        return { successCount: 1, failureCount: 0 };
      }
      const ids = targets.map((e) => e.id);
      // REVISE対応（第5ラウンド、P1-3）: selectRecurringTargetsはrecurringGroupIdの
      // 一致だけでtargetsを絞り込むため、データ破損・recurringGroupIdの偶発的な衝突等で
      // 複数のカレンダーにまたがるtargetsが返る可能性を排除できない。baseEvent.calendarId
      // だけで削除先を判定する前に、全targetsが同じcalendarIdを持つことを検証し、
      // 1件でも異なれば削除処理（楽観更新・Storage・Supabase・通知・同期キュー）に
      // 一切触れる前に例外で停止する。
      if (targets.some((t) => t.calendarId !== baseEvent.calendarId)) {
        throw new Error("削除対象の予定が複数のカレンダーにまたがっているため、削除できません");
      }
      // REVISE対応（第3ラウンド、P1-4）: removeEventと同じclassifyCalendarOwnershipで
      // 判定する（旧isSharedCalendarIdの否定をローカルの証拠として扱わない）。
      const classification = classifyCalendarOwnership(
        baseEvent.calendarId,
        userCalendars,
        sharedData.sharedCalendars
      );
      if (classification === "unknown") {
        throw new Error("この予定の削除元カレンダーを特定できないため、削除できません");
      }
      if (classification === "shared") {
        if (!user || typeof sharedData.ownerUserId !== "string") {
          throw new Error("共有予定の削除にはログインが必要です");
        }
        assertSessionReady(sharedData.sessionInstanceId);
        const ownerUserId = sharedData.ownerUserId;
        const sessionInstanceId = sharedData.sessionInstanceId;
        // REVISE対応（第7ラウンド、P1-3）: Supabase呼び出しを開始する前に検証する。
        // REVISE対応（第8ラウンド、P1-5）: removeEventと同じ理由で、通知取消と実際の
        // 削除の間にもう一度確認する。runCurrentSharedMutationにより、この関数全体が
        // 同一のSharedMutationIdentity契約を通る。
        const identity: SharedMutationIdentity = { userId: ownerUserId, sessionInstanceId };
        return runCurrentSharedMutation(identity, async (assertCurrent) => {
          // [P0084 ROBUST-F015-002] auth捕捉を楽観的な削除UI/通知取消より前に行う
          // （正本§2 Capture ordering、removeEvent単発分岐・P0082と同じ理由）。ここで
          // 失敗すれば楽観的な変更はまだ一切発生していないため、復元は不要。
          const auth = await captureSharedMutationAuthSnapshot(identity);
          assertCurrent();

          ids.forEach((id) => handleRemoteEventDelete(id, ownerUserId, sessionInstanceId));

          // [P0084 ROBUST-F015-002] targets（selectRecurringTargetsの戻り値）はこの操作を
          // 開始する前に取得したイベント実体そのものなので、復元用のスナップショットとして
          // そのまま使える。渡されたサブセットだけを復元する（全件ではなく、実際にdurableな
          // 結果を得られなかったtargetだけ）。
          const restoreTargetsIfStillCurrent = async (targetsToRestore: AppEvent[]) => {
            if (!isCurrentSharedMutationIdentity(identity) || targetsToRestore.length === 0) return;
            targetsToRestore.forEach((t) => handleRemoteEventChange(t, ownerUserId, sessionInstanceId));
            // [P0088 ROBUST-F015-005] removeEvent単発分岐と同じ理由で、ここでの再スケジュール
            // 失敗（例外・blocked）を握りつぶす。直前のhandleRemoteEventChangeで各targetは
            // 既にcommitted React state（sharedData.remoteEvents）へ復元済みのため、下方の
            // 唯一のreconcile effectがbarrier解除時・AppState「active」復帰時に自動的に
            // 再構築を試みる（diff-based・冪等）。この関数がここで例外を投げると、
            // 呼び出し元のcatch節が意図するUNCONFIRMED_MESSAGEを別のエラー形状で
            // 上書きしてしまう。
            try {
              const outcome = await scheduleSharedEventNotifications(
                targetsToRestore,
                ownerUserId,
                sessionInstanceId
              );
              notifyIfNotificationPermissionDenied(outcome);
            } catch (e) {
              if (__DEV__) {
                console.warn(
                  "[AppDataContext] ロールバック時の通知再スケジュール（一括）に失敗しました（イベントデータ自体は復元済み。barrier解除/AppState復帰時のreconcileで自動的に再試行されます）",
                  e
                );
              }
            }
          };

          let outcomes: Record<string, eventService.BulkDeleteTargetOutcome>;
          try {
            // [P0086 ROBUST-F015-003] 通知取消をremote/queue authorityが確定するより前の
            // 楽観的副作用としてtryの外側に置いていたため、取消自体が拒否した場合に
            // remote一括削除もキュー投入も一切行われていないのに、ローカルの楽観的削除だけが
            // 残ってしまっていた（removeEvent単発分岐、Stage 8/P1-5とは異なり、この分岐だけ
            // durable-authority契約から外れていた）。単発削除（removeEvent、1771-1796行目）と
            // 同じく、通知取消をこのtry内へ移し、実際の一括削除呼び出しと同じ復旧経路を通す。
            const cancelResult = await cancelSharedEventNotifications(ids, ownerUserId, sessionInstanceId);
            assertCurrent();
            if (cancelResult === SHARED_NOTIFICATION_BARRIER_BLOCKED) {
              // [P0088 ROBUST-F015-004] removeEvent単発分岐と同じ理由。通知取消がblockされ
              // 何も取り消されていない状態でremote一括削除・キュー投入へ進まない。
              throw new Error(SHARED_EVENT_DELETE_UNCONFIRMED_MESSAGE);
            }
            outcomes = await eventService.removeSharedEventsBulk(
              targets.map((t) => ({ id: t.id, calendarId: t.calendarId })),
              { enqueueDelete, auth }
            );
          } catch (e) {
            if (e instanceof Error && e.message === STALE_SHARED_MUTATION_IDENTITY_MESSAGE) {
              // assertCurrent()自身が投げた、通常のidentity切替検知。既存の規約通り
              // 復元は試みず、そのまま伝播させる。
              throw e;
            }
            // [P0084 ROBUST-F015-002] 呼び出し全体が想定していない例外で失敗した
            // （個々のtargetのdurable delete authorityが一切確認できていない）。
            // まだ現在のidentityであれば全対象を保守的に復元する。
            await restoreTargetsIfStillCurrent(targets);
            throw new Error(SHARED_EVENT_DELETE_UNCONFIRMED_MESSAGE);
          }

          const needsRestore = targets.filter((t) => {
            const outcome = outcomes[t.id];
            return outcome !== "deleted" && outcome !== "enqueued";
          });

          if (needsRestore.length === 0) {
            // 全targetがdeleted/enqueuedのいずれか（durable delete authority確認済み）。
            // 楽観的なローカル削除はそのままauthoritativeとして確定してよい。
            // [P0084 ROBUST-F015-002] BulkSaveResultの既存の規約（第6ラウンド、P1-1）に
            // 合わせ、enqueuedはsuccessCountではなくfailureCountの内訳として数える
            // （呼び出し元app/event/[id].tsxは戻り値を検査しないため、この内訳自体は
            // 挙動に影響しない——removeEvent単発分岐と同じく形式的な整合性のために揃える）。
            const successCount = targets.filter((t) => outcomes[t.id] === "deleted").length;
            const enqueuedCount = targets.length - successCount;
            return {
              successCount,
              failureCount: enqueuedCount,
              enqueuedCount: enqueuedCount > 0 ? enqueuedCount : undefined,
            };
          }

          // [P0084 ROBUST-F015-002] durableな結果を得られなかったtargetのみを復元する
          // （残りのtargetはdeleted/enqueuedのまま——部分成功を全成功・全失敗と混同しない）。
          await restoreTargetsIfStillCurrent(needsRestore);

          const allDefiniteFailure = needsRestore.every((t) => outcomes[t.id] === "definite-failure");
          if (allDefiniteFailure) {
            // [P0080 F015] RLSにより削除が確実にブロックされたことが確認できたtargetのみ
            // （removeEventの単発分岐と同じ理由）。
            throw new Error(SHARED_EVENT_DELETE_BLOCKED_MESSAGE);
          }
          // 少なくとも1件はdurable delete authorityが確認できなかった（unknown-not-durable、
          // またはoutcomesに含まれない想定外のtarget）。「削除されなかった」ではなく
          // 「結果を確認できなかった」ことを表す。
          throw new Error(SHARED_EVENT_DELETE_UNCONFIRMED_MESSAGE);
        });
      }
      // classification === "local"
      const next = await eventService.removeLocalEventsBulk(ids);
      setLocalEvents(next);
      // 削除（ストレージからの除去）が完了した後に通知を取り消す。削除前に取り消すと、
      // 途中でストレージ書込みが失敗した場合に「予定は残っているのに通知だけ消える」
      // 不整合が起きうるため、既存のremoveEvent（Stage H-3）と同じ順序に揃える。
      await cancelNotifications(ids);
      return { successCount: ids.length, failureCount: 0 };
    },
    [
      events,
      removeEvent,
      user,
      userCalendars,
      sharedData.ownerUserId,
      sharedData.sessionInstanceId,
      sharedData.sharedCalendars,
      handleRemoteEventDelete,
      handleRemoteEventChange,
      enqueueDelete,
    ]
  );

  const value = useMemo<AppDataContextValue>(
    () => ({
      loading,
      initializationStatus,
      retryInitialization,
      events,
      overlaySettings,
      shareTargets,
      userCalendars,
      sharedCalendars: sharedData.sharedCalendars,
      syncStatusByEventId,
      loadingShared: sharedData.loadingShared,
      pendingInvites: sharedData.pendingInvites,
      loadingPendingInvites: sharedData.loadingPendingInvites,
      pendingInvitesError: sharedData.pendingInvitesError,
      refresh,
      refreshShared,
      refreshPendingInvites,
      acceptPendingInvite,
      declinePendingInvite,
      saveEvent,
      reflectCommittedSharedEventChange: handleRemoteEventChange,
      saveSharedNormalEventWithVersionCheck,
      saveEventsBulk,
      updateRecurringEvents,
      removeRecurringEvents,
      removeEvent,
      toggleShowNormalEventsIntent,
      toggleShowTasksIntent,
      setEventDisplayModeIntent,
      showOnlyCalendarIntent,
      addUserCalendar,
      updateUserCalendar,
      removeUserCalendar,
      createSharedCalendar,
      updateSharedCalendar,
      deleteSharedCalendar,
      markCalendarVisible,
      toggleCalendarVisibilityIntent,
      favoriteCalendarIds,
      toggleFavoriteCalendar,
      lastUsedCalendarId,
      recordLastUsedCalendar,
      focusHistory,
      refreshFocusHistory,
      appendFocusHistory,
      deleteFocusHistoryRecord,
    }),
    [
      loading,
      initializationStatus,
      retryInitialization,
      events,
      overlaySettings,
      shareTargets,
      userCalendars,
      sharedData.sharedCalendars,
      syncStatusByEventId,
      sharedData.loadingShared,
      sharedData.pendingInvites,
      sharedData.loadingPendingInvites,
      sharedData.pendingInvitesError,
      refresh,
      refreshShared,
      refreshPendingInvites,
      acceptPendingInvite,
      declinePendingInvite,
      saveEvent,
      handleRemoteEventChange,
      saveSharedNormalEventWithVersionCheck,
      saveEventsBulk,
      updateRecurringEvents,
      removeRecurringEvents,
      removeEvent,
      markCalendarVisible,
      toggleCalendarVisibilityIntent,
      toggleShowNormalEventsIntent,
      toggleShowTasksIntent,
      setEventDisplayModeIntent,
      showOnlyCalendarIntent,
      addUserCalendar,
      updateUserCalendar,
      removeUserCalendar,
      createSharedCalendar,
      updateSharedCalendar,
      deleteSharedCalendar,
      favoriteCalendarIds,
      toggleFavoriteCalendar,
      lastUsedCalendarId,
      recordLastUsedCalendar,
      focusHistory,
      refreshFocusHistory,
      appendFocusHistory,
      deleteFocusHistoryRecord,
    ]
  );

  return (
    <AppDataContext.Provider value={value}>
      {children}
    </AppDataContext.Provider>
  );
}

export function useAppData(): AppDataContextValue {
  const ctx = useContext(AppDataContext);
  if (!ctx) {
    throw new Error("useAppData は AppDataProvider の内側で使ってください");
  }
  return ctx;
}
