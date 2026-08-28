import { getDatesInRangeByWeekday } from "./recurringDates";
import { TFunction } from "@/i18n/translations";
import { isValidDateOnlyString, isValidTimeString } from "@/storage/shapeGuards";

export interface FieldErrors {
  [field: string]: string | undefined;
}

export function validateNormalEvent(
  input: {
    title: string;
    date: string;
    startTime: string;
    endTime: string;
    allDay: boolean;
  },
  t: TFunction
): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.title.trim()) {
    errors.title = t("validation.titleRequired");
  }
  if (!input.date) {
    errors.date = t("validation.dateRequired");
  } else if (!isValidDateOnlyString(input.date)) {
    // [P0080 DATA-F013-001] 空文字（未入力）は上のdateRequiredで扱う。ここは
    // 「値はあるが形式が不正」（例: 実在しない暦日）を別メッセージで拒否する
    // 防御的チェック（通常のピッカーUIからは到達しない想定の異常系）。
    errors.date = t("validation.dateInvalid");
  }
  if (!input.allDay) {
    if (!input.startTime) {
      errors.startTime = t("validation.startTimeRequired");
    } else if (!isValidTimeString(input.startTime)) {
      errors.startTime = t("validation.timeInvalid");
    }
    if (!input.endTime) {
      errors.endTime = t("validation.endTimeRequired");
    } else if (!isValidTimeString(input.endTime)) {
      errors.endTime = t("validation.timeInvalid");
    }
    // [P0078 CORRECT-F016-001] 以前はendTimeがstartTimeと同日の時刻でのみ後の時刻に
    // なることを要求しており（isTimeAfter）、日付をまたぐ正当な終了時刻
    // （例: 23:40開始→翌日00:40終了）を「終了は開始より後にしてください」として
    // 一律に拒否していた。resolveEndDate（src/utils/time.ts）がendTime<=startTimeを
    // 「翌日」として一意に解釈するため、HH:mmの組み合わせに無効な値は存在しない
    // （常に0分超・24時間以下の正の所要時間になる）。同日限定の順序チェックは削除する。
    // [P0086 SPEC-F016-001] ただしP0078以前から一貫して、開始と終了が完全に同時刻の
    // 場合は無効という仕様（24時間予定という新しい意味を持たせない）は変わっていない。
    // resolveEndDateの<=規約は同時刻を「翌日」側へ倒すが、それをそのまま許可すると
    // 「同時刻＝24時間予定」という、これまで存在しなかった製品仕様を暗黙に作ってしまう
    // ため、日付をまたぐ判定に使う前にここで明示的に拒否する。新しい文言は追加せず、
    // P0078がisTimeAfter削除で使われなくなっていた既存キー（endTimeAfterStart）を
    // そのまま再利用する。
    if (
      input.startTime &&
      input.endTime &&
      isValidTimeString(input.startTime) &&
      isValidTimeString(input.endTime) &&
      input.startTime === input.endTime &&
      !errors.endTime
    ) {
      errors.endTime = t("validation.endTimeAfterStart");
    }
  }
  return errors;
}

export function validateFocusTask(
  input: {
    title: string;
    date: string;
    startTime: string;
    durationMinutes: number;
  },
  t: TFunction
): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.title.trim()) {
    errors.title = t("validation.taskNameRequired");
  }
  if (!input.date) {
    errors.date = t("validation.executionDateRequired");
  } else if (!isValidDateOnlyString(input.date)) {
    errors.date = t("validation.dateInvalid");
  }
  if (!input.startTime) {
    errors.startTime = t("validation.startTimeRequired");
  } else if (!isValidTimeString(input.startTime)) {
    errors.startTime = t("validation.timeInvalid");
  }
  if (!input.durationMinutes || input.durationMinutes <= 0) {
    errors.durationMinutes = t("validation.durationRequired");
  }
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some((v) => !!v);
}

/**
 * 一括作成（期間・曜日指定）フォーム用のバリデーション。
 * 将来のUI（Stage C以降）で使う想定で、既存の単一予定バリデーション
 * （validateNormalEvent/validateFocusTask）には一切手を加えていない。
 *
 * 期間・曜日の妥当性チェックはgetDatesInRangeByWeekday（recurringDates.ts）を
 * そのまま呼び出して判定する（上限値等のロジックを重複実装しない）。
 */
export function validateBulkEventRange(
  input: {
    title: string;
    calendarId: string;
    startDate: string;
    endDate: string;
    weekdays: number[];
    startTime: string;
    endTime: string;
  },
  t: TFunction
): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.title.trim()) {
    errors.title = t("validation.titleRequired");
  }
  if (!input.calendarId) {
    errors.calendarId = t("validation.calendarRequired");
  }
  if (!input.startDate) {
    errors.startDate = t("validation.startDateRequired");
  } else if (!isValidDateOnlyString(input.startDate)) {
    errors.startDate = t("validation.dateInvalid");
  }
  if (!input.endDate) {
    errors.endDate = t("validation.endDateRequired");
  } else if (!isValidDateOnlyString(input.endDate)) {
    errors.endDate = t("validation.dateInvalid");
  }
  if (input.weekdays.length === 0) {
    errors.weekdays = t("validation.weekdayRequired");
  }
  if (!input.startTime) {
    errors.startTime = t("validation.startTimeRequired");
  } else if (!isValidTimeString(input.startTime)) {
    errors.startTime = t("validation.timeInvalid");
  }
  if (!input.endTime) {
    errors.endTime = t("validation.endTimeRequired");
  } else if (!isValidTimeString(input.endTime)) {
    errors.endTime = t("validation.timeInvalid");
  }
  // [P0078 CORRECT-F016-001] validateNormalEventと同じ理由で同日限定の順序チェックを削除。
  // 一括作成の各回もresolveEndDateにより日付をまたぐ終了時刻を正しく表現できる。
  // [P0086 SPEC-F016-001] validateNormalEventと同じ理由で、完全な同時刻のみ明示的に拒否する
  // （既存のendTimeAfterStartキーを再利用、新しい文言は追加しない）。
  if (
    input.startTime &&
    input.endTime &&
    isValidTimeString(input.startTime) &&
    isValidTimeString(input.endTime) &&
    input.startTime === input.endTime &&
    !errors.endTime
  ) {
    errors.endTime = t("validation.endTimeAfterStart");
  }

  if (
    input.startDate &&
    input.endDate &&
    input.weekdays.length > 0 &&
    !errors.startDate &&
    !errors.endDate
  ) {
    try {
      getDatesInRangeByWeekday(
        {
          startDate: input.startDate,
          endDate: input.endDate,
          weekdays: input.weekdays,
        },
        t
      );
    } catch (e) {
      errors.range = e instanceof Error ? e.message : t("validation.rangeFallback");
    }
  }

  return errors;
}
