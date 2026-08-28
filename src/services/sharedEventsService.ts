import { supabase } from "@/lib/supabaseClient";
import {
  AppEvent,
  FocusTask,
  NormalEvent,
  NotificationSetting,
  RepeatSetting,
  UnlockCondition,
} from "@/types/event";
import {
  SharedOperationIdentity,
  assertCurrentSharedMutationIdentity,
} from "@/auth/sharedMutationIdentity";
import {
  SharedMutationAuthSnapshot,
  createPinnedSharedClient,
} from "@/auth/sharedMutationAuthSnapshot";
import { isValidAppEvent } from "@/storage/eventsRepository";
import { StoredDataValidationError } from "@/storage/shapeGuards";

/** Supabase `events` テーブルの行（snake_case） */
interface EventRow {
  id: string;
  calendar_id: string;
  created_by: string;
  kind: "normal" | "focus";
  title: string;
  date: string;
  start_time: string;
  end_time: string | null;
  /**
   * [P0078 CORRECT-F016-001] 終了時刻の暦日。dateと同一日ならnull（このアプリはnullを
   * 「dateと同一」の意味で使う——client側のNormalEvent.endDate===undefinedと対応）。
   */
  end_date: string | null;
  all_day: boolean;
  location: string | null;
  duration_minutes: number | null;
  restricted_apps: string[] | null;
  unlock_condition: UnlockCondition | null;
  notification: NotificationSetting;
  repeat: RepeatSetting;
  memo: string | null;
  completed: boolean;
  /** 一括作成（期間・曜日指定）で同時に生成された予定に共通のID。単発の予定はnull */
  recurring_group_id: string | null;
  /** 同一recurring_group_id内での生成順（0始まり）。単発の予定はnull */
  recurrence_index: number | null;
  created_at: string;
  updated_at: string;
}

const EVENT_COLUMNS =
  "id, calendar_id, created_by, kind, title, date, start_time, end_time, end_date, all_day, location, duration_minutes, restricted_apps, unlock_condition, notification, repeat, memo, completed, recurring_group_id, recurrence_index, created_at, updated_at";

export function rowToAppEvent(row: EventRow): AppEvent {
  const base = {
    id: row.id,
    title: row.title,
    date: row.date,
    startTime: row.start_time,
    notification: row.notification,
    repeat: row.repeat,
    calendarId: row.calendar_id,
    shareWith: [] as string[],
    completed: row.completed,
    memo: row.memo ?? undefined,
    recurringGroupId: row.recurring_group_id ?? undefined,
    recurrenceIndex: row.recurrence_index ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.kind === "focus") {
    const focus: FocusTask = {
      ...base,
      kind: "focus",
      durationMinutes: row.duration_minutes ?? 0,
      restrictedApps: row.restricted_apps ?? [],
      unlockCondition: row.unlock_condition ?? { type: "none" },
    };
    return focus;
  }

  const normal: NormalEvent = {
    ...base,
    kind: "normal",
    endTime: row.end_time ?? row.start_time,
    endDate: row.end_date ?? undefined,
    allDay: row.all_day,
    location: row.location ?? undefined,
  };
  return normal;
}

/**
 * [P0080 DATA-F013-001] eventsRepository.ts（ローカル保存の書込み時防御）と同じ
 * isValidAppEventを、共有カレンダーへのネットワーク送信直前でも再利用する
 * （「壊れた形状の予定をネットワークへ送信しない」という契約を、ローカル保存と
 * 共有保存の両方で同じ判定基準に揃える——正規化はせず、そのまま拒否する）。
 * upsertSharedEvent/upsertSharedEventsBulkの両方がこの関数を経由するため、
 * 呼出し元ごとに検証を重複させる必要がない。
 */
