import { TFunction } from "@/i18n/translations";

export interface CalendarOption {
  id: string;
  name: string;
  color: string;
}

/** 画面には出さない通常予定の基本保存先。共有用は利用者が0件から作る。 */
export function getCalendarOptions(t: TFunction): CalendarOption[] {
  return [{ id: "main", name: t("options.mainCalendar"), color: "#2E5FE8" }];
}

/** 集中タスクは常にこの内部カレンダーIDで登録され、通常予定の選択肢には出さない */
export const FOCUS_CALENDAR_ID = "focus";

/**
 * 誰もが最初から持つ、削除できない基本のマイカレンダー（表示名「自分一人用」）のID。
 * 2026-08より前は`userCalendars`に実体を持たない仮想IDとして、各画面が個別に
 * `{ id: "main", name: t("options.mainCalendar") }`をハードコードして扱っていたが、
 * 2026-08以降はAppDataContextが起動時に実体（UserCalendar）を保証するため、
 * このIDは常に`userCalendars`配列内の実在レコードを指す。
 */
export const BASE_CALENDAR_ID = "main";

/**
 * 新規カレンダー作成時に選べる色の候補。
 * Stage 2で`NewCalendarModal.tsx`・`app/calendar/[id]/settings.tsx`に重複していた
 * 同一の配列リテラルを1箇所へ集約した（値・並び順は変更していない）。
 */
export const CALENDAR_COLOR_PALETTE: string[] = [
  "#2E5FE8",
  "#22A06B",
  "#8B5CF6",
  "#F59E0B",
  "#EC4899",
];

export interface RestrictedAppOption {
  id: string;
  name: string;
}

/** 第1工程ではモック選択のみ（OSレベルの実制限は行わない） */
export function getRestrictedAppOptions(t: TFunction): RestrictedAppOption[] {
  return [
    { id: "youtube", name: t("options.restrictedAppYoutube") },
    { id: "x", name: t("options.restrictedAppX") },
    { id: "game", name: t("options.restrictedAppGame") },
    { id: "sns", name: t("options.restrictedAppSns") },
    { id: "browser", name: t("options.restrictedAppBrowser") },
  ];
}

/**
 * 通知プリセット（Stage H-2）。通常予定・一括作成・集中タスクの全フォームで共通。
 * minutes: -1 は「通知しない」（NotificationSetting.enabled = false）を表すUI専用の値で、
 * それ以外はそのまま NotificationSetting.minutesBefore として保存する（0 = 開始時刻）。
 */
export function getNotificationPresets(t: TFunction): { label: string; minutes: number }[] {
  return [
    { label: t("options.notificationNone"), minutes: -1 },
    { label: t("options.notificationAtStart"), minutes: 0 },
    { label: t("options.notification5Min"), minutes: 5 },
    { label: t("options.notification10Min"), minutes: 10 },
    { label: t("options.notification15Min"), minutes: 15 },
    { label: t("options.notification30Min"), minutes: 30 },
    { label: t("options.notification1Hour"), minutes: 60 },
    { label: t("options.notification2Hour"), minutes: 120 },
    { label: t("options.notification1Day"), minutes: 1440 },
  ];
}

export function getRepeatOptions(
  t: TFunction
): { label: string; value: "none" | "daily" | "weekly" | "monthly" | "yearly" }[] {
  return [
    { label: t("options.repeatNone"), value: "none" },
    { label: t("options.repeatDaily"), value: "daily" },
    { label: t("options.repeatWeekly"), value: "weekly" },
    { label: t("options.repeatMonthly"), value: "monthly" },
    { label: t("options.repeatYearly"), value: "yearly" },
  ];
}

export function getUnlockConditionOptions(
  t: TFunction
): { label: string; type: "none" | "calculation" }[] {
  return [
    { label: t("options.unlockConditionNone"), type: "none" },
    { label: t("options.unlockConditionCalculation"), type: "calculation" },
  ];
}
