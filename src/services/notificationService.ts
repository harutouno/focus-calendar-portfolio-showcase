import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { AppEvent, FocusSession, FocusTask, isFocusTask } from "@/types/event";
import { combineDateAndTime } from "@/utils/time";
import {
  NotificationOwnership,
  NotificationRegistryEntry,
  NotificationRegistry,
  NotificationRegistryRebuildOutcome,
  NotificationRegistryRepairResult,
  NotificationSlot,
  PendingOwnerCleanupTarget,
  addPendingIdentityCleanup,
  addPendingOwnerCleanup,
  clearAllNotificationIdsStrict,
  repairCorruptNotificationRegistryExclusively,
  getAllNotificationEntries,
  getNotificationId,
  getPendingOwnerCleanupTargets,
  getSharedEntriesForOwner,
  isNotificationRegistryMigratedV3,
  markNotificationRegistryMigratedV3Strict,
  notificationLogicalKey,
  removeNotificationIdForSlot,
  removePendingIdentityCleanup,
  removePendingOwnerCleanup,
  setNotificationId,
} from "@/storage/notificationRepository";
import {
  clearFocusTimerNotificationId,
  getFocusTimerNotificationId,
  saveFocusTimerNotificationId,
} from "@/storage/focusSessionRepository";
import { SupportedLocale, translate } from "@/i18n/translations";
import { localeService } from "@/services/deviceLocaleService";

/**
 * REVISE対応（第8ラウンド、P1-2）: sharedNotificationCoordinatorの起動時hydrateが、
 * 永続化されたpending一覧を直接読めるようにするための再エクスポート
 * （既存のretryPendingOwnerNotificationCleanupsとは別に、hydrate側は「読み込む」ことと
 * 「実際に再試行する」ことを分離して制御する必要があるため）。
 * REVISE対応（第9ラウンド、P1-1）: hydrate専用の厳格版（ストレージ障害・JSON破損・不正な
 * 要素のいずれでも例外を投げ、空配列へフォールバックしない）も再エクスポートする。
 */
export {
  getPendingOwnerCleanups,
  getPendingOwnerCleanupTargetsStrict,
  type PendingOwnerCleanupTarget,
} from "@/storage/notificationRepository";

/**
 * 通知本文はReactツリー外（バックグラウンド処理・保存直後の非同期処理）から呼ばれるため
 * useLocale()は使えない。ユーザーが明示的に選択した（またはAsyncStorageに保存済みの）
 * ロケールをlocaleService経由で取得し、それに基づいて文言を組み立てる。
 * registry.ts経由のDIは使わず直接importする
 * （eventService.ts→notificationService.tsという既存の依存があり、registry.tsは
 * eventService.tsをimportしているため、ここでregistry.tsをimportすると循環importになる）。
 */
async function currentLocale() {
  return localeService.getInitialLocale();
}

/**
 * Stage H-1: 通知機能の基盤（権限・チャンネル・ハンドラ）。
 * Stage H-3〜H-5: 単発予定・一括作成・繰り返し予定・共有カレンダー（作成/編集/削除/Realtime/
 * refreshShared）に対する通知の予約・取消（`scheduleNotification`/`cancelNotification`と
 * その一括版）を追加。
 * Stage H-6: 起動時・再取得時の再構築（`reconcileNotifications`）、ローリングウィンドウ
 * （`MAX_SCHEDULED_NOTIFICATIONS`件までしかOSへ予約しない）、オフラインキュー再送・共有一括/
 * 繰り返し操作への対応拡張を追加。通知IDは引き続きSupabaseへは一切送らず、
 * `notificationRepository`経由で端末ローカル（AsyncStorage）にのみ保持する。
 * 2026-08: 集中予定（FocusTask）だけ、事前リマインダー（focusReminder）と開始通知
 * （focusStart）の最大2件を管理できるよう拡張。通常予定（NormalEvent）は既存どおり
 * defaultスロット1件のみ。
 *
 * SEC-F007-001 Stage 2: 共有予定（scope: "shared"）向けの予約・取消・再構築は、
 * 呼び出し元（sharedNotificationCoordinator.ts）が`isCurrent`（今もその操作の開始時点の
 * 所有者と一致するか）・`ownership`（scope・ownerUserId）を明示的に渡せるよう、
 * 各関数へ省略可能なoptionsを追加した。省略時は常に`{ scope: "local" }`・`isCurrent: () => true`
 * として動作するため、ローカル予定向けの既存呼び出し（saveLocalEvent等）は無変更のまま動く。
 *
 * 動作環境の制約（要実機/Development Build確認、本Stageでは未検証）:
 * - Expo Go: ローカル通知の権限リクエスト・チャンネル作成自体は動く可能性があるが、
 *   Expo SDK 53以降Expo Go上の通知機能は段階的に縮小されており、確実な動作は保証されない。
 *   特にAndroidのExpo Goでの挙動は未検証。
 * - Development Build/実機: 本Stageでは未検証。権限ダイアログの実際の見た目・
 *   通知チャンネルが正しく反映されるかは実機での確認が必要。
 * - iOS: 一度権限を拒否されると、アプリ内から再度ダイアログを出すことはできない
 *   （OS設定アプリからの変更のみ）。`ensureNotificationPermissionAsync`は
 *   status が undetermined のときだけリクエストし、denied のときは再リクエストしない。
 * - Android: 8以降は通知チャンネルが無いと通知が表示されないため`initializeNotifications`が
 *   android限定でデフォルトチャンネルを作成する。13(API 33)以降はPOST_NOTIFICATIONSの
 *   ランタイム許可が必要だが、これは`requestPermissionsAsync`が内部で処理する。
 *   `getPresentedNotificationsAsync`/`dismissNotificationAsync`はAndroid 6(API 23)以降で
 *   利用可能（本プロジェクトはapp.config.tsでminSdkVersionを明示的に上書きしておらず、
 *   Expo managed workflowの既定値を使用するため制約には該当しない）。
 */

/** このモジュールで扱う通知権限の状態。"unavailable"はAPI呼び出し自体が失敗した場合。 */
export type NotificationPermissionState =
  | "granted"
  | "denied"
  | "undetermined"
  | "unavailable";

const ANDROID_DEFAULT_CHANNEL_ID = "default";

let handlerConfigured = false;
let androidChannelConfigured = false;

/**
 * アプリ前面表示中に通知を受信した際の表示方針を設定する。
 * 複数回呼ばれても2回目以降は何もしない（`setNotificationHandler`自体は
 * 何度呼んでも上書きされるだけで安全だが、余分なネイティブ呼び出しを避けるために
 * 明示的にガードする）。
 */
function configureNotificationHandler(): void {
  if (handlerConfigured) return;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    handlerConfigured = true;
  } catch (e) {
    console.warn("[notificationService] 通知ハンドラの設定に失敗しました", e);
  }
}

/**
 * Android用のデフォルト通知チャンネルを作成する。Android以外のプラットフォームでは
 * 何もしない（`setNotificationChannelAsync`はAndroid専用APIのため）。
 */
async function ensureAndroidNotificationChannelAsync(): Promise<void> {
  if (Platform.OS !== "android") return;
  if (androidChannelConfigured) return;
  try {
    const locale = await currentLocale();
    await Notifications.setNotificationChannelAsync(ANDROID_DEFAULT_CHANNEL_ID, {
      name: translate(locale, "notification.channelName"),
      importance: Notifications.AndroidImportance.DEFAULT,
    });
    androidChannelConfigured = true;
  } catch (e) {
    console.warn("[notificationService] Android通知チャンネルの作成に失敗しました", e);
  }
}

/**
 * REVISE対応（第5ラウンド、P2-2、必須テスト1）: reconcile専用の厳格版。
 * reconcileNotificationsInternalは「今のOSの実際の予約状態」を確認できない限り、
 * cancel・schedule・対応表更新のいずれも安全に行えない（空配列を「何も無い」と
 * 誤認すると、既存の正当な通知を全件差分ありと見なして無駄にcancel→再scheduleしたり、
 * 逆に本来検出すべき重複を見逃したりする）。失敗を空配列へ丸め込まず、例外をそのまま
 * 呼び出し元（reconcileNotificationsInternalの外側try/catch）へ伝播させ、reconcile
 * 全体を中止させる。
 * REVISE対応（第6ラウンド、P1-3）: cancelAllSharedNotificationsForOwnerも同じ理由で
 * この厳格版を使う（一覧取得自体の失敗を「完了」として扱わないため）。以前この関数群には
 * 失敗時に空配列へ丸め込む非スロー版（safeGetAllScheduledNotificationsAsync/
 * safeGetPresentedNotificationsAsync）も存在したが、呼び出し元が両方とも
 * 厳格版のみを必要とするようになったため削除した。
 */
async function getAllScheduledNotificationsAsyncStrict(): Promise<
  Notifications.NotificationRequest[]
> {
  return await Notifications.getAllScheduledNotificationsAsync();
}

/**
 * SEC-F007-001 REVISE対応（P1-3、スキーマv3）: 通知レジストリのスキーマ移行。
 * 移行前のスキーマ（v2以前。eventIdのみキー・所有者情報が任意で、ローカル/共有・
 * 異なる所有者・異なる認証セッションが同じeventIdを持つ場合に衝突しうる形式）は
 * 新しい論理キー体系（scope/owner/session/eventId/slotを織り込んだキー）と
 * 互換性が無いため、一度だけ次を行う。
 * 1. OS予約済み・表示済みの「カレンダー予定通知」（content.data.eventIdを持つもの）を
 *    所有者を問わずすべて取消・削除する（集中タイマー終了通知(kind:"focus-timer")は対象外）
 * 2. notificationRepositoryの対応表を丸ごと破棄する
 * 3. 移行完了フラグを保存する
 * ローカル予定の通知は、この直後にAppDataContextの初期化フローが自然に呼ぶ
 * reconcileNotificationsによって再構築される（共有予定側もrefreshShared成功時に同様）。
 * アプリ起動のたびに呼ばれるが、移行済みなら即座に何もしない（冪等）。例外は外へ投げない。
 *
 * REVISE対応（P1-1）: 個々のcancel/dismiss操作の失敗を握りつぶさない。以前は
 * `Promise.allSettled`＋失敗を内部でwarnして握りつぶす`cancelOsNotification`/
 * `.catch(() => undefined)`付きの`dismissNotificationAsync`を使っていたため、
 * OS側の取消・削除が実際には1件も成功していなくても対応表クリア・移行完了フラグの
 * 保存まで進んでしまっていた（＝取り消されなかった旧通知が端末に残ったまま
 * 「移行完了」と記録され、二度と再試行されない）。ここでは失敗を握りつぶさない
 * 厳格な変種（`cancelOsNotificationStrict`/`dismissNotificationStrict`）を使い、
 * `Promise.all`で1件でも失敗したら例外をそのままこの関数のtryのcatchへ伝播させ、
 * 対応表の消去（`clearAllNotificationIdsStrict`）・移行完了フラグの保存
 * （`markNotificationRegistryMigratedV3Strict`）のいずれも行わない。この2つも
 * 書込み失敗時は例外を投げる厳格版を使うため、「対応表は消せたが移行済みフラグの
 * 保存だけ失敗した」場合も移行未完了のまま次回起動時に再試行される
 * （cancel/dismiss自体は存在しない・既に取消済みのIDに対しても安全に呼べる冪等操作の
 * ため、既に成功済みの分を再試行しても実害は無い）。
 * - OS予約一覧・表示済み一覧の取得自体が失敗した場合も、何を安全に取消してよいか
 *   判断できないため、同様に対応表の消去・移行完了フラグの保存のいずれも行わず、
 *   次回起動時に再試行する。
 * - `app/_layout.tsx`の`useEffect`はStrictMode（開発時）で二重発火しうるほか、
 *   `initializeNotifications`自体が複数箇所から呼ばれる可能性も排除できないため、
 *   単一のin-flight Promiseで直列化する（同時に呼ばれても実際の移行処理は1回しか
 *   実行されない＝後発の呼び出しは先行するPromiseをそのまま待つだけで、独自に
 *   対応表を消去し直すことはない）。
 *
 * REVISE対応（第3ラウンド、追加）: 以前はこの関数が失敗時も成功時と同じ`Promise<void>`
 * （常に例外を投げず解決するだけ）を返していたため、呼び出し元（`initializeNotifications`）
 * は移行が実際に失敗したかどうかを一切知る術が無く、後続の通常schedule/reconcileが
 * 移行の失敗を条件にできなかった。移行が失敗すると、旧v2以前のOS通知はP2-2の
 * 厳格なscope一致要求（scope==="local"の明示的な一致を要求する）の下で
 * `logicalKeyFromNotificationData`から「無効な形」として扱われ、reconcileの孤立通知掃除
 * からも見えなくなる（=いつまでも掃除されない残骸になり得る）ため、移行の成功が
 * 確認できるまで新規のschedule/reconcileを開始しない（`ensureMigrationComplete`参照）。
 * この関数はPromise<boolean>を返し、成功（既に移行済み、または今回の移行が完了した）
 * 場合のみtrueを返す。
 *
 * REVISE対応（第4ラウンド、P1）: 前ラウンドでは"not_attempted"（まだ一度も試みていない）を
 * ブロック対象から除外していたが、これは「移行の安全性をまだ確認できていない」という点で
 * "failed"と同じリスクを持つ（起動直後にAppDataContext側のreconcileが移行より先に走ると、
 * 旧v2通知を整理する前に新しいV3通知を予約してしまい、その後の移行のOS一覧一括取消
 * （content.data.eventIdを持つものを無差別に取り消す設計）がこの新しい予約まで巻き込む
 * 恐れがあった）。ブロックするのは"succeeded"以外のすべて（"not_attempted"/"running"/
 * "failed"）とし、"running"（進行中）の場合は即座に諦めず、同じ`migrationInFlight`を
 * 待ってその結果に従う設計にした。これにより、通常の起動シーケンス（移行が成功する
 * 一般的なケース）では、移行と競合して発火したschedule/reconcileが「失われる」ことなく
 * 移行完了後に安全に実行される。移行が実際に失敗した場合や、まだ一度も試みられていない
 * 場合（in-flightでもない）だけが即座にno-opになる。
 */
let migrationInFlight: Promise<boolean> | null = null;
type MigrationState = "not_attempted" | "running" | "succeeded" | "failed";
let migrationState: MigrationState = "not_attempted";

export function runNotificationRegistryMigrationIfNeeded(): Promise<boolean> {
  if (migrationInFlight) return migrationInFlight;
  migrationState = "running";
  const run = runNotificationRegistryMigrationInternal().finally(() => {
    migrationInFlight = null;
  });
  migrationInFlight = run;
  return run;
}

/**
 * REVISE対応（第4ラウンド、P1）: 移行の成功が確認できるまで、新規のschedule/reconcileを
 * 開始しない（fail-closed）。取消系操作は対象外（常に安全なため）。
 * - "succeeded": 即座にtrueを返す。
 * - "running"（進行中）: 同じ`migrationInFlight`をawaitし、その結果（成功/失敗）に従う
 *   （移行と競合して発火した呼び出しを、移行の完了を待ってから安全に実行させるため。
 *   単に諦めるだけだと、通常は成功するはずの移行のせいで正当な予約機会を毎回失うことになる）。
 * - "not_attempted"／"failed"（かついずれもin-flightではない）: falseを返す
 *   （前者は移行の安全性が未確認、後者は直近の試行が失敗と確定しているため、
 *   どちらも新規のOS操作を開始してよい根拠が無い）。
 */
