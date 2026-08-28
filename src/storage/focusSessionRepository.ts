import { FocusSession, FocusSessionRecord, FocusSessionStatus } from "@/types/event";
import { readJSON, readJSONStrict, removeKey, writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";
import { buildFocusHistoryRecord, computeActiveElapsedMs } from "@/services/focusTimerEngine";
import { hasId, readRawArray } from "./arrayRepository";
import {
  isBoolean,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
  isString,
  isValidDateOnlyString,
  isValidIsoDateTimeString,
  StoredDataValidationError,
} from "./shapeGuards";

const KNOWN_STATUSES: FocusSessionStatus[] = [
  "scheduled",
  "running",
  "paused",
  "ready_to_complete",
  "completed",
  "cancelled",
];

/**
 * アクティブセッションのうち「進行中とみなせる」状態（=次のセッションの開始をブロックすべき状態）。
 * completed/cancelledは終端状態のため、単一スロットに残っていても新しいセッション開始を妨げない。
 */
const BLOCKING_STATUSES: FocusSessionStatus[] = [
  "scheduled",
  "running",
  "paused",
  "ready_to_complete",
];

/**
 * 保存済みJSONが現在のFocusSessionの形を満たしているかを検証する。
 * アプリ更新前の旧スキーマ（durationMinutes/startedAt等）や、その他の壊れたデータを
 * 安全に「セッション無し」として扱うためのガード（仕様25番対応）。
 *
 * DATA-F002-002残存部分（2026-08-02追記）: scheduledStartAt/scheduledEndAt/createdAt/
 * updatedAtは常に値を持つISO日時、actualStartedAt/pauseStartedAt/completedAtは
 * 「未確定を意味するnull」を許容するISO日時として検証する（実コードの構築箇所
 * ＝src/hooks/useFocusSession.tsのstart/pause/resume/complete/cancelがいずれも
 * .toISOString()かnullのみを書き込むことを確認済み）。不正な場合の扱い（呼び出し元の
 * getActiveFocusSessionがremoveKeyして「セッション無し」として返す）は変更しない。
 */
function isValidOptionalIsoDateTimeOrNull(value: unknown): boolean {
  return value === null || isValidIsoDateTimeString(value);
}

function isValidFocusSession(value: unknown): value is FocusSession {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.sourceEventId === "string" &&
    typeof v.plannedDurationMs === "number" &&
    typeof v.status === "string" &&
    KNOWN_STATUSES.includes(v.status as FocusSessionStatus) &&
    isValidIsoDateTimeString(v.scheduledStartAt) &&
    isValidIsoDateTimeString(v.scheduledEndAt) &&
    isValidOptionalIsoDateTimeOrNull(v.actualStartedAt) &&
    isValidOptionalIsoDateTimeOrNull(v.pauseStartedAt) &&
    isValidOptionalIsoDateTimeOrNull(v.completedAt) &&
    isValidIsoDateTimeString(v.createdAt) &&
    isValidIsoDateTimeString(v.updatedAt)
  );
}

export async function getActiveFocusSession(): Promise<FocusSession | null> {
  const raw = await readJSON<FocusSession | null>(STORAGE_KEYS.focusSession, null);
  if (raw == null) return null;
  if (!isValidFocusSession(raw)) {
    console.warn("[focusSessionRepository] 保存されたセッションの形式が不正なため無視します");
    // 自己修復のための削除。ここが失敗しても「セッション無し」として返す判断自体は
    // 変えない（読み込み専用のガード処理であり、ユーザー操作の保存失敗ではないため）。
    await removeKey(STORAGE_KEYS.focusSession).catch(() => {});
    return null;
  }
  return raw;
}

export async function saveActiveFocusSession(
  session: FocusSession
): Promise<void> {
  await writeJSON(STORAGE_KEYS.focusSession, session);
}

export async function clearActiveFocusSession(): Promise<void> {
  await removeKey(STORAGE_KEYS.focusSession);
}

