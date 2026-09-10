const PUBLIC_URL_MARKER = "/object/public/calendar-covers/";
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * 共有カレンダーのcover_image_urlに保存されている値から、calendar-coversバケット内の
 * 相対パスを取り出す。削除（Storage.remove）・表示（署名付きURL発行）の両方で共通利用する。
 *
 * - 旧形式（公開URL、"?t=..."付きも含む）: マーカー以降・"?"より前を抽出して返す。
 * - 新形式（一意なリビジョンパスそのもの、スキーム無し）: そのまま返す。
 * - ローカルカレンダーのfile://等・calendar-covers以外の外部URL: null
 *   （呼び出し側はnullの場合、値をそのまま素通しする＝マイカレンダー画像を壊さない）。
 * - 未設定: null。
 */
export function resolveCoverStoragePath(value: string | undefined | null): string | null {
  if (!value) return null;

  const markerIndex = value.indexOf(PUBLIC_URL_MARKER);
  if (markerIndex !== -1) {
    const path = value.slice(markerIndex + PUBLIC_URL_MARKER.length).split("?")[0];
    return path || null;
  }

  if (SCHEME_PATTERN.test(value)) {
    // file:// ・ content:// ・ 他ドメインの外部URL等、calendar-coversの公開URL
    // パターンに一致しないスキーム付きの値。Storageパスとしては扱わない。
    return null;
  }

  // スキームなし＝新形式のベアパスそのもの（例: "{calendarId}/{revisionId}.jpg"）。
  return value;
}

/**
 * REVISE対応（P0014 Batch1.1、P1-4）: `resolveCoverStoragePath`が返したpathを、
 * 削除操作の対象calendarId（呼び出し元がDB行から読んだ、削除しようとしている
 * カレンダー自身のID）と完全一致するかまで検証する。`deleteCalendarCoverStorageObject`は
 * 削除したいpathしか受け取らず対象calendarIdを知らなかったため、`resolveCoverStoragePath`が
 * 何を返しても対象calendarとの一致をhelper内で検証できなかった（不正・破損した
 * cover_image_url値が、意図しない別カレンダーのStorageオブジェクトを指してしまっても
 * 気づけない）。
 *
 * 一致しない・パストラバーサル疑い・不正な形式のいずれの場合もnullを返す
 * （呼び出し元はStorage削除を一切行わない＝安全側でorphanを残す）。
 * - 保存規約は常に`{calendarId}/{revisionId}.jpg`のちょうど2セグメントのみを許可する
 *   （サブディレクトリを持つ形式は現行の保存規約に存在しないため、丸ごと拒否する）。
 * - percent-encodingは`decodeURIComponent`で1回だけ復号してから判定する
 *   （復号できない＝不正な値として拒否）。Storage APIへ渡す値も復号後の値へ統一する
 *   （自前生成のrevisionIdはpercent-encodingを含まないため、正当な値は復号しても
 *   変化しない）。
 * - 空セグメント・`.`・`..`・先頭スラッシュ・バックスラッシュはいずれも拒否する。
 */
export function resolveCoverStoragePathForCalendar(
  value: string | undefined | null,
  expectedCalendarId: string
): string | null {
  const rawPath = resolveCoverStoragePath(value);
  if (!rawPath) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }

  if (decoded.startsWith("/") || decoded.includes("\\")) return null;

  const segments = decoded.split("/");
  if (segments.length !== 2) return null;
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) return null;

  const [calendarIdSegment, fileSegment] = segments;
  if (calendarIdSegment !== expectedCalendarId) return null;
  if (!fileSegment) return null;

  return decoded;
}
