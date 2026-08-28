import { OverlaySettings, ShareTarget, UserCalendar } from "@/types/event";
import { readJSON, readJSONStrict, writeJSON } from "./storage";
import { STORAGE_KEYS } from "./keys";
import { hasAnyId, readRawArray } from "./arrayRepository";
import {
  isBoolean,
  isNonEmptyString,
  isPlainObject,
  isString,
  isStringArray,
  StoredDataValidationError,
} from "./shapeGuards";

const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  showNormalEvents: true,
  showTasks: true,
  visibleCalendarIds: ["main"],
};

/**
 * 2026-07-31以前の旧スキーマ（表示するカレンダー画面の再設計前）。
 * showPersonal/showStrengthは当時から実質未使用の死フィールドだったため引き継がない。
 */
interface LegacyOverlaySettings {
  showPersonal?: boolean;
  showStrength?: boolean;
  sharedSelectedIds?: string[];
}

/**
 * DATA-F002-002: 構造化された設定（Category B）のため、フィールド単位で実行時の型を検証し、
 * 不正なフィールドだけを正式な既定値へフォールバックする（正常なフィールドは保持する）。
 * オブジェクト自体が壊れている場合（配列・文字列等）も、空オブジェクト相当として扱い
 * 全フィールドを既定値へフォールバックするだけで、例外は投げない
 * （表示設定はCategory Bのため、他の重要データの復元をブロックしてはいけない）。
 */
export async function getOverlaySettings(): Promise<OverlaySettings> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.overlaySettings, DEFAULT_OVERLAY_SETTINGS);
  const stored: Partial<OverlaySettings> & LegacyOverlaySettings = isPlainObject(raw) ? raw : {};
  const validVisibleIds = isStringArray(stored.visibleCalendarIds) ? stored.visibleCalendarIds : undefined;
  const validSharedSelected = isStringArray(stored.sharedSelectedIds) ? stored.sharedSelectedIds : undefined;
  const visibleCalendarIds =
    validVisibleIds ??
    (validSharedSelected ? ["main", ...validSharedSelected] : DEFAULT_OVERLAY_SETTINGS.visibleCalendarIds);
  return {
    // 旧スキーマには「通常の予定」を制御するフィールドが実質存在しなかった
    // （showPersonalは死フィールドで、常に表示されていた）ため、旧データからの
    // 移行時は常にtrueへフォールバックし、既存ユーザーの見え方を変えない。
    showNormalEvents: isBoolean(stored.showNormalEvents) ? stored.showNormalEvents : true,
    showTasks: isBoolean(stored.showTasks) ? stored.showTasks : DEFAULT_OVERLAY_SETTINGS.showTasks,
    visibleCalendarIds,
  };
}

export async function saveOverlaySettings(
  settings: OverlaySettings
): Promise<void> {
  await writeJSON(STORAGE_KEYS.overlaySettings, settings);
}

function isValidShareTarget(value: unknown): value is ShareTarget {
  return isPlainObject(value) && isNonEmptyString(value.id) && isString(value.name);
}

/** 現状書き込み箇所は存在しないが、読み込みは行われるため他の配列データと同じ検証パターンを適用する。 */
export async function getShareTargets(): Promise<ShareTarget[]> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.shareTargets, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidShareTarget);
}

function isValidUserCalendar(value: unknown): value is UserCalendar {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isString(value.name)) return false;
  if (!isString(value.color)) return false;
  if (!isStringArray(value.memberNames)) return false;
  return true;
}

/**
 * DATA-F002-002: マイカレンダーはCategory A（重要データ）。トップレベルが配列でない場合は
 * 安全に部分復元できないためStoredDataValidationErrorをthrowする。配列内の一部要素だけが
 * 壊れている場合は、正常な要素（カスタム名・色を含む）だけを残して返す。
 */
export async function getUserCalendars(): Promise<UserCalendar[]> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.userCalendars, []);
  if (!Array.isArray(raw)) {
    throw new StoredDataValidationError("userCalendars", "not_array");
  }
  const valid = raw.filter(isValidUserCalendar);
  if (valid.length !== raw.length && __DEV__) {
    console.warn(`[settingsRepository] ${raw.length - valid.length}件の不正なカレンダーデータを除外しました`);
  }
  return valid;
}

export type UserCalendarsStrictReadResult =
  | { kind: "io-error" }
  | { kind: "value"; value: UserCalendar[] };

