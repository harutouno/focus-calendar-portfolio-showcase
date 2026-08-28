import { AppEvent } from "@/types/event";
import {
  deleteEvent as deleteEventFromStorage,
  deleteEvents as deleteEventsFromStorage,
  saveEvent as saveEventToStorage,
  saveEvents as saveEventsToStorage,
} from "@/storage/eventsRepository";
import {
  BulkUpsertResult,
  SHARED_EVENT_DELETE_BLOCKED_MESSAGE,
  deleteSharedEvent,
  deleteSharedEventsBulk,
  upsertSharedEvent,
  upsertSharedEventsBulk,
} from "@/services/sharedEventsService";
import {
  NotificationScheduleOutcome,
  scheduleNotificationRequestingPermission,
  scheduleNotificationsRequestingPermission,
} from "@/services/notificationService";
import { EnqueueOutcome } from "@/hooks/useSyncQueueProcessor";
import { runCurrentSharedMutation } from "@/auth/sharedMutationIdentity";
import { SharedMutationAuthSnapshot } from "@/auth/sharedMutationAuthSnapshot";

/**
 * 「ローカル予定か共有カレンダーの予定か」の分岐・実際のRepository/Supabase呼び出し・
 * オフライン同期キュー投入を集約するサービス。元々AppDataContext.tsxに直接書かれていた
 * ロジックをそのまま移設したもので、挙動（成功/失敗時の分岐順序）は一切変えていない。
 *
 * Reactの状態更新（setLocalEvents/handleRemoteEventChange等）・通知拒否時のAlert表示は、
 * UI寄りの責務としてAppDataContext.tsx側に残している。
 *
 * SEC-F007-001 Stage 2: 共有予定（saveSharedEvent/saveSharedEventsBulk/removeSharedEvent/
 * removeSharedEventsBulk）は通知に一切触れない設計へ変更した（以前はここで
 * scheduleNotificationRequestingPermission等を直接呼んでいたが、同じ共有通知を操作する
 * writerが複数存在する状態を避けるため、通知操作はsharedNotificationCoordinator経由で
 * AppDataContext.tsx側が行う）。ローカル予定（saveLocalEvent/saveLocalEventsBulk）は
 * 従来どおりこのファイル内で直接通知を予約する（ローカル予定は認証ユーザーと無関係な
 * 端末内データのため、所有者ガードの対象外）。
 */

export interface SaveEventDeps {
  /**
   * REVISE対応（第8ラウンド、P2）: 呼び出し元（AppDataContext.tsx）が固定した
   * userId/sessionInstanceIdを、この関数自身が権威あるauthSessionIdentityStoreと
   * 照合するために使う（呼び出し元の申告をそのまま信頼しない）。
   * [P0080 AUTH-F013-F017-001] identityだけでなく、呼び出し元がこの論理的な操作の
   * 開始時点で1回だけ捕捉したaccess_token（SharedMutationAuthSnapshot）も運ぶ。
   * このオブジェクト自体をAsyncStorage・同期キューレコード・ログへ書き込んではならない
   * （userId/sessionInstanceIdだけが必要な箇所ではauth.userId/auth.sessionInstanceIdを
   * 個別に使う）。
   */
  auth: SharedMutationAuthSnapshot;
  enqueueUpsert: (event: AppEvent, ownerUserId: string, sessionInstanceId: string) => Promise<EnqueueOutcome>;
}

