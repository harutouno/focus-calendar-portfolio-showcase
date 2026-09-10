import { EventAttachment, ProcessedImage } from "@/types/attachment";
import {
  CloudAttachmentRemoveContext,
  CloudAttachmentSaveContext,
  CloudEventAttachmentRepository,
} from "./attachmentRepository";
import {
  deleteAttachmentStorageObject,
  fetchAttachmentsForEvent,
  getAttachmentDeleteVerificationRow,
  getAttachmentSignedUrl,
  getAttachmentStoragePath,
  hardDeleteAttachmentRow,
  insertAttachmentRow,
  softDeleteAttachment,
  uploadAttachmentBytes,
} from "./remoteAttachmentRepository";
import {
  SharedOperationIdentity,
  assertCurrentSharedMutationIdentity,
  isCurrentSharedMutationIdentity,
} from "@/auth/sharedMutationIdentity";
import {
  PendingAttachmentCleanupTarget,
  addPendingAttachmentCleanup,
  getPendingAttachmentCleanupsForOwner,
  removePendingAttachmentCleanup,
} from "@/storage/attachmentCleanupRepository";
import { getCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";

/**
 * 共有（クラウド）予定の添付画像。非公開event-attachmentsバケットへのアップロードと
 * event_attachmentsテーブルへの登録を「アップロード成功後に1回だけ」の順で行う
 * （"uploading"/"failed"状態の行は一切DBへ書き込まない。フェーズ2の設計判断）。
 * 枚数・容量・権限の最終判定は常にDB側（RLS・enforce_attachment_quotaトリガー）が行う。
 *
 * Round 13（SEC-F007-004本修正/SEC-F007-001残存、P1-2）: create()/remove()いずれも、
 * 実際にStorage/DBへ副作用を及ぼす操作を開始する「前」に、必ずその意図（intent）を
 * 永続化する。stale化を検知した時点では、その瞬間アクティブなSupabaseセッションが
 * 誰のものか信頼できない（既に別ユーザーへ切り替わっている可能性がある）ため、
 * その場でStorageを直接操作することは一切しない——Round12にあった、identityを
 * 経由せず直接`supabase.storage`を呼ぶ「補償削除」は廃止した。stale検知時は
 * 既に永続化済みのintentだけを頼りに例外を投げて即座に中断し、後から同じ
 * ownerUserIdで再ログインしたセッション（`retryPendingAttachmentCleanups()`、
 * sessionInstanceIdは問わない）が、DBの現在の実態と照合してから初めて
 * Storage操作を行う。
 */

function buildStoragePath(calendarId: string, eventId: string, attachmentId: string): string {
  return `${calendarId}/${eventId}/${attachmentId}/original.jpg`;
}

/** pending intentの永続化自体（AsyncStorage書込み）が失敗した場合。副作用を一切開始できない。 */
export class CloudAttachmentCleanupTrackingFailedError extends Error {
  readonly code = "cloud-attachment-cleanup-tracking-failed";
  constructor() {
    super("failed to persist cloud attachment cleanup intent before starting the operation");
    this.name = "CloudAttachmentCleanupTrackingFailedError";
  }
}

/** create(): Storageアップロード後・DB登録前にstale化した場合。intentは既に永続化済みで、再試行に委ねる。 */
export class CloudAttachmentStaleBeforeCommitError extends Error {
  readonly code = "cloud-attachment-stale-before-commit";
  constructor() {
    super("cloud attachment upload became stale before DB commit; cleanup was queued for retry");
    this.name = "CloudAttachmentStaleBeforeCommitError";
  }
}

/**
 * create(): DB登録の呼び出し中、または呼び出し直後にstale化した場合。
 * DB書込みが実際に成功したかどうかは呼び出し元からは判別できない場合がある
 * （`insertAttachmentRow`自身の呼び出し中にstale化した場合は不明、呼び出しが正常に戻った
 * 直後にstale化した場合は`attachment`に実際に作成された添付を保持する＝DBには確実に存在する）。
 * いずれの場合もDB行・Storageオブジェクトへは一切触れない（正当な書込みかもしれないものを
 * 誤って削除しないため）。行が実際に作られていた場合は、次にAが取得すれば見える。
 * 永続化済みのcreate-intentは、再試行時にDB行の存在確認によって安全に解決される。
 */
export class CloudAttachmentStaleAfterCommitError extends Error {
  readonly code = "cloud-attachment-stale-after-commit";
  constructor(public readonly attachment?: EventAttachment) {
    super("cloud attachment DB commit outcome is unknown or unreflected due to stale identity");
    this.name = "CloudAttachmentStaleAfterCommitError";
  }
}

/**
 * remove(): soft delete以降のいずれかの段階でstale化した場合。soft delete自体は既に
 * 成功している可能性が高く（一覧からは既に除外されている）、Storageオブジェクト削除・
 * DB物理削除までは完了できていない。永続化済みのdelete-intentが、次回以降の再試行に
 * 委ねられる。
 */
export class CloudAttachmentRemoveStaleError extends Error {
  readonly code = "cloud-attachment-remove-stale";
  constructor() {
    super("cloud attachment delete became stale; remaining cleanup was queued for retry");
    this.name = "CloudAttachmentRemoveStaleError";
  }
}

/**
 * Round14（P1-2）: remove()のStorageオブジェクト削除がstale化ではなく通常失敗（false/reject→false）
 * した場合。以前は例外を投げず`return`していたため呼び出し元（Hook）が成功と区別できなかった。
 * intentは既に永続化済みのまま残し、この型付きエラーで「まだ完了していない」ことを明示する。
 * 呼び出し元（useEventAttachments.tsのremoveAttachment）はこれを成功として扱ってはならない。
 */
export class CloudAttachmentCleanupPendingError extends Error {
  readonly code = "cloud-attachment-cleanup-pending";
  constructor() {
    super("cloud attachment storage deletion did not complete; cleanup intent was preserved for retry");
    this.name = "CloudAttachmentCleanupPendingError";
  }
}

/**
 * Round14（P1-2）: DBから取得したstoragePathが想定形式
 * （`{calendarId}/{eventId}/{attachmentId}/original.jpg`）と一致しない場合。以前は
 * `performRemoveWithoutIntent`でintentを永続化できないままベストエフォートの削除を
 * 試みていたが、追跡できない副作用を開始すること自体が安全でないため、削除処理を
 * 一切開始せずこの例外で拒否する（fail-closed）。
 */
export class UnsafeAttachmentStoragePathError extends Error {
  readonly code = "unsafe-attachment-storage-path";
  constructor() {
    super("attachment storage path has an unexpected format; refusing to start any cleanup side effect");
    this.name = "UnsafeAttachmentStoragePathError";
  }
}

/** intent除去の失敗（AsyncStorage書込み失敗等）を無音で握りつぶさず、開発時に検知できるようにする。 */
function logIntentRemovalFailure(context: string, e: unknown): void {
  if (__DEV__) {
    console.warn(`[cloudAttachmentRepository] intentの除去に失敗しました（${context}）`, e);
  }
}

/**
 * P0024（QA-F007 Batch3.4、1節・2節）: 同一`ownerUserId + attachmentId`のremote mutation
 * （live create/remove、retry create-intent/delete-intent/legacy-delete-unresolved）を
 * 相互排他にするmodule-level per-target coordinator。React instance（Hookインスタンス・
 * コンポーネントmount）には一切依存しない——pending intentは「live operation進行中」と
 * 「中断され回復待ちのoperation」の両方で存在しうるため、「pending intentが存在する＝
 * 今すぐretryして安全」ではない。同じattachmentIdへのremote呼び出しを、liveのcreate/remove
 * とretryの間で並走させないことがこのcoordinatorの唯一の役割。
 *
 * calendarId/eventId/storagePathはkeyへ含めない（scope改変・別pathとの衝突検知は、
 * 各operation内部の既存exact-path検証にそのまま委ねる）。同じattachmentIdに対する
 * scope不一致のoperation同士も、このkeyだけで自然に同じ排他へ入る。
 *
 * 実装は`attachmentCleanupRepository.ts`の`enqueuePendingAttachmentCleanupOp`と同じ
 * 「チェーンとして保持する値は常にresolveする（実際の結果はrunの方で伝える）」設計を、
 * keyごとに独立させたもの。これにより、あるoperationが失敗（reject）しても、chainに
 * 保持される値自体は常にresolveするため、後続のoperationが同じkeyで確実に実行される
 * （chain failure後もlockが永久に塞がらない）。settled後は、他のoperationが割り込んで
 * いなければMapからkeyを除去する（無制限にMapが育たないようにする）。
 */
const attachmentTargetChains = new Map<string, Promise<void>>();

function attachmentTargetKey(ownerUserId: string, attachmentId: string): string {
  return `${ownerUserId}::${attachmentId}`;
}

function runSerializedAttachmentTarget<T>(
  ownerUserId: string,
  attachmentId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = attachmentTargetKey(ownerUserId, attachmentId);
  const previousChain = attachmentTargetChains.get(key) ?? Promise.resolve();
  const run = previousChain.then(operation);
  const nextChain = run.then(
    () => undefined,
    () => undefined
  );
  attachmentTargetChains.set(key, nextChain);
  nextChain.then(() => {
    // 自分がsettleした時点でもMap上のchainがまだ自分自身のままなら（＝自分の後に
    // 誰も並ばなかったなら）、keyを除去する。誰かが既に後続を並べていれば、その
    // nextChainがMapの現在値になっているため、ここでは何もしない。
    if (attachmentTargetChains.get(key) === nextChain) {
      attachmentTargetChains.delete(key);
    }
  });
  return run;
}

/**
 * テスト専用: per-target coordinatorのMapをリセットする。進行中のoperationのPromise
 * chain自体はこの関数と無関係に独立して解決へ向かうため、呼び出しても壊れない
 * （Mapのエントリを消すだけで、以後の新規呼び出しが古いchainを待たなくなるだけ）。
 */
export function __resetAttachmentTargetCoordinatorForTests(): void {
  attachmentTargetChains.clear();
}

/**
 * P0034（QA-F007 C14、client migration core、5節）: C14 migrationのremote mutation
 * （destination staging・source Storage cleanup）を、既存のlive create/remove/retryと
 * 同じper-target coordinatorへ通すための、狭いmigration専用export。generic coordinator
 * （runSerializedAttachmentTarget自体）は外部へ公開しない——呼び出し元が任意のkeyで
 * 呼べてしまうと、5節の禁止事項（「calendar/pathだけをkeyにする」「sessionInstanceIdを
 * keyへ入れる」等の誤用）を防げないため、目的別に固定したkey構成（ownerUserId+
 * destinationAttachmentId / ownerUserId+sourceAttachmentId）だけを露出する。
 */
export function runSerializedMigrationDestinationStage<T>(
  ownerUserId: string,
  destinationAttachmentId: string,
  operation: () => Promise<T>
): Promise<T> {
  return runSerializedAttachmentTarget(ownerUserId, destinationAttachmentId, operation);
}

export function runSerializedMigrationSourceCleanup<T>(
  ownerUserId: string,
  sourceAttachmentId: string,
  operation: () => Promise<T>
): Promise<T> {
  return runSerializedAttachmentTarget(ownerUserId, sourceAttachmentId, operation);
}

async function persistCreateIntent(
  identity: SharedOperationIdentity,
  calendarId: string,
  eventId: string,
  attachmentId: string,
  storagePath: string
): Promise<PendingAttachmentCleanupTarget> {
  const intent: PendingAttachmentCleanupTarget = {
    kind: "create-intent",
    ownerUserId: identity.userId,
    calendarId,
    eventId,
    attachmentId,
    storagePath,
  };
  try {
    await addPendingAttachmentCleanup(intent);
  } catch {
    throw new CloudAttachmentCleanupTrackingFailedError();
  }
  return intent;
}

/**
 * P0023（QA-F007 Batch3.3、2節）: edit-modeでcloud draft（即時create中の下書き）を
 * ユーザーが削除しようとした時点で、まだcreateの成否が確定していない場合に使う
 * local-only intentの記録専用helper。remote side effect（Storage/DB/Supabase）へは
 * 一切触れず、`addPendingAttachmentCleanup()`によるAsyncStorageへのdelete-intent
 * 永続化だけを行う。expected pathは既存のbuildStoragePathで再構築し、callerから
 * 任意のpathを受け取らない。remote identityがstaleでも、このhelper自体は
 * 「既に確定している旧ownerのcleanup意思を端末に記録するだけ」のためSupabase
 * identity gateを要求しない（呼び出し元が削除操作開始時にscope currentを確認する）。
 * kind/ownerUserId/calendarId/eventId/attachmentIdが同じ既存intentがあれば
 * `addPendingAttachmentCleanup`の既存idempotency契約（全フィールド一致なら成功、
 * 不一致なら衝突エラー）にそのまま従う。
 */
export async function queueCloudAttachmentDeleteIntent(context: {
  attachmentId: string;
  eventId: string;
  calendarId: string;
  ownerUserId: string;
}): Promise<void> {
  const { attachmentId, eventId, calendarId, ownerUserId } = context;
  const intent: PendingAttachmentCleanupTarget = {
    kind: "delete-intent",
    ownerUserId,
    calendarId,
    eventId,
    attachmentId,
    storagePath: buildStoragePath(calendarId, eventId, attachmentId),
  };
  try {
    await addPendingAttachmentCleanup(intent);
  } catch {
    throw new CloudAttachmentCleanupTrackingFailedError();
  }
}

export const cloudAttachmentRepository: CloudEventAttachmentRepository = {
  async list(eventId: string, identity: SharedOperationIdentity): Promise<EventAttachment[]> {
    return fetchAttachmentsForEvent(eventId, identity);
  },

  /**
   * Round13、P1-2: Storageアップロードを開始する前にcreate-intentを永続化する
   * （永続化自体が失敗した場合はアップロードを開始しない）。以後、stale化を検知した
   * いずれの段階でもStorage/DBへ直接触れず、intentを頼りに例外を投げるだけに留める。
   * identityが現在も有効なまま起きた「通常の失敗」（DB容量超過・権限不足・通信断等）は、
   * 引き続きこの場で即座に補償する（identityが確定して有効なため安全）。
   *
   * P0024（QA-F007 Batch3.4、3節）: remote lifecycle全体（identity precheckから
   * create-intent clearまで）を、同じ`ownerUserId+attachmentId`のper-target
   * coordinatorへ通す。これにより、このcreateが完了するまで同じtargetのretry
   * （retryCreateIntent等）がremote APIを呼べない。
   */
  create(processed: ProcessedImage, context: CloudAttachmentSaveContext): Promise<EventAttachment> {
    return runSerializedAttachmentTarget(context.identity.userId, context.id, () =>
      performCreate(processed, context)
    );
  },

  /**
   * 二段階削除：①即座に一覧から見えなくする（soft delete）②Storageオブジェクトを削除
   * ③Storage削除が成功した場合のみ行を物理削除する。
   *
   * P0022（QA-F007 Batch3.2、1節）: delete-intentの永続化を、DB verification（DBから
   * 現在のeventId/storagePathを取得・検証する呼出し）より前に移した。以前はverification
   * より後にintentを永続化していたため、verificationのネットワーク呼出し自体が失敗
   * （応答消失・タイムアウト等）した場合、intentが一切残らないままこの呼出しが失敗して
   * 終わるという穴があった。intentの永続化自体は破壊的なremote副作用ではないため、
   * DB verificationより前に安全に保存できる。永続化したintentのstoragePathは、
   * DBから取得する実際の値ではなくcontext（calendarId/eventId/attachmentId）から
   * 再構築した期待値（buildStoragePath）を使う——破壊的操作へ進む条件（exact-path一致）は
   * 従来以上に厳格なまま維持し、verification結果がこの期待値と一致した場合にのみ
   * 以降のsoft delete以降へ進む（不一致・stale化・クエリ失敗のいずれでも破壊的副作用は
   * 一切開始しない）。
   *
   * P0024（QA-F007 Batch3.4、4節）: remote lifecycle全体（delete-intentからintent
   * clearまで）を、createと同じper-target coordinatorへ通す。P0022のdelete-intent-
   * before-verificationとexact-path契約はremove内部でそのまま維持する。
   */
  remove(context: CloudAttachmentRemoveContext): Promise<void> {
    return runSerializedAttachmentTarget(context.identity.userId, context.attachmentId, () =>
      performRemove(context)
    );
  },

  async resolveDisplayUri(
    attachment: EventAttachment,
    identity: SharedOperationIdentity
  ): Promise<string | null> {
    const storagePath = await getAttachmentStoragePath(attachment.id, identity);
    if (!storagePath) return null;
    return getAttachmentSignedUrl(storagePath, identity);
  },
};

async function performCreate(
  processed: ProcessedImage,
  context: CloudAttachmentSaveContext
): Promise<EventAttachment> {
  const { id, eventId, sortOrder, calendarId, identity } = context;

  assertCurrentSharedMutationIdentity(identity); // ①開始時

  const storagePath = buildStoragePath(calendarId, eventId, id);
  assertCurrentSharedMutationIdentity(identity); // ②アップロード開始前（副作用はまだ無い）

  // ③Storageアップロードを開始する前に、必ずintentを永続化する。
  const intent = await persistCreateIntent(identity, calendarId, eventId, id, storagePath);

  if (!isCurrentSharedMutationIdentity(identity)) {
    // intentは既に記録済み。この場でStorageには一切触れず、再試行に委ねる。
    throw new CloudAttachmentStaleBeforeCommitError();
  }

  try {
    await uploadAttachmentBytes(storagePath, processed.localUri, processed.mimeType, identity);
  } catch (e) {
    if (isCurrentSharedMutationIdentity(identity)) {
      // Round14（P1-2）: identityは現在も有効だが、通信エラーの場合バイトが実際に
      // Storageへ届いたかどうかは判別できない（応答が失われただけで、実際には
      // アップロードが完了している可能性がある）。「何も起きなかった」と決めつけて
      // intentを消さず、DB照合ベースの安全な再試行（retryCreateIntent。DB行が
      // 無ければStorage側を削除しにいく）へ委ねる。
      throw e;
    }
    // stale化: intentは既に記録済みのため、この場でStorageには一切触れない。
    throw new CloudAttachmentStaleBeforeCommitError();
  }

  if (!isCurrentSharedMutationIdentity(identity)) {
    throw new CloudAttachmentStaleBeforeCommitError();
  }

  let attachment: EventAttachment;
  try {
    attachment = await insertAttachmentRow(
      { id, eventId, storagePath, mimeType: processed.mimeType, byteSize: processed.byteSize, width: processed.width, height: processed.height, sortOrder },
      identity
    );
  } catch (e) {
    if (isCurrentSharedMutationIdentity(identity)) {
      // Round15（P1-1）: identityは現在も有効だが、この例外がPostgrest側の確定的な拒否
      // （RLS/枚数容量超過等）なのか、通信の応答が失われただけで実際にはDB挿入が成功して
      // いた可能性があるのかを、この場では区別できない。「DB行は作られていない」と
      // 断定してその場でStorageを直接削除することはせず（以前はここで即座に補償削除を
      // 試みていたが、応答消失時にDB行が実在するケースでStorageだけ消してしまう恐れが
      // あったため廃止した）、intentを保持したままDB照合ベースの安全な再試行
      // （retryCreateIntent。DB行が本当に存在しない場合だけStorageを削除する）へ委ねる。
      throw e; // 元のDBエラーを常にそのまま伝える
    }
    // stale化: DB書込みが実際に成功したかは不明。行にもStorageオブジェクトにも一切触れない。
    throw new CloudAttachmentStaleAfterCommitError();
  }

  if (!isCurrentSharedMutationIdentity(identity)) {
    // DB登録は確認済みで成功している。intentはそのまま残し、再試行が
    // 「DB行が存在する＝Storageは削除せずintentだけ除去」で安全に解決する。
    throw new CloudAttachmentStaleAfterCommitError(attachment);
  }

  // 成功: identityが現在も有効なままDB登録まで完了したため、intentを除去する。
  await removePendingAttachmentCleanup(intent).catch((e) => logIntentRemovalFailure("create: 成功後", e));
  return attachment;
}

/**
 * P0024（QA-F007 Batch3.4、4節）: createと同じper-target coordinatorの中で呼ばれる、
 * remove()のremote lifecycle本体。P0022のdelete-intent-before-verificationと
 * exact-path契約はそのまま維持する。
 */
async function performRemove(context: CloudAttachmentRemoveContext): Promise<void> {
  const { attachmentId, eventId, calendarId, identity } = context;

  assertCurrentSharedMutationIdentity(identity); // 開始時

  const expectedStoragePath = buildStoragePath(calendarId, eventId, attachmentId);

  // ①DB verificationより前にdelete-intentを永続化する（永続化自体が失敗した場合は
  // 以降のいずれの副作用も一切開始しない）。
  const intent: PendingAttachmentCleanupTarget = {
    kind: "delete-intent",
    ownerUserId: identity.userId,
    calendarId,
    eventId,
    attachmentId,
    storagePath: expectedStoragePath,
  };
  try {
    await addPendingAttachmentCleanup(intent);
  } catch {
    throw new CloudAttachmentCleanupTrackingFailedError();
  }

  if (!isCurrentSharedMutationIdentity(identity)) {
    // intentは既に記録済みのため、この場でStorage/DBには一切触れず再試行に委ねる。
    throw new CloudAttachmentRemoveStaleError();
  }

  // ②DBから現在のeventId/storagePathを取得・検証する。
  // Round14（P1-1）: getAttachmentDeleteVerificationRowはクエリ自体が失敗した場合は例外を
  // 投げる（not-foundへ丸め込まない）ため、ここで別途catchせずそのまま伝播させる
  // （＝intentは既に永続化済みのまま、以降のいずれの副作用も一切開始せず再試行へ委ねる）。
  const verification = await getAttachmentDeleteVerificationRow(attachmentId, calendarId, identity);

  // [P0166 §1] 「見えない」と「無い」を分ける。unconfirmed のときは intent を残し、
  // primary success も報告しない（RLS 不可視を完了と読まない）。
  if (verification.kind === "unconfirmed") {
    throw new CloudAttachmentCleanupPendingError();
  }

  if (verification.kind === "authoritatively-absent") {
    // メンバーであることを確認したうえでの不在＝既に完了済み。
    // 破壊的副作用は0のまま、intentを除去して通常成功扱いにする。
    // 除去自体が失敗してもintentが残るだけで安全（次回retryが再確認してclearする）。
    await removePendingAttachmentCleanup(intent).catch((e) =>
      logIntentRemovalFailure("remove: authoritatively-absent", e)
    );
    return;
  }

  if (!isCurrentSharedMutationIdentity(identity)) {
    throw new CloudAttachmentRemoveStaleError();
  }

  const verifyRow = verification;

  // Round15（P1-2）: DB行のeventIdがcontext.eventIdと一致すること、かつstoragePathが
  // context（calendarId/eventId/attachmentId）から再構築した完全なpathと一致することの
  // 両方を確認する。以前は正規表現でcalendarId/eventIdのprefixだけを抽出しattachmentId
  // 自体の一致を確認していなかったため、削除対象のattachmentIdとは別のattachmentIdを
  // 指すstoragePathが渡された場合でも通過しうる不備があった。1項目でも不一致なら
  // 追跡・副作用のいずれも一切開始せず拒否する（fail-closed）。
  if (verifyRow.eventId !== eventId || verifyRow.storagePath !== expectedStoragePath) {
    // P0022: 今回作ったintentは、改変・別添付との衝突の可能性がある実体を指しているため
    // このまま残すと将来の再試行で誤って調査対象化し続ける（実害は無いが紛らわしい）。
    // 可能ならclearする（失敗しても破壊的副作用は0のまま変わらない）。
    await removePendingAttachmentCleanup(intent).catch((e) => logIntentRemovalFailure("remove: mismatch", e));
    throw new UnsafeAttachmentStoragePathError();
  }

  try {
    // [P0164 §5] soft delete が**権威をもって適用された**か、既に soft delete 済みで
    // あることが証明できた場合にのみ Storage 削除へ進む。0 行のまま進むと
    // 「DB は未削除・実体だけ消滅」という破壊先行になる。role 変更は auth identity を
    // 変えないため、identity チェックだけではこの経路を止められない。
    const soft = await softDeleteAttachment(attachmentId, identity);
    if (soft.outcome !== "applied" && soft.outcome !== "already-absent") {
      // intent は残したまま（回復可能）。破壊的副作用は 0 のまま返す。
      throw new CloudAttachmentCleanupPendingError();
    }
  } catch (e) {
    if (isCurrentSharedMutationIdentity(identity)) {
      // Round15（P1-1）: この例外が確定的なDB拒否なのか、応答が失われただけで実際には
      // soft deleteが成功していたのかを区別できないため、「未実施」と断定してintentを
      // 除去しない（以前はここで即座にintentを除去していたが、応答消失時にsoft delete
      // だけがサーバー側で完了していたケースを追跡できなくなる恐れがあったため廃止した）。
      // intentを保持したままDB照合ベースの安全な再試行（retryDeleteIntent。
      // softDeleteAttachmentを冪等に再実行してからStorage削除へ進む）へ委ねる。
      throw e;
    }
    throw new CloudAttachmentRemoveStaleError();
  }

  if (!isCurrentSharedMutationIdentity(identity)) {
    throw new CloudAttachmentRemoveStaleError();
  }

  let removed: boolean;
  try {
    removed = await deleteAttachmentStorageObject(verifyRow.storagePath, identity);
  } catch {
    // deleteAttachmentStorageObjectがreject（＝例外）を投げるのは常にstale化のみ
    // （通信自体の失敗はfalseへ丸め込む設計）。
    throw new CloudAttachmentRemoveStaleError();
  }
  if (!removed) {
    // Round14（P1-2）: Storage削除が（stale化ではなく）通常失敗した場合。intentは
    // 既に記録済みのまま残す（孤立行として残るが再試行対象になる）。以前はここで
    // 単に`return`しており呼び出し元が成功と区別できなかったため、型付きエラーで
    // 「まだ完了していない」ことを明示する（呼び出し元はこれを成功として扱わないこと）。
    throw new CloudAttachmentCleanupPendingError();
  }

  if (!isCurrentSharedMutationIdentity(identity)) {
    throw new CloudAttachmentRemoveStaleError();
  }

  let hard: Awaited<ReturnType<typeof hardDeleteAttachmentRow>>;
  try {
    hard = await hardDeleteAttachmentRow(attachmentId, identity);
  } catch {
    if (!isCurrentSharedMutationIdentity(identity)) {
      throw new CloudAttachmentRemoveStaleError();
    }
    throw new Error("hard delete failed after storage object removal");
  }

  if (!isCurrentSharedMutationIdentity(identity)) {
    throw new CloudAttachmentRemoveStaleError();
  }

  // [P0164 §5 / CORRECT-CLOUDATTACH-001] **ここが最重要。**
  // Storage 実体は既に消えている。この段で 0 行（blocked）や確認不能（unconfirmed）を
  // 完了成功へ丸め込むと、DB 行は soft-deleted のまま残り、**回復用の intent も失われる**。
  // したがって applied 以外は intent を残したまま cleanup-pending として返す。
  if (hard.outcome !== "applied") {
    throw new CloudAttachmentCleanupPendingError();
  }

  // 全工程成功: identityが現在も有効なまま完了したため、intentを除去する。
  await removePendingAttachmentCleanup(intent).catch((e) => logIntentRemovalFailure("remove: 成功後", e));
}

/**
 * Round14（P1-1）: retryCreateIntentは、DB行が存在した場合eventId/storagePathの両方が
 * intentの記録内容と完全一致することを確認してから初めて「登録済み」と判断する。
 * 一方だけ一致・両方不一致のいずれの場合も、改変・別添付との衝突の可能性があるため
 * 一切何もしない（Storageにもintentにも触れない。調査対象として保持する）。
 */
async function retryCreateIntent(
  intent: Extract<PendingAttachmentCleanupTarget, { kind: "create-intent" }>,
  identity: SharedOperationIdentity
): Promise<void> {
  // getAttachmentDeleteVerificationRowがクエリ失敗時に投げる例外はここでcatchせず、
  // 呼び出し元（runRetryPendingAttachmentCleanups）のper-target try/catchへそのまま伝播させる
  // （＝Storage/intentのいずれにも一切触れない）。
  const verification = await getAttachmentDeleteVerificationRow(
    intent.attachmentId,
    intent.calendarId,
    identity
  );
  if (verification.kind === "found") {
    if (verification.eventId !== intent.eventId || verification.storagePath !== intent.storagePath) {
      return; // 不一致: 削除もintent除去も行わず、そのまま保持する。
    }
    // DB登録は実際には成功していた（intent除去だけが完了できなかった）。Storageには触れない。
    await removePendingAttachmentCleanup(intent);
    return;
  }

  // [P0166 §1] **ここは特に危険。** 旧 not-found は「DB行が無い＝孤児」と読んで
  // Storage オブジェクトを削除していた。RLS 不可視をそれと同一視すると、
  // **正常に登録済みの添付の実体を消してしまう**（＝可視性の喪失が破壊に化ける）。
  // 権威ある不在を確認できたときだけ孤児として削除する。
  if (verification.kind === "unconfirmed") {
    return; // intent を保持し、破壊的副作用は一切起こさない。
  }

  // authoritatively-absent: DB行が無いことをメンバーとして確認済み = Storageオブジェクトが孤立している。
  const removed = await deleteAttachmentStorageObject(intent.storagePath, identity);
  if (removed) await removePendingAttachmentCleanup(intent);
  // 削除できなかった場合はintentを残し、次回の再試行に委ねる。
}

async function retryDeleteIntent(
  intent: Extract<PendingAttachmentCleanupTarget, { kind: "delete-intent" }>,
  identity: SharedOperationIdentity
): Promise<void> {
  // Round14（P1-1）: クエリ失敗時の例外はここでcatchせず、呼び出し元のper-target
  // try/catchへそのまま伝播させる（＝intentには一切触れない。「行が無い」と誤認しない）。
  const verification = await getAttachmentDeleteVerificationRow(
    intent.attachmentId,
    intent.calendarId,
    identity
  );
  // [P0166 §1] 読取権限を確立できない場合は intent を保持し、破壊的副作用を一切行わない。
  // 「見えない」を「もう無い（＝完了）」と読んで intent を消すと、回復手段が失われる。
  if (verification.kind === "unconfirmed") return;
  if (verification.kind === "authoritatively-absent") {
    // P0023（QA-F007 Batch3.3、4節・5節）: DB行がまだ無くても、同じtarget
    // （ownerUserId/calendarId/eventId/attachmentId/storagePathの全一致）を指す
    // create-intentがpending中なら、そのcreateがこれから成功してDB行が現れる
    // 可能性がまだ残っている（createとdeleteのretryが競合し、deleteのretryが
    // createより先に走った場合）。この場合はdelete-intentをclearせず、destructive
    // side effectを一切起こさずに次回のretryへ委ねる。fresh strict readが失敗した
    // 場合も同様にfail-closedでclearしない（「create-intentは無い」と誤認しないため）。
    let pendingForOwner: PendingAttachmentCleanupTarget[];
    try {
      pendingForOwner = await getPendingAttachmentCleanupsForOwner(intent.ownerUserId);
    } catch {
      return;
    }
    const hasMatchingCreateIntent = pendingForOwner.some(
      (t) =>
        t.kind === "create-intent" &&
        t.calendarId === intent.calendarId &&
        t.eventId === intent.eventId &&
        t.attachmentId === intent.attachmentId &&
        t.storagePath === intent.storagePath
    );
    if (hasMatchingCreateIntent) return;

    // 行が既に無く、matching create-intentも無い＝hard deleteは前回の試行で完了済み
    // （intent除去だけが完了できなかった）、またはcreateが解消済み。
    await removePendingAttachmentCleanup(intent);
    return;
  }
  // 全フィールド完全一致を確認してから削除を進める（改変データによる誤削除を防ぐ）。
  if (verification.eventId !== intent.eventId || verification.storagePath !== intent.storagePath) {
    return; // 不一致: 削除を実行せず、intentもそのまま残す（調査対象として保持）。
  }
  // Round15（P1-1）: 元のremove()呼出し中のsoftDeleteAttachmentが通信エラーで結果不明
  // だった可能性がある（サーバー側では実際に成功していたかもしれない）ため、Storage削除
  // へ進む前にsoftDeleteAttachmentを冪等に再実行し、確実にsoft delete済みの状態にしてから
  // 次へ進む（`deleted_at`へのUPDATEは何度実行しても安全で、既にsoft delete済みの行に
  // 対しても同じ値で上書きするだけ）。
  // [P0164 §5] retry 経路でも同じ効果権威を要求する。soft delete が適用されて
  // いない（あるいは確認できない）まま Storage を消しに行かない。
  const soft = await softDeleteAttachment(intent.attachmentId, identity);
  if (soft.outcome !== "applied" && soft.outcome !== "already-absent") return;
  const removed = await deleteAttachmentStorageObject(intent.storagePath, identity);
  if (!removed) return;
  const hard = await hardDeleteAttachmentRow(intent.attachmentId, identity);
  // **DB の最終化が証明できるまで intent を消さない。** 消してしまうと、
  // 実体だけ消えて DB 行が残った状態を二度と自動回収できなくなる。
  if (hard.outcome !== "applied") return;
  await removePendingAttachmentCleanup(intent);
}

async function retryLegacyUnresolved(
  intent: Extract<PendingAttachmentCleanupTarget, { kind: "legacy-delete-unresolved" }>,
  identity: SharedOperationIdentity
): Promise<void> {
  // Round14（P1-1）: クエリ失敗時の例外はここでcatchせず、呼び出し元のper-target
  // try/catchへそのまま伝播させる（＝隔離状態を誤って解除しない）。
  // [P0166 §1] 旧 v1 の legacy-delete-unresolved は **calendarId を保持していない**ため、
  // 読取権限を確立する手段がそもそも無い。`getAttachmentDeleteVerificationRow` は
  // expectedCalendarId が無い場合に必ず `unconfirmed` を返すので、この経路の隔離は
  // 解除されないまま維持される。それが正しい fail-closed（隔離を解く根拠が無い）。
  // 以前は RLS 不可視の not-found を「もう無い」と読んで隔離を解いていた。
  const verification = await getAttachmentDeleteVerificationRow(intent.attachmentId, null, identity);
  if (verification.kind === "unconfirmed") return; // 隔離を維持する。
  if (verification.kind === "authoritatively-absent") {
    // 削除対象が既に無いことを権威をもって確認できた: これ以上追跡する意味が無いため隔離を解く。
    await removePendingAttachmentCleanup(intent);
    return;
  }
  // 行が現存する場合、旧v1データはstoragePathを持たないため安全に検証できる情報が
  // 無く、削除は実行しない（隔離を維持する）。
}

/**
 * notificationService.tsのretryPendingOwnerNotificationCleanupsと同じ設計
 * （アプリ初期化時・AppState「active」復帰時・identity変更確定直後の3箇所から呼ぶ想定）。
 * 現在ログイン中のownerUserIdに属する対象だけを、同じidentityを使って1件ずつ順番に再試行する
 * （未ログイン時は何もしない。他ユーザーの対象には一切触れない）。例外は外へ投げない。
 *
 * P0022（QA-F007 Batch3.2、5節）: useSyncQueueProcessor.tsのtriggerSyncQueueFlush/
 * syncQueueFlushRerunRequestedと同じ契約へ揃える。以前は単純な`retryInFlight`への
 * 合流だけだったため、A run実行中に届いたB（例: identity変更確定直後）のtriggerが
 * そのままA passへ合流して終わってしまい、B時点の最新状態（getCurrentAuthIdentity()の
 * 新しい値・その時点のpending一覧）が一度も反映されないまま消えることがあった。
 * `attachmentCleanupRetryRerunRequested`で「実行中に追加の要求が来たか」を記録し、
 * 現在のpassが完了した後、要求が残っていればロックを保持したまま続けてもう1pass
 * 実行する（要求は1個のbooleanへcoalesceされるため、実行中に何度triggerされても
 * 追加passは高々1回ずつ＝無制限に連鎖しない）。各pass（再passを含む）は
 * runRetryPendingAttachmentCleanups()自身の中で`getCurrentAuthIdentity()`を都度
 * fresh取得するため、再passは常にその時点の最新identityのpending一覧だけを対象にする。
 * `runRetryPendingAttachmentCleanups()`自体は内部で全ての例外を捕捉し例外を外へ投げない
 * ため、この関数もそれ以上のエラー伝播処理を持たない。
 */
let attachmentCleanupRetryRunPromise: Promise<void> | null = null;
let attachmentCleanupRetryRerunRequested = false;

export function retryPendingAttachmentCleanups(): Promise<void> {
  if (attachmentCleanupRetryRunPromise) {
    attachmentCleanupRetryRerunRequested = true;
    return attachmentCleanupRetryRunPromise;
  }
  attachmentCleanupRetryRunPromise = (async () => {
    try {
      await runRetryPendingAttachmentCleanups();
      while (attachmentCleanupRetryRerunRequested) {
        attachmentCleanupRetryRerunRequested = false;
        await runRetryPendingAttachmentCleanups();
      }
    } finally {
      attachmentCleanupRetryRerunRequested = false;
      attachmentCleanupRetryRunPromise = null;
    }
  })();
  return attachmentCleanupRetryRunPromise;
}

/**
 * テスト専用: モジュールスコープのretryコーディネーター状態をリセットする。
 * jestは1テストファイルにつき1回しかこのモジュールを読み込まないため、
 * attachmentCleanupRetryRunPromise/attachmentCleanupRetryRerunRequestedが
 * テストを跨いで残ってしまう。各テストのbeforeEachから呼ぶことを前提にする。
 */
export function __resetAttachmentCleanupRetryCoordinatorForTests(): void {
  attachmentCleanupRetryRunPromise = null;
  attachmentCleanupRetryRerunRequested = false;
}

/**
 * P0024（QA-F007 Batch3.4、5節）: `a`と`b`が同じpending targetを指すかを、kindごとの
 * 必須フィールドすべてで判定する。create-intent/delete-intentはcalendarId/eventId/
 * storagePathまで含めた完全一致、legacy-delete-unresolvedはkind+ownerUserId+
 * attachmentIdのみ（旧v1形式はこれ以上の情報を持たないため）。
 */
function hasStoragePathFields(
  t: PendingAttachmentCleanupTarget
): t is Extract<PendingAttachmentCleanupTarget, { kind: "create-intent" | "delete-intent" }> {
  return t.kind === "create-intent" || t.kind === "delete-intent";
}

function isSamePendingTarget(a: PendingAttachmentCleanupTarget, b: PendingAttachmentCleanupTarget): boolean {
  if (a.kind !== b.kind || a.ownerUserId !== b.ownerUserId || a.attachmentId !== b.attachmentId) {
    return false;
  }
  if (hasStoragePathFields(a) && hasStoragePathFields(b)) {
    return a.calendarId === b.calendarId && a.eventId === b.eventId && a.storagePath === b.storagePath;
  }
  return true;
}

/**
 * P0024（QA-F007 Batch3.4、5節・9節）: per-target coordinatorのlockを取得した後、
 * remote APIを1つでも呼ぶ前に、pending一覧をfresh strict readし、snapshot（retryが
 * このpassを開始した時点で読んだtarget）と全フィールド完全一致するtargetが今も
 * 存在するかを確認する。coordinator待機中にlive create/removeがtargetを解消したり、
 * 同じowner+attachmentIdで別のintentへ置き換わっている可能性があるため
 * （snapshotのattachmentIdだけが一致し、他のフィールドが変わっているケースを
 * 「同じtarget」と誤認しない）。fresh readクエリ自体が失敗した場合はfail-closedで
 * 「存在しない」扱いにする（remote副作用0のまま、targetには一切触れない）。
 */
async function isPendingTargetStillExact(snapshot: PendingAttachmentCleanupTarget): Promise<boolean> {
  let fresh: PendingAttachmentCleanupTarget[];
  try {
    fresh = await getPendingAttachmentCleanupsForOwner(snapshot.ownerUserId);
  } catch {
    return false;
  }
  return fresh.some((t) => isSamePendingTarget(t, snapshot));
}

async function runRetryPendingAttachmentCleanups(): Promise<void> {
  const current = getCurrentAuthIdentity();
  if (!current.userId || !current.sessionInstanceId) return;
  const identity: SharedOperationIdentity = {
    userId: current.userId,
    sessionInstanceId: current.sessionInstanceId,
  };

  let pending: PendingAttachmentCleanupTarget[];
  try {
    pending = await getPendingAttachmentCleanupsForOwner(identity.userId);
  } catch (e) {
    if (__DEV__) {
      console.warn("[cloudAttachmentRepository] 未完了クリーンアップ一覧の読込みに失敗しました", e);
    }
    return;
  }

  for (const target of pending) {
    try {
      // P0024（QA-F007 Batch3.4、5節）: 同じownerUserId+attachmentIdのlive create/remove
      // と並走しないよう、retryのremote処理もper-target coordinatorへ通す。lock取得後、
      // remote APIを呼ぶ前に必ずfresh exact recheckを行う。
      await runSerializedAttachmentTarget(target.ownerUserId, target.attachmentId, async () => {
        const stillExact = await isPendingTargetStillExact(target);
        if (!stillExact) return; // 消滅・置換済み: remote副作用0のままskip

        if (target.kind === "create-intent") {
          await retryCreateIntent(target, identity);
        } else if (target.kind === "delete-intent") {
          await retryDeleteIntent(target, identity);
        } else {
          await retryLegacyUnresolved(target, identity);
        }
      });
    } catch (e) {
      if (__DEV__) {
        console.warn("[cloudAttachmentRepository] クリーンアップの再試行に失敗しました", e);
      }
    }
  }
}
