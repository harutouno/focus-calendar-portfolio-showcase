import AsyncStorage from "@react-native-async-storage/async-storage";
import { readJSON, readJSONStrict, writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";
import { isPlainObject, isString, isOneOf, StoredDataValidationError } from "./shapeGuards";

/**
 * 1予定に紐づく通知IDの集合。
 * 通常予定は default のみを使う。集中予定はfocusReminder（事前リマインダー、任意）・
 * focusStart（開始通知）の最大2つを使う（2026-08: 集中予定の2通知対応で拡張）。
 */
export interface EventNotificationIds {
  default?: string;
  focusReminder?: string;
  focusStart?: string;
}

export type NotificationSlot = keyof EventNotificationIds;

const ALL_SLOTS: readonly NotificationSlot[] = ["default", "focusReminder", "focusStart"];

/**
 * SEC-F007-001 REVISE対応（P1-3、スキーマv3）: 通知の「誰の・どの認証セッション時点の・
 * どの予定の・どのslotの」通知かを表す所有情報。scope==="shared"の場合のみ
 * ownerUserId・sessionInstanceIdの両方を必ず持つ（型レベルで強制する。以前は両方とも
 * 任意フィールドで、sessionInstanceIdを省略した呼び出しが可能だったため、
 * 「同じownerUserIdの異なるセッション」を区別できない抜け穴があった）。
 */
export type NotificationOwnership =
  | { scope: "local" }
  | { scope: "shared"; ownerUserId: string; sessionInstanceId: string };

/**
 * SEC-F007-001 REVISE対応（P1-3）: 通知1件（eventId×slot単位）の対応表エントリ。
 * schemaVersionは3（v2までのeventIdのみキー・所有者情報が任意だった形式から、
 * 論理キー自体にscope/owner/session/eventId/slotを織り込んだ形式へ変更した）。
 */
export interface NotificationRegistryEntry {
  schemaVersion: 3;
  scope: "local" | "shared";
  ownerUserId?: string;
  sessionInstanceId?: string;
  eventId: string;
  slot: NotificationSlot;
  notificationId: string;
}

/**
 * SEC-F007-001 REVISE対応（P1-3）: v2までは`Record<eventId, entry>`だったため、
 * 「ローカル予定と共有予定が同じeventIdを持つ」「異なる所有者・異なる認証セッションが
 * 同じeventIdを持つ」ケースで、後勝ちの上書き・意図しない取消の衝突が起こり得た
 * （例: BさんがAさんと同じeventIdの共有予定通知を取り消すと、Aさんの通知エントリまで
 * 上書き・削除されてしまう）。v3では論理キーを
 * `local:<eventId>:<slot>` / `shared:<ownerUserId>:<sessionInstanceId>:<eventId>:<slot>`
 * とし、scope・所有者・セッション・予定・slotの組が完全に一致する場合のみ
 * 同じエントリを指すようにする（`notificationLogicalKey`参照）。
 * このキーは衝突を避けるためだけの不透明な文字列として扱い、後から分解して
 * eventId等を復元する用途には使わない（各操作は必ずownershipを明示的に受け取る）。
 */
export type NotificationRegistry = Record<string, NotificationRegistryEntry>;

/** ownership・eventId・slotから一意な論理キーを作る。分解して使うことは想定しない。 */
export function notificationLogicalKey(
  ownership: NotificationOwnership,
  eventId: string,
  slot: NotificationSlot
): string {
  if (ownership.scope === "shared") {
    return `shared:${ownership.ownerUserId}:${ownership.sessionInstanceId}:${eventId}:${slot}`;
  }
  return `local:${eventId}:${slot}`;
}

function isValidRegistryEntry(value: unknown): value is NotificationRegistryEntry {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== 3) return false;
  if (value.scope !== "local" && value.scope !== "shared") return false;
  if (!isString(value.eventId)) return false;
  if (!isOneOf(value.slot, ALL_SLOTS)) return false;
  if (!isString(value.notificationId)) return false;
  if (value.scope === "shared") {
    if (!isString(value.ownerUserId) || !isString(value.sessionInstanceId)) return false;
  } else if (value.ownerUserId !== undefined || value.sessionInstanceId !== undefined) {
    return false;
  }
  return true;
}

/**
 * 論理キー -> 所有情報つき通知エントリの対応表。端末ローカルの情報としてのみ保持し、
 * Supabaseには一切送らない（共有カレンダーの他ユーザーとは共有しない設計方針）。
 *
 * v3より前（schemaVersionが3でない）のエントリは新しい論理キー体系に安全に移せないため、
 * ここでは無効なエントリとして除外する（通常は起動時の1回限りの移行処理
 * `runNotificationRegistryMigrationIfNeeded`が対応表全体を先に破棄するため、この
 * フォールバックが実際に効くのは移行未実施の過渡的な状態やテスト時のみを想定する
 * ——安全側に倒して「無効なら除外」であり、誤って旧エントリを推測して復元することはしない）。
 * 破損JSON・読込み失敗時はreadJSONが空オブジェクトへフォールバックする
 * （**純粋read専用**の寛容な挙動。read-modify-writeでは使ってはならない——
 * 理由と代替は`readNotificationRegistryForMutation`を参照）。
 */
