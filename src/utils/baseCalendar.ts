import { UserCalendar } from "@/types/event";
import { BASE_CALENDAR_ID } from "@/constants/options";
import { colors } from "@/theme/colors";
import { TFunction } from "@/i18n/translations";

/**
 * 2026-08: 誰もが最初から持つ、削除できない基本のマイカレンダー「自分一人用」を
 * userCalendarsへ実体化するための純粋関数。
 *
 * それ以前は`calendarId: "main"`はuserCalendars配列に実データを持たない仮想IDで、
 * 各画面（overlay.tsx、CalendarVisibilityChips.tsx、FocusTaskForm.tsx、
 * NormalEventForm.tsx）がそれぞれ個別に`{ id: "main", name: t("options.mainCalendar") }`
 * というハードコードされた見せかけの行として扱っていた。この関数はそれを1箇所へ集約し、
 * 「無ければ作る・既にあれば触らない」だけを行う。
 *
 * 既に存在する場合は引数と同じ配列参照をそのまま返す（新しい配列を作らない）。
 * これにより呼び出し元（AppDataContext.refresh）は`result !== calendars`の比較だけで
 * 「今回新しく作成が必要だったかどうか」を判定でき、不要な永続化書き込みを避けられる。
 */
export function withBaseCalendarEnsured(
  calendars: UserCalendar[],
  t: TFunction
): UserCalendar[] {
  if (calendars.some((c) => c.id === BASE_CALENDAR_ID)) return calendars;
  const base: UserCalendar = {
    id: BASE_CALENDAR_ID,
    name: t("calendars.baseCalendarName"),
    color: colors.primary,
    memberNames: [],
  };
  return [base, ...calendars];
}
