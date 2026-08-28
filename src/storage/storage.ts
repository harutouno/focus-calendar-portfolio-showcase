import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * AsyncStorage の薄いラッパー。JSON のシリアライズ／デシリアライズと
 * 読み込み失敗時のフォールバックだけを担当する。
 */

/**
 * ローカル永続化（AsyncStorage）への書き込み・削除に失敗したことを表す。
 * key は STORAGE_KEYS の論理的なキー名のみを保持し、保存しようとした値（JSON本体）は
 * 一切含まない（DATA-F002-001 section10のログ禁止事項に合わせるため）。
 */
export class LocalPersistenceError extends Error {
  readonly code = "local_persistence_write_failed" as const;
  readonly operation: "write" | "remove";
  readonly key: string;

  constructor(operation: "write" | "remove", key: string, cause: unknown) {
    // メッセージ先頭に機械可読なコードを埋め込む（friendlyError.tsの既存の文字列一致規約に
    // 合わせるため。他のエラー種別（例: owned_shared_calendar_limit_exceeded）と同じ方式）。
    // key はSTORAGE_KEYSの論理名であり、保存対象の値そのものは含まない。
    super(`local_persistence_${operation}_failed: ${key}`);
    this.name = "LocalPersistenceError";
    this.operation = operation;
    this.key = key;
    this.cause = cause;
  }
}

export async function readJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch (e) {
    console.warn(`[storage] ${key} の読み込みに失敗しました`, e);
    return fallback;
  }
}

/**
 * P0018 Batch1.5: key不存在・getItem失敗（I/O error）・JSON.parse失敗を、
 * 呼び出し元が区別できる形で返すstrict版reader。既存の`readJSON`は
 * UI/Category B/C向けのtolerant readerであり、これら3つを一律fallbackへ畳むため、
 * owner-bound journal/outcome判定（実際にstorageへ反映されたかどうかの確定）には
 * 使えない（畳んだ結果が偶然previousValueと一致すると誤ってnot-appliedと
 * 判定してしまう恐れがあるため）。owner-bound内部専用のprimitiveとして追加する。
 * 既存の`readJSON`/`writeJSON`/`removeKey`の戻り値・ログ・fallback挙動は一切変更しない。
 */
export type StrictJsonReadResult<T> =
  | { kind: "missing" }
  | { kind: "value"; value: T }
  | { kind: "malformed" }
  | { kind: "io-error"; error: unknown };

export async function readJSONStrict<T>(key: string): Promise<StrictJsonReadResult<T>> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (e) {
    return { kind: "io-error", error: e };
  }
  if (raw == null) return { kind: "missing" };
  try {
    return { kind: "value", value: JSON.parse(raw) as T };
  } catch {
    return { kind: "malformed" };
  }
}

/**
 * 保存に成功したときだけ正常終了する。AsyncStorage.setItemが失敗した場合は
 * 以前のようにここで握りつぶさず、LocalPersistenceErrorを投げて呼び出し元へ
 * 失敗を伝える（DATA-F002-001）。呼び出し元は用途に応じてpropagateするか、
 * ベストエフォートとして明示的にcatchするかを選ぶ。
 */
export async function writeJSON<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn(`[storage] ${key} の保存に失敗しました`, e);
    throw new LocalPersistenceError("write", key, e);
  }
}

export async function removeKey(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch (e) {
    console.warn(`[storage] ${key} の削除に失敗しました`, e);
    throw new LocalPersistenceError("remove", key, e);
  }
}
