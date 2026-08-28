import AsyncStorage from "@react-native-async-storage/async-storage";
import { isNonEmptyString, isPlainObject, StoredDataValidationError } from "./shapeGuards";

/**
 * DATA-F002-004: Category A配列系リポジトリの共通read-modify-writeヘルパー。
 *
 * 修正前は各`save*`/`delete*`関数が`get*()`（形状検証済みの要素だけを返す）の結果を
 * そのまま書き戻していたため、Storage内に不正な形状の要素が混入している状態で
 * 無関係な保存・削除操作を1件でも行うと、その不正要素がStorageから永久に失われていた。
 * ここでは「トップレベルが配列かどうか」だけを確認した生の配列を返す
 * （要素ごとの形状検証は行わない）。各`save*`/`delete*`関数は、この生配列から
 * 有効な要素と無効な要素を自分で仕分け、無効な要素（操作対象と同じidのものを除く）を
 * 書き戻し時にそのまま保持することで、無関係なデータの恒久喪失を防ぐ。
 *
 * DATA-F002-004残存部分: `readJSON`は「未保存」と「読み込み失敗（getItem例外・JSON構文破損）」を
 * 区別せず両方を空配列へ縮退させる仕様（画面表示用の読み込みとしては意図的かつ既存のまま）。
 * しかしread-modify-writeでこの縮退を使うと、一時的な読み込み失敗の間に空配列を基準として
 * 書き込みが行われ、既存Storageのデータを消してしまう。そのためここでは`readJSON`を経由せず、
 * `AsyncStorage.getItem`を直接呼び、「値が存在しない（=null）」場合だけを空配列として扱い、
 * `getItem`自体の失敗・`JSON.parse`の構文エラー・トップレベル型不正のいずれも例外として
 * 呼び出し元へ伝える（＝後続の書き込みへ進ませない）。保存内容（JSON本文）はエラーメッセージにも
 * ログにも一切含めない。
 */
export async function readRawArray(key: string, logicalName: string): Promise<unknown[]> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch {
    throw new StoredDataValidationError(logicalName, "read_failed");
  }
  if (raw == null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoredDataValidationError(logicalName, "parse_failed");
  }

  if (!Array.isArray(parsed)) {
    throw new StoredDataValidationError(logicalName, "not_array");
  }
  return parsed;
}

/**
 * 要素が指定したidを持つかどうかを、形状の正当性を問わず判定する。
 * 不正な形状の要素であっても、操作対象と同じidを持つものだけは既存仕様どおり
 * 置換・削除の対象にできるようにするために使う（無関係な不正要素の保持とは区別する）。
 */
export function hasId(value: unknown, id: string): boolean {
  return isPlainObject(value) && isNonEmptyString(value.id) && value.id === id;
}

/** 複数idのいずれかに一致するかどうかを判定する（一括削除・一括保存で使う）。 */
export function hasAnyId(value: unknown, ids: ReadonlySet<string>): boolean {
  return isPlainObject(value) && isNonEmptyString(value.id) && ids.has(value.id);
}
