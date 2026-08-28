import AsyncStorage from "@react-native-async-storage/async-storage";
import { NormalEvent } from "@/types/event";
import { STORAGE_KEYS } from "@/storage/keys";
import {
  clearSyncQueue,
  enqueueDelete as enqueueDeleteRaw,
  enqueueUpsert as enqueueUpsertRaw,
  getSyncQueue,
  isFlushableSyncQueueItem,
  markQueueItemFailed,
  purgeStaleSyncQueueItems,
  removeFromQueue,
  SyncQueueItem,
} from "@/storage/syncQueueRepository";

const ALWAYS_CURRENT = () => true;

/**
 * REVISE対応（第6ラウンド、P1-2）: enqueueUpsert/enqueueDeleteはisStillCurrent引数が
 * 必須になり、戻り値も`{queue, outcome}`へ変わった。既存テストの大半は「常にidentityが
 * 現在のまま」という前提でqueue配列だけを見ているため、その前提を明示するラッパーを
 * 用意し、既存テスト本体（アサーション）は変更しない。isStillCurrent自体の挙動・
 * discarded-stale/補償削除は専用のdescribeブロックでenqueueUpsertRaw/enqueueDeleteRawを
 * 直接使って検証する。
 */
async function enqueueUpsert(
  event: NormalEvent,
  queuedByUserId: string,
  queuedBySessionInstanceId: string
): Promise<SyncQueueItem[]> {
  const { queue } = await enqueueUpsertRaw(event, queuedByUserId, queuedBySessionInstanceId, ALWAYS_CURRENT);
  return queue;
}

async function enqueueDelete(
  eventId: string,
  calendarId: string,
  queuedByUserId: string,
  queuedBySessionInstanceId: string
): Promise<SyncQueueItem[]> {
  const { queue } = await enqueueDeleteRaw(
    eventId,
    calendarId,
    queuedByUserId,
    queuedBySessionInstanceId,
    ALWAYS_CURRENT
  );
  return queue;
}

function buildEvent(id: string, title = "共有予定"): NormalEvent {
  const now = new Date().toISOString();
  return {
    id,
    kind: "normal",
    title,
    date: "2026-07-22",
    startTime: "10:00",
    endTime: "11:00",
    allDay: false,
    calendarId: "cal-1",
    shareWith: [],
    notification: { enabled: true, minutesBefore: 10 },
    repeat: { type: "none" },
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
}

describe("syncQueueRepository", () => {
  beforeEach(async () => {
    await clearSyncQueue();
  });

  it("同じeventIdを再度enqueueすると上書きされる（重複しない）", async () => {
    await enqueueUpsert(buildEvent("evt-1", "元のタイトル"), "user-a", "session-a");
    await enqueueUpsert(buildEvent("evt-1", "更新後のタイトル"), "user-a", "session-a");

    const queue = await getSyncQueue();
    const matches = queue.filter((q) => q.eventId === "evt-1");
    expect(matches).toHaveLength(1);
    expect(matches[0].event?.title).toBe("更新後のタイトル");
  });

  it("upsert済みの項目をenqueueDeleteすると削除操作に置き換わる", async () => {
    await enqueueUpsert(buildEvent("evt-2"), "user-a", "session-a");
    await enqueueDelete("evt-2", "cal-1", "user-a", "session-a");

    const queue = await getSyncQueue();
    const matches = queue.filter((q) => q.eventId === "evt-2");
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("delete");
  });

  it("removeFromQueueで指定したqueueItemIdの項目だけがキューから消える", async () => {
    const [item3] = await enqueueUpsert(buildEvent("evt-3"), "user-a", "session-a");
    await enqueueUpsert(buildEvent("evt-4"), "user-a", "session-a");
    await removeFromQueue(item3.queueItemId as string);

    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId).sort()).toEqual(["evt-4"]);
  });

  it("markQueueItemFailedで指定したqueueItemIdの項目だけに試行回数とエラー内容が記録される", async () => {
    const queueAfterEnqueue = await enqueueUpsert(buildEvent("evt-5"), "user-a", "session-a");
    const queueItemId = queueAfterEnqueue.find((q) => q.eventId === "evt-5")?.queueItemId as string;
    await markQueueItemFailed(queueItemId, "ネットワークエラー");

    const queue = await getSyncQueue();
    const item = queue.find((q) => q.eventId === "evt-5");
    expect(item?.attempts).toBe(1);
    expect(item?.lastError).toBe("ネットワークエラー");
  });

  it("SEC-F002-001: enqueueUpsert/enqueueDeleteはqueuedByUserIdをそのまま保存する", async () => {
    await enqueueUpsert(buildEvent("evt-owner-upsert"), "user-a", "session-a");
    await enqueueDelete("evt-owner-delete", "cal-1", "user-b", "session-b");
    const queue = await getSyncQueue();
    expect(queue.find((q) => q.eventId === "evt-owner-upsert")?.queuedByUserId).toBe("user-a");
    expect(queue.find((q) => q.eventId === "evt-owner-delete")?.queuedByUserId).toBe("user-b");
  });

  it("REVISE対応（P1-2）: enqueueUpsert/enqueueDeleteはqueuedBySessionInstanceIdをそのまま保存する", async () => {
    await enqueueUpsert(buildEvent("evt-session-upsert"), "user-a", "session-1");
    await enqueueDelete("evt-session-delete", "cal-1", "user-a", "session-2");
    const queue = await getSyncQueue();
    expect(queue.find((q) => q.eventId === "evt-session-upsert")?.queuedBySessionInstanceId).toBe(
      "session-1"
    );
    expect(queue.find((q) => q.eventId === "evt-session-delete")?.queuedBySessionInstanceId).toBe(
      "session-2"
    );
  });
});

