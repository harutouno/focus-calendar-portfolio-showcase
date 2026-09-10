import { supabase } from "@/lib/supabaseClient";
import {
  AttachmentMimeType,
  AttachmentQuotaStatus,
  AttachmentUploadStatus,
  EventAttachment,
} from "@/types/attachment";
import {
  SharedOperationIdentity,
  awaitCurrentSharedOperation,
} from "@/auth/sharedMutationIdentity";
import {
  SharedMutationAuthSnapshot,
  captureSharedMutationAuthSnapshot,
  createPinnedSharedClient,
  withPinnedSharedClient
} from "@/auth/sharedMutationAuthSnapshot";
import { WriteEffectResult } from "@/services/writeEffectAuthority";
import {
  AttachmentMigrationTargetEventPatch,
  validateTargetEventPatch,
} from "@/storage/attachmentMigrationRepository";

/**
 * 共有（クラウド）予定の添付画像のメタデータCRUD＋Storageバイトアップロード。
 * 枚数・容量・権限の最終判定はDB側（0008_event_attachments.sqlのRLS・
 * enforce_attachment_quotaトリガー）が行う。超過・権限不足時は例外を投げる。
 *
 * Round 13（SEC-F007-004/SEC-F007-001残存、P1-1）: 全9関数のremote呼出しを
 * `awaitCurrentSharedOperation`経由で実行する。この共通ヘルパーが「開始前」
 * 「resolve直後」「reject時（元エラーを投げる前）」の3点すべてでidentityを再確認するため、
 * 個々の関数側で「remote完了後にerrorをthrow/null/falseへ変換してからidentityを確認する」
 * という順序の誤りを埋め込む余地が無い。stale化と通常のremoteエラーが同時に起きた場合は
 * 常にstale専用の例外を優先する。`getAttachmentStoragePath`・`getAttachmentSignedUrl`・
 * `deleteAttachmentStorageObject`は「見つからない/失敗した場合はnull/falseを返す」設計を
 * 維持するが、その内部catchはoperationコールバックの中に閉じているため、reject後に
 * null/falseへ変換される前に必ずidentityが再確認される（stale時はnull/falseを返さず
 * 例外が優先される）。`uploadAttachmentBytes`はfetch→arrayBuffer→Storage uploadを
 * それぞれ独立したawaitCurrentSharedOperation呼出しにし、各段階の直後で個別に確認する。
 */

interface AttachmentRow {
  id: string;
  event_id: string;
  storage_path: string;
  thumbnail_path: string | null;
  mime_type: AttachmentMimeType;
  byte_size: number;
  width: number | null;
  height: number | null;
  sort_order: number;
  upload_status: AttachmentUploadStatus;
  created_at: string;
}

const ATTACHMENT_COLUMNS =
  "id, event_id, storage_path, thumbnail_path, mime_type, byte_size, width, height, sort_order, upload_status, created_at";

/** cloudAttachmentRepository.tsの補償削除（stale identity発生後の直接Storage操作）でも参照する。 */
export const EVENT_ATTACHMENTS_BUCKET = "event-attachments";

// storage_path/thumbnail_pathはドメイン型(EventAttachment)へそのまま持たせない。
// 表示は必ず getAttachmentSignedUrl 経由の短時間URLで行うため。
function rowToAttachment(row: AttachmentRow): EventAttachment {
  return {
    id: row.id,
    eventId: row.event_id,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    sortOrder: row.sort_order,
    uploadStatus: row.upload_status,
    createdAt: row.created_at,
  };
}

export async function fetchAttachmentsForEvent(
  eventId: string,
  identity: SharedOperationIdentity
): Promise<EventAttachment[]> {
  const data = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await supabase
      .from("event_attachments")
      .select(ATTACHMENT_COLUMNS)
      .eq("event_id", eventId)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return data;
  });
  return (data as AttachmentRow[]).map(rowToAttachment);
}

