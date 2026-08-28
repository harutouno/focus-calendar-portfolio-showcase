import { AppEvent, RepeatType, UnlockConditionType } from "@/types/event";
import { addDays } from "@/utils/date";
import { timeToMinutes } from "@/utils/time";
import { readJSON, writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";
import { hasAnyId, hasId, readRawArray } from "./arrayRepository";
import {
  isBoolean,
  isFiniteNumber,
  isNonEmptyString,
  isOneOf,
  isPlainObject,
  isString,
  isStringArray,
  isValidDateOnlyString,
  isValidIsoDateTimeString,
  isValidTimeString,
  StoredDataValidationError,
} from "./shapeGuards";

const REPEAT_TYPES: readonly RepeatType[] = ["none", "daily", "weekly", "monthly", "yearly"];
const UNLOCK_CONDITION_TYPES: readonly UnlockConditionType[] = ["none", "calculation"];

function isValidNotification(value: unknown): boolean {
  return isPlainObject(value) && isBoolean(value.enabled) && isFiniteNumber(value.minutesBefore);
}

function isValidRepeat(value: unknown): boolean {
  return isPlainObject(value) && isOneOf(value.type, REPEAT_TYPES);
}

function isValidUnlockCondition(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!isOneOf(value.type, UNLOCK_CONDITION_TYPES)) return false;
  if (value.count !== undefined && !isFiniteNumber(value.count)) return false;
  return true;
}

/**
 * 予定1件の実行時形状検証（DATA-F002-002）。壊れた要素だけを一覧から除外できるよう、
 * 配列フィルタで使う。型の妥当性だけを見る（例: titleは文字列であればよく、空文字を
 * 理由に不正扱いはしない——空文字の禁止は既存のフォームバリデーション側の関心事）。
 * [P0080 DATA-F013-001] 読取り専用の内部関数だったが、書込み時の防御（下記
 * assertValidWriteEvent）およびsharedEventsService.tsの共有ネットワーク送信直前の
 * 検証からも同じ判定基準を再利用できるよう、公開関数へ変更した（判定ロジック自体は
 * 無変更）。
 */
export function isValidAppEvent(value: unknown): value is AppEvent {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isString(value.title)) return false;
  if (!isValidDateOnlyString(value.date)) return false;
  if (!isValidTimeString(value.startTime)) return false;
  if (!isNonEmptyString(value.calendarId)) return false;
  if (!isStringArray(value.shareWith)) return false;
  if (!isBoolean(value.completed)) return false;
  if (!isValidNotification(value.notification)) return false;
  if (!isValidRepeat(value.repeat)) return false;
  if (!isValidIsoDateTimeString(value.createdAt)) return false;
  if (!isValidIsoDateTimeString(value.updatedAt)) return false;
  if (value.memo !== undefined && !isString(value.memo)) return false;
  if (value.recurringGroupId !== undefined && !isString(value.recurringGroupId)) return false;
  if (value.recurrenceIndex !== undefined && !isFiniteNumber(value.recurrenceIndex)) return false;

  if (value.kind === "normal") {
    if (!isValidTimeString(value.endTime)) return false;
    if (!isBoolean(value.allDay)) return false;
    // [P0078 CORRECT-F016-001] endDateは任意（dateと同一日を意味するundefinedを含む）。
    // [P0082 DATA-F016-003] 以前はendDateが「存在する場合は日付形式であること」しか
    // 検証しておらず、意味的な不変条件（src/utils/eventDaySlice.ts・resolveEndDate
    // （src/utils/time.ts）が前提とする「endDateはnull（=dateと同一日）かdateの厳密に
    // 翌日のいずれかのみ」）をこの書込み時防御レイヤーでは一切強制していなかった。
    // [P0084 DATA-F016-004] P0082時点のチェックは「endDateが存在する場合、それがdateの
    // 翌日であること」しか見ておらず、実際のstartTime/endTimeの時刻関係とendDateの
    // 有無・値が一致しているかを一切クロスチェックしていなかった——結果、
    // 「23:40→00:40なのにendDate未設定（本来は日をまたぐのに同日扱いのまま）」や
    // 「10:00→11:00（同日で完結する）なのにendDateが翌日」のような、resolveEndDateの
    // 正本ルールと矛盾する値も書込み時には素通りしていた（読取り時のeventDaySlice等が
    // 誤って解釈する余地を残す）。resolveEndDate（src/utils/time.ts）が唯一の正本とする
    // 「endTimeの時刻部分がstartTimeの時刻部分以下（同時刻を含む）なら日をまたぐ」
    // という判定を、この書込み時防御でも同じ基準でそのまま再現し、endDateの有無・値が
    // これと一致しない場合は拒否する。allDay予定はovernight endDateを持たない
    // （同日のみ許可）。
    if (value.allDay) {
      if (value.endDate !== undefined) return false;
    } else {
      // [P0086 SPEC-F016-001] startTime===endTimeは、resolveEndDateの<=規約に従うと
      // 「日をまたぐ」側に分類されてしまうが、これは「同時刻＝24時間予定」という
      // これまで存在しなかった製品仕様を書込み時防御レイヤーが黙って許可することに
      // なる（正本の禁止事項）。resolveEndDateの日またぎ判定を適用する前に、完全な
      // 同時刻はここで明示的に拒否する（正常なUIはvalidateNormalEvent/
      // validateBulkEventRangeで既に拒否しているため、ここに到達するのは防御的な
      // 経路のみを想定）。
      if (value.endTime === value.startTime) return false;
      const crossesMidnight = timeToMinutes(value.endTime) <= timeToMinutes(value.startTime);
      if (crossesMidnight) {
        if (value.endDate !== addDays(value.date, 1)) return false;
      } else {
        if (value.endDate !== undefined) return false;
      }
    }
    if (value.endDate !== undefined && !isValidDateOnlyString(value.endDate)) return false;
    if (value.location !== undefined && !isString(value.location)) return false;
    return true;
  }
  if (value.kind === "focus") {
    if (!isFiniteNumber(value.durationMinutes)) return false;
    if (!isStringArray(value.restrictedApps)) return false;
    if (!isValidUnlockCondition(value.unlockCondition)) return false;
    return true;
  }
  return false;
}