export function appEventToRow(
  event: AppEvent,
  createdBy: string
): Omit<EventRow, "created_at" | "updated_at"> {
  if (!isValidAppEvent(event)) {
    throw new StoredDataValidationError("events", "invalid_write_shape");
  }
  const common = {
    id: event.id,
    calendar_id: event.calendarId,
    created_by: createdBy,
    kind: event.kind,
    title: event.title,
    date: event.date,
    start_time: event.startTime,
    notification: event.notification,
    repeat: event.repeat,
    memo: event.memo ?? null,
    completed: event.completed,
    recurring_group_id: event.recurringGroupId ?? null,
    recurrence_index: event.recurrenceIndex ?? null,
  };

  if (event.kind === "focus") {
    return {
      ...common,
      end_time: null,
      end_date: null,
      all_day: false,
      location: null,
      duration_minutes: event.durationMinutes,
      restricted_apps: event.restrictedApps,
      unlock_condition: event.unlockCondition,
    };
  }

  return {
    ...common,
    end_time: event.endTime,
    end_date: event.endDate ?? null,
    all_day: event.allDay,
    location: event.location ?? null,
    duration_minutes: null,
    restricted_apps: null,
    unlock_condition: null,
  };
}

/**
 * REVISE対応（第11ラウンド、P1-1）: identityを必須にし、remote呼出し前後で検証する。
 * 空配列で早期returnする経路もSupabase通信こそ行わないが、共有読取りAPIとしての契約を
 * 一貫させるため呼出し直後にidentityを確認してから判定する。
 * Round 12（SEC-F007-001残存）: await直後のidentity確認を、`error`の有無を見るより前に
 * 行う（stale化していた場合、通信自体がたまたま成功・失敗のどちらであっても、常にstale専用の
 * 例外を優先して投げる——「stale化」を通常の通信エラー・通常の成功結果のどちらへも
 * 変換しない）。
 */
export async function fetchEventsForCalendars(
  calendarIds: string[],
  identity: SharedOperationIdentity
): Promise<AppEvent[]> {
  assertCurrentSharedMutationIdentity(identity);
  if (calendarIds.length === 0) return [];
  const { data, error } = await supabase
    .from("events")
    .select(EVENT_COLUMNS)
    .in("calendar_id", calendarIds);
  assertCurrentSharedMutationIdentity(identity);
  if (error) throw error;
  return (data as EventRow[]).map(rowToAppEvent);
}

/**
 * upsertは主キー(id)基準のため、同じ内容を再送しても行が重複しない（冪等）。
 * REVISE対応（第10ラウンド、P2）: identityを必須にし、Supabase呼出し直前に権威ある
 * authSessionIdentityStoreと照合する。eventService.ts経由の高レベル呼出しは既に
 * runCurrentSharedMutationで開始前チェック済みだが、この関数自身もチェックすることで、
 * 将来この関数を直接（eventService.tsを経由せず）呼び出すコードが検証を迂回できないよう
 * 閉じる（useSyncQueueProcessor.tsのような既存の直接呼び出し元にも、同じ契約を要求する）。
 * REVISE対応（第11ラウンド、P2）: 以前は`createdBy`を`identity`とは別の引数として
 * 受け取っており、公開APIとしてはidentity=Bのままcreated_by=Aの行を送れてしまう余地が
 * あった（既存の呼び出し元はたまたま同じ値を渡していただけで、契約として保証されていなかった）。
 * `created_by`は常に`identity.userId`から生成するよう一本化し、この余地自体を無くした。
 * あわせて、remote呼出し完了直後にも独立にidentityを再検証する（開始前チェックだけでは、
 * 待機中に切り替わった場合に「行は既に保存されたが呼び出し元へは古いidentityのまま
 * 成功が伝わる」ことを防げないため）。
 * Round 12（SEC-F007-001残存）: この完了直後の再検証を`error`の判定より前に行う
 * （stale化とSupabase側のエラーが同時に起きた場合でも、常にstale専用の例外を優先する）。
 * [P0080 AUTH-F013-F017-001] `identity`ではなく、呼び出し元がこの論理的な操作開始時点で
 * 1回だけ捕捉した`SharedMutationAuthSnapshot`を受け取る。グローバルな`supabase`
 * クライアントではなく、この操作専用のrequest-scopedクライアント
 * （createPinnedSharedClient）でHTTPリクエストを送る——これにより、待機中に
 * ambient sessionが別ユーザーへ切り替わっても、実際にサーバーへ送られるJWTは
 * 捕捉時点のユーザーのままになる。
 */
