import { supabase } from "@/lib/supabaseClient";

const CALENDAR_COVERS_BUCKET = "calendar-covers";

/** 署名付きURLの有効期限（秒）。表示のたびに新規発行はせず、この値を基準にメモリ内キャッシュする。 */
export const COVER_SIGNED_URL_TTL_SECONDS = 600;

/** キャッシュの実効有効期間は、期限切れ間際の画像が表示され続けないよう安全マージンを差し引く。 */
const CACHE_REFRESH_MARGIN_MS = 60_000;

interface CacheEntry {
  url: string;
  expiresAtMs: number;
}

/**
 * パス(calendarId/revisionId.jpg)をキーにした署名付きURLのメモリ内キャッシュ。
 * AsyncStorage等へは永続保存しない（アプリ再起動で消える＝意図通り）。
 * 一覧画面で同じパスに対して多重にcreateSignedUrlを呼ばないよう、進行中リクエストも
 * 同じMapで管理し、後続の呼び出しは同じPromiseに相乗りする。
 */
const cache = new Map<string, CacheEntry | Promise<string | null>>();

/** 直近にキャッシュ済みの署名付きURLを同期的に返す（初回描画のちらつき防止用）。無ければundefined。 */
export function peekCachedSignedCoverUrl(path: string): string | undefined {
  const entry = cache.get(path);
  if (!entry || entry instanceof Promise) return undefined;
  if (entry.expiresAtMs - CACHE_REFRESH_MARGIN_MS <= Date.now()) return undefined;
  return entry.url;
}

async function fetchSignedUrl(path: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from(CALENDAR_COVERS_BUCKET)
      .createSignedUrl(path, COVER_SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * 指定パスの署名付きURLを取得する。新鮮なキャッシュがあればそれを返し、無ければ
 * （進行中のリクエストがあれば相乗りしつつ）新規に発行してキャッシュする。
 * 取得に失敗した場合はnullを返す（呼び出し側はテーマカラー＋アイコンへフォールバックする）。
 * 失敗時はキャッシュへ書き込まない＝次回呼び出しでリトライできる。
 */
export async function getSignedCoverUrl(path: string): Promise<string | null> {
  const cached = peekCachedSignedCoverUrl(path);
  if (cached) return cached;

  const existing = cache.get(path);
  if (existing instanceof Promise) return existing;

  const pending = fetchSignedUrl(path).then((url) => {
    if (url) {
      cache.set(path, { url, expiresAtMs: Date.now() + COVER_SIGNED_URL_TTL_SECONDS * 1000 });
    } else {
      cache.delete(path);
    }
    return url;
  });
  cache.set(path, pending);
  return pending;
}
