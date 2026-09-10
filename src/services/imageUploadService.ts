import { SupabaseClient } from "@supabase/supabase-js";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { isSupabaseConfigured } from "@/lib/supabaseClient";
import { resolveCoverStoragePathForCalendar } from "@/utils/calendarCoverPath";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { generateId } from "@/utils/id";
import { TFunction } from "@/i18n/translations";
import {
  SharedMutationIdentity,
  isCurrentSharedMutationIdentity,
  runCurrentSharedMutation,
} from "@/auth/sharedMutationIdentity";
import {
  captureSharedMutationAuthSnapshot,
  createPinnedSharedClient,
} from "@/auth/sharedMutationAuthSnapshot";

/**
 * REVISE対応（第11ラウンド、P1-2）: stale化した共有カバー画像の補償削除自体が失敗した場合に
 * throwする専用例外。operation内部からthrow（return {error}ではなく）することで、
 * runCurrentSharedMutationの「operationが正常終了した直後の終了時検証」を経由せず
 * （rejectionのためoperation自体が正常終了しない）、外側のcatchまでこのままの型で
 * 伝播させる。これにより、通常のstale拒否（終了時検証によるSTALE_SHARED_MUTATION_IDENTITY_MESSAGE）と、
 * 補償削除自体の失敗を外側のcatchで区別できる。
 */
class SharedCoverStaleCompensationError extends Error {
  readonly code = "shared-cover-stale-compensation-failed";
  constructor() {
    super("shared cover stale compensation failed");
    this.name = "SharedCoverStaleCompensationError";
  }
}

export interface ImageUploadResult {
  /** 成功時: 保存された画像の公開URL（キャッシュ回避のためクエリ付き） */
  url?: string;
  /** 失敗時: 表示言語のエラーメッセージ */
  error?: string;
}

export interface CoverUploadResult {
  /**
   * 成功時: calendar-coversバケット内の相対Storageパス（公開URLではない）。
   * private バケットのため、表示時は毎回 useSignedCoverUrl 経由で署名付きURLを発行する。
   */
  path?: string;
  /** 失敗時: 表示言語のエラーメッセージ */
  error?: string;
}

/**
 * 2026-08: 共有カレンダーのカバー画像専用の前処理・保存パス設計。
 * - リサイズ（長辺1024px）・JPEG再エンコード（副産物としてEXIF自然除去）を、
 *   src/services/{attachmentImageProcessor,localImageStorage}.tsと同じ
 *   ImageManipulator.manipulate().resize().renderAsync()→saveAsync(JPEG)パターンで行う。
 *   呼び出し元（app/calendar/[id]/settings.tsx）は常にaspect:[16,9]でピッカーを開くため、
 *   長辺は常にwidth側になる（縦横比を自前でチェックする必要が無い）。
 * - 保存パスは`{calendarId}/{revisionId}.jpg`という一意なリビジョンファイル名にする
 *   （以前の固定パス`{calendarId}/cover.jpg`は、ローカル保存のマイカレンダー画像で
 *   既に対応した「file://パスをキーにしたネイティブ画像キャッシュが古い内容を
 *   表示し続ける可能性」と同じ問題をSupabase公開URLでも避けられないため）。
 */
const COVER_MAX_LONG_EDGE = 1024;
const COVER_JPEG_QUALITY = 0.8;
const CALENDAR_COVERS_BUCKET = "calendar-covers";

async function processCoverImageForUpload(pickedUri: string): Promise<string> {
  const context = ImageManipulator.manipulate(pickedUri);
  context.resize({ width: COVER_MAX_LONG_EDGE });
  const rendered = await context.renderAsync();
  const processed = await rendered.saveAsync({
    compress: COVER_JPEG_QUALITY,
    format: SaveFormat.JPEG,
  });
  return processed.uri;
}