async function getNotificationRegistry(): Promise<NotificationRegistry> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.notificationMap, {});
  if (!isPlainObject(raw)) return {};
  const result: NotificationRegistry = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isValidRegistryEntry(value)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * [P0126 DATA-F073-006] 1エントリの**厳格**検証。`isValidRegistryEntry`との差:
 * 必須文字列の**非空**を要求する（空文字は論理キーを壊し、OS識別子としても無効）。
 */
function isStrictValidRegistryEntry(value: unknown): value is NotificationRegistryEntry {
  if (!isValidRegistryEntry(value)) return false;
  if (value.eventId.length === 0) return false;
  if (value.notificationId.length === 0) return false;
  if (value.scope === "shared") {
    if ((value.ownerUserId ?? "").length === 0) return false;
    if ((value.sessionInstanceId ?? "").length === 0) return false;
  }
  return true;
}

export type NotificationRegistryValidation =
  | { kind: "valid"; registry: NotificationRegistry }
  | { kind: "invalid"; reason: string };

/**
 * [P0126 DATA-F073-006] notificationMap の **whole-registry** 健全性を判定する唯一の権威。
 *
 * mutation側（`readNotificationRegistryForMutation`）とrepair側
 * （`repairCorruptNotificationRegistryExclusively`）が**同じ関数**を使うことで、
 * 「mutationは壊れていると判断するのにrepairはhealthy扱い（またはその逆）」という
 * 構造的な不一致を排除する。P0124ではこの2者が別基準だったため、
 * 「トップレベルはオブジェクト → repairはnot-corrupt → 次のmutationが不正entryを
 * 除外した正規化オブジェクトを書き戻して生の証跡が消える」という穴が残っていた。
 *
 * healthy条件:
 * ```text
 * トップレベルがplain object
 * 全entryが v3 shape かつ 必須文字列が非空（local は owner/session を持たない）
 * 保存キー === notificationLogicalKey(entry の ownership, eventId, slot)
 * notificationId -> logicalKey が1対1（同じidentifierが複数キーに現れない）
 * ```
 */
export function validateWholeNotificationRegistry(value: unknown): NotificationRegistryValidation {
  if (!isPlainObject(value)) return { kind: "invalid", reason: "not_object" };
  const registry: NotificationRegistry = {};
  const keyByIdentifier = new Map<string, string>();
  for (const [storedKey, entry] of Object.entries(value)) {
    if (!isStrictValidRegistryEntry(entry)) {
      return { kind: "invalid", reason: `entry_invalid:${storedKey}` };
    }
    const ownership: NotificationOwnership =
      entry.scope === "shared"
        ? {
            scope: "shared",
            ownerUserId: entry.ownerUserId as string,
            sessionInstanceId: entry.sessionInstanceId as string,
          }
        : { scope: "local" };
    if (notificationLogicalKey(ownership, entry.eventId, entry.slot) !== storedKey) {
      return { kind: "invalid", reason: `key_mismatch:${storedKey}` };
    }
    const priorKey = keyByIdentifier.get(entry.notificationId);
    if (priorKey !== undefined && priorKey !== storedKey) {
      return { kind: "invalid", reason: `identifier_multi_key:${entry.notificationId}` };
    }
    keyByIdentifier.set(entry.notificationId, storedKey);
    registry[storedKey] = entry;
  }
  return { kind: "valid", registry };
}

/**
 * [P0124 QA-F073 / DATA-F073-001] read-modify-write**専用**のfail-closed reader。
 *
 * 修正前は`mutateNotificationRegistry`が`getNotificationRegistry()`（tolerant）の結果を
 * 基準に新しい対応表を組み立てて書き戻していた。`readJSON`は
 *   - キー未保存（正当な初回状態）
 *   - `AsyncStorage.getItem`自体の失敗（I/Oエラー）
 *   - JSON構文の破損
 *   - トップレベルがオブジェクトでない
 * の**すべて**を`{}`へ縮退させるため、一時的な読込み障害の最中に1件でも変更操作が走ると、
 * 「対応表は空だった」という誤った前提で**他の全エントリを消した対応表**を永続化してしまう。
 * 対応表はOS側の予約済み通知をキャンセル／整合させるための唯一の端末内権威であり、
 * これを失うと削除・編集済みの予定の通知が取り消せない孤立通知として残る
 * （所有者別cleanupの対象も同時に失われる）。
 *
 * F073 §4の原則「MISSING != CORRUPT != I/O_ERROR」に従い、この関数は
 * **未保存のときだけ**空の対応表を返し、それ以外の異常は例外として呼び出し元へ伝える
 * （＝後続の書込みへ進ませない）。
 *
 * [P0128 §6 コメント修正] ここには以前「個々のentryの形状不正は従来どおり除外する」と
 * 書かれていたが、**P0126 DATA-F073-006 以降その記述は実装と矛盾している**。
 * 現在は `validateWholeNotificationRegistry` により、entry 1件でも不正なら
 * 対応表全体をfail-closedとして扱う（正規化した部分集合を書き戻すことは、
 * 元の権威を破壊する上書きに当たるため）。v3移行の過渡状態の解消は
 * migration authorityの責務であり、通常のmutationが片手間に行う処理ではない。
 *
 * 純粋read（getNotificationId等）の寛容な挙動は**一切変更しない**——それらの戻り値は
 * P0086/P0088で確立したcancel outcome契約に接続しており、ここを一律に厳格化すると
 * 受理済みの通知outcome意味論が変わるため（P0124 §5「do not globally tighten it」）。
 */
