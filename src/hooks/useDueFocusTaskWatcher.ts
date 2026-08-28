import { useEffect, useRef, useState } from "react";
import { AppState, AppStateStatus } from "react-native";
import { AppEvent, FocusSession, FocusTask } from "@/types/event";
import { getActiveFocusSession } from "@/storage/focusSessionRepository";
import { findDueFocusTask, findNextScheduledFocusStart } from "@/utils/focusSchedule";

/**
 * setTimeoutの安全な最大遅延（24時間）。JS実装が安全に扱える上限（int32、約24.8日）に対して
 * 十分な安全マージンを持たせつつ、非常に先の集中予定でも最大24時間おきに再評価され続ける
 * （＝日付をまたいだ場合も、この定期的な再評価により自然に追従する。日付境界専用の
 * 特別な監視は別途設けていない）。
 */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * 開始時刻を過ぎている・未開始の集中予定を、通知の予約・受信状態に一切依存せず検出する。
 * 次のタイミングで再判定する:
 * - events（予定一覧）が変化した時
 * - カレンダー画面がフォーカスされた時（isFocused: false→true、または初回マウント時）
 * - AppStateがbackground/inactiveからactiveへ復帰した時（カレンダー画面がフォーカス中の場合のみ）
 * - アプリを開いたまま、監視中の集中予定が開始時刻を迎えた時
 *   （setTimeoutを常に1件だけ使用し、毎秒全予定を走査する方式は取らない）
 *
 * 通知の予約・取消・文言、集中タイマー、専用画面、分析記録には一切関与しない
 * （findDueFocusTask/findNextScheduledFocusStartという既存の純粋関数の結果をもとに、
 * 案内バー用のstateを切り替えるだけ）。
 *
 * カレンダー画面が実際にフォーカスされていない間は、常にnullを返す
 * （＝新規表示だけでなく、既に検出済みの案内も非フォーカス中は表示しない）。
 *
 * dismiss()で閉じた集中予定は、そのアプリ起動中は候補から除外される（findDueFocusTaskへ
 * dismiss済みIDの集合を渡すことで、より開始時刻の早い既dismiss予定が、後続の未dismiss予定を
 * 永久に塞いでしまわないようにしている。2026-08対応）。
 */
