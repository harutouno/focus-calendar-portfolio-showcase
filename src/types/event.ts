/**
 * 予定・集中タスクのデータモデル定義（第1工程）。
 *
 * 将来のクラウド同期・AI登録の拡張を見据えつつ、第1工程では過剰設計をしない。
 */

/** 繰り返し種別 */
export type RepeatType = "none" | "daily" | "weekly" | "monthly" | "yearly";

export interface RepeatSetting {
  type: RepeatType;
}

/**
 * 通知設定。
 * 通常予定: minutesBefore は 0 分以上で自由入力（第1工程ではプリセットから選択）。
 * 集中タスク: minutesBefore は 0〜60 の範囲に制限される（PROMPT_PHASE1.md の確定仕様）。
 */
export interface NotificationSetting {
  enabled: boolean;
  minutesBefore: number;
}

/** 途中解除の条件（集中タスク用）。第1工程では設定UIのみ。 */
export type UnlockConditionType = "none" | "calculation";

export interface UnlockCondition {
  type: UnlockConditionType;
  /** 計算問題の問題数など、条件の強度を表す数値 */
  count?: number;
}

/** 予定表・共有関連 */
export interface ShareTarget {
  id: string;
  name: string;
}

export interface UserCalendar {
  id: string;
  name: string;
  color: string;
  memberNames: string[];
}

interface BaseEvent {
  /** 一意ID */
  id: string;
  /** 予定名／タスク名 */
  title: string;
  /** ローカル日付 YYYY-MM-DD（端末のローカルタイムゾーン基準） */
  date: string;
  /** 開始時刻 HH:mm（1分単位） */
  startTime: string;
  /** 通知設定 */
  notification: NotificationSetting;
  /** 繰り返し設定 */
  repeat: RepeatSetting;
  /** 予定表ID（個人の予定・仕事など） */
  calendarId: string;
  /** 共有先（ShareTarget の id 一覧） */
  shareWith: string[];
  /** 完了状態 */
  completed: boolean;
  /** メモ */
  memo?: string;
  /**
   * 一括作成（期間・曜日指定）で同時に生成された予定に共通のID。
   * 単発の予定・既存の予定では未設定（undefined）のまま。
   * 各予定は依然として独立した実体として保存され、このIDは将来の
   * 「この予定だけ／これ以降／すべて」編集・削除機能のための紐付け情報にすぎない。
   */
  recurringGroupId?: string;
  /**
   * 同一recurringGroupId内での並び順（0始まり）。「これ以降」判定に使う想定。
   * recurringGroupIdと同様、未設定のままでも既存の動作に影響しない。
   */
  recurrenceIndex?: number;
  /** 作成日時（ISO） */
  createdAt: string;
  /** 更新日時（ISO） */
  updatedAt: string;
}

/** 通常予定（仕事でも私生活でも使える汎用予定） */
export interface NormalEvent extends BaseEvent {
  kind: "normal";
  /** 終了時刻 HH:mm */
  endTime: string;
  /**
   * [P0078 CORRECT-F016-001] 終了時刻の暦日（YYYY-MM-DD）。dateと同一日、またはdateの
   * 翌日のいずれか（本アプリの通常予定は複数日にまたがる予定を扱わない）。未設定
   * （undefined）はdateと同一日を意味する——日付をまたがない通常の予定・全日予定・
   * このフィールド導入以前に保存された既存データはこの値を一切持たない
   * （最小表現・後方互換。読み取り側は必ず`event.endDate ?? event.date`でアクセスする）。
   * src/utils/time.tsのresolveEndDateだけがこの値を計算する唯一の正本。
   */
  endDate?: string;
  /** 終日フラグ（通常予定のみ） */
  allDay: boolean;
  /** 場所（通常予定のみ） */
  location?: string;
}

/** 集中タスク。終日・場所は絶対に持たない。 */
export interface FocusTask extends BaseEvent {
  kind: "focus";
  /** 集中時間（分） */
  durationMinutes: number;
  /** 制限するアプリ（第1工程ではモック選択肢のID配列） */
  restrictedApps: string[];
  /** 途中解除の条件 */
  unlockCondition: UnlockCondition;
}

export type AppEvent = NormalEvent | FocusTask;

export function isFocusTask(event: AppEvent): event is FocusTask {
  return event.kind === "focus";
}

export function isNormalEvent(event: AppEvent): event is NormalEvent {
  return event.kind === "normal";
}