export async function upsertSharedEvent(
  event: AppEvent,
  auth: SharedMutationAuthSnapshot
): Promise<void> {
  assertCurrentSharedMutationIdentity(auth);
  const row = appEventToRow(event, auth.userId);
  const { error } = await createPinnedSharedClient(auth).from("events").upsert(row, { onConflict: "id" });
  assertCurrentSharedMutationIdentity(auth);
  if (error) throw error;
}

/**
 * [P0078 DATA-F014-001] 同一カレンダー内の通常予定編集専用のCAS（compare-and-swap）保存。
 * upsertSharedEventと異なり、events.updated_at（サーバー側トリガーが単調に更新する権威ある
 * バージョン）がexpectedUpdatedAtと一致する場合にのみ実際にUPDATEする。RPC
 * update_normal_event_with_version_check（0022移行、単一のUPDATE文＋for update行ロック）が
 * 「id一致・現在のupdated_at一致・editor権限あり」の3条件を1つのatomicな文で検証するため、
 * fetch→比較→upsertという2段階の実装（TOCTOU）にはしない。
 * calendar_id自体はこの関数のパラメータに含まれない（RPC側がDBの現在行から読む）——
 * このRPCではカレンダー移動を一切扱わない（既存のC14 atomic RPC専用）。
 */
export type UpdateNormalEventCasOutcome =
  | { outcome: "committed"; updatedAt: string }
  | { outcome: "conflict"; currentUpdatedAt: string | null }
  | { outcome: "not_found" }
  | { outcome: "not_authorized" };

interface UpdateNormalEventCasRow {
  committed_updated_at: string | null;
  outcome: string;
}

export async function updateSharedNormalEventWithVersionCheck(
  event: NormalEvent,
  expectedUpdatedAt: string,
  auth: SharedMutationAuthSnapshot
): Promise<UpdateNormalEventCasOutcome> {
  assertCurrentSharedMutationIdentity(auth);
  const { data, error } = await createPinnedSharedClient(auth).rpc("update_normal_event_with_version_check", {
    p_event_id: event.id,
    p_expected_updated_at: expectedUpdatedAt,
    p_title: event.title,
    p_date: event.date,
    p_start_time: event.startTime,
    p_end_time: event.endTime,
    p_end_date: event.endDate ?? null,
    p_all_day: event.allDay,
    p_location: event.location ?? null,
    p_notification: event.notification,
    p_repeat: event.repeat,
    p_memo: event.memo ?? null,
    p_completed: event.completed,
  });
  assertCurrentSharedMutationIdentity(auth);
  if (error) throw error;
  const rows = (Array.isArray(data) ? data : data ? [data] : []) as UpdateNormalEventCasRow[];
  const row = rows[0];
  if (!row) throw new Error("update_normal_event_with_version_check: empty response");
  switch (row.outcome) {
    case "committed":
      if (!row.committed_updated_at) {
        throw new Error("update_normal_event_with_version_check: committed without updated_at");
      }
      return { outcome: "committed", updatedAt: row.committed_updated_at };
    case "conflict":
      return { outcome: "conflict", currentUpdatedAt: row.committed_updated_at };
    case "not_found":
      return { outcome: "not_found" };
    case "not_authorized":
      return { outcome: "not_authorized" };
    default:
      throw new Error(`update_normal_event_with_version_check: unknown outcome ${row.outcome}`);
  }
}

/**
 * [P0078 DATA-F014-001] CAS呼び出しがネットワーク断等で応答不明（unknown）になった場合の
 * 再確認専用の単純な単一行取得。events_select_members RLS（is_calendar_member('viewer')）が
 * 既に閲覧権限を強制するため、この関数自体に追加の権限判定は持たせない
 * （呼び出し元がstale-identity再確認・フィールド一致判定を行う）。
 */
