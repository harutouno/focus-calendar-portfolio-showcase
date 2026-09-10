import * as Crypto from "expo-crypto";
import { AttachmentMimeType } from "@/types/attachment";
import {
  SharedOperationIdentity,
  isCurrentSharedMutationIdentity,
} from "@/auth/sharedMutationIdentity";
import { captureSharedMutationAuthSnapshot } from "@/auth/sharedMutationAuthSnapshot";
import { getCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";
import {
  AttachmentMigrationTargetEventPatch,
  PendingAttachmentMigration,
  PendingAttachmentMigrationAttachment,
  buildCanonicalAttachmentPath,
  clearPendingAttachmentMigration,
  getPendingAttachmentMigrationForEvent,
  getPendingAttachmentMigrationsForOwner,
  startAttachmentMigration,
  updatePendingAttachmentMigration,
} from "@/storage/attachmentMigrationRepository";
import {
  stageDestinationAttachment,
  cleanupSourceAttachmentStorage,
  cleanupAbortedDestinationStorage,
  AttachmentMigrationStaleError,
} from "./attachmentMigrationPrimitives";
import {
  invokeMoveSharedEventAndAttachmentsRpc,
  fetchEventReconciliationSnapshot,
  MoveSharedEventAndAttachmentsResult,
  ReconciliationSnapshot,
} from "./remoteAttachmentRepository";
import { UnlockCondition } from "@/types/event";

/**
 * P0034（QA-F007 C14、client migration core）: shared calendar A→B の添付付きevent移動
 * のorchestrator + retry engine。まだNormalEventForm/EditEventScreen/AppDataContextの
 * 通常save経路からは一切呼ばれない（20節: no UI integration）。
 */

/**
 * P0035（4節）: 呼び出し元のcurrent identity.userIdが、対象recordのownerUserIdと
 * 一致しない場合。この例外を投げる時点で、いかなる永続化・remote副作用も
 * まだ実行していないこと（呼び出し元は必ずこのチェックを最初に行うこと）。
 */
export class AttachmentMigrationOwnerMismatchError extends Error {
  readonly code = "attachment-migration-owner-mismatch" as const;
  constructor(context: string) {
    super(`attachment migration caller identity does not match record owner (${context})`);
    this.name = "AttachmentMigrationOwnerMismatchError";
  }
}

// ============================================================
// 18節: 公開result型
// ============================================================
export type AttachmentMigrationResult =
  | { status: "committed"; committedUpdatedAt: string }
  | { status: "pending-retry" }
  | { status: "stale" }
  | { status: "conflict"; reason: string }
  | { status: "not-found" };

// ============================================================
// 10節: RPC error classification（definite rollback vs unknown outcome）
// ============================================================

/**
 * 0019（move_shared_event_and_attachments）とそのトランザクション内で発火しうる
 * enforce_attachment_quotaトリガー・P0033 guard triggerが投げる、確定的な
 * server-side rollbackを表す既知の例外メッセージ。エラー文字列の雑なsubstringだけで
 * 判定しない——PostgrestErrorの実際の構造（message + code）を両方確認する。
 */
const DEFINITE_ROLLBACK_MESSAGES = new Set<string>([
  "unauthenticated",
  "invalid_plan",
  "permission_denied",
  "source_changed",
  "source_attachment_conflict",
  "destination_storage_missing",
  "destination_storage_size_mismatch",
  "attachment_storage_object_not_found",
  "attachment_storage_path_mismatch",
  "attachment_too_large",
  "attachment_event_limit",
  "attachment_quota_exceeded",
  "event_not_found",
  "event_calendar_move_requires_attachment_migration",
]);

/**
 * PostgRESTがPL/pgSQLの`raise exception '<message>'`をそのまま返す場合、
 * `error.message`に例外テキストが入り、`error.code`はデフォルトSQLSTATE（P0001）になる
 * （0019のどのraiseもUSING errcode=...を指定していないため）。この2フィールドの
 * 組み合わせが厳密に一致した場合のみdefiniteと判定する。ネットワークエラー等
 * （fetch失敗・timeout等）はこの形状を持たないため、自動的にfalse（=unknown側）になる。
 * 判定不能はunknownへ倒す（10節）。
 */
export function isDefiniteRpcRollbackError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { message?: unknown; code?: unknown };
  if (typeof e.message !== "string" || typeof e.code !== "string") return false;
  if (e.code !== "P0001") return false;
  return DEFINITE_ROLLBACK_MESSAGES.has(e.message.trim());
}

// ============================================================
// 9節: RPC成功responseの形状検証
// ============================================================

function arraysExactMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function validateRpcResult(
  result: MoveSharedEventAndAttachmentsResult,
  plan: PendingAttachmentMigration
): boolean {
  if (result.eventId !== plan.eventId) return false;
  if (result.sourceCalendarId !== plan.sourceCalendarId) return false;
  if (result.targetCalendarId !== plan.targetCalendarId) return false;
  if (!result.committedUpdatedAt) return false;
  const expectedSourceIds = plan.attachments.map((a) => a.sourceAttachmentId);
  const expectedDestIds = plan.attachments.map((a) => a.destinationAttachmentId);
  if (!arraysExactMatch(result.sourceAttachmentIds, expectedSourceIds)) return false;
  if (!arraysExactMatch(result.destinationAttachmentIds, expectedDestIds)) return false;
  return true;
}

// ============================================================
// 11節: RPC unknown reconciliation（fresh remote read → 3分類）
// ============================================================

/**
 * P0043（4節・6節）: unknown invariant——後続RPCの構造化definite rollbackだけを根拠に
 * abort-destination-cleanup-pendingへ進んではならない（そのエラーはretry RPC自身の
 * rollbackを示すだけで、response lostした先行RPCがlate commitしていないことを
 * 証明しない）。4分類に拡張し、"not-committed"を廃止する:
 * - committed: fresh remote stateが確定的にcommitted。
 * - retryable-not-committed: 同じfixed planで1回だけRPC再送してよい状態
 *   （expectedUpdatedAt・source全row一致・destination未着手が確認できた場合のみ）。
 * - terminal-conflict: fresh remote stateから見て、old unknown RPCが今後commitする
 *   ことが構造的に不可能だと証明できた場合のみ（destination cleanupへ進んでよい）。
 * - committed-superseded: P0044（1節）。migration自体（destination fingerprint）は
 *   確定的にcommitされているが、fresh eventTargetPatchがdurable plan.targetEventと
 *   一致しない——別端末/別sessionが同じtarget eventを既に後続編集済み。この場合
 *   migrationのcommit自体は確定なのでsource cleanupは進めてよいが、plan（stale patch）
 *   をcommittedとしてlocal cacheへ反映してはならない（新しい方の状態を古い方の状態で
 *   上書きするP1を防ぐ）。
 * - ambiguous: 上記のいずれとも判定できない（fail-closed、破壊的操作0件のままrecord保持）。
 */