async function ensureMigrationComplete(): Promise<boolean> {
  if (migrationState === "succeeded") return true;
  if (migrationInFlight) {
    return await migrationInFlight;
  }
  if (migrationState === "not_attempted") {
    devLog("skipped: notification registry migration not yet attempted");
  } else {
    devLog("skipped: notification registry migration failed and has not yet succeeded on retry");
  }
  return false;
}

/** 移行専用。失敗を握りつぶさず、そのまま呼び出し元（移行処理）へ伝播させる。 */
async function cancelOsNotificationStrict(notificationId: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(notificationId);
}

/** 移行専用。失敗を握りつぶさず、そのまま呼び出し元（移行処理）へ伝播させる。 */
async function dismissNotificationStrict(notificationId: string): Promise<void> {
  await Notifications.dismissNotificationAsync(notificationId);
}

async function runNotificationRegistryMigrationInternal(): Promise<boolean> {
  try {
    const migrated = await isNotificationRegistryMigratedV3();
    if (migrated) {
      migrationState = "succeeded";
      return true;
    }

    // 失敗時は例外がそのままこのtryのcatchへ伝播し、対応表の消去・フラグ保存の
    // いずれも行わずに終わる（次回起動時に再試行される）。
    const [osRequests, presented] = await Promise.all([
      Notifications.getAllScheduledNotificationsAsync(),
      Notifications.getPresentedNotificationsAsync(),
    ]);
    const scheduledIdsToCancel = osRequests
      .filter((req) => typeof req.content?.data?.eventId === "string")
      .map((req) => req.identifier);
    const presentedIdsToDismiss = presented
      .filter((n) => typeof n.request.content?.data?.eventId === "string")
      .map((n) => n.request.identifier);

    // REVISE対応（P1-1）: 1件でも失敗したら例外を伝播させる（詳細は関数doc参照）。
    await Promise.all(scheduledIdsToCancel.map((id) => cancelOsNotificationStrict(id)));
    await Promise.all(presentedIdsToDismiss.map((id) => dismissNotificationStrict(id)));
    await clearAllNotificationIdsStrict();
    await markNotificationRegistryMigratedV3Strict();
    migrationState = "succeeded";
    return true;
  } catch (e) {
    console.warn("[notificationService] 通知レジストリの移行に失敗しました", e);
    migrationState = "failed";
    return false;
  }
}

/**
 * 通知機能の基盤を初期化する。アプリ起動時に1回呼ぶことを想定しているが、
 * 複数回呼ばれても安全（内部フラグにより2回目以降は実質何もしない）。
 * 権限のリクエストはここでは行わない（`ensureNotificationPermissionAsync`が別途担当）。
 * 失敗しても例外を投げない＝アプリの起動自体を壊さない。
 * REVISE対応（第3ラウンド、追加）: 戻り値を移行の成否（boolean）にした。呼び出し元
 * （現状は`app/_layout.tsx`のfire-and-forget呼び出しのみ）が結果を使わなくても、
 * 将来的な明示的リトライUIやテストから移行の成否を直接確認できるようにするため。
 */
export async function initializeNotifications(): Promise<boolean> {
  configureNotificationHandler();
  await ensureAndroidNotificationChannelAsync();
  return await runNotificationRegistryMigrationIfNeeded();
}

function toPermissionState(
  status: Notifications.NotificationPermissionsStatus | null | undefined
): NotificationPermissionState {
  if (!status) return "unavailable";
  if (status.granted) return "granted";
  switch (status.status) {
    case "denied":
      return "denied";
    case "undetermined":
      return "undetermined";
    default:
      return "unavailable";
  }
}

/**
 * 現在の通知権限の状態を取得する（ユーザーへのダイアログ表示は発生しない）。
 * API呼び出し自体が失敗した場合は例外を投げず"unavailable"を返す。
 */
export async function getNotificationPermissionStatusAsync(): Promise<NotificationPermissionState> {
  try {
    const status = await Notifications.getPermissionsAsync();
    return toPermissionState(status);
  } catch (e) {
    console.warn("[notificationService] 通知権限の取得に失敗しました", e);
    return "unavailable";
  }
}

/**
 * REVISE対応（P0011 Batch2.5、4節）: 実際の`Notifications.requestPermissionsAsync()`
 * 呼び出しをmodule-levelでsingle-flight化する。同時に複数の呼び出し元
 * （単体/bulk permission wrapper・公開`ensureNotificationPermissionAsync`自身を含む
 * 任意の組み合わせ）がいずれもstatus===undeterminedを観測しても、実際にOSへ
 * リクエストを投げるのは1回だけにし、進行中のリクエストがあれば全員がその同じ
 * Promiseを共有する。成功・denied・例外いずれの経路でも`finally`でlockを解放するため、
 * 次回呼び出し時は必ず新規リクエストとして再試行できる。
 */
let nativePermissionRequestInFlight: Promise<NotificationPermissionState> | null = null;

function requestNativePermissionSingleFlight(): Promise<NotificationPermissionState> {
  if (nativePermissionRequestInFlight) return nativePermissionRequestInFlight;
  const run = (async (): Promise<NotificationPermissionState> => {
    try {
      const status = await Notifications.requestPermissionsAsync();
      return toPermissionState(status);
    } catch (e) {
      console.warn("[notificationService] 通知権限のリクエストに失敗しました", e);
      return "unavailable";
    }
  })();
  nativePermissionRequestInFlight = run;
  run.finally(() => {
    if (nativePermissionRequestInFlight === run) {
      nativePermissionRequestInFlight = null;
    }
  });
  return run;
}

/**
 * 必要な場合のみ通知権限をリクエストする。
 * - すでに granted / denied の場合は何もせず現在の状態をそのまま返す
 *   （iOSはdenied後の再ダイアログをOS自体がサポートしないため、無駄なリクエストを避ける）。
 * - undetermined の場合のみ実際にリクエストする。
 * API呼び出しが失敗した場合は例外を投げず"unavailable"を返す。
 * REVISE対応（P0011 Batch2.5）: 実際のネイティブリクエストは
 * `requestNativePermissionSingleFlight`を経由する。単体で呼んだ場合の観測可能な
 * 挙動（状態取得→undeterminedならリクエスト→結果を返す）自体は変更していない。
 */
export async function ensureNotificationPermissionAsync(): Promise<NotificationPermissionState> {
  const current = await getNotificationPermissionStatusAsync();
  if (current !== "undetermined") return current;
  return requestNativePermissionSingleFlight();
}

/**
 * REVISE対応（P0011 Batch2.5、1節）: `isCurrent`を各checkpointで確認しながら
 * 権限を確保するoperation-aware版。permission wrapper（単体・bulk）専用の内部helperで、
 * 公開`ensureNotificationPermissionAsync`の引数・戻り値は一切変更しない。
 *
 * 最低4箇所のcheckpointを持つ:
 * 1. 呼出し直後（status取得前）
 * 2. status取得後
 * 3. native request開始直前
 * 4. request完了後
 * いずれかでstaleと判定した場合は`"stale"`を返し、それ以降の副作用（新規native
 * requestの開始を含む）を一切行わない。single-flight自体（進行中の他operationの
 * リクエスト）は中止しない——このoperationが単に「その結果を使わない」だけであり、
 * 他のcurrentなoperationの結果には影響しない。
 */
async function ensureNotificationPermissionForOperation(
  isCurrent: () => boolean
): Promise<NotificationPermissionState | "stale"> {
  if (!isCurrent()) return "stale";
  const current = await getNotificationPermissionStatusAsync();
  if (!isCurrent()) return "stale";
  if (current !== "undetermined") return current;
  if (!isCurrent()) return "stale";
  const state = await requestNativePermissionSingleFlight();
  if (!isCurrent()) return "stale";
  return state;
}

/**
 * 現在通知を利用できるか（＝権限が付与済みか）を返す。
 */
export async function areNotificationsAvailableAsync(): Promise<boolean> {
  const state = await getNotificationPermissionStatusAsync();
  return state === "granted";
}

/** event.date + event.startTime から event.notification.minutesBefore 分前の実時刻を求める（通常予定専用）。 */
function getTriggerDate(event: AppEvent): Date {
  const startAt = combineDateAndTime(event.date, event.startTime);
  return new Date(startAt.getTime() - event.notification.minutesBefore * 60 * 1000);
}

/** 集中予定の開始通知（focusStart）のトリガー時刻＝予定開始時刻そのもの。minutesBeforeは使わない。 */
function getFocusStartTriggerDate(event: FocusTask): Date {
  return combineDateAndTime(event.date, event.startTime);
}

/**
 * 集中予定の事前リマインダー（focusReminder）のトリガー時刻。
 * minutesBeforeが0以下の場合は事前リマインダー自体を作らないためnullを返す。
 */
function getFocusReminderTriggerDate(event: FocusTask): Date | null {
  if (event.notification.minutesBefore <= 0) return null;
  const startAt = getFocusStartTriggerDate(event);
  return new Date(startAt.getTime() - event.notification.minutesBefore * 60 * 1000);
}

/**
 * 予定名が空（未入力）の場合に、不自然な空の引用符だけの文言にならないよう
 * 安全な代替文言へ差し替える。
 */
function safeEventTitle(title: string, locale: SupportedLocale): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : translate(locale, "notification.untitledEventFallback");
}

/**
 * 通知のtitle/body/dataを、通常予定・集中予定の各slotに応じて組み立てる。
 * SEC-F007-001 REVISE対応（P1-3）: scope・eventId・slotに加え、共有予定の場合のみ
 * ownerUserId・sessionInstanceIdをdataへ埋め込む。これにより、OSの予約済み/表示済み
 * 通知一覧から直接「local/sharedどちらの、誰の、どの認証セッション時点の共有予定か」を
 * 判別でき、notificationRepositoryの対応表が破損・欠落している場合でも所有者ベースの
 * 一括取消・回収が行える（cancelAllSharedNotificationsForOwner参照）ほか、
 * reconcileNotificationsがOS予約一覧と対応表を同じ論理キーで突き合わせられる
 * （notificationLogicalKeyFromData参照）。個人情報（予定タイトル等）は含めない・増やさない。
 * REVISE対応（第3ラウンド、P2-2）: schemaVersion（対応表側のNotificationRegistryEntry.
 * schemaVersionと同じ数値3）と、typeから間接的に推測するのではなく明示的なslotを
 * dataへ追加した。schemaVersionはOS側に残った旧バージョンの通知を将来のスキーマ変更時に
 * 判別できるようにするため、slotはlogicalKeyFromNotificationData側がtype文字列の
 * パターンマッチに頼らず直接読めるようにするため。
 */
function buildNotificationContent(
  event: AppEvent,
  slot: NotificationSlot,
  locale: SupportedLocale,
  ownership: NotificationOwnership
): { title: string; body: string; data: Record<string, unknown> } {
  const scopeData: Record<string, unknown> =
    ownership.scope === "shared"
      ? {
          schemaVersion: 3,
          slot,
          scope: "shared",
          ownerUserId: ownership.ownerUserId,
          sessionInstanceId: ownership.sessionInstanceId,
        }
      : { schemaVersion: 3, slot, scope: "local" };
  if (slot === "focusReminder" && isFocusTask(event)) {
    return {
      title: translate(locale, "notification.focusReminderTitle", {
        minutes: event.notification.minutesBefore,
      }),
      body: translate(locale, "notification.focusReminderBody", {
        title: safeEventTitle(event.title, locale),
        time: event.startTime,
      }),
      data: { eventId: event.id, type: "focus_session_reminder", ...scopeData },
    };
  }
  if (slot === "focusStart" && isFocusTask(event)) {
    return {
      title: translate(locale, "notification.focusStartTitle"),
      body: translate(locale, "notification.focusStartBody", {
        title: safeEventTitle(event.title, locale),
      }),
      data: { eventId: event.id, type: "focus_session_start", ...scopeData },
    };
  }
  // default（通常予定）: 既存どおりの文言・data。
  return {
    title: event.title,
    body: translate(locale, "notification.eventBody", { time: event.startTime }),
    data: { eventId: event.id, ...scopeData },
  };
}

/**
 * 通知ID1件を安全に取り消す（存在しなければ何もしない。冪等）。
 * REVISE対応（P2-1）: 呼び出し元が「実際にOS側の取消が成功したか」を判断できるよう、
 * 例外は投げないまま成否をbooleanで返す（trueは「元々何も無かった」場合も含む）。
 */
async function cancelOsNotification(notificationId: string | undefined): Promise<boolean> {
  if (!notificationId) return true;
  try {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
    return true;
  } catch (e) {
    console.warn("[notificationService] 通知の取消に失敗しました", e);
    return false;
  }
}

/**
 * ownership・eventId・slot単位で1件だけ取り消す（OS取消＋対応表からの当該slot削除）。
 * `cancelNotification`・reconcile双方から使う。`isCurrent`が省略された場合は常に実行する
 * （ローカル予定からの既存呼び出しはこれに該当）。各OS操作・対応表操作の直前で再確認し、
 * falseになった時点で以降の処理を打ち切る（所有者が変わった後は旧所有者のoperationが
 * 現所有者の通知を操作できないようにする）。
 * REVISE対応（P2-1、必須テスト5）: OS側の取消が失敗した場合、対応表の当該エントリは
 * 削除しない（次回のreconcileで再試行できる状態を維持する。取消に成功したかどうかに
 * 関わらず対応表を消してしまうと、「OS側には残っているのに対応表からは辿れず、
 * 二度と取り消せない孤立通知」を自ら作り出してしまうため）。
 */
/**
 * REVISE対応（第5ラウンド、P2-2）: 呼び出し元（reconcileNotificationsInternalの
 * toSchedule処理）が「取消が実際に確認できたか」を判断できるよう、成否をbooleanで
 * 返す（trueは「元々予約が無かった」場合も含む＝安全に次の予約へ進んでよいことを示す）。
 * falseの場合、呼び出し元は同じ論理キーへの新規予約を行ってはならない
 * （OS側に取消できなかった古い通知が残っている可能性があり、新規予約すると重複する）。
 */
async function cancelSlotInternal(
  eventId: string,
  slot: NotificationSlot,
  ownership: NotificationOwnership,
  isCurrent: () => boolean = ALWAYS_CURRENT
): Promise<boolean> {
  if (!isCurrent()) return false;
  let notificationId: string | undefined;
  try {
    notificationId = await getNotificationId(ownership, eventId, slot);
  } catch (e) {
    console.warn("[notificationService] 通知IDの取得に失敗しました", e);
    return false;
  }
  if (!isCurrent()) return false;
  const cancelled = await cancelOsNotification(notificationId);
  if (!cancelled) return false;
  if (!isCurrent()) return true;
  try {
    await removeNotificationIdForSlot(ownership, eventId, slot);
  } catch (e) {
    console.warn("[notificationService] 通知IDの削除に失敗しました", e);
  }
  return true;
}

/** `cancelNotification`/`reconcileNotifications`共通の、安全性チェックが無い（常にtrueの）既定値。 */
export interface NotificationSafetyOptions {
  /**
   * SEC-F007-001 Stage 2: falseを返した時点で以降のOS操作・対応表への書込みを中止する。
   * 省略時は常にtrue（安全確認を行わない＝ローカル予定の既存呼び出しと同じ挙動）。
   */
  isCurrent?: () => boolean;
}