async function readNotificationRegistryForMutation(): Promise<NotificationRegistry> {
  const result = await readJSONStrict<unknown>(STORAGE_KEYS.notificationMap);
  if (result.kind === "io-error") {
    throw new StoredDataValidationError("notificationMap", "read_failed");
  }
  if (result.kind === "malformed") {
    throw new StoredDataValidationError("notificationMap", "parse_failed");
  }
  if (result.kind === "missing") return {};
  // [P0126 DATA-F073-006] 以前は「トップレベルがobjectなら、不正entryを除外して続行」
  // だった。除外した状態を書き戻すと生の破損証跡が消えるため、whole-registryが
  // healthyでない限りRMWへ進ませない（repair側と同一の権威で判定する）。
  const validation = validateWholeNotificationRegistry(result.value);
  if (validation.kind === "invalid") {
    throw new StoredDataValidationError("notificationMap", validation.reason);
  }
  return validation.registry;
}

/**
 * 対応表への全ての変更操作をこの単一のPromiseチェーンで直列化する
 * （SEC-F007-001 REVISE対応 P2-1）。`op`は「直前の操作が完全に終わった後」にのみ
 * 実行されることが保証されるため、read-modify-write（読み込み→変更→書き込み）を
 * 挟む操作同士が並行実行されて片方の変更が失われる（lost update）ことがなくなる。
 * `op`が例外を投げても、チェーン自体は途切れず次の操作へ進む。
 */
let registryMutationChain: Promise<void> = Promise.resolve();