describe("SEC-F002-001残存修正: queueItemIdによる項目単位の識別・削除・更新", () => {
  beforeEach(async () => {
    await clearSyncQueue();
  });

  it("1. 新規enqueueのたびに一意なqueueItemIdが付与される", async () => {
    const q1 = await enqueueUpsert(buildEvent("evt-id-1"), "user-a", "session-a");
    const q2 = await enqueueUpsert(buildEvent("evt-id-2"), "user-a", "session-a");
    const id1 = q1.find((q) => q.eventId === "evt-id-1")?.queueItemId;
    const id2 = q2.find((q) => q.eventId === "evt-id-2")?.queueItemId;
    expect(id1).toEqual(expect.any(String));
    expect(id2).toEqual(expect.any(String));
    expect(id1).not.toBe(id2);
  });

  it("2. 同じeventIdを同じユーザーが再度enqueueすると新しいqueueItemIdになる", async () => {
    const first = await enqueueUpsert(buildEvent("evt-re", "v1"), "user-a", "session-a");
    const firstId = first.find((q) => q.eventId === "evt-re")?.queueItemId;
    const second = await enqueueUpsert(buildEvent("evt-re", "v2"), "user-a", "session-a");
    const secondId = second.find((q) => q.eventId === "evt-re")?.queueItemId;
    expect(second.filter((q) => q.eventId === "evt-re")).toHaveLength(1);
    expect(secondId).not.toBe(firstId);
  });

  it("2b. REVISE対応（第3ラウンド、P1-5、必須テスト4）: 同じユーザーが別セッションで同じeventIdをenqueueしても圧縮されず、両セッションの項目が別々に残る", async () => {
    // 第2ラウンド時点では、圧縮の単位がeventId＋queuedByUserIdのみだったため、
    // 「同じuserIdのまま別セッションで積んだ項目」も同一キーとみなして圧縮していた
    // （このテストは元々その挙動——最新セッションの項目だけが残る——を検証していた）。
    // しかし第3ラウンドの再監査で、旧セッションで積まれた未送信項目を新セッションの
    // 操作として黙って圧縮・混同すべきではないと指摘されたため、圧縮の単位へ
    // queuedBySessionInstanceIdを加えた。以降は同一userIdでもセッションが異なれば
    // 別項目として扱う（両方とも残り、どちらを実際に送信するかはuseSyncQueueProcessor.ts側の
    // セッション一致判定に委ねる）。
    const first = await enqueueUpsert(buildEvent("evt-re-session", "旧セッション版"), "user-a", "session-1");
    const firstId = first.find((q) => q.eventId === "evt-re-session")?.queueItemId;
    const second = await enqueueUpsert(buildEvent("evt-re-session", "新セッション版"), "user-a", "session-2");
    const matches = second.filter((q) => q.eventId === "evt-re-session");
    expect(matches).toHaveLength(2);
    expect(matches.map((q) => q.queuedBySessionInstanceId).sort()).toEqual(["session-1", "session-2"]);
    expect(matches.find((q) => q.queueItemId === firstId)?.event?.title).toBe("旧セッション版");
    expect(matches.find((q) => q.queuedBySessionInstanceId === "session-2")?.event?.title).toBe(
      "新セッション版"
    );
  });

  it("3. 異なるユーザーが同じeventIdをenqueueしても圧縮されず、両方が別項目として残る（シナリオA準備）", async () => {
    await enqueueUpsert(buildEvent("evt-cross", "Aの版"), "user-a", "session-a");
    const afterB = await enqueueUpsert(buildEvent("evt-cross", "Bの版"), "user-b", "session-b");
    const matches = afterB.filter((q) => q.eventId === "evt-cross");
    expect(matches).toHaveLength(2);
    expect(matches.map((q) => q.queuedByUserId).sort()).toEqual(["user-a", "user-b"]);
    expect(matches[0].queueItemId).not.toBe(matches[1].queueItemId);
  });

  it("4. removeFromQueueは同じeventIdを持つ別項目（別ユーザー）を削除しない", async () => {
    const afterA = await enqueueUpsert(buildEvent("evt-cross-2"), "user-a", "session-a");
    const afterB = await enqueueUpsert(buildEvent("evt-cross-2"), "user-b", "session-b");
    const aItem = afterA.find((q) => q.eventId === "evt-cross-2" && q.queuedByUserId === "user-a");
    const bItemId = afterB.find((q) => q.eventId === "evt-cross-2" && q.queuedByUserId === "user-b")?.queueItemId;

    await removeFromQueue(aItem?.queueItemId as string);

    const queue = await getSyncQueue();
    expect(queue.map((q) => q.queueItemId)).toEqual([bItemId]);
    expect(queue[0].queuedByUserId).toBe("user-b");
  });

  it("5. removeFromQueueは同じeventIdを持つ別項目（同一ユーザーの再編集後）を削除しない（シナリオB準備）", async () => {
    const first = await enqueueUpsert(buildEvent("evt-reedit", "旧版"), "user-a", "session-a");
    const oldQueueItemId = first.find((q) => q.eventId === "evt-reedit")?.queueItemId as string;
    const second = await enqueueUpsert(buildEvent("evt-reedit", "新版"), "user-a", "session-a");
    const newQueueItemId = second.find((q) => q.eventId === "evt-reedit")?.queueItemId as string;

    // 古いqueueItemIdは既にenqueueUpsertの圧縮で消えているため、
    // removeFromQueueは何にも一致せず安全な冪等処理になる。
    await removeFromQueue(oldQueueItemId);

    const queue = await getSyncQueue();
    expect(queue.map((q) => q.queueItemId)).toEqual([newQueueItemId]);
    expect(queue[0].event?.title).toBe("新版");
  });

  it("6. markQueueItemFailedは対象外のqueueItemIdには一致せず、既存項目に影響しない", async () => {
    const queue = await enqueueUpsert(buildEvent("evt-mark"), "user-a", "session-a");
    const realId = queue.find((q) => q.eventId === "evt-mark")?.queueItemId as string;
    const result = await markQueueItemFailed("does-not-exist", "エラー");
    const item = result.find((q) => q.eventId === "evt-mark");
    expect(item?.queueItemId).toBe(realId);
    expect(item?.attempts).toBe(0);
  });

  it("7. isFlushableSyncQueueItemはqueueItemId・queuedByUserId・queuedBySessionInstanceIdの全てが揃っている項目だけをtrueにする", () => {
    const base = {
      eventId: "e",
      calendarId: "c",
      type: "delete" as const,
      queuedAt: new Date().toISOString(),
      attempts: 0,
    };
    expect(
      isFlushableSyncQueueItem({
        ...base,
        queueItemId: "q1",
        queuedByUserId: "user-a",
        queuedBySessionInstanceId: "session-a",
      })
    ).toBe(true);
    expect(
      isFlushableSyncQueueItem({ ...base, queueItemId: "q1", queuedByUserId: "user-a" })
    ).toBe(false);
    expect(
      isFlushableSyncQueueItem({
        ...base,
        queuedByUserId: "user-a",
        queuedBySessionInstanceId: "session-a",
      })
    ).toBe(false);
    expect(
      isFlushableSyncQueueItem({ ...base, queueItemId: "q1", queuedBySessionInstanceId: "session-a" })
    ).toBe(false);
    expect(isFlushableSyncQueueItem({ ...base })).toBe(false);
  });

  it("8. queueItemIdが空文字列の要素は形状検証で除外される", async () => {
    const ok = {
      eventId: "evt-qid-keep",
      calendarId: "cal-1",
      type: "delete",
      queuedAt: new Date().toISOString(),
      attempts: 0,
      queuedByUserId: "user-a",
      queuedBySessionInstanceId: "session-a",
      queueItemId: "q1",
    };
    const broken = {
      eventId: "evt-qid-broken",
      calendarId: "cal-1",
      type: "delete",
      queuedAt: new Date().toISOString(),
      attempts: 0,
      queuedByUserId: "user-a",
      queuedBySessionInstanceId: "session-a",
      queueItemId: "",
    };
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([ok, broken]));
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["evt-qid-keep"]);
  });

  it("9. REVISE対応（P1-2）: queuedBySessionInstanceIdが無い旧形式項目は、除外されず引き続き有効として保持されるがisFlushableSyncQueueItemはfalseになる", async () => {
    const legacy = {
      eventId: "evt-legacy-session",
      calendarId: "cal-1",
      type: "delete",
      queuedAt: new Date().toISOString(),
      attempts: 0,
      queuedByUserId: "user-a",
      queueItemId: "q-legacy",
    };
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([legacy]));
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["evt-legacy-session"]);
    expect(queue[0].queuedBySessionInstanceId).toBeUndefined();
    expect(isFlushableSyncQueueItem(queue[0])).toBe(false);
  });

  it("10. queuedBySessionInstanceIdが空文字列の要素は除外される", async () => {
    const ok = {
      eventId: "evt-session-keep",
      calendarId: "cal-1",
      type: "delete",
      queuedAt: new Date().toISOString(),
      attempts: 0,
      queuedByUserId: "user-a",
      queuedBySessionInstanceId: "session-a",
    };
    const broken = {
      eventId: "evt-session-broken",
      calendarId: "cal-1",
      type: "delete",
      queuedAt: new Date().toISOString(),
      attempts: 0,
      queuedByUserId: "user-a",
      queuedBySessionInstanceId: "",
    };
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([ok, broken]));
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["evt-session-keep"]);
  });
});