/**
 * [P0098 DATA-F018-004] AppDataContext.refresh()がuserCalendarsの読込み～コミットを
 * localCalendarLifecycleCoordinatorへ完全にenqueueして原子的に行うための、I/O失敗を
 * 呼び出し元が区別できるstrict版reader。
 *
 * 既存の`getUserCalendars()`（tolerant）は、AsyncStorage.getItem自体が失敗した場合も
 * readJSONの`catch`節で既定値`[]`へ静かに畳んでしまう（Category B/Cと同じ扱い）。
 * refresh()がこの空配列をそのままuserCalendarsRef/Reactへコミットしてしまうと、
 * 「storageの読込みが一時的に失敗しただけ」と「実際にカレンダーが0件だった」を
 * 区別できず、既存の有効なメモリ上データを誤った空配列で上書きしてしまう
 * （spec section5「refresh失敗時に既存の有効なメモリ上データを書き換えない」に反する）。
 * I/O失敗の場合だけ呼び出し元が「コミットしない」と判断できるよう種別を分けて返す。
 * missing/malformed/not-arrayの扱いは`getUserCalendars()`と同じ既存の寛容フォールバックの
 * ままで変更しない（このstrict化はI/O失敗の検出だけを目的とする）。
 */
export async function getUserCalendarsStrict(): Promise<UserCalendarsStrictReadResult> {
  const result = await readJSONStrict<unknown>(STORAGE_KEYS.userCalendars);
  if (result.kind === "io-error") {
    return { kind: "io-error" };
  }
  if (result.kind === "missing" || result.kind === "malformed") {
    return { kind: "value", value: [] };
  }
  const raw = result.value;
  if (!Array.isArray(raw)) {
    throw new StoredDataValidationError("userCalendars", "not_array");
  }
  const valid = raw.filter(isValidUserCalendar);
  if (valid.length !== raw.length && __DEV__) {
    console.warn(`[settingsRepository] ${raw.length - valid.length}件の不正なカレンダーデータを除外しました`);
  }
  return { kind: "value", value: valid };
}

/**
 * DATA-F002-004: 呼び出し元は既に形状検証済みの一覧（getUserCalendars()の結果を
 * 元に加工したもの）を渡してくる全件置き換えAPIのため、そのまま書き込むと
 * Storageに混入している不正な形状の要素（この呼び出しとは無関係）を永久に失ってしまう。
 * 生の配列から不正な要素だけを取り出し、書き込む一覧に同じidが含まれるもの
 * （＝この呼び出しで明示的に上書き・削除された対象）を除いて保持する。
 */
export async function saveUserCalendars(calendars: UserCalendar[]): Promise<void> {
  const raw = await readRawArray(STORAGE_KEYS.userCalendars, "userCalendars");
  const targetIds = new Set(calendars.map((c) => c.id));
  const preservedInvalid = raw.filter((el) => !isValidUserCalendar(el) && !hasAnyId(el, targetIds));
  await writeJSON(STORAGE_KEYS.userCalendars, [...calendars, ...preservedInvalid]);
}

/**
 * カレンダーのお気に入り（端末内のみのローカル設定。DBには保存しない）。
 * DATA-F002-002: Category C（補助的データ）のため、不正な形状でもthrowせず安全な既定値[]へ。
 */
export async function getFavoriteCalendarIds(): Promise<string[]> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.favoriteCalendarIds, []);
  return isStringArray(raw) ? raw : [];
}

/**
 * お気に入りは無くても実害が小さい補助的データ（Category C）のため、保存失敗を
 * 呼び出し元へ伝播させない（ベストエフォート。失敗時はwriteJSON内で既にログ済み）。
 * 公開UI APIとしてはこちらが正本（従来どおり）。
 */
export async function saveFavoriteCalendarIds(ids: string[]): Promise<void> {
  await writeJSON(STORAGE_KEYS.favoriteCalendarIds, ids).catch(() => {});
}

/**
 * P0016 Batch1.3: owner-bound local preference（AppDataContext.tsxの
 * commitOwnerBoundLocalPreferenceImpl/ownerBoundPreferenceRepository.ts）の内部専用。
 * 通常利用（公開UI API）は引き続き上のsaveFavoriteCalendarIds（best-effort）を使う——
 * このstrict版は、owner-bound修復（stale化した書込みをpreviousValueへ書き戻す処理）が
 * 書込みの成否を確実に判別できるようにするためだけに存在する。書込み失敗時はthrowする。
 */
export async function saveFavoriteCalendarIdsStrict(ids: string[]): Promise<void> {
  await writeJSON(STORAGE_KEYS.favoriteCalendarIds, ids);
}

/**
 * 予定作成画面で最後に選択したカレンダーID（端末内のみのローカル設定。DBには保存しない）。
 * DATA-F002-002: Category C。不正な形状（文字列でもnullでもない値）は安全にnullへ。
 */
export async function getLastUsedCalendarId(): Promise<string | null> {
  const raw = await readJSON<unknown>(STORAGE_KEYS.lastUsedCalendarId, null);
  if (raw === null) return null;
  return isString(raw) ? raw : null;
}

/**
 * 「最後に選択したカレンダー」も補助的データ（Category C）のため、保存失敗を伝播させない。
 * P0015 Batch1.2、P1: nullを受け付けるのは、shared calendar IDを含む書込みがidentity
 * 切替により完了後にstale判定された場合、呼び出し元（AppDataContext）が書込み前の値へ
 * 書き戻す補償のため（書込み前の値が未設定＝nullだったケースを表現する）。
 */
