import { AppEvent } from "@/types/event";
import { generateId } from "@/utils/id";
import { readJSON, writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";
import { readRawArray } from "./arrayRepository";
import {
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
  isString,
  isValidIsoDateTimeString,
  StoredDataValidationError,
} from "./shapeGuards";

export interface SyncQueueItem {
  eventId: string;
  calendarId: string;
  type: "upsert" | "delete";
  /** type === "upsert" のときのみ使用 */
  event?: AppEvent;
  queuedAt: string;
  attempts: number;
  lastError?: string;
  /**
   * SEC-F002-001: この操作をキューへ積んだ時点の認証ユーザーID（Supabase Authのuser.id）。
   * 新規に積まれる項目には必ず設定される（enqueueUpsert/enqueueDeleteが必須引数として
   * 要求する）。このフィールド自体が存在しない項目は、本対応より前のバージョンで保存された
   * 「所有者不明」の旧形式データであることを意味し、無条件に現在の認証ユーザーへ紐づけて
   * 送信してはならない（useSyncQueueProcessor.tsのflush()側で送信対象から除外する）。
   * アクセストークン・メールアドレス等の機密情報は保持しない。
   */
  queuedByUserId?: string;
  /**
   * REVISE対応（P1-2）: この操作をキューへ積んだ時点の認証セッションID（JWTのsession_id
   * クレーム由来、authSessionIdentityStore.sessionInstanceId）。同一userIdのまま
   * サインアウト→再サインインした場合（新しいセッション）に、旧セッションで積まれた
   * 未送信項目を新セッションの操作として誤って再送しないための識別子。新規に積まれる
   * 項目には必ず設定される（enqueueUpsert/enqueueDeleteが必須引数として要求する）。
   * このフィールド自体が存在しない項目はqueuedByUserId欠落と同様に「旧形式」として扱う。
   */
  queuedBySessionInstanceId?: string;
  /**
   * SEC-F002-001残存修正: enqueueのたびに新しく発行される一意なID（generateId("syncq")）。
   * eventId単位ではなくこのIDを主キーとしてremoveFromQueue/markQueueItemFailedが対象を
   * 特定するため、「送信中（await中）に同じeventIdへ新しい項目が積まれた」場合でも、
   * 古いflushが新しい項目を誤って削除・更新することがない（新しい項目には新しいIDが
   * 割り当てられ、古いIDはStorage上から既に消えているため、古いflushの削除はno-opになる）。
   * このフィールド自体が無い項目は、queuedByUserId欠落と同様に「旧形式」として扱い送信しない。
   */
  queueItemId?: string;
}

/**
 * DATA-F002-002: 壊れた要素だけを一覧から除外できるよう、配列フィルタで使う。
 * eventフィールドはeventsRepository.tsの検証ロジックを重複させず、「typeがupsertなら
 * objectであること」だけを確認する（不正な形のeventが残った場合、実際の送信処理
 * （sharedEventsService.upsertSharedEvent）側でサーバーのバリデーションにより
 * 弾かれるため、ここでの二重の詳細検証は必須ではない）。
 *
 * SEC-F002-001: queuedByUserIdは新形式では非空文字列だが、フィールド自体が存在しない
 * （旧形式）ことは形状エラーとして除外しない——「所有者不明」の項目として引き続き
 * キューに残し、送信の可否はflush()側のユーザー照合に委ねる（ここで削除すると
 * 「無根拠に破棄する」ことになり、安全側の判断にならないため）。
 */
function isValidSyncQueueItem(value: unknown): value is SyncQueueItem {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.eventId)) return false;
  if (!isNonEmptyString(value.calendarId)) return false;
  if (value.type !== "upsert" && value.type !== "delete") return false;
  if (!isValidIsoDateTimeString(value.queuedAt)) return false;
  if (!isFiniteNumber(value.attempts)) return false;
  if (value.lastError !== undefined && !isString(value.lastError)) return false;
  if (value.type === "upsert" && !isPlainObject(value.event)) return false;
  if (value.queuedByUserId !== undefined && !isNonEmptyString(value.queuedByUserId)) return false;
  if (
    value.queuedBySessionInstanceId !== undefined &&
    !isNonEmptyString(value.queuedBySessionInstanceId)
  )
    return false;
  if (value.queueItemId !== undefined && !isNonEmptyString(value.queueItemId)) return false;
  return true;
}