describe("DATA-F002-001: syncQueueRepositoryのCategory A/Cの保存失敗ハンドリング", () => {
  it("enqueueUpsertはCategory A（再送キューへの登録そのもの）のため、書き込み失敗時にthrowする", async () => {
    jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("disk full"));
    await expect(enqueueUpsert(buildEvent("evt-fail"), "user-a", "session-a")).rejects.toThrow();
  });

  it("enqueueDeleteはCategory A（再送キューへの登録そのもの）のため、書き込み失敗時にthrowする", async () => {
    jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("disk full"));
    await expect(enqueueDelete("evt-fail", "cal-1", "user-a", "session-a")).rejects.toThrow();
  });

  it("removeFromQueueはCategory C（次回flush()の冪等な再送に任せられる）のため、書き込み失敗してもthrowしない", async () => {
    const queue = await enqueueUpsert(buildEvent("evt-6"), "user-a", "session-a");
    const queueItemId = queue.find((q) => q.eventId === "evt-6")?.queueItemId as string;
    jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("disk full"));
    await expect(removeFromQueue(queueItemId)).resolves.toBeDefined();
  });

  it("markQueueItemFailedはCategory C（補助的な記録）のため、書き込み失敗してもthrowしない", async () => {
    const queue = await enqueueUpsert(buildEvent("evt-7"), "user-a", "session-a");
    const queueItemId = queue.find((q) => q.eventId === "evt-7")?.queueItemId as string;
    jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("disk full"));
    await expect(markQueueItemFailed(queueItemId, "エラー")).resolves.toBeDefined();
  });

  /**
   * REVISE対応（第6ラウンド、P1-2）: 以前はclearSyncQueueもCategory C（補助的な記録）
   * として書き込み失敗を握りつぶしていた。しかし実際には、ログアウト時にこの消去が
   * 静かに失敗すると、前ユーザーの予定タイトル・メモを含む項目がStorageに残ったまま
   * 「消去済み」と扱われてしまう（呼び出し元のuseSyncQueueProcessor.tsが無条件に
   * React stateを空にしていた）。この関数は「意図的にキュー全体を空にする」操作の
   * 成否そのものがプライバシー上重要なため、Category Aと同様に書き込み失敗を
   * 呼び出し元へ伝播させるよう変更した（このテストのアサーションを反転する）。
   */
  it("REVISE対応（第6ラウンド、P1-2）: clearSyncQueueは書き込み失敗時にthrowする（以前はCategory Cとして握りつぶしていた挙動を反転）", async () => {
    jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("disk full"));
    await expect(clearSyncQueue()).rejects.toThrow();
  });
});