export async function saveLastUsedCalendarId(calendarId: string | null): Promise<void> {
  await writeJSON(STORAGE_KEYS.lastUsedCalendarId, calendarId).catch(() => {});
}

/**
 * P0016 Batch1.3: saveFavoriteCalendarIdsStrictと同じ理由（owner-bound修復専用）。
 * 通常利用（公開UI API）は引き続き上のsaveLastUsedCalendarId（best-effort）を使う。
 */
export async function saveLastUsedCalendarIdStrict(calendarId: string | null): Promise<void> {
  await writeJSON(STORAGE_KEYS.lastUsedCalendarId, calendarId);
}

/**
 * P0018 Batch1.5セクション3: owner-boundのoutcome判定（determineFreshOutcome）専用の
 * strict semantic reader。上の3つの公開getter（getOverlaySettings/getFavoriteCalendarIds/
 * getLastUsedCalendarId）はCategory B/Cのtolerant readerであり、I/O失敗・JSON parse失敗・
 * 不正shapeのいずれも安全な既定値へ畳んでしまうため、「実際にstorageへ反映されたか」の
 * 確定判定に使うと、read失敗がたまたまpreviousValueと一致した場合に誤ってnot-appliedと
 * 判定してしまう恐れがある。read失敗・不正shapeは"io-error"/"invalid"として区別できるよう、
 * 3フィールドぶんのstrict版を追加する（determineFreshOutcomeはこの2つを一律"unknown"として
 * 扱うが、owner-bound journal解決側（resolveExistingPendingJournal）はI/O失敗と
 * malformed/不正shapeを異なる扱いにする必要があるため、型としては区別を保持する）。
 *
 * key不存在は正式なdefault値としてsemantic化してよい（"value"扱い）。
 * legacy overlay（sharedSelectedIdsのみで構成された旧スキーマ）は、既存の移行規則
 * （["main", ...sharedSelectedIds]）で決定的に変換できる場合に限りvalidとして扱う。
 * それ以外の未知の形は全て"invalid"。
 */
export type FieldStrictReadResult<T> =
  | { kind: "value"; value: T }
  | { kind: "io-error" }
  | { kind: "invalid" };

function isRecognizedLegacyOverlayShape(raw: Record<string, unknown>): boolean {
  if (!isStringArray(raw.sharedSelectedIds)) return false;
  if (raw.showPersonal !== undefined && !isBoolean(raw.showPersonal)) return false;
  if (raw.showStrength !== undefined && !isBoolean(raw.showStrength)) return false;
  if (raw.visibleCalendarIds !== undefined) return false;
  if (raw.showTasks !== undefined) return false;
  return true;
}

export async function getOverlaySettingsStrict(): Promise<FieldStrictReadResult<OverlaySettings>> {
  const result = await readJSONStrict<unknown>(STORAGE_KEYS.overlaySettings);
  if (result.kind === "missing") return { kind: "value", value: DEFAULT_OVERLAY_SETTINGS };
  if (result.kind === "io-error") return { kind: "io-error" };
  if (result.kind === "malformed" || !isPlainObject(result.value)) return { kind: "invalid" };
  const raw = result.value;
  if (isBoolean(raw.showNormalEvents) && isBoolean(raw.showTasks) && isStringArray(raw.visibleCalendarIds)) {
    return {
      kind: "value",
      value: {
        showNormalEvents: raw.showNormalEvents,
        showTasks: raw.showTasks,
        visibleCalendarIds: raw.visibleCalendarIds,
      },
    };
  }
  if (isRecognizedLegacyOverlayShape(raw)) {
    const sharedSelectedIds = raw.sharedSelectedIds as string[];
    return {
      kind: "value",
      value: { showNormalEvents: true, showTasks: true, visibleCalendarIds: ["main", ...sharedSelectedIds] },
    };
  }
  return { kind: "invalid" };
}

export async function getFavoriteCalendarIdsStrict(): Promise<FieldStrictReadResult<string[]>> {
  const result = await readJSONStrict<unknown>(STORAGE_KEYS.favoriteCalendarIds);
  if (result.kind === "missing") return { kind: "value", value: [] };
  if (result.kind === "io-error") return { kind: "io-error" };
  if (result.kind === "malformed" || !isStringArray(result.value)) return { kind: "invalid" };
  return { kind: "value", value: result.value };
}

export async function getLastUsedCalendarIdStrict(): Promise<FieldStrictReadResult<string | null>> {
  const result = await readJSONStrict<unknown>(STORAGE_KEYS.lastUsedCalendarId);
  if (result.kind === "missing") return { kind: "value", value: null };
  if (result.kind === "io-error") return { kind: "io-error" };
  if (result.kind === "malformed") return { kind: "invalid" };
  if (result.value === null || isString(result.value)) return { kind: "value", value: result.value };
  return { kind: "invalid" };
}
