import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
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
import { colors } from "@/theme/colors";
import { radius, shadow, spacing } from "@/theme/spacing";
import { formatDayTitle, isToday } from "@/utils/date";
import { eventTouchedDates } from "@/utils/eventDaySlice";
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

const TIME_LABEL_WIDTH = 56;
/** ドラッグ中、予定を指の真下に置かないための持ち上げ量(px) */
const DRAG_LIFT_OFFSET = 14;
/** 長押しが成立してドラッグへ入るまでの時間(ms)。エッジスクロールのactivationDelayとは別の値 */
const LONG_PRESS_DURATION = 300;
/** プレビュー時刻バッジの概算の高さ(px)。カードの表示位置がこれ未満まで上端に近づいたら、
 *  バッジをカードの上ではなく下へ表示し、固定ヘッダーへ被らないようにする。 */
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
  onSelectEvent: (event: AppEvent) => void;
  /** 空いている時間帯をタップしたときに、通常予定登録画面を開くためのコールバック */
  onCreateAt?: (date: string, startTime: string) => void;
}

interface DragState {
  /** このドラッグセッションを識別するID（dragSessionIdRefと照合し、古いオートスクロール
   *  ループの残存・多重起動を検知するために使う）。 */
  sessionId: number;
  event: AppEvent;
  originalTop: number;
  height: number;
  columnIndex: number;
  columnCount: number;
  previewStartTime: string;
  /** プレビュー時刻バッジをカードの上ではなく下に表示すべきか（上端付近でヘッダーに被らないため） */
  badgeBelow: boolean;
}

