import { OverlaySettings } from "@/types/event";
import { writeJSON, removeKey, readJSONStrict } from "./storage";
import { STORAGE_KEYS } from "./keys";
import { isBoolean, isPlainObject, isString, isStringArray } from "./shapeGuards";
import { isCurrentSharedMutationIdentity } from "@/auth/sharedMutationIdentity";
import { AuthIdentity, getCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";
import {
  saveOverlaySettings,
  saveFavoriteCalendarIdsStrict,
  saveLastUsedCalendarIdStrict,
  getOverlaySettings,
  getFavoriteCalendarIds,
  getLastUsedCalendarId,
  getOverlaySettingsStrict,
  getFavoriteCalendarIdsStrict,
  getLastUsedCalendarIdStrict,
  FieldStrictReadResult,
} from "./settingsRepository";
import { BASE_CALENDAR_ID } from "@/constants/options";
import { enqueueOwnerBoundPreferenceOperation } from "./ownerBoundPreferenceCoordinator";

/**
 * P0017 Batch1.4: owner-bound端末設定（overlay/favorite/last-used）の永続化契約。
 * P0016の単一スロットpending envelope設計自体は維持しつつ、独立再監査で見つかった
 * 次の構造的な穴を塞ぐ（詳細は各関数のdoc参照）:
 *
 * - unresolved journal overwrite: 修復失敗後もJSのPromiseチェーンは正常に完了してしまうため、
 *   次のowner-bound writeが「既に未解決のenvelopeがある」ことを確認せずに新しいenvelopeで
 *   上書きし、古い未解決分の追跡を失っていた。→ resolveExistingPendingJournalを、
 *   新規書込みの前に必ず呼ぶpreflightとして使う（呼び出し側:
 *   AppDataContext.tsxのcommitOwnerBoundLocalPreferenceImpl）。
 * - recoveryがReactのmutation chain外で動く: refresh()が直接getOverlaySettings等を読み、
 *   別途recoverしていたため、in-flightのowner-bound write中にrecoveryがenvelopeを
 *   clear/repairできてしまう競合があった。→ readOwnerBoundPreferencesSafelyを
 *   moduleレベルcoordinator（ownerBoundPreferenceCoordinator.ts）に載せ、
 *   1つのenqueueされた操作の中で「pending解決→fresh read」を保証する。
 * - chainがProvider instance-local: Reactのuseref正本をやめ、moduleレベルcoordinatorへ統一。
 * - main persist errorを「未適用」と断定していた: persist(nextValue)がthrowした際、
 *   従来は無条件にenvelopeをclearしていた（実際に書けたかどうか不明なまま）。→
 *   determineFreshOutcomeでfresh readして安全側に倒す。
 * - corrupt journalをmissing扱いしていた: 破損envelopeをnullへ畳んでraw値をそのまま
 *   信頼していた。→ parsePendingJournalが3状態（none/valid/corrupt）を区別し、
 *   corrupt時はaffected fieldを安全な既定値へquarantineする
 *   （readPendingOwnerBoundEnvelope自体の公開シグネチャ・既存の「corrupt→null」の
 *   挙動は変えていない。危険なのはこの戻り値の“解釈側”だったため、
 *   resolveExistingPendingJournal側でparsePendingJournalの3状態を直接見て判断する）。
 *
 * P0018 Batch1.5: 上記のjournal/outcome判定ロジックが、内部的にtolerant readerに
 * 依存していた残存箇所を修正する。
 * - parsePendingJournalが`readJSON(..., null)`（tolerant）を使っていたため、pending keyの
 *   getItem I/O失敗を「journal無し」と誤認していた。→ readJSONStrictへ切替え、
 *   I/O失敗を独立した"unreadable"状態として扱う（missingへ畳まない。newjournalを書かない・
 *   old journalをclear/overwriteしない）。
 * - determineFreshOutcomeが公開tolerant getter（getOverlaySettings等）を使っていたため、
 *   read失敗がdefault値へ畳まれ、それが偶然previousValueと一致すると誤ってnot-appliedと
 *   判定する恐れがあった。→ settingsRepository.tsのstrict semantic readerへ切替え、
 *   read失敗・不正shapeを全て"unknown"として扱う。
 * - current ownerのvalid journalを、fresh raw値を確認せず無条件にclearしていた。→
 *   current/staleを問わずfresh raw値を確認してから解決する（詳細は
 *   resolveExistingPendingJournalのdoc参照）。
 *
 * P0019 Batch1.6: unreadable時、safe read（readOwnerBoundPreferencesSafely）がaffected
 * fieldを特定できないままraw値をそのまま返していた（3フィールドのうちどれが中断writeの
 * 対象だったか不明なのに、safeValuesが空のためraw読込み結果が素通りしていた）。→
 * unreadable中はsafeValuesへ3フィールド全ての安全な既定値を設定し、React側へunsafe raw
 * 値を一切露出させない（詳細はresolveExistingPendingJournalのunreadable分岐参照）。
 *
 * P0020 Batch1.7: 残っていた2つの構造的な穴を塞ぐ。
 * - clear failureを解決済み扱いしていた: 「quarantine write全成功」「current-owner raw
 *   ===next/previous」の2箇所が、`clearPendingOwnerBoundEnvelopeStrict().catch(() => {})`
 *   の直後に無条件で`stillPending: false`を返していた。clear自体が失敗すればjournalは
 *   Storageに残ったままなのに「解決済み」と報告すると、次の新規writeがpreflightを
 *   通過してしまい、後で古いjournalのrecoveryが新しい正当な値をpreviousへ巻き戻す
 *   （正常な後発writeの破壊）。→ clearをdurability barrierにする（clear成功時のみ
 *   stillPending: false、失敗時はjournalを残しstillPending: trueで次のwriteをblockする）。
 * - current-ownerのidentity判定がstrict raw read前のsnapshotのままだった:
 *   `isCurrentSharedMutationIdentity`をraw read開始前に1度だけ評価し、await中に
 *   identityが切り替わっても（A→B・同一ユーザーの別セッションへの切替のいずれも）
 *   古い判定結果をそのまま使っていた。→ raw read完了直後にもう一度評価し、
 *   stale化していればstale-owner向けのpreviousへのrepairへ合流する（読めたraw値を
 *   Reactへ一切露出しない）。
 */

export type OwnerBoundPreferenceField = "overlaySettings" | "favoriteCalendarIds" | "lastUsedCalendarId";

const OWNER_BOUND_PENDING_SCHEMA = "owner-bound-pending-v1" as const;
const DEVICE_AUTH_PENDING_SCHEMA = "device-auth-pending-v1" as const;

export interface OwnerBoundPendingEnvelope<T> {
  schema: typeof OWNER_BOUND_PENDING_SCHEMA;
  field: OwnerBoundPreferenceField;
  ownerUserId: string;
  ownerSessionInstanceId: string;
  previousValue: T;
  nextValue: T;
  mutationId: string;
}

/**
 * [P0102 SEC-F019-F020-006] local-only preference write（ownerIdentity === nullの
 * commitOwnerBoundLocalPreferenceImpl経路）用の、device auth identity束縛のpending envelope。
 *
 * owner-bound-pending-v1との違いは束縛するidentityの種類だけ:
 * - owner-bound-pending-v1: 共有カレンダー操作の`SharedMutationIdentity`
 *   （userId/sessionInstanceIdともに非null必須）。current判定は
 *   `isCurrentSharedMutationIdentity`。
 * - device-auth-pending-v1: 操作をenqueue（呼び出し）した時点の端末auth identity
 *   （`authSessionIdentityStore`の`AuthIdentity`。ログアウト状態はuserId/sessionInstanceIdが
 *   ともにnullの「実在するidentity状態」であり、偽のsentinelユーザーIDは一切使わない）。
 *   current判定は`getCurrentAuthIdentity()`との両フィールド完全一致。
 *
 * 単一スロット（STORAGE_KEYS.ownerBoundPreferencePending）は両schemaで共有する。
 * 既存のowner-bound-pending-v1の読取り・recovery互換は完全に維持し、未解決の古いpending
 * （どちらのschemaでも）は新しいenvelopeで上書きされない（preflightの既存契約のまま）。
 */
export interface DeviceAuthPendingEnvelope<T> {
  schema: typeof DEVICE_AUTH_PENDING_SCHEMA;
  field: OwnerBoundPreferenceField;
  /** enqueue時点のdevice auth userId。ログアウト状態で開始した操作はnull。 */
  deviceUserId: string | null;
  /** enqueue時点のdevice auth sessionInstanceId。ログアウト・異常セッションはnull。 */
  deviceSessionInstanceId: string | null;
  previousValue: T;
  nextValue: T;
  mutationId: string;
}

export type PendingPreferenceEnvelope<T> = OwnerBoundPendingEnvelope<T> | DeviceAuthPendingEnvelope<T>;

let mutationCounter = 0;

/** デバッグ・ログ用の一意な識別子。値そのものに機能的な意味は無い（順序保証はcoordinator側が担う）。 */
export function buildOwnerBoundMutationId(): string {
  mutationCounter += 1;
  return `obp-${Date.now()}-${mutationCounter}`;
}

function isValidOverlaySettingsValue(value: unknown): value is OverlaySettings {
  return (
    isPlainObject(value) &&
    isBoolean(value.showNormalEvents) &&
    isBoolean(value.showTasks) &&
    isStringArray(value.visibleCalendarIds)
  );
}

function isValidFavoriteCalendarIdsValue(value: unknown): value is string[] {
  return isStringArray(value);
}

function isValidLastUsedCalendarIdValue(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isValidValueForField(field: OwnerBoundPreferenceField, value: unknown): boolean {
  if (field === "overlaySettings") return isValidOverlaySettingsValue(value);
  if (field === "favoriteCalendarIds") return isValidFavoriteCalendarIdsValue(value);
  return isValidLastUsedCalendarIdValue(value);
}

/**
 * [P0120 Group A / G-01] pending envelopeの **identity attribution**。
 * payload/schemaのvalidity（下のPendingJournalReadResult）とは**独立した次元**である。
 * 破損したenvelopeでも「誰の書込みだったか」を証明するフィールドだけは無傷で残りうるため、
 * corrupt判定と同時にこの帰属も返す。
 *
 * - "user":       schemaに応じたownerUserId / deviceUserIdが非空文字列として読めた。
 * - "logged_out": device-auth-pending-v1で deviceUserId === null（＝ログアウト状態で
 *                 開始された正当なlocal-only操作。誰のものでもない）。
 * - "unknown":    トップレベルがオブジェクトでない／schemaが未知／identityフィールド自体が
 *                 不正。**「誰のものでもない」ではなく「誰のものか判らない」**を意味する。
 */
type PendingIdentityAttribution =
  | { kind: "user"; userId: string }
  | { kind: "logged_out" }
  | { kind: "unknown" };

/**
 * [P0120 Group A / G-01] payload validityに一切依存せずidentityだけを取り出す。
 * parsePendingJournalのcorrupt分岐から呼ばれ、「破損＝帰属不明」と畳まないようにする
 * （畳んでいたためA削除がBのenvelopeをglobal quarantine/clearできていた）。
 */
function attributePendingJournalIdentity(raw: unknown): PendingIdentityAttribution {
  if (!isPlainObject(raw)) return { kind: "unknown" };
  if (raw.schema === OWNER_BOUND_PENDING_SCHEMA) {
    return isString(raw.ownerUserId) && raw.ownerUserId.length > 0
      ? { kind: "user", userId: raw.ownerUserId }
      : { kind: "unknown" };
  }
  if (raw.schema === DEVICE_AUTH_PENDING_SCHEMA) {
    if (raw.deviceUserId === null) return { kind: "logged_out" };
    return isString(raw.deviceUserId) && raw.deviceUserId.length > 0
      ? { kind: "user", userId: raw.deviceUserId }
      : { kind: "unknown" };
  }
  // schema自体が読めない以上、他のフィールド名の意味も保証できない。
  return { kind: "unknown" };
}

type PendingJournalReadResult =
  | { kind: "none" }
  | { kind: "valid"; envelope: PendingPreferenceEnvelope<unknown> }
  /**
   * corrupt: recoverableFieldが分かれば「どのフィールドの書込みだったか」だけは判別できた
   * ケース（previousValue/nextValue自体は信頼できない）。分からない場合はnull
   * （schemaやfield自体が不正・トップレベルがオブジェクトでない等）。
   *
   * [P0120 Group A] identityは上記とは独立した次元として常に同伴する
   * （payloadが壊れていても帰属だけは証明できる場合があるため）。
   */
  | {
      kind: "corrupt";
      recoverableField: OwnerBoundPreferenceField | null;
      identity: PendingIdentityAttribution;
    }
  /**
   * P0018セクション2: pending keyのgetItem自体がI/O失敗した状態。「journal無し」とは
   * 明確に区別する（missingへ畳まない）。この状態の間は新規journalを書かず、
   * 既存journal（読めていないだけで実際には存在するかもしれない）をclear/overwriteしない。
   */
  | { kind: "unreadable" };

/**
 * 保留中journalを読み、4状態（none/valid/corrupt/unreadable）で返す内部関数。
 * 既存の公開関数`readPendingOwnerBoundEnvelope`は後方互換のため「corrupt/unreadable→null」を
 * 維持するが、`resolveExistingPendingJournal`はこちらを直接使い、いずれもnoneと
 * 混同しない（P0017セクション7: 破損journalをmissing扱いしない。P0018セクション2:
 * I/O失敗をmissing扱いしない）。
 */
async function parsePendingJournal(): Promise<PendingJournalReadResult> {
  const result = await readJSONStrict<unknown>(STORAGE_KEYS.ownerBoundPreferencePending);
  if (result.kind === "missing") return { kind: "none" };
  if (result.kind === "io-error") return { kind: "unreadable" };
  if (result.kind === "malformed") {
    // JSONとして読めていない。帰属を証明する材料が一切ない。
    return { kind: "corrupt", recoverableField: null, identity: { kind: "unknown" } };
  }
  const raw = result.value;
  const identity = attributePendingJournalIdentity(raw);
  if (
    !isPlainObject(raw) ||
    (raw.schema !== OWNER_BOUND_PENDING_SCHEMA && raw.schema !== DEVICE_AUTH_PENDING_SCHEMA)
  ) {
    return { kind: "corrupt", recoverableField: null, identity };
  }
  const field = raw.field;
  const recoverableField: OwnerBoundPreferenceField | null =
    field === "overlaySettings" || field === "favoriteCalendarIds" || field === "lastUsedCalendarId"
      ? field
      : null;
  if (recoverableField === null) {
    return { kind: "corrupt", recoverableField: null, identity };
  }
  if (
    !isString(raw.mutationId) ||
    !isValidValueForField(recoverableField, raw.previousValue) ||
    !isValidValueForField(recoverableField, raw.nextValue)
  ) {
    return { kind: "corrupt", recoverableField, identity };
  }
  if (raw.schema === OWNER_BOUND_PENDING_SCHEMA) {
    // owner-bound-pending-v1: 既存の検証をそのまま維持（userId/sessionInstanceIdともに
    // 非空文字列必須。nullや空文字列はcorrupt）。
    if (
      !isString(raw.ownerUserId) ||
      raw.ownerUserId.length === 0 ||
      !isString(raw.ownerSessionInstanceId) ||
      raw.ownerSessionInstanceId.length === 0
    ) {
      return { kind: "corrupt", recoverableField, identity };
    }
    return { kind: "valid", envelope: raw as unknown as OwnerBoundPendingEnvelope<unknown> };
  }
  // device-auth-pending-v1: deviceUserId/deviceSessionInstanceIdはnull（ログアウト状態）
  // または非空文字列。undefined（フィールド欠落）・空文字列・その他の型はcorrupt。
  const isValidDeviceIdentityField = (value: unknown): value is string | null =>
    value === null || (isString(value) && value.length > 0);
  if (
    !isValidDeviceIdentityField(raw.deviceUserId) ||
    !isValidDeviceIdentityField(raw.deviceSessionInstanceId)
  ) {
    return { kind: "corrupt", recoverableField, identity };
  }
  return { kind: "valid", envelope: raw as unknown as DeviceAuthPendingEnvelope<unknown> };
}

/**
 * 保留中envelopeを読む。存在しない・破損している・読込み自体に失敗したのいずれも
 * 安全にnullへ縮退する（例外は投げない）。P0015/P0016から後方互換の公開API
 * （「envelopeが今あるかどうか」だけを見たい呼び出し元向け）。内部のrecovery判断は
 * parsePendingJournal（4状態）を直接使う。
 */
export async function readPendingOwnerBoundEnvelope(): Promise<PendingPreferenceEnvelope<unknown> | null> {
  const parsed = await parsePendingJournal();
  if (parsed.kind === "valid") return parsed.envelope;
  if (parsed.kind === "corrupt" && __DEV__) {
    console.warn("[ownerBoundPreferenceRepository] 保留中envelopeの形状が不正なため無視します");
  }
  return null;
}

/** 保留中envelopeを永続化する。失敗時はthrowする（呼び出し元は書込み自体を進めてはいけない）。 */
export async function writePendingOwnerBoundEnvelopeStrict<T>(
  envelope: PendingPreferenceEnvelope<T>
): Promise<void> {
  await writeJSON(STORAGE_KEYS.ownerBoundPreferencePending, envelope);
}

/** 保留中envelopeを消去する。失敗時はthrowする（呼び出し元が結果に応じて扱いを決める）。 */
export async function clearPendingOwnerBoundEnvelopeStrict(): Promise<void> {
  await removeKey(STORAGE_KEYS.ownerBoundPreferencePending);
}

async function writeRepairValueStrict(field: OwnerBoundPreferenceField, value: unknown): Promise<void> {
  if (field === "overlaySettings") {
    await saveOverlaySettings(value as OverlaySettings);
    return;
  }
  if (field === "favoriteCalendarIds") {
    await saveFavoriteCalendarIdsStrict(value as string[]);
    return;
  }
  await saveLastUsedCalendarIdStrict(value as string | null);
}

export interface OwnerBoundPreferenceRawValues {
  overlaySettings: OverlaySettings;
  favoriteCalendarIds: string[];
  lastUsedCalendarId: string | null;
}

/**
 * corrupt journalの「フィールド不明」quarantine、およびdetermineFreshOutcomeで
 * 参照に使う安全な既定値（settingsRepository.tsのDEFAULT_OVERLAY_SETTINGSは
 * 非公開のためここで同値を保持する。BASE_CALENDAR_IDは削除不可の基本カレンダーの
 * ID定数で、常にvisibleCalendarIdsに含めても安全）。
 */
const QUARANTINE_DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  showNormalEvents: true,
  showTasks: true,
  visibleCalendarIds: [BASE_CALENDAR_ID],
};

function defaultValueForField(field: OwnerBoundPreferenceField): unknown {
  if (field === "overlaySettings") return QUARANTINE_DEFAULT_OVERLAY_SETTINGS;
  if (field === "favoriteCalendarIds") return [];
  return null;
}

export interface OwnerBoundPendingResolution {
  /**
   * true: 未解決のjournalが残っている（修復・quarantine writeが失敗した、または
   * journal自体が現時点で読めない）。safeValuesに、そのために安全側へ差し替えるべき
   * フィールドの値が入る（呼び出し元はこの値をfresh readの結果の代わりに使う）。
   */
  stillPending: boolean;
  safeValues: Partial<OwnerBoundPreferenceRawValues>;
}

/**
 * [P0120 Group A] corrupt journalに対するfail-closed quarantine規則（P0017セクション7・
 * P0020セクション2で確立した既存セマンティクスそのまま）を、通常経路
 * （resolveExistingPendingJournal）と所有者限定の整理経路（resolveOwnerBoundPendingForOwner）で
 * 共有するために切り出した。**振る舞いは一切変えていない**——変わったのは
 * 「整理経路がこの規則を呼んでよいのは、対象recordを対象ownerのものだと
 * positivelyに帰属できた場合だけ」という前提条件（呼び出し側）である。
 *
 * - recoverableFieldが分かる: そのフィールドだけを安全な既定値へ書き、成功時のみclear。
 * - 分からない: 3フィールド全てをquarantineし、全write成功時のみclear。
 * - clear失敗はdurability barrier（stillPending=trueを返し、次の新規writeをblockする）。
 */
async function quarantineCorruptJournal(
  recoverableField: OwnerBoundPreferenceField | null
): Promise<OwnerBoundPendingResolution> {
  if (recoverableField) {
    const field = recoverableField;
    const safeDefault = defaultValueForField(field);
    try {
      await writeRepairValueStrict(field, safeDefault);
      await clearPendingOwnerBoundEnvelopeStrict();
      return { stillPending: false, safeValues: {} };
    } catch {
      return {
        stillPending: true,
        safeValues: { [field]: safeDefault } as Partial<OwnerBoundPreferenceRawValues>,
      };
    }
  }
  // journal自体（schema/field）が特定できない: どのフィールドが影響を受けたか
  // 判別できないため、3フィールド全てを安全な既定値へquarantineする。
  const defaults: OwnerBoundPreferenceRawValues = {
    overlaySettings: QUARANTINE_DEFAULT_OVERLAY_SETTINGS,
    favoriteCalendarIds: [],
    lastUsedCalendarId: null,
  };
  const fields: OwnerBoundPreferenceField[] = ["overlaySettings", "favoriteCalendarIds", "lastUsedCalendarId"];
  const results = await Promise.allSettled(fields.map((f) => writeRepairValueStrict(f, defaults[f])));
  const failedFields = fields.filter((_, i) => results[i]!.status === "rejected");
  if (failedFields.length === 0) {
    try {
      await clearPendingOwnerBoundEnvelopeStrict();
      return { stillPending: false, safeValues: {} };
    } catch {
      // P0020セクション2: quarantine writeは全て成功したがclear自体が失敗した。
      // journalはStorageに残ったままなので「未解決」として次の新規writeをblockする
      // （clear成功時のみstillPending=falseにする——durability barrier）。
      return { stillPending: true, safeValues: defaults };
    }
  }
  const safeValues: Partial<OwnerBoundPreferenceRawValues> = {};
  for (const f of failedFields) {
    (safeValues as Record<OwnerBoundPreferenceField, unknown>)[f] = defaults[f];
  }
  return { stillPending: true, safeValues };
}

async function readCurrentFieldStrict(field: OwnerBoundPreferenceField): Promise<FieldStrictReadResult<unknown>> {
  if (field === "overlaySettings") return getOverlaySettingsStrict();
  if (field === "favoriteCalendarIds") return getFavoriteCalendarIdsStrict();
  return getLastUsedCalendarIdStrict();
}

/**
 * 既存の保留中journalを解決する（内部専用）。呼び出し元は必ず
 * `enqueueOwnerBoundPreferenceOperation`でenqueueされた操作の内側からのみ呼ぶこと
 * （この関数自身はenqueueしない。二重にenqueueするとchainがそれ自身の完了を
 * 待つ自己参照になりdeadlockする）。
 *
 * 呼び出し元:
 * - readOwnerBoundPreferencesSafely（起動時・refresh()のsafe read）
 * - AppDataContext.tsxのcommitOwnerBoundLocalPreferenceImpl（新規owner-bound/local-only
 *   writeを始める前のpreflight。P0017セクション4/6: 未解決のpendingが残っている間は
 *   次のjournalを書かない）
 *
 * P0018セクション4: 以前はcurrent owner（自分自身の完了処理の残骸と仮定）のvalid journalを、
 * storageの実値を確認せず無条件にclearしていた。current/staleを問わず、まずfield自体の
 * strict raw値を確認してから解決する:
 * - raw === nextValue: 反映済み。clearして解決。
 * - raw === previousValue: 未反映。clearして解決（previousと同じなので修復不要）。
 * - raw が他のvalid値: previousへstrict repairし、成功した場合のみclear。
 * - raw読込みがinvalid（malformed/不正shape）: previousへstrict repairし、成功した場合のみclear
 *   （読めた上で壊れていると分かっているため、修復を試みる）。
 * - raw読込みがI/O失敗: 修復を試みずjournalを維持する（stillPending=true。リトライに委ねる）。
 * stale ownerは既存どおり常にpreviousへstrict repairする（raw値は判定に使わない。
 * 別identityの書込みは常に元へ戻すべきため）。ただしread error/repair errorでjournalを失わない。
 */
export async function resolveExistingPendingJournal(): Promise<OwnerBoundPendingResolution> {
  const parsed = await parsePendingJournal();

  if (parsed.kind === "none") {
    return { stillPending: false, safeValues: {} };
  }

  if (parsed.kind === "unreadable") {
    // journal自体が今読めない。存在するかもしれない古いjournalをclear/overwriteせず、
    // 新規journalも書かない（呼び出し元のpreflightがこれを見て新規writeをブロックする）。
    //
    // P0019 Batch1.6: journalがunreadableな間はaffected fieldが不明（overlay/favorite/
    // last-usedのどれに対応するpendingだったか判別できない）。safeValuesを空のままにすると、
    // readOwnerBoundPreferencesSafelyがraw値（中断writeの旧owner由来の値かもしれない）を
    // そのまま返してしまい、A→B切替時にAのshared calendar IDがBのReact stateへ漏れる恐れが
    // あった。unreadable中は3フィールド全てを安全な既定値へ差し替える（Storageへの書込みは
    // 一切行わない。読込み障害が解消すれば次回のresolveExistingPendingJournalが既存journalを
    // 通常どおりrecoveryできる）。
    return {
      stillPending: true,
      safeValues: {
        overlaySettings: QUARANTINE_DEFAULT_OVERLAY_SETTINGS,
        favoriteCalendarIds: [],
        lastUsedCalendarId: null,
      },
    };
  }

  if (parsed.kind === "corrupt") {
    return quarantineCorruptJournal(parsed.recoverableField);
  }

  // kind === "valid"
  const envelope = parsed.envelope;
  // [P0102 SEC-F019-F020-006] schemaごとにcurrent判定の主体が異なる:
  // - owner-bound-pending-v1: 共有カレンダー操作のSharedMutationIdentity
  //   （isCurrentSharedMutationIdentity、従来どおり）。
  // - device-auth-pending-v1: envelopeへ記録されたenqueue時点のdevice auth identityと
  //   authSessionIdentityStoreの現在値の両フィールド完全一致（null同士の一致も
  //   「ログアウト状態のまま」という正当なcurrentとして扱う）。
  const isEnvelopeIdentityCurrent = (): boolean => {
    if (envelope.schema === "owner-bound-pending-v1") {
      return isCurrentSharedMutationIdentity({
        userId: envelope.ownerUserId,
        sessionInstanceId: envelope.ownerSessionInstanceId,
      });
    }
    const current = getCurrentAuthIdentity();
    return (
      current.userId === envelope.deviceUserId &&
      current.sessionInstanceId === envelope.deviceSessionInstanceId
    );
  };
  const isCurrent = isEnvelopeIdentityCurrent();

  const repairToPreviousThenClear = async (): Promise<OwnerBoundPendingResolution> => {
    try {
      await writeRepairValueStrict(envelope.field, envelope.previousValue);
      await clearPendingOwnerBoundEnvelopeStrict();
      return { stillPending: false, safeValues: {} };
    } catch {
      // 修復write自体が失敗。envelopeは残したまま（後で再試行できるように、握りつぶさない）。
      return {
        stillPending: true,
        safeValues: { [envelope.field]: envelope.previousValue } as Partial<OwnerBoundPreferenceRawValues>,
      };
    }
  };

  if (!isCurrent) {
    // stale owner: raw値によらず常にpreviousへ戻す。
    return repairToPreviousThenClear();
  }

  const rawResult = await readCurrentFieldStrict(envelope.field);
  // P0020セクション3: raw read自体はawaitを挟むため、この間にidentityが切り替わりうる
  // （A→B・同一ユーザーの別セッションへの切替のいずれも含む）。isCurrentは読込み開始前の
  // snapshotのため、読込み完了直後に再評価する。stale化していた場合は、rawResultの種類
  // （io-error/invalid/value）を問わずcurrent-owner向けの判定を続行せず、stale-ownerと
  // 同じpreviousへのrepairへ合流する（読めていたraw値をReactへ一切露出しない）。
  // [P0102] device-auth-pending-v1でも同じ再評価をschema対応のisEnvelopeIdentityCurrentで行う。
  if (!isEnvelopeIdentityCurrent()) {
    return repairToPreviousThenClear();
  }
  if (rawResult.kind === "io-error") {
    // 読込み自体がI/O失敗。repairを試みず、journalを維持してリトライに委ねる
    // （読めていないのに書込みを試みると、実際には正常だった値を誤って上書きする恐れがある）。
    return {
      stillPending: true,
      safeValues: { [envelope.field]: envelope.previousValue } as Partial<OwnerBoundPreferenceRawValues>,
    };
  }
  if (rawResult.kind === "invalid") {
    // 読めた上でmalformed/不正shapeと判明している。積極的にpreviousへ戻す。
    return repairToPreviousThenClear();
  }
  const raw = rawResult.value;
  if (
    fieldValuesEqual(envelope.field, raw, envelope.nextValue) ||
    fieldValuesEqual(envelope.field, raw, envelope.previousValue)
  ) {
    try {
      await clearPendingOwnerBoundEnvelopeStrict();
      return { stillPending: false, safeValues: {} };
    } catch {
      // P0020セクション2: raw値の検証（next/previousとの一致）自体は成功しているため、
      // その検証済み値はsafe readでそのまま使ってよい。ただしclear自体が失敗した以上、
      // journalはStorageに残ったままなので「未解決」として次の新規writeをblockする。
      return {
        stillPending: true,
        safeValues: { [envelope.field]: raw } as Partial<OwnerBoundPreferenceRawValues>,
      };
    }
  }
  return repairToPreviousThenClear();
}

/**
 * AppDataContext.refresh()（起動時・retryInitialization時）から呼ぶ、owner-bound
 * 3フィールドの安全な読込み。P0017セクション3: 「pending journal解決」と
 * 「overlay/favorite/last-usedのfresh read」を同じenqueueされた1操作の中で行うことで、
 * in-flightのowner-bound write中にこの読込みが割り込む（またはその逆）ことがないようにする。
 * このfresh read自体はUI表示用（Category B/Cのtolerant getter）のままでよい
 * （journal解決の判定ロジックだけが厳密である必要があるため。詳細は
 * resolveExistingPendingJournal/determineFreshOutcomeのdoc参照）。
 */
export function readOwnerBoundPreferencesSafely(): Promise<OwnerBoundPreferenceRawValues> {
  return enqueueOwnerBoundPreferenceOperation(async () => {
    const resolution = await resolveExistingPendingJournal();
    const [overlaySettings, favoriteCalendarIds, lastUsedCalendarId] = await Promise.all([
      getOverlaySettings(),
      getFavoriteCalendarIds(),
      getLastUsedCalendarId(),
    ]);
    const raw: OwnerBoundPreferenceRawValues = { overlaySettings, favoriteCalendarIds, lastUsedCalendarId };
    return resolution.stillPending ? { ...raw, ...resolution.safeValues } : raw;
  });
}

/**
 * [P0104 SEC-F008-F019-F020-001] 対象所有者に束縛された pending envelope の
 * 安全な解決。呼び出し元は対象所有者の識別子を明示する。
 *
 * 破られていた不変条件（P0103指摘）: pending envelopeは「main nextValueが適用済みで、
 * previousValueへのrepairが失敗した」状態を表しうる。その状態ではenvelopeが
 * 「保存されたフィールドが汚染されている可能性」を証明する唯一のdurable recovery authority
 * であり、(a) 正確なpreviousValueがdurablyに復元された後、または (b) 別の厳密な権威ある
 * 解決がフィールドの安全を証明した後にしかclearしてはならない。所有者限定の整理も例外ではない
 * ——P0102までのpurgeは一致するenvelopeを「clearだけ」して復元を行わなかったため、
 * Storage上のstale nextValue（OverlaySettings全体を持つため、変更フィールドがshowTasks等でも
 * 共有カレンダーIDを含みうる）が追跡不能のまま残り、次のユーザーBのrefreshがそれを
 * 正常な現在値として取り込めた。
 *
 * 契約:
 * - `enqueueOwnerBoundPreferenceOperation`で直列化する（通常のpreference transaction・
 *   refresh()のsafe readと同じ1本のchain。削除側の解決が通常操作とjournal clear/writeを
 *   競合させない）。
 * - strict 4状態read（parsePendingJournal）を使う。tolerantな
 *   readPendingOwnerBoundEnvelope()で「unreadableをnone扱い」しない:
 *   - none → "none"（何もしない）。
 *   - unreadable（getItem I/O失敗）→ "unresolved"（存在するかもしれないjournalを
 *     clearせず、完了扱いにもしない。呼び出し元はpartial_retryableでmarkerを残す）。
 *   - corrupt → **[P0120 Group A / G-01で訂正]** まずidentity attributionを見る。
 *     P0104までは「破損journalはどのidentityのものとも証明できない」と仮定して無条件に
 *     quarantine（安全既定値の書込み）+ clear を実行していたが、これは誤りだった——
 *     payloadが壊れていてもownerUserId / deviceUserIdは無傷で残りうる。その場合、
 *     Aの削除がBのStorage（overlay/favorite/last-used）とBのrecovery authorityを
 *     破壊できてしまう。現在は:
 *       * belongs_to_other_identity → "none"（一切触れない）
 *       * logged_out（deviceUserId === null）→ "none"（Aのものではない）
 *       * identity_unknown → "unresolved"（所有権を主張せず、帰属証跡も消さない）
 *       * belongs_to_deleted_user → 承認済みのfail-closed quarantine規則
 *         （quarantineCorruptJournal。安全既定値のwriteが全て成功した場合にのみclear）
 *   - valid → 下記のidentity束縛判定へ。
 * - 両schemaを扱う: owner-bound-pending-v1はownerUserId、device-auth-pending-v1は
 *   deviceUserIdを削除対象userIdと比較する。一致しないenvelope（他ユーザーのもの、
 *   およびdeviceUserId===nullのログアウト状態pending）には一切触れず"none"を返す。
 * - 一致するvalid envelopeは、現在のauth identityが何であるかに関係なく無条件に
 *   「repair→clear」で解決する（repair-before-clear）:
 *     1. envelope.previousValueをaffected fieldへdurablyに書き戻す（writeRepairValueStrict）。
 *     2. repairが成功した場合にのみenvelopeをclearする。
 *   通常のresolveExistingPendingJournalの「current identityならraw値を確認して
 *   repairなしでclearしうる」分岐は使わない——削除済みユーザーのenvelopeは、たとえ
 *   削除処理時点のdevice authがまだそのユーザーのままでも「二度と正当なcurrentに
 *   なり得ない操作の残骸」であり、常にpreviousValueへの復元が安全側である。
 * - repair失敗: envelopeを残したまま"unresolved"（後の再試行で同じ手順を冪等に繰り返せる）。
 * - repair成功後のclear失敗: envelopeが残るため"unresolved"（再試行ではrepairが
 *   同じpreviousValueを冪等に再書込みしてからclearを再試行する。安全）。
 * - "unresolved"を受け取った呼び出し元は既存の保留マーカーを消さず、次回起動時に
 *   本関数を再実行できるようにする。
 */
export type OwnerBoundPendingResolutionOutcome = "none" | "resolved" | "unresolved";

export function resolveOwnerBoundPendingForOwner(
  ownerUserId: string
): Promise<OwnerBoundPendingResolutionOutcome> {
  return enqueueOwnerBoundPreferenceOperation(async () => {
    const parsed = await parsePendingJournal();
    if (parsed.kind === "none") {
      return "none";
    }
    if (parsed.kind === "unreadable") {
      // journal自体が今読めない。「pendingは無かった」と誤認して完了扱いにしない。
      return "unresolved";
    }
    if (parsed.kind === "corrupt") {
      // [P0120 Group A / G-01] payload validityとidentity attributionは独立した次元である。
      // P0104までは、corruptというだけで無条件にquarantine（3フィールドまたはaffected field
      // への安全既定値書込み）+ clear を実行していた。これはenvelopeがBの有効なidentityを
      // 保持していても同じで、A削除がBのStorage/journalを破壊できていた（G-01）。
      // 削除側の権威は「そのrecordがAのものだとpositivelyに証明できた場合」に限る。
      const attribution = parsed.identity;
      if (attribution.kind === "logged_out") {
        // ログアウト状態で開始されたlocal-only操作の残骸。誰のものでもなく、Aのものでもない。
        return "none";
      }
      if (attribution.kind === "unknown") {
        // 帰属が判らない。A削除が所有権を主張してはならず、帰属を証明しうる証跡
        // （envelopeそのもの）を消してもならない。markerを残して再試行に委ねる。
        return "unresolved";
      }
      if (attribution.userId !== ownerUserId) {
        // 他ユーザーのenvelope。payloadが壊れていても、それはそのユーザーのrecovery
        // authorityであり、A削除は一切触れない（cross-identity writeの禁止）。
        return "none";
      }
      // positivelyにA所有と証明できたcorrupt record。承認済みのfail-closed
      // quarantine規則をそのまま適用する（clearされるのはquarantine writeが
      // durablyに成功した場合のみ）。
      const resolution = await quarantineCorruptJournal(parsed.recoverableField);
      return resolution.stillPending ? "unresolved" : "resolved";
    }
    const envelope = parsed.envelope;
    const boundUserId =
      envelope.schema === "owner-bound-pending-v1" ? envelope.ownerUserId : envelope.deviceUserId;
    if (boundUserId !== ownerUserId) {
      // 他ユーザーのenvelope、またはログアウト状態（deviceUserId===null）のenvelope。
      // 削除対象ユーザーのものと証明できない以上、一切触れない。
      return "none";
    }
    try {
      await writeRepairValueStrict(envelope.field, envelope.previousValue);
    } catch {
      // repair自体が失敗。envelopeは唯一のrecovery authorityとして残す。
      return "unresolved";
    }
    try {
      await clearPendingOwnerBoundEnvelopeStrict();
    } catch {
      // repairは成功したがclearが失敗。journalがStorageに残っている以上「解決済み」とは
      // 報告しない（P0020のdurability barrierと同じ規律。再試行は冪等）。
      return "unresolved";
    }
    return "resolved";
  });
}

/**
 * [P0100 SEC-F019-F020-005] `readAndCommitOwnerBoundPreferencesSafely`が返す結果。
 * commitコールバックが実際に呼ばれた場合は"committed"、3箇所の再検証のいずれかで
 * 呼び出し開始時点のidentityから既にstale化していたと判定してcommitを行わなかった場合は
 * "stale_skipped"を返す。呼び出し元（AppDataContext.refresh()）はこの結果を見て
 * 追加の後処理を行う必要はない（stale_skippedの場合、後続の正しいidentityでの
 * refresh呼び出しが改めて自分自身のsnapshotをcommitするため）。
 */
export type OwnerBoundRefreshOutcome =
  | { status: "committed"; values: OwnerBoundPreferenceRawValues }
  | { status: "stale_skipped" };

function isStartingIdentityStale(startingIdentity: AuthIdentity): boolean {
  const current = getCurrentAuthIdentity();
  return current.userId !== startingIdentity.userId || current.sessionInstanceId !== startingIdentity.sessionInstanceId;
}

/**
 * [P0098 CORRECT-F019-F020-004] `readOwnerBoundPreferencesSafely`と同じ
 * 「pending解決→fresh read」に加えて、その結果をReactへ反映する同期commitコールバックまで
 * 同じenqueueされた1操作の中で行う。以前はAppDataContext.refresh()が
 * readOwnerBoundPreferencesSafely()の結果（Promise）をPromise.allの一部として待ち、
 * その解決後（＝enqueueされた操作が既に完了した後）に別途setOverlaySettings等でReactへ
 * 反映していたため、読込みとcommitの間に別の新しいintent（トグル等）がこのchainへ割り込んで
 * 先にcommitすると、その新しい結果をこの古いrefresh由来のスナップショットで
 * 上書きしてしまう窓があった。commitコールバックをenqueueされた操作の内部・最終awaitの直後
 * （P0018セクション6と同じ理由でawaitを挟まない）に呼ぶことで、「このrefreshの読込み開始から
 * commitまでの間に割り込む後続操作が存在しない」ことを直列化キール自体が保証する。
 *
 * [P0100 SEC-F019-F020-005] 上記の直列化だけでは、この操作を開始したrefresh()呼び出し自体が
 * 束縛しているauth identity（userId/sessionInstanceId）とは無関係にcommitしてしまう問題が
 * 残っていた。この操作がenqueueされてから実際に実行されるまでの間（キューが混雑している場合）・
 * 実行中のawait（pending journal解決、Storage read）の間のいずれでも、authSessionIdentityStore上の
 * 現在のidentityがA→Bへ切り替わりうる。切り替わった後にA時点のsnapshotをそのままcommitすると、
 * 本来Bのセッションへ反映されるべきでないAの端末設定値がReact stateへ漏れる。
 *
 * これを防ぐため、呼び出し元（refresh()）はenqueueする直前にauthSessionIdentityStore（React
 * closureではなく、Reactの外側にある権威あるモジュールスコープの正本）からidentityの
 * snapshot（startingIdentity）を取得して渡す。この関数は次の3箇所でstartingIdentityと
 * 現在のidentityを再比較する:
 *   1. pending journal解決・fresh readを始める前（enqueueされた操作が実際に実行され始めた直後）
 *   2. pending journal解決の完了直後
 *   3. overlay/favorite/last-usedのfresh read（Storage read）の完了直後、commitを呼ぶ直前
 *      （P0018セクション6と同じ理由でこのチェックとcommit呼び出しの間にawaitを挟まない。
 *      awaitが無いため、この1つのチェック式が「fresh read完了直後」と「commit直前」を
 *      同時に兼ねる——[P0104 §10] 実装上のチェック式は3つであり、独立した4つ目は存在しない）
 * いずれかの時点でstaleと判定した場合、それ以降の処理（pending journal解決や後続のfresh read）は
 * 行わずstale_skippedを返す。pending journal自体の解決は、envelopeへ書き込まれた
 * ownerUserId/ownerSessionInstanceId基準で独立してcurrent/staleを判定する
 * （resolveExistingPendingJournalのdoc参照）ため、この関数のstartingIdentityとは無関係に
 * 安全に完結する処理であり、ここでskipしても「未解決のまま追跡を失う」ことにはならない
 * （後続の正しいidentityでのrefresh呼び出し、またはcommitOwnerBoundLocalPreferenceImplの
 * preflightが改めてresolveExistingPendingJournalを呼ぶため、解決自体は先送りされるだけである）。
 *
 * 呼び出し元は必ずenqueueされていない外側から呼ぶこと（この関数自身がenqueueするため、
 * 既にenqueueされた操作の内側から呼ぶとchainが自己参照しdeadlockする——
 * resolveExistingPendingJournalのdoc同様の制約）。
 */
export function readAndCommitOwnerBoundPreferencesSafely(
  startingIdentity: AuthIdentity,
  commit: (values: OwnerBoundPreferenceRawValues) => void
): Promise<OwnerBoundRefreshOutcome> {
  return enqueueOwnerBoundPreferenceOperation(async () => {
    if (isStartingIdentityStale(startingIdentity)) {
      return { status: "stale_skipped" };
    }
    const resolution = await resolveExistingPendingJournal();
    if (isStartingIdentityStale(startingIdentity)) {
      return { status: "stale_skipped" };
    }
    const [overlaySettings, favoriteCalendarIds, lastUsedCalendarId] = await Promise.all([
      getOverlaySettings(),
      getFavoriteCalendarIds(),
      getLastUsedCalendarId(),
    ]);
    const raw: OwnerBoundPreferenceRawValues = { overlaySettings, favoriteCalendarIds, lastUsedCalendarId };
    const result = resolution.stillPending ? { ...raw, ...resolution.safeValues } : raw;
    if (isStartingIdentityStale(startingIdentity)) {
      return { status: "stale_skipped" };
    }
    commit(result);
    return { status: "committed", values: result };
  });
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * genericなdeep equalityではなく、フィールドごとの構造を知った上でのvalidated equality
 * （P0017セクション5の指示どおり）。
 */
function fieldValuesEqual(field: OwnerBoundPreferenceField, a: unknown, b: unknown): boolean {
  if (field === "overlaySettings") {
    const av = a as OverlaySettings;
    const bv = b as OverlaySettings;
    return (
      av.showNormalEvents === bv.showNormalEvents &&
      av.showTasks === bv.showTasks &&
      arraysEqual(av.visibleCalendarIds, bv.visibleCalendarIds)
    );
  }
  if (field === "favoriteCalendarIds") {
    return arraysEqual(a as string[], b as string[]);
  }
  return (a as string | null) === (b as string | null);
}

export type OwnerBoundPersistOutcome = "applied" | "not-applied" | "unknown";

/**
 * P0017セクション5: owner-boundのmain persist（persist(nextValue)）がthrowした際に、
 * 「実際にstorageへ反映されたのか」をfresh readで確認する。
 *
 * P0018セクション3: 公開tolerant getter（getOverlaySettings等）は使わない
 * （I/O失敗・JSON parse失敗・不正shapeを安全な既定値へ畳んでしまうため、
 * その既定値がpreviousValue/nextValueのいずれかと偶然一致すると誤った outcome を
 * 返してしまう）。settingsRepository.tsのstrict semantic readerを使い、
 * read失敗・不正shapeは全て"unknown"として扱う（fail closed。呼び出し元はjournalを
 * 保持したままにできる）。
 */
export async function determineFreshOutcome<T>(
  field: OwnerBoundPreferenceField,
  previousValue: T,
  nextValue: T
): Promise<OwnerBoundPersistOutcome> {
  const result = await readCurrentFieldStrict(field);
  if (result.kind !== "value") return "unknown";
  const raw = result.value;
  if (fieldValuesEqual(field, raw, nextValue)) return "applied";
  if (fieldValuesEqual(field, raw, previousValue)) return "not-applied";
  return "unknown";
}