/**
 * REVISE対応（第3ラウンド、P1-5）: enqueueUpsert・enqueueDelete・removeFromQueue・
 * markQueueItemFailed・clearSyncQueueは、以前はそれぞれ独立にread-modify-writeを行っており、
 * 2つの操作がawaitを挟まず（ほぼ同時に）発火すると、後勝ちのwriteJSONが先の操作の変更を
 * 丸ごと上書きしてしまうlost updateがあった。syncQueueRepository.tsに追加した単一の
 * Promiseチェーン（enqueueSyncQueueOp）による直列化を、実際に「awaitを挟まず複数の操作を
 * 発火してからまとめてawaitする」形で検証する（直列化が無ければStorageのモック実装上、
 * 後続の書き込みが先行の書き込みを踏み潰す形で失敗するテストになる）。
 */
describe("REVISE対応（第3ラウンド、P1-5）: 変更操作の直列化（並行安全性）", () => {
  beforeEach(async () => {
    await clearSyncQueue();
  });

  it("必須テスト1: 並行するremoveFromQueueとenqueueUpsertで、新しく積んだ項目を失わない", async () => {
    const seeded = await enqueueUpsert(buildEvent("evt-concurrent-a"), "user-a", "session-a");
    const idA = seeded.find((q) => q.eventId === "evt-concurrent-a")?.queueItemId as string;

    // awaitを挟まず、削除と新規enqueueをほぼ同時に発火する。
    const removePromise = removeFromQueue(idA);
    const enqueuePromise = enqueueUpsert(buildEvent("evt-concurrent-b"), "user-a", "session-a");
    await Promise.all([removePromise, enqueuePromise]);

    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["evt-concurrent-b"]);
  });

  it("必須テスト2: 並行する2件のenqueueUpsertが、どちらも失われず両方永続化される", async () => {
    const p1 = enqueueUpsert(buildEvent("evt-concurrent-c"), "user-a", "session-a");
    const p2 = enqueueUpsert(buildEvent("evt-concurrent-d"), "user-a", "session-a");
    await Promise.all([p1, p2]);

    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId).sort()).toEqual(["evt-concurrent-c", "evt-concurrent-d"]);
  });

  it("必須テスト3: 並行するmarkQueueItemFailedとenqueueUpsertで、無関係な項目を失わない", async () => {
    const seeded = await enqueueUpsert(buildEvent("evt-concurrent-e"), "user-a", "session-a");
    const idE = seeded.find((q) => q.eventId === "evt-concurrent-e")?.queueItemId as string;

    const failPromise = markQueueItemFailed(idE, "network error");
    const enqueuePromise = enqueueUpsert(buildEvent("evt-concurrent-f"), "user-a", "session-a");
    await Promise.all([failPromise, enqueuePromise]);

    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId).sort()).toEqual(["evt-concurrent-e", "evt-concurrent-f"]);
    const itemE = queue.find((q) => q.eventId === "evt-concurrent-e");
    expect(itemE?.attempts).toBe(1);
    expect(itemE?.lastError).toBe("network error");
  });

  it("必須テスト5: 失敗した変更操作が後続の操作をブロックしない", async () => {
    jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("disk full"));
    await expect(
      enqueueUpsert(buildEvent("evt-concurrent-g-fail"), "user-a", "session-a")
    ).rejects.toThrow();

    // 直前の操作が失敗（例外）していても、直列化チェーン自体は途切れず、
    // 後続の正常な操作は問題なく完了する。
    await enqueueUpsert(buildEvent("evt-concurrent-h"), "user-a", "session-a");

    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["evt-concurrent-h"]);
  });
});

