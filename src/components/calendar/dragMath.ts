import { AppEvent, isFocusTask, isNormalEvent } from "@/types/event";
import { MonthCell } from "@/utils/date";
import { minutesToTime, resolveEndDate, timeToMinutes } from "@/utils/time";
import { HOUR_HEIGHT, START_HOUR, TIMELINE_HEIGHT } from "./timelineLayout";

/**
 * ドラッグ＆ドロップ編集（日・週・月表示）のための、UIから独立した座標・日時計算。
 * すべて純関数。実際の保存呼び出し（AppDataContext.saveEvent）は各View側が行う。
 */

const MIN_MINUTES = 0;
const MAX_MINUTES = 23 * 60 + 45; // 23:45（1日の最後の15分刻み）

/** 分（小数可）を15分単位に丸め（最も近い方向へ）、1日の範囲へクランプする */
export function snapToQuarterHour(rawMinutes: number): number {
  const rounded = Math.round(rawMinutes / 15) * 15;
  return Math.min(Math.max(rounded, MIN_MINUTES), MAX_MINUTES);
}

/**
 * 分（小数可）を15分単位で切り上げ、1日の範囲へクランプする（最も近い方向ではなく、
 * 常に次の15分刻みへ進める）。例: 3分→15分、22分→30分、53分→次の時の00分。
 * ちょうど15分刻みの値（0/15/30/45）はそのまま変化しない。
 */
export function ceilToQuarterHour(rawMinutes: number): number {
  const rounded = Math.ceil(rawMinutes / 15) * 15;
  return Math.min(Math.max(rounded, MIN_MINUTES), MAX_MINUTES);
}

/**
 * タイムライン上のY座標（px） -> 15分単位（最も近い方向への丸め）の "HH:mm"。
 * 既存の予定を動かす（ドラッグ&ドロップ）操作専用。
 */
export function timeFromOffsetY(y: number): string {
  const rawMinutes = START_HOUR * 60 + (y / HOUR_HEIGHT) * 60;
  return minutesToTime(snapToQuarterHour(rawMinutes));
}

/**
 * タイムライン上のY座標（px） -> 15分単位に切り上げた "HH:mm"。
 * 「空いている時間帯をタップして予定作成画面を開く」フロー専用。
 * ドラッグ&ドロップ（timeFromOffsetY、最も近い15分へ丸める）とは異なり、
 * こちらは常に次の15分刻みへ切り上げる（例: 22分でタップ→30分、53分でタップ→次の時の00分）。
 */
export function ceilTimeFromOffsetY(y: number): string {
  const rawMinutes = START_HOUR * 60 + (y / HOUR_HEIGHT) * 60;
  return minutesToTime(ceilToQuarterHour(rawMinutes));
}

/** "HH:mm" -> タイムライン上のY座標（px）。timeFromOffsetYの逆関数 */
export function offsetYFromTime(time: string): number {
  const minutes = timeToMinutes(time);
  return (minutes - START_HOUR * 60) * (HOUR_HEIGHT / 60);
}

/** 週表示: X座標（px） -> 日カラムのインデックス（0〜6にクランプ） */
export function dayIndexFromOffsetX(x: number, dayColumnWidth: number): number {
  if (dayColumnWidth <= 0) return 0;
  const index = Math.floor(x / dayColumnWidth);
  return Math.min(Math.max(index, 0), 6);
}

/**
 * dayIndexFromOffsetXにヒステリシス（不感帯）を加えたもの。境界ぎりぎりで指が
 * 微小に揺れても列の判定がちらつかない（flip-flopしない）ようにするための、
 * 週表示ドラッグ専用の補助関数。
 *
 * 現在の確定インデックス(currentIndex)から隣接列へ移る場合のみ、境界から
 * hysteresis(px)分だけ余分に越えたところで初めて切り替える。2列以上離れた
 * インデックスへ一気に移動した場合（速いドラッグでの飛び越し）はヒステリシスの
 * 対象にせず、そのまま切り替える（曖昧さが無いため待たせる必要がない）。
 */
