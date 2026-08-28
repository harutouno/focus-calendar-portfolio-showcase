/**
 * [P0080 DATA-F017-001] 一括作成（期間・曜日指定）の論理的なattemptを識別するための
 * 純粋関数。フォームの入力内容だけから決定的な文字列を作る——生成されたevent id・
 * recurringGroupIdなど「その結果」に依存する値は一切含まない（それらを安定させるために
 * この関数を使うため、循環させない）。
 * 「同じ内容の再送」＝同じfingerprintのときだけevent idを再利用し、内容が少しでも
 * 変われば別のfingerprint（＝別の論理attempt）になる（安全側: 過剰な再利用をしない）。
 */
export interface BulkAttemptFingerprintInput {
  title: string;
  calendarId: string;
  startDate: string;
  endDate: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  memo: string;
  notificationMinutes: number;
}

export function computeBulkAttemptFingerprint(input: BulkAttemptFingerprintInput): string {
  const sortedWeekdays = [...input.weekdays].sort((a, b) => a - b);
  return JSON.stringify({
    title: input.title.trim(),
    calendarId: input.calendarId,
    startDate: input.startDate,
    endDate: input.endDate,
    weekdays: sortedWeekdays,
    startTime: input.startTime,
    endTime: input.endTime,
    memo: input.memo.trim(),
    notificationMinutes: input.notificationMinutes,
  });
}
