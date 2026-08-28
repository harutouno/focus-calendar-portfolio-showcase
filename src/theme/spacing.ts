export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

/** タップ領域は最低44px相当を確保する */
export const minTapSize = 44;

export const shadow = {
  card: {
    shadowColor: "#11141B",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  /**
   * ドラッグ中のプレビューカード等、cardより強く浮き上がらせたい要素用。
   * 元々MonthView/WeekView/DayViewのdragOverlayスタイルへ同一の値がそれぞれ直書きされていた
   * ものをStage 2で1箇所へ集約した（値自体は変更していない）。
   */
  elevated: {
    shadowColor: "#11141B",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
} as const;