export function dayIndexFromOffsetXWithHysteresis(
  x: number,
  dayColumnWidth: number,
  currentIndex: number,
  hysteresis: number = 8
): number {
  if (dayColumnWidth <= 0) return currentIndex;
  const rawIndex = dayIndexFromOffsetX(x, dayColumnWidth);
  if (rawIndex === currentIndex) return currentIndex;
  if (Math.abs(rawIndex - currentIndex) > 1) return rawIndex;
  if (rawIndex > currentIndex) {
    const boundary = rawIndex * dayColumnWidth + hysteresis;
    return x >= boundary ? rawIndex : currentIndex;
  }
  const boundary = currentIndex * dayColumnWidth - hysteresis;
  return x < boundary ? rawIndex : currentIndex;
}

/** 週表示: 日カラムのインデックス -> 対応する日付文字列 */
export function dateFromDayIndex(
  weekDates: string[],
  index: number
): string | undefined {
  if (weekDates.length === 0) return undefined;
  const clamped = Math.min(Math.max(index, 0), weekDates.length - 1);
  return weekDates[clamped];
}

/** 月表示: グリッド内の(x,y) -> 42セル(7列×6行)のインデックス */
export function monthCellIndexFromOffset(
  x: number,
  y: number,
  gridWidth: number,
  gridHeight: number
): number {
  const colWidth = gridWidth / 7;
  const rowHeight = gridHeight / 6;
  const col = colWidth > 0 ? Math.min(Math.max(Math.floor(x / colWidth), 0), 6) : 0;
  const row = rowHeight > 0 ? Math.min(Math.max(Math.floor(y / rowHeight), 0), 5) : 0;
  return row * 7 + col;
}

/** 月表示: セルインデックス -> 対応する日付文字列 */
export function dateFromMonthCellIndex(
  cells: MonthCell[],
  index: number
): string | undefined {
  if (cells.length === 0) return undefined;
  const clamped = Math.min(Math.max(index, 0), cells.length - 1);
  return cells[clamped].date;
}

/**
 * 日付・開始時刻を変更し、所要時間を維持した新しいイベントを返す（既存イベントはミューテートしない）。
 * NormalEventは終了時刻を再計算、FocusTaskはdurationMinutesをそのまま維持する。
 */
export function applyTimeMove(
  event: AppEvent,
  newDate: string,
  newStartTime: string
): AppEvent {
  const updatedAt = new Date().toISOString();
  if (isFocusTask(event)) {
    return { ...event, date: newDate, startTime: newStartTime, updatedAt };
  }
  const durationMinutes =
    (timeToMinutes(event.endTime) - timeToMinutes(event.startTime) + 1440) % 1440;
  const newEndTime = minutesToTime(timeToMinutes(newStartTime) + durationMinutes);
  // [P0078 CORRECT-F016-001] endDateはresolveEndDateだけが正本。旧event.endDateを
  // そのまま持ち越すと、日付が繰り上がっていた予定を移動した際に「元の日付+1」を
  // 指したまま古い値が残ってしまう（新しいdate+1へ再計算する必要がある）。
  const resolvedEndDate = resolveEndDate(newDate, newStartTime, newEndTime);
  return {
    ...event,
    date: newDate,
    startTime: newStartTime,
    endTime: newEndTime,
    endDate: resolvedEndDate === newDate ? undefined : resolvedEndDate,
    updatedAt,
  };
}

/**
 * 日付だけを変更し、時刻は一切変更しない（月表示で「元の時刻のまま保存」を選んだ場合に使う）。
 */
export function applyDateMove(event: AppEvent, newDate: string): AppEvent {
  // [P0078 CORRECT-F016-001] 時刻は変えないため、endDateの「dateから見た日数オフセット」は
  // resolveEndDateで新しいdate基準に再計算しても変わらない（applyTimeMoveと同じ理由）。
  if (isNormalEvent(event)) {
    const resolvedEndDate = resolveEndDate(newDate, event.startTime, event.endTime);
    return {
      ...event,
      date: newDate,
      endDate: resolvedEndDate === newDate ? undefined : resolvedEndDate,
      updatedAt: new Date().toISOString(),
    };
  }
  return { ...event, date: newDate, updatedAt: new Date().toISOString() };
}

/**
 * 日付と時刻の両方を変更する（月表示の確認シートで時刻を指定した場合に使う）。
 * 内部的にはapplyTimeMoveと同じ所要時間維持ロジック。
 */