export interface ScheduleNotificationOptions extends NotificationSafetyOptions {
  /** 省略時は`{ scope: "local" }`。共有予定向けにはsharedNotificationCoordinatorが指定する。 */
  ownership?: NotificationOwnership;
}

export interface CancelNotificationOptions extends NotificationSafetyOptions {
  /**
   * REVISE対応（P1-3）: 省略時は`{ scope: "local" }`。共有予定を取り消す場合は
   * sharedNotificationCoordinatorが必ず`{scope:"shared", ownerUserId, sessionInstanceId}`を
   * 指定する（省略するとlocal扱いになり、同じeventIdを持つ共有予定側のエントリを
   * 取り消せない・逆に無関係なlocal側エントリを誤って触ってしまう）。
   */
  ownership?: NotificationOwnership;
}

const DEFAULT_OWNERSHIP: NotificationOwnership = { scope: "local" };
const ALWAYS_CURRENT = () => true;

const ALL_NOTIFICATION_SLOTS: readonly NotificationSlot[] = ["default", "focusReminder", "focusStart"];

/**
 * REVISE対応（第5ラウンド、P2-2、必須テスト6）: 同一ownership+eventIdに対する
 * scheduleNotification/cancelNotificationの呼び出しをownership+eventId単位で直列化する。
 * 以前はこれらの呼び出し同士が全く同期されていなかったため、同一eventIdに対して
 * scheduleNotificationが同時に2回呼ばれると（例: 保存処理の二重発火）、両方が
 * 互いの存在を知らないままOS予約を作成し、対応表（1件しか保持できない）には
 * 後勝ちの1件だけが残り、もう一方のOS通知が永久に追跡不能な重複として残ってしまう
 * 恐れがあった。ownership+eventId単位のPromiseチェーンで直列化することで、
 * 後着の呼び出しは先着の呼び出しが完了してから実行されるようになり、OS通知・対応表の
 * いずれも必ず1件に収束する。別のeventIdの呼び出しは独立したチェーンを持つため、
 * 一括予約（scheduleNotifications）の並行性には影響しない。
 */
const eventMutationChains = new Map<string, Promise<unknown>>();

function eventMutationKey(ownership: NotificationOwnership, eventId: string): string {
  return ownership.scope === "shared"
    ? `shared:${ownership.ownerUserId}:${ownership.sessionInstanceId}:${eventId}`
    : `local:${eventId}`;
}

function enqueueEventMutation<T>(
  ownership: NotificationOwnership,
  eventId: string,
  op: () => Promise<T>
): Promise<T> {
  const key = eventMutationKey(ownership, eventId);
  const prior = eventMutationChains.get(key) ?? Promise.resolve();
  const run = prior.then(op);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  eventMutationChains.set(key, settled);
  settled.then(() => {
    if (eventMutationChains.get(key) === settled) {
      eventMutationChains.delete(key);
    }
    maybeCleanupEventIntentGeneration(key);
  });
  return run;
}

/**
 * REVISE対応（P0007 Batch2.2、C08）: ownership+eventId単位の「最新のdirect intentが
 * 何回目か」を表す世代カウンタ。`scheduleNotification`/`cancelNotification`（公開版の
 * 直接入口のみ。reconcileが内部で呼ぶ`cancelSlotInternal`/`scheduleCandidateInternal`
 * 自体は対象外）が呼ばれるたびに、最初のawaitより前の同期区間で対象キーの値を1つ
 * 進める。
 *
 * 背景: `enqueueEventMutation`によるownership+eventId単位の直列化は、「両方の呼び出しが
 * 既にこのチェーンへ並んだ後」の順序は保証するが、reconcileNotificationsは呼び出し時点
 * （`entries`が確定した時点）で「予約すべきか」を決めてしまうため、reconcileが
 * 外側の準備処理（OS一覧取得等）を待っている間に、より新しいdirect schedule/cancelが
 * 別に呼ばれて完了してしまうと、reconcileは古い（既に上書きされた）意図のまま
 * 予約・取消を実行し、新しいdirect呼び出しの結果を静かに巻き戻してしまう恐れがあった
 * （P0008 Batch2.2で指摘）。reconcileは自身の呼び出し時点でこの世代を同期的に
 * スナップショットし（`reconcileNotifications`参照）、実際に各candidate/取消対象を
 * 処理する直前（および各await境界）で「呼び出し時点から世代が変わっていないか」を
 * 確認する。変わっていれば、より新しいdirect intentが既に存在する（またはこの後
 * 追い越してくる）と判断し、そのeventについては一切のOS操作・対応表変更を行わない
 * （新しいdirect呼び出し自身が最終状態を確定させる）。
 */
const eventIntentGeneration = new Map<string, number>();
/** 現在進行中（呼び出し済みだが完了していない）のreconcileNotifications呼び出しの数。 */
let reconcileInFlightCount = 0;

/**
 * REVISE対応（P0009 Batch2.3）: ownership+eventIdに紐づく1回のdirect operation
 * （schedule/cancel/permission-requesting wrapper）を指す不透明なtoken。
 * `beginEventIntent`が返した時点のkey・generationを固定して保持する。以前の
 * `bumpEventIntentGeneration`（voidを返すだけ）は、呼び出し元が自分自身のtokenを
 * 保持できず、reconcileのsnapshot比較にしか使えなかった。direct operation自身が
 * 「自分より新しいintentが割り込んだか」を`isEventIntentTokenCurrent`で判定できる
 * ようにするため、token化した。
 */
interface EventIntentToken {
  readonly key: string;
  readonly generation: number;
}

/**
 * REVISE対応（P0010 Batch2.4、3節）: token発行専用のmodule-global単調増加sequence。
 * 以前の`beginEventIntent`は`(eventIntentGeneration.get(key) ?? 0) + 1`という
 * 「そのkeyの現在値からの相対的な+1」で世代番号を決めていたため、`eventIntentGeneration`
 * からそのkeyのエントリが（`maybeCleanupEventIntentGeneration`により正当に、または
 * このBatchで修正した「まだ活動中のtokenが誤って消される」バグにより不当に）削除された
 * 後にこのkeyへ改めて`beginEventIntent`を呼ぶと、番号が1から再スタートしてしまう。
 * この時、Map削除前に発行されていた古い（本来staleなはずの）tokenのgenerationが
 * たまたま1だった場合、新しく発行されたtoken（削除後の再スタートでやはり1になる）と
 * 数値が一致し、`isEventIntentTokenCurrent`が古いtokenを「current」と誤判定して
 * 復活してしまうABAが構造的に成立し得た（独立監査での指摘）。
 * 全tokenの発行元をこのmodule-global sequenceへ一本化することで、`eventIntentGeneration`
 * のどのkeyがいつ削除・再作成されても、新しく発行される値は必ず過去に一度も使われて
 * いない値になる（=同じ数値が2回発行されることが無い）。これによりABAは値の再利用
 * そのものが起きないため構造的に不可能になる。
 */
let eventIntentSequence = 0;

/**
 * ownership+eventIdに対する新しいtokenを発行し、そのkeyの現在値をこのtokenの世代へ
 * 更新する。公開operation（`scheduleNotification`/`cancelNotification`/
 * permission-requesting wrapper）の最初のawaitより前の同期区間で呼ぶこと。
 */
function beginEventIntent(ownership: NotificationOwnership, eventId: string): EventIntentToken {
  const key = eventMutationKey(ownership, eventId);
  eventIntentSequence += 1;
  const generation = eventIntentSequence;
  eventIntentGeneration.set(key, generation);
  return { key, generation };
}

/**
 * `token`を発行した時点から、このownership+eventIdの世代が変わっていないかを判定する。
 * 変わっていれば、より新しいdirect intent（別のschedule/cancel呼び出し）が既に
 * 割り込んでいるため、`token`を発行したoperation自身がstaleと判断してよい。
 */
function isEventIntentTokenCurrent(token: EventIntentToken): boolean {
  return (eventIntentGeneration.get(token.key) ?? 0) === token.generation;
}

/**
 * `eventMutationChains`が当該キーについて空になった時点（＝直近の操作が完了した時点）で
 * 呼ばれる。ただし、進行中のreconcileが古いスナップショットに基づいてこのキーの世代を
 * まだ比較していない可能性がある間は削除を保留する（削除してしまうと、世代が「変化した」
 * という事実そのものが失われ、reconcile側の比較が誤って「変化なし」に見えてしまうため）。
 * 保留した場合も、このキーに対する次の操作（direct呼び出し・reconcile自身の
 * enqueueEventMutation呼び出しのいずれも）が改めて自身の完了時にこの関数を呼び直すため、
 * 全てのreconcileが完了した後には必ずクリーンアップされる。
 */
function maybeCleanupEventIntentGeneration(key: string): void {
  if (reconcileInFlightCount > 0) return;
  if (eventMutationChains.has(key)) return;
  eventIntentGeneration.delete(key);
}

/**
 * `snapshot`（reconcile呼び出し時点で同期的に複製した世代の写し）と現在の世代を比較し、
 * このownership+eventIdについてより新しいdirect intentが介入していないかを判定する。
 */
function isEventIntentStillCurrent(
  snapshot: ReadonlyMap<string, number>,
  ownership: NotificationOwnership,
  eventId: string
): boolean {
  const key = eventMutationKey(ownership, eventId);
  const cutoff = snapshot.get(key) ?? 0;
  const current = eventIntentGeneration.get(key) ?? 0;
  return current === cutoff;
}

/** テスト専用: 世代カウンタMapの現在のサイズ（無制限に蓄積していないことの確認用）。 */
export function __getEventIntentGenerationMapSizeForTests(): number {
  return eventIntentGeneration.size;
}

/**
 * ownership・eventIdに紐づく全ての通知を取り消す（通常予定はdefaultの1件、集中予定は
 * focusReminder・focusStartの最大2件）。対応する予約が無い場合（未予約・通知なし設定・
 * 一部slotのみ存在等）も含め、例外を投げずに正常終了する（冪等）。
 * REVISE対応（P1-3）: 3スロットそれぞれを`cancelSlotInternal`へ委譲する（従来は
 * `getNotificationEntry`で3スロットまとめて取得→`removeNotificationId`でまとめて削除
 * していたが、ownershipを問わずeventIdだけで対応表を触っていたため、同じeventIdを持つ
 * 別scope/別所有者/別セッションのエントリまで巻き込む恐れがあった。`cancelSlotInternal`は
 * 論理キー単位でしか対応表に触れないため、この巻き込みが構造的に起きなくなる。
 * 副次効果として、P2-1必須テスト5（OS取消失敗時は対応表エントリを残す）もスロット単位で
 * 自動的に適用される。
 */
async function cancelNotificationCore(
  eventId: string,
  options: CancelNotificationOptions
): Promise<void> {
  const isCurrent = options.isCurrent ?? ALWAYS_CURRENT;
  const ownership = options.ownership ?? DEFAULT_OWNERSHIP;
  if (!isCurrent()) return;
  await Promise.allSettled(
    ALL_NOTIFICATION_SLOTS.map((slot) => cancelSlotInternal(eventId, slot, ownership, isCurrent))
  );
}

export function cancelNotification(
  eventId: string,
  options: CancelNotificationOptions = {}
): Promise<void> {
  const ownership = options.ownership ?? DEFAULT_OWNERSHIP;
  // REVISE対応（P0009 Batch2.3）: enqueueEventMutationへ積む前の同期区間でtokenを
  // 取得し、既存のidentity/session由来isCurrentとAND合成する。これにより、この
  // cancelNotification呼び出し自身が、eventMutationChainsの順序だけに頼らず
  // 「自分より新しいdirect intentが割り込んだか」を各await境界（cancelNotificationCore→
  // cancelSlotInternal内部の複数チェックポイント）で継続的に検知できる
  // （より新しいdirect scheduleが割り込んだ場合、この古いcancelは以降のOS/registry
  // 副作用を停止する）。
  const token = beginEventIntent(ownership, eventId);
  const baseIsCurrent = options.isCurrent ?? ALWAYS_CURRENT;
  const isCurrent = () => baseIsCurrent() && isEventIntentTokenCurrent(token);
  return enqueueEventMutation(ownership, eventId, () =>
    cancelNotificationCore(eventId, { ...options, isCurrent })
  );
}

/**
 * 1件の通知候補（NotificationCandidate）を実際に予約し、成功時のみ対応表へ保存する。
 * SEC-F007-001 Stage 2必須修正3: 予約直前・予約完了直後の2箇所で`isCurrent`を確認する。
 * 予約完了直後に所有者が変わっていた場合は、直ちに取り消し（OSへ表示され得る状態を残さない）、
 * 対応表への保存も行わない（stale所有者の通知IDが対応表に残らないようにするため）。
 *
 * REVISE対応（P1-4）: 対応表への保存（setNotificationId）自体が失敗した場合
 * （AsyncStorageの書込み失敗等）、OSには予約が成功しているのに対応表からは辿れない
 * 「孤立通知」が残ってしまう。保存が失敗した場合は、直ちにOS側の予約を取り消す
 * （＝この端末には「予約されなかった」のと同じ状態に揃える）。また、対応表への保存中
 * （awaitしている間）に所有者が変わっていた場合も同様に取り消し、対応表からも
 * このslotのエントリを除去する（保存済みだが直後にstaleとなったエントリを残さない）。
 */
async function scheduleCandidateInternal(
  candidate: NotificationCandidate,
  options: { isCurrent: () => boolean; ownership: NotificationOwnership }
): Promise<void> {
  const { event, slot, triggerDate } = candidate;
  if (triggerDate.getTime() <= Date.now()) return;
  if (!options.isCurrent()) return;
  try {
    const locale = await currentLocale();
    // REVISE対応（P0009 Batch2.3、4節）: currentLocale()のawait境界を閉じる。
    // このawait中により新しいdirect intentが割り込んだ場合、OS副作用を始める前に
    // 検知して打ち切る。
    if (!options.isCurrent()) return;
    const content = buildNotificationContent(event, slot, locale, options.ownership);
    // REVISE対応（P0009 Batch2.3、4節）: OS API呼出し直前でも再確認する
    // （buildNotificationContent自体は同期だが、await境界の直後・OS副作用の直前という
    // 要求どおりの位置に明示的なチェックポイントを置く）。
    if (!options.isCurrent()) return;
    const notificationId = await Notifications.scheduleNotificationAsync({
      content,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: triggerDate,
        channelId: ANDROID_DEFAULT_CHANNEL_ID,
      },
    });
    if (!options.isCurrent()) {
      // 予約が完了した直後に所有者が変わっていた＝stale。OSへ残さず、対応表にも保存しない。
      await cancelOsNotification(notificationId);
      return;
    }
    const saved = await setNotificationId(event.id, notificationId, slot, options.ownership);
    if (!saved) {
      // 対応表への保存に失敗＝この端末からは追跡・取消不能な孤立通知になるため、
      // OS側の予約自体を直ちに取り消す。
      await cancelOsNotification(notificationId);
      return;
    }
    if (!options.isCurrent()) {
      // 保存はできたが、保存中に所有者が変わっていた＝stale。OS側を取り消し、
      // 保存済みのこのslotのエントリも対応表から除去する。
      // REVISE対応（第3ラウンド、P2-2）: OS側の取消が実際に成功した場合のみ対応表から
      // 除去する（cancelOsNotificationの戻り値を確認せず除去していたため、OS取消が
      // 失敗してもエントリを消してしまい、「OS側には残っているのに対応表からは辿れず
      // 二度と取り消せない孤立通知」を作り得た。cancelSlotInternal・P2-1で既に同じ
      // 判断を行っているのに、この予約直後のstale経路だけ抜けていた不備を揃える）。
      const cancelled = await cancelOsNotification(notificationId);
      if (cancelled) {
        await removeNotificationIdForSlot(options.ownership, event.id, slot);
      }
    }
  } catch (e) {
    console.warn("[notificationService] 通知の予約に失敗しました", e);
  }
}