describe("syncQueueRepository（DATA-F002-002: 実行時の形状検証）", () => {
  beforeEach(async () => {
    await clearSyncQueue();
  });

  it("トップレベルが配列でない場合はthrowする", async () => {
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify({ not: "array" }));
    await expect(getSyncQueue()).rejects.toThrow();
  });

  it("不正なtype値を持つ要素は除外され、正常な要素は保持される", async () => {
    await enqueueUpsert(buildEvent("evt-keep"), "user-a", "session-a");
    const queueBefore = await getSyncQueue();
    const broken = { eventId: "evt-broken", calendarId: "cal-1", type: "invalid_type", queuedAt: new Date().toISOString(), attempts: 0 };
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([...queueBefore, broken]));
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["evt-keep"]);
  });

  it("type=upsertなのにeventフィールドが無い要素は除外される", async () => {
    const broken = { eventId: "evt-no-event", calendarId: "cal-1", type: "upsert", queuedAt: new Date().toISOString(), attempts: 0 };
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([broken]));
    const queue = await getSyncQueue();
    expect(queue).toEqual([]);
  });

  it("DATA-F002-002追記: 14. queuedAtが不正な日時の要素は除外される", async () => {
    const ok = { eventId: "evt-date-keep", calendarId: "cal-1", type: "delete", queuedAt: new Date().toISOString(), attempts: 0 };
    const broken = { eventId: "evt-date-broken", calendarId: "cal-1", type: "delete", queuedAt: "not-a-date", attempts: 0 };
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([ok, broken]));
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["evt-date-keep"]);
  });

  it("SEC-F002-001: queuedByUserIdが存在しない旧形式の要素は、除外されず引き続き有効として保持される", async () => {
    const legacy = { eventId: "evt-legacy", calendarId: "cal-1", type: "delete", queuedAt: new Date().toISOString(), attempts: 0 };
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([legacy]));
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["evt-legacy"]);
    expect(queue[0].queuedByUserId).toBeUndefined();
  });

  it("SEC-F002-001: queuedByUserIdが空文字列の要素は除外される", async () => {
    const ok = { eventId: "evt-owner-keep", calendarId: "cal-1", type: "delete", queuedAt: new Date().toISOString(), attempts: 0, queuedByUserId: "user-a" };
    const broken = { eventId: "evt-owner-broken", calendarId: "cal-1", type: "delete", queuedAt: new Date().toISOString(), attempts: 0, queuedByUserId: "" };
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([ok, broken]));
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["evt-owner-keep"]);
  });
});