export function DayView({ focusedDate, events, onSelectEvent, onCreateAt }: Props) {
  const { saveEvent, sharedCalendars } = useAppData();
  const { t, locale } = useLocale();
  const scrollRef = useRef<ScrollView>(null);
  const reducedMotion = useReducedMotion();

  // ドラッグ中の座標計算に使うミュータブルな値（再レンダーを起こさず高頻度に更新するためref管理）
  const scrollYRef = useRef(0);
  const dragStartScrollYRef = useRef(0);
  const lastAbsoluteYRef = useRef<number | null>(null);
  const lastTranslationYRef = useRef(0);
  const viewportBoundsRef = useRef<{ top: number; bottom: number } | null>(null);
  const edgeDwellStartRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const dragStateRef = useRef<DragState | null>(null);
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

  // ドラッグ中カードの「見た目」の連続的な移動はReact stateを介さず、shared valueへ直接
  // 書き込む（UIスレッド側のtransformだけが更新され、コンポーネント全体の再レンダーは
  // 発生しない）。日表示は横方向の移動が無いためtranslateYのみで足りる。
  const overlayTranslateY = useSharedValue(0);
  const overlayScale = useSharedValue(1);
  const overlayOpacity = useSharedValue(1);

  const [dragState, setDragState] = useState<DragState | null>(null);

  const overlayAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: overlayTranslateY.value }, { scale: overlayScale.value }],
    opacity: overlayOpacity.value,
  }));

  // [P0080 CORRECT-F016-002] 以前はe.date===focusedDateのみで、前日から続く
  // overnight NormalEvent（例: 23:40開始→翌日00:40終了）の継続部分が翌日の表示から
  // 消えていた（実バグ）。eventTouchedDates（唯一の投影権限）で判定する。
  const dayEvents = useMemo(
    () => events.filter((e) => eventTouchedDates(e).includes(focusedDate)),
    [events, focusedDate]
  );
  const positioned = useMemo(
    () => layoutEventsForDay(dayEvents, focusedDate),
    [dayEvents, focusedDate]
  );
  const hours = Array.from(
    { length: END_HOUR - START_HOUR },
    (_, i) => START_HOUR + i
  );
  const today = isToday(focusedDate);

  useEffect(() => {
    // 今日なら現在時刻の約2時間前、別の日なら朝8時から見せる。
    // 0時始まりで毎回スクロールさせる負担をなくす。
    const initialHour = today ? Math.max(0, new Date().getHours() - 2) : 8;
    const targetY = (initialHour - START_HOUR) * HOUR_HEIGHT;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: targetY, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedDate, today]);

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
    edgeDwellStartRef.current = null;
  }, []);

  /** ドラッグを完全に破棄する（オートスクロール停止・settleタイマー解除・ドラッグ状態の初期化）。
   *  正常終了（settle完了後）・キャンセル・異常終了・アンマウント・表示中の日の変更など、
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
    cancelAnimation(overlayTranslateY);
    overlayScale.value = 1;
    overlayOpacity.value = 1;
    dragStateRef.current = null;
    setDragState(null);
  }, [overlayOpacity, overlayScale, overlayTranslateY, stopAutoScrollLoop]);

  // 表示中の日が変わった場合（ドラッグ中に外部要因で発生しうる）、進行中のドラッグを破棄する。
  useEffect(() => {
    resetDragState();
  }, [focusedDate, resetDragState]);

  /** 指の移動量＋現在までの自動スクロール差分を合算し、移動先プレビューを再計算する */
  const recomputePreview = useCallback(
    (translationY: number) => {
      const current = dragStateRef.current;
      if (!current) return;
      const scrollDelta = scrollYRef.current - dragStartScrollYRef.current;
      const totalDelta = translationY + scrollDelta;
      const rawTop = current.originalTop + totalDelta;

      // 候補時刻（previewStartTime）は「今どこへドラッグしようとしているか」を表す、
      // コンテンツ全体(0〜24時)の範囲だけでクランプした値から計算する。自動スクロールが
      // 指の動きに追いつききれていない間も、候補時刻はここで変化し続ける
      // （見た目のクランプとは意図的に分離している）。
      const contentClampedTop = clampDragCardTop(rawTop, current.height);
      const previewStartTime = timeFromOffsetY(contentClampedTop);

      // 見た目の表示位置は、今まさに実際にスクロールされて見えている範囲内へ収める。
      const viewportHeight = viewportBoundsRef.current
        ? viewportBoundsRef.current.bottom - viewportBoundsRef.current.top
        : TIMELINE_HEIGHT;
      const visualTop = clampCardToViewport(rawTop, current.height, scrollYRef.current, viewportHeight);
      const renderTop = Math.max(visualTop - DRAG_LIFT_OFFSET, 0);
      const badgeBelow = renderTop < PREVIEW_BADGE_HEIGHT_ESTIMATE;

      const next: DragState = { ...current, previewStartTime, badgeBelow };
      dragStateRef.current = next;

      // 見た目の連続的な移動はshared valueへ直接書き込む（指の動きに1:1で追従するため、
      // ここではwithTimingを使わず即座に反映する）。
      overlayTranslateY.value = renderTop;

      // 候補（15分バケット）が実際に変わった時だけ軽い触覚フィードバックを鳴らし、
      // 対応するReact stateも更新する（連続的な指の動きのたびに再レンダーしないようにする）。
      const candidateChanged = previewStartTime !== current.previewStartTime;
      const badgeFlipped = badgeBelow !== lastBadgeBelowRef.current;
      if (candidateChanged) {
        Haptics.selectionAsync();
      }
      if (candidateChanged || badgeFlipped) {
        lastBadgeBelowRef.current = badgeBelow;
        setDragState(next);
      }
    },
    [overlayTranslateY]
  );

  const autoScrollTick = useCallback(() => {
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

    // このフレームでまだ「動ける可能性がある」状態かどうか。falseになった時点で、
    // 次のrequestAnimationFrameを登録せずループを自己終了する——scrollToを呼ばない
    // だけでは不十分で、指を端に置いたままにするとRAFだけが空回りし続けてしまうため。
    let needsMoreFrames = false;

    if (viewportBoundsRef.current && lastAbsoluteYRef.current != null) {
      const { top, bottom } = viewportBoundsRef.current;
      const { direction, penetration } = decideAutoScrollEdge(
        lastAbsoluteYRef.current,
        top,
        bottom,
        DEFAULT_EDGE_SCROLL_CONFIG.edgeThreshold
      );

      if (direction === 0) {
        edgeDwellStartRef.current = null;
      } else {
        if (edgeDwellStartRef.current == null) edgeDwellStartRef.current = Date.now();
        const dwell = Date.now() - edgeDwellStartRef.current;
        const speed = edgeScrollSpeed(penetration, dwell);
        const viewportHeight = bottom - top;
        const maxScrollY = maximumScrollOffset(TIMELINE_HEIGHT, viewportHeight);
        const nextY =
          speed > 0
            ? nextAutoScrollOffset(scrollYRef.current, direction, speed, maxScrollY)
            : scrollYRef.current;
        const frame = evaluateAutoScrollFrame(direction, speed, scrollYRef.current, nextY);
        needsMoreFrames = frame.needsMoreFrames;
        if (frame.moved) {
          scrollYRef.current = nextY;
          scrollRef.current?.scrollTo({ y: nextY, animated: false });
          // 見た目と保存時刻がずれないよう、スクロール差分を即座に計算へ反映する
          recomputePreview(lastTranslationYRef.current);
        }
      }
    }

    if (!needsMoreFrames) {
      rafRef.current = null;
      return;
    }
    rafRef.current = requestAnimationFrame(autoScrollTick);
  }, [recomputePreview]);

  const handleDragStart = useCallback(
    (event: AppEvent, item: PositionedEvent, absoluteY: number) => {
      // 前回のドラッグのsettleアニメーション・遅延resetが残っていれば破棄し、新しいドラッグを
      // 常にニュートラルな状態（scale=1, opacity=1）から始める。
      if (settleTimeoutRef.current != null) {
        clearTimeout(settleTimeoutRef.current);
        settleTimeoutRef.current = null;
      }
      isSettlingRef.current = false;
      cancelAnimation(overlayScale);
      cancelAnimation(overlayOpacity);
      cancelAnimation(overlayTranslateY);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      dragStartScrollYRef.current = scrollYRef.current;
      lastAbsoluteYRef.current = absoluteY;
      lastTranslationYRef.current = 0;
      const handle = findNodeHandle(scrollRef.current);
      if (handle != null) {
        UIManager.measure(handle, (_x, _y, _w, h, _pageX, pageY) => {
          viewportBoundsRef.current = { top: pageY, bottom: pageY + h };
        });
      }
      dragSessionIdRef.current += 1;
      const initialTop = clampDragCardTop(item.top, item.height);
      const initialRenderTop = Math.max(initialTop - DRAG_LIFT_OFFSET, 0);
      const initialBadgeBelow = initialRenderTop < PREVIEW_BADGE_HEIGHT_ESTIMATE;
      lastBadgeBelowRef.current = initialBadgeBelow;
      const initial: DragState = {
        sessionId: dragSessionIdRef.current,
        event,
        originalTop: item.top,
        height: item.height,
        columnIndex: item.columnIndex,
        columnCount: item.columnCount,
        previewStartTime: event.startTime,
        badgeBelow: initialBadgeBelow,
      };
      dragStateRef.current = initial;
      setDragState(initial);

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
      rafRef.current = requestAnimationFrame(autoScrollTick);
    },
    [autoScrollTick, overlayOpacity, overlayScale, overlayTranslateY, reducedMotion, stopAutoScrollLoop]
  );

  const handleDragUpdate = useCallback(
    (translationY: number, absoluteY: number) => {
      lastAbsoluteYRef.current = absoluteY;
      lastTranslationYRef.current = translationY;
      recomputePreview(translationY);
      // オートスクロールのRAFループが境界到達等で自己終了していた場合、指がその後
      // 中央へ戻ってから再び端へ入るなど、新たな指の動きがあるたびにここで再起動する。
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(autoScrollTick);
      }
    },
    [autoScrollTick, recomputePreview]
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
      const finalTop = success ? offsetYFromTime(current.previewStartTime) : current.originalTop;

      const finish = () => {
        settleTimeoutRef.current = null;
        isSettlingRef.current = false;
        if (!isMountedRef.current) return;
        if (dragSessionIdRef.current !== sessionId) return;
        dragStateRef.current = null;
        setDragState(null);
      };

      if (reducedMotion) {
        overlayTranslateY.value = finalTop;
        overlayScale.value = 1;
        overlayOpacity.value = 1;
        finish();
      } else {
        overlayTranslateY.value = withTiming(finalTop, { duration: SETTLE_DURATION, easing: EASE_OUT });
        overlayScale.value = withTiming(1, { duration: SETTLE_DURATION, easing: EASE_OUT });
        overlayOpacity.value = withTiming(1, { duration: SETTLE_DURATION, easing: EASE_OUT });
        settleTimeoutRef.current = setTimeout(finish, SETTLE_DURATION);
      }
    },
    [overlayOpacity, overlayScale, overlayTranslateY, reducedMotion, resetDragState, stopAutoScrollLoop]
  );

  const handleDragEnd = useCallback(
    (success: boolean) => {
      const current = dragStateRef.current;
      if (current && success && !savingRef.current) {
        savingRef.current = true;
        const updated = applyTimeMove(current.event, focusedDate, current.previewStartTime);
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
    [beginSettle, focusedDate, saveEvent, t]
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
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      scrollEnabled={!dragState}
      onScroll={(e) => {
        scrollYRef.current = e.nativeEvent.contentOffset.y;
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
        <Pressable
          style={({ pressed }) => [
            styles.dayColumn,
            today && styles.dayColumnToday,
            pressed && !!onCreateAt && styles.dayColumnPressed,
          ]}
          onPress={(e) => {
            if (onCreateAt) {
              onCreateAt(focusedDate, ceilTimeFromOffsetY(e.nativeEvent.locationY));
            }
          }}
          accessibilityRole={onCreateAt ? "button" : undefined}
          accessibilityLabel={onCreateAt ? `${formatDayTitle(focusedDate, locale)}${t("common.timeSlotSuffix")}` : undefined}
          accessibilityHint={onCreateAt ? t("common.createEventHint") : undefined}
        >
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
            // [P0080 CORRECT-F016-002] 前日から続く継続区間（isStartDay===false）は、
            // event.dateがこの日ではなく前日を指すため、ここでドラッグして
            // applyTimeMove(event, focusedDate, ...)を呼ぶと予定の開始日を
            // 誤って書き換えてしまう。開始日側のブロックからのみ移動できる。
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
                  <EventBlock event={item.event} onPress={onSelectEvent} style={blockStyle} />
                </GestureDetector>
              );
            }
            const pan = Gesture.Pan()
              .activateAfterLongPress(LONG_PRESS_DURATION)
              .onStart((e) => {
                runOnJS(handleDragStart)(item.event, item, e.absoluteY);
              })
              .onUpdate((e) => {
                runOnJS(handleDragUpdate)(e.translationY, e.absoluteY);
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
                <EventBlock event={item.event} onPress={onSelectEvent} style={blockStyle} />
              </GestureDetector>
            );
          })}
          {dragState && (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.dragOverlay,
                overlayAnimatedStyle,
                {
                  height: dragState.height,
                  left: `${(dragState.columnIndex / dragState.columnCount) * 100}%`,
                  width: `${100 / dragState.columnCount}%`,
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
                <Text style={styles.dragPreviewText}>
                  {formatDayTitle(focusedDate, locale)} {dragState.previewStartTime}
                </Text>
              </View>
            </Animated.View>
          )}
        </Pressable>
        {today && (
          <View
            style={[StyleSheet.absoluteFillObject, { flexDirection: "row" }]}
            pointerEvents="none"
          >
            <CurrentTimeLine top={currentTimeTop()} label={nowLabel()} />
          </View>
        )}
      </View>
    </ScrollView>
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
    paddingRight: 6,
  },
  hourLabel: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: -6,
  },
  dayColumn: {
    flex: 1,
    backgroundColor: colors.calendarSurface,
    borderLeftWidth: 1,
    borderLeftColor: colors.calendarNormalDivider,
    position: "relative",
  },
  dayColumnPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  /** 今日を表示している場合にごく薄くかける背景。予定カード自体は不透明背景のため可読性は保たれる。 */
  dayColumnToday: {
    backgroundColor: colors.calendarTodaySurface,
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
