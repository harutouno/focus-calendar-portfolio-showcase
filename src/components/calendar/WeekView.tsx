import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
  ViewStyle,
  findNodeHandle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { AppEvent } from "@/types/event";
import { useAppData } from "@/context/AppDataContext";
import { groupEventsByDate } from "@/utils/eventVisibility";
import { colors } from "@/theme/colors";
import { minTapSize, radius, shadow, spacing } from "@/theme/spacing";
import {
  formatAgendaDayTitle,
  formatShortDay,
  getWeekDates,
  isToday,
  weekdayLabel,
  weekdayLabelByIndex,
} from "@/utils/date";
import { todayLocalDateString } from "@/utils/date";
import { useLocale } from "@/context/LocaleContext";
import {
  END_HOUR,
  HOUR_HEIGHT,
  PositionedEvent,
  START_HOUR,
  TIMELINE_HEIGHT,
  currentTimeTop,
  layoutEventsForDay,
} from "./timelineLayout";
import {
  DEFAULT_EDGE_SCROLL_CONFIG,
  applyTimeMove,
  ceilTimeFromOffsetY,
  clampCardToViewport,
  clampDragCardTop,
  dateFromDayIndex,
  dayIndexFromOffsetXWithHysteresis,
  decideAutoScrollEdge,
  edgeScrollSpeed,
  evaluateAutoScrollFrame,
  maximumScrollOffset,
  nextAutoScrollOffset,
  offsetYFromTime,
  shouldContinueAutoScroll,
  timeFromOffsetY,
} from "./dragMath";
import { canEditEvent, dragDisabledReason } from "@/utils/permissions";
import { EventBlock, eventColor } from "./EventChip";
import { CurrentTimeLine } from "./CurrentTimeLine";

const TIME_LABEL_WIDTH = 44;
/** ドラッグ中、予定を指の真下に置かないための持ち上げ量(px) */
const DRAG_LIFT_OFFSET = 14;
/** 長押しが成立してドラッグへ入るまでの時間(ms)。エッジスクロールのactivationDelayとは別の値 */
const LONG_PRESS_DURATION = 300;
/** プレビュー時刻バッジの概算の高さ(px)。カードの表示位置がこれ未満まで上端に近づいたら、
 *  バッジをカードの上ではなく下へ表示し、固定の曜日ヘッダーへ被らないようにする。 */
const PREVIEW_BADGE_HEIGHT_ESTIMATE = 28;
/** 長押し成立時の「持ち上げ」アニメーションの拡大率・所要時間(ms) */
const LIFT_SCALE = 1.03;
const LIFT_DURATION = 140;
/** ドロップ確定時（settle）・キャンセル時（元の位置へ戻る）の所要時間(ms) */
const SETTLE_DURATION = 160;
const EASE_OUT = Easing.out(Easing.quad);

interface Props {
  focusedDate: string;
  events: AppEvent[];
  onSelectDate: (date: string) => void;
  onSelectEvent: (event: AppEvent) => void;
  /** 空いている時間帯をタップしたときに、通常予定登録画面を開くためのコールバック */
  onCreateAt?: (date: string, startTime: string) => void;
  onNavigateWeek?: (amount: -1 | 1) => void;
}

interface DragState {
  /** このドラッグセッションを識別するID（dragSessionIdRefと照合し、古いオートスクロール
   *  ループの残存・多重起動を検知するために使う）。 */
  sessionId: number;
  event: AppEvent;
  originalTop: number;
  originalDayIndex: number;
  height: number;
  columnIndex: number;
  columnCount: number;
  previewDate: string;
  previewStartTime: string;
  /** プレビュー時刻バッジをカードの上ではなく下に表示すべきか（上端付近でヘッダーに被らないため） */
  badgeBelow: boolean;
}