describe("syncQueueRepository（DATA-F002-004: read-modify-writeによる無関係データの永久喪失防止）", () => {
  beforeEach(async () => {
    await clearSyncQueue();
  });

  async function rawStoredQueue(): Promise<unknown[]> {
    const stored = await AsyncStorage.getItem(STORAGE_KEYS.syncQueue);
    return JSON.parse(stored as string);
  }

  it("enqueueUpsert/enqueueDeleteは、無関係な不正な形状のキュー項目をStorageに残す", async () => {
    const broken = { eventId: "rmw-sq-broken" }; // calendarId等が欠落した壊れた項目
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([broken]));

    await enqueueUpsert(buildEvent("rmw-sq-1"), "user-a", "session-a");
    let raw = await rawStoredQueue();
    expect(raw).toContainEqual(broken);

    await enqueueDelete("rmw-sq-2", "cal-1", "user-a", "session-a");
    raw = await rawStoredQueue();
    expect(raw).toContainEqual(broken);
  });

  it("removeFromQueue/markQueueItemFailedは、queueItemId単位の対象特定を維持したまま、無関係な不正項目をStorageに残す", async () => {
    const broken = { eventId: "rmw-sq-broken-2" };
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([broken]));
    const queue = await enqueueUpsert(buildEvent("rmw-sq-3"), "user-a", "session-a");
    const queueItemId = queue[0].queueItemId as string;

    await markQueueItemFailed(queueItemId, "network error");
    let raw = await rawStoredQueue();
    expect(raw).toContainEqual(broken);
    const afterFail = await getSyncQueue();
    expect(afterFail[0].attempts).toBe(1);
    expect(afterFail[0].queueItemId).toBe(queueItemId); // queueItemId単位の対象特定に回帰なし

    await removeFromQueue(queueItemId);
    raw = await rawStoredQueue();
    expect(raw).toContainEqual(broken);
    expect(await getSyncQueue()).toEqual([]);
  });

  it("不正項目と同じeventId・queuedByUserId・queuedBySessionInstanceIdの組でenqueueすると、その不正項目だけが対象になり置き換わる（無関係な不正項目は保持）", async () => {
    // REVISE対応（第3ラウンド、P1-5）: 圧縮の単位にqueuedBySessionInstanceIdが加わったため、
    // 「同じキー」とみなされるにはこのフィールドも一致している必要がある。
    const brokenSameKey = {
      eventId: "rmw-sq-same",
      queuedByUserId: "user-a",
      queuedBySessionInstanceId: "session-a",
    }; // calendarId等が欠落
    const unrelatedBroken = { eventId: "rmw-sq-other" };
    await AsyncStorage.setItem(
      STORAGE_KEYS.syncQueue,
      JSON.stringify([brokenSameKey, unrelatedBroken])
    );

    await enqueueUpsert(buildEvent("rmw-sq-same"), "user-a", "session-a");

    const raw = await rawStoredQueue();
    expect(raw).not.toContainEqual(brokenSameKey);
    expect(raw).toContainEqual(unrelatedBroken);
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["rmw-sq-same"]);
  });

  it("トップレベルが配列でない場合、キュー操作はStorageを上書きせずthrowする", async () => {
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify({ not: "array" }));

    await expect(enqueueUpsert(buildEvent("rmw-sq-toplevel"), "user-a", "session-a")).rejects.toThrow();
    await expect(enqueueDelete("rmw-sq-toplevel", "cal-1", "user-a", "session-a")).rejects.toThrow();
    await expect(removeFromQueue("some-queue-item-id")).rejects.toThrow();
    await expect(markQueueItemFailed("some-queue-item-id", "error")).rejects.toThrow();

    const stored = await AsyncStorage.getItem(STORAGE_KEYS.syncQueue);
    expect(JSON.parse(stored as string)).toEqual({ not: "array" });
  });
});