/**
 * SEC-F002-001残存修正: 「送信してよい新形式の項目」かどうかを判定する。
 * queueItemId・queuedByUserIdの両方が揃っていない項目（本対応より前に保存された旧形式、
 * および前回のSEC-F002-001修正時点でqueuedByUserIdのみ持ちqueueItemIdを持たない
 * 過渡的な形式のいずれも）は、所有者・識別子のどちらかが安全に確定できないため、
 * useSyncQueueProcessor.tsのflush()から送信対象として扱わない。
 * REVISE対応（P1-2）: queuedBySessionInstanceIdも必須条件に加えた。これが無い項目
 * （本対応より前に積まれた項目）は、どのセッションで積まれたか安全に確定できないため
 * 同様に送信対象から除外する。
 */
export function isFlushableSyncQueueItem(
  item: SyncQueueItem
): item is SyncQueueItem & {
  queueItemId: string;
  queuedByUserId: string;
  queuedBySessionInstanceId: string;
} {
  return (
    isNonEmptyString(item.queueItemId) &&
    isNonEmptyString(item.queuedByUserId) &&
    isNonEmptyString(item.queuedBySessionInstanceId)
  );
}

/**
 * REVISE対応（第3ラウンド、P1-5）: enqueueUpsert・enqueueDelete・removeFromQueue・
 * markQueueItemFailed・clearSyncQueueは、それぞれ独立にread-modify-write（読み込み→
 * 変更→書き込み）を行っていたため、2つの操作がほぼ同時に発火すると、後勝ちのwriteJSONが
 * 先の操作の変更を丸ごと上書きしてしまう競合（lost update）があった
 * （notificationRepository.tsが同種の問題をP2-1でこの直列化チェーンにより解決済みの
 * ため、同じ設計をここでも採用する）。この単一のPromiseチェーンへ全ての変更操作を
 * 通すことで、常に「直前の操作の書き込みが完全に終わった後」にしか次の操作の読み込みが
 * 始まらないことを保証する。`op`が例外を投げてもチェーン自体は途切れず次の操作へ進む
 * （必須テスト5: 失敗した変更が後続の操作をブロックしない）。
 */
let syncQueueMutationChain: Promise<void> = Promise.resolve();

function enqueueSyncQueueOp<T>(op: () => Promise<T>): Promise<T> {
  const run = syncQueueMutationChain.then(op);
  syncQueueMutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** getSyncQueueの実体。enqueueSyncQueueOpの外側・内側の両方から安全に呼べる（自身はチェーンに触れない）。 */
async function readSyncQueueRaw(): Promise<SyncQueueItem[]> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.syncQueue, []);
  if (!Array.isArray(raw)) {
    throw new StoredDataValidationError("syncQueue", "not_array");
  }
  const valid = raw.filter(isValidSyncQueueItem);
  if (valid.length !== raw.length && __DEV__) {
    console.warn(`[syncQueueRepository] ${raw.length - valid.length}件の不正な同期キュー項目を除外しました`);
  }
  return valid;
}

/**
 * REVISE対応（第6ラウンド、P1-2）: 以前はこの読み込みがsyncQueueMutationChainを一切
 * 経由しなかったため、他の変更操作（enqueueUpsert等）がチェーン内で順番待ちしている間に
 * この関数が呼ばれると、その進行中の変更が反映される前の古いスナップショットを読んでしまう
 * ことがあった（flush()の初回読込み・useSyncQueueProcessor.tsのマウント時読込みが対象）。
 * notificationRepository.tsのgetAllNotificationEntries（第5ラウンド、P2-2）と同じ設計で、
 * この読み込みも直列化チェーンへ合流させ、「この時点までにキューへ積まれた変更」が
 * 必ず反映された状態を読めるようにする。
 */