/**
 * 共有カレンダーの予定を保存する。保存の成否（"saved" | "enqueued" | "discarded-stale" |
 * "stale-cleanup-pending"）を返す。通知の予約はここでは行わない（呼び出し元が
 * sharedNotificationCoordinator経由で行う）。保存に失敗した場合はオフラインキューへ
 * 積みを試み、"enqueued" を返す。
 * REVISE対応（第8ラウンド、P2）: リモート呼出し（upsertSharedEvent）を開始する直前に、
 * deps.identityを権威あるauthSessionIdentityStoreと照合する。呼び出し元
 * （AppDataContext.tsx）が既に開始前チェックを行っていても、eventService自身が
 * 呼び出し元の申告するuserId/sessionInstanceIdをそのまま信頼せず独立に検証することで、
 * 将来の呼び出し元（未使用のcalendarFacade経由等）がこの検証を迂回できないようにする。
 * 一致しない場合は例外を投げ、Supabaseへのリクエスト自体を送らない
 * （enqueueUpsertへのフォールバックも行わない——開始時点で既にstaleなら、
 * オフラインキューへの後始末は呼び出し元のassertStillCurrentOwner相当の判定に委ねる）。
 * REVISE対応（P1-2）: enqueueUpsertへは、この操作を開始した時点で捕捉済みの
 * deps.identityをそのまま渡す（enqueueUpsert自身が「今現在の」認証identityを
 * 読み直すことはない設計のため、upsertSharedEventの失敗を待っている間にユーザー・
 * セッションが切り替わっていても、この操作の本来の所有者として正しく記録される）。
 * REVISE対応（第6ラウンド、P1-1）: 以前はenqueueUpsertの戻り値（EnqueueOutcome）を
 * 無視し、常に"enqueued"を返していた。identityが既に切り替わっていてenqueueUpsert自体が
 * "discarded-stale"（Storageへ一切書き込まない）を返した場合でも、この関数が"enqueued"を
 * 返してしまうと、呼び出し元は実際には失われた変更を「後で同期される」と誤認する
 * （静かなデータ消失）。実際の結果をそのまま呼び出し元へ伝播させる。
 * REVISE対応（第7ラウンド、P1-1）: enqueueUpsertが"stale-cleanup-pending"（補償削除自体の
 * 失敗）を返す場合も、そのまま呼び出し元へ伝播させる（"enqueued"や"saved"として
 * 握りつぶさない）。
 * REVISE対応（第9ラウンド、P1-2）: 以前はremote呼出し前の1回しかidentityを確認しなかった。
 * upsertSharedEventの完了（成功/失敗いずれも）後、"saved"を返す前・enqueueUpsert
 * （後続副作用）へ進む前の共通の1箇所でも改めて確認する（identity変化後は
 * どちらの分岐にも進まない）。
 */
export async function saveSharedEvent(
  event: AppEvent,
  deps: SaveEventDeps
): Promise<"saved" | "enqueued" | "discarded-stale" | "stale-cleanup-pending"> {
  return runCurrentSharedMutation(deps.auth, async (assertCurrent) => {
    let saved = false;
    try {
      await upsertSharedEvent(event, deps.auth);
      saved = true;
    } catch {
      // 保存自体の失敗はここでは判定せず、下のassertCurrentの後にenqueueUpsertへ委ねる。
    }
    assertCurrent();
    if (saved) return "saved";
    return await deps.enqueueUpsert(event, deps.auth.userId, deps.auth.sessionInstanceId);
  });
}

export async function saveLocalEvent(
  event: AppEvent
): Promise<{ events: AppEvent[]; notificationOutcome: NotificationScheduleOutcome }> {
  const events = await saveEventToStorage(event);
  const notificationOutcome = await scheduleNotificationRequestingPermission(event);
  return { events, notificationOutcome };
}

export interface SaveEventsBulkDeps {
  /**
   * REVISE対応（第8ラウンド、P2）: saveSharedEventと同じ理由でidentityを要求する。
   * [P0080 AUTH-F013-F017-001] saveSharedEventと同じくSharedMutationAuthSnapshotを運ぶ。
   */
  auth: SharedMutationAuthSnapshot;
  enqueueUpsert: (event: AppEvent, ownerUserId: string, sessionInstanceId: string) => Promise<EnqueueOutcome>;
}