/**
 * トップレベルが配列でない場合（構文は正しいが期待した形と全く異なる場合）は、
 * 安全に部分復元できないため黙って空配列にはせず、StoredDataValidationErrorをthrowして
 * 呼び出し元（AppDataContext.runInitializationの既存try/catch）へ委ねる。
 * 配列の中の一部要素だけが壊れている場合は、正常な要素だけを残して返す
 * （壊れた要素の内容はログに出さず、除外件数のみ__DEV__時に記録する）。
 */
export async function getAllEvents(): Promise<AppEvent[]> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.events, []);
  if (!Array.isArray(raw)) {
    throw new StoredDataValidationError("events", "not_array");
  }
  const valid = raw.filter(isValidAppEvent);
  if (valid.length !== raw.length && __DEV__) {
    console.warn(`[eventsRepository] ${raw.length - valid.length}件の不正な予定データを除外しました`);
  }
  return valid;
}

/**
 * [P0080 DATA-F013-001] 書込み対象のAppEventが、getAllEvents()が読取り時に要求するのと
 * 同じ形状（isValidAppEvent）を満たさない場合はStorageへ書き込む前に例外を投げる。
 * 以前はsaveEvent/saveEventsが書込み対象そのものを一切検証しておらず、不正な形状の
 * 予定（例: date="2026-02-30"）でも一度は書き込めてしまい、次回のgetAllEvents()呼出しで
 * 黙って除外され「保存した予定が消えた」という状態になっていた（この関数自身が既に
 * 読取り時にisValidAppEventで弾く形状を、書込み時には無検証で通してしまう非対称性が
 * 実バグの原因）。この関数が投げるStoredDataValidationErrorは、read時の
 * "not_array"（トップレベル構造そのものの破損）と区別できるよう理由を
 * "invalid_write_shape"にする。
 */
function assertValidWriteEvent(event: AppEvent): void {
  if (!isValidAppEvent(event)) {
    throw new StoredDataValidationError("events", "invalid_write_shape");
  }
}

/**
 * DATA-F002-004: 不正な形状の要素がStorageに混入していても、この保存操作とは無関係な
 * それらの要素をここで書き戻し時に永久に失わないよう、getAllEvents()（形状検証済みの
 * 要素だけを返す）の結果ではなく、生の配列を直接読み直して操作する。対象と同じidを
 * 持つ要素（不正な形状であっても）だけは、既存仕様どおり置換の対象にする。
 */
/**
 * [P0130 F073-SERIALIZATION-CLOSURE-001] `events` キーのRMWを直列化する
 * module-level single-writer チェーン。
 *
 * 5つのwriter（saveEvent / saveEvents / deleteEvent / deleteEvents / replaceAllEvents）は
 * いずれも
 *   readRawArray -> 派生 -> writeJSON
 * であり、`await` を跨ぐ。呼び出し元（eventService.ts の saveLocalEvent /
 * saveLocalEventsBulk / removeLocalEvent / removeLocalEventsBulk、および seedData.ts）は
 * これらを直接呼んでおり、これらを跨いで共有する上位の直列化権威は存在しない
 * （userCalendars における localCalendarLifecycleCoordinator に相当するものが無い）。
 * そのため2つの操作が同じ古いスナップショットを読み、後勝ちで相手の成功済み変更を
 * 消し得た（例: ドラッグ移動の保存と別画面からの削除が交差する）。
 *
 * 設計は同リポジトリ群で確立済みの `enqueueSyncQueueOp` /
 * `registryMutationChain` と同一:
 * - キー単位。アプリ全体のストレージmutexにはしない。
 * - 新しい永続状態を増やさない。
 * - operationがrejectしてもチェーンは次へ進む（poisonしない）。エラーは呼び出し元へ伝播する。
 */
let eventsWriteQueue: Promise<void> = Promise.resolve();