/**
 * P0041（2節）: shared calendar間の予定移動routing判定（performSingleEventSave）専用の
 * source row取得。`fetchAttachmentsForEvent`（UI表示用、`deleted_at IS NULL`で絞り込む）
 * とはcontractが異なる——deleted_atで絞り込まず、対象eventId配下の全row（uploading/
 * failed/soft-deleted済みの行を含む）をそのまま返す。routing判定（1節 invariant A/B/C）は
 * この「全row」を権威として使うため、ここでフィルタしてはならない。
 */
export interface AttachmentMigrationSourceRow {
  id: string;
  mimeType: AttachmentMimeType;
  byteSize: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
  uploadStatus: AttachmentUploadStatus;
  deletedAt: string | null;
}

interface AttachmentRowWithDeletedAt extends AttachmentRow {
  deleted_at: string | null;
}

export async function fetchAttachmentMigrationSourceRowsForEvent(
  eventId: string,
  identity: SharedOperationIdentity
): Promise<AttachmentMigrationSourceRow[]> {
  const data = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await supabase
      .from("event_attachments")
      .select(`${ATTACHMENT_COLUMNS}, deleted_at`)
      .eq("event_id", eventId)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return data;
  });
  return (data as AttachmentRowWithDeletedAt[]).map((row) => ({
    id: row.id,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    sortOrder: row.sort_order,
    uploadStatus: row.upload_status,
    deletedAt: row.deleted_at,
  }));
}

export interface InsertAttachmentInput {
  /** クライアント側で1回だけ生成するuuid。再送時も同じ値を使うことで二重登録を防ぐ（idベースのupsert）。 */
  id: string;
  eventId: string;
  storagePath: string;
  thumbnailPath?: string;
  mimeType: AttachmentMimeType;
  byteSize: number;
  width?: number;
  height?: number;
  sortOrder: number;
}

/**
 * upsertはid(主キー)基準のため、同じidでの再送は新しい行を作らない（冪等）。
 * 枚数・容量・権限の最終判定はDB側のRLS/enforce_attachment_quotaトリガーが行うため、
 * 超過・権限不足の場合はここでエラーが投げられる（呼び出し元でtoFriendlyMessage等へ変換する）。
 * Round 12（P1-1）: `created_by`は常に`identity.userId`から生成する（別引数として受け取らない。
 * identity=Bのままcreated_by=Aを指定できる余地を型・実装の両方から無くすため）。
 */
export async function insertAttachmentRow(
  input: InsertAttachmentInput,
  identity: SharedOperationIdentity
): Promise<EventAttachment> {
  const row = {
    id: input.id,
    event_id: input.eventId,
    storage_path: input.storagePath,
    thumbnail_path: input.thumbnailPath ?? null,
    mime_type: input.mimeType,
    byte_size: input.byteSize,
    width: input.width ?? null,
    height: input.height ?? null,
    sort_order: input.sortOrder,
    upload_status: "ready" as const,
    created_by: identity.userId,
  };
  const data = await awaitCurrentSharedOperation(identity, async () => {
    // P0154 (SEC-AUTH-TRANSPORT-001): PostgREST の書き込みも `_getSessionToken()` を通るため、
    // RPC と同じく pinned transport で送る。
    const { data, error } = await withPinnedSharedClient(identity, (client) =>
      client
        .from("event_attachments")
        .upsert(row, { onConflict: "id" })
        .select(ATTACHMENT_COLUMNS)
        .single()
    );
    if (error) throw error;
    return data;
  });
  return rowToAttachment(data as AttachmentRow);
}

/**
 * 削除時にStorageオブジェクトを消すためのstorage_pathを取得する。
 * ドメイン型(EventAttachment)はstorage_pathを持たないため、削除処理だけがこの内部パスを必要とする。
 * 取得できない場合（既に削除済み・権限喪失等）はnullを返す（呼び出し元はDB側の削除だけ進める）。
 * stale identityの場合はnullへ丸め込まず、assertCurrentSharedMutationIdentityがthrowする。
 */
export async function getAttachmentStoragePath(
  id: string,
  identity: SharedOperationIdentity
): Promise<string | null> {
  return awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await supabase
      .from("event_attachments")
      .select("storage_path")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { storage_path: string }).storage_path;
  });
}