/**
 * 共有カレンダーのカバー画像ファイルをStorageから削除する（存在しなくてもエラーにしない＝冪等）。
 * 削除したい対象の保存値（旧形式の公開URL・新形式のベアパスのどちらでも）をそのまま渡す —
 * resolveCoverStoragePathForCalendarが両方の形式を解決する。
 * 例外は投げない——呼び出し側は既に新しい画像・DB更新に成功したあとの
 * best-effortな後始末としてこれを呼ぶため、削除に失敗しても新しい設定は取り消さない。
 *
 * REVISE対応（P0014 Batch1.1、P1-4）: `expectedCalendarId`を必須にし、解決したpathが
 * このcalendarId配下でない限りStorage削除を一切行わない（パストラバーサル・破損した
 * cover_image_url値・別カレンダーのpathの誤指定のいずれでも、他カレンダーのcoverを
 * 誤って削除しない安全側へ倒す。不一致時はorphanをそのまま残す）。
 */
/**
 * P0154 (SEC-AUTH-TRANSPORT-001): 本関数は **security-sensitive な Storage 削除**であり、
 * ambient 認可でサイレントに実行されてはならない（正本 §2-C）。identity を必須引数にし、
 * 送出直前に **その所有者であることを証明できる新しいスナップショットを捕捉**してから
 * pinned client で削除する。
 *
 * これは「長レイテンシの post-primary cleanup では、同一 owner/session を証明できた場合に
 * 限り fresh に再捕捉してよい」という正本 §2-C の許可に沿う。
 * **証明できない場合は削除せず orphan を残す**（別アカウントの認可でオブジェクトを
 * 消しに行くことは決してしない）。best-effort の契約（例外を投げない）は不変。
 */
export async function deleteCalendarCoverStorageObject(
  expectedCalendarId: string,
  coverImageUrl: string | undefined,
  identity: SharedMutationIdentity
): Promise<void> {
  const path = resolveCoverStoragePathForCalendar(coverImageUrl, expectedCalendarId);
  if (!path) return;
  try {
    const auth = await captureSharedMutationAuthSnapshot(identity);
    await createPinnedSharedClient(auth).storage.from(CALENDAR_COVERS_BUCKET).remove([path]);
  } catch {
    // best-effort。呼び出し元の処理結果には影響させない。
    // 捕捉失敗（所有者を証明できない）もここに落ちる＝削除せず orphan を残す。
  }
}

/**
 * ローカルファイルURI(uri)をSupabase Storageの指定バケット/パスへアップロードするだけの
 * 低レベル処理（公開URLの取得は行わない）。Storage未設定・オフライン・アップロード失敗・
 * 権限不足のいずれも例外を投げず、`{error}`として返す。
 */
async function uploadFileToBucket(
  bucket: string,
  path: string,
  uri: string,
  t: TFunction,
  // P0154: 送出に使うクライアントは呼び出し元が「1つの論理操作につき1回だけ捕捉した」
  // pinned client を渡す。ambient クライアントを内部で参照しない。
  client: SupabaseClient
): Promise<{ error?: string }> {
  if (!isSupabaseConfigured) {
    return { error: t("imageUploadService.notConfigured") };
  }
  try {
    const response = await fetch(uri);
    const arrayBuffer = await response.arrayBuffer();
    const isPng = uri.toLowerCase().endsWith(".png");
    const contentType = isPng ? "image/png" : "image/jpeg";

    const { error: uploadError } = await client.storage
      .from(bucket)
      .upload(path, arrayBuffer, { contentType, upsert: true });
    if (uploadError) {
      return {
        error: toFriendlyMessage(uploadError.message, t("imageUploadService.uploadFailed"), t),
      };
    }
    return {};
  } catch (e) {
    return {
      error: toFriendlyMessage(
        e instanceof Error ? e.message : undefined,
        t("imageUploadService.uploadFailedNetwork"),
        t
      ),
    };
  }
}

/**
 * ローカルファイルURI(uri)をSupabase Storageの指定バケット/パスへアップロードし、公開URLを
 * 返す。avatarsバケット（公開）用 — calendar-coversはprivateのため別経路
 * （uploadCalendarCoverImage）を使う。
 */
