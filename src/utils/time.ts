/**
 * 時刻（HH:mm, 1分単位）ユーティリティ。
 */
import { SupportedLocale, translate } from "@/i18n/translations";
import { addDays } from "@/utils/date";
import { UserCalendar } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";
import { isValidDateOnlyString, isValidTimeString } from "@/storage/shapeGuards";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** "HH:mm" -> 0〜1439 の分 */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map((v) => parseInt(v, 10));
  return (h % 24) * 60 + (m % 60);
}

/** 0〜1439 の分 -> "HH:mm" */
export function minutesToTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

export function nowHHMM(now: Date = new Date()): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

export function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/** 分単位の所要時間を「n時間m分」（en: "Nh Mm"）表記にする */
export function formatDuration(totalMinutes: number, locale: SupportedLocale = "ja"): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return translate(locale, "common.durationMinutes", { minutes: m });
  if (m <= 0) return translate(locale, "common.durationHours", { hours: h });
  return translate(locale, "common.durationHoursMinutes", { hours: h, minutes: m });
}

/** "YYYY-MM-DD" + "HH:mm" をローカル Date に変換 */
export function combineDateAndTime(dateStr: string, time: string): Date {
  const [y, mo, d] = dateStr.split("-").map((v) => parseInt(v, 10));
  const [h, mi] = time.split(":").map((v) => parseInt(v, 10));
  return new Date(y, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, 0, 0);
}

export function isTimeAfter(a: string, b: string): boolean {
  return timeToMinutes(a) > timeToMinutes(b);
}

/**
 * 現在時刻を30分単位へ切り上げる。
 * 例: 15:01→15:30 / 15:30→15:30（変化なし） / 15:31→16:00 / 23:50→00:00（carryDay=true）
 */
function roundUpToHalfHour(now: Date): { time: string; carryDay: boolean } {
  const rawMinutes = now.getHours() * 60 + now.getMinutes();
  const rounded = Math.ceil(rawMinutes / 30) * 30;
  if (rounded >= 1440) {
    return { time: minutesToTime(0), carryDay: true };
  }
  return { time: minutesToTime(rounded), carryDay: false };
}

/**
 * 新規予定作成画面を開いた瞬間の初期値（日付・開始時刻）を決める純粋関数。
 * タイムラインのタップ位置など、呼び出し元が既に具体的な開始時刻を持っている場合は
 * それを最優先し（params.startTime、1分単位のまま丸めない）、指定が無い場合のみ
 * 「現在時刻を30分単位へ切り上げた時刻」を返す。
 * 日付は、呼び出し元が表示中の日付を明示している場合（params.date）はそれを最優先する。
 * 未指定（今日として自動的に決まる場合）のみ、時刻の切り上げに伴う日付の繰り上げ
 * （例: 23:50→翌日00:00）も反映する——表示中の特定の日付から開いた場合にまで
 * 「現在時刻」由来の日付繰り上げを適用すると、ユーザーが選んでいた日付を無関係な理由で
 * 書き換えてしまうため。
 * 通常予定（app/event/new.tsx）・集中モード（app/focus/new.tsx）の両方がこの関数を
 * 共通で呼ぶことで、初期値の決め方が画面ごとに分岐しないようにする。
 *
 * [P0080 DATA-F013-001] params.date/params.startTimeはURLルートパラメータ（expo-routerの
 * useLocalSearchParams）由来の文字列であり、型としてはstringでも実行時の値は無検証な
 * 任意の文字列になり得る（ディープリンク・手動入力・将来の呼び出し元の実装ミス等）。
 * 不正な形式（例: date="abc"、date="2026-02-30"のような実在しない暦日、
 * startTime="99:99"・"12:60"のような範囲外の時刻）は、正規化して受け入れるのではなく
 * 「未指定」と同じ扱い（＝フォールバック）にする——中途半端に補正した値をそのまま
 * フォーム初期値へ流し込まない。有効な値（例: date="2026-08-11"・startTime="09:07"）は
 * 従来どおり1分単位のまま一切変更せずそのまま使う。
 */