/**
 * 集中モードの実行状態（タイマー復元用）。
 * scheduled: まだ実際には開始していない（画面を開いた瞬間にrunningへ1回だけ遷移する）
 * running/paused: 通常の実行中・一時停止中
 * ready_to_complete: 残り時間が0になり、完了ボタンを押せる状態（カウントダウンは停止済み）
 * completed/cancelled: 終端状態。単一スロットのアクティブセッションストレージには
 *   「直近のセッション」としてこの状態のまま残ることがあるが、新しいセッション開始時に
 *   上書きされる（=次のセッションを開始できる）。
 */
export type FocusSessionStatus =
  | "scheduled"
  | "running"
  | "paused"
  | "ready_to_complete"
  | "completed"
  | "cancelled";

export interface FocusSession {
  /** generateId("session")。再開・再表示のたびに再生成しない */
  id: string;
  sourceEventId: string;
  sourceCalendarId: string;
  sourceType: "local" | "shared";
  /** 開始時点のタイトルスナップショット。開始後に元予定の名前が変わっても追従しない */
  titleSnapshot: string;
  /** 開始時点のカレンダー名スナップショット。titleSnapshotと同じく開始後は追従しない（任意） */
  calendarNameSnapshot?: string;
  /** 予定されていた開始日時（ISO）。通知・開始候補の基準であり、実際の集中時間の計測には使わない */
  scheduledStartAt: string;
  scheduledEndAt: string;
  plannedDurationMs: number;
  /** 実際に集中を開始した日時（ISO）。scheduledの間はnull。running化した瞬間に一度だけ確定し、以後不変 */
  actualStartedAt: string | null;
  status: FocusSessionStatus;
  /** 直近の一時停止開始日時（ISO）。status が paused のときのみ値を持つ */
  pauseStartedAt: string | null;
  /** 一時停止していた時間の累積(ms)。resumeのたびに加算するだけで、actualStartedAtは動かさない */
  totalPausedDurationMs: number;
  interruptionCount: number;
  /** completed/cancelledの終端日時（ISO）として共用 */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 記録画面用：完了・中断した集中セッションの履歴。
 * 既存フィールド（id〜completedFully）は src/utils/focusStats.ts・src/utils/records.ts・
 * app/records.tsx がそのまま読むため一切変更しない。新しいフィールドは追加のみとし、
 * 更新前に保存済みの履歴データもそのまま読める（オプショナル）。
 */
export interface FocusSessionRecord {
  id: string;
  taskId: string;
  taskTitle: string;
  startedAt: string;
  endedAt: string;
  plannedMinutes: number;
  actualMinutes: number;
  /** true: 最後まで完了 / false: 途中解除 */
  completedFully: boolean;

  /** 2026-08: idと同じ値（FocusSession.id）を明示フィールドとしても持つ。冪等性の一意キー。 */
  sessionId?: string;
  sourceEventId?: string;
  scheduledStartAt?: string;
  plannedDurationMs?: number;
  /** 中断時間を除外した実質集中時間(ms)。actualMinutes*60000と同じ値をより精密な単位で持つ */
  actualActiveDurationMs?: number;
  totalPausedDurationMs?: number;
  interruptionCount?: number;
  completionStatus?: "completed" | "abandoned";
  calendarId?: string;
  sourceType?: "local" | "shared";
  /** ローカル日付(YYYY-MM-DD)。日次・週次・月次集計用（scheduledStartAt由来、連続記録判定には使わない） */
  dateKey?: string;

  /** 2026-08: 集中記録・分析システム用に追加。すべて任意＝旧データはそのまま読める。 */
  /** 削除・改名されたカレンダーでも履歴表示が壊れないためのスナップショット */
  calendarNameSnapshot?: string;
  /** 計画時間でクランプ済みの正式な集中時間(秒)。分析はこの値を使う（actualMinutesは待機時間を含み得るため使わない） */
  creditedFocusSeconds?: number;
  /** 完了/中断が確定した時点のローカル日付(YYYY-MM-DD)。連続記録の判定に使う（dateKeyとは別物） */
  localDateKey?: string;
  /** localDateKey確定時点のタイムゾーンオフセット分（Date.getTimezoneOffset()と同じ符号） */
  timezoneOffsetMinutes?: number;
  /** このレコードの形式バージョン。未設定は旧形式（v1未満）とみなす */
  schemaVersion?: number;
}

/** 「表示設定」画面の表示設定 */
export interface OverlaySettings {
  /** 通常の予定を表示するか */
  showNormalEvents: boolean;
  /** タスク（集中モードで実行する予定）を表示するか */
  showTasks: boolean;
  /** 表示対象のカレンダーID一覧。"main"（既定のマイカレンダー）を含め、マイカレンダー・共有カレンダーを同じ配列で統一的に扱う */
  visibleCalendarIds: string[];
}