export async function fetchSharedEventById(
  id: string,
  auth: SharedMutationAuthSnapshot
): Promise<AppEvent | null> {
  assertCurrentSharedMutationIdentity(auth);
  const { data, error } = await createPinnedSharedClient(auth)
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  assertCurrentSharedMutationIdentity(auth);
  if (error) throw error;
  if (!data) return null;
  return rowToAppEvent(data as EventRow);
}

/**
 * [P0080 F015] events_delete_editor（0001_init.sql）は`using`句のみのポリシーのため、
 * 削除実行者がeditor未満（viewer等）の行に対する`.delete()`はPostgreSQL/RLS的には
 * 「0件が条件に一致した」という扱いになり、エラーを一切返さない（サイレントno-op）。
 * 以前のdeleteSharedEventはこれを区別せず「errorが無ければ成功」と扱っていたため、
 * 予定編集中にeditor権限を喪失した（オーナーに降格された・キックされた等）ユーザーが
 * 削除を実行すると、実際にはサーバー上の行が一切変更されていないにも関わらず、
 * この端末のUIからは削除成功として消える——「phantom deletion」（見せかけの削除成功）。
 * `.delete().select("id")`で実際に削除された行を受け取り、0件だった場合のみ
 * events_select_members（viewer以上なら可視）で存在を再確認する。まだ存在すれば、
 * それは「削除がブロックされた」ことが確定した状態であり、成功として扱ってはならない。
 * 既に存在しない（＝誰か他者が既に削除済み、または元々アクセス不可）場合は、望む終端状態
 * （その行が無い）が既に達成されているため、従来通り成功として扱う（削除の冪等性を維持）。
 */
export const SHARED_EVENT_DELETE_BLOCKED_MESSAGE = "shared_event_delete_permission_denied";

/**
 * 既に存在しない行への削除は0件更新で成功扱いになるため、再送しても副作用がない（冪等）。
 * REVISE対応（第10ラウンド、P2）: upsertSharedEventと同じ理由でidentityを必須にする。
 * Round 12（SEC-F007-001残存）: 以前はremote呼出し完了後の再検証が無く、待機中にstale化
 * していても（削除自体は成功していたとしても）呼び出し元へそのまま伝わっていた。
 * upsertSharedEventと同じ位置（`error`判定より前）に再検証を追加する。
 * [P0080 F015] 上のdocの通り、実際に削除された行数を確認し、0件かつ行がまだ存在する場合は
 * SHARED_EVENT_DELETE_BLOCKED_MESSAGEを投げる（呼び出し元がこれをenqueueDeleteへの
 * フォールバック対象から除外できるようにするため——ブロックされた削除は何度キューへ
 * 積んでリトライしても同じ理由で永久に失敗し続けるため、キューへは積まない）。
 */
export async function deleteSharedEvent(
  id: string,
  auth: SharedMutationAuthSnapshot
): Promise<void> {
  assertCurrentSharedMutationIdentity(auth);
  const { data, error } = await createPinnedSharedClient(auth)
    .from("events")
    .delete()
    .eq("id", id)
    .select("id");
  assertCurrentSharedMutationIdentity(auth);
  if (error) throw error;
  if ((data ?? []).length > 0) return;
  const { data: stillExists, error: checkError } = await createPinnedSharedClient(auth)
    .from("events")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  assertCurrentSharedMutationIdentity(auth);
  if (checkError) throw checkError;
  if (stillExists) {
    throw new Error(SHARED_EVENT_DELETE_BLOCKED_MESSAGE);
  }
}

export interface BulkUpsertResult {
  successCount: number;
  failureCount: number;
  /** 失敗時のみ設定 */
  failureReason?: string;
}