/**
 * [P0132 DATA-F073-010] 破壊的操作を認可する判定のための、**ただ1回**の strict 読み取り。
 *
 * P0130 は `readJSONStrict`（strict probe）の直後に `getActiveFocusSession()`（tolerant）を
 * 呼んでおり、**同じキーを2回独立に読んで**いた。1回目が成功しても2回目が I/O 失敗すると
 * tolerant 側が `null` へ畳み、「競合なし」→「開始してよい」と解釈されて実在する
 * 進行中セッションを上書きし得た（P0131 が再開した欠陥）。窓を塞いだのではなく
 * 移動させただけだった。
 *
 * 判定は必ずこの1つのスナップショットだけから導く（**再読み取りを追加して直さない**）:
 *   missing        -> { kind: "none" }（本当に未保存。競合なし）
 *   io-error       -> throw read_failed（読めなかったことを「無い」に化かさない）
 *   malformed      -> throw parse_failed（壊れていることも「無い」ではない）
 *   schema 不正    -> throw invalid_shape（fail-closed。ここでは修復しない）
 *   valid          -> { kind: "session" }
 *
 * schema 不正をここで**修復しない**のは意図的である。破損値の自己修復は表示用の
 * `getActiveFocusSession()` 側の既存契約（removeKey）がそのまま担うため、次回の
 * 読み込みで解消される——判定側が破壊すると「判定のつもりが状態を変えた」ことになる。
 */
type ActiveSessionDecisionSnapshot =
  | { kind: "none" }
  | { kind: "session"; session: FocusSession };

async function readActiveSessionForMutationDecision(): Promise<ActiveSessionDecisionSnapshot> {
  const result = await readJSONStrict<unknown>(STORAGE_KEYS.focusSession);
  switch (result.kind) {
    case "missing":
      return { kind: "none" };
    case "io-error":
      throw new StoredDataValidationError("focusSession", "read_failed");
    case "malformed":
      throw new StoredDataValidationError("focusSession", "parse_failed");
    case "value":
      if (!isValidFocusSession(result.value)) {
        throw new StoredDataValidationError("focusSession", "invalid_shape");
      }
      return { kind: "session", session: result.value };
  }
}

/**
 * taskId以外の予定へ新しい集中セッションを開始しようとしていないかを判定する。
 * 進行中とみなせる状態（BLOCKING_STATUSES）かつsourceEventIdが一致しない場合のみ、
 * その競合セッションを返す（呼び出し元はこれを見て「戻る」案内を出す）。
 * 一致するtaskId自身への再開・completed/cancelled後の新規開始はブロックしない。
 *
 * これは表示用の読み取りではなく、**新しいセッションを開始してよいかを決める
 * mutation decision** である。読み取りは
 * `readActiveSessionForMutationDecision()` の単一スナップショットのみを使い、
 * `getActiveFocusSession()`（tolerant）は呼ばない。
 */
export async function getActiveSessionConflict(
  taskId: string
): Promise<FocusSession | null> {
  const snapshot = await readActiveSessionForMutationDecision();
  if (snapshot.kind === "none") return null;
  const active = snapshot.session;
  if (active.sourceEventId === taskId) return null;
  if (!BLOCKING_STATUSES.includes(active.status)) return null;
  return active;
}

/**
 * 「今の集中を終了して新しい集中を始める」が選ばれたときに使う。useFocusSessionの
 * cancel()と同じ「記録保存→ステータス更新」の手順を、フックがマウントされていない
 * （別タスクの）画面からでも呼べるようにリポジトリ層へ用意したもの。
 * 進行中でない（既にcompleted/cancelled）場合は何もしない＝二重終了・二重記録を防ぐ。
 *
 * [P0132 同一スコープ兄弟] この関数も「読み取り結果に基づいて破壊的な書き込み
 * （履歴追記＋cancelledへの遷移）を行うかどうかを決める」ため、mutation decision である。
 * 従来は tolerant な `getActiveFocusSession()` を使っていたため、読み取りが I/O 失敗すると
 * `null` へ畳まれて「終了すべきものは無い」と解釈され、**実際には生きているセッションを
 * 終了しないまま正常終了を返して**いた。呼び出し元（app/focus/[id].tsx の
 * 「今の集中を終了して新しい集中を始める」）はこれを成功とみなして次へ進むため、
 * 古いセッションが残ったまま新規開始へ向かう。
 * 判定は `getActiveSessionConflict` と同じ単一 strict スナップショットに統一する。
 * throw は呼び出し元の既存 try/catch（既存の保存失敗アラート）がそのまま受ける——
 * 新しい UI 文言は追加しない。
 */