/**
 * Round13（SEC-F007-004/SEC-F007-001残存、P1-2）: pending cleanup（create-intent/
 * delete-intent）の再試行が、永続化しておいたintentの内容を「DBの現在の実態」と
 * 突き合わせて検証するための専用取得。getAttachmentStoragePathと同じく`deleted_at`で
 * 絞り込まない（soft delete済み・物理削除前の行も対象に含める必要があるため）。
 *
 * Round14（P1-1）: 通信/クエリ自体が失敗した場合（`error`が真）は「対象が存在しない」へ
 * 丸め込まずthrowする（awaitCurrentSharedOperationのpost-checkを経て、stale化していれば
 * stale専用の例外が優先される）。行が本当に存在しない場合（`error`が無く`data`が無い）
 * だけを`{kind:"not-found"}`として返す。呼び出し元（cloudAttachmentRepository.tsの
 * remove/retryCreateIntent/retryDeleteIntent/retryLegacyUnresolved）は、この関数が
 * 例外を投げた場合、Storage操作・hard delete・intent除去のいずれも一切開始しないこと
 * （「クエリが失敗した＝対象は無い」と推測しない）。
 */
/**
 * [P0166 §1 / CORRECT-CLOUDATTACH-002] **3値**の検証結果。
 *
 * 旧契約は `found` / `not-found` の 2 値だったため、
 *   - 権威ある不在（本当に消えている）
 *   - RLS 不可視（メンバーシップ／読取権を失っただけ）
 * を区別できず、後者を「既に無い」と読んで成功報告・intent 除去まで進んでいた。
 *
 * `unconfirmed` は「呼び出し元の読取権限を確立できなかった」全状態を含む。
 * **不在と断定してはならない**側である。
 */
export type AttachmentVerificationResult =
  | { kind: "found"; eventId: string; storagePath: string }
  | { kind: "authoritatively-absent" }
  | { kind: "unconfirmed" };

type VerifyAttachmentRow = {
  outcome: string;
  event_id: string | null;
  storage_path: string | null;
};

/**
 * `verify_attachment_delete_target` RPC（migration 0024）で検証する。
 *
 * クライアント側で「メンバーか？」と「行はあるか？」を別々に問い合わせても、
 * 2 クエリの間で権限が変化しうるため**原子的に判定できない**。サーバ側の
 * 1 スナップショットで両方を決める（P0166 §1 の preferred server authority）。
 *
 * `expectedCalendarId` が無い場合（旧 v1 の legacy-delete-unresolved は
 * calendarId を保持していない）は、読取権限を確立する手段がそもそも無いので
 * **問い合わせずに `unconfirmed`** を返す。結果として legacy の隔離は
 * 解除されないままになるが、それが正しい fail-closed（隔離解除の根拠が無い）。
 *
 * Round14（P1-1）から引き継ぐ契約: 通信/クエリ自体が失敗した場合は
 * 「対象が存在しない」へ丸め込まず throw する。呼び出し元は例外時に
 * Storage 操作・hard delete・intent 除去のいずれも一切開始しない。
 */
export async function getAttachmentDeleteVerificationRow(
  id: string,
  expectedCalendarId: string | null,
  identity: SharedOperationIdentity
): Promise<AttachmentVerificationResult> {
  if (!expectedCalendarId) return { kind: "unconfirmed" };
  return awaitCurrentSharedOperation(identity, async () => {
    const auth = await captureSharedMutationAuthSnapshot(identity);
    const client = createPinnedSharedClient(auth);
    const { data, error } = await client.rpc("verify_attachment_delete_target", {
      p_attachment_id: id,
      p_calendar_id: expectedCalendarId,
    });
    if (error) throw error;
    const row = firstRow<VerifyAttachmentRow>(data);
    // 応答が読めない＝不在の証明にはならない。
    if (!row) return { kind: "unconfirmed" as const };
    if (row.outcome === "found") {
      // found を名乗るならメタデータが揃っていなければならない。欠けていれば信用しない。
      if (!row.event_id || !row.storage_path) return { kind: "unconfirmed" as const };
      return {
        kind: "found" as const,
        eventId: row.event_id,
        storagePath: row.storage_path,
      };
    }
    if (row.outcome === "authoritatively-absent") return { kind: "authoritatively-absent" as const };
    // 未知の outcome も含め、残りはすべて確認不能側へ倒す（fail-closed）。
    return { kind: "unconfirmed" as const };
  });
}