/**
 * 一括作成（期間・曜日指定）で生成した複数の予定を、1回のSupabase呼び出しでまとめてupsertする。
 * 通信回数削減: N件を1件ずつupsertSharedEventで送る（N回の往復）代わりに、配列をそのまま
 * .upsert()へ渡すことで1回のHTTPリクエスト・1回のSQL文にまとめる。
 *
 * エラー処理: 複数行を1回のupsert文で送るため、Postgres/RLS上は単一トランザクションとして
 * 評価される（いずれか1行でもRLS（events_insert_editor等）に違反すれば文全体がロールバックされる）。
 * そのため「全件成功・全件失敗」という理想形が、部分成功を気にする特別なロジックなしで
 * 自然に実現できる。失敗時は呼び出し元が個別にオフライン同期キューへ積めるよう、
 * 成功件数・失敗件数・失敗理由を返す（Supabase側の通常のエラーでは例外を投げない）。
 * Round 12（SEC-F007-001残存）: identityの確認は①空配列の早期return前②remote呼出し前
 * （＝①と同じ確認を流用）③remote呼出し完了直後・`error`の有無を見るより前、の3箇所で行う。
 * stale化した場合は、通常の「成功件数0・失敗件数N」という値ベースの結果に丸め込まず、
 * 常に例外を投げる——呼び出し元（eventService.ts経由）がこれを「同期待ち」のオフライン
 * キューへ積んでしまう（stale時にeventServiceのenqueueUpsertパスへ進んでしまう）ことを防ぐため。
 */
export async function upsertSharedEventsBulk(
  events: AppEvent[],
  auth: SharedMutationAuthSnapshot
): Promise<BulkUpsertResult> {
  assertCurrentSharedMutationIdentity(auth);
  if (events.length === 0) return { successCount: 0, failureCount: 0 };
  const rows = events.map((e) => appEventToRow(e, auth.userId));
  const { error } = await createPinnedSharedClient(auth).from("events").upsert(rows, { onConflict: "id" });
  assertCurrentSharedMutationIdentity(auth);
  if (error) {
    return { successCount: 0, failureCount: events.length, failureReason: error.message };
  }
  return { successCount: events.length, failureCount: 0 };
}

/**
 * [P0084 ROBUST-F015-002] deleteSharedEventsBulkの戻り値。集計値（successCount/
 * failureCount）だけでなく、実際にどのIDが確認済みで削除されたか（deletedIds）・
 * まだ確認できていないか（notDeletedIds）を公開する——呼び出し元（eventService.ts）が
 * 「target1は削除確認済み・target2はまだ未確認」のように、事後の復旧をID単位で
 * 正確に判断できるようにするため（集計件数だけでは、どのIDが成功したかを一意に
 * 特定できない）。
 */
export interface BulkDeleteResult {
  /**
   * このリクエストで確認済みの削除が確定したID。実際にDELETEされたもの、または
   * 0件削除だったが再確認で既に存在しないと分かったもの（＝誰かが既に削除済み・
   * deleteSharedEvent単発と同じ冪等性）の両方を含む。
   */
  deletedIds: string[];
  /** 削除が確認できなかったID（notDeletedIdsのうち、まだ存在すると確認できたもの）。 */
  notDeletedIds: string[];
  /** trueなら、notDeletedIds全体がRLSにより確実にブロックされたことを確認済み。 */
  blocked: boolean;
  /** リモート呼出し自体がエラーになった場合の理由（blocked===falseのときのみ意味を持つ）。 */
  failureReason?: string;
}

/**
 * 繰り返し予定の「これ以降/すべて」削除用。複数IDを1回の.delete().in()呼び出しでまとめて削除する
 * （N件を1件ずつdeleteSharedEventで送る代わりに、通信回数を1回に抑える）。
 * 削除は主キー(id)基準のため、既に存在しないidが含まれていても安全（0件削除で成功扱い）。
 */