type ReconciliationOutcome =
  | "committed"
  | "committed-superseded"
  | "retryable-not-committed"
  | "terminal-conflict"
  | "ambiguous";

type ReconciliationAttachmentRowShape = {
  id: string;
  storagePath: string;
  mimeType: AttachmentMimeType;
  byteSize: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
  uploadStatus: string;
  deletedAt: string | null;
};

/**
 * P0036（4節）: fresh attachment行の集合が、planのsource側attachment一覧と
 * 完全一致（storagePath/mimeType/byteSize/width/height/sortOrder/uploadStatus=ready/
 * deletedAt=null、行数・ID集合とも過不足なし）することを確認する。呼び出し元
 * （classifyReconciliation・recoverFromPreRpcStagingFailure）で共有する純粋関数。
 */
function sourceRowsExactMatch(
  attachmentRows: ReconciliationAttachmentRowShape[],
  plan: PendingAttachmentMigration
): boolean {
  if (attachmentRows.length !== plan.attachments.length) return false;
  const rowsById = new Map(attachmentRows.map((r) => [r.id, r]));
  for (const a of plan.attachments) {
    const row = rowsById.get(a.sourceAttachmentId);
    if (!row) return false;
    if (
      row.storagePath !== a.sourceStoragePath ||
      row.byteSize !== a.byteSize ||
      row.mimeType !== a.mimeType ||
      row.width !== a.width ||
      row.height !== a.height ||
      row.sortOrder !== a.sortOrder ||
      row.uploadStatus !== "ready" ||
      row.deletedAt !== null
    ) {
      return false;
    }
  }
  return true;
}

/**
 * P0043（7節）: nonzero plan・event calendar==target側の判定。
 * 「attachmentRows.length !== plan.attachments.length」チェックを廃止した——
 * planに属さないextra attachment rows（RPC commit後に別端末がtargetへ新規追加した
 * 正当な添付等）はcommitted判定を壊さない。planned destination UUIDsそのものが
 * このoperationのfingerprintであり、無関係な行の存在は無視してよい。
 * planned source IDが1件でも残っていれば（=移行未完了の証跡）ambiguous。
 *
 * P0044（1節）: destination fingerprintがexactに揃っていても、それだけでは
 * 「plan（P1）が現在のserver stateと一致する」ことを意味しない——response lostの後、
 * 別端末/別sessionが同じtarget eventを既にP2へ編集済みの可能性がある
 * （destination attachment idsはP1のRPCが確定させたまま変わらないため、
 * fingerprintだけ見るとP2編集後もexactのまま）。fresh eventTargetPatchを
 * durable plan.targetEventとexact比較し、一致しなければ"committed-superseded"
 * （migration自体のcommitは確定だがstale patchをcommittedとして返さない）。
 */
function classifyNonzeroPlanTarget(
  snapshot: ReconciliationSnapshot,
  plan: PendingAttachmentMigration
): ReconciliationOutcome {
  const attachmentRows = snapshot.attachments;
  const sourceIdSet = new Set(plan.attachments.map((a) => a.sourceAttachmentId));
  if (attachmentRows.some((r) => sourceIdSet.has(r.id))) return "ambiguous";
  const rowsById = new Map(attachmentRows.map((r) => [r.id, r]));
  for (const a of plan.attachments) {
    const row = rowsById.get(a.destinationAttachmentId);
    if (!row) return "ambiguous";
    if (
      row.storagePath !== a.destinationStoragePath ||
      row.byteSize !== a.byteSize ||
      row.mimeType !== a.mimeType ||
      row.width !== a.width ||
      row.height !== a.height ||
      row.sortOrder !== a.sortOrder ||
      row.uploadStatus !== "ready" ||
      row.deletedAt !== null
    ) {
      return "ambiguous";
    }
  }
  return eventTargetPatchExactMatch(snapshot.eventTargetPatch, plan.targetEvent) ? "committed" : "committed-superseded";
}

/**
 * P0043（2節 source retry invariant、8節）: nonzero plan・event calendar==source側の判定。
 * destination行が1件でも存在すればambiguous（committed候補との対称性維持、5節と同様）。
 * それ以外は、source retry invariantを満たす場合のみretryable-not-committed:
 * eventUpdatedAt===plan.expectedUpdatedAt かつ source全rowがoriginal manifestと完全一致。
 * どちらか一方でも崩れていれば、old unknown RPCは今後commitできないと構造的に証明できる
 * ためterminal-conflict（destination cleanupへ進んでよい）。
 */
function classifyNonzeroPlanSource(
  snapshot: ReconciliationSnapshot,
  plan: PendingAttachmentMigration
): ReconciliationOutcome {
  const destIdSet = new Set(plan.attachments.map((a) => a.destinationAttachmentId));
  if (snapshot.attachments.some((r) => destIdSet.has(r.id))) return "ambiguous";
  const exactUpdatedAt = snapshot.eventUpdatedAt === plan.expectedUpdatedAt;
  const exactSource = sourceRowsExactMatch(snapshot.attachments, plan);
  if (exactUpdatedAt && exactSource) return "retryable-not-committed";
  return "terminal-conflict";
}

/**
 * P0043（9節）: nonzero plan・eventがsource/target以外の第三calendarへ移動済みの場合。
 * このsource-bound RPCは以後commitできない（calendar一致チェックで必ず弾かれる）ため、
 * 原則terminal-conflictとしてよいが、planned destination行が1件でも存在すれば
 * destructive target cleanupの安全性を証明できないためambiguousに倒す
 * （false committedしない、というより先に「勝手に壊さない」ことを優先する）。
 */
function classifyNonzeroPlanOtherCalendar(
  snapshot: ReconciliationSnapshot,
  plan: PendingAttachmentMigration
): ReconciliationOutcome {
  const destIdSet = new Set(plan.attachments.map((a) => a.destinationAttachmentId));
  if (snapshot.attachments.some((r) => destIdSet.has(r.id))) return "ambiguous";
  return "terminal-conflict";
}

function classifyNonzeroPlanReconciliation(
  snapshot: ReconciliationSnapshot,
  plan: PendingAttachmentMigration
): ReconciliationOutcome {
  if (snapshot.eventCalendarId === plan.targetCalendarId) {
    return classifyNonzeroPlanTarget(snapshot, plan);
  }
  if (snapshot.eventCalendarId === plan.sourceCalendarId) {
    return classifyNonzeroPlanSource(snapshot, plan);
  }
  return classifyNonzeroPlanOtherCalendar(snapshot, plan);
}

function stringArraysExactMatch(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function unlockConditionExactMatch(a: UnlockCondition | null, b: UnlockCondition | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.type !== b.type) return false;
  return (a.count ?? null) === (b.count ?? null);
}

