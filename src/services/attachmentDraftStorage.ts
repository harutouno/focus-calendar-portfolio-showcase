import { Directory, File, Paths } from "expo-file-system";

/**
 * 予定本体がまだ保存されていない添付画像の一時保存先（ドラフト領域）。
 *
 * event_attachments.event_id はevents(id)への外部キー（NOT NULL・即時検証・ON DELETE CASCADE）
 * のため、events行が存在しない段階でその添付を正式なrepository（Storage+DB、または端末内の
 * 正式ディレクトリ+メタデータ）へ登録してはいけない。ここはあくまでアプリのドキュメント領域内の
 * ただのファイルであり、Supabase/AsyncStorageのどちらにも一切触れない。
 *
 * パス: attachments/drafts/{draftSessionId}/{attachmentId}.jpg
 * draftSessionIdは予定のevent_idとは別に生成する識別子（概念上分離するため）。
 */

function draftsRootDirectory(): Directory {
  return new Directory(Paths.document, "attachments", "drafts");
}

/**
 * DATA-F002-003: `target`が`root`配下（root自身を含む）に実際に解決されているかを確認する。
 * draftSessionIdは通常generateId()由来の安全な文字列だが、万一この値が改変された
 * AsyncStorageデータ等、信頼できない経路から渡された場合に`../`等でドラフト領域の外側
 * （アプリのドキュメント領域内の他のディレクトリ）を指すURIが構築される可能性を防ぐ。
 * 構築後のURI文字列を検査するだけの単純な確認のため、新しい依存は不要。
 */
function isWithinRoot(root: Directory, target: Directory): boolean {
  return target.uri === root.uri || target.uri.startsWith(`${root.uri}/`);
}

function draftSessionDirectory(draftSessionId: string): Directory {
  const dir = new Directory(draftsRootDirectory(), draftSessionId);
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  return dir;
}

function draftFileName(attachmentId: string): string {
  return `${attachmentId}.jpg`;
}

/** 圧縮済み画像（expo-image-manipulatorの一時キャッシュ）をドラフト用永続領域へコピーする。 */
export async function saveDraftAttachmentFile(
  draftSessionId: string,
  attachmentId: string,
  processedLocalUri: string
): Promise<string> {
  const destination = new File(draftSessionDirectory(draftSessionId), draftFileName(attachmentId));
  if (destination.exists) {
    destination.delete();
  }
  const source = new File(processedLocalUri);
  source.copy(destination);
  return destination.uri;
}

/** 1件分のドラフトファイルを削除する（正式登録成功後、または個別削除時）。存在しなくてもエラーにしない。 */
export async function deleteDraftAttachmentFile(
  draftSessionId: string,
  attachmentId: string
): Promise<void> {
  const file = new File(draftSessionDirectory(draftSessionId), draftFileName(attachmentId));
  if (file.exists) {
    file.delete();
  }
}

/**
 * ドラフトセッション全体を削除する。予定作成をキャンセルした場合、および予定保存後に
 * 添付コミットが一部失敗したまま画面を離れた場合の両方で使う（失敗中のドラフトを保持し
 * 続けない——正式登録済みの添付は別ディレクトリ/Storage/DBにあるため、これでは消えない）。
 * 存在しなくてもエラーにしない。draftSessionIdがドラフト領域の外側を指すよう改変されて
 * いた場合は、安全側として削除自体を行わない（isWithinRoot参照）。
 */
export async function deleteDraftSession(draftSessionId: string): Promise<void> {
  const root = draftsRootDirectory();
  const dir = new Directory(root, draftSessionId);
  if (isWithinRoot(root, dir) && dir.exists) {
    dir.delete();
  }
}

/**
 * DATA-F002-003: アプリ起動時に一度だけ呼ぶ、前回プロセスの孤立ドラフト清掃。
 * 強制終了・クラッシュ等でdeleteDraftSession()が実行されないまま残った
 * attachments/drafts/配下の全サブディレクトリ（＝どのdraftSessionIdも、この関数が
 * 呼ばれた時点ではまだ今回のプロセスで発行されていない）を一括削除する。
 *
 * expo-file-systemのDirectory API（list/delete/create等）はすべて同期呼び出しのため、
 * この関数の内部処理（列挙→削除）はawaitを挟まない1つの同期処理として完結する。
 * そのため、呼び出し元がこの関数の完了を待たずに次の処理へ進んだとしても、
 * その処理が実際に走り出す前にこの関数自体はもう完了している（JSの単一スレッド実行に
 * より、同期処理の途中に他のコードが割り込むことはない）。呼び出し元
 * （AppDataContext.runInitialization）は、UI（event/new.tsx等のドラフト作成画面）が
 * 実際に操作可能になるより前の段階でこれを呼ぶことで、「今回のプロセスで新しく作成された
 * ドラフトを誤って削除する」余地自体をそもそも発生させない設計にしている。
 *
 * 確定済み添付ディレクトリ（attachments/events/）には一切触れない（対象をdrafts/配下に
 * 限定しているため、パスの上でも構造的に混在しない）。個々のディレクトリの削除に失敗しても
 * 他のディレクトリの削除は継続する。この関数自体は例外を投げない
 * （呼び出し元のAppData初期化状態を巻き込まないため）。
 */
export function cleanupOrphanedAttachmentDrafts(): void {
  const root = draftsRootDirectory();
  if (!root.exists) return;
  let entries: (Directory | File)[];
  try {
    entries = root.list();
  } catch (e) {
    if (__DEV__) {
      console.warn(
        "[attachmentDraftStorage] 孤立ドラフトの列挙に失敗しました",
        e instanceof Error ? e.name : "unknown"
      );
    }
    return;
  }
  for (const entry of entries) {
    try {
      entry.delete();
    } catch (e) {
      if (__DEV__) {
        console.warn(
          "[attachmentDraftStorage] 孤立ドラフトの削除に失敗しました（1件、他は継続）",
          e instanceof Error ? e.name : "unknown"
        );
      }
    }
  }
}