export async function abandonActiveFocusSession(): Promise<void> {
  const snapshot = await readActiveSessionForMutationDecision();
  if (snapshot.kind === "none") return;
  const active = snapshot.session;
  if (active.status === "completed" || active.status === "cancelled") return;
  const activeElapsedMs = computeActiveElapsedMs(active, Date.now());
  const record = buildFocusHistoryRecord(active, activeElapsedMs, false);
  await appendFocusHistory(record);
  const nowIso = new Date().toISOString();
  const next: FocusSession = { ...active, status: "cancelled", completedAt: nowIso, updatedAt: nowIso };
  await saveActiveFocusSession(next);
}

/**
 * DATA-F002-002: 必須フィールド（id〜completedFully）は厳格に検証する。任意フィールドは
 * 存在する場合のみ型を確認し、型が不正ならレコード全体を除外する（部分的に欠けた
 * 分析用フィールドをそのまま下流の集計処理へ渡すと不正確な集計になりうるため）。
 */
function isValidFocusSessionRecord(value: unknown): value is FocusSessionRecord {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isNonEmptyString(value.taskId)) return false;
  if (!isString(value.taskTitle)) return false;
  if (!isValidIsoDateTimeString(value.startedAt)) return false;
  if (!isValidIsoDateTimeString(value.endedAt)) return false;
  if (!isFiniteNumber(value.plannedMinutes)) return false;
  if (!isFiniteNumber(value.actualMinutes)) return false;
  if (!isBoolean(value.completedFully)) return false;

  const optionalStrings: (keyof FocusSessionRecord)[] = [
    "sessionId",
    "sourceEventId",
    "calendarId",
    "calendarNameSnapshot",
  ];
  for (const key of optionalStrings) {
    if (value[key] !== undefined && !isString(value[key])) return false;
  }
  // DATA-F002-002残存部分（2026-08-02追記）: scheduledStartAtはISO日時（focusTimerEngine.tsが
  // session.scheduledStartAtをそのまま引き継ぐ）、dateKey/localDateKeyはYYYY-MM-DD
  // （focusTimerEngine.tsのformatLocalDate由来）。任意フィールドのため未設定は許容し、
  // 存在する場合のみ正式形式かどうかを検証する（不正なら既存方針どおりレコード全体を除外）。
  if (value.scheduledStartAt !== undefined && !isValidIsoDateTimeString(value.scheduledStartAt)) {
    return false;
  }
  if (value.dateKey !== undefined && !isValidDateOnlyString(value.dateKey)) return false;
  if (value.localDateKey !== undefined && !isValidDateOnlyString(value.localDateKey)) return false;
  const optionalNumbers: (keyof FocusSessionRecord)[] = [
    "plannedDurationMs",
    "actualActiveDurationMs",
    "totalPausedDurationMs",
    "interruptionCount",
    "creditedFocusSeconds",
    "timezoneOffsetMinutes",
    "schemaVersion",
  ];
  for (const key of optionalNumbers) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) return false;
  }
  if (
    value.sourceType !== undefined &&
    value.sourceType !== "local" &&
    value.sourceType !== "shared"
  ) {
    return false;
  }
  if (
    value.completionStatus !== undefined &&
    value.completionStatus !== "completed" &&
    value.completionStatus !== "abandoned"
  ) {
    return false;
  }
  return true;
}

export async function getFocusHistory(): Promise<FocusSessionRecord[]> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.focusHistory, []);
  if (!Array.isArray(raw)) {
    throw new StoredDataValidationError("focusHistory", "not_array");
  }
  const valid = raw.filter(isValidFocusSessionRecord);
  if (valid.length !== raw.length && __DEV__) {
    console.warn(`[focusSessionRepository] ${raw.length - valid.length}件の不正な集中履歴を除外しました`);
  }
  return valid;
}