/**
 * P0043（11節）: zero-plan committed判定専用のfield-specific pure comparator。
 * JSON.stringifyだけに依存しない（object key orderで誤判定しない）——各フィールドを
 * 個別に比較する。array（restrictedApps）はorder-sensitiveなexact match
 * （jsonb round-tripで順序は保持されるため、setとして緩めない）。
 */
function eventTargetPatchExactMatch(
  snapshotPatch: AttachmentMigrationTargetEventPatch,
  planPatch: AttachmentMigrationTargetEventPatch
): boolean {
  if (snapshotPatch.title !== planPatch.title) return false;
  if (snapshotPatch.date !== planPatch.date) return false;
  if (snapshotPatch.startTime !== planPatch.startTime) return false;
  if (snapshotPatch.endTime !== planPatch.endTime) return false;
  if (snapshotPatch.allDay !== planPatch.allDay) return false;
  if (snapshotPatch.location !== planPatch.location) return false;
  if (snapshotPatch.durationMinutes !== planPatch.durationMinutes) return false;
  if (!stringArraysExactMatch(snapshotPatch.restrictedApps, planPatch.restrictedApps)) return false;
  if (!unlockConditionExactMatch(snapshotPatch.unlockCondition, planPatch.unlockCondition)) return false;
  if (snapshotPatch.notification.enabled !== planPatch.notification.enabled) return false;
  if (snapshotPatch.notification.minutesBefore !== planPatch.notification.minutesBefore) return false;
  if (snapshotPatch.repeat.type !== planPatch.repeat.type) return false;
  if (snapshotPatch.memo !== planPatch.memo) return false;
  if (snapshotPatch.completed !== planPatch.completed) return false;
  if (snapshotPatch.recurringGroupId !== planPatch.recurringGroupId) return false;
  if (snapshotPatch.recurrenceIndex !== planPatch.recurrenceIndex) return false;
  return true;
}

/**
 * P0043（2節 zero-plan invariant、12節）: zero plan・event calendar==target側の判定。
 * attachments=[]ではdestination attachment ID fingerprintが存在しないため、
 * event.calendar==targetだけでcommitted判定してはならない——durable targetEventと
 * fresh remote event fieldsのexact semantic matchを要求する。attachmentRowsの内容は
 * 一切見ない（0件である必要も無い——zero plan自身にはsource/destination Storage
 * cleanupが無いため、target patchがexactなら他端末が追加した無関係な添付の存在に
 * 関わらずsemantic committedとして閉じてよい、17節）。
 */
function classifyZeroPlanTarget(
  snapshot: ReconciliationSnapshot,
  plan: PendingAttachmentMigration
): ReconciliationOutcome {
  return eventTargetPatchExactMatch(snapshot.eventTargetPatch, plan.targetEvent) ? "committed" : "terminal-conflict";
}

/**
 * P0043（13節）: zero plan・event calendar==source側の判定。
 * retryable-not-committedは「eventUpdatedAt===expectedUpdatedAt かつ attachment行0件」
 * の場合のみ。eventUpdatedAtが変化した、または添付行が1件以上追加された場合は、
 * zero manifest RPCが以後exact count/expected checkを通れないため、old unknown RPCの
 * late commitは構造的に不可能——terminal-conflict（destination側の副作用はそもそも
 * 存在しないため、remote cleanup 0でrecordをclearしてconflict resultへ進む）。
 */
function classifyZeroPlanSource(
  snapshot: ReconciliationSnapshot,
  plan: PendingAttachmentMigration
): ReconciliationOutcome {
  const exactUpdatedAt = snapshot.eventUpdatedAt === plan.expectedUpdatedAt;
  const zeroRows = snapshot.attachments.length === 0;
  return exactUpdatedAt && zeroRows ? "retryable-not-committed" : "terminal-conflict";
}

/**
 * P0043（14節）: zero plan・eventがsource/target以外の場合。zero planはStorage
 * side effectそのものが存在しないため、destination行の存在確認すら不要——
 * 常にterminal-conflict（success UI 0のままrecordをclearする）。
 */
function classifyZeroPlanOtherCalendar(): ReconciliationOutcome {
  return "terminal-conflict";
}

function classifyZeroPlanReconciliation(
  snapshot: ReconciliationSnapshot,
  plan: PendingAttachmentMigration
): ReconciliationOutcome {
  if (snapshot.eventCalendarId === plan.targetCalendarId) return classifyZeroPlanTarget(snapshot, plan);
  if (snapshot.eventCalendarId === plan.sourceCalendarId) return classifyZeroPlanSource(snapshot, plan);
  return classifyZeroPlanOtherCalendar();
}

function classifyReconciliation(
  snapshot: ReconciliationSnapshot,
  plan: PendingAttachmentMigration
): ReconciliationOutcome {
  return plan.attachments.length === 0
    ? classifyZeroPlanReconciliation(snapshot, plan)
    : classifyNonzeroPlanReconciliation(snapshot, plan);
}

type ReconciliationResult =
  | { outcome: "committed"; eventUpdatedAt: string }
  | { outcome: "committed-superseded"; eventUpdatedAt: string }
  | { outcome: "retryable-not-committed" }
  | { outcome: "terminal-conflict" }
  | { outcome: "ambiguous" }
  | { outcome: "identity-stale" };

/**
 * 12節: reconciliationはremote readのため、current identityが必須。identity staleなら
 * reconciliationを実行せず（remote副作用0のまま）、recordを消さずに戻る
 * （A再ログイン後にA recordとして再開できるようにする）。
 * P0035（5節）: committed判定時は、fresh snapshotが返した実際のeventUpdatedAtを
 * 一緒に返す——呼び出し元がdurable committedUpdatedAtへそのまま書き込むため。
 * P0044（1節）: committed-supersededも同様にfresh eventUpdatedAtを一緒に返す
 * （呼び出し元がdurable committedUpdatedAtへ「migrationが実際にcommitした
 * 事実の証拠」として書き込む——staleなexpectedUpdatedAtと混同しない）。
 */
async function reconcileAttachmentMigration(
  plan: PendingAttachmentMigration,
  identity: SharedOperationIdentity
): Promise<ReconciliationResult> {
  if (!isCurrentSharedMutationIdentity(identity)) return { outcome: "identity-stale" };
  let snapshot;
  try {
    // [P0080 AUTH-F013-F017-001] この論理readのためだけにauth snapshotを捕捉する。
    const auth = await captureSharedMutationAuthSnapshot(identity);
    snapshot = await fetchEventReconciliationSnapshot(plan.eventId, auth);
  } catch {
    // captureSharedMutationAuthSnapshotのstale例外もここへ落ちるが、直後のisCurrentSharedMutationIdentity
    // チェックが必ずidentity-staleとして正しく分類し直すため、ambiguousへ誤分類されることはない。
    if (!isCurrentSharedMutationIdentity(identity)) return { outcome: "identity-stale" };
    return { outcome: "ambiguous" }; // fail-closed: 判定不能はambiguous扱い（malformed target patch含む）
  }
  if (!isCurrentSharedMutationIdentity(identity)) return { outcome: "identity-stale" };
  if (!snapshot) return { outcome: "ambiguous" }; // eventそのものが読めない: 勝手にcommitted/terminal-conflictと決めない
  const outcome = classifyReconciliation(snapshot, plan);
  if (outcome === "committed" || outcome === "committed-superseded") {
    return { outcome, eventUpdatedAt: snapshot.eventUpdatedAt };
  }
  return { outcome };
}