/**
 * 集中予定（FocusTask）の事前リマインダー（notification.minutesBefore分前、
 * minutesBeforeが0以下または既に過去なら予約しない）と開始通知（予定開始時刻ちょうど、
 * minutesBeforeは使わない。既に過去なら予約しない）を、それぞれ独立に予約する。
 * 一方が失敗しても他方の予約は継続する（scheduleCandidateInternal自体が例外を握りつぶす
 * 設計のため、ここでは単純に両方awaitするだけでよい）。
 */
async function scheduleFocusTaskNotifications(
  event: FocusTask,
  options: { isCurrent: () => boolean; ownership: NotificationOwnership }
): Promise<void> {
  const now = Date.now();
  const reminderAt = getFocusReminderTriggerDate(event);
  if (reminderAt) {
    await scheduleCandidateInternal({ event, slot: "focusReminder", triggerDate: reminderAt }, options);
  }
  const startAt = getFocusStartTriggerDate(event);
  if (startAt.getTime() > now) {
    await scheduleCandidateInternal({ event, slot: "focusStart", triggerDate: startAt }, options);
  }
}

/**
 * 予定（NormalEvent/FocusTask）に対してローカル通知を予約する。
 * - 既にこのeventIdに対する予約（全slot）があれば、まず取り消してから判定し直す
 *   （編集による時刻・通知設定の変更、再保存を安全に反映するため）。
 * - notification.enabled が false の場合は予約しない（＝cancelNotificationを呼んだ
 *   状態のまま何もしない）。
 * - 通常予定（NormalEvent）: 既存どおりdefaultスロット1件（minutesBefore分前、
 *   トリガー時刻が既に過去なら予約しない）。
 * - 集中予定（FocusTask）: focusReminder（任意）・focusStart（必須条件付き）の
 *   最大2件を`scheduleFocusTaskNotifications`へ委譲する。
 * - 通知権限が無い・API呼び出しが失敗した場合も含め、例外は一切外へ投げない
 *   （＝予定の保存処理自体を失敗させない）。
 * `options`省略時は`{ scope: "local" }`・常に実行（isCurrent省略）として動作する。
 */
async function scheduleNotificationCore(
  event: AppEvent,
  options: ScheduleNotificationOptions
): Promise<void> {
  const isCurrent = options.isCurrent ?? ALWAYS_CURRENT;
  const ownership = options.ownership ?? DEFAULT_OWNERSHIP;
  if (!isCurrent()) return;
  // REVISE対応（第6ラウンド、P2-2）: 移行ゲートを既存通知の取消より前に置く。以前は
  // 「取消は常に安全」という前提で先に既存通知を取り消してから移行状態を確認していたが、
  // 移行未完了・失敗中に予定を保存すると、既存通知だけを取り消して代替を予約しない
  // 「通知の消滅」が起こり得た（完全なfail-closedになっていなかった）。移行が
  // succeeded以外（not_attempted/running中でも未確定/failed）の間は、既存通知の取消・
  // 新規予約のいずれも一切行わない。
  if (!(await ensureMigrationComplete())) return;
  if (!isCurrent()) return;
  // REVISE対応（P1-3）: 再予約前に取り消す既存登録も、このイベントと同じownershipに
  // 限定する（省略時defaultのlocalに倒れると、共有予定を再予約する際にローカル側の
  // 同じeventIdのエントリを誤って触ってしまう恐れがあるため）。
  // REVISE対応（第5ラウンド、P2-2）: 同一のenqueueEventMutationチェーン内で実行中のため、
  // 二重に直列化キューへ積まないよう、公開版のcancelNotificationではなくcoreを直接呼ぶ。
  await cancelNotificationCore(event.id, { isCurrent, ownership });
  if (!isCurrent()) return;
  try {
    if (!event.notification.enabled) return;
    if (isFocusTask(event)) {
      await scheduleFocusTaskNotifications(event, { isCurrent, ownership });
      return;
    }
    const triggerDate = getTriggerDate(event);
    if (triggerDate.getTime() <= Date.now()) return;
    if (!isCurrent()) return;
    const locale = await currentLocale();
    // REVISE対応（P0009 Batch2.3、4節）: currentLocale()のawait境界を閉じる。
    if (!isCurrent()) return;
    const content = buildNotificationContent(event, "default", locale, ownership);
    // REVISE対応（P0009 Batch2.3、4節）: OS API呼出し直前でも再確認する。
    if (!isCurrent()) return;
    const notificationId = await Notifications.scheduleNotificationAsync({
      content,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: triggerDate,
        channelId: ANDROID_DEFAULT_CHANNEL_ID,
      },
    });
    if (!isCurrent()) {
      await cancelOsNotification(notificationId);
      return;
    }
    // REVISE対応（P1-4）: 対応表への保存が失敗した場合、OS側に孤立通知を残さないよう
    // 直ちに取り消す（scheduleCandidateInternalと同じ設計）。
    const saved = await setNotificationId(event.id, notificationId, "default", ownership);
    if (!saved) {
      await cancelOsNotification(notificationId);
      return;
    }
    if (!isCurrent()) {
      // REVISE対応（第3ラウンド、P2-2）: scheduleCandidateInternalと同様、OS側の取消が
      // 実際に成功した場合のみ対応表から除去する。
      const cancelled = await cancelOsNotification(notificationId);
      if (cancelled) {
        await removeNotificationIdForSlot(ownership, event.id, "default");
      }
    }
  } catch (e) {
    console.warn("[notificationService] 通知の予約に失敗しました", e);
  }
}

export function scheduleNotification(
  event: AppEvent,
  options: ScheduleNotificationOptions = {}
): Promise<void> {
  const ownership = options.ownership ?? DEFAULT_OWNERSHIP;
  // REVISE対応（P0009 Batch2.3）: cancelNotificationと同じ理由・同じ同期区間でtokenを
  // 取得しisCurrentへAND合成する（集中予定のfocusReminder/focusStartも同じeventId単位の
  // tokenを共有する。scheduleFocusTaskNotificationsはscheduleNotificationCore内部から
  // 呼ばれるため、1回のscheduleNotification呼び出しにつきtokenは1つだけ発行される＝
  // eventMutationChains自体がslot単位ではなくeventId単位のキーであることと粒度を
  // 揃えている）。これにより、この古いscheduleが自分より新しいdirect intentの割り込みを
  // 各await境界で自己検知して以降の副作用を止められる。
  const token = beginEventIntent(ownership, event.id);
  const baseIsCurrent = options.isCurrent ?? ALWAYS_CURRENT;
  const isCurrent = () => baseIsCurrent() && isEventIntentTokenCurrent(token);
  return enqueueEventMutation(ownership, event.id, () =>
    scheduleNotificationCore(event, { ...options, isCurrent })
  );
}

/**
 * `scheduleNotificationRequestingPermission`/`...s`の結果。呼び出し元が拒否時のみUIへ伝えるために使う。
 * REVISE対応（第6ラウンド、P2-2）: "blocked-migration"を追加した。以前は移行未完了・失敗中に
 * この関数を呼ぶと、実際にはscheduleNotificationCore内部の移行ゲートで何も行われていない
 * （通知OFF操作すら実行されていない）にもかかわらず、"disabled"（＝正常にOFFにできた）を
 * 返してしまっていた。呼び出し元がこの区別をできるよう、移行が未完了・失敗中の間は
 * 実際のOS操作を一切試みず、明示的にこの値を返す。
 */
export type NotificationScheduleOutcome =
  | "scheduled"
  | "disabled"
  | "permission-denied"
  | "blocked-migration";

/**
 * 保存された1件の予定に対して、通知が有効な場合のみ通知権限を確認・
 * （未確定なら）リクエストしたうえで予約する。ローカル予定専用（scope: "local"固定）。
 * 共有予定の通知はsharedNotificationCoordinator経由でscheduleNotificationを直接呼ぶ
 * （権限確認自体はcoordinator側では行わないため、必要ならcoordinatorが別途担う）。
 * - notification.enabled が false: 権限には触れず、`scheduleNotification`だけ呼ぶ
 *   （既存の予約があれば取り消すだけの通常の動作）。
 * - enabled かつ 権限が granted でない: 予約せず、念のためこのeventIdの既存予約も取り消し、
 *   "permission-denied" を返す（呼び出し元がユーザーへ表示するかを判断する）。
 * - enabled かつ granted: 通常通り予約する。
 * `ensureNotificationPermissionAsync`自体が「undeterminedのときだけ実際にOSダイアログを出す」
 * 設計のため、この関数を保存のたびに呼んでも、権限ダイアログが繰り返し出ることはない。
 */
export function scheduleNotificationRequestingPermission(
  event: AppEvent
): Promise<NotificationScheduleOutcome> {
  const ownership = DEFAULT_OWNERSHIP;
  // REVISE対応（P0009 Batch2.3）: 以前は内部でscheduleNotification/cancelNotification
  // （公開版）を呼んでおり、それらが持つtoken登録がmigration/permission awaitの"後"に
  // しか行われなかったため、待機中に割り込んだより新しいdirect呼び出しをこのwrapper
  // 自身が検知できない窓があった（ChatGPTによる独立監査での指摘）。
  // ここでは、最初のawaitより前の同期区間でこの1回のoperation用tokenを取得し、
  // migration確認・permission確認・最終的なschedule/cancelの実行までを、同じtokenを
  // 使う単一のenqueueEventMutation callback（＝eventMutationChains上の1つのoperation）
  // としてまとめる。内部からはcore関数（scheduleNotificationCore/cancelNotificationCore）
  // を直接呼び、公開版scheduleNotification/cancelNotificationは呼ばない
  // （呼ぶとそれぞれが独自のtokenを新たに発行し、二重bump・二重enqueueになるため）。
  const token = beginEventIntent(ownership, event.id);
  const isCurrent = () => isEventIntentTokenCurrent(token);
  // REVISE対応（P0011 Batch2.5、2節）: 完全にsupersededされた場合に返す、
  // 呼出し元がAlertを出さない既存outcome。唯一のAlert条件（AppDataContext.
  // notifyIfNotificationPermissionDenied）はoutcome==="permission-denied"のみのため、
  // permission-denied/blocked-migrationのいずれも返さなければ十分——新しいoutcome値は
  // 追加せず、既存unionから「enabled requestならscheduled、disabled requestならdisabled」を選ぶ。
  const neutralOutcome: NotificationScheduleOutcome = event.notification.enabled
    ? "scheduled"
    : "disabled";
  return enqueueEventMutation(ownership, event.id, async () => {
    // checkpoint 1: callback開始時。
    if (!isCurrent()) return neutralOutcome;
    // REVISE対応（第6ラウンド、P2-2）: 移行が未完了・失敗中の間は、通知OFF（disabled）の
    // ケースを含めOS操作を一切試みない。
    const migrationOk = await ensureMigrationComplete();
    // checkpoint 2・3: migration完了後・blocked outcomeを返す直前。
    if (!isCurrent()) return neutralOutcome;
    if (!migrationOk) return "blocked-migration";
    if (!event.notification.enabled) {
      // checkpoint 8: schedule/cancel core前。
      if (!isCurrent()) return neutralOutcome;
      await scheduleNotificationCore(event, { isCurrent, ownership });
      return "disabled";
    }
    // checkpoint 4〜6: permission status取得前後・native request直前・結果後は
    // ensureNotificationPermissionForOperation内部で確認される。
    const permissionResult = await ensureNotificationPermissionForOperation(isCurrent);
    if (permissionResult === "stale") return neutralOutcome;
    if (permissionResult === "denied") {
      // REVISE対応（P0012 Batch2.6、2節）: confirmed denied（exact"denied"）のみ
      // 既存通知をcancelし、cancel開始前・完了後の両方でcurrentを確認する。
      // cancel完了後にstaleと判明した場合、より新しいintentが既に最終状態を
      // 確定させているため、この古いwrapperはpermission-deniedを返さず
      // neutral outcomeへ畳む（stale wrapperがAlertを出させないため）。
      // checkpoint: cancel開始前。
      if (!isCurrent()) return neutralOutcome;
      await cancelNotificationCore(event.id, { isCurrent, ownership });
      // checkpoint: cancel完了後。
      if (!isCurrent()) return neutralOutcome;
      return "permission-denied";
    }
    if (permissionResult !== "granted") {
      // REVISE対応（P0012 Batch2.6、1節）: "unavailable"・native request後も
      // "undetermined"のまま、といったunknown/unavailable結果は確定的な拒否ではない。
      // 「安全側」のつもりで一度cancelすると、既存の有効な通知・registryを不必要に
      // 破壊してしまう（本当の安全側はOS操作を一切行わないこと）。schedule・cancelの
      // いずれも行わず、非Alertのneutral outcomeへ畳む。
      return neutralOutcome;
    }
    // checkpoint: schedule core前。
    if (!isCurrent()) return neutralOutcome;
    await scheduleNotificationCore(event, { isCurrent, ownership });
    return "scheduled";
  });
}

/**
 * 一括作成・繰り返し編集（following/all）向け。一括保存されるイベント群は同一の
 * 通知設定（BulkEventForm等でまとめて指定される）を共有する前提のため、
 * 先頭の1件の`notification.enabled`だけで判定し、権限確認は1回だけ行う
 * （`isSharedCalendarId`判定が`events[0]`基準なのと同じ考え方）。ローカル予定専用。
 */