export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  return enqueueSyncQueueOp(() => readSyncQueueRaw());
}

/**
 * DATA-F002-004: 不正な形状の要素かどうかを問わず、指定したeventId・queuedByUserId・
 * queuedBySessionInstanceIdの組に一致するかどうかを判定する。enqueue系の圧縮ロジックと
 * 揃えるための、無関係な不正要素の保持除外に使う。
 * REVISE対応（第3ラウンド、P1-5、必須テスト4）: 圧縮の単位に
 * queuedBySessionInstanceIdを追加した。以前はeventId＋queuedByUserIdのみで圧縮していたため、
 * 同一userIdのまま旧セッションで積まれた未送信項目が、新セッションで同じeventIdへ
 * 積んだ項目によって（実質的に別のセッションの操作なのに）誤って上書き・混同され得た。
 */
function matchesEventUserSession(
  value: unknown,
  eventId: string,
  queuedByUserId: string,
  queuedBySessionInstanceId: string
): boolean {
  return (
    isPlainObject(value) &&
    value.eventId === eventId &&
    value.queuedByUserId === queuedByUserId &&
    value.queuedBySessionInstanceId === queuedBySessionInstanceId
  );
}

/** 不正な形状の要素かどうかを問わず、指定したqueueItemIdに一致するかどうかを判定する。 */
function matchesQueueItemId(value: unknown, queueItemId: string): boolean {
  return isPlainObject(value) && value.queueItemId === queueItemId;
}

/**
 * REVISE対応（第6ラウンド、P1-2）: enqueueUpsert/enqueueDeleteの結果。
 * useSyncQueueProcessor.tsのEnqueueOutcomeと同じ意味（"enqueued"=実際にAsyncStorageへ
 * 保存できた、"discarded-stale"=identity不一致のため保存自体を行わなかった）だが、
 * 定義はこちらのファイルを正本とする（syncQueueMutationChain内部の判定結果をそのまま
 * 返せるようにするため）。useSyncQueueProcessor.tsはこの型をそのままre-exportする。
 *
 * REVISE対応（第7ラウンド、P1-1）: "stale-cleanup-pending"を追加した。書込み後にstaleと
 * 判明した際の補償削除（compensating delete）自体が失敗した場合を表す——この場合、
 * 今回enqueueした項目はStorageに残ったまま（"discarded-stale"のように確実に除去された
 * わけではない）である。以前はこの補償writeJSONの失敗を`.catch(() => {})`で握りつぶし、
 * 常に"discarded-stale"（＝Storageから消せた）を返していたため、実際には残っている
 * 旧所有者の予定データを「破棄済み」と誤って報告していた。呼び出し元は
 * "stale-cleanup-pending"を"discarded-stale"と同様に「保存/削除は完了しなかった」
 * 失敗として扱い、後続のpurgeStaleSyncQueueItems（現在identityを正本とする選択的除去、
 * AppState「active」復帰・次回起動時に既存経路から自動的に呼ばれる）による回収に委ねる。
 */
export type EnqueueOutcome = "enqueued" | "discarded-stale" | "stale-cleanup-pending";

