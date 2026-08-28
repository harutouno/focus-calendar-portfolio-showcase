/**
 * 集中記録・分析機能のしきい値を一元化する。
 * 画面・分析関数に生の数値を直接書かず、必ずここを経由する。
 *
 * Portfolio Edition は課金機能を持たないため、期間・履歴件数の制限は無い。
 * 本体アプリではここに無料/プレミアムの差分があった。
 */

/** 記録画面で選べる集計期間。 */
export const FOCUS_ANALYTICS_RANGES = [
  "today",
  "last7Days",
  "last30Days",
  "thisWeek",
  "thisMonth",
  "thisYear",
  "allTime",
  "custom",
] as const;

/**
 * 曜日別・時間帯別分析で「完遂率が一番高い/中断が一番多い区分」を判定する際の
 * 最低サンプル数。これ未満の区分は「データ不足」として除外し、たまたま数件しかない
 * 区分を過大評価しないようにする。
 */
export const FOCUS_ANALYTICS_MIN_SAMPLE_FOR_BEST = 3;
