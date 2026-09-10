import AsyncStorage from "@react-native-async-storage/async-storage";
import { writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";
import {
  isPlainObject,
  isString,
  isBoolean,
  isOneOf,
  isStringArray,
  isValidDateOnlyString,
  isValidTimeString,
  isValidIsoDateTimeString,
} from "./shapeGuards";
import { AttachmentMimeType } from "@/types/attachment";
import { NotificationSetting, RepeatSetting, RepeatType, UnlockCondition, UnlockConditionType } from "@/types/event";

/**
 * P0034（QA-F007 C14、client migration core）: shared calendar A→B の添付付きevent移動
 * （C14 RPC = move_shared_event_and_attachments）を跨ぐdurable operation記録。
 * `attachmentCleanupRepository.ts`（Round13〜）と同じ設計原則
 * （副作用の前に必ず永続化する・strict JSON parse・fail-closed・owner明示）を踏襲するが、
 * 別スキーマ・別state機械として完全に独立させる。
 *
 * 状態遷移（17節）:
 *   start plan → planned → destination-staging → destination-staged → RPC
 *   → committed | rpc-unknown | (definite rollback: abort-destination-cleanup-pending)
 *   → reconcile if unknown → source-cleanup-pending → complete → record clear
 *
 * P0044（2節）: rpc-unknown reconciliationがcommitted-superseded
 * （migration自体はcommit確定だが、fresh event stateが別端末の後続編集で
 * plan.targetEventと既に乖離している）と判定した場合の専用disposition。
 * source-cleanup-pendingと同じくsource cleanupのみ行うが、cleanup成功後も
 * 最終結果は"committed"ではなく"conflict"のまま——cleanup/clear retryを何度
 * 挟んでもこのconflict dispositionを失わない（普通のcommitted系phaseへ
 * 巻き戻さない）ための独立phase。
 *   → reconcile if unknown & superseded → source-cleanup-pending-conflict
 *   → complete → record clear（result: conflict）
 */
export type AttachmentMigrationPhase =
  | "planned"
  | "destination-staging"
  | "destination-staged"
  | "rpc-unknown"
  | "committed"
  | "source-cleanup-pending"
  | "source-cleanup-pending-conflict"
  | "abort-destination-cleanup-pending";

const ATTACHMENT_MIGRATION_PHASES: readonly AttachmentMigrationPhase[] = [
  "planned",
  "destination-staging",
  "destination-staged",
  "rpc-unknown",
  "committed",
  "source-cleanup-pending",
  "source-cleanup-pending-conflict",
  "abort-destination-cleanup-pending",
];

const ATTACHMENT_MIME_TYPES: readonly AttachmentMimeType[] = ["image/jpeg", "image/png", "image/webp"];

/**
 * RPC（0019: move_shared_event_and_attachments）へ送るevent patchのwhitelist。
 * caller供給の任意フィールドを展開しない（8節: event patch whitelist以外を送らない）。
 * createdBy/createdAt・destination storage pathはここに含めない
 * （サーバー側で決定する値をclientから送らない、8節）。
 */
export interface AttachmentMigrationTargetEventPatch {
  title: string;
  date: string;
  /** P0037（4節）: `public.events.start_time text not null`に合わせ非null必須（HH:mm）。 */
  startTime: string;
  endTime: string | null;
  allDay: boolean;
  location: string | null;
  durationMinutes: number | null;
  restrictedApps: string[] | null;
  unlockCondition: UnlockCondition | null;
  notification: NotificationSetting;
  repeat: RepeatSetting;
  memo: string | null;
  completed: boolean;
  recurringGroupId: string | null;
  recurrenceIndex: number | null;
}

export interface PendingAttachmentMigrationAttachment {
  sourceAttachmentId: string;
  destinationAttachmentId: string;
  sourceStoragePath: string;
  destinationStoragePath: string;
  mimeType: AttachmentMimeType;
  byteSize: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
  destinationStaged: boolean;
  sourceCleaned: boolean;
}

export interface PendingAttachmentMigration {
  operationId: string;
  ownerUserId: string;
  eventId: string;
  sourceCalendarId: string;
  targetCalendarId: string;
  expectedUpdatedAt: string;
  /**
   * P0035（5節）: RPC成功時の実際の応答、またはreconciliation committed判定時の
   * fresh snapshotから得た、サーバーが実際に割り当てたevent.updated_atの新しい値。
   * phase="committed"/"source-cleanup-pending"のときのみ非null（不変条件、
   * parseMigrationEntryで強制する）。それ以外のphaseでは常にnull——
   * expectedUpdatedAt（caller供給のPRE-RPC値）と混同しないこと。
   */
  committedUpdatedAt: string | null;
  targetEvent: AttachmentMigrationTargetEventPatch;
  attachments: PendingAttachmentMigrationAttachment[];
  phase: AttachmentMigrationPhase;
}

/** `{calendarId}/{eventId}/{attachmentId}/original.jpg`の正規形式のみ許可する。 */
function buildCanonicalAttachmentPath(calendarId: string, eventId: string, attachmentId: string): string {
  return `${calendarId}/${eventId}/${attachmentId}/original.jpg`;
}

/**
 * P0037（8節）: shared C14 DB schema（calendars.id/event_attachments.id共にuuid列）に
 * 合わせたUUID形式検証。バージョン非依存（8-4-4-4-12桁の16進数のみ確認する）。
 */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isValidUuidString(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * P0037（8節）: eventIdは`events.id`（text列、UUID castしない）。
 * non-emptyかつ`buildCanonicalAttachmentPath`のpath segmentを壊さないよう`/`を含まないこと
 * だけを要求する（legacy UUID text event IDもそのまま許可する）。
 */
function isPathSafeEventId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("/");
}

/** malformed stateを自動実行しないための例外。呼び出し元はこれを見たら副作用を一切開始しないこと。 */
export class AttachmentMigrationValidationError extends Error {
  readonly code = "attachment-migration-invalid" as const;
  constructor(reason: string) {
    super(`invalid attachment migration record: ${reason}`);
    this.name = "AttachmentMigrationValidationError";
  }
}

/** AsyncStorage読込み・JSON解析・形状のいずれかが不正な場合に投げる。空配列へfallbackしない（fail-closed）。 */
export class AttachmentMigrationCorruptStateError extends Error {
  readonly code = "attachment-migration-corrupt-state" as const;
  constructor(reason: string) {
    super(`pending attachment migration storage is corrupt: ${reason}`);
    this.name = "AttachmentMigrationCorruptStateError";
  }
}

/** 同一ownerUserId+eventIdに既に未完了migrationが存在する場合（4節: same event uniqueness）。 */
export class AttachmentMigrationAlreadyPendingError extends Error {
  readonly code = "attachment-migration-already-pending" as const;
  constructor(public readonly existing: PendingAttachmentMigration) {
    super("an attachment migration is already pending for this owner+event");
    this.name = "AttachmentMigrationAlreadyPendingError";
  }
}

/**
 * 1件のattachment要素の形状・値の一貫性を検証する。
 * - sourceAttachmentId != destinationAttachmentId（DESIGN LOCK、0019のP0032と同じ不変条件）
 * - source/destination storagePathは、同レコードのcalendarId/eventId/attachmentIdから
 *   再構築した正規形と完全一致すること
 */
function validateAttachmentEntry(
  item: unknown,
  sourceCalendarId: string,
  targetCalendarId: string,
  eventId: string
): PendingAttachmentMigrationAttachment {
  if (!isPlainObject(item)) throw new AttachmentMigrationValidationError("attachment entry is not an object");
  const {
    sourceAttachmentId,
    destinationAttachmentId,
    sourceStoragePath,
    destinationStoragePath,
    mimeType,
    byteSize,
    width,
    height,
    sortOrder,
    destinationStaged,
    sourceCleaned,
  } = item;

  if (!isValidUuidString(sourceAttachmentId)) {
    throw new AttachmentMigrationValidationError("sourceAttachmentId missing or not a UUID");
  }
  if (!isValidUuidString(destinationAttachmentId)) {
    throw new AttachmentMigrationValidationError("destinationAttachmentId missing or not a UUID");
  }
  if (sourceAttachmentId === destinationAttachmentId) {
    throw new AttachmentMigrationValidationError("sourceAttachmentId equals destinationAttachmentId");
  }
  if (!isString(sourceStoragePath) || sourceStoragePath !== buildCanonicalAttachmentPath(sourceCalendarId, eventId, sourceAttachmentId)) {
    throw new AttachmentMigrationValidationError("sourceStoragePath does not match canonical shape");
  }
  if (
    !isString(destinationStoragePath) ||
    destinationStoragePath !== buildCanonicalAttachmentPath(targetCalendarId, eventId, destinationAttachmentId)
  ) {
    throw new AttachmentMigrationValidationError("destinationStoragePath does not match canonical shape");
  }
  if (!isOneOf(mimeType, ATTACHMENT_MIME_TYPES)) {
    throw new AttachmentMigrationValidationError("mimeType invalid");
  }
  // P0037（9節）/P0039（4節・5節）: RPC castで必ず失敗するdurable commandを早期fail-closedに
  // するため、byte_size/width/height/sort_orderはPostgreSQL側の実際の列domainまで検証する。
  // width/height/sortOrderは0019 manifestでint4へcastされるためPG int4上限を課す。
  // byteSizeはevent_attachments.byte_size bigintだが、JS/JSON往復・durable比較の
  // exactnessのためNumber.isSafeIntegerを要求する（PG bigint上限そのものは課さない）。
  if (typeof byteSize !== "number" || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
    throw new AttachmentMigrationValidationError("byteSize invalid");
  }
  if (width !== null && !isNonNegativePgInt(width)) {
    throw new AttachmentMigrationValidationError("width invalid");
  }
  if (height !== null && !isNonNegativePgInt(height)) {
    throw new AttachmentMigrationValidationError("height invalid");
  }
  if (!isNonNegativePgInt(sortOrder)) {
    throw new AttachmentMigrationValidationError("sortOrder invalid");
  }
  if (!isBoolean(destinationStaged)) {
    throw new AttachmentMigrationValidationError("destinationStaged invalid");
  }
  if (!isBoolean(sourceCleaned)) {
    throw new AttachmentMigrationValidationError("sourceCleaned invalid");
  }

  return {
    sourceAttachmentId,
    destinationAttachmentId,
    sourceStoragePath,
    destinationStoragePath,
    mimeType,
    byteSize,
    width: width as number | null,
    height: height as number | null,
    sortOrder,
    destinationStaged,
    sourceCleaned,
  };
}

const REPEAT_TYPES: readonly RepeatType[] = ["none", "daily", "weekly", "monthly", "yearly"];
const UNLOCK_CONDITION_TYPES: readonly UnlockConditionType[] = ["none", "calculation"];

// P0039（1節・2節）: durable client commandの数値domainは、0019 RPC/PostgreSQL column
// domainと静的に一致させる。「integerである」だけでは不十分——PostgreSQL `int`（int4）は
// -2147483648..2147483647、C14で使う値は非負なので0..2147483647がint4 domainとなる。
// durationMinutes/recurrenceIndex/width/height/sortOrderは0019で実際にint4列・int4[]配列
// へcastされるSQL parameterのため、この上限を課す（P0038の「4 fieldすべてRPC int列」という
// コメントは不正確だったため訂正: notification/unlockConditionはjsonb paramの内部の
// 離散フィールドであり、直接のPostgreSQL int parameterではない）。
const PG_INT4_MAX = 2_147_483_647;

function isNonNegativePgInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= PG_INT4_MAX;
}

