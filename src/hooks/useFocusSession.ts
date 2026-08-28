import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { FocusSession, FocusTask } from "@/types/event";
import {
  appendFocusHistory,
  getActiveFocusSession,
  saveActiveFocusSession,
} from "@/storage/focusSessionRepository";
import { generateId } from "@/utils/id";
import { combineDateAndTime } from "@/utils/time";
import {
  cancelFocusTimerEndNotification,
  reconcileFocusTimerNotification,
  scheduleFocusTimerEndNotification,
} from "@/services/notificationService";
import {
  buildFocusHistoryRecord,
  computeActiveElapsedMs,
  computeTimerSnapshot,
} from "@/services/focusTimerEngine";

/**
 * notificationServiceのFocus専用関数は内部で例外を握りつぶす設計だが、念のためここでも
 * 二重に保護する（万一notificationService側の前提が崩れても、タイマー本体の処理
 * （開始・一時停止・再開・完了・中断・履歴保存）を絶対に失敗させないため）。
 */
async function safeFocusNotificationCall(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (e) {
    console.warn("[useFocusSession] Focus通知の処理に失敗しました", e);
  }
}

interface UseFocusSessionResult {
  session: FocusSession | null;
  remainingMs: number;
  elapsedMs: number;
  progress: number; // 0..1
  isReadyToComplete: boolean;
  isLoaded: boolean;
  start: (
    task: FocusTask,
    sourceType: "local" | "shared",
    calendarNameSnapshot?: string
  ) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  complete: () => Promise<void>;
  cancel: () => Promise<void>;
}

/**
 * 集中セッションの永続タイマー。画面を閉じたりアプリを再起動したりしても、保存済みの
 * actualStartedAt/totalPausedDurationMsから残り時間を再計算できるようにするため、
 * 実際の時間計算は全てsrc/services/focusTimerEngine.ts（純粋関数、正本）へ委ねる。
 * setIntervalは1秒ごとの再描画トリガーとしてのみ使う。
 *
 * onCompletedは「完了ボタンが押され、分析記録の保存とセッションのcompleted化が
 * 両方成功した後」にのみ呼ばれるコールバック（中断=cancel()では呼ばれない）。
 * 呼び出し元がAppDataContextのsaveEvent等を渡すことを想定しているが、このフック自体は
 * AppDataContextに一切依存しない（循環依存を避け、フックを独立したまま保つため）。
 */