// ============================================================
// 3節・6節: plan作成（副作用の前に必ず永続化する）
// ============================================================

export interface AttachmentMigrationPlanAttachmentInput {
  sourceAttachmentId: string;
  /** plan作成時に一度だけ生成し、retryでも同じIDを使うこと（呼び出し元の責任）。 */
  destinationAttachmentId: string;
  mimeType: AttachmentMimeType;
  byteSize: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
}

export interface StartAttachmentMigrationInput {
  ownerUserId: string;
  eventId: string;
  sourceCalendarId: string;
  targetCalendarId: string;
  expectedUpdatedAt: string;
  targetEvent: AttachmentMigrationTargetEventPatch;
  attachments: AttachmentMigrationPlanAttachmentInput[];
}

/**
 * 19節1: このplan作成自体は永続化のみを行い、いかなるremote副作用（Storage/RPC）も
 * 一切開始しない。永続化に失敗した場合（write例外）は、以降の副作用が0件のまま
 * 例外を伝播する。
 * P0035（4節）: identity.userIdがinput.ownerUserIdと一致しない場合、record自体を
 * 一切永続化せずに`AttachmentMigrationOwnerMismatchError`を投げる（他ユーザーの
 * ownerUserIdを騙ってrecordを作成できないようにする、defense-in-depth——
 * planAndRunAttachmentMigration側のチェックだけに頼らない）。
 * P0036（9節）: owner一致だけでは不十分——identity自体が開始時点で既にstaleな
 * same-user session（別session generation）である場合も、record永続化前に
 * `AttachmentMigrationStaleError`で拒否する。「開始時からstale」と「開始後に
 * remote await中にstale化」（advanceAttachmentMigrationループ内の既存チェックが
 * 担当・recordは保持されfresh identityでの再開/reconciliationに委ねる）を混同しない。
 * P0037（2節）: entry時点のcurrentチェックだけでは、repositoryのqueue/read待ち中に
 * session generationが変わるrace（entry通過後・実際のAsyncStorage書込み前）を
 * 防げない。`startAttachmentMigration`の`beforeWrite`callbackへ同じowner/current
 * チェックを渡し、write直前の最終gateとしても評価させる（entry gateとfinal gateの
 * 二重チェック、linearization: entry check → repository async read/queue wait →
 * final gate → 実際のlocal write開始、を正本とする）。
 */
export async function planAttachmentMigration(
  input: StartAttachmentMigrationInput,
  identity: SharedOperationIdentity
): Promise<PendingAttachmentMigration> {
  if (identity.userId !== input.ownerUserId) {
    throw new AttachmentMigrationOwnerMismatchError("planAttachmentMigration");
  }
  if (!isCurrentSharedMutationIdentity(identity)) {
    throw new AttachmentMigrationStaleError("planAttachmentMigration-entry");
  }
  const operationId = Crypto.randomUUID();
  const attachments: PendingAttachmentMigrationAttachment[] = input.attachments.map((a) => ({
    sourceAttachmentId: a.sourceAttachmentId,
    destinationAttachmentId: a.destinationAttachmentId,
    sourceStoragePath: buildCanonicalAttachmentPath(input.sourceCalendarId, input.eventId, a.sourceAttachmentId),
    destinationStoragePath: buildCanonicalAttachmentPath(
      input.targetCalendarId,
      input.eventId,
      a.destinationAttachmentId
    ),
    mimeType: a.mimeType,
    byteSize: a.byteSize,
    width: a.width,
    height: a.height,
    sortOrder: a.sortOrder,
    destinationStaged: false,
    sourceCleaned: false,
  }));

  const record: PendingAttachmentMigration = {
    operationId,
    ownerUserId: input.ownerUserId,
    eventId: input.eventId,
    sourceCalendarId: input.sourceCalendarId,
    targetCalendarId: input.targetCalendarId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    committedUpdatedAt: null,
    targetEvent: input.targetEvent,
    attachments,
    phase: "planned",
  };

  // 4節（same-event uniqueness）はstartAttachmentMigration内部（repository）で強制される。
  await startAttachmentMigration(record, {
    beforeWrite: () => {
      if (identity.userId !== input.ownerUserId) {
        throw new AttachmentMigrationOwnerMismatchError("planAttachmentMigration-pre-write");
      }
      if (!isCurrentSharedMutationIdentity(identity)) {
        throw new AttachmentMigrationStaleError("planAttachmentMigration-pre-write");
      }
    },
  });
  return record;
}

// ============================================================
// 17節: operation lifecycle stepper
// ============================================================

function toRpcPlanPatch(plan: PendingAttachmentMigration) {
  return {
    eventId: plan.eventId,
    sourceCalendarId: plan.sourceCalendarId,
    targetCalendarId: plan.targetCalendarId,
    expectedUpdatedAt: plan.expectedUpdatedAt,
    title: plan.targetEvent.title,
    date: plan.targetEvent.date,
    startTime: plan.targetEvent.startTime,
    endTime: plan.targetEvent.endTime,
    allDay: plan.targetEvent.allDay,
    location: plan.targetEvent.location,
    durationMinutes: plan.targetEvent.durationMinutes,
    restrictedApps: plan.targetEvent.restrictedApps,
    unlockCondition: plan.targetEvent.unlockCondition,
    notification: plan.targetEvent.notification,
    repeat: plan.targetEvent.repeat,
    memo: plan.targetEvent.memo,
    completed: plan.targetEvent.completed,
    recurringGroupId: plan.targetEvent.recurringGroupId,
    recurrenceIndex: plan.targetEvent.recurrenceIndex,
    attachmentManifest: plan.attachments.map((a) => ({
      sourceAttachmentId: a.sourceAttachmentId,
      destinationAttachmentId: a.destinationAttachmentId,
      storagePath: a.sourceStoragePath,
      mimeType: a.mimeType,
      byteSize: a.byteSize,
      width: a.width,
      height: a.height,
      sortOrder: a.sortOrder,
    })),
  };
}