// notification.minutesBefore/unlockCondition.countはp_notification/p_unlock_conditionという
// jsonb paramの内部の離散値であり、PG int4列に直接castされるわけではない。JSON round-trip
// exactness・client側比較のexactness・minutes/countという意味論のため、PG int4上限を
// 無根拠に課さずNumber.isSafeIntegerで正確性境界のみを閉じる。
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidNotificationSetting(value: unknown): value is NotificationSetting {
  return isPlainObject(value) && isBoolean(value.enabled) && isNonNegativeSafeInteger(value.minutesBefore);
}

function isValidRepeatSetting(value: unknown): value is RepeatSetting {
  return isPlainObject(value) && isOneOf(value.type, REPEAT_TYPES);
}

function isValidUnlockConditionOrNull(value: unknown): value is UnlockCondition | null {
  if (value === null) return true;
  if (!isPlainObject(value)) return false;
  if (!isOneOf(value.type, UNLOCK_CONDITION_TYPES)) return false;
  if (value.count !== undefined && !isNonNegativeSafeInteger(value.count)) return false;
  return true;
}

function isValidRestrictedAppsOrNull(value: unknown): value is string[] | null {
  return value === null || isStringArray(value);
}

/**
 * P0037（4節・5節）: RPC（0019）へ実際に送るevent patchのruntime authority。
 * `unknown`型フィールド（restrictedApps/unlockCondition/notification/repeat）を廃止し、
 * `@/types/event`のwire型と一致する構造検証まで行う——corrupt/malformedなtargetEventを
 * remoteへ一切送らない（3節: corrupt/malformed durable targetEventはremote実行しない）。
 */