async function uploadToBucket(
  bucket: string,
  path: string,
  uri: string,
  t: TFunction,
  client: SupabaseClient
): Promise<ImageUploadResult> {
  const raw = await uploadFileToBucket(bucket, path, uri, t, client);
  if (raw.error) return { error: raw.error };

  const { data } = client.storage.from(bucket).getPublicUrl(path);
  // 同じパスに上書きしてもキャッシュされた古い画像が表示され続けないよう、更新時刻を付与する
  return { url: `${data.publicUrl}?t=${Date.now()}` };
}

/**
 * 自分のプロフィール画像を更新する。avatarsバケットは本人のみ書き込み可
 * （既存のStorageポリシー）。profiles.avatar_urlの更新も本人のみ可（既存RLS）。
 */
export async function uploadAvatarImage(
  userId: string,
  localUri: string,
  identity: SharedMutationIdentity,
  t: TFunction
): Promise<ImageUploadResult> {
  // Supabase未設定時の既存契約（notConfigured を返す）を維持するため、認可の捕捉より前に判定する。
  if (!isSupabaseConfigured) {
    return { error: t("imageUploadService.notConfigured") };
  }

  // P0154 (SEC-AUTH-TRANSPORT-001): アバターのStorage upload と profiles UPDATE は
  // どちらも auth.uid() で認可される identity-scoped mutation。1つの論理操作なので
  // **認可は1回だけ捕捉**し、両方の送出で同じ pinned client を共有する（正本 §3）。
  let client: SupabaseClient;
  try {
    client = createPinnedSharedClient(await captureSharedMutationAuthSnapshot(identity));
  } catch {
    return { error: t("imageUploadService.uploadFailed") };
  }

  const path = `${userId}/avatar.jpg`;
  const result = await uploadToBucket("avatars", path, localUri, t, client);
  if (!result.url) return result;

  // [P0164 §7] この UPDATE は **primary success として報告される**（成功時に
  // アップロード済み URL を返し、呼び出し元はアバター更新完了として扱う）。
  // したがって行効果の証跡が要る（EFFECT_REQUIRED）。
  // `profiles_update_own` は `using (id = auth.uid())` 形なので、profiles 行が
  // 無い等で条件に合致しないと 0 行・エラー無しで返り、Storage には新しい画像が
  // 上がっているのに DB は元のまま——という不整合を「成功」と表示してしまう。
  const { data, error } = await client
    .from("profiles")
    .update({ avatar_url: result.url })
    .eq("id", userId)
    .select("id");
  if (error) {
    return { error: toFriendlyMessage(error.message, t("imageUploadService.avatarSaveFailed"), t) };
  }
  if ((data ?? []).length === 0) {
    // エラーが無くても効果が無い。成功として返さない。
    return { error: t("imageUploadService.avatarSaveFailed") };
  }
  return result;
}

/**
 * 共有カレンダーのカバー画像を更新する。calendar-coversバケットはprivateで、書き込み・削除は
 * オーナーのみ許可（Storage RLS・update_calendar_cover RPCとも、supabase/migrations/
 * 0009_private_calendar_covers.sql適用後はオーナー限定）。calendars.cover_image_urlには
 * 公開URLではなくバケット内相対パスを保存する（表示は毎回useSignedCoverUrl経由で
 * 署名付きURLを発行する。getPublicUrlはここでは呼ばない）。
 * 保存前にリサイズ・JPEG再エンコードを行い、保存パスは呼び出しごとに一意なリビジョン
 * ファイル名にする（詳細は本ファイル冒頭のコメント参照）。旧ファイルの削除はここでは行わない
 * ——呼び出し側がDB更新の成功を確認したあとで`deleteCalendarCoverStorageObject`を
 * 別途呼ぶ（安全な更新順序を呼び出し側で保証するため、src/services/localImageStorage.tsと
 * 同じ責務分割）。
 */
/**
 * REVISE対応（第10ラウンド、P1-4）: 画像変換・Storageアップロード・RPC更新の各ステップの
 * 間でidentityを再検証する。picker待機中や前段のawait中に既にidentityが切り替わっていれば
 * runCurrentSharedMutationの開始前チェックでアップロード自体を開始しない。Storage
 * アップロード完了後にstale化していた場合は、今アップロードした新規オブジェクトだけを
 * 補償削除してからRPCへは進まない（旧画像には一切触れない——旧画像の削除は呼び出し元が
 * DB更新の成功・identity一致を確認したあとで別途行う既存の責務分割のまま）。補償削除自体が
 * 失敗した場合も、サイレントな成功として返さず追跡可能なエラーとして返す。
 */
