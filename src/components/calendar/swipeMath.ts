/**
 * 月表示の左右スワイプによる月移動判定（Stage I-8.6）。
 * UIから独立した純粋関数にし、dragMath.tsと同じくジェスチャー本体（MonthView側）から分離する。
 */

export interface SwipeNavigationConfig {
  /** 月移動と判定するための最小の横移動量(px) */
  minDistance: number;
  /** 横方向が縦方向より十分大きいと判定するための倍率（|dx| >= minHorizontalDominance * |dy|） */
  minHorizontalDominance: number;
  /** 移動量がminDistance未満でも、これ以上の速度（px/秒）ならスワイプとみなす */
  minVelocity: number;
}

export const DEFAULT_SWIPE_CONFIG: SwipeNavigationConfig = {
  minDistance: 60,
  minHorizontalDominance: 1.5,
  minVelocity: 500,
};

/** -1: 前月へ（右スワイプ）, 1: 翌月へ（左スワイプ）, 0: 月移動しない */
export type SwipeMonthDirection = -1 | 0 | 1;

/**
 * ジェスチャー終了時点の総移動量・横方向速度から、月移動の方向を1回だけ判定する。
 * 呼び出し側（MonthView）は、この関数をPanジェスチャーのonEndで一度だけ呼ぶことで、
 * 「1ジェスチャーにつき最大1回・最大1か月分」の移動を自然に保証する。
 */
export function resolveSwipeMonthDirection(
  translationX: number,
  translationY: number,
  velocityX: number,
  config: SwipeNavigationConfig = DEFAULT_SWIPE_CONFIG
): SwipeMonthDirection {
  const absX = Math.abs(translationX);
  const absY = Math.abs(translationY);

  // 斜め方向の動きは、横方向が縦方向より十分大きい場合だけ月移動の対象にする
  if (absX < absY * config.minHorizontalDominance) return 0;

  const distanceOk = absX >= config.minDistance;
  const velocityOk = Math.abs(velocityX) >= config.minVelocity;
  if (!distanceOk && !velocityOk) return 0;

  // 左スワイプ（指が左へ、translationXが負）は翌月、右スワイプは前月
  return translationX < 0 ? 1 : -1;
}