/**
 * P0043（10節）: zero-plan reconciliationのfresh remote event snapshot parsing
 * （remoteAttachmentRepository.ts）が、このdurable targetEvent validatorと
 * 全く同じ意味論で検証できるよう公開する。malformed/型不一致のraw fieldは
 * ここでthrowし、呼び出し元のfail-closed処理（ambiguous扱い）に委ねる。
 *
 * P0044（3節）: restrictedApps専用のnull→[]canonicalization。0019のUPDATE文は
 * `restricted_apps = coalesce(p_restricted_apps, '[]'::jsonb)`、RPC wrapper
 * （remoteAttachmentRepository.ts invokeMoveSharedEventAndAttachmentsRpc）も
 * `p_restricted_apps: params.restrictedApps ?? []`と、DB/RPC側は常に
 * null入力を[]として扱う——このvalidatorをdurable plan保存時とfresh remote
 * snapshot parse時の両方で共有するcanonicalization authorityとすることで、
 * `restrictedApps=null`（caller入力・旧durable record）と`restrictedApps=[]`
 * （DB実態）を同一の[]へ正規化し、zero/nonzero exact comparatorがserver
 * semanticsと一致するようにする。restrictedApps以外のfieldへは、0019の
 * 実際のUPDATE文を確認した上で勝手なdefaultを追加しない
 * （他fieldはcoalesceされておらず、null入力はnullのままDBへ書かれるため）。
 */