/**
 * REVISE対応（第6ラウンド、P1-2）: enqueueUpsert/enqueueDeleteのisStillCurrent引数・
 * purgeStaleSyncQueueItemsの検証。isStillCurrentはop本体の内部（syncQueueMutationChain上で
 * 実際に実行が始まった後）でのみ評価される設計のため、「呼び出し前チェックは通ったが、
 * 直列化チェーン内で自分の番が回ってくる前にA→Bとなった」状況は、isStillCurrentの
 * 戻り値をop実行中に切り替える（または最初から一貫してfalseにする）ことで直接検証できる
 * ——実際にチェーンを人為的にブロックする補助関数は不要（isStillCurrentが呼ばれる
 * タイミングそのものが「チェーン内で自分の番が回ってきた後」であるため）。
 */
describe("REVISE対応（第6ラウンド、P1-2）: enqueueの直列化チェーン内でのidentity再確認・purgeStaleSyncQueueItems", () => {
  beforeEach(async () => {
    await clearSyncQueue();
  });

  it("必須テスト1: enqueueがmutation chain待機中にA→Bとなった場合、Aの項目を保存しない", async () => {
    // op本体の最初のisStillCurrent確認（＝チェーン内で自分の番が回ってきた直後）が
    // 既にfalseを返す＝「順番待ちの間にA→Bとなった」状況そのもの。Storageに一切触れず
    // discarded-staleを返すべき。
    const isStillCurrent = () => false;

    const result = await enqueueUpsertRaw(buildEvent("evt-race-a"), "user-a", "session-a", isStillCurrent);

    expect(result.outcome).toBe("discarded-stale");
    expect(result.queue.some((q) => q.eventId === "evt-race-a")).toBe(false);
    const stored = await getSyncQueue();
    expect(stored.some((q) => q.eventId === "evt-race-a")).toBe(false);
  });

  it("必須テスト2: Storage書込み中にA→Bとなった場合、今回の項目を補償削除する", async () => {
    // isStillCurrentは、書込み前の2回の確認（op開始直後・読込み直後）ではtrueを、
    // 書込み完了直後の確認ではfalseを返すよう、呼び出し回数で切り替える。
    let callCount = 0;
    const isStillCurrent = () => {
      callCount += 1;
      return callCount <= 2;
    };

    const result = await enqueueUpsertRaw(buildEvent("evt-race-b"), "user-a", "session-a", isStillCurrent);

    expect(result.outcome).toBe("discarded-stale");
    expect(result.queue.some((q) => q.eventId === "evt-race-b")).toBe(false);
    // 補償削除がStorageへも反映されていることを確認する（書込み自体は一度成功したはず）。
    const stored = await getSyncQueue();
    expect(stored.some((q) => q.eventId === "evt-race-b")).toBe(false);
  });

  it("必須テスト4・5: purgeStaleSyncQueueItemsは現在identity以外・旧形式項目を除去し、現在identity自身の正当な項目は維持する", async () => {
    await enqueueUpsert(buildEvent("evt-purge-a-item"), "user-a", "session-old"); // 前ユーザーAの残骸
    await enqueueUpsert(buildEvent("evt-purge-b-item"), "user-b", "session-b"); // 現在identity（B）自身の正当な項目
    const legacy = {
      eventId: "evt-purge-legacy",
      calendarId: "cal-1",
      type: "delete",
      queuedAt: new Date().toISOString(),
      attempts: 0,
    };
    const raw = JSON.parse((await AsyncStorage.getItem(STORAGE_KEYS.syncQueue)) as string);
    await AsyncStorage.setItem(STORAGE_KEYS.syncQueue, JSON.stringify([...raw, legacy]));

    const result = await purgeStaleSyncQueueItems("user-b", "session-b");

    expect(result.map((q) => q.eventId)).toEqual(["evt-purge-b-item"]);
    const stored = await getSyncQueue();
    expect(stored.map((q) => q.eventId)).toEqual(["evt-purge-b-item"]);
  });

  it("必須テスト7: purgeStaleSyncQueueItemsの失敗後も、直列化チェーンは途切れず後続操作が実行できる", async () => {
    jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("disk full"));
    await expect(purgeStaleSyncQueueItems("user-a", "session-a")).rejects.toThrow();

    // 直前の操作が失敗していても、チェーン自体は途切れず後続の正常な操作が完了する。
    await enqueueUpsert(buildEvent("evt-after-purge-fail"), "user-a", "session-a");
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId)).toEqual(["evt-after-purge-fail"]);
  });
});

/**
 * REVISE対応（第7ラウンド、P1-1）: 書込み後にstaleと判明した際の補償削除
 * （compensating delete）自体が失敗した場合の挙動。以前はこの補償writeJSONの失敗を
 * `.catch(() => {})`で握りつぶし、常に"discarded-stale"（＝Storageから確実に消せた）を
 * 返していたため、実際には旧所有者の予定データ（タイトル・メモを含むAppEvent全体）が
 * Storageに残ったまま「破棄済み」と誤って報告していた。新設の"stale-cleanup-pending"は、
 * この「保存はされなかったが、後始末（除去）自体は未完了」という状態を明示的に区別する。
 */