export async function scheduleNotificationsRequestingPermission(
  events: AppEvent[]
): Promise<NotificationScheduleOutcome> {
  if (events.length === 0) return "disabled";
  const ownership = DEFAULT_OWNERSHIP;

  // REVISE対応（P0010 Batch2.4）: 以前はtokenの発行こそ最初のawait前に行っていたが、
  // 実際に`enqueueEventMutation`へ登録する（＝`eventMutationChains`がそのkeyを占有する）
  // のはmigration/permission確認が終わった後だった。その間（tokenは存在するが
  // どのchainにも属していない窓）に、同じkeyの古いdirect operationが完了して
  // `maybeCleanupEventIntentGeneration`を呼ぶと「このkeyにアクティブなchainは無い」と
  // 判定され、まだ有効なはずのbulk tokenのgenerationエントリを削除できてしまっていた。
  // さらにreconcile完了時のグローバル一斉清掃（`reconcileNotifications`参照）も
  // 同じ理由でこの窓を突破できた（独立監査での指摘）。
  //
  // 対策として、各eventの`enqueueEventMutation`呼び出し自体を、tokenの発行と同じ
  // 同期区間（＝この関数が呼ばれたその同期スタック）で行う。migration/permission確認は
  // 引き続きevents全体で共有する1回だけの判定のまま、各eventのenqueue済みcallback
  // 内部からその共有Promise（`decision`）をawaitする形にする。これにより
  // `eventMutationChains`が各eventのkeyを同期的に即座に占有するため、新しい専用の
  // lease管理構造を追加しなくても、既存の`eventMutationChains`＋
  // `maybeCleanupEventIntentGeneration`の「chainが空でない限り世代を消さない」という
  // 既存契約がそのままbulk tokenの保護（lease）として機能する。
  //
  // REVISE対応（P0010 Batch2.4、4節）: `Map<eventId, token>`ではなく配列
  // （`{event, token}`の組）で操作記録を保持する。入力配列に同一eventIdが重複して
  // 含まれる場合でも、各要素が自分自身のtokenを独立して持つ（後の要素ほど
  // `beginEventIntent`が後に呼ばれるため世代が新しくなり、結果的に先の要素は
  // 実行時に自己検知してno-opする＝最新要素だけが最終内容を確定する）。
  const operations = events.map((event) => ({
    event,
    token: beginEventIntent(ownership, event.id),
  }));

  // REVISE対応（P0011 Batch2.5、3節）: 個々のeventではなく「少なくとも1件は
  // まだcurrentなoperationが残っているか」を、共有decision内のpermission副作用
  // （native requestを含む）の可否判定に使う。1eventだけがsupersededされても
  // 他のcurrentなeventのためにpermission確認自体は継続する必要があるため。
  const hasCurrentOperation = (): boolean =>
    operations.some(({ token }) => isEventIntentTokenCurrent(token));

  // 全operationがsupersededされた場合に返す、呼出し元がAlertを出さないoutcome
  // （単体wrapperと同じ選択基準）。
  const neutralOutcome: NotificationScheduleOutcome = events[0].notification.enabled
    ? "scheduled"
    : "disabled";

  // REVISE対応（P0012 Batch2.6、3節）: 従来はdecision自体がそのままNotificationSchedule
  // Outcome（"permission-denied"を含む）を確定させていたため、confirmed deniedの場合、
  // 実際には全eventがsupersededされていても外側がpermission-deniedを返してしまう
  // （呼出し元がAlertを出しうる）恐れがあった。ここではdecisionの型を内部専用のkindへ
  // 変更し、"confirmed-denied"の最終outcomeは各eventのsettlement結果（実際にcurrentの
  // ままcancelを適用できたか）から決める。settlement後にgeneration Mapを再読して判断
  // すると、chain cleanup済みの正常operationまでfalseに見えてしまう恐れがあるため、
  // 各settlement自身の戻り値（実行時に確定するboolean）だけを根拠にする。
  type BulkPermissionDecision =
    | { kind: "blocked-migration" }
    | { kind: "neutral" }
    | { kind: "disabled" }
    | { kind: "granted" }
    | { kind: "confirmed-denied" }
    | { kind: "unknown" };

  // migration/permission確認はevents全体で共有する1回だけの判定。この時点では
  // まだ何もawaitされていない（async IIFEが「開始」されるだけ）。実際にこのPromiseが
  // awaitされるのは、下の同期ループが完了した後、各eventのenqueue済みcallback内部から。
  const decision: Promise<BulkPermissionDecision> = (async () => {
    // checkpoint: migration確認前にcurrent eventの有無を確認。
    if (!hasCurrentOperation()) return { kind: "neutral" };
    // REVISE対応（第6ラウンド、P2-2）: 移行が未完了・失敗中の間はOS操作を一切試みない。
    const migrationOk = await ensureMigrationComplete();
    // checkpoint: migration確認後にcurrent eventの有無を再確認。
    if (!hasCurrentOperation()) return { kind: "neutral" };
    if (!migrationOk) return { kind: "blocked-migration" };
    if (!events[0].notification.enabled) return { kind: "disabled" };
    // checkpoint群（status取得前後・native request直前・結果後）は
    // ensureNotificationPermissionForOperation内部で、hasCurrentOperationを
    // isCurrentとして確認される。これにより「全event stale」ならpermission APIを
    // 一切開始せず、「1件でもcurrent」なら通常どおり1回だけ確認が進む。
    const permissionResult = await ensureNotificationPermissionForOperation(hasCurrentOperation);
    if (permissionResult === "stale") return { kind: "neutral" };
    if (permissionResult === "denied") return { kind: "confirmed-denied" };
    if (permissionResult !== "granted") return { kind: "unknown" };
    return { kind: "granted" };
  })();

  // この関数が呼ばれた同じ同期スタック内で、全eventのqueue登録を完了する
  // （この行より後にどんなawaitが起きても、以降の呼び出しにはもう影響されない）。
  // 各settlementは、confirmed deniedのcancelをcurrentのまま適用できたかをbooleanで
  // 返す（それ以外のkindでは常にfalse。この戻り値だけが最終outcome判定の根拠になる）。
  const settlements: Promise<boolean>[] = operations.map(({ event, token }) => {
    const isCurrent = () => isEventIntentTokenCurrent(token);
    return enqueueEventMutation(ownership, event.id, async (): Promise<boolean> => {
      const outcome = await decision;
      if (outcome.kind === "disabled") {
        await scheduleNotificationCore(event, { isCurrent, ownership });
        return false;
      }
      if (outcome.kind === "confirmed-denied") {
        // checkpoint: cancel開始前。
        if (!isCurrent()) return false;
        await cancelNotificationCore(event.id, { isCurrent, ownership });
        // checkpoint: cancel完了後。staleならこのeventは「適用できた」に数えない。
        if (!isCurrent()) return false;
        return true;
      }
      if (outcome.kind === "granted") {
        await scheduleNotificationCore(event, { isCurrent, ownership });
        return false;
      }
      // blocked-migration / neutral / unknown: OS操作を一切行わない。
      return false;
    });
  });

  const settlementResults = await Promise.allSettled(settlements);
  const decided = await decision;
  if (decided.kind === "blocked-migration") return "blocked-migration";
  if (decided.kind === "disabled") return "disabled";
  if (decided.kind === "granted") return "scheduled";
  if (decided.kind === "confirmed-denied") {
    // REVISE対応（P0012 Batch2.6、3節）: 1件でもcurrentのままcancelを適用できていれば
    // permission-deniedを返す。全event staleならneutral outcomeへ畳む。
    const appliedWhileCurrent = settlementResults.some(
      (result) => result.status === "fulfilled" && result.value === true
    );
    return appliedWhileCurrent ? "permission-denied" : neutralOutcome;
  }
  // neutral / unknown
  return neutralOutcome;
}

/**
 * 複数件の予定に対して`scheduleNotification`をまとめて実行する（Stage H-4: 一括作成・
 * 繰り返し編集の端末内予定向け）。`scheduleNotification`自体が例外を投げない設計のため
 * `Promise.all`でも動作上は等価だが、将来の変更に対する保険として`Promise.allSettled`を使い、
 * 1件が失敗しても他の予約処理を止めない・awaitされない非同期処理を残さないことを保証する。
 * 最大200件（一括作成の上限）程度まではこの一括起動で許容する想定。
 * 呼び出し元（AppDataContext）の保存結果には一切影響を与えない（戻り値なし）。
 */
export async function scheduleNotifications(
  events: AppEvent[],
  options: ScheduleNotificationOptions = {}
): Promise<void> {
  await Promise.allSettled(events.map((event) => scheduleNotification(event, options)));
}

/**
 * 複数件のeventIdに対して`cancelNotification`をまとめて実行する（Stage H-4: 繰り返し予定の
 * 「これ以降/すべて」削除向け）。設計方針は`scheduleNotifications`と同じ。
 */
export async function cancelNotifications(
  eventIds: string[],
  options: CancelNotificationOptions = {}
): Promise<void> {
  await Promise.allSettled(eventIds.map((eventId) => cancelNotification(eventId, options)));
}

/**
 * Stage H-6: 一度にOSへ予約するローカル通知の最大件数。
 * OS・ライブラリ側の正確な仕様（プラットフォームやOSバージョンによって変わりうる）を
 * ここで断定することは避け、あくまで「このアプリが自主的に持つ安全マージン」として扱う。
 * 一括作成の上限（最大200件）よりかなり小さい値にすることで、iOSで一般に知られている
 * ローカル通知の保留件数上限に余裕を持たせつつ、予約更新用の余白も確保する狙い。
 * 2026-08: 集中予定は最大2通知を持つため、「予定数」ではなく「実際に予約する通知件数」を
 * この上限で数える（例: 集中予定10件・各リマインダーありなら20件として数える）。
 */
export const MAX_SCHEDULED_NOTIFICATIONS = 50;

function devLog(message: string): void {
  if (__DEV__) {
    // eslint-disable-next-line no-console -- 開発環境のみの確認用ログ（本番ビルドでは__DEV__がfalseになり出力されない）
    console.log(`[notificationService] ${message}`);
  }
}

export interface NotificationCandidate {
  event: AppEvent;
  slot: NotificationSlot;
  triggerDate: Date;
}

/**
 * REVISE対応（第4ラウンド、P2）: `reconcileNotifications`の呼び出し元が、予定1件ごとの
 * ownershipを明示的に対にして渡すための入力形式。以前は`resolveOwnership: (event) => ownership`
 * というコールバック（イベント本体の構造からownershipを推測する実装を呼び出し元へ許してしまう
 * 設計）を使っていたが、これを廃止し、ownershipは常にこの配列を組み立てる時点で確定させる。
 */
export interface NotificationEventEntry {
  event: AppEvent;
  ownership: NotificationOwnership;
}

interface NotificationCandidateWithOwnership extends NotificationCandidate {
  ownership: NotificationOwnership;
}

/** 上限超過時の優先順位付け用ランク。数値が小さいほど優先的に残す（0が最優先）。 */
function candidateRank(slot: NotificationSlot): number {
  if (slot === "focusStart") return 0;
  if (slot === "focusReminder") return 1;
  return 2; // default（通常予定）
}

/** `{slot, triggerDate}`の並びを、開始通知優先＞時刻昇順の順で揃える共通比較関数。 */
function compareBySlotThenTime(
  a: { slot: NotificationSlot; triggerDate: Date },
  b: { slot: NotificationSlot; triggerDate: Date }
): number {
  const rankDiff = candidateRank(a.slot) - candidateRank(b.slot);
  if (rankDiff !== 0) return rankDiff;
  return a.triggerDate.getTime() - b.triggerDate.getTime();
}

/**
 * 1件の予定（enabled かつ トリガー時刻が未来のものだけ）から、実際に予約すべき
 * `{slot, triggerDate}`の組を最大2件（集中予定）・最大1件（通常予定）算出する純粋関数。
 * `getNotificationCandidates`・`getReconcileCandidates`の両方が、この結果へ
 * それぞれの文脈で必要な追加フィールド（後者はownership）を付与して使う
 * （候補算出ロジック自体の重複を避けるための共通部分）。
 */
function slotsForEvent(
  event: AppEvent,
  nowMs: number
): { slot: NotificationSlot; triggerDate: Date }[] {
  if (!event.notification.enabled) return [];
  if (isFocusTask(event)) {
    const result: { slot: NotificationSlot; triggerDate: Date }[] = [];
    const reminderAt = getFocusReminderTriggerDate(event);
    if (reminderAt && reminderAt.getTime() > nowMs) {
      result.push({ slot: "focusReminder", triggerDate: reminderAt });
    }
    const startAt = getFocusStartTriggerDate(event);
    if (startAt.getTime() > nowMs) {
      result.push({ slot: "focusStart", triggerDate: startAt });
    }
    return result;
  }
  const triggerDate = getTriggerDate(event);
  return triggerDate.getTime() > nowMs ? [{ slot: "default", triggerDate }] : [];
}

/**
 * 通知候補（enabled かつ トリガー時刻が未来の実通知）を抽出する純粋関数。
 * 集中予定は事前リマインダー（minutesBefore>0かつ未来の場合のみ）・開始通知
 * （未来の場合のみ）をそれぞれ独立した候補として扱う（1予定=最大2候補）。通常予定は
 * 既存どおり1候補。削除済みの予定はそもそも`events`に含まれないため、ここでは判定しない
 * （呼び出し元が渡す`events`が「現在アクセス可能な予定の全体集合」であることが前提）。
 *
 * 並び順は「1.開始通知（直近のものから） 2.事前リマインダー（直近のものから）
 * 3.通常予定の通知（直近のものから）」の優先度順。上限件数で切り詰められる際、
 * 集中予定の開始通知が同じ予定の事前リマインダーより優先的に残るようにするため
 * （時刻の昇順だけで単純にソートすると、リマインダーの方が時刻が早いために開始通知より
 * 先に残ってしまい、優先したい開始通知の方が切り捨てられてしまうことがあるため）。
 */
export function getNotificationCandidates(
  events: AppEvent[],
  now: Date = new Date()
): NotificationCandidate[] {
  const nowMs = now.getTime();
  const result: NotificationCandidate[] = [];
  for (const event of events) {
    for (const { slot, triggerDate } of slotsForEvent(event, nowMs)) {
      result.push({ event, slot, triggerDate });
    }
  }
  return result.sort(compareBySlotThenTime);
}

/**
 * REVISE対応（第4ラウンド、P2）: `reconcileNotifications`専用の候補算出関数。
 * `getNotificationCandidates`とは異なり、`AppEvent[]`単体ではなく`{event, ownership}`の
 * 組（`NotificationEventEntry[]`）を受け取り、各候補へその予定のownershipをそのまま
 * 引き継がせる。ownershipはこの関数の入力配列の要素として最初から対になっているため、
 * eventId文字列・オブジェクト参照・配列上の所属位置など、予定オブジェクト自身の構造から
 * scopeを後から推測する必要が一切無い（呼び出し元がスプレッドコピー・JSON往復・
 * map/filterで配列を作り直しても、各要素が保持する`ownership`フィールド自体は
 * 常にそのまま残るため影響を受けない）。
 */
function getReconcileCandidates(
  entries: NotificationEventEntry[],
  now: Date = new Date()
): NotificationCandidateWithOwnership[] {
  const nowMs = now.getTime();
  const result: NotificationCandidateWithOwnership[] = [];
  for (const { event, ownership } of entries) {
    for (const { slot, triggerDate } of slotsForEvent(event, nowMs)) {
      result.push({ event, ownership, slot, triggerDate });
    }
  }
  return result.sort(compareBySlotThenTime);
}

/**
 * 優先順位順の候補から、先頭`limit`件だけを実際の予約対象として選ぶ純粋関数。
 * 「予定数」ではなく「実通知件数」を数える（getNotificationCandidatesが既に
 * 1予定=最大2候補へ展開済みのため、ここでは単純にスライスするだけでよい）。
 */
export function selectNotificationsToSchedule(
  candidates: NotificationCandidate[],
  limit: number = MAX_SCHEDULED_NOTIFICATIONS
): NotificationCandidate[] {
  return candidates.slice(0, limit);
}