/** stageの残り（destinationStaged=falseのもの）を先頭から順に処理する。1件失敗したら以降は着手しない。 */
async function stageRemainingDestinations(
  plan: PendingAttachmentMigration,
  identity: SharedOperationIdentity
): Promise<{ ok: true } | { ok: false; stale: boolean }> {
  for (const attachment of plan.attachments) {
    if (attachment.destinationStaged) continue;
    try {
      await stageDestinationAttachment(
        attachment,
        { sourceCalendarId: plan.sourceCalendarId, targetCalendarId: plan.targetCalendarId, eventId: plan.eventId },
        identity
      );
    } catch (e) {
      if (e instanceof AttachmentMigrationStaleError) return { ok: false, stale: true };
      return { ok: false, stale: false };
    }
    await updatePendingAttachmentMigration(plan.operationId, (current) => ({
      ...current,
      phase: current.phase === "planned" ? "destination-staging" : current.phase,
      attachments: current.attachments.map((a) =>
        a.destinationAttachmentId === attachment.destinationAttachmentId ? { ...a, destinationStaged: true } : a
      ),
    }));
  }
  return { ok: true };
}

/**
 * source cleanupの残り（sourceCleaned=falseのもの）を先頭から順に処理する。
 * P0044（2節）: 呼び出し元がdurable phaseとして書き込む値を`targetPhase`で
 * 指定できるようにする——固定で"source-cleanup-pending"を書いていると、
 * committed-superseded由来のsource-cleanup-pending-conflictがcleanup成功の
 * たびに普通のsource-cleanup-pendingへ巻き戻ってしまい、conflict
 * dispositionを失う（＝次回retryがcommitted resultを返しかねない）。
 */
async function cleanupRemainingSources(
  plan: PendingAttachmentMigration,
  identity: SharedOperationIdentity,
  targetPhase: "source-cleanup-pending" | "source-cleanup-pending-conflict" = "source-cleanup-pending"
): Promise<{ ok: true } | { ok: false; stale: boolean }> {
  for (const attachment of plan.attachments) {
    if (attachment.sourceCleaned) continue;
    let removed: boolean;
    try {
      removed = await cleanupSourceAttachmentStorage(
        attachment,
        { sourceCalendarId: plan.sourceCalendarId, eventId: plan.eventId },
        identity
      );
    } catch (e) {
      if (e instanceof AttachmentMigrationStaleError) return { ok: false, stale: true };
      return { ok: false, stale: false };
    }
    if (!removed) return { ok: false, stale: false };
    await updatePendingAttachmentMigration(plan.operationId, (current) => ({
      ...current,
      phase: targetPhase,
      attachments: current.attachments.map((a) =>
        a.sourceAttachmentId === attachment.sourceAttachmentId ? { ...a, sourceCleaned: true } : a
      ),
    }));
  }
  return { ok: true };
}

/**
 * P0035（7節）/P0036（2節）: destination staging中（RPC呼び出し前、
 * phase="planned"/"destination-staging"）にstageRemainingDestinationsが通常失敗
 * （stale以外）した場合、fresh remote readでsource側の状態を確認し、
 * transient failure（network blip等、source状態は変化なし）か
 * permanent source change（他者が既にsourceを移動/変更済み）かを区別する。
 * P0036（3節）: RPC unknown reconciliation用のclassifyReconciliationとは
 * 役割を分離した、pre-RPC専用のtransient/permanent/unknown判定を行う——
 * classifyReconciliationの3分類（committed/not-committed/ambiguous）を
 * そのまま流用しない（committed/ambiguousをpermanentと混同する危険があるため）。
 *
 * design lock: このロジックはphase="planned"/"destination-staging"の場合のみ呼ぶこと。
 * rpc-unknown以降（RPCが実際に呼ばれた可能性がある状態）では絶対に呼ばない——
 * その状態でdestination行が実際にcommit済みの可能性があり、それをpermanentと
 * 誤判定してdestination cleanupしてしまうと、正当にcommitされたdestination
 * attachmentを破壊しかねないため。
 *
 * 判定不能（fetch失敗・event未検出・destination DB ID存在・source側の一部不一致で
 * event calendarはsourceのまま等）は、常にunknown（=破壊的操作0件、pending-retryの
 * ままrecord保持）に倒す。
 */
async function recoverFromPreRpcStagingFailure(
  plan: PendingAttachmentMigration,
  identity: SharedOperationIdentity
): Promise<{ outcome: "identity-stale" | "transient" | "permanent" | "unknown" }> {
  if (!isCurrentSharedMutationIdentity(identity)) return { outcome: "identity-stale" };
  let snapshot;
  try {
    // [P0080 AUTH-F013-F017-001] この論理readのためだけにauth snapshotを捕捉する。
    const auth = await captureSharedMutationAuthSnapshot(identity);
    snapshot = await fetchEventReconciliationSnapshot(plan.eventId, auth);
  } catch {
    if (!isCurrentSharedMutationIdentity(identity)) return { outcome: "identity-stale" };
    return { outcome: "unknown" };
  }
  if (!isCurrentSharedMutationIdentity(identity)) return { outcome: "identity-stale" };
  if (!snapshot) return { outcome: "unknown" };

  // P0036（3節）: destination DB IDが1件でも存在すれば、pre-RPC local phaseと
  // remote stateが矛盾している——このdestination行がcanonicalかどうかをこの局面で
  // 断定できないため、無条件でunknownへ倒す（event calendarがsourceでない、という
  // 理由だけでpermanentと即断しない）。
  const destinationIds = new Set(plan.attachments.map((a) => a.destinationAttachmentId));
  if (snapshot.attachments.some((r) => destinationIds.has(r.id))) {
    return { outcome: "unknown" };
  }

  // destination行の不在を確認済みのうえで、source側が完全一致（event calendar含む）
  // ならtransient（network blip等でsource状態自体は変化していない）。
  if (
    snapshot.eventCalendarId === plan.sourceCalendarId &&
    sourceRowsExactMatch(snapshot.attachments, plan)
  ) {
    return { outcome: "transient" };
  }

  // destination行は不在、かつsource側が完全一致ではない
  // （calendar移動・source行欠落/追加行・metadata不一致・非readyステータス・
  // soft delete等）: permanent source change。
  return { outcome: "permanent" };
}

/** abort後のdestination cleanup残り（destinationStaged=trueのもの、=まだ削除できていないもの）を処理する。 */
async function cleanupRemainingAbortedDestinations(
  plan: PendingAttachmentMigration,
  identity: SharedOperationIdentity
): Promise<{ ok: true } | { ok: false; stale: boolean }> {
  for (const attachment of plan.attachments) {
    if (!attachment.destinationStaged) continue;
    let removed: boolean;
    try {
      removed = await cleanupAbortedDestinationStorage(
        attachment,
        { targetCalendarId: plan.targetCalendarId, eventId: plan.eventId },
        identity
      );
    } catch (e) {
      if (e instanceof AttachmentMigrationStaleError) return { ok: false, stale: true };
      return { ok: false, stale: false };
    }
    if (!removed) return { ok: false, stale: false };
    await updatePendingAttachmentMigration(plan.operationId, (current) => ({
      ...current,
      attachments: current.attachments.map((a) =>
        a.destinationAttachmentId === attachment.destinationAttachmentId ? { ...a, destinationStaged: false } : a
      ),
    }));
  }
  return { ok: true };
}