describe("REVISE対応（第7ラウンド、P1-1）: 補償削除自体の失敗（stale-cleanup-pending）", () => {
  beforeEach(async () => {
    await clearSyncQueue();
  });

  it("必須テスト1: 補償削除自体の書込みが失敗した場合、discarded-staleではなくstale-cleanup-pendingを返し、元の項目をStorageに残す", async () => {
    // mockRestore()は意図的に呼ばない（本エンゲージメントで既知の、
    // jest.spyOn(AsyncStorage, "setItem")をmockRestore()すると無関係な後続の書込みが
    // 静かに失われるという既存不具合を踏まないため）。
    //
    // 本体の書込み（1回目のsetItem呼び出し）には一切手を加えず、既定の（このファイルの
    // 他のテストと共有される）スパイの挙動——上書きが無ければ実装へ委譲する——のまま
    // 実際に保存させる。isStillCurrentの3回目の呼び出し（書込み後、補償削除の直前）で
    // 初めてmockRejectedValueOnceを1件だけ積み、次のsetItem呼び出し（＝これから行われる
    // 補償削除の書込みそのもの）だけを失敗させる。これにより「何回目の呼び出しか」を
    // 数えて分岐する複雑なmockImplementationを組む必要がなく、このファイルの他の
    // テストと同じ確立された安全なパターン（mockRejectedValueOnceを1件だけ積んで
    // 次の1回だけに適用する）のまま使い回せる。
    let callCount = 0;
    const isStillCurrent = () => {
      callCount += 1;
      if (callCount === 3) {
        jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("disk full"));
      }
      return callCount <= 2; // 書込み前の2回の確認はtrue、書込み後の確認だけfalseにする。
    };

    const result = await enqueueUpsertRaw(
      buildEvent("evt-compensate-fail"),
      "user-a",
      "session-a",
      isStillCurrent
    );

    expect(result.outcome).toBe("stale-cleanup-pending");
    // 補償削除の書込み自体が失敗したため、本体の書込み（1回目）で保存された項目が
    // そのままStorageに残っている（"discarded-stale"のように確実に消せたわけではない）。
    const stored = await getSyncQueue();
    expect(stored.some((q) => q.eventId === "evt-compensate-fail")).toBe(true);
  });

  it("必須テスト3・4: 補償削除に失敗し残存したA項目は、現在identity（B）を正本とするpurgeにより除去され、B自身の正当な項目は維持される（アプリ再起動をまたいだ残存の回収に相当）", async () => {
    // 補償削除自体の失敗経路（必須テスト1で検証済み）を経て、Aの項目がStorageに
    // 残ったままになった状況を直接再現する。「再起動をまたいで残ったままの状態」からの
    // 回収を検証するのが目的のため、失敗経路自体は再現せず直接seedする。
    await enqueueUpsert(buildEvent("evt-a-residual"), "user-a", "session-a"); // 補償失敗で残ったAの項目
    await enqueueUpsert(buildEvent("evt-b-legit"), "user-b", "session-b"); // Bの正当な項目

    // cold-start-purge・AppState「active」復帰時の再試行に相当する呼び出し。
    const result = await purgeStaleSyncQueueItems("user-b", "session-b");

    expect(result.map((q) => q.eventId)).toEqual(["evt-b-legit"]);
    const stored = await getSyncQueue();
    expect(stored.map((q) => q.eventId)).toEqual(["evt-b-legit"]);
  });

  it("必須テスト6: stale-cleanup-pending判定（本体書込み成功＋補償削除失敗）の後も、直列化チェーンは途切れず後続操作が実行できる", async () => {
    // 必須テスト1と同じ理由・同じパターン（isStillCurrentの3回目の呼び出しで、次の
    // 1回のsetItem呼び出しだけを失敗させる）を使う。
    let callCount = 0;
    const isStillCurrent = () => {
      callCount += 1;
      if (callCount === 3) {
        jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("disk full"));
      }
      return callCount <= 2;
    };
    const result = await enqueueUpsertRaw(
      buildEvent("evt-stale-pending"),
      "user-a",
      "session-a",
      isStillCurrent
    );
    expect(result.outcome).toBe("stale-cleanup-pending");

    // 直前の操作のop自体がcatch節で終わっていても、チェーンは途切れず、後続の正常な
    // enqueueUpsertが問題なく完了する。
    await enqueueUpsert(buildEvent("evt-after-stale-pending"), "user-a", "session-a");
    const queue = await getSyncQueue();
    expect(queue.map((q) => q.eventId).sort()).toEqual(
      ["evt-after-stale-pending", "evt-stale-pending"].sort()
    );
  });
});