/**
 * 同じidの記録が既に存在する場合は追加せず、既存の履歴をそのまま返す
 * （セッションIDを一意キーとした冪等性。完了処理の二重実行で記録が重複しないようにする）。
 */
/**
 * DATA-F002-004: getFocusHistory()の結果（形状検証済み）ではなく生の配列を読み直し、
 * この保存操作とは無関係な不正要素をStorageから消してしまわないようにする。
 */
/**
 * [P0130 F073-SERIALIZATION-CLOSURE-001] `focusHistory` キーのRMWを直列化する
 * module-level single-writer チェーン。
 *
 * `appendFocusHistory`（セッション完了・中断の記録）と
 * `deleteFocusHistoryRecord`（記録画面からの削除）は同一キーのRMWであり、
 * `await` を跨ぐ。両者を跨いで共有する上位権威は本番呼び出し元
 * （useFocusSession / 記録画面 / abandonActiveFocusSession経路）に存在しないため、
 * 完了記録と削除が交差すると後勝ちで相手の成功済み変更を失い得た。
 *
 * `enqueueSyncQueueOp` と同一設計（キー単位・新しい永続状態なし・poisonしない）。
 */
let focusHistoryWriteQueue: Promise<void> = Promise.resolve();

function enqueueFocusHistoryOp<T>(operation: () => Promise<T>): Promise<T> {
  const result = focusHistoryWriteQueue.then(operation, operation);
  focusHistoryWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export function appendFocusHistory(
  record: FocusSessionRecord
): Promise<FocusSessionRecord[]> {
  return enqueueFocusHistoryOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.focusHistory, "focusHistory");
    const history = raw.filter(isValidFocusSessionRecord);
    if (history.some((r) => r.id === record.id)) {
      return history;
    }
    const preservedInvalid = raw.filter(
      (el) => !isValidFocusSessionRecord(el) && !hasId(el, record.id)
    );
    const next = [record, ...history];
    await writeJSON(STORAGE_KEYS.focusHistory, [...next, ...preservedInvalid]);
    return next;
  });
}

/**
 * Stage I-4: 指定したid以外の記録は変更せず、対象のみ取り除いて書き戻す。
 * 既存の appendFocusHistory と同じく、全件読込→配列を更新→単一キーへ書き戻すだけの
 * 構造（focusHistoryキー自体の形式は変更しない）。
 *
 * [P0130] append と同じ `focusHistory` チェーンへ直列化する。
 */
export function deleteFocusHistoryRecord(
  id: string
): Promise<FocusSessionRecord[]> {
  return enqueueFocusHistoryOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.focusHistory, "focusHistory");
    const history = raw.filter(isValidFocusSessionRecord);
    const preservedInvalid = raw.filter((el) => !isValidFocusSessionRecord(el) && !hasId(el, id));
    const next = history.filter((r) => r.id !== id);
    await writeJSON(STORAGE_KEYS.focusHistory, [...next, ...preservedInvalid]);
    return next;
  });
}

/**
 * Stage I-5: 集中タイマー終了通知のnotificationId。
 * カレンダー予定の通知（notificationRepositoryのeventId→notificationId対応表）とは
 * 完全に別のストレージキーで管理する（両者を混在させない設計方針）。
 * 集中タイマーは同時に1件しか実行されない前提のため、単一値として保持するだけでよい。
 */
/** DATA-F002-002: Category C（補助的データ）。不正な形状は安全にnullへフォールバックする。 */
export async function getFocusTimerNotificationId(): Promise<string | null> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.focusTimerNotificationId, null);
  if (raw === null) return null;
  return isString(raw) ? raw : null;
}

/** 補助的データ（Category C）。OS側の通知予約自体は既に成功しているため、保存失敗は伝播させない。 */
export async function saveFocusTimerNotificationId(
  notificationId: string
): Promise<void> {
  await writeJSON(STORAGE_KEYS.focusTimerNotificationId, notificationId).catch(() => {});
}

export async function clearFocusTimerNotificationId(): Promise<void> {
  await removeKey(STORAGE_KEYS.focusTimerNotificationId).catch(() => {});
}
