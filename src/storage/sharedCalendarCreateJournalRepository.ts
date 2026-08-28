import { STORAGE_KEYS } from "./keys";
import { readJSONStrict, writeJSON } from "./storage";
import {
  isNonEmptyString,
  isPlainObject,
  isValidIsoDateTimeString,
  StoredDataValidationError,
} from "./shapeGuards";

/**
 * [P0134 QA-F021 / DATA-F021-001] 共有カレンダー作成の durable operation identity。
 *
 * 解決したい欠陥:
 *   INSERT commit -> 応答喪失 -> クライアントは失敗と認識 -> ユーザーが再作成
 *   -> 新しいUUIDで2件目が durable に生まれる（F021-IDEMP-1 で実証）
 *   -> 再起動を跨ぐと元 operation を特定する手段が端末に一切残らない（F021-IDEMP-2 で実証）
 *
 * 設計（P0134 Option A）:
 * - `calendars.id` をクライアントが決め、それを **安定した operation identity** として再利用する。
 *   新しい DB 列は増やさない。PK が「同じ id の再送は最大1件」を保証する。
 * - ただし **PK だけでは restart-safe ではない**。再起動でその id を忘れたら、
 *   リトライは新しい id を作ってしまう。よってこの durable journal が必須。
 * - 判定は必ず「id で SELECT し直す」。エラー種別で applied/not-applied を決めない
 *   （0016 の BEFORE INSERT limit トリガーは PK 一意性より**先**に発火し得るため、
 *    同一 id の再送が duplicate-key ではなく limit error になる場合がある）。
 *
 * 所有者境界（QA-F073 / QA-F008 の既存基盤に合わせる）:
 * - `ownerUserId` + `ownerSessionInstanceId` を必ず持つ。A が開始した pending を
 *   B が reconcile してはならない。
 * - 未知状態を success へ縮退させない。
 */
export interface PendingSharedCalendarCreate {
  /** クライアントが決めた calendars.id。これが operation identity そのもの。 */
  calendarId: string;
  ownerUserId: string;
  ownerSessionInstanceId: string;
  /**
   * reconcile 時の payload 照合対象。**作成時点で durable authority となる欄だけ**を持つ。
   * created_at / updated_at のように自動付与・後から変更され得る欄は
   * 含めない（含めると、正しく作成済みなのに偽の不一致で CONFLICT になる）。
   */
  name: string;
  color: string;
  createdAt: string;
}

function isValidPendingSharedCalendarCreate(
  value: unknown
): value is PendingSharedCalendarCreate {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.calendarId)) return false;
  if (!isNonEmptyString(value.ownerUserId)) return false;
  if (!isNonEmptyString(value.ownerSessionInstanceId)) return false;
  if (typeof value.name !== "string") return false;
  if (typeof value.color !== "string") return false;
  if (!isValidIsoDateTimeString(value.createdAt)) return false;
  return true;
}

/**
 * [P0136 ARCH/DATA-F021-003] 保存済み pending を、いま操作している identity が
 * どう扱ってよいかの **明示的な境界**。
 *
 * P0134 は `ownerSessionInstanceId` を保存していたが authority として使っておらず、
 * A/session1 の pending を A/session2 が「通常の mutation identity の一致」であるかのように
 * 暗黙に resume できていた（P0135 §4）。ここで3種類を明示的に分ける。
 *
 * - `same-session`  : 同一 userId かつ同一 sessionInstanceId。
 *                     **元 operation の継続**。応答喪失直後のリトライがこれに当たる。
 *                     APPLIED なら既存 calendar をそのまま返してよい（＝2件目を作らない）。
 * - `cross-session-recovery` : 同一 userId・別 sessionInstanceId（再起動・再ログイン後）。
 *                     **結果の再判定（recovery）だけを許す**。
 *                     ユーザーが後から出した新しい create 要求を、この pending の結果へ
 *                     すり替えてはならない（P0135 §5 の false-success の原因）。
 * - `foreign-owner` : userId 不一致。**問い合わせ自体を行わない**。
 *
 * どの分類でも、operation identity は保存済み `calendarId` であり、
 * 「後から現れた current-session token を元 operation identity として使う」ことは無い。
 */