/**
 * 同じユーザーの同じeventIdに対する未送信操作は上書きする（最後の操作だけを送ればよいため）。
 * SEC-F002-001残存修正: 圧縮の単位を「eventIdのみ」から「eventId＋queuedByUserId」へ変更した。
 * 異なるユーザーが同じeventId（同じ共有予定）へオフライン操作を積んだ場合、互いの項目を
 * 上書きしない（同一端末での複数アカウント利用時に、後から積んだユーザーの操作が
 * 前のユーザーの未送信操作を消してしまうことを防ぐ）。queuedByUserIdが無い旧形式の項目は
 * 常に一致しない（`undefined !== 文字列`）ため、新規enqueueで暗黙に圧縮されることはなく、
 * 元のまま残る（ログアウト時のclearSyncQueue()以外で自動的に消えることは無い）。
 * 新規項目には毎回新しいqueueItemIdを発行する——送信中（await中）の古い項目と
 * 新しく積まれた項目が同じ識別子を共有することはない。
 * queuedByUserIdは呼び出し元の自由入力を受け付けるが、実際の値は
 * useSyncQueueProcessor.ts側が自身のuserIdRef（AuthContextのuser.idに追従する信頼できる値）
 * からのみ渡す設計とする（他の呼び出し元を追加しない）。
 */
/**
 * DATA-F002-004: getSyncQueue()（形状検証済み）ではなく生の配列を読み直し、この操作とは
 * 無関係な不正要素をStorageから消してしまわないようにする。無関係かどうかの判定は、
 * 既存の圧縮ロジックと同じ単位（eventId＋queuedByUserId＋queuedBySessionInstanceId）で行う。
 */
/**
 * REVISE対応（第6ラウンド、P1-2）: 呼び出し元（useSyncQueueProcessor.ts）は、この関数を
 * 呼ぶ「前」にisStillCurrentIdentityを確認しているが、この関数自体はsyncQueueMutationChain
 * （他の全変更操作と共有する単一の直列化キュー）へ積まれるため、実際に処理が始まるまでの
 * 待ち時間の間にidentityが変化しうる（呼び出し前チェックと実際の書込みの間に競合窓が残る）。
 * `isStillCurrent`を直列化されたop自身の内部で、読み込み後・書込み直前と、書込み完了後の
 * 両方で再確認することで、この窓を完全に閉じる。書込み完了後に stale と判明した場合は、
 * 今回発行したqueueItemIdだけを同じop内（＝同じ直列化スロット内、追加のenqueueは不要）で
 * 補償削除する。
 */
export function enqueueUpsert(
  event: AppEvent,
  queuedByUserId: string,
  queuedBySessionInstanceId: string,
  isStillCurrent: () => boolean
): Promise<{ queue: SyncQueueItem[]; outcome: EnqueueOutcome }> {
  return enqueueSyncQueueOp(async () => {
    if (!isStillCurrent()) {
      return { queue: await readSyncQueueRaw(), outcome: "discarded-stale" as const };
    }
    const raw = await readRawArray(STORAGE_KEYS.syncQueue, "syncQueue");
    if (!isStillCurrent()) {
      return { queue: raw.filter(isValidSyncQueueItem), outcome: "discarded-stale" as const };
    }
    const queue = raw.filter(isValidSyncQueueItem);
    const preservedInvalid = raw.filter(
      (el) =>
        !isValidSyncQueueItem(el) &&
        !matchesEventUserSession(el, event.id, queuedByUserId, queuedBySessionInstanceId)
    );
    const next = queue.filter(
      (q) =>
        !(
          q.eventId === event.id &&
          q.queuedByUserId === queuedByUserId &&
          q.queuedBySessionInstanceId === queuedBySessionInstanceId
        )
    );
    const newItemId = generateId("syncq");
    next.push({
      queueItemId: newItemId,
      eventId: event.id,
      calendarId: event.calendarId,
      type: "upsert",
      event,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      queuedByUserId,
      queuedBySessionInstanceId,
    });
    await writeJSON(STORAGE_KEYS.syncQueue, [...next, ...preservedInvalid]);
    if (!isStillCurrent()) {
      const compensated = next.filter((q) => q.queueItemId !== newItemId);
      // REVISE対応（第7ラウンド、P1-1）: 補償削除自体の書込み失敗をもう握りつぶさない。
      // 失敗した場合、今回enqueueした項目はStorageに残ったまま（next相当）であり、
      // これを"discarded-stale"として報告すると「破棄できた」という誤った保証になる。
      try {
        await writeJSON(STORAGE_KEYS.syncQueue, [...compensated, ...preservedInvalid]);
        return { queue: compensated, outcome: "discarded-stale" as const };
      } catch {
        return { queue: next, outcome: "stale-cleanup-pending" as const };
      }
    }
    return { queue: next, outcome: "enqueued" as const };
  });
}

