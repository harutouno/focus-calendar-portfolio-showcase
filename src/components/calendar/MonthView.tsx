import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
  findNodeHandle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { AppEvent } from "@/types/event";
import { useAppData } from "@/context/AppDataContext";
import { useHolidays } from "@/hooks/useHolidays";
import { groupEventsByDate } from "@/utils/eventVisibility";
import { colors } from "@/theme/colors";
import { radius, shadow, spacing } from "@/theme/spacing";
import {
  addMonths,
  formatAgendaDayTitle,
  formatShortDay,
  getMonthMatrix,
  isToday,
  parseLocalDateString,
  weekdayLabelByIndex,
} from "@/utils/date";
import { useLocale } from "@/context/LocaleContext";
import { useHolidayRegion } from "@/context/HolidayRegionContext";
import {
  DEFAULT_EDGE_SCROLL_CONFIG,
  applyDateAndTimeMove,
  applyDateMove,
  dateFromMonthCellIndex,
  edgeScrollSpeed,
  monthCellIndexFromOffset,
} from "./dragMath";
import { resolveSwipeMonthDirection } from "./swipeMath";
import { canEditEvent, dragDisabledReason } from "@/utils/permissions";
import { EventChipCompact, eventColor } from "./EventChip";
import { MonthDropConfirmSheet } from "./MonthDropConfirmSheet";

const MAX_VISIBLE_PER_CELL = 3;
/** 長押しが成立してドラッグへ入るまでの時間(ms) */
const LONG_PRESS_DURATION = 300;
/** 上下端に留まり続けたときの前後月移動を連発させないための最小間隔(ms) */
const MONTH_NAV_COOLDOWN_MS = 900;
/** 横スワイプで月が確定したときのスライドアニメーションの所要時間(ms) */
const MONTH_SLIDE_DURATION = 260;
/** スワイプが閾値未満だったときに元位置へ戻すバネアニメーションの設定 */
const SWIPE_CANCEL_SPRING = { damping: 24, stiffness: 260 };

interface Props {
  focusedDate: string;
  events: AppEvent[];
  onSelectDate: (date: string) => void;
  onSelectEvent: (event: AppEvent) => void;
  /** 上下端に留まったときの前月・翌月への移動（ドラッグ中のみ使用） */
  onDragNavigateMonth?: (amount: -1 | 1) => void;
  /** カレンダー部分の左右スワイプによる前月・翌月への移動（Stage I-8.6）。
   *  既存の矢印ボタン・今日ボタン・年月選択と同じ月変更ロジック（呼び出し元のnavigate）を渡す想定。 */
  onSwipeNavigateMonth?: (amount: -1 | 1) => void;
}

interface DragState {
  event: AppEvent;
  originalRow: number;
  originalCol: number;
  translationX: number;
  translationY: number;
  previewDate: string;
  previewCellIndex: number;
}

interface PendingDrop {
  event: AppEvent;
  newDate: string;
}

/** 矢印ボタン等、スワイプ以外の操作からも同じスライドアニメーションで月移動するための命令的API（Stage 2）。 */
export interface MonthViewHandle {
  /**
   * スワイプで確定したときと同じスライドアニメーションで前月・翌月へ移動する。
   * 予定ドラッグ中、または既に別のスライドアニメーションが進行中の場合は何もしない
   * （スワイプ側の多重入力防止と同じ基準で抑制する。呼び出し側でのフォールバックは行わない）。
   */
  animateToMonth: (direction: -1 | 1) => void;
}