/**
 * 永続化済みrecordを、可能な限り先まで進める。1回の呼出しで複数phaseをまたいで
 * 前進しうる（例: destination-staged → rpc-unknown → committed → source cleanup完了 →
 * record clear、を1passで完了することもある）。identity staleを検知した時点で
 * 即座に停止し、recordは可能な限り安全な状態のまま残す。
 */
async function advanceAttachmentMigration(
  operationId: string,
  ownerUserId: string,
  identity: SharedOperationIdentity
): Promise<AttachmentMigrationResult> {
  // P0035（7節）: abort-destination-cleanup-pendingへ入った理由を、このpass内でのみ
  // 記録する（durable recordへは保存しない——診断用のconflict.reason文字列にのみ使う）。
  // 前回のpassで既にabort-destination-cleanup-pendingへ入っていた場合（このpassでは
  // 自分では遷移させていない）はデフォルトのrpc_definite_rollbackのまま扱う。
  let abortReason: string = "rpc_definite_rollback";

  // ループ: 各iterationの先頭でfresh recordを読み直す（他のpassとの直接競合はrepositoryの
  // enqueueAttachmentMigrationOp直列化キューが防ぐが、phase判定は常に最新値で行う）。
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!isCurrentSharedMutationIdentity(identity)) return { status: "stale" };

    const forOwner = await getPendingAttachmentMigrationsForOwner(ownerUserId);
    const plan = forOwner.find((m) => m.operationId === operationId);
    if (!plan) return { status: "not-found" };

    switch (plan.phase) {
      case "planned":
      case "destination-staging": {
        const staged = await stageRemainingDestinations(plan, identity);
        if (staged.ok) {
          await updatePendingAttachmentMigration(operationId, (current) => ({
            ...current,
            phase: "destination-staged",
          }));
          continue;
        }
        if (staged.stale) return { status: "stale" };
        // P0035（7節）: RPC呼び出し前のみ、fresh readでsourceの状態を確認する。
        const recovery = await recoverFromPreRpcStagingFailure(plan, identity);
        if (recovery.outcome === "identity-stale") return { status: "stale" };
        if (recovery.outcome === "permanent") {
          abortReason = "source_changed_before_rpc";
          // P0036（7節）: abortへ遷移する直前に、durable recordのphaseが依然として
          // planned/destination-stagingのままであることをfresh再確認する（whole-operation
          // coordinatorにより同一processでの競合は通常起きないが、durable stateを
          // authorityとする防御を維持する）。既に他phaseへ進んでいた場合は何もせず、
          // 次のloop iterationがそのphaseへ正しく分岐する。
          await updatePendingAttachmentMigration(operationId, (current) => {
            if (current.phase !== "planned" && current.phase !== "destination-staging") {
              return current;
            }
            return { ...current, phase: "abort-destination-cleanup-pending" };
          });
          continue;
        }
        return { status: "pending-retry" }; // transient/unknown: 破壊的操作0件のままrecord保持
      }

      case "destination-staged": {
        // 8節・9節: RPC呼び出し前に、まずphaseを`rpc-unknown`へdurably遷移させる
        // （呼び出し前の最後の安全なcheckpoint）。RPC結果を確認できた場合のみ
        // committed/abort-destination-cleanup-pendingへ進める。確認できなければ
        // `rpc-unknown`のまま残り、次回はRPCを再度呼ばずreconciliationへ進む
        // （成功後のdurable write失敗によるRPC二重呼出しを防ぐ）。
        if (!isCurrentSharedMutationIdentity(identity)) return { status: "stale" };
        await updatePendingAttachmentMigration(operationId, (current) => ({ ...current, phase: "rpc-unknown" }));

        let result: MoveSharedEventAndAttachmentsResult;
        try {
          // [P0080 AUTH-F013-F017-001] この論理RPC送信のためだけにauth snapshotを捕捉する。
          const auth = await captureSharedMutationAuthSnapshot(identity);
          result = await invokeMoveSharedEventAndAttachmentsRpc(toRpcPlanPatch(plan), auth);
        } catch (e) {
          if (!isCurrentSharedMutationIdentity(identity)) return { status: "stale" };
          if (isDefiniteRpcRollbackError(e)) {
            await updatePendingAttachmentMigration(operationId, (current) => ({
              ...current,
              phase: "abort-destination-cleanup-pending",
            }));
            continue;
          }
          // unknown outcome: destructive cleanupへ進まない。phaseは既にrpc-unknown。
          // 11節のreconciliationを、外部からの再試行を待たず同一pass内で試みる
          // （次のloop iterationがphase="rpc-unknown"のcaseへ入り、fresh remote readで
          // 判定する）。
          continue;
        }

        if (!isCurrentSharedMutationIdentity(identity)) return { status: "stale" };
        if (!validateRpcResult(result, plan)) {
          // 想定外の形状: committedとみなさず、次回reconciliationに委ねる。
          return { status: "pending-retry" };
        }
        // P0035（5節）: durable committedUpdatedAtは、RPCが実際に返した新しいupdated_at
        // （result.committedUpdatedAt）で確定する。plan.expectedUpdatedAt（PRE-RPCの
        // caller供給値）とは別物であり、これをcommittedUpdatedAtへ書き込まないこと。
        await updatePendingAttachmentMigration(operationId, (current) => ({
          ...current,
          phase: "committed",
          committedUpdatedAt: result.committedUpdatedAt,
        }));
        continue;
      }

      case "rpc-unknown": {
        // P0043（4節・5節）: reconciliationは1pass内で最大1回。retryable-not-committedの
        // 場合でも、phaseを"destination-staged"へ戻して"destination-staged" caseの
        // RPC呼び出しロジックへ再突入させない——そちらのdefinite-rollback判定は
        // 「このRPCが最初の1回目」を前提にした既存contract（16節test4）のままにする
        // 必要があり、rpc-unknownからのretryにそのまま使うと、retry自身の構造化エラーを
        // 「先行unknown RPCがrollbackされた証拠」と誤認してdestination cleanupへ
        // 進んでしまう（P0043で発見されたP1）。retryはこのcase内で直接・最大1回だけ行う。
        const reconciled = await reconcileAttachmentMigration(plan, identity);
        if (reconciled.outcome === "identity-stale") return { status: "stale" };
        if (reconciled.outcome === "ambiguous") return { status: "pending-retry" }; // fail-closed、record保持

        if (reconciled.outcome === "committed") {
          // fresh snapshotが返した実際のeventUpdatedAtをdurableに確定する。
          await updatePendingAttachmentMigration(operationId, (current) => ({
            ...current,
            phase: "committed",
            committedUpdatedAt: reconciled.eventUpdatedAt,
          }));
          continue;
        }

        if (reconciled.outcome === "committed-superseded") {
          // P0044（1節・2節）: migration自体のcommitは確定しているが、fresh eventが
          // 既に別端末/別sessionの後続編集（P2）へ乖離している——stale patch（plan
          // のP1）をcommittedとして返さず、専用phaseへ進めてsource cleanupのみ行う
          // （destination側は既に正しくcommit済みのためcleanup対象にしない）。
          await updatePendingAttachmentMigration(operationId, (current) => ({
            ...current,
            phase: "source-cleanup-pending-conflict",
            committedUpdatedAt: reconciled.eventUpdatedAt,
          }));
          continue;
        }

        if (reconciled.outcome === "terminal-conflict") {
          // fresh remote stateから、old unknown RPCが今後commitできないことを構造的に
          // 証明できた場合のみここへ進む（destination cleanup 0のretryable errorとは
          // 明確に区別する）。
          abortReason = "rpc_unknown_terminal_conflict";
          await updatePendingAttachmentMigration(operationId, (current) => {
            if (current.phase !== "rpc-unknown") return current;
            return { ...current, phase: "abort-destination-cleanup-pending" };
          });
          continue;
        }

        // retryable-not-committed: source retry invariantを満たすことを確認済み。
        // 同じfixed planで、このpass内に限り最大1回だけRPCを再送する（5節: tight retry
        // loop禁止——このcaseは1passにつき1回しか到達しないため、ループでの無制限retryは
        // 起きない）。
        if (!isCurrentSharedMutationIdentity(identity)) return { status: "stale" };
        let retryResult: MoveSharedEventAndAttachmentsResult;
        try {
          // [P0080 AUTH-F013-F017-001] retry RPC送信のためだけにauth snapshotを再捕捉する。
          const auth = await captureSharedMutationAuthSnapshot(identity);
          retryResult = await invokeMoveSharedEventAndAttachmentsRpc(toRpcPlanPatch(plan), auth);
        } catch (e) {
          if (!isCurrentSharedMutationIdentity(identity)) return { status: "stale" };
          // P0043（4節）: retry RPC error != 先行のunknown RPCがすべてrollbackされた証明。
          // 構造化definite rollbackであっても、ここではabort-destination-cleanup-pendingへ
          // 進まない——phaseはrpc-unknownのまま保持し、次回lifecycle retryで
          // fresh reconciliationからやり直す。
          void e;
          return { status: "pending-retry" };
        }

        if (!isCurrentSharedMutationIdentity(identity)) return { status: "stale" };
        if (!validateRpcResult(retryResult, plan)) {
          return { status: "pending-retry" };
        }
        await updatePendingAttachmentMigration(operationId, (current) => ({
          ...current,
          phase: "committed",
          committedUpdatedAt: retryResult.committedUpdatedAt,
        }));
        continue;
      }

      case "committed":
      case "source-cleanup-pending": {
        // source cleanup試行前に、durable phaseを"source-cleanup-pending"へ確定させる
        // （cleanupRemainingSourcesが最初の1件で即座に失敗した場合でも、phaseが
        // "committed"のまま取り残されないようにする——次回retryが同じ"committed"/
        // "source-cleanup-pending"の両caseへ入ること自体は安全だが、durable stateとして
        // 「source cleanup試行中」であることを正しく反映するため）。
        if (plan.phase === "committed") {
          await updatePendingAttachmentMigration(operationId, (current) => ({
            ...current,
            phase: "source-cleanup-pending",
          }));
        }
        const cleaned = await cleanupRemainingSources(plan, identity);
        if (!cleaned.ok) return cleaned.stale ? { status: "stale" } : { status: "pending-retry" };
        // P0035（5節）: 呼び出し元へ返す最終値は、必ずdurable committedUpdatedAt
        // （RPC/reconciliationが実際に確定した新しいupdated_at）を使う。
        // plan.expectedUpdatedAt（PRE-RPCのcaller供給値）を返してはならない——
        // repositoryのphase不変条件により、この時点でplan.committedUpdatedAtは
        // 必ず非nullのはず（そうでなければ内部不整合として例外を投げる）。
        if (plan.committedUpdatedAt === null) {
          throw new Error(
            "attachment migration internal invariant violated: committed phase missing committedUpdatedAt"
          );
        }
        const committedUpdatedAt = plan.committedUpdatedAt;
        await clearPendingAttachmentMigration(operationId);
        return { status: "committed", committedUpdatedAt };
      }

      case "source-cleanup-pending-conflict": {
        // P0044（2節）: committed-supersededのdurable disposition。source cleanupのみ
        // 行い、cleanup成功後もphaseは既にこの専用値のまま——普通のsource-cleanup-pending
        // へ書き戻さない（cleanupRemainingSourcesへtargetPhaseを明示的に渡す）ため、
        // cleanup/clear retryを何度挟んでもconflict dispositionを失わない。
        const cleaned = await cleanupRemainingSources(plan, identity, "source-cleanup-pending-conflict");
        if (!cleaned.ok) return cleaned.stale ? { status: "stale" } : { status: "pending-retry" };
        await clearPendingAttachmentMigration(operationId);
        return { status: "conflict", reason: "rpc_unknown_committed_superseded" };
      }

      case "abort-destination-cleanup-pending": {
        const cleaned = await cleanupRemainingAbortedDestinations(plan, identity);
        if (!cleaned.ok) return cleaned.stale ? { status: "stale" } : { status: "pending-retry" };
        await clearPendingAttachmentMigration(operationId);
        return { status: "conflict", reason: abortReason };
      }

      default:
        return { status: "pending-retry" };
    }
  }
}