/** 二段階削除の1段階目: すぐに一覧から見えなくする（Storage実削除・行の物理削除はフェーズ3で扱う）。 */
/**
 * [P0164 §5 / CORRECT-CLOUDATTACH-001] soft delete も **効果証跡**を返す。
 *
 * `event_attachments` の RLS も USING 形なので、editor 権限を失った後の UPDATE は
 * 0 行・エラー無しで返る。それを成功と読むと、**DB 上は soft delete されていないのに
 * Storage 実体の削除へ進んでしまう**（破壊が先行する）。
 *
 * 0 行だった場合のみ読み戻して分類する:
 *   - 行が見えて `deleted_at` が入っている → 既に soft delete 済み（安全に次へ進める）
 *   - 行が見えて `deleted_at` が null      → 拒否が確定（blocked）
 *   - 行が見えない                          → 不在か読取権喪失かを区別できない（unconfirmed）
 */
export async function softDeleteAttachment(
  id: string,
  identity: SharedOperationIdentity
): Promise<WriteEffectResult> {
  const auth = await captureSharedMutationAuthSnapshot(identity);
  const client = createPinnedSharedClient(auth);
  const applied = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await client
      .from("event_attachments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .select("id");
    if (error) throw error;
    return (data ?? []) as { id: string }[];
  });
  if (applied.length > 0) return { outcome: "applied" };
  const row = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await client
      .from("event_attachments")
      .select("id, deleted_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data as { id: string; deleted_at: string | null } | null;
  });
  if (!row) return { outcome: "unconfirmed" };
  // 既に soft delete 済み＝望む状態が達成されている（安全に次段へ進める）。
  if (row.deleted_at) return { outcome: "already-absent" };
  return { outcome: "blocked" };
}

/**
 * 二段階削除の2段階目。Storage側の削除が成功した後にのみ呼ぶ（cloudAttachmentRepository.remove参照）。
 *
 * [P0164 §5 / CORRECT-CLOUDATTACH-001] **0 行や不明を完了成功へ丸め込まない。**
 * ここは Storage 実体を既に消したあとの最終段であり、0 行のまま成功にすると
 * 「DB 行は残る・実体は無い・回復用 intent も消える」という復旧不能な部分成功になる。
 */
export async function hardDeleteAttachmentRow(
  id: string,
  identity: SharedOperationIdentity
): Promise<WriteEffectResult> {
  const auth = await captureSharedMutationAuthSnapshot(identity);
  const client = createPinnedSharedClient(auth);
  const applied = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await client
      .from("event_attachments")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) throw error;
    return (data ?? []) as { id: string }[];
  });
  if (applied.length > 0) return { outcome: "applied" };
  const row = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await client
      .from("event_attachments")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data as { id: string } | null;
  });
  // 行が見えれば拒否確定。見えなければ「消えた」と「読めない」を区別できない。
  return { outcome: row ? "blocked" : "unconfirmed" };
}

/**
 * 圧縮済み画像ファイルを非公開event-attachmentsバケットへアップロードする。
 * imageUploadService.tsのuploadToBucketと同じfetch→arrayBuffer→uploadパターンだが、
 * 非公開バケット・可変パス（{calendarId}/{eventId}/{attachmentId}/original.jpg）向けに
 * 専用実装する（公開URLは取得しない）。
 * 同じstoragePathへの再試行（アップロード成功後にDB登録が失敗した場合の再送）でも
 * 安全に上書きできるよう upsert:true にする。
 */
