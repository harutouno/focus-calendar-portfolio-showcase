import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { AppEvent } from "@/types/event";
import { SyncStatus } from "@/types/sharing";
import {
  EnqueueOutcome,
  SyncQueueItem,
  clearSyncQueue,
  enqueueDelete as enqueueDeleteToStorage,
  enqueueUpsert as enqueueUpsertToStorage,
  getSyncQueue,
  isFlushableSyncQueueItem,
  markQueueItemFailed,
  purgeStaleSyncQueueItems,
  removeFromQueue,
} from "@/storage/syncQueueRepository";
import { deleteSharedEvent, upsertSharedEvent } from "@/services/sharedEventsService";
import {
  cancelSharedEventNotification,
  scheduleSharedEventNotification,
} from "@/services/sharedNotificationCoordinator";
import { getCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";
import { SharedMutationIdentity } from "@/auth/sharedMutationIdentity";
import { captureSharedMutationAuthSnapshot } from "@/auth/sharedMutationAuthSnapshot";

/**
 * REVISE対応（第5ラウンド、P1-2）: enqueueUpsert/enqueueDeleteの結果。
 * "enqueued"は実際にAsyncStorageへ保存できたことを、"discarded-stale"は
 * 呼び出し時点で既にownerUserId/sessionInstanceIdが現在の認証identityと
 * 一致しなくなっていたため、保存自体を行わなかったことを表す
 * （保存していないのに「積んだ」と誤って報告しない）。
 * REVISE対応（第6ラウンド、P1-2）: 型定義自体はsyncQueueRepository.tsを正本とし、
 * ここではre-exportするだけにする（eventService.ts等の既存importパスを変えないため）。
 */
export type { EnqueueOutcome };

interface UseSyncQueueProcessorResult {
  syncStatusByEventId: Record<string, SyncStatus>;
  enqueueUpsert: (
    event: AppEvent,
    ownerUserId: string,
    sessionInstanceId: string
  ) => Promise<EnqueueOutcome>;
  enqueueDelete: (
    eventId: string,
    calendarId: string,
    ownerUserId: string,
    sessionInstanceId: string
  ) => Promise<EnqueueOutcome>;
  flush: () => Promise<void>;
  clear: () => Promise<void>;
  /**
   * REVISE対応（第6ラウンド、P1-2）: 現在のuserId/sessionInstanceId以外の項目（別ユーザー・
   * 別セッションの残骸・旧形式項目）だけを選択的に取り除く。ログイン中の起動時・
   * identity変更確定直後の両方から、現在identityの正当な未送信分を保持したまま呼べる。
   */
  purgeStale: (userId: string, sessionInstanceId: string) => Promise<void>;
}

/**
 * REVISE対応（P1-2）: 指定したuserId・sessionInstanceIdが、今この瞬間の認証identityと
 * 一致するかをauthSessionIdentityStore（Reactの外側で、AuthContextが認証イベントと
 * 同じ同期処理内に更新する権威あるソース）と比較して判定する。
 * REVISE対応（P0007 Batch2.1、P2-1/P2-2）: 以前はこのフック自身が持つuserIdRef/
 * sessionInstanceIdRef（Effectで1レンダー遅れて更新される）と併用していたが、
 * 「ユーザー切替がコミットされてからEffectが実行されるまでの間にNetInfo/AppStateの
 * イベントでflush()が発火する」という窓をrefでは防げないため、authSessionIdentityStore
 * を直接参照するこの関数だけが権威あるチェックとして残っている（flushの実行本体が
 * モジュールスコープへ移り、Hookインスタンスのrefに一切依存しなくなったことに伴い、
 * ref自体を廃止した）。
 */
function isStillCurrentIdentity(userId: string, sessionInstanceId: string): boolean {
  const identity = getCurrentAuthIdentity();
  return identity.userId === userId && identity.sessionInstanceId === sessionInstanceId;
}

/**
 * REVISE対応（P0007 Batch2.1、P2-1/P2-2）: flushの排他とpassの実行本体をJSモジュール
 * スコープ（このHookのインスタンスとは無関係、同一JSプロセス内で常に単一）へ切り出す。
 *
 * 背景（P2-2）: 以前は`useRef`によるHookインスタンス単位の排他だったため、
 * Providerのremount・StrictModeの二重マウント等で複数のHookインスタンスが存在すると、
 * それぞれが独立した「今flush中かどうか」を持ってしまい、同じqueue項目を並行して
 * 複数回remote送信しうる窓があった。同期キューの正本はAsyncStorage
 * （syncQueueRepository）であり、特定のHookインスタンスのclosureを正本にする必要は
 * 無いため、実行本体（runSyncQueueFlushPass）はHookのuserId/sessionInstanceIdの
 * refやclosureに依存せず、都度`getCurrentAuthIdentity()`から直接現在identityを
 * 解決する（既存のisStillCurrentIdentityと同じ、Reactのタイミングに一切依存しない
 * 権威あるソース）。
 *
 * 背景（P2-1）: 以前はflush実行中に新しいtrigger（NetInfo再接続・AppState復帰・
 * enqueue成功）が来ても、ロック中のため即座に無視していた。そのtriggerが発生した
 * 時点でenqueueされていた新規項目は、オンラインであっても次の外部triggerが来るまで
 * 送信されないまま滞留しうる。`syncQueueFlushRerunRequested`で「実行中に追加の
 * 要求が来たか」を記録し、現在のpassが完了した後、要求が残っていればロックを
 * 保持したまま続けてもう1pass実行する（要求は1個のbooleanへcoalesceされるため、
 * 実行中に何度triggerされても追加passは高々1回ずつしか積み上がらない＝無制限に
 * 連鎖しない）。`triggerSyncQueueFlush()`が返すPromiseは、この「追加passを含めた
 * 一連の実行」全体が終わるまで解決しないため、呼び出し元はこのPromiseをawaitする
 * だけで自分のtriggerが反映されるまで待てる。
 */
let syncQueueFlushRunPromise: Promise<void> | null = null;
let syncQueueFlushRerunRequested = false;
/** mount中の各Hookインスタンスが、flush完了時点の最新queueを受け取るための購読者集合。 */
const syncQueueFlushListeners = new Set<(queue: SyncQueueItem[]) => void>();

function notifySyncQueueFlushListeners(queue: SyncQueueItem[]): void {
  for (const listener of syncQueueFlushListeners) {
    try {
      listener(queue);
    } catch (e) {
      if (__DEV__) {
        console.warn("[useSyncQueueProcessor] flush結果通知リスナーで例外が発生しました", e);
      }
    }
  }
}

/**
 * 実際に1回分のネットワーク送信passを行う。呼び出し元（triggerSyncQueueFlush）が
 * single-flightを保証する前提のため、この関数自体は排他制御を持たない
 * （常に直列に1つずつ呼ばれる）。
 * SEC-F002-001: このpassを開始した時点の認証ユーザーIDを`flushUserId`として固定する。
 * ループの各反復では、この固定値と項目自身のqueuedByUserIdを照合する。
 * - queuedByUserIdがflushUserIdと一致しない項目（他ユーザーの項目・queueItemId/
 *   queuedByUserIdのいずれかが無い旧形式項目のいずれも）は送信せず、削除も
 *   再試行カウントもしない（次回以降のpassへそのまま持ち越す）。
 * [P0080 AUTH-F013-F017-001] 旧注記（技術的な限界）は解消済み: 以前は個々の
 * upsertSharedEvent/deleteSharedEvent呼び出しがsupabase-jsの単一グローバルクライアント
 * （src/lib/supabaseClient.ts）が保持する「その時点で有効なセッション」を使って
 * HTTPリクエストを送出していたため、送信開始直後〜実際のリクエスト発行までの間に
 * アカウントが切り替わると、そのHTTPリクエストが新しいユーザーのJWTを積んでしまう
 * request-level TOCTOUが原理的に存在した。今は各項目の送信直前
 * （captureSharedMutationAuthSnapshot）でその時点のowner本人のセッションから
 * access_tokenを捕捉し、requestScoped client（createPinnedSharedClient、SDKの
 * accessTokenオプション経由）でHTTPを送出するため、ambient sessionへは一切
 * フォールバックしない。捕捉自体がisStillCurrentIdentityと同じ権威あるチェックを
 * 内包しているため、捕捉時点でownerが既に現在identityでなくなっていれば
 * STALE_SHARED_MUTATION_IDENTITY_MESSAGEで例外化し、下のcatch節が
 * isStillCurrentIdentityで判定してmarkQueueItemFailedを行わない（次回passへ持ち越す）。
 *
 * SEC-F002-001残存修正: removeFromQueue/markQueueItemFailedの対象特定を、
 * item.eventId（この項目の送信中に同じeventIdへ新しい項目が積まれた場合、その新しい
 * 項目まで巻き込んで削除・更新してしまう）から、enqueueのたびに新しく発行される
 * item.queueItemId（この項目インスタンスだけを指す一意なID）へ変更した。これにより、
 * 「Aの送信await中にBがログインして同じeventIdをenqueueする」「Aの送信await中にAが
 * 同じ予定を再編集する」のいずれのケースでも、await完了後にこの項目だけを安全に
 * 除去・更新でき、新しく積まれた項目（別のqueueItemId）を誤って巻き込まない。
 *
 * REVISE対応（P1-2、再監査）: 各await境界でauthSessionIdentityStoreを直接参照する
 * isStillCurrentIdentity()により再確認する（Reactのタイミングに一切依存しない）。
 * またキュー項目自体もqueuedBySessionInstanceIdを持つため、「同じuserIdのまま
 * 別セッションで積まれた項目」を新しいセッションの操作として誤って送信しない
 * （旧セッションで失敗した項目は、そのセッションのuserId+sessionInstanceIdの組が
 * 二度と現在のflushUserId/flushSessionInstanceIdと一致しないため、以後のpassでも
 * 一貫して送信対象から除外され続ける＝安全に「隔離」される）。
 */
async function runSyncQueueFlushPass(): Promise<void> {
  const identity = getCurrentAuthIdentity();
  const flushUserId = identity.userId;
  // SEC-F007-001 Stage 2: 共有通知の予約/取消はsharedNotificationCoordinator経由で
  // ownerUserId+sessionInstanceIdの両方を要求するため、session_idが取得できていない
  // 間はpass自体を行わない。
  const flushSessionInstanceId = identity.sessionInstanceId;
  if (!flushUserId || !flushSessionInstanceId) return;
  const flushIdentity: SharedMutationIdentity = {
    userId: flushUserId,
    sessionInstanceId: flushSessionInstanceId,
  };

  const net = await NetInfo.fetch();
  if (!isStillCurrentIdentity(flushUserId, flushSessionInstanceId)) return;
  if (!net.isConnected) return;

  let current = await getSyncQueue();
  if (!isStillCurrentIdentity(flushUserId, flushSessionInstanceId)) return;
  for (const item of current) {
    // アカウント切替・セッション境界変更検知: pass開始時のuserId・sessionInstanceIdの
    // いずれかが現在の認証状態と異なる場合、このpassはここで打ち切る
    // （残りの項目は次回のpassに委ねる）。
    if (!isStillCurrentIdentity(flushUserId, flushSessionInstanceId)) break;

    // queueItemId/queuedByUserId/queuedBySessionInstanceIdのいずれかが無い旧形式項目は
    // 送信しない（所有者・セッション・識別子のいずれかを安全に確定できないため、
    // 既存方針どおり送信禁止を優先する）。
    if (!isFlushableSyncQueueItem(item)) continue;

    // 他ユーザーの項目、または同一ユーザーでも別セッションで積まれた項目は送信しない。
    if (item.queuedByUserId !== flushUserId) continue;
    if (item.queuedBySessionInstanceId !== flushSessionInstanceId) continue;

    const queueItemId = item.queueItemId;

    try {
      if (item.type === "upsert" && item.event) {
        // [P0080 AUTH-F013-F017-001] この項目の送信という論理的attemptごとにフレッシュな
        // auth snapshotを捕捉する（owner確認は捕捉自体の内部でも行われる。トークンは
        // このローカル変数以外のどこにも永続化しない）。
        const auth = await captureSharedMutationAuthSnapshot(flushIdentity);
        await upsertSharedEvent(item.event, auth);
        // REVISE対応（P1-2、再監査）: ネットワーク呼出しの完了を待つ間にidentityが
        // 変わっていた場合、以降のOS通知予約・キュー除去・失敗記録のいずれも行わない
        // （既にサーバーへ送信済みの操作自体を遡って取り消すことはできないが、
        // ローカル側の以降の副作用だけは切替後のユーザー・セッションへ波及させない）。
        if (!isStillCurrentIdentity(flushUserId, flushSessionInstanceId)) break;
        // 再送が成功した予定について、この端末のローカル通知を有効化する
        // （Stage H-6: オフラインキュー再送成功時の既知ギャップ解消。scheduleSharedEventNotification
        // 自体が例外を投げないため、通知の失敗で再送の成否判定には影響しない）。
        // SEC-F007-001 Stage 2: 共有予定の通知writerを一本化するため、notificationServiceを
        // 直接呼ばずsharedNotificationCoordinator経由にする（所有者切替後はisCurrent判定で
        // 自動的に無視される）。
        await scheduleSharedEventNotification(item.event, flushUserId, flushSessionInstanceId);
      } else if (item.type === "delete") {
        // [P0080 AUTH-F013-F017-001] 削除も同様にこの項目の送信という論理的attemptごとに
        // フレッシュなauth snapshotを捕捉する。
        const auth = await captureSharedMutationAuthSnapshot(flushIdentity);
        await deleteSharedEvent(item.eventId, auth);
        if (!isStillCurrentIdentity(flushUserId, flushSessionInstanceId)) break;
        // 削除の再送が成功した場合も、対象の通知が残らないようにする。
        await cancelSharedEventNotification(item.eventId, flushUserId, flushSessionInstanceId);
      }
      if (!isStillCurrentIdentity(flushUserId, flushSessionInstanceId)) break;
      // queueItemId単位で除去するため、送信中に同じeventIdへ新しく積まれた
      // 別の項目（別ユーザー・同一ユーザーの再編集のいずれも）を誤って削除しない。
      current = await removeFromQueue(queueItemId);
    } catch (e) {
      // アカウントが切り替わった後の失敗は、切替後のユーザーのエラーとして
      // 記録しない（別ユーザーのエラー表示・不要な再試行回数増加を防ぐ）。
      if (isStillCurrentIdentity(flushUserId, flushSessionInstanceId)) {
        current = await markQueueItemFailed(
          queueItemId,
          e instanceof Error ? e.message : "同期に失敗しました"
        );
      }
    }
  }
  // REVISE対応（第6ラウンド、P1-2）: ここまでの`current`は、このpass自身の
  // removeFromQueue/markQueueItemFailedの結果だけを反映したスナップショットであり、
  // pass実行中（各ネットワーク呼び出しをawaitしている間）に並行して積まれた
  // 新しいenqueueUpsert/enqueueDeleteの結果を反映していない場合がある。通知直前に
  // getSyncQueue()（syncQueueMutationChainへ合流済み）で改めて読み直すことで、
  // このpassが実際に完了した時点までにチェーンへ積まれた全ての変更（並行enqueueを含む）
  // を反映した状態を採用する（新規項目のpending表示が消えたまま古い状態で
  // 上書きされることを防ぐ）。
  notifySyncQueueFlushListeners(await getSyncQueue());
}

/**
 * flushの外部トリガー入口。single-flightを保証しつつ、実行中に届いた追加要求を
 * 取りこぼさない（P2-1）。
 * - 実行中でなければ即座に1passを開始する。ロックの成立（`syncQueueFlushRunPromise`
 *   への代入）はawaitを一切挟まない同期区間で完結するため、ほぼ同時に複数回
 *   呼ばれてもTOCTOU競合が生じない。
 * - 実行中であれば、今回の要求を記録するだけで新たなpassは開始しない
 *   （coalesce）。返すPromiseは、現在実行中のpass「とその後に続く再passすべて」が
 *   完了した時点で解決するため、呼び出し元はこのPromiseをawaitするだけで
 *   「自分の要求が反映されるまで」を待てる。
 * - passが完了した時点でまだ要求が残っていれば、ロックを保持したまま続けてもう1pass
 *   実行する。要求は1個のbooleanへcoalesceされるため、実行中に何度triggerされても
 *   追加で走るpassは高々1回ずつ（無制限に積み上がらない）。
 * - offline等でpassが即座に終わる場合も、要求が残っていない限りここで止まる
 *   （busy loopしない）。
 * - 例外・early returnのいずれで終わっても、finallyで必ずロックと保留要求の
 *   両方を解放する。
 *
 * REVISE対応（P0007 Batch2.2、P2-1）: 以前は`await runSyncQueueFlushPass()`が
 * 例外を投げると、直後の`while`ループへ一切入らずfinallyへ抜けていた。finallyは
 * `syncQueueFlushRerunRequested`を無条件にfalseへ戻すため、先行passが例外で終わる
 * 間際に届いていたrerun要求（NetInfo/Storage待機中に新規enqueueされた項目等）が、
 * 一度もpassされないまま消えてしまっていた。ここでは各passの例外を個別にcatchし、
 * 「rerun要求がある限り、直前のpassが成功・失敗のどちらであっても次passを実行する」
 * ようにする。最初に発生した例外だけを保持し、全てのrerunを処理し終えた後、
 * 保持していた例外があれば改めてrejectする（`flush()`が例外時にrejectする既存の契約は
 * 維持しつつ、rerun要求だけは例外の有無に関わらず必ず消化する）。
 */
function triggerSyncQueueFlush(): Promise<void> {
  if (syncQueueFlushRunPromise) {
    syncQueueFlushRerunRequested = true;
    return syncQueueFlushRunPromise;
  }
  syncQueueFlushRunPromise = (async () => {
    let hasError = false;
    let firstError: unknown;
    try {
      try {
        await runSyncQueueFlushPass();
      } catch (e) {
        hasError = true;
        firstError = e;
      }
      while (syncQueueFlushRerunRequested) {
        syncQueueFlushRerunRequested = false;
        try {
          await runSyncQueueFlushPass();
        } catch (e) {
          if (!hasError) {
            hasError = true;
            firstError = e;
          }
        }
      }
      if (hasError) throw firstError;
    } finally {
      syncQueueFlushRerunRequested = false;
      syncQueueFlushRunPromise = null;
    }
  })();
  return syncQueueFlushRunPromise;
}

/**
 * テスト専用: モジュールスコープのflushコーディネーター状態をリセットする。
 * jestは1テストファイルにつき1回しかこのモジュールを読み込まないため、
 * syncQueueFlushRunPromise・syncQueueFlushRerunRequested・購読者集合が
 * テストを跨いで残ってしまう。各テストのbeforeEachから呼ぶことを前提にする。
 */
export function __resetSyncQueueFlushCoordinatorForTests(): void {
  syncQueueFlushRunPromise = null;
  syncQueueFlushRerunRequested = false;
  syncQueueFlushListeners.clear();
}

/**
 * 共有カレンダーの予定を送信できなかった操作をAsyncStorageにキューし、
 * 再接続・アプリ復帰時に再送する。upsert/deleteはどちらもID主キー基準のため
 * 再送しても副作用がない（冪等）。
 */
export function useSyncQueueProcessor(
  userId: string | null,
  sessionInstanceId: string | null
): UseSyncQueueProcessorResult {
  const [queue, setQueue] = useState<SyncQueueItem[]>([]);
  /**
   * REVISE対応（第6ラウンド、P1-2）: clear()/purgeStale()のStorage書込みが失敗した場合、
   * その旨をここへ記録し、次回のAppState復帰時に同じ操作を再試行する
   * （clearSyncQueue()の書込み失敗をもう握りつぶさなくなったため、失敗を呼び出し元へ
   * 伝えるだけでなく、再試行の機会も保証する）。
   *
   * REVISE対応（第7ラウンド、P1-1）: "purge"型は、以前は失敗時点で捕捉したuserId/
   * sessionInstanceIdをそのまま保持し、再試行時もその値をそのまま使っていた。しかし
   * 「補償削除自体の失敗（stale-cleanup-pending）」を回収する再試行では、失敗した項目の
   * 所有者ではなく「今現在の（再試行時点の）現在identity」を正本として
   * purgeStaleSyncQueueItemsへ渡す必要がある（現在identity以外の項目を除去することが
   * この関数の目的であり、失敗時点でのidentityは既に古い可能性があるため）。
   * そのためuserId/sessionInstanceIdの捕捉を廃止し、再試行のたびに
   * getCurrentAuthIdentity()から新しく解決する（ログアウト状態ならclearSyncQueue()相当の
   * 全消去にフォールバックする）。
   */
  const pendingCleanupRef = useRef<{ type: "clear" } | { type: "purge" } | null>(null);

  useEffect(() => {
    // REVISE対応（P0007 Batch2.1、P2-2）: このHookインスタンスがmountしている間、
    // 他のインスタンス（あるいは自分自身）が起動したflush passの結果を受け取れるよう
    // 購読する。flushの実行本体はモジュールスコープの単一コーディネーターへ移した
    // ため、trigger元がどのインスタンスであってもこの購読でstateが更新される。
    syncQueueFlushListeners.add(setQueue);
    // DATA-F002-002: getSyncQueueは形状不正なトップレベルデータに対してthrowするように
    // なったため、未処理のPromise拒否を防ぐためだけに明示的にcatchする（開発時のみログ）。
    // 失敗時はキューを空のまま扱う（新規のenqueueUpsert/enqueueDeleteで上書きされるまでの
    // 一時的な状態であり、既存データを削除するわけではない）。
    getSyncQueue()
      .then(setQueue)
      .catch((e) => {
        if (__DEV__) {
          console.warn("[useSyncQueueProcessor] 同期キューの読み込みに失敗しました", e);
        }
      });
    return () => {
      syncQueueFlushListeners.delete(setQueue);
    };
  }, []);

  /**
   * REVISE対応（P0007 Batch2.1、P2-1/P2-2）: 実行本体・単一化・再passの取りこぼし防止は
   * すべてモジュールスコープのtriggerSyncQueueFlush/runSyncQueueFlushPassへ集約したため、
   * このHookが公開するflush()は単なる薄いラッパーになる。
   */
  const flush = useCallback(() => triggerSyncQueueFlush(), []);

  // flush()自体はqueueへの書き戻し（removeFromQueue/markQueueItemFailed、いずれも
  // 補助的データとしてベストエフォート化済み）でreject しない設計だが、念のため
  // 未処理のPromise拒否を防ぐためだけに明示的にcatchしておく（開発時のみログ）。
  const runFlush = useCallback(() => {
    triggerSyncQueueFlush().catch((e) => {
      if (__DEV__) {
        console.warn("[useSyncQueueProcessor] flush失敗", e);
      }
    });
  }, []);

  /**
   * REVISE対応（第6ラウンド、P1-2）: clear()/purgeStale()のStorage書込みが直前の試行で
   * 失敗していた場合、AppState復帰のタイミングに相乗りして同じ操作を再試行する
   * （flush()の既存の再試行トリガーと同じ考え方）。
   *
   * REVISE対応（第7ラウンド、P1-1）: "purge"の再試行では、失敗時点で捕捉した
   * userId/sessionInstanceIdではなく、再試行するこの瞬間のauthSessionIdentityStoreを
   * 「現在identityの正本」として都度読み直す。再試行までの間にさらに別のユーザーへ
   * 切り替わっていた場合でも、常に「今の現在identity」だけを保持し、それ以外
   * （補償削除に失敗して残った旧所有者の項目を含む）を除去できるようにするため。
   * 現在identityが存在しない（ログアウト状態が正本）場合は、選択的な除去ではなく
   * 全消去（clearSyncQueue）が正しい後始末となる。
   */
  const retryPendingCleanup = useCallback(() => {
    const pending = pendingCleanupRef.current;
    if (!pending) return;
    if (pending.type === "clear") {
      clearSyncQueue()
        .then(() => {
          pendingCleanupRef.current = null;
          setQueue([]);
        })
        .catch((e) => {
          if (__DEV__) {
            console.warn("[useSyncQueueProcessor] 同期キューの消去の再試行に失敗しました", e);
          }
        });
      return;
    }
    const identity = getCurrentAuthIdentity();
    if (identity.userId && identity.sessionInstanceId) {
      purgeStaleSyncQueueItems(identity.userId, identity.sessionInstanceId)
        .then((next) => {
          pendingCleanupRef.current = null;
          setQueue(next);
        })
        .catch((e) => {
          if (__DEV__) {
            console.warn("[useSyncQueueProcessor] 同期キューの選択的清掃の再試行に失敗しました", e);
          }
        });
    } else {
      clearSyncQueue()
        .then(() => {
          pendingCleanupRef.current = null;
          setQueue([]);
        })
        .catch((e) => {
          if (__DEV__) {
            console.warn(
              "[useSyncQueueProcessor] ログアウト状態での同期キュー全消去の再試行に失敗しました",
              e
            );
          }
        });
    }
  }, []);

  useEffect(() => {
    const sub = NetInfo.addEventListener((state) => {
      if (state.isConnected) runFlush();
    });
    const appStateSub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        runFlush();
        retryPendingCleanup();
      }
    });
    return () => {
      sub();
      appStateSub.remove();
    };
  }, [runFlush, retryPendingCleanup]);

  /**
   * REVISE対応（P1-2）: 以前はqueuedByUserIdを、このフック自身が保持する「今現在の」
   * userIdRefから取得していた。しかしenqueueUpsert/enqueueDeleteは、失敗した共有操作
   * （eventService.saveSharedEvent/removeSharedEvent等）のcatch節から、その操作を
   * 開始した時点よりも後（ネットワーク呼び出しが失敗するまで待った後）に呼ばれる。
   * その間にユーザーがA→Bへ切り替わっていた場合、「今現在のuserId」であるBを
   * queuedByUserIdとして記録してしまい、実際にはAの操作だったものがBの同期キューへ
   * 混入する（Bの端末上でAの編集内容が、Bのアカウントとして再送されうる）。
   *
   * 修正: queuedByUserIdは呼び出し元（AppDataContext）が、その共有操作を開始した
   * 時点で捕捉したownerUserId（sharedData.ownerUserId由来。認証ユーザー自身の入力では
   * なく、AuthContext→AppDataContextの信頼できる状態伝播経路から得た値）を明示的に
   * 渡す。これにより「操作開始時点の所有者」が最後まで一貫して使われる
   * （SEC-F002-001が防ぎたかった「呼び出し元の自由入力によるユーザーID偽装」とは異なり、
   * ここで渡されるownerUserIdは常にこの信頼できる経路からのみ生成される値のため、
   * 偽装耐性は損なわれない）。
   */
  /**
   * REVISE対応（第5ラウンド、P1-2）: enqueueUpsert/enqueueDeleteは、呼び出し元
   * （eventService.saveSharedEvent等）の実際のネットワーク失敗を待った"後"に呼ばれる
   * ため、呼び出しが開始された時点で、この操作を開始したユーザー（引数のownerUserId/
   * sessionInstanceId）が既に現在の認証identityと一致しなくなっている場合がある
   * （待機中にユーザーが切り替わった場合）。この状態でも保存自体はqueuedByUserId等が
   * 正しく元の所有者のまま記録されるため、別ユーザーへの誤帰属は起きない
   * （SEC-F002-001で対応済み）が、Storageへの書込み自体は行われてしまい、
   * 元の所有者に属する予定のタイトル・メモを含むAppEvent全体が、除去されるまで
   * この端末に残り続けてしまう。isStillCurrentIdentityで開始時点の所有者が
   * 引き続き現在のidentityと一致するかを確認し、既に一致しない場合は保存自体を
   * 行わない（Storageへ一切書き込まない）。
   */
  /**
   * REVISE対応（第6ラウンド、P1-2）: 呼び出し前チェックだけでは、
   * syncQueueMutationChain（enqueueUpsertToStorage/enqueueDeleteToStorageが実際に積まれる
   * 直列化キュー）で順番待ちしている間にidentityが変化する競合窓を防げない。この
   * isStillCurrent自体をStorage関数へ渡し、直列化されたop自身の内部（読込み後・書込み
   * 直前・書込み直後）で再確認させることで、待ち時間の長さに関わらず安全にする。
   */
  const enqueueUpsert = useCallback(
    async (event: AppEvent, ownerUserId: string, sessionInstanceId: string): Promise<EnqueueOutcome> => {
      if (!ownerUserId || !sessionInstanceId) {
        if (__DEV__) {
          console.warn(
            "[useSyncQueueProcessor] ownerUserIdまたはsessionInstanceIdが空のためenqueueUpsertを無視しました"
          );
        }
        return "discarded-stale";
      }
      if (!isStillCurrentIdentity(ownerUserId, sessionInstanceId)) {
        if (__DEV__) {
          console.warn(
            "[useSyncQueueProcessor] enqueueUpsert開始前にユーザー/セッションが切り替わったため保存をスキップしました"
          );
        }
        return "discarded-stale";
      }
      const { queue: next, outcome } = await enqueueUpsertToStorage(event, ownerUserId, sessionInstanceId, () =>
        isStillCurrentIdentity(ownerUserId, sessionInstanceId)
      );
      setQueue(next);
      if (outcome === "enqueued") runFlush();
      // REVISE対応（第7ラウンド、P1-1）: 補償削除自体が失敗した場合、今回enqueueした
      // 項目がStorageに残ったままになる。現在identityを正本とするpurgeを次回の
      // AppState「active」復帰時に再試行する（clear/purgeの既存の再試行機構に相乗りする）。
      if (outcome === "stale-cleanup-pending") {
        pendingCleanupRef.current = { type: "purge" };
        if (__DEV__) {
          console.warn(
            "[useSyncQueueProcessor] enqueueUpsertの補償削除に失敗しました。清掃を再試行対象へ登録します"
          );
        }
      }
      return outcome;
    },
    [runFlush]
  );

  const enqueueDelete = useCallback(
    async (
      eventId: string,
      calendarId: string,
      ownerUserId: string,
      sessionInstanceId: string
    ): Promise<EnqueueOutcome> => {
      if (!ownerUserId || !sessionInstanceId) {
        if (__DEV__) {
          console.warn(
            "[useSyncQueueProcessor] ownerUserIdまたはsessionInstanceIdが空のためenqueueDeleteを無視しました"
          );
        }
        return "discarded-stale";
      }
      if (!isStillCurrentIdentity(ownerUserId, sessionInstanceId)) {
        if (__DEV__) {
          console.warn(
            "[useSyncQueueProcessor] enqueueDelete開始前にユーザー/セッションが切り替わったため保存をスキップしました"
          );
        }
        return "discarded-stale";
      }
      const { queue: next, outcome } = await enqueueDeleteToStorage(
        eventId,
        calendarId,
        ownerUserId,
        sessionInstanceId,
        () => isStillCurrentIdentity(ownerUserId, sessionInstanceId)
      );
      setQueue(next);
      if (outcome === "enqueued") runFlush();
      // REVISE対応（第7ラウンド、P1-1）: enqueueUpsertと同じ理由で再試行を登録する。
      if (outcome === "stale-cleanup-pending") {
        pendingCleanupRef.current = { type: "purge" };
        if (__DEV__) {
          console.warn(
            "[useSyncQueueProcessor] enqueueDeleteの補償削除に失敗しました。清掃を再試行対象へ登録します"
          );
        }
      }
      return outcome;
    },
    [runFlush]
  );

  /**
   * REVISE対応（第6ラウンド、P1-2）: clearSyncQueue()（repository側）はもう書込み失敗を
   * 握りつぶさないため、ここでも成功を確認してからReact stateを空にする。失敗した場合は
   * queue stateを変更せず（＝UI上は消去済みに見えない）、pendingCleanupRefへ記録して
   * 次回のAppState復帰時に再試行する。
   */
  const clear = useCallback(async () => {
    try {
      await clearSyncQueue();
      pendingCleanupRef.current = null;
      setQueue([]);
    } catch (e) {
      pendingCleanupRef.current = { type: "clear" };
      if (__DEV__) {
        console.warn("[useSyncQueueProcessor] 同期キューの消去に失敗しました。再試行を予約します", e);
      }
    }
  }, []);

  /**
   * REVISE対応（第6ラウンド、P1-2）: 現在のuserId/sessionInstanceId以外の項目（別ユーザー・
   * 別セッションの残骸・旧形式項目）だけを選択的に取り除く。失敗時はclear()と同様に
   * pendingCleanupRefへ記録し、次回のAppState復帰時に再試行する（queue stateは変更しない）。
   */
  const purgeStale = useCallback(async (targetUserId: string, targetSessionInstanceId: string) => {
    try {
      const next = await purgeStaleSyncQueueItems(targetUserId, targetSessionInstanceId);
      pendingCleanupRef.current = null;
      setQueue(next);
    } catch (e) {
      // REVISE対応（第7ラウンド、P1-1）: 再試行時はtargetUserId/targetSessionInstanceId
      // （呼び出し時点のスナップショット）ではなく、再試行時点の現在identityを正本として
      // 再解決する（retryPendingCleanup参照）。
      pendingCleanupRef.current = { type: "purge" };
      if (__DEV__) {
        console.warn("[useSyncQueueProcessor] 同期キューの選択的清掃に失敗しました。再試行を予約します", e);
      }
    }
  }, []);

  /**
   * REVISE対応（第5ラウンド、P1-2）: 以前はowner/sessionを問わずqueue内の全項目から
   * eventIdだけでこのMapを組み立てていた。AとBが同じ共有カレンダーを閲覧している場合
   * （同じeventIdをAのremoteEventsにもBのremoteEventsにも持ちうる）、Aの送信失敗項目が
   * B切替後もキューに残っていると（クリアされるまでの間）、eventIdの一致だけを根拠に
   * Bの画面へAの同期状態（pending/error）がそのまま表示されてしまう。呼び出し元
   * （AppDataContext）が渡す現在のuserId/sessionInstanceIdと、各項目自身が持つ
   * queuedByUserId/queuedBySessionInstanceIdが完全一致する項目だけを対象にすることで、
   * 所有者・セッションを跨いだ同期状態の漏えいを構造的に防ぐ。
   */
  const syncStatusByEventId: Record<string, SyncStatus> = {};
  for (const item of queue) {
    if (item.queuedByUserId !== userId || item.queuedBySessionInstanceId !== sessionInstanceId) continue;
    syncStatusByEventId[item.eventId] = item.attempts > 0 ? "error" : "pending";
  }

  return { syncStatusByEventId, enqueueUpsert, enqueueDelete, flush, clear, purgeStale };
}