export function validateTargetEventPatch(item: unknown): AttachmentMigrationTargetEventPatch {
  if (!isPlainObject(item)) throw new AttachmentMigrationValidationError("targetEvent is not an object");
  const {
    title,
    date,
    startTime,
    endTime,
    allDay,
    location,
    durationMinutes,
    restrictedApps,
    unlockCondition,
    notification,
    repeat,
    memo,
    completed,
    recurringGroupId,
    recurrenceIndex,
  } = item;
  if (!isString(title)) throw new AttachmentMigrationValidationError("targetEvent.title invalid");
  if (!isValidDateOnlyString(date)) throw new AttachmentMigrationValidationError("targetEvent.date invalid");
  if (!isValidTimeString(startTime)) {
    throw new AttachmentMigrationValidationError("targetEvent.startTime invalid");
  }
  if (endTime !== null && !isValidTimeString(endTime)) {
    throw new AttachmentMigrationValidationError("targetEvent.endTime invalid");
  }
  if (!isBoolean(allDay)) throw new AttachmentMigrationValidationError("targetEvent.allDay invalid");
  if (location !== null && !isString(location)) {
    throw new AttachmentMigrationValidationError("targetEvent.location invalid");
  }
  // P0038（2節）/P0039（3節）: 0019 RPCのp_duration_minutesはint4。1.5等のfractionalに加え、
  // int4上限（2147483647）を超える値もdurable planとして残さない（null許容）。
  if (durationMinutes !== null && !isNonNegativePgInt(durationMinutes)) {
    throw new AttachmentMigrationValidationError("targetEvent.durationMinutes invalid");
  }
  if (!isValidRestrictedAppsOrNull(restrictedApps)) {
    throw new AttachmentMigrationValidationError("targetEvent.restrictedApps invalid");
  }
  if (!isValidUnlockConditionOrNull(unlockCondition)) {
    throw new AttachmentMigrationValidationError("targetEvent.unlockCondition invalid");
  }
  if (!isValidNotificationSetting(notification)) {
    throw new AttachmentMigrationValidationError("targetEvent.notification invalid");
  }
  if (!isValidRepeatSetting(repeat)) {
    throw new AttachmentMigrationValidationError("targetEvent.repeat invalid");
  }
  if (memo !== null && !isString(memo)) {
    throw new AttachmentMigrationValidationError("targetEvent.memo invalid");
  }
  if (!isBoolean(completed)) throw new AttachmentMigrationValidationError("targetEvent.completed invalid");
  if (recurringGroupId !== null && !isString(recurringGroupId)) {
    throw new AttachmentMigrationValidationError("targetEvent.recurringGroupId invalid");
  }
  // P0038（3節）/P0039（3節）: 0019 RPCのp_recurrence_indexはint4。null許容、非null時は
  // int4上限（2147483647）までの非負整数必須。
  if (recurrenceIndex !== null && !isNonNegativePgInt(recurrenceIndex)) {
    throw new AttachmentMigrationValidationError("targetEvent.recurrenceIndex invalid");
  }
  return {
    title,
    date,
    startTime,
    endTime: endTime as string | null,
    allDay,
    location: location as string | null,
    durationMinutes: durationMinutes as number | null,
    restrictedApps: (restrictedApps as string[] | null) ?? [], // P0044（3節）: DB/RPCのcoalesce(...,'[]')と一致させるcanonicalization
    unlockCondition: unlockCondition as UnlockCondition | null,
    notification: notification as NotificationSetting,
    repeat: repeat as RepeatSetting,
    memo: memo as string | null,
    completed,
    recurringGroupId: recurringGroupId as string | null,
    recurrenceIndex: recurrenceIndex as number | null,
  };
}