/**
 * REVISE対応（第6ラウンド、P1-1）: 一括保存/一括削除がオフラインキューへ積みを試みた結果の内訳。
 * REVISE対応（第7ラウンド、P1-1）: discardedStaleCountは"discarded-stale"（確実にStorageへ
 * 保存されなかった）と"stale-cleanup-pending"（保存はされなかったが、その後の補償削除自体が
 * 失敗し、選択的purgeによる後始末が保留中）の両方を合算する——いずれも「この操作は
 * 完了しなかった」という呼び出し元・UI向けの意味では同じ扱いにする（"保存されなかった"
 * という警告メッセージの対象であり、"enqueued"（＝後で同期される）とは区別する）。
 */
export interface BulkQueueOutcome {
  enqueuedCount: number;
  discardedStaleCount: number;
}

const EMPTY_QUEUE_OUTCOME: BulkQueueOutcome = { enqueuedCount: 0, discardedStaleCount: 0 };

function tallyQueueOutcomes(outcomes: EnqueueOutcome[]): BulkQueueOutcome {
  return {
    enqueuedCount: outcomes.filter((o) => o === "enqueued").length,
    discardedStaleCount: outcomes.filter(
      (o) => o === "discarded-stale" || o === "stale-cleanup-pending"
    ).length,
  };
}

/**
 * 共有カレンダーへの一括保存。保存結果（BulkUpsertResult）に加え、オフラインキューへの
 * 積み込み内訳（BulkQueueOutcome）を返す。通知の予約はここでは行わない（呼び出し元が
 * sharedNotificationCoordinator経由で行う）。一部失敗時はオフラインキューへ積みを試みる
 * （deps.userId・deps.sessionInstanceId＝この操作を開始した時点の所有者・セッションを
 * そのまま渡す。理由はsaveSharedEventと同じ）。
 * REVISE対応（第6ラウンド、P1-1）: 以前は各enqueueUpsert呼び出しの結果（EnqueueOutcome）を
 * 一切確認せず、"失敗件数がある＝いずれキューから再送される"と暗黙に扱っていた。identityが
 * 途中で切り替わった一部の予定はStorageへ書き込まれず（"discarded-stale"）、実際には
 * 失われる。呼び出し元がこの内訳を見て「後で同期される」と「保存されなかった」を
 * 区別できるよう、enqueuedCount・discardedStaleCountを個別に集計して返す。
 * REVISE対応（第9ラウンド、P1-2）: upsertSharedEventsBulk完了後、結果を返す前・
 * enqueueUpsert（後続副作用）へ進む前の共通の1箇所でidentityを再確認する。
 */
export async function saveSharedEventsBulk(
  events: AppEvent[],
  deps: SaveEventsBulkDeps
): Promise<{ result: BulkUpsertResult; queueOutcome: BulkQueueOutcome }> {
  return runCurrentSharedMutation(deps.auth, async (assertCurrent) => {
    const result = await upsertSharedEventsBulk(events, deps.auth);
    assertCurrent();
    if (result.failureCount === 0) {
      return { result, queueOutcome: EMPTY_QUEUE_OUTCOME };
    }
    const outcomes = await Promise.all(
      events.map((e) => deps.enqueueUpsert(e, deps.auth.userId, deps.auth.sessionInstanceId))
    );
    return { result, queueOutcome: tallyQueueOutcomes(outcomes) };
  });
}

export async function saveLocalEventsBulk(
  events: AppEvent[]
): Promise<{ events: AppEvent[]; notificationOutcome: NotificationScheduleOutcome }> {
  const next = await saveEventsToStorage(events);
  const notificationOutcome = await scheduleNotificationsRequestingPermission(events);
  return { events: next, notificationOutcome };
}

export interface RemoveEventDeps {
  /**
   * REVISE対応（第8ラウンド、P2）: removeSharedEvent自身がSupabase呼出し前に検証する。
   * [P0080 AUTH-F013-F017-001] SharedMutationAuthSnapshotを運ぶ。
   */
  auth: SharedMutationAuthSnapshot;
  enqueueDelete: (
    id: string,
    calendarId: string,
    ownerUserId: string,
    sessionInstanceId: string
  ) => Promise<EnqueueOutcome>;
}