// ============================================================
// P0035（2節）: operation単位のcoordinator
// ============================================================

/**
 * 同一のdurable migration operation（ownerUserId+operationId）を、plan直後の実行・
 * resume・retryのどのentry pointから並行に呼んでも、advanceAttachmentMigrationの
 * 実行が互いに重ならないよう直列化する。P0024の`runSerializedAttachmentTarget`
 * （ownerUserId+attachmentId）とは別のkey空間（ownerUserId+operationId）——
 * 混同しないこと。各operationが直列化される順で実行され、chainが解決した時点で
 * 誰も後続を並べていなければMapからkeyを除去する（無制限に育たないようにする）。
 */
const migrationOperationChains = new Map<string, Promise<void>>();

function migrationOperationKey(ownerUserId: string, operationId: string): string {
  return `${ownerUserId}::${operationId}`;
}

function runSerializedMigrationOperation<T>(
  ownerUserId: string,
  operationId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = migrationOperationKey(ownerUserId, operationId);
  const previousChain = migrationOperationChains.get(key) ?? Promise.resolve();
  const run = previousChain.then(operation);
  const nextChain = run.then(
    () => undefined,
    () => undefined
  );
  migrationOperationChains.set(key, nextChain);
  nextChain.then(() => {
    if (migrationOperationChains.get(key) === nextChain) {
      migrationOperationChains.delete(key);
    }
  });
  return run;
}