export function useDueFocusTaskWatcher(
  events: AppEvent[],
  isFocused: boolean
): { dueFocusTask: FocusTask | null; dismiss: () => void } {
  const [rawDueTask, setRawDueTask] = useState<FocusTask | null>(null);
  // ユーザーが閉じた集中予定のeventIdの集合。1件だけでなく複数保持できるようにし
  // （予定Aを閉じた後に予定Bも閉じる、といった連続dismissでも両方を再表示しないため）、
  // AsyncStorage等への永続化はしない（アプリプロセス内のメモリのみ、既存仕様どおり
  // 再起動でリセットされる）。
  const [dismissedEventIds, setDismissedEventIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  const eventsRef = useRef(events);
  eventsRef.current = events;
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  const rawDueTaskRef = useRef(rawDueTask);
  rawDueTaskRef.current = rawDueTask;
  const dismissedEventIdsRef = useRef(dismissedEventIds);
  dismissedEventIdsRef.current = dismissedEventIds;

  // すべての内部状態・関数を1つのオブジェクトへまとめ、マウント時に一度だけ生成する。
  // 各関数は呼び出し時点で常にeventsRef/isFocusedRef（上のref）とstate（下のmutableな
  // フィールド）を読むため、再生成の必要が無く、相互再帰（tick→scheduleNextCheck→
  // setTimeout→tick）も安全に組める。
  const controllerRef = useRef<{
    clearScheduledCheck: () => void;
    scheduleNextCheck: () => void;
    evaluate: () => Promise<void>;
    tick: () => void;
  } | null>(null);

  if (!controllerRef.current) {
    const state: { activeSession: FocusSession | null; timeoutId: ReturnType<typeof setTimeout> | null; generation: number } = {
      activeSession: null,
      timeoutId: null,
      generation: 0,
    };

    const clearScheduledCheck = () => {
      if (state.timeoutId != null) {
        clearTimeout(state.timeoutId);
        state.timeoutId = null;
      }
    };

    const scheduleNextCheck = () => {
      clearScheduledCheck();
      if (!isFocusedRef.current) return;
      const next = findNextScheduledFocusStart(eventsRef.current, Date.now(), state.activeSession);
      if (!next) return;
      const rawDelay = next.scheduledStartTimestamp - Date.now();
      const delay = Math.max(0, Math.min(rawDelay, MAX_TIMEOUT_MS));
      state.timeoutId = setTimeout(() => {
        state.timeoutId = null;
        tick();
      }, delay);
    };

    const evaluate = async () => {
      const generation = ++state.generation;
      let session: FocusSession | null;
      try {
        session = await getActiveFocusSession();
      } catch {
        session = null;
      }
      // 呼び出し中に、より新しいevaluate()が開始されていた場合はこの結果を破棄する
      // （古い非同期応答が新しい判定結果を上書きしないようにするため）。
      if (generation !== state.generation) return;
      state.activeSession = session;
      setRawDueTask(
        findDueFocusTask(eventsRef.current, Date.now(), session, dismissedEventIdsRef.current) ??
          null
      );
    };

    const tick = () => {
      // 呼び出された時点で古い監視timeoutは即座に（同期的に）解除する。evaluate()の解決を
      // 待ってからだと、その間に古いtimeoutが発火してしまう可能性がわずかに残るため。
      clearScheduledCheck();
      void evaluate().then(scheduleNextCheck);
    };

    controllerRef.current = { clearScheduledCheck, scheduleNextCheck, evaluate, tick };
  }
  const controller = controllerRef.current;

  // events変化・カレンダー画面のフォーカス変化のいずれでも再評価する
  // （1つの effect にまとめることで、マウント時に2つの effect が同時に
  // evaluate()を呼んで監視timeoutの設定・解除が競合するのを避ける）。
  // フォーカスされている間は再評価し、blurしている間はtimeoutだけ解除する
  // （画面がフォーカスされていない間は新たに監視timeoutを持たない）。
  useEffect(() => {
    if (isFocused) {
      controller.tick();
    } else {
      controller.clearScheduledCheck();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, isFocused]);

  // AppStateのbackground/inactive→active復帰を検出する（listenerは1つだけ登録し、
  // アンマウント時に解除する）。カレンダー画面がフォーカスされている場合のみ再評価する。
  // フォーカスされていない場合は何もせず、後でフォーカスされた時の再評価に任せる。
  useEffect(() => {
    // マウント直後はJSが実行できている＝実質フォアグラウンドとみなし"active"を初期値とする
    // （react-nativeのjestモック環境ではAppState.currentStateがそのまま文字列を返さないため、
    // ここから読み取らない設計にしている）。以降はこのeffect内で"change"イベントのたびに
    // 更新される値だけを見るため、実機挙動には影響しない。
    let previousState: AppStateStatus = "active";
    const subscription = AppState.addEventListener("change", (nextState) => {
      const cameToForeground =
        (previousState === "background" || previousState === "inactive") &&
        nextState === "active";
      const wentToBackground =
        previousState === "active" && (nextState === "background" || nextState === "inactive");
      previousState = nextState;
      if (cameToForeground && isFocusedRef.current) {
        controller.tick();
      } else if (wentToBackground) {
        // background中はJS側のtimeoutに依存しない（発火が保証されないため）。
        // 監視timeoutは一旦解除し、foreground復帰時の再評価（上のcameToForeground分岐）を
        // 正本として再設定する。
        controller.clearScheduledCheck();
      }
    });
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // アンマウント時に監視timeoutを解除する。
  useEffect(() => {
    return () => controller.clearScheduledCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // events変化のたびに、現在のeventsに存在しないdismiss済みIDを間引く（削除済み予定の
  // IDがSetに残り続けて肥大化しないようにするだけの掃除であり、選択ロジック自体の正しさは
  // dismissedEventIdsRefをfindDueFocusTaskへ渡すevaluate()側で既に保証されている）。
  useEffect(() => {
    setDismissedEventIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(events.map((e) => e.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  const dismiss = () => {
    const current = rawDueTaskRef.current;
    if (!current) return;
    if (dismissedEventIdsRef.current.has(current.id)) return; // 既にdismiss済みなら何もしない（冪等）

    // setDismissedEventIds（React state）は次のrenderまで反映される保証が無い。
    // 直後に呼ぶcontroller.tick()はevaluate()を介してdismissedEventIdsRef.currentを
    // 非同期処理（await getActiveFocusSession()）の後で読むため、renderの反映を待っていると
    // 更新前のSetを参照して予定Aを再び候補として選んでしまう可能性がある
    // （テストではact()が同期的にrenderを反映するため見えにくいが、実機では保証されない）。
    // そのため、表示更新・再render用のstateとは別に、同期参照用のrefをここで直接更新し、
    // controller.tick()を呼ぶ時点で既に最新のdismiss済みSetを指すようにする。
    const next = new Set(dismissedEventIdsRef.current);
    next.add(current.id);
    dismissedEventIdsRef.current = next;
    setDismissedEventIds(next);

    // 次点の未dismiss候補（既に開始時刻を過ぎているものがあれば）を、
    // 更新済みSetを使って即座に案内できるよう明示的に再評価する。
    controller.tick();
  };

  const dueFocusTask =
    isFocused && rawDueTask && !dismissedEventIds.has(rawDueTask.id) ? rawDueTask : null;

  return { dueFocusTask, dismiss };
}