/**
 * REVISE対応（P1-3）: OS通知のcontent.dataから、対応表と同じ論理キー（scope/owner/
 * session/eventId/slotを織り込んだキー）を組み立てる。
 * REVISE対応（第5ラウンド、P2-1）: 以前はschemaVersionを一切確認せず、slotも
 * `type`文字列からの間接推測（"focus_session_reminder"等）に頼っていたため、
 * buildNotificationContentが既に明示的なschemaVersion・slotフィールドをdataへ
 * 書き込んでいるにも関わらず、読取り側では実質的に使われていなかった。将来の
 * スキーマ変更・破損したdata・v3未満の残骸のいずれも、この厳格な検証により
 * 「無効な形」として照合対象から除外されるべきであり、typeからの再推測は行わない
 * （typeは通知タップ時のルーティング専用の別の関心事であり、
 * useNotificationResponseRouting.tsが直接読む。ここでの照合とは無関係）。
 * schemaVersion===3・eventIdが非空文字列・slotが3種のいずれか・scopeがlocal/sharedの
 * いずれか（sharedはownerUserId・sessionInstanceIdが共に非空文字列、localはこれらが
 * 存在しない）をすべて満たさない場合はundefinedを返し、呼び出し元でこの通知を
 * 照合対象から除外する（孤立通知として掃除の対象にはなり得るが、正規のV3通知と
 * 誤って同一視されることはない）。
 */
function logicalKeyFromNotificationData(data: unknown): string | undefined {
  const d = data as Record<string, unknown> | undefined;
  if (d?.schemaVersion !== 3) return undefined;
  const eventId = d?.eventId;
  if (typeof eventId !== "string" || eventId.length === 0) return undefined;
  const slot = d?.slot;
  if (typeof slot !== "string" || !ALL_NOTIFICATION_SLOTS.includes(slot as NotificationSlot)) {
    return undefined;
  }
  if (d?.scope === "shared") {
    const ownerUserId = d?.ownerUserId;
    const sessionInstanceId = d?.sessionInstanceId;
    if (typeof ownerUserId !== "string" || ownerUserId.length === 0) return undefined;
    if (typeof sessionInstanceId !== "string" || sessionInstanceId.length === 0) return undefined;
    return notificationLogicalKey(
      { scope: "shared", ownerUserId, sessionInstanceId },
      eventId,
      slot as NotificationSlot
    );
  }
  if (d?.scope === "local") {
    if (d?.ownerUserId !== undefined || d?.sessionInstanceId !== undefined) return undefined;
    return notificationLogicalKey({ scope: "local" }, eventId, slot as NotificationSlot);
  }
  return undefined;
}

/**
 * OS予約一覧から 論理キー -> notificationId[] のMapを作る（Focus Calendarのカレンダー通知のみが対象）。
 * REVISE対応（第5ラウンド、P2-2）: 以前はMap<string, string>で同じ論理キーの2件目以降を
 * 黙って上書きしていたため、過去の異常終了・再試行等で同じ論理キーのOS通知が複数存在する
 * 場合、古い方のnotificationIdが対応表からも呼び出し元からも一切辿れなくなり、二度と
 * 取り消せない重複通知として残り続けた。配列で全件保持し、呼び出し元が重複を検出・
 * 整理できるようにする。
 */
function buildOsLogicalKeyMap(requests: Notifications.NotificationRequest[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const req of requests) {
    const key = logicalKeyFromNotificationData(req.content?.data);
    if (!key) continue;
    const existing = map.get(key);
    if (existing) existing.push(req.identifier);
    else map.set(key, [req.identifier]);
  }
  return map;
}

/** 対応表の全エントリを 論理キー -> エントリ のMapへ変換する（各エントリ自身のownership情報を使う）。 */
function buildRepoLogicalKeyMap(
  entries: NotificationRegistryEntry[]
): Map<string, NotificationRegistryEntry> {
  const map = new Map<string, NotificationRegistryEntry>();
  for (const entry of entries) {
    const ownership = entryOwnership(entry);
    map.set(notificationLogicalKey(ownership, entry.eventId, entry.slot), entry);
  }
  return map;
}

/** 対応表エントリ自身が持つscope/owner/session情報から、そのエントリのownershipを復元する。 */
function entryOwnership(entry: NotificationRegistryEntry): NotificationOwnership {
  if (entry.scope === "shared" && entry.ownerUserId && entry.sessionInstanceId) {
    return { scope: "shared", ownerUserId: entry.ownerUserId, sessionInstanceId: entry.sessionInstanceId };
  }
  return { scope: "local" };
}

let reconcileChain: Promise<void> = Promise.resolve();

export type ReconcileNotificationsOptions = NotificationSafetyOptions;

/**
 * ローカル/共有を問わず、現在アクセス可能な全予定（`events`）を基に、この端末の通知予約を
 * 再構築する。処理内容（2026-08: 1予定=最大2通知(集中予定)に対応するため、eventId単位ではなく
 * "eventId:slot"単位で差分を取るよう拡張）:
 * 1. 通知候補（enabled かつ 未来の実通知）を抽出し、開始通知>事前リマインダー>通常予定の
 *    優先順位・時刻の昇順に並べる
 * 2. 先頭 MAX_SCHEDULED_NOTIFICATIONS 件（実通知件数）だけを予約対象にする（ローリングウィンドウ）
 * 3. OSの予約一覧・notificationRepositoryの対応表（"eventId:slot"へフラット化）を取得する
 * 4. 対応表にあるが予約対象外になった"eventId:slot"（削除済み・通知OFF・過去化・上限から
 *    溢れた分・件数のみ変更等）は個別のslotだけを取り消す（同じ予定の別slotには影響しない）
 * 5. OSにはあるが対応表に無い「孤立した」通知のうち、今回の予約対象にも含まれないものを掃除する
 * 6. 予約対象について、対応表とOSの両方に一致するnotificationIdが既に存在するslotはスキップし
 *    （＝全件cancel→scheduleし直す方式は避ける）、ズレている・欠けているslotだけ
 *    「安全側に倒して」取消→再予約する
 *
 * 複数の呼び出しが同時に走ると取消・予約が競合しうるため、単一のPromiseチェーンで直列化する
 * （外部ライブラリを使わない簡易的な排他制御）。通知権限が無い場合は、予約APIを無駄に呼ばないよう
 * 早期終了する（取消・整理は行わずそのまま終了する＝アプリの初期化・同期は失敗させない）。
 * 例外は一切外へ投げない。
 *
 * SEC-F007-001 Stage 2: `options.isCurrent`が渡された場合、複数の副作用境界
 * （権限確認後・OS一覧取得後・各cancel直前・各schedule直前）で再確認し、falseに
 * なった時点で以降の処理を打ち切る。
 * REVISE対応（第4ラウンド、P2）: 引数を`AppEvent[]`から`NotificationEventEntry[]`
 * （`{event, ownership}`の組の配列）へ変更した。以前は`resolveOwnership`という
 * 「イベント本体から所有者を推測するコールバック」を別途受け取っていたが、この設計は
 * コールバックの実装がeventId・オブジェクト参照・配列上の所属といった構造的な手がかりに
 * 頼らざるを得ない（`event`単体からownershipを引けるようにするには、結局どこかで
 * event→ownershipの対応表を作って引くことになり、その対応表の作り方次第で壊れる）
 * という弱点があった。ownershipは呼び出し元がこの配列を組み立てる時点で各要素へ
 * 明示的に付与するため、以降のどの処理段階でも推測が発生しない。
 */
export function reconcileNotifications(
  entries: NotificationEventEntry[],
  options: ReconcileNotificationsOptions = {}
): Promise<void> {
  // REVISE対応（P0007 Batch2.2、C08）: 「公開関数が呼ばれた同期区間でcutoffを取得する」
  // 要求どおり、reconcileChainでの順番待ちに入る前に、この瞬間のeventIntentGeneration
  // 全体を複製する。以降このreconcile呼び出しが各candidate/取消対象を処理する際、
  // このスナップショットと現在の世代を比較することで、「reconcileがこの呼び出しを
  // 受け取ってから後に、より新しいdirect schedule/cancelが割り込んでいないか」を
  // 判定できる（entriesに含まれないeventId・登録前のeventIdも含め、任意のキーについて
  // `snapshot.get(key) ?? 0`で「reconcile開始時点の世代」を一律に参照できる）。
  const generationSnapshot = new Map(eventIntentGeneration);
  reconcileInFlightCount += 1;
  const run = reconcileChain
    .then(() => reconcileNotificationsInternal(entries, options, generationSnapshot))
    .finally(() => {
      reconcileInFlightCount -= 1;
      if (reconcileInFlightCount === 0) {
        // このreconcileが最後の1件だった場合、settle済みだが世代削除を保留していた
        // キーをまとめて再チェックする（詳細はmaybeCleanupEventIntentGeneration参照）。
        for (const key of [...eventIntentGeneration.keys()]) {
          maybeCleanupEventIntentGeneration(key);
        }
      }
    });
  // 次の呼び出しが今回の完了（成功・失敗どちらでも）を待つようにする。
  reconcileChain = run.catch(() => undefined);
  return run;
}

async function reconcileNotificationsInternal(
  entries: NotificationEventEntry[],
  options: ReconcileNotificationsOptions = {},
  generationSnapshot: ReadonlyMap<string, number> = new Map()
): Promise<void> {
  const isCurrent = options.isCurrent ?? ALWAYS_CURRENT;
  try {
    if (!isCurrent()) return;
    // REVISE対応（第3・第4ラウンド）: reconcileは新規予約だけでなく孤立通知の掃除も
    // 兼ねるが、移行の成功が確認できるまでは「掃除しても安全な孤立通知かどうか」を
    // 正しく判別できない（旧v2以前の残骸がP2-2の厳格な照合で孤立扱いになる）ため、
    // 移行が進行中ならその完了を待ち、確認できなければreconcile自体を丸ごとスキップする。
    if (!(await ensureMigrationComplete())) return;
    if (!isCurrent()) return;
    const permission = await getNotificationPermissionStatusAsync();
    if (permission !== "granted") {
      devLog(`reconcile skipped: permission=${permission}`);
      return;
    }
    if (!isCurrent()) return;

    // REVISE対応（第4ラウンド、P2）: 各候補は`entries`の時点で確定したownershipを
    // そのまま引き継ぐ（`getReconcileCandidates`参照）。ここで改めて推測し直すことはない。
    const candidates = getReconcileCandidates(entries);
    const toSchedule = candidates.slice(0, MAX_SCHEDULED_NOTIFICATIONS);
    const scheduleKeys = new Set(
      toSchedule.map((candidate) =>
        notificationLogicalKey(candidate.ownership, candidate.event.id, candidate.slot)
      )
    );

    if (!isCurrent()) return;
    // REVISE対応（第5ラウンド、P2-2、必須テスト1）: OS一覧取得は厳格版を使う。取得自体が
    // 失敗した場合は例外がこの関数の外側try/catchへ伝播し、以降のcancel/schedule/
    // 対応表更新のいずれも一切行わずreconcile全体を中止する（空配列で処理を続けない）。
    // REVISE対応（第5ラウンド、P2-2、必須テスト5）: getAllNotificationEntriesが
    // registryMutationChainへ合流するようになったため、この読み込みは、この時点までに
    // 既にキューに積まれていた（setNotificationId等の）変更が反映された後の状態を
    // 必ず読める（進行中のmutationを追い越して古いスナップショットを読むことがない）。
    const [osRequests, repoEntries] = await Promise.all([
      getAllScheduledNotificationsAsyncStrict(),
      getAllNotificationEntries(),
    ]);
    if (!isCurrent()) return;
    const osByLogicalKey = buildOsLogicalKeyMap(osRequests);
    const repoByLogicalKey = buildRepoLogicalKeyMap(repoEntries);

    // 対応表にあるが今回の予約対象外になった論理キーは、そのエントリだけ取り消す
    // （削除済み・通知OFF・過去化・上限から溢れた分をまとめて含む。scope・所有者・
    // セッション・eventId・slotの組が完全一致するエントリだけを見るため、同じeventIdを
    // 持つ別scope/別所有者/別セッションのエントリや、同じ予定の別slotには影響しない）。
    const keysToCancel = [...repoByLogicalKey.keys()].filter((key) => !scheduleKeys.has(key));

    // OSにはあるが対応表に無く、かつ今回の予約対象にも無い「孤立した」通知も掃除する
    // （例: 前回の異常終了などでnotificationRepositoryの書込みだけ失敗したケースの復旧）
    const orphanKeys = [...osByLogicalKey.keys()].filter(
      (key) => !repoByLogicalKey.has(key) && !scheduleKeys.has(key)
    );

    let cancelCount = 0;
    await Promise.allSettled(
      keysToCancel.map(async (key) => {
        if (!isCurrent()) return;
        const entry = repoByLogicalKey.get(key);
        if (!entry) return;
        const entryOwn = entryOwnership(entry);
        // REVISE対応（P0007 Batch2.2、C08）: このentryのownership+eventIdについて、
        // reconcile呼び出し時点（generationSnapshot取得時）から世代が変わっていないかも
        // 合わせて確認する。変わっていれば、より新しいdirect schedule/cancelが既に
        // このキーへ介入している（または介入しつつある）ため、reconcileはこのentryの
        // 取消を行わない（新しいdirect呼び出し自身が最終状態を確定させる）。
        const entryIsCurrent = () =>
          isCurrent() && isEventIntentStillCurrent(generationSnapshot, entryOwn, entry.eventId);
        if (!entryIsCurrent()) return;
        // REVISE対応（第6ラウンド、P2-1）: 直接のscheduleNotification/cancelNotification
        // （公開版、enqueueEventMutation経由）と同じownership+eventId単位の直列化チェーンへ
        // 合流させる。以前はreconcile専用のreconcileChainからcancelSlotInternalを直接
        // 呼んでいたため、同一eventIdに対する直接呼び出しとreconcileが並行実行されると、
        // 互いのOS操作が入れ子にならずインターリーブし、片方が孤立した重複通知を
        // 作りうる構造だった。
        await enqueueEventMutation(entryOwn, entry.eventId, async () => {
          if (!entryIsCurrent()) return;
          await cancelSlotInternal(entry.eventId, entry.slot, entryOwn, entryIsCurrent);
        });
        cancelCount += 1;
      })
    );
    // 孤立した通知は対応表に無くrepository経由では引けないため、OS予約一覧から得た
    // notificationIdを直接使ってOSへ取消を伝える（対応表側は元々何も持っていないので
    // removeNotificationIdForSlotは不要）。REVISE対応（第5ラウンド、P2-2）: 同じ論理キーに
    // 複数件の孤立通知が存在する場合（過去の重複）も全件取り消す。
    await Promise.allSettled(
      orphanKeys.map(async (key) => {
        if (!isCurrent()) return;
        const notificationIds = osByLogicalKey.get(key) ?? [];
        await Promise.allSettled(notificationIds.map((id) => cancelOsNotification(id)));
        cancelCount += 1;
      })
    );

    // 予約対象について、対応表・OSの両方が一致している場合のみ差分無しとしてスキップする。
    // 一致しない場合（対応表にあるがOSに無い、OSにあるが対応表に無い、両方欠けている等）は
    // 安全側に倒してそのslotだけ取消→再予約する（同じ予定の他slotは触らない）。
    let scheduleCount = 0;
    await Promise.allSettled(
      toSchedule.map(async (candidate) => {
        if (!isCurrent()) return;
        const { ownership } = candidate;
        const key = notificationLogicalKey(ownership, candidate.event.id, candidate.slot);
        const osNotificationIds = osByLogicalKey.get(key) ?? [];

        // REVISE対応（P0007 Batch2.2、C08）: このcandidateのownership+eventIdについて、
        // reconcile呼び出し時点から世代が変わっていないかを、この後の各await境界
        // （cancelSlotInternal/scheduleCandidateInternal内部を含む）で継続的に確認する。
        // 変わっていれば、より新しいdirect schedule/cancelが既にこのキーへ介入している
        // （または介入しつつある）ため、reconcileはこのcandidateについて一切のOS操作・
        // 対応表変更を行わない。stale化した`entries`に基づく古い予約意図が、新しい
        // direct呼び出しの結果を巻き戻す（例: ユーザーが通知OFFへ変更した直後の
        // direct cancelを、古いreconcileが「enabledだった」という古い入力のまま
        // 再予約し直してしまう）ことを防ぐ。
        const candidateIsCurrent = () =>
          isCurrent() && isEventIntentStillCurrent(generationSnapshot, ownership, candidate.event.id);

        // REVISE対応（第6ラウンド、P2-1）: この候補に対する取消・予約の一連の操作全体を、
        // 直接のscheduleNotification/cancelNotification（公開版、enqueueEventMutation経由）と
        // 同じownership+eventId単位の直列化チェーンへ合流させる。1つの候補が持つ判定
        // （osNotificationIds等）はこのreconcile実行開始時点のスナップショットのままだが、
        // 実際のOS操作（cancelSlotInternal/scheduleCandidateInternal）自体は対応表を
        // 都度読み直す設計のため、直接呼び出しと入れ子にならず直列実行されることで、
        // 同一eventIdに対して両方が同時にOS予約を作成し、対応表には片方しか残らない
        // （もう一方が孤立した重複通知になる）という構造的な穴を閉じる。
        await enqueueEventMutation(ownership, candidate.event.id, async () => {
          if (!candidateIsCurrent()) return;
          // DATA-F007-001対応: repoNotificationIdだけは外側スナップショット
          // （repoByLogicalKey、keysToCancel/orphanKeysのPromise.allSettledが完了するまで
          // 待たされた後に読まれる）を使わず、このロック内でgetNotificationIdにより
          // 都度読み直す。同じ論理キーに対する直接呼び出し（schedule/cancel）は同じ
          // enqueueEventMutationキューを経由するため、このコールバックが実行され始めた
          // 時点までに完了している直接呼び出しの結果は、フレッシュな読み出しで必ず
          // 反映される（registryMutationChain経由のため読み-after-書きが保証される）。
          // 外側スナップショットのままだと、このロックへ入るまでの待ち時間の間に完了した
          // 直接呼び出しの結果（例: 直前にキャンセル済み）を見落とし、既にstaleになった
          // 対応関係を「一致している」と誤判定してreconcileが本来必要な再予約を
          // 静かにスキップしうる（詳細はDATA-F007-001参照）。osNotificationIds
          // （OS側一覧）は外側スナップショットのままでよい（実際のOS取消操作自体が
          // 冪等であり、このcallback内の判定を誤って安全でない側＝false陽性のinSyncへ
          // 倒すことはないため）。
          const repoNotificationId = await getNotificationId(ownership, candidate.event.id, candidate.slot);
          if (!candidateIsCurrent()) return;
          if (osNotificationIds.length > 1) {
            // REVISE対応（第5ラウンド、P2-2、必須テスト3）: 同じ論理キーのOS予約が複数存在する
            // （過去の異常終了・再試行等による重複）。対応表が指すIDを含め全件を取り消せた
            // 場合のみ対応表エントリを除去し、改めて1件だけ予約し直す。1件でも取消に
            // 失敗した場合は、重複がOS側に残っている可能性があるため対応表・予約の
            // いずれにも触れず、正規化完了扱いにしない（必須テスト4）。
            if (!candidateIsCurrent()) return;
            const results = await Promise.all(osNotificationIds.map((id) => cancelOsNotification(id)));
            if (!results.every(Boolean)) return;
            if (!candidateIsCurrent()) return;
            try {
              await removeNotificationIdForSlot(ownership, candidate.event.id, candidate.slot);
            } catch (e) {
              console.warn("[notificationService] 通知IDの削除に失敗しました", e);
            }
            if (!candidateIsCurrent()) return;
            await scheduleCandidateInternal(candidate, { isCurrent: candidateIsCurrent, ownership });
            scheduleCount += 1;
            return;
          }

          const inSync =
            !!repoNotificationId &&
            osNotificationIds.length === 1 &&
            osNotificationIds[0] === repoNotificationId;
          if (inSync) return;
          // REVISE対応（第5ラウンド、P2-2、必須テスト2）: 取消が実際に確認できた場合のみ
          // 新規予約へ進む。取消できなかった場合（OS側に古い通知が残っている可能性）に
          // 新規予約してしまうと、同じ論理キーのOS通知が重複する。
          const cancelled = await cancelSlotInternal(
            candidate.event.id,
            candidate.slot,
            ownership,
            candidateIsCurrent
          );
          if (!cancelled) return;
          if (!candidateIsCurrent()) return;
          await scheduleCandidateInternal(candidate, { isCurrent: candidateIsCurrent, ownership });
          scheduleCount += 1;
        });
      })
    );

    devLog(
      `reconcile done: candidates=${candidates.length} toSchedule=${toSchedule.length} ` +
        `cancelled=${cancelCount} scheduled=${scheduleCount}`
    );
  } catch (e) {
    console.warn("[notificationService] 通知の再構築に失敗しました", e);
  }
}