export type SharedCalendarCreateAdoption =
  | "same-session"
  | "cross-session-recovery"
  | "foreign-owner";

export function classifySharedCalendarCreateAdoption(
  pending: Pick<PendingSharedCalendarCreate, "ownerUserId" | "ownerSessionInstanceId">,
  identity: { userId: string; sessionInstanceId: string }
): SharedCalendarCreateAdoption {
  if (pending.ownerUserId !== identity.userId) return "foreign-owner";
  if (pending.ownerSessionInstanceId !== identity.sessionInstanceId) {
    return "cross-session-recovery";
  }
  return "same-session";
}

/**
 * [P0137 §5 / ARCH-F021-003 再修正] **このプロセス（アプリ起動）で作られた pending か**。
 *
 * P0136 は「再起動 = 別 session」という前提で resume 境界を作っていたが、これは**誤り**だった。
 * `sessionInstanceId` は Supabase JWT の `session_id` claim
 * （`sharedMutationAuthSnapshot.ts` が access token から抽出）であり、
 * セッションが AsyncStorage に永続化されたままアプリを再起動しても **変わらない**。
 * つまり「再起動後の意図的な新規作成」も `same-session` に分類され、
 * P0135 §5 の false-success が実際には塞がっていなかった。
 *
 * 「同じ論理操作のリトライか」を決める本当の境界は auth session ではなく
 * **同一 JS ランタイム（= 同一アプリ起動）かどうか**である。
 * この Set は module scope なのでプロセス終了とともに必ず消える＝機械的に真。
 * 新しい durable フィールドを増やさずに済む。
 */
const createdInThisRun = new Set<string>();

/** テスト専用。プロセス再起動を再現するために run 境界をリセットする。 */
export function __resetSharedCalendarCreateRunScopeForTest(): void {
  createdInThisRun.clear();
}

export function wasSharedCalendarCreateStartedInThisRun(calendarId: string): boolean {
  return createdInThisRun.has(calendarId);
}

/**
 * pending の採用モード。`resume` だけが「APPLIED なら既存を返してよい」。
 * - `resume`       : 同一 owner かつ **この run が開始した** operation の継続
 * - `recover-only` : 同一 owner だが別 run（＝再起動後）。結果の再判定だけ許す
 * - `not-adoptable`: owner 不一致。問い合わせ自体を行わない
 */
export type SharedCalendarCreateResumeMode = "resume" | "recover-only" | "not-adoptable";

export function resolveSharedCalendarCreateResumeMode(
  pending: Pick<PendingSharedCalendarCreate, "ownerUserId" | "ownerSessionInstanceId">,
  identity: { userId: string; sessionInstanceId: string },
  startedInThisRun: boolean
): SharedCalendarCreateResumeMode {
  if (classifySharedCalendarCreateAdoption(pending, identity) === "foreign-owner") {
    return "not-adoptable";
  }
  return startedInThisRun ? "resume" : "recover-only";
}

/**
 * このキーの read -> derive -> write を直列化する module-level single-writer チェーン。
 * `enqueueSyncQueueOp` / `enqueueEventsOp` と同一設計（キー単位・新しい永続状態を増やさない・
 * operation が reject してもチェーンは次へ進む）。
 */
let journalWriteQueue: Promise<void> = Promise.resolve();