export const MonthView = forwardRef<MonthViewHandle, Props>(function MonthView(
  {
    focusedDate,
    events,
    onSelectDate,
    onSelectEvent,
    onDragNavigateMonth,
    onSwipeNavigateMonth,
  },
  ref
) {
  const { saveEvent, sharedCalendars } = useAppData();
  const { t, locale } = useLocale();
  const { region } = useHolidayRegion();
  // 月表示における「選択中の日付」は、新しいstateを追加せず既存のfocusedDateをそのまま使う
  // （日付タップは既存どおり日別画面へ遷移するだけで、月表示内に留まって選択状態を保持する
  // 新しい挙動は追加しない。あくまで見た目上、今どの日付が起点になっているかを示すだけ）。
  const selectedDate = focusedDate;
  const cursor = parseLocalDateString(focusedDate);
  const cursorYear = cursor.getFullYear();
  const cursorMonth = cursor.getMonth();
  const cells = useMemo(
    () => getMonthMatrix(cursorYear, cursorMonth),
    [cursorYear, cursorMonth]
  );
  // 前月・翌月のパネル（Stage 1: 横スワイプの3枚パネル表示用）。
  // 月の計算自体は既存のaddMonths/getMonthMatrixをそのまま使い、新しい日付計算ロジックは追加しない。
  const previousFocusedDate = useMemo(() => addMonths(focusedDate, -1), [focusedDate]);
  const nextFocusedDate = useMemo(() => addMonths(focusedDate, 1), [focusedDate]);
  const previousCursor = parseLocalDateString(previousFocusedDate);
  const nextCursor = parseLocalDateString(nextFocusedDate);
  const previousCursorYear = previousCursor.getFullYear();
  const previousCursorMonth = previousCursor.getMonth();
  const nextCursorYear = nextCursor.getFullYear();
  const nextCursorMonth = nextCursor.getMonth();
  const previousCells = useMemo(
    () => getMonthMatrix(previousCursorYear, previousCursorMonth),
    [previousCursorYear, previousCursorMonth]
  );
  const nextCells = useMemo(
    () => getMonthMatrix(nextCursorYear, nextCursorMonth),
    [nextCursorYear, nextCursorMonth]
  );
  // 祝日は表示専用でAppDataContextの予定データとは完全に分離する（保存・編集・通知の対象にしない）。
  // グリッドは前後月の日付を含み年をまたぐことがあるため、実際に表示中の日付から必要な年を導出する。
  // 3枚パネル分の日付をまとめて渡すことで、useHolidays呼び出しは既存どおり1回のままにする。
  const cellDates = useMemo(
    () => [...previousCells, ...cells, ...nextCells].map((c) => c.date),
    [previousCells, cells, nextCells]
  );
  const holidays = useHolidays(cellDates, locale, region);

  // 横スワイプのページングアニメーション（Stage 1）用。
  const [panelWidth, setPanelWidth] = useState(() => Dimensions.get("window").width);
  const [isMonthAnimating, setIsMonthAnimating] = useState(false);
  const translateX = useSharedValue(0);
  const mountedRef = useRef(true);
  const previousFocusedDateSeenRef = useRef(focusedDate);

  const gridRef = useRef<View>(null);
  const gridBoundsRef = useRef<{
    top: number;
    bottom: number;
    width: number;
    height: number;
  } | null>(null);
  const lastAbsoluteYRef = useRef<number | null>(null);
  const lastTranslationXRef = useRef(0);
  const lastTranslationYRef = useRef(0);
  const edgeDwellStartRef = useRef<number | null>(null);
  const monthNavCooldownRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const dragStateRef = useRef<DragState | null>(null);
  /** 1回のスワイプジェスチャーにつき月移動を1回だけ実行するためのガード（Stage I-8.6） */
  const swipeHandledRef = useRef(false);
  /** 月替わり後も最新のcellsを参照し続けるための「常に最新」の自動遷移処理 */
  const tickRef = useRef<() => void>(() => {});

  const [dragState, setDragState] = useState<DragState | null>(null);
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);

  const eventsByDate = useMemo(() => groupEventsByDate(events), [events]);

  const chunkIntoWeeks = (source: typeof cells): (typeof cells)[] => {
    const result: (typeof cells)[] = [];
    for (let i = 0; i < source.length; i += 7) {
      result.push(source.slice(i, i + 7));
    }
    return result;
  };
  const weeks = chunkIntoWeeks(cells);
  const previousWeeks = chunkIntoWeeks(previousCells);
  const nextWeeks = chunkIntoWeeks(nextCells);

  // ドラッグ中に画面遷移等でアンマウントされても、オートスクロールのRAFループを残さない。
  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  // unmount時に月切り替えアニメーションが残らないようにする（Stage 1）。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimation(translateX);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // focusedDateが実際に変化したタイミング（スワイプ確定・矢印ボタン・ドラッグ端到達等、
  // 原因を問わない）で、translateXを0へ戻し、アニメーション中フラグを解除する。
  // withTimingのコールバックで直接0に戻さず、この副作用を経由するのは、
  // 新しい月のcellsが実際にレンダーされたタイミングと同期させ、
  // 切り替え直後に一瞬古い月が見えてしまう「戻り」を防ぐため（第1段階の重要要件）。
  useEffect(() => {
    if (previousFocusedDateSeenRef.current === focusedDate) return;
    previousFocusedDateSeenRef.current = focusedDate;
    translateX.value = 0;
    setIsMonthAnimating(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedDate]);

  const stopAutoScrollLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    edgeDwellStartRef.current = null;
  }, []);

  const recomputePreview = useCallback(
    (translationX: number, translationY: number) => {
      const current = dragStateRef.current;
      const bounds = gridBoundsRef.current;
      if (!current || !bounds) return;
      const cellWidth = bounds.width / 7;
      const cellHeight = bounds.height / 6;
      const contentX = current.originalCol * cellWidth + translationX;
      const contentY = current.originalRow * cellHeight + translationY;
      const cellIndex = monthCellIndexFromOffset(
        contentX,
        contentY,
        bounds.width,
        bounds.height
      );
      const previewDate = dateFromMonthCellIndex(cells, cellIndex) ?? current.previewDate;
      const next: DragState = {
        ...current,
        translationX,
        translationY,
        previewDate,
        previewCellIndex: cellIndex,
      };
      dragStateRef.current = next;
      setDragState(next);
    },
    [cells]
  );

  // 毎レンダーで最新のクロージャに更新する（月替わり後も古いcellsを参照しないため）
  tickRef.current = () => {
    // ドラッグが既に終了・キャンセルされていれば、次のフレームを予約せずここで自己終了する。
    // stopAutoScrollLoop()のcancelAnimationFrameがタイミング競合で効かなかった場合でも、
    // dragStateRefはhandleDragEnd/handleDragFinalizeで必ず同時にnullへ戻されるため、
    // このガードにより自動スクロール／月移動ループが指を離した後も回り続けることはない。
    if (!dragStateRef.current) return;
    const bounds = gridBoundsRef.current;
    if (bounds && lastAbsoluteYRef.current != null) {
      const y = lastAbsoluteYRef.current;
      const distanceFromTop = y - bounds.top;
      const distanceFromBottom = bounds.bottom - y;
      let direction: -1 | 0 | 1 = 0;
      let penetration = 0;
      if (distanceFromTop < DEFAULT_EDGE_SCROLL_CONFIG.edgeThreshold) {
        direction = -1;
        penetration =
          DEFAULT_EDGE_SCROLL_CONFIG.edgeThreshold - Math.max(distanceFromTop, 0);
      } else if (distanceFromBottom < DEFAULT_EDGE_SCROLL_CONFIG.edgeThreshold) {
        direction = 1;
        penetration =
          DEFAULT_EDGE_SCROLL_CONFIG.edgeThreshold - Math.max(distanceFromBottom, 0);
      }
      if (direction === 0) {
        edgeDwellStartRef.current = null;
      } else {
        if (edgeDwellStartRef.current == null) edgeDwellStartRef.current = Date.now();
        const dwell = Date.now() - edgeDwellStartRef.current;
        const shouldNavigate = edgeScrollSpeed(penetration, dwell) > 0;
        if (shouldNavigate && onDragNavigateMonth) {
          const now = Date.now();
          if (now - monthNavCooldownRef.current > MONTH_NAV_COOLDOWN_MS) {
            monthNavCooldownRef.current = now;
            onDragNavigateMonth(direction);
          }
        }
      }
    }
    rafRef.current = requestAnimationFrame(() => tickRef.current());
  };

  const startAutoScrollLoop = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => tickRef.current());
  }, []);

  const handleDragStart = useCallback(
    (event: AppEvent, row: number, col: number, absoluteY: number) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      lastAbsoluteYRef.current = absoluteY;
      lastTranslationXRef.current = 0;
      lastTranslationYRef.current = 0;

      const handle = findNodeHandle(gridRef.current);
      if (handle != null) {
        UIManager.measure(handle, (_x, _y, w, h, _pageX, pageY) => {
          gridBoundsRef.current = { top: pageY, bottom: pageY + h, width: w, height: h };
        });
      }

      const initial: DragState = {
        event,
        originalRow: row,
        originalCol: col,
        translationX: 0,
        translationY: 0,
        previewDate: event.date,
        previewCellIndex: row * 7 + col,
      };
      dragStateRef.current = initial;
      setDragState(initial);
      stopAutoScrollLoop();
      startAutoScrollLoop();
    },
    [startAutoScrollLoop, stopAutoScrollLoop]
  );

  const handleDragUpdate = useCallback(
    (translationX: number, translationY: number, absoluteY: number) => {
      lastAbsoluteYRef.current = absoluteY;
      lastTranslationXRef.current = translationX;
      lastTranslationYRef.current = translationY;
      recomputePreview(translationX, translationY);
    },
    [recomputePreview]
  );

  const handleDragEnd = useCallback((success: boolean) => {
    stopAutoScrollLoop();
    const current = dragStateRef.current;
    dragStateRef.current = null;
    setDragState(null);
    if (!current || !success) return;
    setPendingDrop({ event: current.event, newDate: current.previewDate });
  }, [stopAutoScrollLoop]);

  const handleDragFinalize = useCallback(() => {
    stopAutoScrollLoop();
  }, [stopAutoScrollLoop]);

  const handleDragBlocked = useCallback((reason: string) => {
    Alert.alert(t("common.cannotMoveTitle"), reason);
  }, [t]);

  const handleSheetCancel = useCallback(() => {
    setPendingDrop(null);
  }, []);

  const handleSheetSaveWithTime = useCallback(
    async (time: string) => {
      if (!pendingDrop || savingRef.current) return;
      savingRef.current = true;
      const updated = applyDateAndTimeMove(pendingDrop.event, pendingDrop.newDate, time);
      try {
        await saveEvent(updated);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {
        Alert.alert(t("common.saveFailedTitle"), t("common.saveFailedMessage"));
      } finally {
        savingRef.current = false;
        setPendingDrop(null);
      }
    },
    [pendingDrop, saveEvent, t]
  );

  const resetSwipeHandled = useCallback(() => {
    swipeHandledRef.current = false;
  }, []);

  /**
   * スライドアニメーションが目標位置まで終わった後に呼ばれる（Stage 1）。
   * ここで初めてfocusedDateを更新する（アニメーション中に先に更新しない、という要件を
   * このタイミング設計で満たす）。translateXを0へ戻す処理自体は行わない
   * ——実際に新しいcellsがレンダーされたのを検知するuseEffect（focusedDate監視）に委ね、
   * 切り替え直後の一瞬の巻き戻りを防ぐ。
   */
  const handleSwipeCommit = useCallback(
    (direction: 1 | -1) => {
      if (!mountedRef.current) return;
      if (!onSwipeNavigateMonth) {
        // ハンドラ未指定時はfocusedDateが変化せず、監視用useEffectが発火しないため、
        // ここで直接元へ戻し、スタックしたままにしない。
        translateX.value = 0;
        setIsMonthAnimating(false);
        return;
      }
      onSwipeNavigateMonth(direction);
    },
    [onSwipeNavigateMonth, translateX]
  );

  /**
   * 月移動のスライドアニメーション本体（Stage 2: スワイプ・矢印ボタン共通で使う）。
   * withTiming/withSpringの呼び出し自体はJSスレッドから行っても問題ない
   * ——Reanimatedのshared valueはどちらのスレッドからの代入にも対応している。
   */
  const startMonthSlide = useCallback(
    (direction: 1 | -1) => {
      setIsMonthAnimating(true);
      const target = direction === 1 ? -panelWidth : panelWidth;
      translateX.value = withTiming(target, { duration: MONTH_SLIDE_DURATION }, (finished) => {
        if (finished) {
          runOnJS(handleSwipeCommit)(direction);
        }
      });
    },
    [handleSwipeCommit, panelWidth, translateX]
  );

  /**
   * スワイプ終了時の判定・アニメーション開始はすべてJSスレッド側のこの関数に集約する
   * （worklet内から直接useRefを読み書きしたり、非worklet関数（resolveSwipeMonthDirection等）を
   * 呼び出したりしない。既存のhandleDragStart等と同じ「runOnJS経由でJS側の通常関数を呼ぶ」
   * パターンに統一する）。
   */
  const handleSwipeEnd = useCallback(
    (translationX: number, translationY: number, velocityX: number) => {
      if (dragStateRef.current || swipeHandledRef.current) {
        translateX.value = withSpring(0, SWIPE_CANCEL_SPRING);
        return;
      }
      const direction = resolveSwipeMonthDirection(translationX, translationY, velocityX);
      if (direction === 0) {
        translateX.value = withSpring(0, SWIPE_CANCEL_SPRING);
        return;
      }
      swipeHandledRef.current = true;
      startMonthSlide(direction);
    },
    [startMonthSlide, translateX]
  );

  /**
   * 矢印ボタン等、外部から呼ばれる命令的API（Stage 2）。スワイプの.onEnd相当の判定
   * （ドラッグ中／アニメーション中は何もしない）だけを行い、実際のアニメーションは
   * スワイプ確定時と全く同じstartMonthSlideを使う（アニメーションの二重実装を避ける）。
   */
  const animateToMonth = useCallback(
    (direction: -1 | 1) => {
      if (dragStateRef.current || isMonthAnimating) return;
      startMonthSlide(direction);
    },
    [isMonthAnimating, startMonthSlide]
  );

  useImperativeHandle(ref, () => ({ animateToMonth }), [animateToMonth]);

  const handleSheetSaveOriginalTime = useCallback(async () => {
    if (!pendingDrop || savingRef.current) return;
    savingRef.current = true;
    const updated = applyDateMove(pendingDrop.event, pendingDrop.newDate);
    try {
      await saveEvent(updated);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert(t("common.saveFailedTitle"), t("common.saveFailedMessage"));
    } finally {
      savingRef.current = false;
      setPendingDrop(null);
    }
  }, [pendingDrop, saveEvent, t]);

  /**
   * カレンダー部分の左右スワイプによる月移動（Stage I-8.6）。
   * - activeOffsetX/failOffsetYで「明確な横方向の動き」だけを拾い、タップ・縦方向の動きは
   *   このジェスチャーを一切活性化させず、Pressable（日付選択）や予定チップ側のPan
   *   （長押し後にのみ活性化）へそのまま通す（RNGHのジェスチャー競合解決に委ねる）。
   * - 最終的な方向判定はonEndで一度だけ純関数resolveSwipeMonthDirectionへ委ね、
   *   月変更処理そのものは既存のonSwipeNavigateMonth（呼び出し元のnavigate）を呼ぶだけで、
   *   MonthView内に月変更ロジックを重複実装しない。
   * - onStart/onUpdate/onEndはUIスレッドのworkletとして実行されるため、ref読み書きや
   *   resolveSwipeMonthDirection（非worklet関数）の呼び出しは直接行わず、
   *   必ずrunOnJS経由でJSスレッド側の関数（resetSwipeHandled/handleSwipeEnd）へ委譲する
   *   （直接呼び出すと「非worklet関数をUIスレッドから呼んだ」実行時エラーでクラッシュする）。
   *   ただしonUpdateでのtranslateX代入は、Reanimatedのshared value自体への代入であり
   *   （非worklet関数の呼び出しではないため）worklet内から直接行ってよい。指の動きに
   *   遅延なく追従させるため、あえてrunOnJSを経由させない。
   * - Stage 1: ドラッグ中（dragState）またはスライドアニメーション中（isMonthAnimating）は
   *   .enabled(false)でジェスチャー自体を無効化し、既存の予定ドラッグや多重スワイプと
   *   競合しないようにする。
   */
  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-20, 20])
    .failOffsetY([-15, 15])
    .enabled(!dragState && !isMonthAnimating)
    .onStart(() => {
      runOnJS(resetSwipeHandled)();
    })
    .onUpdate((e) => {
      translateX.value = e.translationX;
    })
    .onEnd((e) => {
      runOnJS(handleSwipeEnd)(e.translationX, e.translationY, e.velocityX);
    });

  /**
   * 3枚パネル（前月・当月・翌月）はそれぞれ独立したposition:"absolute"の箱として置き、
   * 幅は常にwidth: panelWidthで固定する（3枚まとめて1つの3倍幅トラックを
   * flexDirection:"row"で並べてtransformする方式は、静止時は正しく見えても
   * スワイプ中（transformが毎フレーム変化する状態）に列幅の再計算が疑われる挙動が
   * 実機で確認されたため、この設計へ変更した）。
   * 各パネルはtranslateX.value（生のスワイプ量）に、パネルごとの基準オフセットを
   * 加えるだけで、常にwidth: panelWidthのまま動く。7列グリッド自体の幅計算は
   * 「自分のパネルの幅」だけを見ればよく、3倍幅のトラック全体を経由しない。
   */
  const previousPanelStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: -panelWidth + translateX.value }] }),
    [panelWidth]
  );
  const currentPanelStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: translateX.value }] }),
    []
  );
  const nextPanelStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: panelWidth + translateX.value }] }),
    [panelWidth]
  );

  /**
   * 前月・翌月パネルの表示専用レンダリング（Stage 1）。
   * 当月パネル（後述、既存のweeks.map部分）と見た目は揃えるが、日付タップ・予定ドラッグの
   * ジェスチャーは一切付けない（PressableではなくViewで包む、EventChipCompactのonPressは
   * no-opにする）。表示中はスワイプ操作そのものの最中で、指はswipeGesture側に取られており、
   * かつ画面外にクリップされているため、実質的にタップ・ドラッグが発生する余地はない。
   */
  const renderReadOnlyMonth = (weeksForMonth: (typeof cells)[]) =>
    weeksForMonth.map((week, wi) => (
      <View key={wi} style={styles.weekRow}>
        {week.map((cell) => {
          const dayEvents = eventsByDate.get(cell.date) ?? [];
          const visible = dayEvents.slice(0, MAX_VISIBLE_PER_CELL);
          const overflow = dayEvents.length - visible.length;
          const today = isToday(cell.date);
          const isSelected = cell.date === selectedDate;
          const holidayName = holidays[cell.date];
          return (
            <View
              key={cell.date}
              style={[
                styles.dayCell,
                !cell.isCurrentMonth && styles.dayCellDim,
                today && !isSelected && styles.dayCellToday,
                isSelected && styles.dayCellSelected,
              ]}
            >
              <View style={styles.dayCellTouchable}>
                <View style={[styles.dateBadge, today && styles.dateBadgeToday]}>
                  <Text
                    style={[
                      styles.dateText,
                      !cell.isCurrentMonth && styles.dateTextDim,
                      !!holidayName && !today && styles.dateTextHoliday,
                      today && styles.dateTextToday,
                    ]}
                  >
                    {formatShortDay(cell.date)}
                  </Text>
                </View>
                {holidayName && (
                  <Text
                    style={[styles.holidayText, !cell.isCurrentMonth && styles.dateTextDim]}
                    numberOfLines={1}
                  >
                    {holidayName}
                  </Text>
                )}
                {visible.map((event) => (
                  <EventChipCompact key={event.id} event={event} onPress={() => {}} />
                ))}
                {overflow > 0 && (
                  <Text style={styles.overflowText}>{t("common.moreCount", { count: overflow })}</Text>
                )}
              </View>
            </View>
          );
        })}
      </View>
    ));

  return (
    <View style={styles.container}>
      <View style={styles.weekdayRow}>
        {Array.from({ length: 7 }, (_, i) => (
          <View key={i} style={styles.weekdayCell}>
            <Text
              style={[
                styles.weekdayText,
                i === 0 && styles.sunday,
                i === 6 && styles.saturday,
              ]}
            >
              {weekdayLabelByIndex(i, locale)}
            </Text>
          </View>
        ))}
      </View>
      <View
        style={styles.pagerViewport}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          if (w > 0 && Math.abs(w - panelWidth) > 0.5) setPanelWidth(w);
        }}
      >
      <GestureDetector gesture={swipeGesture}>
      <View style={styles.pagerGestureSurface}>
        <Animated.View style={[styles.panel, { width: panelWidth }, previousPanelStyle]}>
          {renderReadOnlyMonth(previousWeeks)}
        </Animated.View>
        <Animated.View ref={gridRef} style={[styles.panel, { width: panelWidth }, currentPanelStyle]}>
        {weeks.map((week, wi) => (
          <View key={wi} style={styles.weekRow}>
            {week.map((cell, ci) => {
              const dayEvents = eventsByDate.get(cell.date) ?? [];
              const visible = dayEvents.slice(0, MAX_VISIBLE_PER_CELL);
              const overflow = dayEvents.length - visible.length;
              const today = isToday(cell.date);
              const isSelected = cell.date === selectedDate;
              const holidayName = holidays[cell.date];
              const cellIndex = wi * 7 + ci;
              const isDropTarget =
                !!dragState && dragState.previewCellIndex === cellIndex;
              return (
                <View
                  key={cell.date}
                  style={[
                    styles.dayCell,
                    !cell.isCurrentMonth && styles.dayCellDim,
                    today && !isSelected && styles.dayCellToday,
                    isSelected && styles.dayCellSelected,
                    isDropTarget && styles.dayCellDropTarget,
                  ]}
                >
                  <Pressable
                    style={({ pressed }) => [
                      styles.dayCellTouchable,
                      pressed && styles.dayCellPressed,
                    ]}
                    onPress={() => onSelectDate(cell.date)}
                    accessibilityRole="button"
                    accessibilityLabel={`${formatAgendaDayTitle(cell.date, locale)}${
                      holidayName ? `${t("common.a11ySeparator")}${holidayName}` : ""
                    }${today ? t("common.todaySuffix") : ""}`}
                  >
                    <View style={[styles.dateBadge, today && styles.dateBadgeToday]}>
                      <Text
                        style={[
                          styles.dateText,
                          !cell.isCurrentMonth && styles.dateTextDim,
                          // 祝日かどうかだけで色を決める（曜日による赤色付けは行っていないため、
                          // 日曜・土曜の祝日でも表示ロジックが競合しない）。todayは既存どおり最優先。
                          !!holidayName && !today && styles.dateTextHoliday,
                          today && styles.dateTextToday,
                        ]}
                      >
                        {formatShortDay(cell.date)}
                      </Text>
                    </View>
                    {holidayName && (
                      <Text
                        style={[
                          styles.holidayText,
                          !cell.isCurrentMonth && styles.dateTextDim,
                        ]}
                        numberOfLines={1}
                      >
                        {holidayName}
                      </Text>
                    )}
                    {visible.map((event) => {
                      const isDraggingThis = dragState?.event.id === event.id;
                      const draggable = canEditEvent(event, sharedCalendars);
                      if (!draggable) {
                        const reason = dragDisabledReason(event, sharedCalendars, t) ?? "";
                        const longPressOnly = Gesture.LongPress()
                          .minDuration(LONG_PRESS_DURATION)
                          .onStart(() => {
                            runOnJS(handleDragBlocked)(reason);
                          });
                        return (
                          <GestureDetector key={event.id} gesture={longPressOnly}>
                            <EventChipCompact event={event} onPress={onSelectEvent} />
                          </GestureDetector>
                        );
                      }
                      const pan = Gesture.Pan()
                        .activateAfterLongPress(LONG_PRESS_DURATION)
                        .onStart((e) => {
                          runOnJS(handleDragStart)(event, wi, ci, e.absoluteY);
                        })
                        .onUpdate((e) => {
                          runOnJS(handleDragUpdate)(e.translationX, e.translationY, e.absoluteY);
                        })
                        .onEnd((_e, success) => {
                          runOnJS(handleDragEnd)(success);
                        })
                        .onFinalize(() => {
                          runOnJS(handleDragFinalize)();
                        });
                      return (
                        <GestureDetector key={event.id} gesture={pan}>
                          <View style={isDraggingThis ? styles.ghost : undefined}>
                            <EventChipCompact event={event} onPress={onSelectEvent} />
                          </View>
                        </GestureDetector>
                      );
                    })}
                    {overflow > 0 && (
                      <Text style={styles.overflowText}>{t("common.moreCount", { count: overflow })}</Text>
                    )}
                  </Pressable>
                </View>
              );
            })}
          </View>
        ))}
        {dragState && gridBoundsRef.current && (
          <View
            pointerEvents="none"
            style={[
              styles.dragOverlay,
              {
                top:
                  dragState.originalRow * (gridBoundsRef.current.height / 6) +
                  dragState.translationY,
                left:
                  dragState.originalCol * (gridBoundsRef.current.width / 7) +
                  dragState.translationX,
                width: gridBoundsRef.current.width / 7,
                backgroundColor: eventColor(dragState.event).bg,
                borderColor: eventColor(dragState.event).fg,
              },
            ]}
          >
            <Text
              style={[styles.dragOverlayTitle, { color: eventColor(dragState.event).fg }]}
              numberOfLines={1}
            >
              {dragState.event.title}
            </Text>
            <View style={styles.dragPreviewBadge}>
              <Text style={styles.dragPreviewText} numberOfLines={1}>
                {t("monthView.movePreviewSuffix", { day: formatShortDay(dragState.previewDate) })}
              </Text>
            </View>
          </View>
        )}
        </Animated.View>
        <Animated.View style={[styles.panel, { width: panelWidth }, nextPanelStyle]}>
          {renderReadOnlyMonth(nextWeeks)}
        </Animated.View>
      </View>
      </GestureDetector>
      </View>

      <MonthDropConfirmSheet
        visible={!!pendingDrop}
        event={pendingDrop?.event ?? null}
        newDate={pendingDrop?.newDate ?? focusedDate}
        onCancel={handleSheetCancel}
        onSaveWithTime={handleSheetSaveWithTime}
        onSaveWithOriginalTime={handleSheetSaveOriginalTime}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  weekdayRow: {
    flexDirection: "row",
    // 主要区切り：曜日ヘッダーとカレンダー本体の境目。背景も本体・フィルター欄と区別する。
    backgroundColor: colors.calendarHeaderSurface,
    borderBottomWidth: 1,
    borderBottomColor: colors.calendarMajorDivider,
    paddingVertical: spacing.sm,
  },
  weekdayCell: {
    flex: 1,
    alignItems: "center",
  },
  weekdayText: {
    fontSize: 12,
    fontWeight: "700",
    // 日付セルの数字より少し強い印象にするため、textSecondaryからtextPrimaryへ引き上げる。
    color: colors.textPrimary,
  },
  sunday: { color: colors.warning },
  saturday: { color: colors.primary },
  /** スワイプ検知・3枚パネルをクリップする外枠（Stage 1）。 */
  pagerViewport: {
    flex: 1,
    overflow: "hidden",
    position: "relative",
  },
  /** GestureDetectorの直下に置く、ジェスチャー検知面。3枚パネルの位置決めの基準になる。 */
  pagerGestureSurface: {
    flex: 1,
    position: "relative",
  },
  /**
   * 1か月分のパネル（前月・当月・翌月で共通）。当月パネルは既存のgridRefを引き続き付与する。
   * 3枚をflexDirection:"row"の1本のトラックとして並べてtransformする方式（旧実装）は、
   * 静止時は正しく見えても、スワイプ中（transformが毎フレーム変化する状態）に
   * 実機で列幅の圧縮が確認されたため撤回した。
   * 代わりに、各パネルを独立したposition:"absolute"の箱にし、幅を常にwidth: panelWidthの
   * まま固定。3枚まとめた「3倍幅のトラック」という概念自体をなくし、パネルごとに
   * 個別のtranslateXだけを与える（previousPanelStyle/currentPanelStyle/nextPanelStyle）。
   * これにより、7列グリッドの幅計算は常に「自分の属するパネルの幅」だけを基準にでき、
   * 3倍幅トラックのflex計算を経由しない。
   */
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
  },
  weekRow: {
    flex: 1,
    flexDirection: "row",
  },
  dayCell: {
    flex: 1,
    backgroundColor: colors.calendarSurface,
    // 通常区切り：左右（日付セルの境界）は既存どおり細く、上下（週と週の区切り）は
    // 同じ色のまま少しだけ太くして、週の区切りを縦の境界より認識しやすくする
    // （色を主要区切りまで濃くはしない＝あくまで「通常」区切りの範囲内での強調）。
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.calendarNormalDivider,
    padding: 4,
    minHeight: 64,
  },
  dayCellTouchable: {
    flex: 1,
  },
  dayCellPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  dayCellDim: {
    backgroundColor: colors.calendarOutsideMonthSurface,
  },
  /** 今日のセル。日付数字自体は既存のdateBadgeToday（青丸）で示すため、ここはごく薄い背景のみ。 */
  dayCellToday: {
    backgroundColor: colors.calendarTodaySurface,
  },
  /** 選択中（focusedDate）のセル。背景＋枠線の両方で示し、今日と同じ日でも破綻しないよう
   *  dayCellTodayとは排他的に適用する（呼び出し側でtoday && !isSelectedにしている）。 */
  dayCellSelected: {
    backgroundColor: colors.calendarSelectedSurface,
    borderColor: colors.primary,
    borderWidth: 1.5,
  },
  dayCellDropTarget: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
  },
  dateBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  dateBadgeToday: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.today,
  },
  dateText: {
    fontSize: 12,
    color: colors.textPrimary,
    fontWeight: "600",
  },
  dateTextDim: {
    color: colors.textTertiary,
  },
  dateTextToday: {
    color: colors.textInverse,
    fontWeight: "700",
  },
  dateTextHoliday: {
    color: colors.holiday,
  },
  holidayText: {
    fontSize: 9,
    fontWeight: "700",
    color: colors.holiday,
    marginTop: 2,
  },
  overflowText: {
    fontSize: 9,
    color: colors.textTertiary,
    marginTop: 2,
  },
  ghost: {
    opacity: 0.35,
  },
  dragOverlay: {
    position: "absolute",
    borderRadius: 4,
    borderWidth: 2,
    paddingHorizontal: 6,
    paddingVertical: 4,
    zIndex: 10,
    ...shadow.elevated,
  },
  dragOverlayTitle: {
    fontSize: 10,
    fontWeight: "700",
  },
  dragPreviewBadge: {
    position: "absolute",
    bottom: "100%",
    marginBottom: 4,
    alignSelf: "flex-start",
    backgroundColor: colors.textPrimary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  dragPreviewText: {
    color: colors.textInverse,
    fontSize: 10,
    fontWeight: "700",
  },
});