/**
 * SEC-F007-001 REVISE対応（P1-3）: 指定した所有者（ownerUserId）の共有予定に紐づく通知を、
 * 予約済み（対応表経由・OS予約一覧のcontent.data.ownerUserId経由も追加）・表示済み
 * （通知センター、content.data.ownerUserId経由）のいずれからも一括取消・削除する。
 *
 * REVISE対応（第9ラウンド、P1-1）: 第2引数`sessionInstanceId`を省略した場合は従来どおり
 * 認証セッションを問わず同一ownerUserIdの全セッション分を対象にする（レガシー呼び出し・
 * 永続化されたlegacy-ownerターゲットの再試行向け、後方互換のため挙動を変えていない）。
 * `sessionInstanceId`を指定した場合は、そのセッションの通知だけを対象にする（同一ユーザーの
 * 別セッション（A/session1→A/session2等）の残留を、無関係な他セッションの正当な通知を
 * 巻き込まずに取り消すため）。
 *
 * REVISE対応（第6ラウンド、P1-3）: 以前は3段階（対応表経由の取消・OS一覧経由の孤立取消・
 * 表示済み削除）それぞれをtry/catchで個別に握りつぶし、1件でも失敗しても常に
 * 「完了」として扱っていた。A→B切替直後にこの取消が失敗し、その後Bの共有取得も
 * 失敗すると、Aの予定名を含む通知がBの端末に残り続ける恐れがあった。
 * ここでは各段階の成否（一覧取得自体の失敗を含む）を厳密に追跡し、全段階が成功した
 * 場合のみtrueを返す（対応表経由の取消は`cancelSlotInternal`を直接使い、boolean戻り値で
 * 個々の成否を判定する。以前の`cancelNotification`公開版は内部でPromise.allSettledに
 * より失敗を握りつぶすため、全体の成否を外から判別できなかった）。1件でも失敗した場合は
 * このターゲット（所有者、または所有者+セッション）をpendingOwnerNotificationCleanup一覧
 * （永続化）へ記録し、次回のAppState復帰・アプリ起動時・次の所有者切替時に自動的に
 * 再試行する（`retryPendingOwnerNotificationCleanups`参照）。全段階が成功した場合のみ
 * 一覧から除去する。個々のOS操作は、直接のscheduleNotification/cancelNotificationと同じ
 * ownership+eventId単位の直列化チェーン（enqueueEventMutation）へ合流させ、旧所有者に対して
 * 進行中かもしれない直接呼び出しと競合しないようにする。ユーザー切替が確定した直後に、
 * 前の所有者（＋セッション）を指定してsharedNotificationCoordinator経由で呼ばれる想定。
 * 例外は外へ投げない。
 */
export async function cancelAllSharedNotificationsForOwner(
  ownerUserId: string,
  sessionInstanceId?: string
): Promise<boolean> {
  let allOk = true;

  try {
    const allEntries = await getSharedEntriesForOwner(ownerUserId);
    const entries = sessionInstanceId
      ? allEntries.filter((e) => e.sessionInstanceId === sessionInstanceId)
      : allEntries;
    const results = await Promise.all(
      entries
        .filter((entry): entry is NotificationRegistryEntry & { sessionInstanceId: string } =>
          Boolean(entry.sessionInstanceId)
        )
        .map((entry) => {
          const ownership: NotificationOwnership = {
            scope: "shared",
            ownerUserId,
            sessionInstanceId: entry.sessionInstanceId,
          };
          return enqueueEventMutation(ownership, entry.eventId, () =>
            cancelSlotInternal(entry.eventId, entry.slot, ownership, ALWAYS_CURRENT)
          );
        })
    );
    if (!results.every(Boolean)) allOk = false;
  } catch (e) {
    console.warn("[notificationService] 所有者単位の予約済み共有通知の取消に失敗しました", e);
    allOk = false;
  }

  try {
    // REVISE対応（P1-4）: 対応表に見つからない（保存失敗・破損等で対応表から漏れた）
    // 予約済み通知も、OS予約一覧のcontent.data.ownerUserIdから直接検索して取り消す。
    // 対応表経由で既に取り消し済みのものが再度ここでヒットしても、cancelOsNotification
    // 自体が冪等（既に取消済み・存在しないIDへの取消は安全に無視される）のため無害。
    // REVISE対応（第6ラウンド、P1-3）: 一覧取得自体が失敗した場合も「完了していない」扱いにする
    // （空配列へのフォールバックは行わない厳格版を使う）。
    const osRequests = await getAllScheduledNotificationsAsyncStrict();
    const toCancel = osRequests.filter((req) => {
      const data = req.content?.data as
        | { scope?: string; ownerUserId?: string; sessionInstanceId?: string }
        | undefined;
      if (data?.scope !== "shared" || data?.ownerUserId !== ownerUserId) return false;
      if (sessionInstanceId && data?.sessionInstanceId !== sessionInstanceId) return false;
      return true;
    });
    const results = await Promise.all(toCancel.map((req) => cancelOsNotification(req.identifier)));
    if (!results.every(Boolean)) allOk = false;
  } catch (e) {
    console.warn("[notificationService] OS予約一覧からの所有者単位取消に失敗しました", e);
    allOk = false;
  }

  try {
    // REVISE対応（第6ラウンド、P1-3）: 表示済み一覧の取得自体が失敗した場合も
    // 「完了していない」扱いにする（空配列へのフォールバックは行わない）。
    const presented = await Notifications.getPresentedNotificationsAsync();
    const toDismiss = presented.filter((n) => {
      const data = n.request.content?.data as
        | { scope?: string; ownerUserId?: string; sessionInstanceId?: string }
        | undefined;
      if (data?.scope !== "shared" || data?.ownerUserId !== ownerUserId) return false;
      if (sessionInstanceId && data?.sessionInstanceId !== sessionInstanceId) return false;
      return true;
    });
    const results = await Promise.all(
      toDismiss.map((n) =>
        Notifications.dismissNotificationAsync(n.request.identifier)
          .then(() => true)
          .catch(() => false)
      )
    );
    if (!results.every(Boolean)) allOk = false;
  } catch (e) {
    console.warn("[notificationService] 表示済み共有通知の削除に失敗しました", e);
    allOk = false;
  }

  try {
    if (sessionInstanceId) {
      if (allOk) {
        await removePendingIdentityCleanup(ownerUserId, sessionInstanceId);
      } else {
        await addPendingIdentityCleanup(ownerUserId, sessionInstanceId);
      }
    } else {
      if (allOk) {
        await removePendingOwnerCleanup(ownerUserId);
      } else {
        await addPendingOwnerCleanup(ownerUserId);
      }
    }
  } catch (e) {
    console.warn("[notificationService] 所有者単位クリーンアップの進捗記録に失敗しました", e);
  }

  return allOk;
}

/**
 * REVISE対応（第6ラウンド、P1-3）: 過去に`cancelAllSharedNotificationsForOwner`が
 * 全段階を完了できなかったターゲットについて、再試行する。アプリ初期化時・AppState「active」
 * 復帰時・次の所有者切替確定直後の3箇所から呼ぶ想定（要求どおり）。1件ずつ順番に
 * 再試行し（同時に大量のターゲットを並行処理して他のOS操作と輻輳させないため）、
 * 途中で例外が起きても残りのターゲットの再試行は継続する。例外は外へ投げない。
 * REVISE対応（第9ラウンド、P1-1）: `identity`種別のターゲットはセッション指定で、
 * `legacy-owner`種別のターゲットは従来どおり全セッション対象で再試行する。
 */
export async function retryPendingOwnerNotificationCleanups(): Promise<void> {
  let pending: PendingOwnerCleanupTarget[];
  try {
    pending = await getPendingOwnerCleanupTargets();
  } catch (e) {
    console.warn("[notificationService] 未完了の所有者クリーンアップ一覧の読込みに失敗しました", e);
    return;
  }
  for (const target of pending) {
    try {
      if (target.kind === "identity") {
        await cancelAllSharedNotificationsForOwner(target.ownerUserId, target.sessionInstanceId);
      } else {
        await cancelAllSharedNotificationsForOwner(target.ownerUserId);
      }
    } catch (e) {
      console.warn("[notificationService] 所有者単位クリーンアップの再試行に失敗しました", e);
    }
  }
}

/**
 * [P0124 QA-F073 / DATA-F073-004] OSの通知1件を、対応表エントリへ復元する。
 *
 * - `ignore`: 対応表が管理する通知ではない（集中タイマー`kind:"focus-timer"`、
 *   schemaVersionを持たない旧形式など）。除外しても対応表の完全性は損なわれない。
 * - `invalid`: **v3を名乗っているのに**論理キー生成に必要なfieldを欠く／identifierが空。
 *   黙って捨てると「取り消せない孤児通知」を生んだまま正常なregistryをcommitすることになるため、
 *   呼び出し元は再構築全体を中止する。
 */
type OsRegistryRecoveryResult =
  | { kind: "entry"; key: string; entry: NotificationRegistryEntry }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: string };

function recoverRegistryEntryFromOsPayload(
  identifier: unknown,
  data: unknown
): OsRegistryRecoveryResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { kind: "ignore" };
  const d = data as Record<string, unknown>;
  // schemaVersion 3 を名乗らないものは対応表の管理対象外（focus-timer等）。
  if (d.schemaVersion !== 3) return { kind: "ignore" };

  if (typeof identifier !== "string" || identifier.length === 0) {
    return { kind: "invalid", reason: "empty_identifier" };
  }
  if (typeof d.eventId !== "string" || d.eventId.length === 0) {
    return { kind: "invalid", reason: "missing_eventId" };
  }
  const slot = d.slot as NotificationSlot;
  if (!ALL_NOTIFICATION_SLOTS.includes(slot)) {
    return { kind: "invalid", reason: "invalid_slot" };
  }
  if (d.scope === "local") {
    const ownership: NotificationOwnership = { scope: "local" };
    return {
      kind: "entry",
      key: notificationLogicalKey(ownership, d.eventId, slot),
      entry: {
        schemaVersion: 3,
        scope: "local",
        eventId: d.eventId,
        slot,
        notificationId: identifier,
      },
    };
  }
  if (d.scope === "shared") {
    if (
      typeof d.ownerUserId !== "string" ||
      d.ownerUserId.length === 0 ||
      typeof d.sessionInstanceId !== "string" ||
      d.sessionInstanceId.length === 0
    ) {
      return { kind: "invalid", reason: "missing_shared_identity" };
    }
    // 所有者は**OSペイロードから復元**する（現在ログイン中のユーザーを刻印しない）。
    // これによりrepair中にA→Bへ切り替わっても、Aの通知はAの帰属のまま再構築される。
    const ownership: NotificationOwnership = {
      scope: "shared",
      ownerUserId: d.ownerUserId,
      sessionInstanceId: d.sessionInstanceId,
    };
    return {
      kind: "entry",
      key: notificationLogicalKey(ownership, d.eventId, slot),
      entry: {
        schemaVersion: 3,
        scope: "shared",
        ownerUserId: d.ownerUserId,
        sessionInstanceId: d.sessionInstanceId,
        eventId: d.eventId,
        slot,
        notificationId: identifier,
      },
    };
  }
  return { kind: "invalid", reason: "invalid_scope" };
}