export function resolveDefaultEventStart(
  params: { date?: string; startTime?: string },
  today: string,
  now: Date = new Date()
): { date: string; startTime: string } {
  const validParamDate =
    params.date !== undefined && isValidDateOnlyString(params.date) ? params.date : undefined;
  const validParamStartTime =
    params.startTime !== undefined && isValidTimeString(params.startTime) ? params.startTime : undefined;

  if (validParamStartTime !== undefined) {
    return { date: validParamDate ?? today, startTime: validParamStartTime };
  }
  const { time, carryDay } = roundUpToHalfHour(now);
  const baseDate = validParamDate ?? today;
  const date = carryDay && validParamDate === undefined ? addDays(baseDate, 1) : baseDate;
  return { date, startTime: time };
}

/**
 * 開始時刻(HH:mm) + durationMinutes分後の終了時刻(HH:mm)を返す（新規予定作成の初期値、
 * および開始時刻変更時の自動追従の両方で使う）。
 * [P0078 CORRECT-F016-001] 以前はNormalEvent.dateが開始・終了で共通の単一フィールドで
 * あることを理由に23:59へクランプしていたが、これは「23:40開始→翌日00:40終了」等の
 * 正しい終了時刻を03:59等の誤った同日時刻へ静かに書き換えてしまう実バグだった
 * （正本の禁止事項）。minutesToTime自体が1440分での剰余を取るため、ここでのクランプを
 * 単純に取り除くだけで日付繰り上げを含む正しい時刻が返るようになる。日付繰り上げの
 * 有無自体はこの関数の戻り値だけでは分からないため、呼び出し側は必ずresolveEndDateと
 * 組み合わせてendDateを求めること（NormalEvent.endDateの唯一の正本ロジック）。
 */
export function defaultEndTime(startTime: string, durationMinutes: number = 60): string {
  return minutesToTime(timeToMinutes(startTime) + durationMinutes);
}

/**
 * [P0078 CORRECT-F016-001] 開始(date, startTime)から見て、終了時刻(endTime)の時刻部分が
 * 開始の時刻部分以下（同時刻を含む）であれば、日付が1日繰り上がった（＝翌日）とみなし、
 * そうでなければ同日とみなす——この判定だけでNormalEvent.endDateを一意に決定できる
 * （本アプリの通常予定は複数日にまたがる予定を扱わないため、日付繰り上がりは高々1日分）。
 * defaultEndTimeによる自動計算（0<durationMinutes<1440の範囲）・ユーザーによる終了時刻の
 * 手動編集・開始日付自体の変更のいずれの経路でも、この関数だけを唯一の正本として
 * endDateを再計算する（endDateを独立した状態として個別に追跡・保存しない）。
 */
export function resolveEndDate(date: string, startTime: string, endTime: string): string {
  return timeToMinutes(endTime) <= timeToMinutes(startTime) ? addDays(date, 1) : date;
}

/**
 * 予定作成画面（通常予定・タスク共通）を開いた時点での、保存先カレンダーの初期値を決める。
 * 直前に使ったカレンダー（candidateId）が、選択可能なカレンダー（自分のマイカレンダー、または
 * 閲覧のみでない共有カレンダー）の中に現存すればそれを使う。削除済み・退出済み等で
 * 存在しない場合や、そもそも未設定の場合は"main"（既定のマイカレンダー）にフォールバックする。
 */
export function resolveDefaultCalendarId(
  candidateId: string | null,
  userCalendars: UserCalendar[],
  sharedCalendars: JoinedCalendarSummary[]
): string {
  if (!candidateId) return "main";
  if (candidateId === "main") return "main";
  const existsAsUserCalendar = userCalendars.some((c) => c.id === candidateId);
  const existsAsEditableSharedCalendar = sharedCalendars.some(
    (s) => s.calendar.id === candidateId && s.role !== "viewer"
  );
  return existsAsUserCalendar || existsAsEditableSharedCalendar ? candidateId : "main";
}