export function applyDateAndTimeMove(
  event: AppEvent,
  newDate: string,
  newStartTime: string
): AppEvent {
  return applyTimeMove(event, newDate, newStartTime);
}

/**
 * ドラッグ中の予定カードの表示位置（コンテンツ座標系のtop）を、実際にスクロール可能な
 * 時間軸コンテンツの範囲[0, contentHeight-cardHeight]へ収める。週表示・日表示で共通。
 * 曜日ヘッダー・下部操作欄・下部ナビゲーションはScrollViewの外側の兄弟要素のため、
 * コンテンツ座標をこの範囲に収めればスクロール位置に関わらず必ずScrollView内に描画される
 * （ページ座標系への変換は不要）。dropしたときの時刻計算にもこの値をそのまま使うことで、
 * 「0:00より前・24:00を超える時刻を生成しない」という制約も同時に満たす。
 */
export function clampDragCardTop(
  rawTop: number,
  cardHeight: number,
  contentHeight: number = TIMELINE_HEIGHT
): number {
  const maxTop = Math.max(contentHeight - cardHeight, 0);
  return Math.min(Math.max(rawTop, 0), maxTop);
}

/**
 * ドラッグ中の予定カードの「見た目の」表示位置（コンテンツ座標系のtop）を、
 * 今まさに画面へ実際にスクロールされて見えている範囲
 * [viewportScrollTop, viewportScrollTop + viewportHeight] へ収める。
 *
 * clampDragCardTopが1日全体（0〜24時のコンテンツ範囲）でクランプするのに対し、こちらは
 * 「現在の実際のスクロール位置」を基準にクランプするため、自動スクロールが指の動きに
 * 追いつききれていない場合でも、カードは常に画面内（曜日ヘッダーの下端〜下部操作欄の
 * 上端の間）に留まり、ヘッダーの裏へ隠れたり画面外へ消えたりしない。
 *
 * カードの高さがビューポートの高さを超える極端なケースでも、上限が下限を下回って
 * 計算が破綻しないよう、その場合はビューポート上端へピン留めする。
 */
export function clampCardToViewport(
  rawTop: number,
  cardHeight: number,
  viewportScrollTop: number,
  viewportHeight: number
): number {
  const availableHeight = Math.max(viewportHeight - cardHeight, 0);
  const upperBound = viewportScrollTop + availableHeight;
  return Math.min(Math.max(rawTop, viewportScrollTop), upperBound);
}

/** コンテンツ全体の高さとビューポートの高さから、ScrollViewが取りうる最大スクロール量を求める */
export function maximumScrollOffset(contentHeight: number, viewportHeight: number): number {
  return Math.max(contentHeight - viewportHeight, 0);
}

export interface EdgeScrollConfig {
  /** エッジ領域の幅（px） */
  edgeThreshold: number;
  /** エッジ領域に入ってから自動スクロールを開始するまでの待機時間（ms） */
  activationDelay: number;
  /** エッジ境界での最小速度（px/frame相当） */
  minSpeed: number;
  /** 物理的な端での最大速度（px/frame相当） */
  maxSpeed: number;
}

export const DEFAULT_EDGE_SCROLL_CONFIG: EdgeScrollConfig = {
  edgeThreshold: 80,
  activationDelay: 250,
  minSpeed: 4,
  maxSpeed: 18,
};

/**
 * エッジ領域への侵入量(penetration, 0=境界〜edgeThreshold=物理端)と、
 * エッジ領域に留まっている時間(dwellTime, ms)から自動スクロール速度を計算する。
 * dwellTimeがactivationDelay未満なら0（誤操作防止）。
 */
export function edgeScrollSpeed(
  penetration: number,
  dwellTime: number,
  config: EdgeScrollConfig = DEFAULT_EDGE_SCROLL_CONFIG
): number {
  if (dwellTime < config.activationDelay) return 0;
  if (config.edgeThreshold <= 0) return config.maxSpeed;
  const clamped = Math.min(Math.max(penetration, 0), config.edgeThreshold);
  const ratio = clamped / config.edgeThreshold;
  return config.minSpeed + (config.maxSpeed - config.minSpeed) * ratio;
}

export interface AutoScrollEdgeDecision {
  direction: -1 | 0 | 1;
  penetration: number;
}

