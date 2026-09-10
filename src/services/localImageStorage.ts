import { Directory, File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { generateId } from "@/utils/id";

/**
 * マイカレンダー（端末内のみ、ログイン不要）のカバー画像をアプリ専用の永続領域へ保存する。
 * 共有カレンダーがSupabase Storageへアップロードすることのローカル版に相当する——
 * ImagePickerが返すURIは一時領域を指すことがあり、OSに消される可能性があるため、
 * ここで初めて「保存した」と言える永続コピーを作る。
 *
 * 2026-08: 保存前にリサイズ・JPEG再エンコードを1段挟む（一覧・カード表示用の軽量化と、
 * 再エンコードに伴うEXIF自然除去が目的）。正方形への切り抜きは呼び出し側の
 * useImagePicker（allowsEditing+aspect:[1,1]）がOSの標準UIで既に行うため、ここでは
 * 手動クロップは行わない。src/services/attachmentImageProcessor.tsと同じ
 * ImageManipulator.manipulate().resize().renderAsync()→saveAsync(JPEG)パターンを使うが、
 * 添付画像専用のドラフト・容量判定・複数品質ティアのラダーは持ち込まない
 * （カバー画像には添付画像のような厳密なバイト数上限が無いため）。
 *
 * 2026-08（キャッシュ表示の修正）: 以前は`{calendarId}.jpg`という固定ファイル名へ
 * 変更のたびに上書き保存していたが、これはReact Native標準のImageコンポーネント
 * （src/components/calendar/CoverImage.tsxが使用、file://スキーム）が、iOS/Androidの
 * ネイティブ画像デコード・キャッシュ層でURIの「パス」部分をキーにして古いデコード結果を
 * 再利用する可能性を否定できない設計だった。file://はHTTPキャッシュ層を経由しないため
 * ETag/Cache-Control等の仕組みは効かず、クエリ文字列の付与だけで全OS・全バージョンにおいて
 * 確実にキャッシュが無効化される保証が無い。この不確実性を残さないため、画像を変更する
 * たびに物理的に別のファイル（`{calendarId}-{revisionId}.jpg`）へ保存する方式へ変更した
 * ——「同じパスの中身だけが変わる」状況自体を作らないことで、キャッシュ層の実装に
 * 依存せず確実に新しい画像が表示されるようにする。
 * 古いファイルの削除はこの関数の責務外とし、呼び出し側がカレンダーデータの更新に
 * 成功したあとで`deleteLocalCalendarCoverImage`を別途呼ぶ（安全な更新順序：
 * 新画像保存→カレンダーデータ更新→成功後にのみ旧画像削除、を呼び出し側で保証するため）。
 */
const COVERS_DIR_NAME = "calendar-covers";
const COVER_MAX_LONG_EDGE = 512;
const COVER_JPEG_QUALITY = 0.8;

function coversDirectory(): Directory {
  const dir = new Directory(Paths.document, COVERS_DIR_NAME);
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  return dir;
}

/** 変更のたびに衝突しない一意なファイル名を発行する（写真ライブラリの元ファイル名は使わない）。 */
function coverFileName(calendarId: string): string {
  return `${calendarId}-${generateId("rev")}.jpg`;
}

/**
 * 選択された画像をリサイズ・JPEG再エンコードしてから、今回の変更専用の新しい永続ファイルへ
 * 保存し、表示用のURI（キャッシュ回避のクエリ付き）を返す。
 * 古い画像ファイルの削除はここでは行わない（呼び出し側の責務。上記コメント参照）。
 */
export async function saveLocalCalendarCoverImage(
  calendarId: string,
  pickedUri: string
): Promise<string> {
  const context = ImageManipulator.manipulate(pickedUri);
  context.resize({ width: COVER_MAX_LONG_EDGE });
  const rendered = await context.renderAsync();
  const processed = await rendered.saveAsync({
    compress: COVER_JPEG_QUALITY,
    format: SaveFormat.JPEG,
  });

  const destination = new File(coversDirectory(), coverFileName(calendarId));
  if (destination.exists) {
    destination.delete();
  }
  const source = new File(processed.uri);
  source.copy(destination);
  if (source.exists && source.uri !== destination.uri) {
    source.delete();
  }
  return `${destination.uri}?t=${Date.now()}`;
}

/**
 * 保存済みのカバー画像ファイルを削除する（存在しなくてもエラーにしない＝冪等）。
 * 引数には「削除したい対象のcoverImageUriそのもの」を渡す（calendarIdからの逆算はしない）。
 * 新形式（`{calendarId}-{revisionId}.jpg`）・旧形式（`{calendarId}.jpg`固定パス）の
 * どちらのURIを渡してもそのまま同じファイルを指すため、特別な分岐なしに両形式へ対応できる。
 * uriがundefined（画像未設定）の場合は何もしない。
 */
export async function deleteLocalCalendarCoverImage(coverImageUri: string | undefined): Promise<void> {
  if (!coverImageUri) return;
  const path = coverImageUri.split("?")[0];
  const file = new File(path);
  if (file.exists) {
    file.delete();
  }
}
