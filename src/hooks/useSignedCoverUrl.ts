import { useEffect, useState } from "react";
import { resolveCoverStoragePath } from "@/utils/calendarCoverPath";
import { getSignedCoverUrl, peekCachedSignedCoverUrl } from "@/services/calendarCoverUrlCache";

/**
 * カレンダーのカバー画像として保存されている値（DBのcover_image_url、または
 * ローカルカレンダーのcoverImageUri）を、そのまま<CoverImage uri={...}>へ渡せる
 * 表示用URIへ解決するHook。
 *
 * - ローカルカレンダーのfile://等・calendar-covers以外の外部URL・未設定:
 *   値をそのまま素通しする（マイカレンダー画像はこのHookを通しても一切変化しない）。
 * - calendar-covers由来の値（旧公開URL・新形式ベアパスのいずれも）:
 *   短時間キャッシュされた署名付きURLを非同期に解決する。取得できるまで／失敗した場合は
 *   undefinedを返し、CoverImage側の既存フォールバック（テーマカラー＋アイコン）に任せる。
 */
export function useSignedCoverUrl(rawValue: string | undefined): string | undefined {
  const path = rawValue ? resolveCoverStoragePath(rawValue) : null;
  // pathがnull＝署名不要な値（ローカルfile://・未設定・不明な外部URL）はそのまま素通しする。
  const initialResolved = path ? peekCachedSignedCoverUrl(path) : rawValue;
  const [resolved, setResolved] = useState<string | undefined>(initialResolved);

  useEffect(() => {
    if (!path) {
      setResolved(rawValue);
      return;
    }
    let cancelled = false;
    const cached = peekCachedSignedCoverUrl(path);
    setResolved(cached);
    getSignedCoverUrl(path).then((url) => {
      if (!cancelled) setResolved(url ?? undefined);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawValue, path]);

  return resolved;
}