/**
 * 共有カレンダーの予定を削除する。失敗時はオフラインキューへ積みを試みる（例外は投げない）。
 * 結果は"deleted"（即時削除に成功、または既に存在しないことを確認できた＝目的の終端状態を
 * 確認済み）・"enqueued"（キューへ積めた）・"discarded-stale"（identity変化により削除も
 * キュー保存もできなかった）・"stale-cleanup-pending"（同じくidentity変化で削除・保存は
 * できなかったが、補償削除自体も失敗し後始末が保留中）・"definite-failure"（[P0080 F015]
 * 削除がRLSにより確実にブロックされたことが確認できた——権限喪失等、リトライしても
 * 同じ理由で永久に失敗し続けるため、enqueueDeleteへは進まない）のいずれかを返す。
 * REVISE対応（第6ラウンド、P1-1）: 以前はenqueueDeleteの戻り値を無視しPromise<void>を
 * 返していたため、呼び出し元は"discarded-stale"の場合でも削除が完了した（または
 * いずれ完了する）ものとして扱ってしまっていた。
 * REVISE対応（第7ラウンド、P1-1）: "stale-cleanup-pending"もそのまま伝播させる。
 * REVISE対応（第9ラウンド、P1-2）: deleteSharedEvent完了後、"deleted"を返す前・
 * enqueueDelete（後続副作用）へ進む前の共通の1箇所でidentityを再確認する。
 * [P0080 F015] deleteSharedEventがSHARED_EVENT_DELETE_BLOCKED_MESSAGEを投げた場合は、
 * 他の例外（ネットワーク断等の一過性障害——キューへ積んでのリトライが正しい）と区別し、
 * "definite-failure"として即座に返す（enqueueDeleteを一切呼ばない——ブロックされた削除を
 * キューに積んでも、権限が戻らない限り毎回同じ理由で失敗し続けるだけの無意味な永久
 * リトライになるため）。
 */
export async function removeSharedEvent(
  id: string,
  calendarId: string,
  deps: RemoveEventDeps
): Promise<"deleted" | "enqueued" | "discarded-stale" | "stale-cleanup-pending" | "definite-failure"> {
  return runCurrentSharedMutation(deps.auth, async (assertCurrent) => {
    let deleted = false;
    let blocked = false;
    try {
      await deleteSharedEvent(id, deps.auth);
      deleted = true;
    } catch (e) {
      if (e instanceof Error && e.message === SHARED_EVENT_DELETE_BLOCKED_MESSAGE) {
        blocked = true;
      }
      // それ以外の失敗はここでは判定せず、下のassertCurrentの後にenqueueDeleteへ委ねる。
    }
    assertCurrent();
    if (deleted) return "deleted";
    if (blocked) return "definite-failure";
    return await deps.enqueueDelete(id, calendarId, deps.auth.userId, deps.auth.sessionInstanceId);
  });
}

/**
 * DATA-F002-003: 予定本体の永続化削除が成功した後にだけ、端末内添付ファイルを清掃する
 * （deleteEventFromStorageが失敗すればここへは到達しない＝削除成功が前提条件）。
 * 清掃自体の失敗は削除済み予定を復活させる理由にはしない——孤立ファイルを残して
 * 安全側に倒し、呼び出し元へは予定削除自体の成功をそのまま返す。
 */
export async function removeLocalEvent(id: string): Promise<AppEvent[]> {
  return deleteEventFromStorage(id);
}

export interface RemoveEventsBulkDeps {
  /**
   * REVISE対応（第8ラウンド、P2）: removeSharedEventsBulk自身がSupabase呼出し前に検証する。
   * [P0080 AUTH-F013-F017-001] SharedMutationAuthSnapshotを運ぶ。
   */
  auth: SharedMutationAuthSnapshot;
  enqueueDelete: (
    id: string,
    calendarId: string,
    ownerUserId: string,
    sessionInstanceId: string
  ) => Promise<EnqueueOutcome>;
}