export async function uploadAttachmentBytes(
  storagePath: string,
  localUri: string,
  mimeType: AttachmentMimeType,
  identity: SharedOperationIdentity
): Promise<void> {
  // fetch→arrayBuffer→Storage uploadを別々のawait境界として扱い、各段階の直後で
  // 個別にidentityを確認する（Round13、P1-1。いずれか1段階のみ完了した状態で
  // stale化した場合でも、次の段階を開始する前に必ず検知するため）。
  const response = await awaitCurrentSharedOperation(identity, () => fetch(localUri));
  const arrayBuffer = await awaitCurrentSharedOperation(identity, () => response.arrayBuffer());
  await awaitCurrentSharedOperation(identity, async () => {
    // P0154: Storage の書き込みも同じ transport TOCTOU を持つ（バケットRLSは
    // リクエストJWTで評価される）。pinned client で送る。
    const { error } = await withPinnedSharedClient(identity, (client) =>
      client.storage
        .from(EVENT_ATTACHMENTS_BUCKET)
        .upload(storagePath, arrayBuffer, { contentType: mimeType, upsert: true })
    );
    if (error) throw error;
  });
}

/**
 * アップロード済みだがDB登録に失敗した場合のロールバック用。削除にも失敗した場合は
 * 例外を投げず呼び出し元へfalseを返す（孤立ファイルとしてフェーズ3の対策対象になる）。
 * stale identityの場合はfalseへ丸め込まず、assertCurrentSharedMutationIdentityがthrowする
 * （開始前チェック・await完了直後チェックの両方をtry/catchの外側で行う）。
 */
export async function deleteAttachmentStorageObject(
  storagePath: string,
  identity: SharedOperationIdentity
): Promise<boolean> {
  // reject（通信自体の失敗）はここで内側のtry/catchが握りつぶしfalseへ変換するが、
  // その値がawaitCurrentSharedOperationのpost-checkを通過して初めて呼び出し元へ返るため、
  // reject後・false変換後にstale化していた場合はfalseではなく例外が優先される。
  return awaitCurrentSharedOperation(identity, async () => {
    try {
      const { error } = await withPinnedSharedClient(identity, (client) =>
        client.storage.from(EVENT_ATTACHMENTS_BUCKET).remove([storagePath])
      );
      return !error;
    } catch {
      return false;
    }
  });
}

/**
 * P0034（QA-F007 C14、client migration core、6節）: destination Storage staging
 * （download + upload）のsource側読み出し。非公開バケットのためsigned URL/公開URL
 * には頼らず、Supabase Storageクライアントの`download()`（Blobを返す）を直接使う。
 * `uploadAttachmentBytes`のfetch（ローカルファイル読み出し）とは別経路——こちらは
 * クラウド上の既存オブジェクトを読む。
 */
export async function downloadAttachmentBytes(
  storagePath: string,
  identity: SharedOperationIdentity
): Promise<ArrayBuffer> {
  return awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await supabase.storage.from(EVENT_ATTACHMENTS_BUCKET).download(storagePath);
    if (error) throw error;
    if (!data) throw new Error("attachment_source_download_empty");
    return data.arrayBuffer();
  });
}

/**
 * P0034（6節）: 既にメモリ上にあるバイト列（`downloadAttachmentBytes`で取得したもの）を
 * 別pathへアップロードする。`uploadAttachmentBytes`（ローカルファイルURIを起点にする
 * fetch→arrayBuffer→uploadの3段階）とは異なり、こちらはbyte列を直接受け取る1段階のみ
 * （既存のuploadAttachmentBytesの呼び出し契約・挙動は変更しない）。migration retryが
 * 同じdestination ID/pathへ何度再送しても安全なよう upsert:true にする。
 */
export async function uploadAttachmentBytesRaw(
  storagePath: string,
  bytes: ArrayBuffer,
  mimeType: AttachmentMimeType,
  identity: SharedOperationIdentity
): Promise<void> {
  await awaitCurrentSharedOperation(identity, async () => {
    const { error } = await withPinnedSharedClient(identity, (client) =>
      client.storage
        .from(EVENT_ATTACHMENTS_BUCKET)
        .upload(storagePath, bytes, { contentType: mimeType, upsert: true })
    );
    if (error) throw error;
  });
}