export function useFocusSession(
  taskId: string | undefined,
  onCompleted?: () => void | Promise<void>
): UseFocusSessionResult {
  const [session, setSession] = useState<FocusSession | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isLoaded, setIsLoaded] = useState(false);
  const completingRef = useRef(false);

  useEffect(() => {
    (async () => {
      const active = await getActiveFocusSession();
      if (active && (!taskId || active.sourceEventId === taskId)) {
        setSession(active);
      }
      // Active Sessionの実体（taskIdの一致に関わらず、ストレージ上の唯一の値）を基準に
      // Focus通知を整合させる。running かつ 未来なら再予約、paused/終了時刻経過/nullなら取消。
      await safeFocusNotificationCall(() => reconcileFocusTimerNotification(active));
      setIsLoaded(true);
    })();
  }, [taskId]);

  // 1秒ごとの表示更新（時間の正本ではなく、再描画トリガーとしてのみ使う）。
  useEffect(() => {
    if (!session || session.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session]);

  // アプリがフォアグラウンドへ復帰した際、Focus通知のみを軽量に整合させる。
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      setNow(Date.now());
      safeFocusNotificationCall(() => reconcileFocusTimerNotification(session));
    });
    return () => subscription.remove();
  }, [session]);

  // scheduled状態のセッションを、画面が実際にマウントされ最初に評価された瞬間だけ
  // runningへ昇格させる（actualStartedAtをここで一度だけ確定する。以後は
  // status!=="scheduled"になるため、このeffectは再度発火しない）。
  useEffect(() => {
    if (!session || session.status !== "scheduled") return;
    (async () => {
      const nowIso = new Date().toISOString();
      const next: FocusSession = {
        ...session,
        status: "running",
        actualStartedAt: nowIso,
        updatedAt: nowIso,
      };
      await saveActiveFocusSession(next);
      setSession(next);
      setNow(Date.now());
      await safeFocusNotificationCall(() => scheduleFocusTimerEndNotification(next));
    })();
  }, [session]);

  const snapshot = session ? computeTimerSnapshot(session, now) : null;

  // 残り時間が0になった瞬間、一度だけready_to_completeへ遷移させる
  // （カウントダウン・ゲージはこの状態遷移により自然に停止する）。
  useEffect(() => {
    if (!session || session.status !== "running") return;
    if (!snapshot?.isReadyToComplete) return;
    (async () => {
      const nowIso = new Date().toISOString();
      const next: FocusSession = { ...session, status: "ready_to_complete", updatedAt: nowIso };
      await saveActiveFocusSession(next);
      setSession(next);
      await safeFocusNotificationCall(() => cancelFocusTimerEndNotification());
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshotはsession+nowから
    // 毎回新規に計算される値のため、isReadyToCompleteの変化だけを見る
  }, [session, snapshot?.isReadyToComplete]);

  const start = useCallback(
    async (task: FocusTask, sourceType: "local" | "shared", calendarNameSnapshot?: string) => {
      const scheduledStart = combineDateAndTime(task.date, task.startTime);
      const plannedDurationMs = task.durationMinutes * 60000;
      const nowIso = new Date().toISOString();
      const next: FocusSession = {
        id: generateId("session"),
        sourceEventId: task.id,
        sourceCalendarId: task.calendarId,
        sourceType,
        titleSnapshot: task.title,
        calendarNameSnapshot,
        scheduledStartAt: scheduledStart.toISOString(),
        scheduledEndAt: new Date(scheduledStart.getTime() + plannedDurationMs).toISOString(),
        plannedDurationMs,
        actualStartedAt: null,
        status: "scheduled",
        pauseStartedAt: null,
        totalPausedDurationMs: 0,
        interruptionCount: 0,
        completedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await saveActiveFocusSession(next);
      setSession(next);
      setNow(Date.now());
    },
    []
  );

  const pause = useCallback(async () => {
    if (!session || session.status !== "running") return;
    const nowIso = new Date().toISOString();
    const next: FocusSession = {
      ...session,
      status: "paused",
      pauseStartedAt: nowIso,
      interruptionCount: session.interruptionCount + 1,
      updatedAt: nowIso,
    };
    await saveActiveFocusSession(next);
    setSession(next);
    // 一時停止中に終了通知が鳴らないよう、予約中のFocus通知を取り消す。
    await safeFocusNotificationCall(() => cancelFocusTimerEndNotification());
  }, [session]);

  const resume = useCallback(async () => {
    if (!session || session.status !== "paused" || !session.pauseStartedAt) return;
    const nowMs = Date.now();
    const pausedMs = Math.max(0, nowMs - new Date(session.pauseStartedAt).getTime());
    const next: FocusSession = {
      ...session,
      status: "running",
      pauseStartedAt: null,
      totalPausedDurationMs: session.totalPausedDurationMs + pausedMs,
      updatedAt: new Date(nowMs).toISOString(),
    };
    await saveActiveFocusSession(next);
    setSession(next);
    setNow(nowMs);
    // actualStartedAtは変更しない。累積一時停止時間だけを終了予定時刻の計算に反映する。
    await safeFocusNotificationCall(() => scheduleFocusTimerEndNotification(next));
  }, [session]);

  const complete = useCallback(async () => {
    // 1) 二重押下防止（completingRefは同期的に立つため、連打された2回目以降はここで弾かれる）
    if (!session || completingRef.current) return;
    completingRef.current = true;
    try {
      // 2)-5) ここまでstateに保持していたsessionを信用せず、ストレージから最新のセッションを
      // 再取得し、id一致・ready_to_complete・実際の残り時間<=0 を再確認してから確定する
      // （画面の再マウントや通知タップとの競合で古いsessionを掴んでいる可能性を排除するため）。
      const latest = await getActiveFocusSession();
      if (!latest || latest.id !== session.id) return;
      if (latest.status !== "ready_to_complete") return;
      const latestSnapshot = computeTimerSnapshot(latest, Date.now());
      if (latestSnapshot.remainingMs > 0) return;
      // 6)-7) 履歴保存はappendFocusHistory内部でid一致による冪等チェック済み（重複追加されない）。
      const record = buildFocusHistoryRecord(latest, latestSnapshot.elapsedMs, true);
      // 履歴保存を先に確定させる。この後の状態更新・呼び出し元コールバックが失敗しても
      // 記録は既に確定しているため失われない・再試行しても重複しない。
      await appendFocusHistory(record);
      // 8) セッション自体をcompletedへ更新する
      const nowIso = new Date().toISOString();
      const next: FocusSession = { ...latest, status: "completed", completedAt: nowIso, updatedAt: nowIso };
      await saveActiveFocusSession(next);
      setSession(next);
      await safeFocusNotificationCall(() => cancelFocusTimerEndNotification());
      // 10) 元予定の完了更新は呼び出し元のコールバックへ委ねる（完了時のみ呼ぶ。中断では呼ばない）。
      if (onCompleted) {
        await onCompleted();
      }
    } finally {
      completingRef.current = false;
    }
  }, [session, onCompleted]);

  const cancel = useCallback(async () => {
    if (!session || completingRef.current) return;
    if (session.status === "completed" || session.status === "cancelled") return;
    completingRef.current = true;
    try {
      const activeElapsedMs = computeActiveElapsedMs(session, Date.now());
      const record = buildFocusHistoryRecord(session, activeElapsedMs, false);
      await appendFocusHistory(record);
      const nowIso = new Date().toISOString();
      const next: FocusSession = { ...session, status: "cancelled", completedAt: nowIso, updatedAt: nowIso };
      await saveActiveFocusSession(next);
      setSession(next);
      await safeFocusNotificationCall(() => cancelFocusTimerEndNotification());
    } finally {
      completingRef.current = false;
    }
  }, [session]);

  return {
    session,
    remainingMs: snapshot?.remainingMs ?? 0,
    elapsedMs: snapshot?.elapsedMs ?? 0,
    progress: snapshot?.progress ?? 0,
    isReadyToComplete: snapshot?.isReadyToComplete ?? false,
    isLoaded,
    start,
    pause,
    resume,
    complete,
    cancel,
  };
}