function enqueueEventsOp<T>(operation: () => Promise<T>): Promise<T> {
  const result = eventsWriteQueue.then(operation, operation);
  eventsWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function saveEvent(event: AppEvent): Promise<AppEvent[]> {
  // 入力検証は直列化キューへ積む前に行う（不正な入力で他操作を待たせない）。
  // ただしこの関数は`async`のまま維持する——非asyncにすると
  // assertValidWriteEventが**同期throw**になり、「常にPromiseを返し、失敗は
  // rejectionで表す」という既存契約が壊れる（`.catch()`で受けている呼び出し元が
  // 素通しの例外を受け取る）。P0130で一度非asyncにして
  // __tests__/eventsRepository.test.ts の12件が落ちたため、契約を明示的に固定する。
  assertValidWriteEvent(event);
  return enqueueEventsOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.events, "events");
    const validEvents = raw.filter(isValidAppEvent);
    const preservedInvalid = raw.filter((el) => !isValidAppEvent(el) && !hasId(el, event.id));
    const idx = validEvents.findIndex((e) => e.id === event.id);
    let next: AppEvent[];
    if (idx >= 0) {
      next = [...validEvents];
      next[idx] = event;
    } else {
      next = [...validEvents, event];
    }
    await writeJSON(STORAGE_KEYS.events, [...next, ...preservedInvalid]);
    return next;
  });
}

/**
 * 一括作成・一括編集用のバッチ保存API。全件読込→まとめてupsert→1回だけ書込、という方式にすることで、
 * saveEvent()をN回呼ぶ場合に発生するO(N^2)の読み書き（全件読込→書込をN回繰り返す）を避ける。
 * saveEvent()の1件ずつのupsertロジック（IDが一致すれば置き換え、なければ追加）と同じ意味論にして
 * あるため、一括作成（新規ID）にも一括編集（既存IDの更新、繰り返し予定の「これ以降/すべて」編集）
 * にもそのまま使える（saveEvent()自体は一切変更していない）。
 */
export async function saveEvents(events: AppEvent[]): Promise<AppEvent[]> {
  // saveEventと同じ理由で`async`を維持する（同期throwへ退行させない）。
  events.forEach(assertValidWriteEvent);
  return enqueueEventsOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.events, "events");
    const existing = raw.filter(isValidAppEvent);
    const targetIds = new Set(events.map((e) => e.id));
    const preservedInvalid = raw.filter((el) => !isValidAppEvent(el) && !hasAnyId(el, targetIds));
    const updatesById = new Map(events.map((e) => [e.id, e]));
    const merged = existing.map((e) => updatesById.get(e.id) ?? e);
    const existingIds = new Set(existing.map((e) => e.id));
    const newOnes = events.filter((e) => !existingIds.has(e.id));
    const next = [...merged, ...newOnes];
    await writeJSON(STORAGE_KEYS.events, [...next, ...preservedInvalid]);
    return next;
  });
}

export function deleteEvent(id: string): Promise<AppEvent[]> {
  return enqueueEventsOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.events, "events");
    const events = raw.filter(isValidAppEvent);
    const preservedInvalid = raw.filter((el) => !isValidAppEvent(el) && !hasId(el, id));
    const next = events.filter((e) => e.id !== id);
    await writeJSON(STORAGE_KEYS.events, [...next, ...preservedInvalid]);
    return next;
  });
}

/**
 * 繰り返し予定の「これ以降/すべて」削除用のバッチ削除API。
 * 全件読込→対象IDをまとめて除外→1回だけ書込にすることで、deleteEvent()をN回呼ぶ場合の
 * O(N^2)の読み書きを避ける（deleteEvent()自体は一切変更していない）。
 */
export function deleteEvents(ids: string[]): Promise<AppEvent[]> {
  return enqueueEventsOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.events, "events");
    const events = raw.filter(isValidAppEvent);
    const idSet = new Set(ids);
    const preservedInvalid = raw.filter((el) => !isValidAppEvent(el) && !hasAnyId(el, idSet));
    const next = events.filter((e) => !idSet.has(e.id));
    await writeJSON(STORAGE_KEYS.events, [...next, ...preservedInvalid]);
    return next;
  });
}

export async function getEventById(id: string): Promise<AppEvent | undefined> {
  const events = await getAllEvents();
  return events.find((e) => e.id === id);
}

/**
 * seedData.tsからのみ呼ばれる、初回起動時の全件置き換え（既存の有効な予定が0件のときにのみ
 * 呼ばれる、既存仕様は無変更）。DATA-F002-004: この場合も、既存の不正な形状の要素を
 * Storageから消してしまわないよう保持する（シードのIDは新規生成のため衝突しない）。
 */
export function replaceAllEvents(events: AppEvent[]): Promise<void> {
  return enqueueEventsOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.events, "events");
    const preservedInvalid = raw.filter((el) => !isValidAppEvent(el));
    await writeJSON(STORAGE_KEYS.events, [...events, ...preservedInvalid]);
  });
}
