import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { FocusSessionRecord } from "@/types/event";
import { buildFocusHistoryCsv, buildFocusHistoryCsvFilename, FocusCsvLabels } from "@/utils/focusCsv";

/**
 * 集中記録CSVの書き出し・共有（仕様25番、プレミアム限定）。
 * - 外部サーバーへは一切送信しない。expo-sharingの共有シート（端末標準のOS UI）を経由するのみ。
 * - 一時ファイルはアプリのキャッシュ領域（Paths.cache）にのみ作成し、共有シートを閉じた後
 *   （成功・キャンセル・失敗のいずれでも）必ず削除する。
 */
export class FocusCsvShareUnavailableError extends Error {
  constructor() {
    super("この端末では共有機能を利用できません");
    this.name = "FocusCsvShareUnavailableError";
  }
}

export async function shareFocusHistoryCsv(
  records: FocusSessionRecord[],
  labels: FocusCsvLabels,
  referenceDate: Date = new Date()
): Promise<void> {
  const csvContent = buildFocusHistoryCsv(records, labels);
  const fileName = buildFocusHistoryCsvFilename(referenceDate);
  const file = new File(Paths.cache as Directory, fileName);

  if (file.exists) {
    file.delete();
  }
  file.create();
  file.write(csvContent);

  try {
    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) {
      throw new FocusCsvShareUnavailableError();
    }
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/csv",
      dialogTitle: fileName,
      UTI: "public.comma-separated-values-text",
    });
  } finally {
    // [P0120 Group D / D8 ROBUST-POSTPRIMARY-001-C12 / G-16] 一時ファイルの後始末は
    // 常にbest-effort。従来はfinally内のfile.delete()がthrowすると
    // - 共有が成功していた場合: 成功が失敗へ書き換わる（＝実際には共有できているのに
    //   「書き出せませんでした」と表示される）
    // - 共有が失敗していた場合: 元の（真の原因である）エラーが置き換わる
    // という2方向の誤りが起きた。cleanupの失敗はどちらの結果も再定義しない。
    // 共有前のcreate/write、Sharing.isAvailableAsync/shareAsyncの失敗は従来どおりthrowする。
    try {
      if (file.exists) {
        file.delete();
      }
    } catch (e) {
      if (__DEV__) {
        console.warn("[focusCsvExportService] 一時ファイルの後始末に失敗しました", e);
      }
    }
  }
}