function enqueueRegistryOp<T>(op: () => Promise<T>): Promise<T> {
  const run = registryMutationChain.then(op);
  registryMutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * REVISE対応（P1-3）: 通知ID対応表は端末内の補助的データ（Category C）のため、
 * 削除系操作（removeNotificationIdForSlot等）では引き続き保存失敗を呼び出し元へ
 * 伝播させない（再起動時のreconcileNotifications等が対応表無しから復旧できる前提の
 * ベストエフォート）。一方、setNotificationId（新規予約の記録）だけは戻り値のbooleanで
 * 成否を返す。OS側の予約が既に成功した直後に呼ばれるため、ここで保存が失敗すると
 * 「OSには存在するが対応表からは辿れない孤立通知」が残ってしまう。呼び出し元
 * （notificationService.scheduleCandidateInternal等）は、falseが返った場合に
 * 直ちにOS側の予約を取り消す責務を持つ。
 */
async function writeNotificationRegistry(registry: NotificationRegistry): Promise<boolean> {
  try {
    await writeJSON(STORAGE_KEYS.notificationMap, registry);
    return true;
  } catch {
    return false;
  }
}

/**
 * `mutator`を対応表の最新内容へ適用し、直列化された1回のread-modify-writeとして
 * 書き込む（P2-1）。保存の成否をbooleanで返す（詳細は`writeNotificationRegistry`参照）。
 */
function updateRegistry(
  mutator: (current: NotificationRegistry) => NotificationRegistry
): Promise<boolean> {
  return enqueueRegistryOp(async () => {
    // [P0124 QA-F073 / DATA-F073-001] RMWの読取りだけはfail-closed版を使う。
    // 読めなかった（I/Oエラー・JSON破損・非オブジェクト）ときは、対応表を空と誤認して
    // 他の全エントリを消した内容を書き戻すのではなく、書込み自体を行わずfalseを返す。
    // falseは既存の「保存できなかった」経路（setNotificationIdの呼び出し元がOS予約を
    // 取り消す責務を持つ契約）とまったく同じ意味であり、新しい戻り値も新しい文言も増やさない。
    let current: NotificationRegistry;
    try {
      current = await readNotificationRegistryForMutation();
    } catch (e) {
      if (__DEV__) {
        console.warn("[notificationRepository] 対応表を読めなかったため変更を中止しました（既存エントリは保持）", e);
      }
      return false;
    }
    const next = mutator(current);
    return writeNotificationRegistry(next);
  });
}

/**
 * 指定したownership・eventId・slotの通知IDを取得する。
 * REVISE対応（P0007 Batch2.1、P2-3）: 以前はregistryMutationChainを経由しない直接読みで、
 * set/remove/clear等の変更操作が既にチェーンへ積まれているが完了していない
 * （read-modify-write途中の）タイミングでこの関数を呼ぶと、その進行中の変更を反映する前の
 * 古いスナップショットを読んでしまう可能性があった。呼び出し元（reconcileNotifications・
 * cancelSlotInternal等）の設計・コード上のコメントは「呼び出し時点までにチェーンへ積まれた
 * 全ての変更が完了した後の値を読める」ことを前提にしていたため、この関数自体がその前提を
 * 満たしていなかった（getAllNotificationEntriesと同じ理由・同じ対応、Round 5 P2-2参照）。
 * enqueueRegistryOpへ合流させることで、他の変更操作と同じ直列化を受ける。
 */
export async function getNotificationId(
  ownership: NotificationOwnership,
  eventId: string,
  slot: NotificationSlot = "default"
): Promise<string | undefined> {
  return enqueueRegistryOp(async () => {
    const registry = await getNotificationRegistry();
    return registry[notificationLogicalKey(ownership, eventId, slot)]?.notificationId;
  });
}

/**
 * 指定したownership・eventId・slotへ通知IDを設定する（他のslot・他のownershipの
 * エントリには一切影響しない）。ownershipは呼び出し元が必ず明示する
 * （呼び出し元＝notificationService/sharedNotificationCoordinatorが、今まさに
 * 予約しようとしている通知が誰のものかを一番正確に把握しているため）。
 * REVISE対応（P1-4）: 保存の成否をbooleanで返す（詳細は`writeNotificationRegistry`参照）。
 * REVISE対応（P2-1）: `updateRegistry`経由で直列化されるため、他の並行するset/remove
 * 呼び出しとのread-modify-write競合でエントリが失われることはない。
 */
export async function setNotificationId(
  eventId: string,
  notificationId: string,
  slot: NotificationSlot,
  ownership: NotificationOwnership
): Promise<boolean> {
  const key = notificationLogicalKey(ownership, eventId, slot);
  return updateRegistry((current) => ({
    ...current,
    [key]:
      ownership.scope === "shared"
        ? {
            schemaVersion: 3,
            scope: "shared",
            ownerUserId: ownership.ownerUserId,
            sessionInstanceId: ownership.sessionInstanceId,
            eventId,
            slot,
            notificationId,
          }
        : {
            schemaVersion: 3,
            scope: "local",
            eventId,
            slot,
            notificationId,
          },
  }));
}

/**
 * 指定したownership・eventId・slotだけを対応表から削除する（他のslot・他のownershipの
 * エントリには一切影響しない。存在しなくても失敗しない）。
 */
export async function removeNotificationIdForSlot(
  ownership: NotificationOwnership,
  eventId: string,
  slot: NotificationSlot
): Promise<void> {
  const key = notificationLogicalKey(ownership, eventId, slot);
  await updateRegistry((current) => {
    if (!(key in current)) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });
}

/**
 * 対応表の全エントリを取得する（reconcileNotificationsでのOS予約一覧との照合用）。
 * scope・所有者・セッションを問わず「今対応表にある全て」を返すため、呼び出し元が
 * 各エントリ自身が持つownership情報（scope/ownerUserId/sessionInstanceId）を使って
 * OS側の通知と突き合わせる。
 * REVISE対応（第5ラウンド、P2-2、必須テスト5）: 以前はこの読み込みが
 * registryMutationChainを経由しない直接読みだったため、setNotificationId等の
 * 変更操作が既にチェーンへ積まれているが完了していない（read-modify-write途中の）
 * タイミングでreconcileがこの関数を呼ぶと、その進行中の変更を反映する前の
 * 古いスナップショットを読んでしまう可能性があった（＝reconcileが同じ論理キーへ
 * 二重に予約してしまう恐れ）。他の変更操作と同じチェーンへ合流させることで、
 * 呼び出し時点までにキューに積まれていた全ての変更が完了した後の状態を必ず読める
 * ようにする（進行中のmutationを追い越さない）。
 */
export async function getAllNotificationEntries(): Promise<NotificationRegistryEntry[]> {
  return enqueueRegistryOp(async () => {
    const registry = await getNotificationRegistry();
    return Object.values(registry);
  });
}

/**
 * 指定した所有者（ownerUserId）の共有予定（scope==="shared"）に属する通知エントリだけを
 * 抽出する（認証セッションを問わず、同一ownerUserIdの全セッション分を返す）。
 * ユーザー切替時に「前の所有者の共有通知だけ」を一括取消するために使う。
 */
export async function getSharedEntriesForOwner(
  ownerUserId: string
): Promise<NotificationRegistryEntry[]> {
  const registry = await getNotificationRegistry();
  return Object.values(registry).filter(
    (entry) => entry.scope === "shared" && entry.ownerUserId === ownerUserId
  );
}

/**
 * 対応表に登録されている、共有予定（scope==="shared"）の所有者ID一覧（重複無し）。
 * アプリ再起動時に「現在の所有者と一致しない共有通知」を回収するための列挙に使う。
 */
export async function getAllSharedOwnerIds(): Promise<string[]> {
  const registry = await getNotificationRegistry();
  const owners = new Set<string>();
  for (const entry of Object.values(registry)) {
    if (entry.scope === "shared" && entry.ownerUserId) {
      owners.add(entry.ownerUserId);
    }
  }
  return [...owners];
}

/** 対応表に登録されているeventId一覧を取得する（scope・所有者を問わず重複無し）。 */
export async function getAllEventIds(): Promise<string[]> {
  const registry = await getNotificationRegistry();
  const ids = new Set<string>();
  for (const entry of Object.values(registry)) {
    ids.add(entry.eventId);
  }
  return [...ids];
}

/**
 * REVISE対応（P1-1）: 移行専用の厳格版。書き込みに失敗した場合は例外
 * （`writeJSON`が投げる`LocalPersistenceError`）をそのまま呼び出し元（移行処理）へ
 * 伝播させる（対応表を確実に空にできたことを保証できない場合、移行完了扱いにしない
 * ため）。他の全ての変更操作と同じ直列化チェーンを経由するため、この処理の前に
 * 積まれていた変更はこのクリアより前に確定し、後から積まれる変更はこのクリアより
 * 後に適用される。
 */
export function clearAllNotificationIdsStrict(): Promise<void> {
  return enqueueRegistryOp(async () => {
    await writeJSON(STORAGE_KEYS.notificationMap, {});
  });
}

/**
 * [P0124 QA-F073 / DATA-F073-004] 破損確定時の再構築結果。
 * `abort`のとき、対応表へは**一切書き込まない**（不完全なregistryをcommitしない）。
 */
export type NotificationRegistryRebuildOutcome =
  | { kind: "rebuilt"; registry: NotificationRegistry }
  | { kind: "abort"; reason: string };

export type NotificationRegistryRepairResult =
  | "not-corrupt"
  | "unreadable"
  | "aborted"
  | "repaired"
  /** v3移行が未完了。runtime corruption repairは実行せず、migration authorityへ委譲する。 */
  | "migration-pending"
  /** 移行完了フラグ自体を読めなかった。fail-closed（OS列挙も書き込みも行わない）。 */
  | "migration-unknown";

/**
 * [P0124 QA-F073 / DATA-F073-004] 破損確定した対応表を、OS側の通知メタデータから再構築する。
 *
 * DATA-F073-001で「破損時はRMWを行わない」ようにしたが、v3移行済み端末では
 * `clearAllNotificationIdsStrict`が一度きりの移行からしか呼ばれないため、
 * 破損が一度起きると`updateRegistry`が恒久的にfalseを返し、通知の記録が永久に止まる。
 * 一方で対応表を`{}`へresetするだけでは、OSに登録済みの通知が孤児化する。
 *
 * `buildNotificationContent`が全slot・両scopeについて
 * `{ eventId, schemaVersion:3, slot, scope, (shared: ownerUserId, sessionInstanceId) }`
 * をcontent.dataへ埋めているため、OSの予約済み・表示済み一覧から**論理キーを完全に復元**でき、
 * `identifier`をnotificationIdとしてregistryを損失なく再構築できる（reset不要）。
 *
 * ## 直列化（必須）
 * 再構築は「strict read → 破損確定 → OS列挙 → absolute write」までを
 * `enqueueRegistryOp`の**単一スロット内**で行う。通常のadd/remove/update/read
 * （`updateRegistry`・`getNotificationId`・`getAllNotificationEntries`・
 * `clearAllNotificationIdsStrict`）はすべて同じチェーンを共有するため、
 *   - repair開始後に追加された正常entryを古いsnapshotで消す
 *   - repair開始後に削除されたentryを古いsnapshotで復活させる
 * のいずれのlost-updateも構造的に発生しない（新しいlockは追加しない）。
 *
 * ## 書込み条件
 * `rebuild`が`abort`を返した場合（必要なOS列挙のいずれかが失敗した／v3を名乗るのに
 * 必須fieldを欠くペイロードがあった／同一論理キーに矛盾するidentifierがあった）は
 * **書き込まない**。破損値はそのまま残り、次の機会に再試行できる（冪等）。
 *
 * ## `rebuild`が例外を投げた場合
 * 例外はそのまま呼び出し元へ伝播し、**書き込みは行わない**（`writeJSON`へ到達しない）。
 * 「repair成功」として解決することは絶対にない。破損値はそのまま残り再試行できる。
 *
 * ## 耐クラッシュ性
 * 永続的な中間状態を持たない（durable markerを追加しない）。
 * `setItem`前に落ちれば破損のまま＝次回repairが再実行され、成功後に落ちれば有効なregistry。
 */
export async function repairCorruptNotificationRegistryExclusively(
  rebuild: () => Promise<NotificationRegistryRebuildOutcome>
): Promise<NotificationRegistryRepairResult> {
  return enqueueRegistryOp(async () => {
    // [P0126 DATA-F073-006] **migration authorityを最初に確認する**。
    // v3移行が完了していない間は、v3以前の内容を「runtime corruption」とみなして
    // 勝手に再構築してはならない（対応表を丸ごと破棄する権威はmigration側にある）。
    // P0124時点ではこの確認が無く、malformed JSONに対してrepairがmigrationより先に
    // 発火してabsolute writeしていた（P0126-C3で検出）。
    const migrated = await readJSONStrict<unknown>(STORAGE_KEYS.notificationRegistryMigratedV3);
    if (migrated.kind === "io-error" || migrated.kind === "malformed") {
      // 移行状態が不明なままOS列挙・書き込みへ進まない。
      return "migration-unknown";
    }
    if (!(migrated.kind === "value" && migrated.value === true)) {
      return "migration-pending";
    }

    const result = await readJSONStrict<unknown>(STORAGE_KEYS.notificationMap);
    // I/Oエラーは「破損確定」ではない（元bytesは無傷の可能性が高い）。再構築してはいけない。
    if (result.kind === "io-error") return "unreadable";
    if (result.kind === "missing") return "not-corrupt";
    if (
      result.kind === "value" &&
      validateWholeNotificationRegistry(result.value).kind === "valid"
    ) {
      return "not-corrupt";
    }
    // malformed / 非オブジェクト / whole-registry不正 = 破損確定。
    const outcome = await rebuild();
    if (outcome.kind === "abort") return "aborted";
    await writeJSON(STORAGE_KEYS.notificationMap, outcome.registry);
    return "repaired";
  });
}

/**
 * SEC-F007-001 REVISE対応（P1-3）: 通知レジストリのv3スキーマ（論理キーにscope/owner/
 * session/eventId/slotを織り込んだ形式）への移行が完了済みかどうか。
 * 移行前（v2以前）のエントリは新しい論理キー体系と互換性が無いため、一度だけ
 * 対応表全体を破棄する（関連: notificationService.runNotificationRegistryMigrationIfNeeded）。
 *
 * [P0128 DATA-F073-009 P1] **strict reader**。以前は`readJSON(..., false)`で
 * 「欠落 / 破損 / 読み取りI/O失敗」をすべて`false`（=未移行）へ畳んでいた。
 * 唯一の本番呼び出し元はOS通知のcancel/dismissと対応表全消去を行う**破壊的権威**なので、
 * 畳み込みは「実際は移行済みなのに、markerが一時的に読めなかっただけ」の状況で
 * 現行v3の通知と対応表を破棄する経路になっていた。
 *
 * 契約:
 *   値がtrue           -> true（移行済み）
 *   値がfalse / 欠落   -> false（移行してよい）
 *   破損 / I/O失敗     -> throw（呼び出し元がfail closedする）
 *   boolean以外の値    -> throw（未知スキーマを「未移行」と解釈しない）
 *
 * F073根本原則の適用: MISSING != CORRUPT != I/O_ERROR。
 * 「欠落」だけが移行を正当化し、「不明」は正当化しない。
 */
export async function isNotificationRegistryMigratedV3(): Promise<boolean> {
  const result = await readJSONStrict<unknown>(STORAGE_KEYS.notificationRegistryMigratedV3);
  if (result.kind === "io-error") {
    throw new StoredDataValidationError("notificationRegistryMigratedV3", "read_failed");
  }
  if (result.kind === "malformed") {
    throw new StoredDataValidationError("notificationRegistryMigratedV3", "malformed");
  }
  if (result.kind === "missing") return false;
  if (typeof result.value !== "boolean") {
    throw new StoredDataValidationError("notificationRegistryMigratedV3", "not_boolean");
  }
  return result.value;
}

/**
 * REVISE対応（P1-1）: 移行専用の厳格版。書き込みに失敗した場合は例外を呼び出し元へ
 * 伝播させる（フラグを保存できたことを確認できないまま移行完了扱いにしないため。
 * 以前は`.catch(() => {})`で書込み失敗を握りつぶしており、対応表は既に破棄済みなのに
 * 移行未完了と記録される・あるいは逆に保存失敗を検知できず次回起動時に再試行されない、
 * という不整合の原因になっていた）。
 */
export async function markNotificationRegistryMigratedV3Strict(): Promise<void> {
  await writeJSON(STORAGE_KEYS.notificationRegistryMigratedV3, true);
}

/**
 * REVISE対応（第6ラウンド、P1-3）: cancelAllSharedNotificationsForOwnerが1件でも失敗した
 * 所有者を永続的に記録する一覧。
 *
 * REVISE対応（第9ラウンド、P1-1）: 以前はownerUserId文字列だけを記録しており、
 * 「どの認証セッション時点の残留か」を区別できなかった。同一ユーザーが別セッションで
 * 再ログインした場合（A/session1→A/session2）、A/session1の残骸をセッション単位で
 * 追跡できず、A/session2起動時に「ownerUserIdが同じ」という理由だけで誤って
 * 自分自身の正常な通知として除外されてしまう経路があった。新形式では各要素を
 * `{kind:"identity", ownerUserId, sessionInstanceId}`（特定セッションのみ対象）または
 * `{kind:"legacy-owner", ownerUserId}`（本ラウンド以前に書き込まれた、セッション情報を
 * 持たない旧形式のエントリ。後方互換のため、全セッション分をまとめて対象にする）として
 * 扱う。永続化フォーマット自体は「文字列（旧形式）またはownerUserId/sessionInstanceIdを
 * 持つオブジェクト（新形式）」が混在する配列のまま維持する。
 */
export type PendingOwnerCleanupTarget =
  | { kind: "identity"; ownerUserId: string; sessionInstanceId: string }
  | { kind: "legacy-owner"; ownerUserId: string };

type PendingOwnerCleanupRawEntry = string | { ownerUserId: string; sessionInstanceId: string };

function pendingTargetKey(target: PendingOwnerCleanupTarget): string {
  return target.kind === "identity"
    ? `identity:${target.ownerUserId}:${target.sessionInstanceId}`
    : `legacy-owner:${target.ownerUserId}`;
}

function pendingTargetToRaw(target: PendingOwnerCleanupTarget): PendingOwnerCleanupRawEntry {
  return target.kind === "identity"
    ? { ownerUserId: target.ownerUserId, sessionInstanceId: target.sessionInstanceId }
    : target.ownerUserId;
}

/** 1件の生要素を検証済みターゲットへ変換する。不正な形の場合はnullを返す。 */
function parsePendingTargetEntry(item: unknown): PendingOwnerCleanupTarget | null {
  if (isString(item)) {
    return item.length > 0 ? { kind: "legacy-owner", ownerUserId: item } : null;
  }
  if (
    isPlainObject(item) &&
    isString(item.ownerUserId) &&
    item.ownerUserId.length > 0 &&
    isString(item.sessionInstanceId) &&
    item.sessionInstanceId.length > 0
  ) {
    return { kind: "identity", ownerUserId: item.ownerUserId, sessionInstanceId: item.sessionInstanceId };
  }
  return null;
}

/**
 * 読み込み時に不正な要素（非文字列・非オブジェクト・空文字列等）はベストエフォートで
 * 除外する（書込み・再試行用の非strict版。安全側に倒し、判別不能な値を誤ってターゲットとして
 * 扱わない）。読込み自体の失敗はreadJSONの既定の挙動（空配列へフォールバック）に従う
 * ——起動時hydrateのfail-closed判定には`getPendingOwnerCleanupTargetsStrict`を、
 * 追加系RMWには`readPendingOwnerCleanupTargetsForMutation`を使うこと
 * （P0124: 以前この行は存在しない関数名`readPendingOwnerCleanupTargetsStrict`を指していた）。
 */
async function readPendingOwnerCleanupTargets(): Promise<PendingOwnerCleanupTarget[]> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.pendingOwnerNotificationCleanup, []);
  if (!Array.isArray(raw)) return [];
  const targets: PendingOwnerCleanupTarget[] = [];
  for (const item of raw) {
    const target = parsePendingTargetEntry(item);
    if (target) targets.push(target);
  }
  return targets;
}