/**
 * 1件の生レコードを検証済みPendingAttachmentMigrationへ変換する。不正な場合はnullを返す
 * （strict版リーダーはnullが1件でもあれば例外を投げ、空配列へfallbackしない）。
 */
/**
 * committedUpdatedAtが非nullであることを要求するphase（5節: 不変条件）。
 * P0044（2節）: source-cleanup-pending-conflictもmigration自体のcommitが
 * 確定した状態であるため、同じ不変条件を課す（fresh eventUpdatedAtを保持する）。
 */
const PHASES_REQUIRING_COMMITTED_UPDATED_AT: readonly AttachmentMigrationPhase[] = [
  "committed",
  "source-cleanup-pending",
  "source-cleanup-pending-conflict",
];

function parseMigrationEntry(item: unknown): PendingAttachmentMigration | null {
  if (!isPlainObject(item)) return null;
  const {
    operationId,
    ownerUserId,
    eventId,
    sourceCalendarId,
    targetCalendarId,
    expectedUpdatedAt,
    committedUpdatedAt,
    targetEvent,
    attachments,
    phase,
  } = item;

  // P0037（8節）: operationIdは既存persisted formatとの互換のためnon-emptyのみ要求する
  // （UUID化はservice側がCrypto.randomUUID()で常に生成するが、repository契約としては必須にしない）。
  if (!isString(operationId) || operationId.length === 0) return null;
  if (!isString(ownerUserId) || ownerUserId.length === 0) return null;
  // eventIdは`events.id`（text列）——UUID castせず、path-safe（`/`を含まない）ことだけ要求する。
  if (!isPathSafeEventId(eventId)) return null;
  if (!isValidUuidString(sourceCalendarId)) return null;
  if (!isValidUuidString(targetCalendarId)) return null;
  if (sourceCalendarId === targetCalendarId) return null;
  if (!isValidIsoDateTimeString(expectedUpdatedAt)) return null;
  if (!isOneOf(phase, ATTACHMENT_MIGRATION_PHASES)) return null;
  if (!Array.isArray(attachments)) return null;

  const requiresCommittedUpdatedAt = PHASES_REQUIRING_COMMITTED_UPDATED_AT.includes(phase);
  if (requiresCommittedUpdatedAt) {
    if (!isValidIsoDateTimeString(committedUpdatedAt)) return null;
  } else if (committedUpdatedAt !== null) {
    return null;
  }

  try {
    const parsedTargetEvent = validateTargetEventPatch(targetEvent);
    const parsedAttachments = attachments.map((a) =>
      validateAttachmentEntry(a, sourceCalendarId, targetCalendarId, eventId)
    );
    const sourceIds = new Set<string>();
    const destinationIds = new Set<string>();
    for (const a of parsedAttachments) {
      if (sourceIds.has(a.sourceAttachmentId)) return null; // duplicate source ID reject
      if (destinationIds.has(a.destinationAttachmentId)) return null; // duplicate destination ID reject
      sourceIds.add(a.sourceAttachmentId);
      destinationIds.add(a.destinationAttachmentId);
    }
    // P0037（7節）: source ID集合とdestination ID集合は完全disjointであること
    // （intersection(sourceIds, destinationIds) = empty）。
    for (const destinationId of destinationIds) {
      if (sourceIds.has(destinationId)) return null;
    }
    return {
      operationId,
      ownerUserId,
      eventId,
      sourceCalendarId,
      targetCalendarId,
      expectedUpdatedAt,
      committedUpdatedAt: requiresCommittedUpdatedAt ? (committedUpdatedAt as string) : null,
      targetEvent: parsedTargetEvent,
      attachments: parsedAttachments,
      phase,
    };
  } catch {
    return null;
  }
}