export function enqueueDelete(
  eventId: string,
  calendarId: string,
  queuedByUserId: string,
  queuedBySessionInstanceId: string,
  isStillCurrent: () => boolean
): Promise<{ queue: SyncQueueItem[]; outcome: EnqueueOutcome }> {
  return enqueueSyncQueueOp(async () => {
    if (!isStillCurrent()) {
      return { queue: await readSyncQueueRaw(), outcome: "discarded-stale" as const };
    }
    const raw = await readRawArray(STORAGE_KEYS.syncQueue, "syncQueue");
    if (!isStillCurrent()) {
      return { queue: raw.filter(isValidSyncQueueItem), outcome: "discarded-stale" as const };
    }
    const queue = raw.filter(isValidSyncQueueItem);
    const preservedInvalid = raw.filter(
      (el) =>
        !isValidSyncQueueItem(el) &&
        !matchesEventUserSession(el, eventId, queuedByUserId, queuedBySessionInstanceId)
    );
    const next = queue.filter(
      (q) =>
        !(
          q.eventId === eventId &&
          q.queuedByUserId === queuedByUserId &&
          q.queuedBySessionInstanceId === queuedBySessionInstanceId
        )
    );
    const newItemId = generateId("syncq");
    next.push({
      queueItemId: newItemId,
      eventId,
      calendarId,
      type: "delete",
      queuedAt: new Date().toISOString(),
      attempts: 0,
      queuedByUserId,
      queuedBySessionInstanceId,
    });
    await writeJSON(STORAGE_KEYS.syncQueue, [...next, ...preservedInvalid]);
    if (!isStillCurrent()) {
      const compensated = next.filter((q) => q.queueItemId !== newItemId);
      // REVISE対応（第7ラウンド、P1-1）: enqueueUpsertと同じ理由で、補償削除の失敗を
      // 握りつぶさない。
      try {
        await writeJSON(STORAGE_KEYS.syncQueue, [...compensated, ...preservedInvalid]);
        return { queue: compensated, outcome: "discarded-stale" as const };
      } catch {
        return { queue: next, outcome: "stale-cleanup-pending" as const };
      }
    }
    return { queue: next, outcome: "enqueued" as const };
  });
}

/**
 * 送信済みアイテムのキューからの除去は補助的データ（Category C）。ここで保存に失敗しても
 * 次回のflush()がID主キーの冪等な再送を試みるだけで、データ損失にはならないため
 * 呼び出し元へ伝播させない。
 *
 * SEC-F002-001残存修正: 対象の特定をeventIdからqueueItemId（enqueueのたびに新しく発行される
 * 一意なID）へ変更した。これにより、この項目の送信（await）が完了する前に、同じeventIdへ
 * 新しい項目が積まれていた場合でも（別ユーザーによる場合・同一ユーザーによる再編集の
 * 場合のいずれも）、新しい項目（＝別のqueueItemId）を誤って削除しない。対象の
 * queueItemIdが既にStorage上に存在しない場合（既に別の経路で除去済み等）は、
 * 何も一致せず無変更で終わる安全な冪等処理として扱う。
 */
/**
 * DATA-F002-004: getSyncQueue()（形状検証済み）ではなく生の配列を読み直し、この削除操作とは
 * 無関係な不正要素をStorageから消してしまわないようにする（対象と同じqueueItemIdを持つ
 * 不正要素だけは、既存仕様どおり削除対象に含める）。
 */