/**
 * 指（またはドラッグ基準点）の画面上のY座標と、実際に測定したビューポートの上端・下端から、
 * 自動スクロールすべき方向と、エッジ領域への侵入量を判定する。上端・下端どちらの判定にも
 * 使える対称なロジック（上端だけ／下端だけが動く、という非対称バグを防ぐため、
 * 週表示・日表示のどちらもこの1つの関数を共通で使う）。
 */
export function decideAutoScrollEdge(
  pointerY: number,
  viewportTop: number,
  viewportBottom: number,
  edgeThreshold: number = DEFAULT_EDGE_SCROLL_CONFIG.edgeThreshold
): AutoScrollEdgeDecision {
  const distanceFromTop = pointerY - viewportTop;
  const distanceFromBottom = viewportBottom - pointerY;
  if (distanceFromTop < edgeThreshold) {
    return { direction: -1, penetration: edgeThreshold - Math.max(distanceFromTop, 0) };
  }
  if (distanceFromBottom < edgeThreshold) {
    return { direction: 1, penetration: edgeThreshold - Math.max(distanceFromBottom, 0) };
  }
  return { direction: 0, penetration: 0 };
}

/**
 * 自動スクロールの次のオフセットを、[0, maxOffset]の範囲へクランプして返す。
 * 上端では0未満にならず、下端ではmaxOffset（＝maximumScrollOffsetの結果）を超えない。
 */
export function nextAutoScrollOffset(
  currentOffset: number,
  direction: -1 | 0 | 1,
  speed: number,
  maxOffset: number
): number {
  return Math.min(Math.max(currentOffset + direction * speed, 0), maxOffset);
}

export interface AutoScrollFrameResult {
  /** このフレームで実際にオフセットが変化した（scrollToが必要だった）か */
  moved: boolean;
  /**
   * このフレームの後、次のrequestAnimationFrameを登録すべきか。
   * エッジ領域の外（direction=0）や、境界（0:00・最下部など）に到達していてこれ以上
   * 動けない（nextOffsetがcurrentOffsetと同じ）場合はfalseになる——scrollToを呼ばない
   * だけでなく、ループ自体もそこで自己終了させるための判定に使う。dwell待ち（speedが
   * まだ0）の間は、待機時間を計測し続ける必要があるためtrueのままにする。
   */
  needsMoreFrames: boolean;
}

/**
 * 1軸分の自動スクロール判定結果から、「このフレームでオフセットが動いたか」
 * 「次のフレームも登録すべきか」を求める。
 * - direction=0（エッジ領域の外）: 何もする必要が無い → needsMoreFrames=false
 * - direction≠0だがspeed<=0（activationDelay未満でまだ発動前）: 待機時間の計測を
 *   続ける必要がある → needsMoreFrames=true
 * - direction≠0でspeed>0: 実際に動けていれば(moved)続行、境界に到達して
 *   nextOffset===currentOffsetになった（movementImpossible）ならneedsMoreFrames=false
 */
export function evaluateAutoScrollFrame(
  direction: -1 | 0 | 1,
  speed: number,
  currentOffset: number,
  nextOffset: number
): AutoScrollFrameResult {
  if (direction === 0) return { moved: false, needsMoreFrames: false };
  if (speed <= 0) return { moved: false, needsMoreFrames: true };
  const moved = nextOffset !== currentOffset;
  return { moved, needsMoreFrames: moved };
}

export interface AutoScrollGuardState {
  /** 画面（このコンポーネントインスタンス）がまだマウントされているか */
  isMounted: boolean;
  /** 現在ドラッグ中（dragStateが存在する）か */
  isDragging: boolean;
  /** 現在アクティブなドラッグセッションのID */
  activeSessionId: number;
  /** このオートスクロールループが開始された時点のドラッグセッションID */
  loopSessionId: number;
}

/**
 * 自動スクロールの毎フレームで確認する安全確認。1つでも不成立ならそのフレームで
 * スクロールを実行せず、ループ自体も継続してはいけない（古いセッションのループ残存・
 * アンマウント後の実行・ドラッグ終了後の暴走を防ぐ）。
 */
export function shouldContinueAutoScroll(state: AutoScrollGuardState): boolean {
  return (
    state.isMounted && state.isDragging && state.activeSessionId === state.loopSessionId
  );
}