export function WeekView({
  focusedDate,
  events,
  onSelectDate,
  onSelectEvent,
  onCreateAt,
  onNavigateWeek,
}: Props) {
  const { saveEvent, sharedCalendars } = useAppData();
  const { t, locale } = useLocale();
  const weekDates = useMemo(() => getWeekDates(focusedDate), [focusedDate]);
  const screenWidth = Dimensions.get("window").width;
  const dayColumnWidth = Math.max(116, (screenWidth - TIME_LABEL_WIDTH) / 3.35);
  const verticalRef = useRef<ScrollView>(null);
  const headerRef = useRef<ScrollView>(null);
  const gridRef = useRef<ScrollView>(null);
  const showToday = weekDates.includes(todayLocalDateString());
  const reducedMotion = useReducedMotion();

  // ドラッグ中の座標計算に使うミュータブルな値
  const verticalScrollYRef = useRef(0);
  const dragStartScrollYRef = useRef(0);
  const horizontalScrollXRef = useRef(0);
  const dragStartScrollXRef = useRef(0);
  const lastAbsoluteYRef = useRef<number | null>(null);
  const lastAbsoluteXRef = useRef<number | null>(null);
  const lastTranslationYRef = useRef(0);
  const lastTranslationXRef = useRef(0);
  const verticalViewportRef = useRef<{ top: number; bottom: number } | null>(null);
  const horizontalViewportRef = useRef<{ left: number; right: number } | null>(null);
  const verticalDwellStartRef = useRef<number | null>(null);
  const horizontalDwellStartRef = useRef<number | null>(null);
  const lastDayIndexRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const dragStateRef = useRef<DragState | null>(null);
  /** 週替わり後も最新のクロージャで動き続けるための「常に最新」の自動スクロール処理 */
  const tickRef = useRef<() => void>(() => {});
  /** 直近に発行したドラッグセッションID。ドラッグ開始のたびにインクリメントし、
   *  オートスクロールの各フレームでdragStateRef.current.sessionIdと照合することで、
   *  古いセッションのループが残存・多重起動しないことを保証する。 */
  const dragSessionIdRef = useRef(0);
  /** アンマウント後にオートスクロールのRAFループが動き続けないようにするフラグ */
  const isMountedRef = useRef(true);
  /** ドロップ確定／キャンセルのsettleアニメーション中かどうか（onEnd直後に必ず発火する
   *  onFinalizeが、settleの遅延reset処理を上書きしてしまわないようにするためのガード） */
  const isSettlingRef = useRef(false);
  const settleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 直近にReact stateへ反映したbadgeBelow（変化した時だけsetDragStateするための比較用） */
  const lastBadgeBelowRef = useRef(false);

  // ドラッグ中カードの「見た目」の連続的な移動はReact stateを介さず、この3つの
  // shared valueへ直接書き込む（UIスレッド側のtransformだけが更新され、7日分の
  // イベントブロックを含むコンポーネント全体の再レンダーは発生しない）。
  const overlayTranslateX = useSharedValue(0);
  const overlayTranslateY = useSharedValue(0);
  const overlayScale = useSharedValue(1);
  const overlayOpacity = useSharedValue(1);

  const [dragState, setDragState] = useState<DragState | null>(null);

  const overlayAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: overlayTranslateX.value },
      { translateY: overlayTranslateY.value },
      { scale: overlayScale.value },
    ],
    opacity: overlayOpacity.value,
  }));

  useEffect(() => {
    const today = todayLocalDateString();
    const targetDate = weekDates.includes(today) ? today : focusedDate;
    const targetIndex = Math.max(0, weekDates.indexOf(targetDate));
    const visibleWidth = screenWidth - TIME_LABEL_WIDTH;
    const targetX = Math.max(
      0,
      targetIndex * dayColumnWidth - (visibleWidth - dayColumnWidth) / 2
    );
    const frame = requestAnimationFrame(() => {
      gridRef.current?.scrollTo({ x: targetX, animated: false });
      headerRef.current?.scrollTo({ x: targetX, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [dayColumnWidth, focusedDate, screenWidth, weekDates]);

  // [QA-F009-F012広範監査] 月表示（MonthView）と同じgroupEventsByDate（1回の走査でO(events.length)）
  // を再利用する。以前はweekDates(7日分)ごとにevents全体を毎回filterしておりO(7×events.length)
  // だった。layoutEventsForDayが内部で改めて時刻順にソートするため、グルーピング後の並び順は
  // 最終的な表示結果に影響しない（挙動は変更していない）。
  const eventsByDate = useMemo(() => groupEventsByDate(events), [events]);

  const hours = Array.from(
    { length: END_HOUR - START_HOUR },
    (_, i) => START_HOUR + i
  );

  // ドラッグ中に画面遷移等でアンマウントされても、オートスクロールのRAFループ・
  // settleの遅延タイマーを残さない。
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (settleTimeoutRef.current != null) {
        clearTimeout(settleTimeoutRef.current);
        settleTimeoutRef.current = null;
      }
    };
  }, []);

  const stopAutoScrollLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    verticalDwellStartRef.current = null;
    horizontalDwellStartRef.current = null;
  }, []);

  /** ドラッグを完全に破棄する（オートスクロール停止・settleタイマー解除・ドラッグ状態の初期化）。
   *  正常終了（settle完了後）・キャンセル・異常終了・アンマウント・表示中の週の変更など、
   *  ドラッグを終わらせるすべての経路から共通で呼ぶ。 */
  const resetDragState = useCallback(() => {
    stopAutoScrollLoop();
    if (settleTimeoutRef.current != null) {
      clearTimeout(settleTimeoutRef.current);
      settleTimeoutRef.current = null;
    }
    isSettlingRef.current = false;
    cancelAnimation(overlayScale);
    cancelAnimation(overlayOpacity);
    cancelAnimation(overlayTranslateX);
    cancelAnimation(overlayTranslateY);
    overlayScale.value = 1;
    overlayOpacity.value = 1;
    dragStateRef.current = null;
    setDragState(null);
  }, [overlayOpacity, overlayScale, overlayTranslateX, overlayTranslateY, stopAutoScrollLoop]);

  // 表示中の週が変わった場合（ドラッグ中に外部要因で発生しうる）、進行中のドラッグを破棄する。
  useEffect(() => {
    resetDragState();
  }, [focusedDate, resetDragState]);

  /** 指の移動量＋現在までの縦横スクロール差分を合算し、移動先プレビューを再計算する */
  const recomputePreview = useCallback(
    (translationX: number, translationY: number) => {
      const current = dragStateRef.current;
      if (!current) return;
      const scrollDeltaY = verticalScrollYRef.current - dragStartScrollYRef.current;
      const scrollDeltaX = horizontalScrollXRef.current - dragStartScrollXRef.current;
      const totalDeltaY = translationY + scrollDeltaY;
      const totalDeltaX = translationX + scrollDeltaX;
      const rawTop = current.originalTop + totalDeltaY;

      // 候補日時（previewStartTime）は「今どこへドラッグしようとしているか」を表す、
      // コンテンツ全体(0〜24時)の範囲だけでクランプした値から計算する。自動スクロールが
      // 指の動きに追いつききれていない間も、候補日時はここで変化し続ける
      // （見た目のクランプとは意図的に分離している）。
      const contentClampedTop = clampDragCardTop(rawTop, current.height);
      const previewStartTime = timeFromOffsetY(contentClampedTop);

      // 見た目の表示位置は、今まさに実際にスクロールされて見えている範囲内へ収める。
      const viewportHeight = verticalViewportRef.current
        ? verticalViewportRef.current.bottom - verticalViewportRef.current.top
        : TIMELINE_HEIGHT;
      const visualTop = clampCardToViewport(
        rawTop,
        current.height,
        verticalScrollYRef.current,
        viewportHeight
      );

      const contentX = current.originalDayIndex * dayColumnWidth + totalDeltaX;
      // 境界での列判定のちらつきを防ぐため、ヒステリシス付きで列を確定する
      // （2列以上離れた速いドラッグはヒステリシスなしで即座に切り替わる）。
      const hysteresisIndex = dayIndexFromOffsetXWithHysteresis(
        contentX,
        dayColumnWidth,
        lastDayIndexRef.current
      );
      // 週表示のドラッグ可能範囲は表示中の7日間(0〜6)に固定する。週送りは行わない
      const dayIndex = Math.min(Math.max(hysteresisIndex, 0), 6);
      lastDayIndexRef.current = dayIndex;
      const previewDate = dateFromDayIndex(weekDates, dayIndex) ?? current.previewDate;

      const renderTop = Math.max(visualTop - DRAG_LIFT_OFFSET, 0);
      const badgeBelow = renderTop < PREVIEW_BADGE_HEIGHT_ESTIMATE;

      const next: DragState = {
        ...current,
        previewStartTime,
        previewDate,
        badgeBelow,
      };
      dragStateRef.current = next;

      // 見た目の連続的な移動はshared valueへ直接書き込む（UIスレッド側のtransformのみが
      // 更新され、Reactの再レンダーは発生しない。指の動きに1:1で追従するため、ここでは
      // withTimingを使わず即座に反映する）。
      overlayTranslateX.value = contentX;
      overlayTranslateY.value = renderTop;

      // 候補（日付・時刻の15分バケット）が実際に変わった時だけ軽い触覚フィードバックを鳴らし、
      // 対応するReact stateも更新する（badgeBelowの反転も含め、7日分のイベントブロックを
      // 含む再レンダーは、この「候補が変わった」タイミングだけに限定する）。
      const candidateChanged =
        previewDate !== current.previewDate || previewStartTime !== current.previewStartTime;
      const badgeFlipped = badgeBelow !== lastBadgeBelowRef.current;
      if (candidateChanged) {
        Haptics.selectionAsync();
      }
      if (candidateChanged || badgeFlipped) {
        lastBadgeBelowRef.current = badgeBelow;
        setDragState(next);
      }
    },
    [dayColumnWidth, overlayTranslateX, overlayTranslateY, weekDates]
  );

  // 毎レンダーで最新のクロージャに更新する（週替わり後も古い weekDates/dayColumnWidth を参照しないため）
  tickRef.current = () => {
    // 毎フレームの安全確認：どれか一つでも不成立なら、このフレームでは何もせず、
    // ループ自体もここで自己終了する（再スケジュールしない）。stopAutoScrollLoop()が
    // 何らかの理由で呼ばれなかった場合でも、無限スクロールが残り続けない保険になる。
    const current = dragStateRef.current;
    const ok = shouldContinueAutoScroll({
      isMounted: isMountedRef.current,
      isDragging: current != null,
      activeSessionId: dragSessionIdRef.current,
      loopSessionId: current?.sessionId ?? -1,
    });
    if (!ok) {
      rafRef.current = null;
      return;
    }

    // このフレームで縦・横のどちらかがまだ「動ける可能性がある」状態かどうか。
    // どちらもfalse（エッジ領域の外、または境界に到達して動けない）になった時点で、
    // 次のrequestAnimationFrameを登録せずループを自己終了する——scrollToを呼ばない
    // だけでは不十分で、指を端に置いたままにするとRAFだけが空回りし続けてしまうため。
    let verticalNeedsFrames = false;
    let horizontalNeedsFrames = false;

    // 縦方向（時間軸）の自動スクロール
    if (verticalViewportRef.current && lastAbsoluteYRef.current != null) {
      const { top, bottom } = verticalViewportRef.current;
      const { direction, penetration } = decideAutoScrollEdge(
        lastAbsoluteYRef.current,
        top,
        bottom,
        DEFAULT_EDGE_SCROLL_CONFIG.edgeThreshold
      );
      if (direction === 0) {
        verticalDwellStartRef.current = null;
      } else {
        if (verticalDwellStartRef.current == null) verticalDwellStartRef.current = Date.now();
        const dwell = Date.now() - verticalDwellStartRef.current;
        const speed = edgeScrollSpeed(penetration, dwell);
        const viewportHeight = bottom - top;
        const maxScrollY = maximumScrollOffset(TIMELINE_HEIGHT, viewportHeight);
        const nextY =
          speed > 0
            ? nextAutoScrollOffset(verticalScrollYRef.current, direction, speed, maxScrollY)
            : verticalScrollYRef.current;
        const frame = evaluateAutoScrollFrame(direction, speed, verticalScrollYRef.current, nextY);
        verticalNeedsFrames = frame.needsMoreFrames;
        if (frame.moved) {
          verticalScrollYRef.current = nextY;
          verticalRef.current?.scrollTo({ y: nextY, animated: false });
          recomputePreview(lastTranslationXRef.current, lastTranslationYRef.current);
        }
      }
    }

    // 横方向（日付）の自動スクロール。表示中の週(0〜6日目)の範囲を超えては絶対にスクロールしない。
    // 週の端でスクロールが止まっても、前週・次週への切り替えは一切行わない
    if (horizontalViewportRef.current && lastAbsoluteXRef.current != null) {
      const { left, right } = horizontalViewportRef.current;
      const { direction, penetration } = decideAutoScrollEdge(
        lastAbsoluteXRef.current,
        left,
        right,
        DEFAULT_EDGE_SCROLL_CONFIG.edgeThreshold
      );
      if (direction === 0) {
        horizontalDwellStartRef.current = null;
      } else {
        if (horizontalDwellStartRef.current == null) horizontalDwellStartRef.current = Date.now();
        const dwell = Date.now() - horizontalDwellStartRef.current;
        const speed = edgeScrollSpeed(penetration, dwell);
        const viewportWidth = right - left;
        // 週は常に7日固定。この幅を超えるスクロールは発生しえない
        const totalContentWidth = weekDates.length * dayColumnWidth;
        const maxScrollX = maximumScrollOffset(totalContentWidth, viewportWidth);
        const nextX =
          speed > 0
            ? nextAutoScrollOffset(horizontalScrollXRef.current, direction, speed, maxScrollX)
            : horizontalScrollXRef.current;
        const frame = evaluateAutoScrollFrame(direction, speed, horizontalScrollXRef.current, nextX);
        horizontalNeedsFrames = frame.needsMoreFrames;
        if (frame.moved) {
          horizontalScrollXRef.current = nextX;
          gridRef.current?.scrollTo({ x: nextX, animated: false });
          recomputePreview(lastTranslationXRef.current, lastTranslationYRef.current);
        }
      }
    }

    if (!verticalNeedsFrames && !horizontalNeedsFrames) {
      rafRef.current = null;
      return;
    }
    rafRef.current = requestAnimationFrame(() => tickRef.current());
  };

  const startAutoScrollLoop = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => tickRef.current());
  }, []);

  const handleDragStart = useCallback(
    (
      event: AppEvent,
      item: PositionedEvent,
      dayIndex: number,
      absoluteX: number,
      absoluteY: number
    ) => {
      // 前回のドラッグのsettleアニメーション・遅延resetが残っていれば破棄し、新しいドラッグを
      // 常にニュートラルな状態（scale=1, opacity=1）から始める。
      if (settleTimeoutRef.current != null) {
        clearTimeout(settleTimeoutRef.current);
        settleTimeoutRef.current = null;
      }
      isSettlingRef.current = false;
      cancelAnimation(overlayScale);
      cancelAnimation(overlayOpacity);
      cancelAnimation(overlayTranslateX);
      cancelAnimation(overlayTranslateY);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      dragStartScrollYRef.current = verticalScrollYRef.current;
      dragStartScrollXRef.current = horizontalScrollXRef.current;
      lastAbsoluteYRef.current = absoluteY;
      lastAbsoluteXRef.current = absoluteX;
      lastTranslationYRef.current = 0;
      lastTranslationXRef.current = 0;
      lastDayIndexRef.current = dayIndex;

      const verticalHandle = findNodeHandle(verticalRef.current);
      if (verticalHandle != null) {
        UIManager.measure(verticalHandle, (_x, _y, _w, h, _pageX, pageY) => {
          verticalViewportRef.current = { top: pageY, bottom: pageY + h };
        });
      }
      const horizontalHandle = findNodeHandle(gridRef.current);
      if (horizontalHandle != null) {
        UIManager.measure(horizontalHandle, (_x, _y, w, _h, pageX, _pageY) => {
          horizontalViewportRef.current = { left: pageX, right: pageX + w };
        });
      }
      dragSessionIdRef.current += 1;
      const initialTop = clampDragCardTop(item.top, item.height);
      const initialRenderTop = Math.max(initialTop - DRAG_LIFT_OFFSET, 0);
      const initialLeft = dayIndex * dayColumnWidth;
      const initialBadgeBelow = initialRenderTop < PREVIEW_BADGE_HEIGHT_ESTIMATE;
      lastBadgeBelowRef.current = initialBadgeBelow;
      const initial: DragState = {
        sessionId: dragSessionIdRef.current,
        event,
        originalTop: item.top,
        originalDayIndex: dayIndex,
        height: item.height,
        columnIndex: item.columnIndex,
        columnCount: item.columnCount,
        previewDate: event.date,
        previewStartTime: event.startTime,
        badgeBelow: initialBadgeBelow,
      };
      dragStateRef.current = initial;
      setDragState(initial);

      overlayTranslateX.value = initialLeft;
      overlayTranslateY.value = initialRenderTop;
      overlayScale.value = 1;
      overlayOpacity.value = reducedMotion ? 1 : 0.97;
      if (reducedMotion) {
        overlayScale.value = 1;
        overlayOpacity.value = 1;
      } else {
        overlayScale.value = withTiming(LIFT_SCALE, { duration: LIFT_DURATION, easing: EASE_OUT });
        overlayOpacity.value = withTiming(1, { duration: LIFT_DURATION, easing: EASE_OUT });
      }

      stopAutoScrollLoop();
      startAutoScrollLoop();
    },
    [
      dayColumnWidth,
      overlayOpacity,
      overlayScale,
      overlayTranslateX,
      overlayTranslateY,
      reducedMotion,
      startAutoScrollLoop,
      stopAutoScrollLoop,
    ]
  );

  const handleDragUpdate = useCallback(
    (translationX: number, translationY: number, absoluteX: number, absoluteY: number) => {
      lastAbsoluteXRef.current = absoluteX;
      lastAbsoluteYRef.current = absoluteY;
      lastTranslationXRef.current = translationX;
      lastTranslationYRef.current = translationY;
      recomputePreview(translationX, translationY);
      // オートスクロールのRAFループが境界到達等で自己終了していた場合、指がその後
      // 中央へ戻ってから再び端へ入るなど、新たな指の動きがあるたびにここで再起動する
      // （startAutoScrollLoop自体は多重起動しないよう既にガードされている）。
      startAutoScrollLoop();
    },
    [recomputePreview, startAutoScrollLoop]
  );

  /** ドロップ確定（success）またはキャンセル（!success）の後始末。カードを最終的な
   *  位置（確定時は候補スロット、キャンセル時は元の位置）へ滑らかに戻しつつ、
   *  そのアニメーション分だけドラッグ状態を維持してから（=元の予定カードとゴーストの
   *  二重表示を避けてから）実際にドラッグ状態を破棄する。 */
  const beginSettle = useCallback(
    (success: boolean) => {
      const current = dragStateRef.current;
      stopAutoScrollLoop();
      if (!current) {
        resetDragState();
        return;
      }
      isSettlingRef.current = true;
      const sessionId = current.sessionId;

      const dayIndex = weekDates.indexOf(current.previewDate);
      const finalLeft = (dayIndex >= 0 ? dayIndex : current.originalDayIndex) * dayColumnWidth;
      const finalTop = success ? offsetYFromTime(current.previewStartTime) : current.originalTop;
      const finalLeftValue = success ? finalLeft : current.originalDayIndex * dayColumnWidth;

      const finish = () => {
        settleTimeoutRef.current = null;
        isSettlingRef.current = false;
        if (!isMountedRef.current) return;
        if (dragSessionIdRef.current !== sessionId) return;
        dragStateRef.current = null;
        setDragState(null);
      };

      if (reducedMotion) {
        overlayTranslateX.value = finalLeftValue;
        overlayTranslateY.value = finalTop;
        overlayScale.value = 1;
        overlayOpacity.value = 1;
        finish();
      } else {
        overlayTranslateX.value = withTiming(finalLeftValue, { duration: SETTLE_DURATION, easing: EASE_OUT });
        overlayTranslateY.value = withTiming(finalTop, { duration: SETTLE_DURATION, easing: EASE_OUT });
        overlayScale.value = withTiming(1, { duration: SETTLE_DURATION, easing: EASE_OUT });
        overlayOpacity.value = withTiming(1, { duration: SETTLE_DURATION, easing: EASE_OUT });
        settleTimeoutRef.current = setTimeout(finish, SETTLE_DURATION);
      }
    },
    [
      dayColumnWidth,
      overlayOpacity,
      overlayScale,
      overlayTranslateX,
      overlayTranslateY,
      reducedMotion,
      resetDragState,
      stopAutoScrollLoop,
      weekDates,
    ]
  );

  const handleDragEnd = useCallback(
    (success: boolean) => {
      const current = dragStateRef.current;
      if (current && success && !savingRef.current) {
        savingRef.current = true;
        const updated = applyTimeMove(current.event, current.previewDate, current.previewStartTime);
        saveEvent(updated)
          .then(() => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          })
          .catch(() => {
            Alert.alert(t("common.saveFailedTitle"), t("common.saveFailedMessage"));
          })
          .finally(() => {
            savingRef.current = false;
          });
      }
      beginSettle(success);
    },
    [beginSettle, saveEvent, t]
  );

  // onEnd（正常終了・失敗終了の両方でsuccessフラグ付きで呼ばれる）に加え、
  // onFinalize（キャンセルを含め、gestureが終わる経路すべてで必ず呼ばれる。onEndの直後にも
  // 必ず呼ばれる）・onTouchesCancelled（OSレベルでタッチが打ち切られた場合）のどちらでも、
  // 最終的にドラッグ状態を初期化する必要がある。ただしonEnd経由で既にsettleアニメーションが
  // 始まっている場合（isSettlingRef）は、onFinalizeがそれを上書きして即座にリセットしない
  // ようにする（settleの遅延resetにcleanup処理を一本化する）。
  const handleDragFinalize = useCallback(() => {
    if (isSettlingRef.current) return;
    beginSettle(false);
  }, [beginSettle]);

  const handleDragBlocked = useCallback((reason: string) => {
    Alert.alert(t("common.cannotMoveTitle"), reason);
  }, [t]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={[{ width: TIME_LABEL_WIDTH }, styles.headerCornerSpacer]} />
        <ScrollView ref={headerRef} horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false}><View style={styles.horizontalContent}>{weekDates.map((date, i) => {
          const today = isToday(date);
          return (
            <Pressable
              key={date}
              style={({ pressed }) => [
                styles.headerCell,
                { width: dayColumnWidth },
                pressed && styles.headerCellPressed,
              ]}
              onPress={() => onSelectDate(date)}
              accessibilityRole="button"
              accessibilityLabel={`${formatAgendaDayTitle(date, locale)}${today ? t("common.todaySuffix") : ""}`}
            >
              <Text
                style={[
                  styles.headerWeekday,
                  i === 0 && styles.sunday,
                  i === 6 && styles.saturday,
                ]}
              >
                {weekdayLabelByIndex(i, locale)}
              </Text>
              <View style={[styles.headerDateBadge, today && styles.headerDateBadgeToday]}>
                <Text
                  style={[styles.headerDate, today && styles.headerDateToday]}
                >
                  {formatShortDay(date)}
                </Text>
              </View>
            </Pressable>
          );
        })}</View></ScrollView>
      </View>
      <View style={styles.bodyRow}>
        <ScrollView
          ref={verticalRef}
          style={styles.scroll}
          showsVerticalScrollIndicator
          scrollEnabled={!dragState}
          onScroll={(e) => {
            verticalScrollYRef.current = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
        >
        <View style={{ flexDirection: "row", height: TIMELINE_HEIGHT }}>
          <View style={styles.timeGutter}>
            {hours.map((h) => (
              <View key={h} style={[styles.hourLabelRow, { height: HOUR_HEIGHT }]}>
                <Text style={styles.hourLabel}>{`${h}:00`}</Text>
              </View>
            ))}
          </View>
          <ScrollView
            ref={gridRef}
            horizontal
            showsHorizontalScrollIndicator
            scrollEnabled={!dragState}
            onScroll={(e) => {
              horizontalScrollXRef.current = e.nativeEvent.contentOffset.x;
              headerRef.current?.scrollTo({ x: e.nativeEvent.contentOffset.x, animated: false });
            }}
            scrollEventThrottle={16}
          >
          <View style={styles.horizontalContent}>
            {weekDates.map((date, dayIndex) => {
              const positioned = layoutEventsForDay(eventsByDate.get(date) ?? [], date);
              const isDropTarget = !!dragState && dragState.previewDate === date;
              const isCurrentDay = isToday(date);
              return (
                <Pressable
                  key={date}
                  style={({ pressed }) => [
                    styles.dayColumn,
                    { width: dayColumnWidth },
                    isCurrentDay && styles.dayColumnToday,
                    pressed && !!onCreateAt && styles.dayColumnPressed,
                    isDropTarget && styles.dayColumnDropTarget,
                  ]}
                  onPress={(e) => {
                    if (onCreateAt) {
                      onCreateAt(date, ceilTimeFromOffsetY(e.nativeEvent.locationY));
                    }
                  }}
                  accessibilityRole={onCreateAt ? "button" : undefined}
                  accessibilityLabel={onCreateAt ? `${formatAgendaDayTitle(date, locale)}${t("common.timeSlotSuffix")}` : undefined}
                  accessibilityHint={onCreateAt ? t("common.createEventHint") : undefined}
                >
                  <View pointerEvents="none" style={styles.dayColumnDivider} />
                  {hours.map((h) => (
                    <React.Fragment key={h}>
                      <View style={[styles.hourGridLine, { top: (h - START_HOUR) * HOUR_HEIGHT }]} />
                      <View
                        pointerEvents="none"
                        style={[
                          styles.halfHourGridLine,
                          { top: (h - START_HOUR) * HOUR_HEIGHT + HOUR_HEIGHT / 2 },
                        ]}
                      />
                    </React.Fragment>
                  ))}
                  {positioned.map((item) => {
                    const isDraggingThis = dragState?.event.id === item.event.id;
                    // [P0080 CORRECT-F016-002] DayView.tsxと同じ理由で、継続区間
                    // （isStartDay===false）はこの列（date）からのドラッグを許可しない。
                    const draggable = canEditEvent(item.event, sharedCalendars) && item.isStartDay;
                    const blockStyle: ViewStyle = {
                      top: item.top,
                      height: item.height,
                      left: `${(item.columnIndex / item.columnCount) * 100}%`,
                      width: `${100 / item.columnCount}%`,
                      opacity: isDraggingThis ? 0.35 : 1,
                    };
                    if (!draggable) {
                      const reason = !item.isStartDay
                        ? t("permissions.overnightContinuationCannotMove")
                        : dragDisabledReason(item.event, sharedCalendars, t) ?? "";
                      const longPressOnly = Gesture.LongPress()
                        .minDuration(LONG_PRESS_DURATION)
                        .onStart(() => {
                          runOnJS(handleDragBlocked)(reason);
                        });
                      return (
                        <GestureDetector key={item.event.id} gesture={longPressOnly}>
                          <EventBlock event={item.event} dense onPress={onSelectEvent} style={blockStyle} />
                        </GestureDetector>
                      );
                    }
                    const pan = Gesture.Pan()
                      .activateAfterLongPress(LONG_PRESS_DURATION)
                      .onStart((e) => {
                        runOnJS(handleDragStart)(item.event, item, dayIndex, e.absoluteX, e.absoluteY);
                      })
                      .onUpdate((e) => {
                        runOnJS(handleDragUpdate)(e.translationX, e.translationY, e.absoluteX, e.absoluteY);
                      })
                      .onEnd((_e, success) => {
                        runOnJS(handleDragEnd)(success);
                      })
                      .onFinalize(() => {
                        runOnJS(handleDragFinalize)();
                      })
                      .onTouchesCancelled(() => {
                        runOnJS(handleDragFinalize)();
                      });
                    return (
                      <GestureDetector key={item.event.id} gesture={pan}>
                        <EventBlock event={item.event} dense onPress={onSelectEvent} style={blockStyle} />
                      </GestureDetector>
                    );
                  })}
                </Pressable>
              );
            })}
            {dragState && (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.dragOverlay,
                  overlayAnimatedStyle,
                  {
                    width: dayColumnWidth,
                    height: dragState.height,
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
                <View style={dragState.badgeBelow ? styles.dragPreviewBadgeBelow : styles.dragPreviewBadge}>
                  <Text style={styles.dragPreviewText} numberOfLines={1}>
                    {t("weekView.dragPreviewLabel", {
                      weekday: weekdayLabel(dragState.previewDate, locale),
                      day: formatShortDay(dragState.previewDate),
                      time: dragState.previewStartTime,
                    })}
                  </Text>
                </View>
              </Animated.View>
            )}
          </View></ScrollView>
        </View>
        {showToday && (
          <View
            style={[
              StyleSheet.absoluteFillObject,
              { flexDirection: "row" },
            ]}
            pointerEvents="none"
          >
            <CurrentTimeLine top={currentTimeTop()} label={nowLabel()} />
          </View>
        )}
      </ScrollView></View>
      <View style={styles.weekNavigation}>
        <Pressable
          onPress={() => onNavigateWeek?.(-1)}
          style={styles.weekNavButton}
          accessibilityRole="button"
          accessibilityLabel={t("weekView.prevWeekA11y")}
        >
          <Text style={styles.weekNavText}>{t("weekView.prevWeekLabel")}</Text>
        </Pressable>
        <Text style={styles.swipeHint}>{t("weekView.swipeHint")}</Text>
        <Pressable
          onPress={() => onNavigateWeek?.(1)}
          style={styles.weekNavButton}
          accessibilityRole="button"
          accessibilityLabel={t("weekView.nextWeekA11y")}
        >
          <Text style={styles.weekNavText}>{t("weekView.nextWeekLabel")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function nowLabel(): string {
  const d = new Date();
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h}:${m < 10 ? "0" + m : m}`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  bodyRow: { flex: 1 },
  horizontalContent: { flexDirection: "row", position: "relative" },
  headerRow: {
    flexDirection: "row",
    // 主要区切り：曜日ヘッダーと時間軸本体の境目。背景も本体・フィルター欄と区別する。
    backgroundColor: colors.calendarHeaderSurface,
    borderBottomWidth: 1,
    borderBottomColor: colors.calendarMajorDivider,
    paddingVertical: spacing.xs,
  },
  /** ヘッダー行の左上、時刻欄の真上に来る空白セル。ヘッダー背景と地続きに見せる。 */
  headerCornerSpacer: {
    backgroundColor: colors.calendarHeaderSurface,
  },
  headerCell: {
    alignItems: "center",
    borderRadius: radius.sm,
  },
  headerCellPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  headerWeekday: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: "700",
  },
  sunday: { color: colors.warning },
  saturday: { color: colors.primary },
  headerDateBadge: {
    marginTop: 2,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  headerDateBadgeToday: {
    backgroundColor: colors.today,
  },
  headerDate: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  headerDateToday: {
    color: colors.textInverse,
  },
  scroll: {
    flex: 1,
  },
  weekNavigation: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.sm, paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider, backgroundColor: colors.surface },
  weekNavButton: { minHeight: minTapSize, justifyContent: "center", paddingHorizontal: 8 },
  weekNavText: { color: colors.primary, fontWeight: "700", fontSize: 12 },
  swipeHint: { color: colors.textTertiary, fontSize: 10 },
  /** 左側の時刻ラベル欄。本体（予定欄）とはごく薄い背景差＋主要区切り線で分ける。 */
  timeGutter: {
    width: TIME_LABEL_WIDTH,
    backgroundColor: colors.calendarTimeGutterSurface,
    borderRightWidth: 1,
    borderRightColor: colors.calendarMajorDivider,
  },
  hourLabelRow: {
    justifyContent: "flex-start",
    alignItems: "flex-end",
    paddingRight: 4,
  },
  hourLabel: {
    fontSize: 10,
    color: colors.textSecondary,
    marginTop: -6,
  },
  dayColumn: {
    backgroundColor: colors.calendarSurface,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.calendarNormalDivider,
    position: "relative",
  },
  dayColumnPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  /** 今日の列にごく薄くかける背景。予定カード自体は不透明な背景を持つため可読性は保たれる。 */
  dayColumnToday: {
    backgroundColor: colors.calendarTodaySurface,
  },
  dayColumnDropTarget: {
    backgroundColor: colors.primarySoft,
  },
  /** 曜日の境界を分かりやすくするための縦線。既存のborderLeftWidthは変更せず、
   *  絶対配置の装飾用オーバーレイとして追加する（列幅・レイアウト計算には影響しない）。 */
  dayColumnDivider: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: colors.calendarNormalDivider,
  },
  /** 通常区切り：1時間単位の線。以前より少し濃い色にして位置を追いやすくする。 */
  hourGridLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.calendarNormalDivider,
  },
  /** 補助区切り：30分単位の線。1時間線より明確に薄くし、常時強く出さない。 */
  halfHourGridLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.calendarMinorDivider,
  },
  dragOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    borderRadius: radius.sm,
    borderWidth: 2,
    paddingHorizontal: 6,
    paddingVertical: 3,
    zIndex: 10,
    ...shadow.elevated,
  },
  dragOverlayTitle: {
    fontSize: 12,
    fontWeight: "700",
  },
  dragPreviewBadge: {
    position: "absolute",
    bottom: "100%",
    marginBottom: spacing.xs,
    alignSelf: "flex-start",
    backgroundColor: colors.textPrimary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  /** カードが上端付近にあり、上に表示するスペースが無い場合に使う（固定ヘッダーへの被り防止）。 */
  dragPreviewBadgeBelow: {
    position: "absolute",
    top: "100%",
    marginTop: spacing.xs,
    alignSelf: "flex-start",
    backgroundColor: colors.textPrimary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  dragPreviewText: {
    color: colors.textInverse,
    fontSize: 11,
    fontWeight: "700",
  },
});