export function removeFromQueue(queueItemId: string): Promise<SyncQueueItem[]> {
  return enqueueSyncQueueOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.syncQueue, "syncQueue");
    const queue = raw.filter(isValidSyncQueueItem);
    const preservedInvalid = raw.filter(
      (el) => !isValidSyncQueueItem(el) && !matchesQueueItemId(el, queueItemId)
    );
    const next = queue.filter((q) => q.queueItemId !== queueItemId);
    await writeJSON(STORAGE_KEYS.syncQueue, [...next, ...preservedInvalid]).catch(() => {});
    return next;
  });
}

/**
 * 失敗回数・エラー内容の記録も補助的データ（Category C）のため、保存失敗を伝播させない。
 * SEC-F002-001残存修正: removeFromQueueと同様、対象の特定をeventIdからqueueItemIdへ
 * 変更した。同じeventIdの新しい項目（別ユーザー・同一ユーザーの再編集のいずれも）へ
 * 古い送信の失敗理由を誤って付与しない。
 */
/**
 * DATA-F002-004: markQueueItemFailedは既存項目の一部フィールドを書き換えるだけ（要素の
 * 削除は起きない）ため、不正な形状の要素は無条件にそのまま保持すればよい。
 */
export function markQueueItemFailed(
  queueItemId: string,
  errorMessage: string
): Promise<SyncQueueItem[]> {
  return enqueueSyncQueueOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.syncQueue, "syncQueue");
    const queue = raw.filter(isValidSyncQueueItem);
    const preservedInvalid = raw.filter((el) => !isValidSyncQueueItem(el));
    const next = queue.map((q) =>
      q.queueItemId === queueItemId
        ? { ...q, attempts: q.attempts + 1, lastError: errorMessage }
        : q
    );
    await writeJSON(STORAGE_KEYS.syncQueue, [...next, ...preservedInvalid]).catch(() => {});
    return next;
  });
}

/**
 * ログアウト時などにキュー全体を意図的に空にする、明示的な全消去操作。
 * DATA-F002-004の対象外（「無関係な操作による意図しない喪失」ではなく、
 * このキー自体を丸ごと空にすることが目的の操作のため、不正要素の温存はしない）。
 *
 * REVISE対応（第6ラウンド、P1-2）: 以前は書込み失敗を`.catch(() => {})`で握りつぶし、
 * 呼び出し元（useSyncQueueProcessor.ts）は常に成功したものとしてReact stateを空にしていた。
 * 実際には前ユーザーの予定タイトル・メモを含む項目がStorageに残ったまま「消去済み」と
 * 表示される事故になり得るため、書込み失敗はそのまま呼び出し元へ伝播させる（呼び出し元が
 * 再試行を予約できるようにする）。
 */
export function clearSyncQueue(): Promise<void> {
  return enqueueSyncQueueOp(async () => {
    await writeJSON(STORAGE_KEYS.syncQueue, []);
  });
}

/**
 * REVISE対応（第6ラウンド、P1-2）: 現在のuserId/sessionInstanceId「以外」の項目（別ユーザー・
 * 同一ユーザーでも別セッションの残骸）と、queuedByUserId/queuedBySessionInstanceId/
 * queueItemIdのいずれかを欠く旧形式項目を、Storageから選択的に取り除く。clearSyncQueue()の
 * ような全消去とは異なり、呼び出し時点で既に現在identityの下に積まれている正当な未送信
 * 項目は保持したまま行える（ログイン中の起動時・identity変更確定直後のいずれから呼んでも、
 * 「今の自分の未送信分」を誤って消さない）。
 */
export function purgeStaleSyncQueueItems(
  currentUserId: string,
  currentSessionInstanceId: string
): Promise<SyncQueueItem[]> {
  return enqueueSyncQueueOp(async () => {
    const raw = await readRawArray(STORAGE_KEYS.syncQueue, "syncQueue");
    const next = raw.filter(
      (el): el is SyncQueueItem =>
        isValidSyncQueueItem(el) &&
        el.queuedByUserId === currentUserId &&
        el.queuedBySessionInstanceId === currentSessionInstanceId
    );
    await writeJSON(STORAGE_KEYS.syncQueue, next);
    return next;
  });
}
