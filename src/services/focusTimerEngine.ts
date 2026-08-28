import { FocusSession, FocusSessionRecord } from "@/types/event";
import { formatLocalDate } from "@/utils/date";

/**
 * 集中セッションの残り時間・経過時間計算を行う純粋関数群（タイマーの正本）。
 * setIntervalは1秒ごとの再描画トリガーとしてのみ使い、実際の時間は常にこのファイルの
 * 関数へ Date.now() を渡した結果から導出する（setIntervalの発火回数には一切依存しない。
 * バックグラウンド復帰・画面再マウント後もこの関数を呼び直すだけで正しい値になる）。
 */

export interface TimerSnapshot {
  remainingMs: number;
  elapsedMs: number;
  /** 0..1（経過率） */
  progress: number;
  isReadyToComplete: boolean;
}

/**
 * 現在までに実際に「集中していた」時間(ms)。
 * activeElapsed = now - actualStartedAt - totalPausedDurationMs - (一時停止中なら現在の一時停止分)
 */
export function computeActiveElapsedMs(session: FocusSession, nowMs: number): number {
  if (!session.actualStartedAt) return 0;
  const startedMs = new Date(session.actualStartedAt).getTime();
  const currentPauseMs =
    session.status === "paused" && session.pauseStartedAt
      ? Math.max(0, nowMs - new Date(session.pauseStartedAt).getTime())
      : 0;
  const pausedTotalMs = session.totalPausedDurationMs + currentPauseMs;
  return Math.max(0, nowMs - startedMs - pausedTotalMs);
}

export function computeTimerSnapshot(session: FocusSession, nowMs: number): TimerSnapshot {
  const elapsedMs = computeActiveElapsedMs(session, nowMs);
  const remainingMs = Math.max(0, session.plannedDurationMs - elapsedMs);
  const progress =
    session.plannedDurationMs > 0 ? Math.min(1, elapsedMs / session.plannedDurationMs) : 0;
  return {
    remainingMs,
    elapsedMs,
    progress,
    isReadyToComplete: remainingMs <= 0,
  };
}

/**
 * 残り時間(ms)を表示用文字列へ変換する。
 * 60分ちょうど: "60:00" / 60分を超える: "1:29:45" / 60分未満: "29:45" / 0秒: "00:00"
 * ちょうど60分（3600秒）まではMM:SS形式（分が60まで伸びる）のまま表示し、それを超えた
 * 時点で初めてH:MM:SS形式へ切り替える（負の時間は表示しない。0でクランプ済みの値を渡す
 * 前提だが、念のためここでもクランプする）。
 */
/** focusHistoryレコードの形式バージョン。新規保存時は常にこの値を書き込む */
export const FOCUS_HISTORY_SCHEMA_VERSION = 1;

/**
 * 完了(complete)・中断(cancel)の両方から呼ばれる、履歴レコード生成の正本。
 * activeElapsedMsは呼び出し元がcomputeActiveElapsedMs/computeTimerSnapshotで
 * 計算した「実質集中していた時間」をそのまま渡す（このファイル内では時刻を読まない）。
 *
 * creditedFocusSecondsは計画時間でクランプする＝完了ボタンを押すまで0秒のまま待った時間や
 * 一時停止時間は集中時間として加算しない（actualMinutes/actualActiveDurationMsは
 * 後方互換のため待機時間を含んだ従来値のまま残す。分析側は creditedFocusSeconds を使う）。
 */
export function buildFocusHistoryRecord(
  session: FocusSession,
  activeElapsedMs: number,
  completedFully: boolean
): FocusSessionRecord {
  const nowDate = new Date();
  const nowIso = nowDate.toISOString();
  const creditedFocusSeconds = Math.max(
    0,
    Math.round(Math.min(session.plannedDurationMs, activeElapsedMs) / 1000)
  );
  return {
    id: session.id,
    taskId: session.sourceEventId,
    taskTitle: session.titleSnapshot,
    startedAt: session.actualStartedAt ?? nowIso,
    endedAt: nowIso,
    plannedMinutes: Math.round(session.plannedDurationMs / 60000),
    actualMinutes: Math.round(activeElapsedMs / 60000),
    completedFully,
    sessionId: session.id,
    sourceEventId: session.sourceEventId,
    scheduledStartAt: session.scheduledStartAt,
    plannedDurationMs: session.plannedDurationMs,
    actualActiveDurationMs: activeElapsedMs,
    totalPausedDurationMs: session.totalPausedDurationMs,
    interruptionCount: session.interruptionCount,
    completionStatus: completedFully ? "completed" : "abandoned",
    calendarId: session.sourceCalendarId,
    sourceType: session.sourceType,
    dateKey: formatLocalDate(new Date(session.scheduledStartAt)),
    calendarNameSnapshot: session.calendarNameSnapshot,
    creditedFocusSeconds,
    localDateKey: formatLocalDate(nowDate),
    timezoneOffsetMinutes: nowDate.getTimezoneOffset(),
    schemaVersion: FOCUS_HISTORY_SCHEMA_VERSION,
  };
}

export function formatRemainingClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  if (totalSeconds > 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${pad(minutes)}:${pad(seconds)}`;
}