export async function uploadCalendarCoverImage(
  calendarId: string,
  localUri: string,
  identity: SharedMutationIdentity,
  t: TFunction
): Promise<CoverUploadResult> {
  // Supabase未設定なら、無駄なリサイズ処理を行う前に早期リターンする
  // （既存のuploadFileToBucket内チェックと同じ判定を、重い処理の手前で先取りするだけ）。
  if (!isSupabaseConfigured) {
    return { error: t("imageUploadService.notConfigured") };
  }

  try {
    return await runCurrentSharedMutation(identity, async (assertCurrent) => {
      let processedUri: string;
      try {
        processedUri = await processCoverImageForUpload(localUri);
      } catch (e) {
        return {
          error: toFriendlyMessage(
            e instanceof Error ? e.message : undefined,
            t("imageUploadService.uploadFailed"),
            t
          ),
        };
      }
      assertCurrent();

      // P0154 (SEC-AUTH-TRANSPORT-001): カバー更新は「Storage upload → (補償 remove) →
      // update_calendar_cover RPC」という**1つの論理操作**である。正本 §3 に従い
      // 認可を1回だけ捕捉し、以降の全送出で同じ pinned client を使う
      // （途中で ambient セッションが切り替わっても認可主体は変わらない）。
      let coverClient: SupabaseClient;
      try {
        coverClient = createPinnedSharedClient(await captureSharedMutationAuthSnapshot(identity));
      } catch {
        // 捕捉できない＝所有者を証明できないため、アップロードを開始しない（fail-closed）。
        return { error: t("imageUploadService.uploadFailed") };
      }

      const path = `${calendarId}/${generateId("rev")}.jpg`;
      const uploadResult = await uploadFileToBucket(
        CALENDAR_COVERS_BUCKET,
        path,
        processedUri,
        t,
        coverClient
      );
      if (uploadResult.error) return { error: uploadResult.error };

      if (!isCurrentSharedMutationIdentity(identity)) {
        // RPC前にstale化していた場合、今アップロードした新規オブジェクトだけを補償削除する。
        // REVISE対応（第11ラウンド、P1-2）: Storageのremove()は失敗時に必ずしもPromiseを
        // rejectするとは限らず、resolvedな{error}として返す場合がある。両方を補償失敗として
        // 扱う。補償が失敗した場合は専用のSharedCoverStaleCompensationErrorをthrowすることで
        // （return {error}ではなく）、直後のassertCurrent()や
        // runCurrentSharedMutationの終了時検証を経由せずに外側のcatchまで伝播させる。
        let removeFailed = false;
        try {
          const { error: removeError } = await coverClient.storage
            .from(CALENDAR_COVERS_BUCKET)
            .remove([path]);
          removeFailed = !!removeError;
        } catch {
          removeFailed = true;
        }
        if (removeFailed) {
          throw new SharedCoverStaleCompensationError();
        }
        assertCurrent();
      }

      const { error } = await coverClient.rpc("update_calendar_cover", {
        p_calendar_id: calendarId,
        p_cover_image_url: path,
      });
      if (error) {
        return { error: toFriendlyMessage(error.message, t("imageUploadService.coverSaveFailed"), t) };
      }
      return { path };
    });
  } catch (e) {
    // REVISE対応（第11ラウンド、P1-2）: 補償削除自体の失敗（SharedCoverStaleCompensationError）は
    // 専用のエラーメッセージへ変換する。それ以外（通常のstale拒否・処理失敗）は、これまでどおり
    // 汎用のuploadFailedへフォールバックする。
    if (e instanceof SharedCoverStaleCompensationError) {
      return { error: t("imageUploadService.staleCompensationFailed") };
    }
    return {
      error: toFriendlyMessage(
        e instanceof Error ? e.message : undefined,
        t("imageUploadService.uploadFailed"),
        t
      ),
    };
  }
}
