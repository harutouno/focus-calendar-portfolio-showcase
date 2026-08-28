import { FocusSessionRecord } from "@/types/event";
import { formatLocalDate } from "@/utils/date";
import { resolveCalendarName, resolveCreditedFocusSeconds } from "@/utils/focusStats";

/**
 * 集中記録CSV出力用の純粋関数群（仕様25番）。ファイルI/O・共有処理は
 * src/services/focusCsvExportService.ts側の責務とし、ここでは文字列の組み立てのみを行う
 * （expo-file-system/expo-sharingに依存しないため、モック無しでテストできる）。
 */

const CSV_HEADERS = [
  "recordId",
  "title",
  "calendarName",
  "calendarType",
  "status",
  "plannedDurationMinutes",
  "creditedFocusMinutes",
  "actualStartedAt",
  "completedAt",
  "interruptionCount",
] as const;

export interface FocusCsvLabels {
  unknownCalendar: string;
  calendarTypeMy: string;
  calendarTypeShared: string;
  statusCompleted: string;
  statusIncomplete: string;
}

/**
 * セルの先頭が `=`/`+`/`-`/`@` の場合、先頭に`'`を付けて無害化する（CSVインジェクション対策）。
 * スプレッドシートアプリはこの前置された`'`をテキストとして扱い、数式評価をしない。
 */
export function sanitizeCsvCell(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** CSVフィールドとして安全な形へエスケープする（RFC 4180準拠、カンマ・改行・二重引用符を考慮）。 */
function escapeCsvField(value: string): string {
  const sanitized = sanitizeCsvCell(value);
  if (/[",\r\n]/.test(sanitized)) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

function calendarTypeLabel(
  record: FocusSessionRecord,
  labels: Pick<FocusCsvLabels, "calendarTypeMy" | "calendarTypeShared">
): string {
  if (record.sourceType === "local") return labels.calendarTypeMy;
  if (record.sourceType === "shared") return labels.calendarTypeShared;
  return "";
}

/**
 * 集中履歴レコードをCSV文字列へ変換する（UTF-8 BOM付き、ExcelでのJIS/ANSI誤認識による
 * 文字化けを防ぐ）。改行はCRLF（RFC 4180準拠）。recordsは既に呼び出し元（画面側）で
 * 期間フィルタ済みのものを渡す前提——ここでは期間の絞り込みは行わない
 * （集計ロジックの重複実装を避けるため）。
 */
export function buildFocusHistoryCsv(
  records: FocusSessionRecord[],
  labels: FocusCsvLabels
): string {
  const rows = [CSV_HEADERS.join(",")];
  for (const r of records) {
    const plannedMinutes = Number.isFinite(r.plannedMinutes) ? r.plannedMinutes : 0;
    const creditedMinutes = Math.round(resolveCreditedFocusSeconds(r) / 60);
    const interruptionCount = Number.isFinite(r.interruptionCount) ? (r.interruptionCount as number) : 0;
    const status = r.completedFully ? labels.statusCompleted : labels.statusIncomplete;

    const cells = [
      r.id,
      r.taskTitle,
      resolveCalendarName(r, labels.unknownCalendar),
      calendarTypeLabel(r, labels),
      status,
      String(plannedMinutes),
      String(creditedMinutes),
      r.startedAt,
      r.endedAt,
      String(interruptionCount),
    ];
    rows.push(cells.map((cell) => escapeCsvField(cell)).join(","));
  }
  // Excelがヘッダーに含まれる非ASCII文字（マルチバイト）をANSI/Shift-JISと誤認識し
  // 文字化けするのを防ぐため、UTF-8のBOM(U+FEFF)を先頭に付与する。
  const UTF8_BOM = String.fromCharCode(0xfeff);
  return UTF8_BOM + rows.join("\r\n");
}

/** "focus-calendar-records-YYYY-MM-DD.csv" 形式の固定ファイル名。 */
export function buildFocusHistoryCsvFilename(referenceDate: Date = new Date()): string {
  return `focus-calendar-records-${formatLocalDate(referenceDate)}.csv`;
}