function enqueueJournalOp<T>(operation: () => Promise<T>): Promise<T> {
  const result = journalWriteQueue.then(operation, operation);
  journalWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * 破壊的判断の土台となる strict read。
 * QA-F073 の原則どおり missing / malformed / io-error を畳まない。
 * malformed は「未保存」と同一視せず throw する（不明な状態を「保留なし」に化かさない）。
 *
 * [P0136 DATA-F021-002] **child が1件でも invalid なら fail-closed で throw する**。
 * 以前は `.filter(isValid...)` で壊れた child を黙って捨てていたが、その filtered 配列を
 * put / clear / purge がそのまま書き戻すため、
 * 「正常な A pending + 壊れた B pending」の状態で A を purge しただけで
 * **B の未解決 operation identity まで永久に消える**（別 owner の記録を巻き添えにできる）。
 * 消えた B は後から新しい UUID で再作成され、重複 calendar を生む。
 * 破壊的な書き戻しの土台になる読み取りでは、部分復元を選んではならない。
 */
async function readAllStrict(): Promise<PendingSharedCalendarCreate[]> {
  const result = await readJSONStrict<unknown>(STORAGE_KEYS.sharedCalendarCreateJournal);
  switch (result.kind) {
    case "missing":
      return [];
    case "io-error":
      throw new StoredDataValidationError("sharedCalendarCreateJournal", "read_failed");
    case "malformed":
      throw new StoredDataValidationError("sharedCalendarCreateJournal", "parse_failed");
    case "value": {
      if (!Array.isArray(result.value)) {
        throw new StoredDataValidationError("sharedCalendarCreateJournal", "not_array");
      }
      const invalidCount = result.value.reduce(
        (count, entry) => (isValidPendingSharedCalendarCreate(entry) ? count : count + 1),
        0
      );
      if (invalidCount > 0) {
        // bulkAttemptJournalRepository と同じ house 形式のコード。
        throw new StoredDataValidationError(
          "sharedCalendarCreateJournal",
          `${invalidCount}_malformed_records`
        );
      }
      return result.value as PendingSharedCalendarCreate[];
    }
  }
}

/**
 * INSERT を送る**前**に呼ぶ。同じ calendarId が既にあれば上書きせず据え置く
 * （同一 operation の再入で createdAt を進めない）。
 */
export function putPendingSharedCalendarCreate(
  entry: PendingSharedCalendarCreate
): Promise<void> {
  return enqueueJournalOp(async () => {
    const all = await readAllStrict();
    // [P0137] この run が開始した operation であることを記録する。
    // 書込みが成功したかに関わらず「この run が送ろうとした」ことは真なので、
    // read の直後・write の前に印を付ける（write 失敗時も resume 対象として扱ってよい）。
    createdInThisRun.add(entry.calendarId);
    if (all.some((e) => e.calendarId === entry.calendarId)) return;
    await writeJSON(STORAGE_KEYS.sharedCalendarCreateJournal, [...all, entry]);
  });
}

/**
 * 指定 owner の保留分だけを返す。**他 owner の pending は返さない**
 * （A が開始した操作を B が reconcile できてはならない）。
 */
export function readPendingSharedCalendarCreates(
  ownerUserId: string
): Promise<PendingSharedCalendarCreate[]> {
  return enqueueJournalOp(async () => {
    const all = await readAllStrict();
    return all.filter((e) => e.ownerUserId === ownerUserId);
  });
}

/**
 * 結果が確定した（APPLIED / NOT_APPLIED / CONFLICT）ときだけ呼ぶ。
 * **UNKNOWN では絶対に呼ばない**——不明なまま消すと再判定手段を失う。
 * owner 一致も条件にして、別 owner の記録を巻き添えで消さない。
 */
export function clearPendingSharedCalendarCreate(
  calendarId: string,
  ownerUserId: string
): Promise<void> {
  return enqueueJournalOp(async () => {
    const all = await readAllStrict();
    const next = all.filter(
      (e) => !(e.calendarId === calendarId && e.ownerUserId === ownerUserId)
    );
    if (next.length === all.length) return;
    await writeJSON(STORAGE_KEYS.sharedCalendarCreateJournal, next);
  });
}