/** テスト専用: operation coordinatorのモジュールスコープ状態をリセットする。 */
export function __resetAttachmentMigrationOperationCoordinatorForTests(): void {
  migrationOperationChains.clear();
}

/**
 * planAttachmentMigration()の直後に呼び、そのまま実行まで進める便宜関数。
 * P0035（4節）: identity.userId !== input.ownerUserIdの場合はplanAttachmentMigration自体が
 * 例外を投げ、record永続化を含む一切の副作用が発生しない。
 * P0035（2節）: advanceAttachmentMigrationの実行はoperation coordinatorへ通す
 * （新規operationIdのため、同時に同じoperationIdへ他から並ぶことは通常起きないが、
 * 直後に発行されるresume/retryと衝突しないよう、常にcoordinator経由で統一する）。
 */
export async function planAndRunAttachmentMigration(
  input: StartAttachmentMigrationInput,
  identity: SharedOperationIdentity
): Promise<AttachmentMigrationResult> {
  const plan = await planAttachmentMigration(input, identity);
  return runSerializedMigrationOperation(plan.ownerUserId, plan.operationId, () =>
    advanceAttachmentMigration(plan.operationId, plan.ownerUserId, identity)
  );
}

/**
 * 既存の未完了operationを、そのeventIdから再開する。UI統合前のテスト用エントリでもある。
 * P0035（4節）: identity.userId !== ownerUserIdの場合は、repositoryの読込みすら行わず
 * 即座に例外を投げる（他ユーザーのownerUserIdを指定してoperationを進行させられない
 * ようにする）。
 * P0036（9節）: owner一致に加えて、identity自体が現在current（session generationが
 * 最新）であることも、repositoryの読込み前に要求する。staleならA recordを一切変更
 * せずに例外を投げる（remote副作用0、A recordはfresh identityでの再開のため保持される）。
 * P0035（2節）: 同一operationIdに対するretry engine等の並行呼び出しと衝突しないよう、
 * advanceAttachmentMigrationの実行はoperation coordinator経由に統一する
 * （lock取得後にadvanceAttachmentMigration自身がfresh recordを読み直すため、
 * 「lock取得後の再読込み」要件はそのまま満たされる）。
 */
export async function resumeAttachmentMigrationForEvent(
  ownerUserId: string,
  eventId: string,
  identity: SharedOperationIdentity
): Promise<AttachmentMigrationResult> {
  if (identity.userId !== ownerUserId) {
    throw new AttachmentMigrationOwnerMismatchError("resumeAttachmentMigrationForEvent");
  }
  if (!isCurrentSharedMutationIdentity(identity)) {
    throw new AttachmentMigrationStaleError("resumeAttachmentMigrationForEvent-entry");
  }
  const existing = await getPendingAttachmentMigrationForEvent(ownerUserId, eventId);
  if (!existing) return { status: "not-found" };
  return runSerializedMigrationOperation(ownerUserId, existing.operationId, () =>
    advanceAttachmentMigration(existing.operationId, ownerUserId, identity)
  );
}

// ============================================================
// 16節: retry engine（single-flight + rerun、P0022と同型）
// ============================================================

let attachmentMigrationRetryRunPromise: Promise<void> | null = null;
let attachmentMigrationRetryRerunRequested = false;

/**
 * 現在ログイン中のownerUserIdに属するmigration recordだけを、同じidentityを使って
 * 1件ずつ順番に再開する（未ログイン時は何もしない。他ユーザーの対象には一切触れない）。
 * 例外は外へ投げない。P0034では**App start/AppStateへまだ本配線しない**（後続P0035）。
 *
 * cloudAttachmentRepository.tsのretryPendingAttachmentCleanupsと同じ設計:
 * 実行中に追加のtriggerが来た場合、現在のpass完了後にもう1pass実行する
 * （要求は1個のbooleanへcoalesceされるため、無制限に連鎖しない）。各pass（再passを含む）は
 * 内部で`getCurrentAuthIdentity()`をfresh取得するため、identity変更中もold identityの
 * remote continuationを止め、new identity passはそのowner recordだけを読む。
 */
export function retryPendingAttachmentMigrations(): Promise<void> {
  if (attachmentMigrationRetryRunPromise) {
    attachmentMigrationRetryRerunRequested = true;
    return attachmentMigrationRetryRunPromise;
  }
  attachmentMigrationRetryRunPromise = (async () => {
    try {
      await runRetryPendingAttachmentMigrations();
      while (attachmentMigrationRetryRerunRequested) {
        attachmentMigrationRetryRerunRequested = false;
        await runRetryPendingAttachmentMigrations();
      }
    } finally {
      attachmentMigrationRetryRerunRequested = false;
      attachmentMigrationRetryRunPromise = null;
    }
  })();
  return attachmentMigrationRetryRunPromise;
}

async function runRetryPendingAttachmentMigrations(): Promise<void> {
  const current = getCurrentAuthIdentity();
  if (!current.userId || !current.sessionInstanceId) return;
  const identity: SharedOperationIdentity = {
    userId: current.userId,
    sessionInstanceId: current.sessionInstanceId,
  };

  let pending;
  try {
    pending = await getPendingAttachmentMigrationsForOwner(identity.userId);
  } catch (e) {
    if (__DEV__) {
      console.warn("[attachmentMigrationService] 未完了migration一覧の読込みに失敗しました", e);
    }
    return; // corrupt state: remote副作用0、auto-clearしない（18節）
  }

  for (const migration of pending) {
    try {
      // P0035（2節）: 同一operationIdへplan直後の実行やresumeが並行に走っても
      // 安全なよう、advanceAttachmentMigrationの実行はoperation coordinator経由に統一する。
      await runSerializedMigrationOperation(identity.userId, migration.operationId, () =>
        advanceAttachmentMigration(migration.operationId, identity.userId, identity)
      );
    } catch (e) {
      if (__DEV__) {
        console.warn("[attachmentMigrationService] migrationの再試行に失敗しました", e);
      }
    }
  }
}

/** テスト専用: retryコーディネーターのモジュールスコープ状態をリセットする。 */
export function __resetAttachmentMigrationRetryCoordinatorForTests(): void {
  attachmentMigrationRetryRunPromise = null;
  attachmentMigrationRetryRerunRequested = false;
}