/** 他の変更操作とは独立した、この一覧専用の直列化チェーン（read-modify-writeの競合防止）。 */
let pendingOwnerCleanupChain: Promise<void> = Promise.resolve();

function enqueuePendingOwnerCleanupOp<T>(op: () => Promise<T>): Promise<T> {
  const run = pendingOwnerCleanupChain.then(op);
  pendingOwnerCleanupChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** 現在「未完了」として記録されているターゲット一覧を返す（重複無し）。非strict版。 */
export function getPendingOwnerCleanupTargets(): Promise<PendingOwnerCleanupTarget[]> {
  return enqueuePendingOwnerCleanupOp(() => readPendingOwnerCleanupTargets());
}

/**
 * REVISE対応（第9ラウンド、P1-1）: 既存呼び出し元（表示・ログ等、厳密なfail-closed判定を
 * 必要としない箇所）向けの後方互換ヘルパー。ownerUserIdのみを重複無しで返す
 * （identity・legacy-owner両方の種別から集約する）。
 */
export async function getPendingOwnerCleanups(): Promise<string[]> {
  const targets = await getPendingOwnerCleanupTargets();
  return [...new Set(targets.map((t) => t.ownerUserId))];
}

/**
 * [P0124 QA-F073 / DATA-F073-002] 追加系RMW**専用**のfail-closed reader。
 *
 * この一覧はログアウト／アカウント切替／削除後に「まだ消せていない所有者別通知」を
 * 再試行するための**復旧証跡（R-05）**である。修正前は追加経路が非strict版
 * （`readJSON`→`[]`フォールバック）で現在値を読み、`[...current, target]`を書き戻していた。
 * そのため`AsyncStorage.getItem`の一時的な失敗やJSON破損の最中に1件でも追加が走ると、
 * **他の全ターゲットを失った1要素だけの一覧**を永続化し、復旧証跡そのものを消してしまう
 * （F073 §4「erase recovery evidence」に該当）。
 *
 * 読めなかった場合は例外を投げ、**書込みへ進ませない**。呼び出し元
 * （`addPendingOwnerCleanup`等）は既に「書込み失敗時は例外を投げる」契約であり、
 * 新しい戻り値・新しい文言は追加していない。
 *
 * 削除経路（`removePendingTarget`）も同じくこのreaderを使う。非strict版でも
 * 「読めなかった→空→早期return」により破壊的な書込みは起きないが、結果を成功扱いに
 * してしまう。読めなかった場合は例外を投げ、書込みは行わない（証跡は残り再試行できる）。
 */
async function readPendingOwnerCleanupTargetsForMutation(): Promise<PendingOwnerCleanupTarget[]> {
  const result = await readJSONStrict<unknown>(STORAGE_KEYS.pendingOwnerNotificationCleanup);
  if (result.kind === "io-error") {
    throw new StoredDataValidationError("pendingOwnerNotificationCleanup", "read_failed");
  }
  if (result.kind === "malformed") {
    throw new StoredDataValidationError("pendingOwnerNotificationCleanup", "parse_failed");
  }
  if (result.kind === "missing") return [];
  if (!Array.isArray(result.value)) {
    throw new StoredDataValidationError("pendingOwnerNotificationCleanup", "not_array");
  }
  const targets: PendingOwnerCleanupTarget[] = [];
  let invalidCount = 0;
  for (const item of result.value) {
    const target = parsePendingTargetEntry(item);
    if (target) {
      targets.push(target);
    } else {
      invalidCount += 1;
    }
  }
  if (invalidCount > 0) {
    // [P0126 DATA-F073-005] 不正な**個別要素**を黙って除外して正常分だけを書き戻すと、
    // 生の復旧証跡が恒久的に失われる（トップレベルがfail-closedでも意味がない）。
    // 除外は「そのターゲットのcleanup再試行可能性を静かに捨てる」ことであり、
    // R-05はログアウト／アカウント切替／削除の通知プライバシー境界に使われるため
    // 安全側ではなく危険側の判断になる。
    // 起動時hydrate（getPendingOwnerCleanupTargetsStrict）が既に
    // 「不正要素があれば例外」で統一されており、mutation側だけが緩いのは
    // authority同士の不一致でもあった。
    // 先例: bulkAttemptJournalRepository.readAll（P0082 DATA-F017-003）。
    throw new StoredDataValidationError(
      "pendingOwnerNotificationCleanup",
      `${invalidCount}_malformed_elements`
    );
  }
  return targets;
}

async function addPendingTarget(target: PendingOwnerCleanupTarget): Promise<void> {
  return enqueuePendingOwnerCleanupOp(async () => {
    const current = await readPendingOwnerCleanupTargetsForMutation();
    const key = pendingTargetKey(target);
    if (current.some((t) => pendingTargetKey(t) === key)) return;
    await writeJSON(
      STORAGE_KEYS.pendingOwnerNotificationCleanup,
      [...current, target].map(pendingTargetToRaw)
    );
  });
}

async function removePendingTarget(
  predicate: (t: PendingOwnerCleanupTarget) => boolean
): Promise<void> {
  return enqueuePendingOwnerCleanupOp(async () => {
    // [P0124 QA-F073 / DATA-F073-003] 読取り失敗を「対象なし」と誤認して黙ってresolveしない。
    // 書込みを行わない点は従来と同じ（＝破壊的上書きは元々起きない）が、
    // 呼び出し元が戻り値で復旧完了を判定するため、読めなかったことは伝播させる。
    const current = await readPendingOwnerCleanupTargetsForMutation();
    const next = current.filter((t) => !predicate(t));
    if (next.length === current.length) return;
    await writeJSON(STORAGE_KEYS.pendingOwnerNotificationCleanup, next.map(pendingTargetToRaw));
  });
}

/** 指定した所有者ID（全セッション、legacy形式）を一覧へ追加する。書込み失敗時は例外を投げる。 */
export function addPendingOwnerCleanup(ownerUserId: string): Promise<void> {
  return addPendingTarget({ kind: "legacy-owner", ownerUserId });
}

/** 指定した所有者ID（legacy形式のエントリのみ）を一覧から除去する。書込み失敗時は例外を投げる。 */
export function removePendingOwnerCleanup(ownerUserId: string): Promise<void> {
  return removePendingTarget((t) => t.kind === "legacy-owner" && t.ownerUserId === ownerUserId);
}

/**
 * REVISE対応（第9ラウンド、P1-1）: 指定した所有者・セッションの組（1セッション分のみ）を
 * 一覧へ追加する。書込み失敗時は例外を投げる。
 */
export function addPendingIdentityCleanup(
  ownerUserId: string,
  sessionInstanceId: string
): Promise<void> {
  return addPendingTarget({ kind: "identity", ownerUserId, sessionInstanceId });
}

/** 指定した所有者・セッションの組（identityエントリのみ）を一覧から除去する。書込み失敗時は例外を投げる。 */
export function removePendingIdentityCleanup(
  ownerUserId: string,
  sessionInstanceId: string
): Promise<void> {
  return removePendingTarget(
    (t) => t.kind === "identity" && t.ownerUserId === ownerUserId && t.sessionInstanceId === sessionInstanceId
  );
}

/**
 * REVISE対応（第9ラウンド、P1-1）: sharedNotificationCoordinatorの起動時hydrate専用。
 * 汎用の`readJSON`は`AsyncStorage.getItem`の失敗・`JSON.parse`の失敗のいずれも内部で
 * 握りつぶし既定値（空配列）へフォールバックするため、この一覧の読込みにそのまま使うと
 * 「実際にはストレージ障害でpending一覧を読めていない」状態と「本当にpendingが0件」の
 * 状態を呼び出し元が区別できず、hydrate側のfail-closed判定（catchブロックで
 * barrierHydratedをfalseのまま維持する設計）が実質的に機能しない（＝常に成功したかのように
 * 見えてしまう）。この関数はAsyncStorage読込み・JSON解析・配列形状・各要素の形状の
 * いずれかが不正な場合は例外を投げ、空配列へフォールバックしない。値が全く保存されて
 * いない場合（初回起動等、正当な「pending無し」状態）のみ空配列を返す。
 */
export function getPendingOwnerCleanupTargetsStrict(): Promise<PendingOwnerCleanupTarget[]> {
  return enqueuePendingOwnerCleanupOp(async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.pendingOwnerNotificationCleanup);
    if (raw == null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("pendingOwnerNotificationCleanupのJSON解析に失敗しました");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("pendingOwnerNotificationCleanupの形式が不正です（配列ではありません）");
    }
    const targets: PendingOwnerCleanupTarget[] = [];
    for (const item of parsed) {
      const target = parsePendingTargetEntry(item);
      if (!target) {
        throw new Error("pendingOwnerNotificationCleanupに不正な要素が含まれています");
      }
      targets.push(target);
    }
    return targets;
  });
}