/**
 * P0034（11節）: RPC unknown-outcome reconciliationのためのfresh remote read。
 * event.calendar_idと、対象event配下のevent_attachments全行（statusを問わず、
 * `deleted_at`でも絞り込まない——0019のRPC自身が判定に使う「全row」と同じ範囲）を返す。
 * eventが存在しない場合はnullを返す（呼び出し元がambiguous/committed/not-committedの
 * いずれとも解釈せず、fail-closedで扱うこと）。
 */
export interface ReconciliationAttachmentRow {
  id: string;
  storagePath: string;
  mimeType: AttachmentMimeType;
  byteSize: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
  uploadStatus: AttachmentUploadStatus;
  deletedAt: string | null;
}

export interface ReconciliationSnapshot {
  eventCalendarId: string;
  /** P0035（5節）: committedUpdatedAtの永続化に使う、fresh readで取得した実際のevent.updated_at。 */
  eventUpdatedAt: string;
  attachments: ReconciliationAttachmentRow[];
  /**
   * P0043（2節 zero-plan invariant、10節）: attachments=[]のplanにはdestination
   * attachment ID fingerprintが存在しないため、event.calendar==targetだけで
   * committed判定してはならない——durable targetEventとのexact matchが必要。
   * `validateTargetEventPatch`（durable targetEvent validatorと同一関数）で
   * 検証済みのfresh remote値。malformed/型不一致のraw fieldがあれば、この関数自体が
   * throwし（呼び出し元のfetchEventReconciliationSnapshot try/catchで揉み消さない
   * ——そのまま伝播させ、reconcileAttachmentMigration側の既存catchがambiguousへ
   * fail-closedする）。
   */
  eventTargetPatch: AttachmentMigrationTargetEventPatch;
}

interface RawEventReconciliationRow {
  calendar_id: string;
  updated_at: string;
  title: unknown;
  date: unknown;
  start_time: unknown;
  end_time: unknown;
  all_day: unknown;
  location: unknown;
  duration_minutes: unknown;
  restricted_apps: unknown;
  unlock_condition: unknown;
  notification: unknown;
  repeat: unknown;
  memo: unknown;
  completed: unknown;
  recurring_group_id: unknown;
  recurrence_index: unknown;
}

const EVENT_RECONCILIATION_COLUMNS =
  "calendar_id, updated_at, title, date, start_time, end_time, all_day, location, " +
  "duration_minutes, restricted_apps, unlock_condition, notification, repeat, memo, " +
  "completed, recurring_group_id, recurrence_index";

export async function fetchEventReconciliationSnapshot(
  eventId: string,
  auth: SharedMutationAuthSnapshot
): Promise<ReconciliationSnapshot | null> {
  // [P0080 AUTH-F013-F017-001] C14のreconciliation readもF014 CASのreconciliation read
  // と同型のTOCTOUを持つため、同じrequest-scoped pinned clientで送出する。
  return awaitCurrentSharedOperation(auth, async () => {
    const client = createPinnedSharedClient(auth);
    const { data: eventRow, error: eventError } = await client
      .from("events")
      .select(EVENT_RECONCILIATION_COLUMNS)
      .eq("id", eventId)
      .maybeSingle();
    if (eventError) throw eventError;
    if (!eventRow) return null;

    const { data: attachmentRows, error: attachmentError } = await client
      .from("event_attachments")
      .select("id, storage_path, mime_type, byte_size, width, height, sort_order, upload_status, deleted_at")
      .eq("event_id", eventId);
    if (attachmentError) throw attachmentError;

    const row = eventRow as unknown as RawEventReconciliationRow;
    // P0043（10節）: durable targetEvent validatorと同じ意味論・同じ関数で検証する
    // （勝手なdefault補正は一切行わない——malformedならthrowし、呼び出し元がambiguousへ倒す）。
    const eventTargetPatch = validateTargetEventPatch({
      title: row.title,
      date: row.date,
      startTime: row.start_time,
      endTime: row.end_time,
      allDay: row.all_day,
      location: row.location,
      durationMinutes: row.duration_minutes,
      restrictedApps: row.restricted_apps,
      unlockCondition: row.unlock_condition,
      notification: row.notification,
      repeat: row.repeat,
      memo: row.memo,
      completed: row.completed,
      recurringGroupId: row.recurring_group_id,
      recurrenceIndex: row.recurrence_index,
    });

    return {
      eventCalendarId: row.calendar_id,
      eventUpdatedAt: row.updated_at,
      attachments: (attachmentRows as {
        id: string;
        storage_path: string;
        mime_type: AttachmentMimeType;
        byte_size: number;
        width: number | null;
        height: number | null;
        sort_order: number;
        upload_status: AttachmentUploadStatus;
        deleted_at: string | null;
      }[]).map((r) => ({
        id: r.id,
        storagePath: r.storage_path,
        mimeType: r.mime_type,
        byteSize: r.byte_size,
        width: r.width,
        height: r.height,
        sortOrder: r.sort_order,
        uploadStatus: r.upload_status,
        deletedAt: r.deleted_at,
      })),
      eventTargetPatch,
    };
  });
}