/**
 * [P0124 QA-F073 / DATA-F073-004] OSの予約済み・表示済み一覧から対応表を再構築する。
 *
 * 必要なOS列挙が**すべて**成功した場合にのみ再構築する。片方だけ成功した結果で書き直すと、
 * 失敗した側にしか残っていない自分の通知が対応表から脱落し、取り消せない孤児通知になる。
 */
async function rebuildNotificationRegistryFromOsState(): Promise<NotificationRegistryRebuildOutcome> {
  let scheduled: Notifications.NotificationRequest[];
  try {
    scheduled = await getAllScheduledNotificationsAsyncStrict();
  } catch (e) {
    return { kind: "abort", reason: `scheduled_enumeration_failed: ${String(e)}` };
  }
  let presented: Notifications.Notification[];
  try {
    presented = await Notifications.getPresentedNotificationsAsync();
  } catch (e) {
    return { kind: "abort", reason: `presented_enumeration_failed: ${String(e)}` };
  }

  const registry: NotificationRegistry = {};
  // 対応表のInvariantは logicalKey -> identifier / identifier -> logicalKey の**両方向1対1**。
  // 同じOS identifierが2つの論理キーへ割り当てられた状態を許すと、片方をcancelした時点で
  // もう片方のentryも実体を失い（同じ通知を指しているため）、対応表の整合性が壊れる。
  const keyByIdentifier = new Map<string, string>();
  const sources: { identifier: unknown; data: unknown }[] = [
    ...scheduled.map((r) => ({ identifier: r.identifier, data: r.content?.data })),
    ...presented.map((n) => ({ identifier: n.request.identifier, data: n.request.content?.data })),
  ];

  for (const source of sources) {
    const recovered = recoverRegistryEntryFromOsPayload(source.identifier, source.data);
    if (recovered.kind === "ignore") continue;
    if (recovered.kind === "invalid") {
      return { kind: "abort", reason: `invalid_v3_payload: ${recovered.reason}` };
    }
    const existing = registry[recovered.key];
    if (existing) {
      // 同一通知が予約済み・表示済みの両方に現れる場合は同じidentifierになる（重複排除）。
      if (existing.notificationId !== recovered.entry.notificationId) {
        // 同じ論理キーに異なるidentifier＝どちらが正本か判断できない。
        // 黙ってlast-winsで倒すと、もう一方が取り消せない孤児通知として残る。
        return { kind: "abort", reason: `conflicting_identifiers_for_key: ${recovered.key}` };
      }
      continue;
    }
    const priorKey = keyByIdentifier.get(recovered.entry.notificationId);
    if (priorKey !== undefined && priorKey !== recovered.key) {
      // 逆方向の衝突: 同じidentifierが複数の論理キーへ割り当てられている。
      return {
        kind: "abort",
        reason: `identifier_mapped_to_multiple_keys: ${recovered.entry.notificationId}`,
      };
    }
    registry[recovered.key] = recovered.entry;
    keyByIdentifier.set(recovered.entry.notificationId, recovered.key);
  }
  return { kind: "rebuilt", registry };
}

/**
 * [P0124 QA-F073 / DATA-F073-004] 対応表が破損確定している場合のみ、OS状態から再構築する。
 * 破損していない・I/Oエラー・再構築を中止した場合は何も書き込まない。例外は外へ投げない。
 * `retryPendingOwnerNotificationCleanups`と同じ契機（初期化時・AppState「active」復帰時・
 * 所有者切替確定直後）から呼ぶ想定。
 */
export async function repairCorruptNotificationRegistryIfNeeded(): Promise<NotificationRegistryRepairResult> {
  try {
    const result = await repairCorruptNotificationRegistryExclusively(
      rebuildNotificationRegistryFromOsState
    );
    if (__DEV__ && result === "aborted") {
      console.warn("[notificationService] 対応表の再構築を中止しました（破損値は保持）");
    }
    return result;
  } catch (e) {
    console.warn("[notificationService] 対応表の破損復旧に失敗しました", e);
    return "aborted";
  }
}

/** REVISE対応（第9ラウンド、P1-1）: OSメタデータから発見した1件の共有通知の所有者・セッション。 */
export interface SharedNotificationIdentity {
  ownerUserId: string;
  sessionInstanceId: string;
}

/**
 * REVISE対応（第9ラウンド、P1-1）: 予約済み一覧・表示済み一覧それぞれの取得が実際に
 * 成功したかを呼び出し元（coordinatorの起動時hydrate）が判定できるようにする。
 * 以前の`discoverSharedOwnerIdsFromOsMetadata`は、どちらか一方（または両方）のOS一覧
 * 取得に失敗しても、取得できた方の結果だけで静かに処理を続行し、呼び出し元はこの関数の
 * 戻り値だけでは「本当に完全な調査ができたか」を判別できなかった。
 * `scheduledScanSucceeded`/`presentedScanSucceeded`のいずれかがfalseの場合、
 * 発見結果（`identities`）は不完全である可能性があり、呼び出し元はhydrateを
 * fail-closedで停止すべきである。
 */
export interface SharedNotificationDiscoveryResult {
  identities: SharedNotificationIdentity[];
  scheduledScanSucceeded: boolean;
  presentedScanSucceeded: boolean;
}

function extractSharedNotificationIdentity(data: unknown): SharedNotificationIdentity | null {
  const d = data as
    | { schemaVersion?: number; scope?: string; ownerUserId?: string; sessionInstanceId?: string }
    | undefined;
  if (
    d?.schemaVersion === 3 &&
    d?.scope === "shared" &&
    typeof d.ownerUserId === "string" &&
    d.ownerUserId.length > 0 &&
    typeof d.sessionInstanceId === "string" &&
    d.sessionInstanceId.length > 0
  ) {
    return { ownerUserId: d.ownerUserId, sessionInstanceId: d.sessionInstanceId };
  }
  return null;
}

/**
 * SEC-F007-001 REVISE対応（第8ラウンド、P1-2 → 第9ラウンド、P1-1で完全化）: 永続化された
 * pending一覧（`pendingOwnerNotificationCleanup`）は、`addPendingOwnerCleanup`自体の
 * 書込みが失敗していた場合には対象を記録できていない可能性がある。OSの予約済み・表示済み
 * 通知のcontent.data（V3スキーマ、`scope==="shared"`・`ownerUserId`・`sessionInstanceId`を
 * 含む）を直接列挙し、pending一覧だけでは見つからない残留を、所有者だけでなく
 * どの認証セッション時点のものかまで含めて発見できるようにする
 * （sharedNotificationCoordinatorの起動時hydrateから、pending一覧と合わせて使う）。
 * 以前はownerUserIdのみを返しており、呼び出し元が「現在のidentityと同じownerUserIdなら
 * 除外してよい」と誤って判断できてしまう構造だった（同一ユーザーの別セッションの残留が
 * 誤って自分自身の正常な通知として除外される恐れがあった）ため、sessionInstanceIdまで
 * 含めた完全なidentityを返すよう変更した。除外の判断（現在identityと完全一致するかどうか）は
 * 引き続き呼び出し元が行う（この関数自体はidentityを一切参照しない、純粋なOS状態の
 * 列挙のみ）。予約済み一覧・表示済み一覧それぞれの取得成否も返す
 * （`SharedNotificationDiscoveryResult`参照）。
 */
export async function discoverSharedNotificationIdentitiesFromOsMetadata(): Promise<SharedNotificationDiscoveryResult> {
  const identities = new Map<string, SharedNotificationIdentity>();
  let scheduledScanSucceeded = true;
  let presentedScanSucceeded = true;

  try {
    const osRequests = await getAllScheduledNotificationsAsyncStrict();
    for (const req of osRequests) {
      const identity = extractSharedNotificationIdentity(req.content?.data);
      if (identity) identities.set(`${identity.ownerUserId}:${identity.sessionInstanceId}`, identity);
    }
  } catch (e) {
    console.warn("[notificationService] OS予約一覧からの共有所有者検出に失敗しました", e);
    scheduledScanSucceeded = false;
  }
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented) {
      const identity = extractSharedNotificationIdentity(n.request.content?.data);
      if (identity) identities.set(`${identity.ownerUserId}:${identity.sessionInstanceId}`, identity);
    }
  } catch (e) {
    console.warn("[notificationService] 表示済み一覧からの共有所有者検出に失敗しました", e);
    presentedScanSucceeded = false;
  }
  return {
    identities: Array.from(identities.values()),
    scheduledScanSucceeded,
    presentedScanSucceeded,
  };
}

/**
 * Stage I-5: 集中タイマー（FocusSession）の終了通知。
 *
 * カレンダー予定の通知（scheduleNotification/cancelNotification/reconcileNotifications、
 * notificationRepositoryのeventId対応表、content.data.eventId、H-6の
 * MAX_SCHEDULED_NOTIFICATIONS件ローリングウィンドウ）とは目的・ライフサイクルが異なるため、
 * 完全に分離する：
 * - 通知IDは`focusTimerNotificationId`という別のAsyncStorageキー（focusSessionRepository経由）
 *   にのみ保持し、notificationRepositoryのeventId対応表には一切書き込まない
 * - 予約時のcontent.dataは `{ kind: "focus-timer", focusSessionId }` とし、eventIdは使わない
 * - ローリングウィンドウ（50件）の対象に含めない（そもそもOS予約一覧を照合しない設計。
 *   集中タイマーは同時に1セッションしか存在しない前提のため、単一IDの
 *   「取消してから予約」だけで二重予約を防げ、OS一覧との突き合わせは不要と判断した）
 *
 * 直列化: pause→resumeの連打や、状態復元とアプリ復帰が重なるケースを考慮し、
 * AppDataContext/H-6のreconcileNotifications用チェーンとは別の、Focus専用の単一Promise
 * チェーンで直列化する（混在させない）。
 */
function getFocusSessionEndDate(session: FocusSession): Date {
  const startedMs = session.actualStartedAt
    ? new Date(session.actualStartedAt).getTime()
    : Date.now();
  // 累積の一時停止時間ぶんだけ終了予定時刻を後ろへずらす（actualStartedAt自体は不変のため、
  // ここで明示的に加算する。以前はresume時にstartedAtそのものをずらすトリックで
  // 同じ効果を得ていたが、今回actualStartedAtを不変にしたため計算側で吸収する）。
  return new Date(startedMs + session.plannedDurationMs + session.totalPausedDurationMs);
}

let focusNotificationChain: Promise<void> = Promise.resolve();

function runFocusNotificationTask(task: () => Promise<void>): Promise<void> {
  const run = focusNotificationChain.then(task);
  focusNotificationChain = run.catch(() => undefined);
  return run;
}

async function cancelFocusTimerEndNotificationInternal(): Promise<void> {
  try {
    const notificationId = await getFocusTimerNotificationId();
    if (notificationId) {
      await Notifications.cancelScheduledNotificationAsync(notificationId);
    }
  } catch (e) {
    console.warn("[notificationService] Focusタイマー終了通知の取消に失敗しました", e);
  }
  try {
    await clearFocusTimerNotificationId();
  } catch (e) {
    console.warn("[notificationService] Focusタイマー終了通知IDの削除に失敗しました", e);
  }
}

async function scheduleFocusTimerEndNotificationInternal(
  session: FocusSession
): Promise<void> {
  // 既存の予約は必ず先に取り消してから判定し直す（1セッションにつき通知は常に1件。
  // pause→resumeの再予約や、誤って複数回startされた場合も二重予約を防ぐ）。
  await cancelFocusTimerEndNotificationInternal();
  try {
    // 予約API呼び出し自体は失敗しても外へ投げないが、無駄な呼び出しを避けられるよう
    // 権限が無い場合はここで早期終了する（テスト容易性のため明示的に判定する）。
    const permission = await getNotificationPermissionStatusAsync();
    if (permission !== "granted") return;

    const endDate = getFocusSessionEndDate(session);
    if (endDate.getTime() <= Date.now()) return;

    const locale = await currentLocale();
    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: translate(locale, "notification.focusEndTitle"),
        body: translate(locale, "notification.focusEndBody"),
        // カレンダー通知のeventIdとは明確に区別する識別データ。
        data: { kind: "focus-timer", focusSessionId: session.id },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: endDate,
        channelId: ANDROID_DEFAULT_CHANNEL_ID,
      },
    });
    await saveFocusTimerNotificationId(notificationId);
  } catch (e) {
    console.warn("[notificationService] Focusタイマー終了通知の予約に失敗しました", e);
  }
}

async function reconcileFocusTimerNotificationInternal(
  session: FocusSession | null
): Promise<void> {
  if (!session || session.status !== "running") {
    // Active Sessionが無い、または一時停止中は、残存する通知を取り消すだけでよい
    // （一時停止中は新たに予約しない）。
    await cancelFocusTimerEndNotificationInternal();
    return;
  }
  // 実行中セッションについては、予約処理自体が「取消してから未来のみ予約」を保証するため、
  // 終了時刻を過ぎていれば自動的に取消のみで終わる（過去時刻への新規予約は行われない）。
  await scheduleFocusTimerEndNotificationInternal(session);
}

/**
 * 実行中の集中セッションに対して、終了予定時刻(startedAt + durationMinutes)へ
 * ローカル通知を1件予約する。呼び出し前に必ず既存の予約を取り消してから判定するため、
 * start()/resume()のどちらから呼んでも二重予約は起きない。例外は一切外へ投げない。
 */
export function scheduleFocusTimerEndNotification(
  session: FocusSession
): Promise<void> {
  return runFocusNotificationTask(() =>
    scheduleFocusTimerEndNotificationInternal(session)
  );
}

/**
 * 予約中のFocusタイマー終了通知を取り消す（pause/complete/cancel、Active Session消失時に使用）。
 * 対応する予約が無い場合も含め、例外を投げずに正常終了する。
 */
export function cancelFocusTimerEndNotification(): Promise<void> {
  return runFocusNotificationTask(() => cancelFocusTimerEndNotificationInternal());
}

/**
 * アプリ再起動時の状態復元・フォアグラウンド復帰時に、現在のFocusSessionの状態へ
 * Focusタイマー終了通知を整合させる。
 * - running かつ 終了時刻が未来: 再予約（取消→予約）
 * - running かつ 終了時刻が過去: 取消のみ
 * - paused: 取消のみ（予約しない）
 * - Active Sessionなし（null）: 残存通知を取消
 */
export function reconcileFocusTimerNotification(
  session: FocusSession | null
): Promise<void> {
  return runFocusNotificationTask(() =>
    reconcileFocusTimerNotificationInternal(session)
  );
}