/**
 * Round 12（SEC-F007-001残存）: upsertSharedEventsBulkと同じ理由・同じ位置
 * （空配列早期return前・remote呼出し完了直後かつ`error`判定より前）でidentityを確認する。
 * [P0080 F015] deleteSharedEvent（単発）と同じ理由でphantom deletion対策を行う。
 * [P0084 ROBUST-F015-002] 以前はnotDeletedIds全体を一律に「失敗」として扱っていたが、
 * その中には「他者が既に削除済みで、望む終端状態（行が無い）が既に達成されている」
 * IDも含まれうる（deleteSharedEvent単発と同じ冪等性の原則）。再確認クエリで実際に
 * まだ存在するIDだけを「真にブロックされた」ものとして区別し、それ以外は
 * deletedIdsへ含める——呼び出し元がID単位で正確な復旧判断をできるようにするため。
 * blockedはtrulyBlockedIdsが1件でもあればtrueとする（removeRecurringEvents呼び出し前に
 * 「全targetsが同一calendarId」であることを検証済みのため、RLSがブロックする場合は
 * 対象全件が一律にブロックされる想定に変わりはない）。
 */
export async function deleteSharedEventsBulk(
  ids: string[],
  auth: SharedMutationAuthSnapshot
): Promise<BulkDeleteResult> {
  assertCurrentSharedMutationIdentity(auth);
  if (ids.length === 0) return { deletedIds: [], notDeletedIds: [], blocked: false };
  const { data, error } = await createPinnedSharedClient(auth)
    .from("events")
    .delete()
    .in("id", ids)
    .select("id");
  assertCurrentSharedMutationIdentity(auth);
  if (error) {
    return { deletedIds: [], notDeletedIds: ids, blocked: false, failureReason: error.message };
  }
  const confirmedDeletedByThisCall = new Set((data ?? []).map((r: { id: string }) => r.id));
  const remaining = ids.filter((id) => !confirmedDeletedByThisCall.has(id));
  if (remaining.length === 0) {
    return { deletedIds: ids, notDeletedIds: [], blocked: false };
  }
  const { data: stillExistingRows, error: checkError } = await createPinnedSharedClient(auth)
    .from("events")
    .select("id")
    .in("id", remaining);
  assertCurrentSharedMutationIdentity(auth);
  if (checkError) {
    return {
      deletedIds: Array.from(confirmedDeletedByThisCall),
      notDeletedIds: remaining,
      blocked: false,
      failureReason: checkError.message,
    };
  }
  const stillExistingIds = new Set((stillExistingRows ?? []).map((r: { id: string }) => r.id));
  const trulyBlockedIds = remaining.filter((id) => stillExistingIds.has(id));
  const idempotentlyGoneIds = remaining.filter((id) => !stillExistingIds.has(id));
  return {
    deletedIds: [...confirmedDeletedByThisCall, ...idempotentlyGoneIds],
    notDeletedIds: trulyBlockedIds,
    blocked: trulyBlockedIds.length > 0,
  };
}

export interface CalendarEventChangeHandlers {
  onUpsert: (event: AppEvent) => void;
  onDelete: (eventId: string) => void;
}

/**
 * 指定カレンダーの`events`テーブルへのRealtime購読を1つ開始する。
 * 元々useSharedCalendarSync.tsに直接書かれていたSupabase呼び出し（channel/on/subscribe）を
 * ここへ移設したもの（画面・フックからSupabaseへの直接依存をゼロにするため）。
 * 通知（scheduleNotification/cancelNotification）呼び出しは含まない
 * （それは呼び出し元のuseSharedCalendarSync.tsの責務のまま、挙動を変えていない）。
 * 戻り値の関数を呼ぶと購読を解除する。
 */
export function subscribeToCalendarEvents(
  calendarId: string,
  handlers: CalendarEventChangeHandlers
): () => void {
  const channel = supabase
    .channel(`events:${calendarId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "events",
        filter: `calendar_id=eq.${calendarId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") {
          const oldId = (payload.old as { id?: string }).id;
          if (oldId) handlers.onDelete(oldId);
          return;
        }
        const event = rowToAppEvent(payload.new as Parameters<typeof rowToAppEvent>[0]);
        handlers.onUpsert(event);
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}