/**
 * P0034（8節）: Phase 2 RPC wrapper。0019のmove_shared_event_and_attachments署名と
 * 厳密に一致するパラメータのみを渡す（caller供給の任意フィールドを展開しない）。
 * createdBy/createdAt・destination storage pathはサーバー側で決定するためここに含めない。
 */
export interface MoveSharedEventAndAttachmentsManifestElement {
  sourceAttachmentId: string;
  destinationAttachmentId: string;
  storagePath: string;
  mimeType: AttachmentMimeType;
  byteSize: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
}

export interface MoveSharedEventAndAttachmentsParams {
  eventId: string;
  sourceCalendarId: string;
  targetCalendarId: string;
  expectedUpdatedAt: string;
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  location: string | null;
  durationMinutes: number | null;
  restrictedApps: unknown;
  unlockCondition: unknown;
  notification: unknown;
  repeat: unknown;
  memo: string | null;
  completed: boolean;
  recurringGroupId: string | null;
  recurrenceIndex: number | null;
  attachmentManifest: MoveSharedEventAndAttachmentsManifestElement[];
}

export interface MoveSharedEventAndAttachmentsResult {
  eventId: string;
  sourceCalendarId: string;
  targetCalendarId: string;
  committedUpdatedAt: string;
  sourceAttachmentIds: string[];
  destinationAttachmentIds: string[];
}

interface MoveRpcRow {
  event_id: string;
  source_calendar_id: string;
  target_calendar_id: string;
  committed_updated_at: string;
  source_attachment_ids: string[];
  destination_attachment_ids: string[];
}

/**
 * 呼び出し元（attachmentMigrationService.ts）は、この関数が投げる例外を
 * definite-rollback（サーバー側で確定的に拒否・transaction rollback済み）と
 * unknown-outcome（通信断・タイムアウト等、commit有無が不明）へ分類する責任を持つ
 * （このwrapper自身は分類しない——生のerror/例外をそのまま伝播させる）。
 */