/**
 * AsyncStorage読込み・JSON解析・配列形状・各要素の形状のいずれかが不正な場合は例外を投げ、
 * 空配列へfallbackしない（read-modify-writeの「読込み障害＝0件」誤認を防ぐため。
 * `attachmentCleanupRepository.ts`のreadTargetsStrictと同じ設計）。値が全く保存されていない
 * 場合（初回起動等、正当な「pending無し」状態）のみ空配列を返す。
 */
async function readMigrationsStrict(): Promise<PendingAttachmentMigration[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.attachmentMigration);
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AttachmentMigrationCorruptStateError("JSON parse failed");
  }
  if (!Array.isArray(parsed)) {
    throw new AttachmentMigrationCorruptStateError("top-level value is not an array");
  }
  const migrations: PendingAttachmentMigration[] = [];
  for (const item of parsed) {
    const migration = parseMigrationEntry(item);
    if (!migration) {
      throw new AttachmentMigrationCorruptStateError("malformed migration entry");
    }
    migrations.push(migration);
  }
  return migrations;
}

/** 他の変更操作とは独立した、この一覧専用の直列化チェーン（read-modify-writeの競合防止）。 */
let attachmentMigrationChain: Promise<void> = Promise.resolve();

function enqueueAttachmentMigrationOp<T>(op: () => Promise<T>): Promise<T> {
  const run = attachmentMigrationChain.then(op);
  attachmentMigrationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * 読込み専用。読込み自体が失敗した場合（AsyncStorage障害・JSON破損・不正要素混入）は
 * 例外を投げる（呼び出し元は「0件」と誤認しないこと）。
 */
export function getPendingAttachmentMigrations(): Promise<PendingAttachmentMigration[]> {
  return enqueueAttachmentMigrationOp(() => readMigrationsStrict());
}

/** 指定したownerUserIdに属するmigrationだけを返す（B userがA recordを読まない）。 */
export async function getPendingAttachmentMigrationsForOwner(
  ownerUserId: string
): Promise<PendingAttachmentMigration[]> {
  const all = await getPendingAttachmentMigrations();
  return all.filter((m) => m.ownerUserId === ownerUserId);
}

/** 指定したownerUserId+eventIdの未完了migrationを1件返す（無ければnull）。 */
export async function getPendingAttachmentMigrationForEvent(
  ownerUserId: string,
  eventId: string
): Promise<PendingAttachmentMigration | null> {
  const forOwner = await getPendingAttachmentMigrationsForOwner(ownerUserId);
  return forOwner.find((m) => m.eventId === eventId) ?? null;
}

/**
 * P0037（2節）: `startAttachmentMigration`呼出し元が、repositoryのqueue/read待ちを
 * またいだ後・実際のAsyncStorage書込み直前に同期的に実行させたい最終チェックの狭い
 * callback契約。repository自身はauth storeへ一切依存しない（current authを自分で
 * 読まない）——呼び出し元（service層）がidentity判定ロジックを注入する。
 */
export interface StartAttachmentMigrationOptions {
  beforeWrite?: () => void;
}

/**
 * 新しいmigration planを開始する（副作用（Storage/RPC）を一切開始する前に呼ぶこと、6節）。
 * 4節（same event uniqueness）: 同一ownerUserId+eventIdに既存の未完了migrationがある場合、
 * `AttachmentMigrationAlreadyPendingError`を投げて拒否する（A→B pending中のB→C要求も
 * この仕組みで自然にrejectされる——古いrecordを新しいrecordで上書きしない）。
 * planの形状自体が不正な場合は`AttachmentMigrationValidationError`を投げる。
 *
 * P0037（2節）: `options.beforeWrite`は、uniqueness確認まで完了した直後・
 * `writeJSON(...)`呼出しの直前に同期呼び出しする（両呼出しの間にawaitを挟まない）。
 * `beforeWrite`がthrowした場合、write は0件のまま例外を呼び出し元へ伝播する
 * （既存recordも一切変更しない）。
 */
export function startAttachmentMigration(
  plan: PendingAttachmentMigration,
  options?: StartAttachmentMigrationOptions
): Promise<void> {
  return enqueueAttachmentMigrationOp(async () => {
    const validated = parseMigrationEntry(plan);
    if (!validated) {
      throw new AttachmentMigrationValidationError("plan failed shape validation");
    }
    const current = await readMigrationsStrict();
    const existing = current.find((m) => m.ownerUserId === plan.ownerUserId && m.eventId === plan.eventId);
    if (existing) {
      throw new AttachmentMigrationAlreadyPendingError(existing);
    }
    if (current.some((m) => m.operationId === plan.operationId)) {
      throw new AttachmentMigrationValidationError("operationId already in use");
    }
    options?.beforeWrite?.();
    await writeJSON(STORAGE_KEYS.attachmentMigration, [...current, validated]);
  });
}

/**
 * 既存recordを更新する（phase遷移・destinationStaged/sourceCleanedフラグ更新等）。
 * `updater`はレコードのdeep copyを受け取り、更新後の値を返す（不変条件は呼び出し元が維持する。
 * このrepository自体もparseMigrationEntryで再検証してから書き込む——fail-closed）。
 * 該当operationIdが存在しない場合は何もしない（既にclear済み等、二重更新を防ぐ）。
 */
export function updatePendingAttachmentMigration(
  operationId: string,
  updater: (current: PendingAttachmentMigration) => PendingAttachmentMigration
): Promise<void> {
  return enqueueAttachmentMigrationOp(async () => {
    const current = await readMigrationsStrict();
    const idx = current.findIndex((m) => m.operationId === operationId);
    if (idx === -1) return;
    const updated = updater(current[idx]);
    if (updated.operationId !== operationId) {
      throw new AttachmentMigrationValidationError("updater must not change operationId");
    }
    const validated = parseMigrationEntry(updated);
    if (!validated) {
      throw new AttachmentMigrationValidationError("updated record failed shape validation");
    }
    const next = [...current];
    next[idx] = validated;
    await writeJSON(STORAGE_KEYS.attachmentMigration, next);
  });
}

/**
 * operationを完了として一覧から除去する（17節: record clearは最後）。
 * clear失敗（write例外）はそのまま呼び出し元へ伝播する——「record無し」と扱わないこと
 * （呼び出し元はoperationを完了扱いにする前に、この呼出しが成功したことを確認すること）。
 */
export function clearPendingAttachmentMigration(operationId: string): Promise<void> {
  return enqueueAttachmentMigrationOp(async () => {
    const current = await readMigrationsStrict();
    const next = current.filter((m) => m.operationId !== operationId);
    if (next.length === current.length) return;
    await writeJSON(STORAGE_KEYS.attachmentMigration, next);
  });
}

export { buildCanonicalAttachmentPath };