/**
 * [P0084 ROBUST-F015-002] 各対象event IDが実際にどうなったかを表す。呼び出し元
 * （AppDataContext.removeRecurringEvents）はこの結果からID単位で「ローカル削除を
 * authoritativeのまま維持してよいか（deleted/enqueued）」「復元が必要か
 * （それ以外すべて）」を判断する。集計値（successCount/failureCount）だけでは
 * どのIDが成功したかを一意に特定できないため、正本§2「Aggregate ... is not enough
 * unless it can be mapped exactly back to event IDs」に対応する。
 */
export type BulkDeleteTargetOutcome = "deleted" | "enqueued" | "definite-failure" | "unknown-not-durable";

/**
 * 共有カレンダーの繰り返し予定（following/all）を一括削除する。一部失敗時はオフラインキューへ
 * 積みを試みる。
 * [P0084 ROBUST-F015-002] 以前は集計値（BulkUpsertResult・BulkQueueOutcome・blocked）
 * だけを返しており、呼び出し元は「一部のenqueueDeleteが失敗した場合にどのIDが
 * 実際に失敗したか」を特定できなかった（Promise.allの結果を集計するだけで、
 * 個々のtargetへの対応付けを破棄していた）。event ID -> 結果、のマップを返すよう
 * 全面的に作り直す。deleteSharedEventsBulkの結果（deletedIds/notDeletedIds/blocked）を
 * 起点に、notDeletedIdsのうちblocked===falseのものだけenqueueDeleteへ個別にフォール
 * バックする（enqueueDelete自体がAsyncStorage書込み失敗等で例外を投げる場合は
 * "unknown-not-durable"として扱う——removeEvent単発分岐の queue storage failure対応と
 * 同じ規約）。
 * REVISE対応（第9ラウンド、P1-2）: deleteSharedEventsBulk完了後、結果を返す前・
 * enqueueDelete（後続副作用）へ進む前の共通の1箇所でidentityを再確認する。
 */
export async function removeSharedEventsBulk(
  targets: { id: string; calendarId: string }[],
  deps: RemoveEventsBulkDeps
): Promise<Record<string, BulkDeleteTargetOutcome>> {
  return runCurrentSharedMutation(deps.auth, async (assertCurrent) => {
    const idToCalendarId = new Map(targets.map((t) => [t.id, t.calendarId]));
    const result = await deleteSharedEventsBulk(Array.from(idToCalendarId.keys()), deps.auth);
    assertCurrent();
    const outcomes: Record<string, BulkDeleteTargetOutcome> = {};
    for (const id of result.deletedIds) outcomes[id] = "deleted";
    if (result.notDeletedIds.length === 0) return outcomes;
    if (result.blocked) {
      for (const id of result.notDeletedIds) outcomes[id] = "definite-failure";
      return outcomes;
    }
    const enqueueResults = await Promise.all(
      result.notDeletedIds.map(async (id) => {
        const calendarId = idToCalendarId.get(id) as string;
        try {
          const outcome = await deps.enqueueDelete(
            id,
            calendarId,
            deps.auth.userId,
            deps.auth.sessionInstanceId
          );
          return { id, outcome };
        } catch {
          return { id, outcome: "unknown-not-durable" as const };
        }
      })
    );
    for (const r of enqueueResults) {
      outcomes[r.id] = r.outcome === "enqueued" ? "enqueued" : "unknown-not-durable";
    }
    return outcomes;
  });
}

/** DATA-F002-003: removeLocalEventと同じ順序（永続化削除が先、添付清掃は後・ベストエフォート）。 */
export async function removeLocalEventsBulk(ids: string[]): Promise<AppEvent[]> {
  return deleteEventsFromStorage(ids);
}