export async function invokeMoveSharedEventAndAttachmentsRpc(
  params: MoveSharedEventAndAttachmentsParams,
  auth: SharedMutationAuthSnapshot
): Promise<MoveSharedEventAndAttachmentsResult> {
  // [P0080 AUTH-F013-F017-001] C14のcalendar-move RPCもF014 CAS RPCと同型の
  // request-level TOCTOUを持つため、同じrequest-scoped pinned clientで送出する。
  const data = await awaitCurrentSharedOperation(auth, async () => {
    const { data, error } = await createPinnedSharedClient(auth).rpc("move_shared_event_and_attachments", {
      p_event_id: params.eventId,
      p_source_calendar_id: params.sourceCalendarId,
      p_target_calendar_id: params.targetCalendarId,
      p_expected_updated_at: params.expectedUpdatedAt,
      p_title: params.title,
      p_date: params.date,
      p_start_time: params.startTime,
      p_end_time: params.endTime,
      p_all_day: params.allDay,
      p_location: params.location,
      p_duration_minutes: params.durationMinutes,
      p_restricted_apps: params.restrictedApps ?? [],
      p_unlock_condition: params.unlockCondition,
      p_notification: params.notification,
      p_repeat: params.repeat,
      p_memo: params.memo,
      p_completed: params.completed,
      p_recurring_group_id: params.recurringGroupId,
      p_recurrence_index: params.recurrenceIndex,
      p_attachment_manifest: params.attachmentManifest.map((a) => ({
        sourceAttachmentId: a.sourceAttachmentId,
        destinationAttachmentId: a.destinationAttachmentId,
        storagePath: a.storagePath,
        mimeType: a.mimeType,
        byteSize: a.byteSize,
        width: a.width,
        height: a.height,
        sortOrder: a.sortOrder,
      })),
    });
    if (error) throw error;
    return data;
  });
  const row = firstRow<MoveRpcRow>(data);
  if (!row) throw new Error("move_shared_event_and_attachments_no_row_returned");
  return {
    eventId: row.event_id,
    sourceCalendarId: row.source_calendar_id,
    targetCalendarId: row.target_calendar_id,
    committedUpdatedAt: row.committed_updated_at,
    sourceAttachmentIds: row.source_attachment_ids,
    destinationAttachmentIds: row.destination_attachment_ids,
  };
}

interface QuotaStatusRow {
  max_files_per_event: number;
  max_file_size_bytes: number;
  total_storage_limit_bytes: number;
  current_event_file_count: number;
  current_used_bytes: number;
  remaining_bytes: number;
  can_upload: boolean;
}

function firstRow<T>(data: unknown): T | undefined {
  return Array.isArray(data) ? (data[0] as T | undefined) : (data as T | undefined);
}

/**
 * 共有カレンダー所有者の実プランに基づく画像添付の上限・現在値をRPC(0017の
 * get_attachment_quota_status)から取得する。所有者の資格詳細は一切返らない。
 * eventIdを省略した場合（新規作成のドラフト段階でevents行がまだ無い場合）は
 * サーバー側でcurrentEventFileCountを0として扱う。
 */
export async function fetchAttachmentQuotaStatus(
  calendarId: string,
  identity: SharedOperationIdentity,
  eventId?: string
): Promise<AttachmentQuotaStatus> {
  const data = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await supabase.rpc("get_attachment_quota_status", {
      p_calendar_id: calendarId,
      p_event_id: eventId ?? null,
    });
    if (error) throw error;
    return data;
  });
  const row = firstRow<QuotaStatusRow>(data);
  if (!row) throw new Error("quota_status_not_found");
  return {
    maxFilesPerEvent: row.max_files_per_event,
    maxFileSizeBytes: row.max_file_size_bytes,
    totalStorageLimitBytes: row.total_storage_limit_bytes,
    currentEventFileCount: row.current_event_file_count,
    currentUsedBytes: row.current_used_bytes,
    remainingBytes: row.remaining_bytes,
    canUpload: row.can_upload,
  };
}

/**
 * 表示のたびに取得する短時間署名付きURL。DB/AsyncStorageへは永続保存しない。
 * 取得に失敗した場合（権限喪失・オフライン等）は例外を投げずnullを返す
 * （呼び出し元は画像を表示できないだけで、画面全体をクラッシュさせないため）。
 * stale identityはnullへ丸め込まず、assertCurrentSharedMutationIdentityがthrowする
 * （開始前チェック・await完了直後チェックの両方をtry/catchの外側で行う）。
 */
export async function getAttachmentSignedUrl(
  storagePath: string,
  identity: SharedOperationIdentity,
  expiresInSeconds = 300
): Promise<string | null> {
  return awaitCurrentSharedOperation(identity, async () => {
    try {
      const { data, error } = await supabase.storage
        .from(EVENT_ATTACHMENTS_BUCKET)
        .createSignedUrl(storagePath, expiresInSeconds);
      if (error) return null;
      return data?.signedUrl ?? null;
    } catch {
      return null;
    }
  });
}
