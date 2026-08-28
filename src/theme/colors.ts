/**
 * 共通デザイン: 白〜薄いグレーを基調とした落ち着いた実務向けデザイン。
 * メインカラーは青。集中タスクは紫系。警告・現在時刻は赤系。
 */
export const colors = {
  background: "#F7F8FA",
  surface: "#FFFFFF",
  surfaceAlt: "#F1F3F6",
  border: "#E3E6EB",
  borderStrong: "#C9CFD8",

  textPrimary: "#1A1D23",
  textSecondary: "#5B6270",
  textTertiary: "#8B92A0",
  textInverse: "#FFFFFF",

  primary: "#2E5FE8",
  primarySoft: "#E6ECFD",
  primaryStrong: "#1E45B8",

  focus: "#7C4DFF",
  focusSoft: "#EFE7FF",
  focusStrong: "#5B32C7",

  meeting: "#22A06B",
  meetingSoft: "#E1F5EC",

  warning: "#E14848",
  warningSoft: "#FCE8E8",

  today: "#2E5FE8",

  /** 祝日の日付・祝日名表示専用（warningと同系統の赤だが、意味が異なるため別トークンにしている） */
  holiday: "#D6394A",

  /** お気に入り（星）表示専用。Stage 2で直書きの#F59E0Bを集約 */
  favorite: "#F59E0B",

  divider: "#EAECF0",
  disabled: "#C4C9D2",
  placeholder: "#A6ACB8",

  overlay: "rgba(17, 20, 27, 0.45)",

  /**
   * カレンダー本体（月・週・日表示）の区切り線・背景を一元管理するトークン群。
   * 各ビュー側では直接色コードを書かず、必ずこちらを参照する。
   * 区切りは重要度で3段階（major/normal/minor）に分け、太さではなく主に濃さで差を付ける
   * （真っ黒な罫線・全て同じ太さの表計算ソフト的な見た目を避けるため）。
   * すべてライトテーマ前提の値だが、フラットな1階層のキーとして既存colorsへ足すだけの
   * 構造にしているため、将来ダークテーマの別colorsオブジェクトを用意する際もキー名は流用できる。
   */
  /** 予定グリッド本体の基本背景（月間セル・週日タイムラインの土台） */
  calendarSurface: "#FFFFFF",
  /** 予定種別フィルター等、操作エリア用のごく薄い補助サーフェス */
  calendarSubtleSurface: "#F6F7FA",
  /** 曜日・日付ヘッダー行専用の背景 */
  calendarHeaderSurface: "#F1F4F9",
  /** 主要区切り：操作エリア/ヘッダー/カレンダー本体の境目、時刻欄と予定欄の境目など */
  calendarMajorDivider: "#C7CDD8",
  /** 通常区切り：日付セルの境界・日付列の境界・1時間単位の線 */
  calendarNormalDivider: "#D8DCE4",
  /** 補助区切り：30分単位の線・セル内の補助表示 */
  calendarMinorDivider: "#EDEFF3",
  /** 前月・翌月セルの背景（当月との差を示す。読めなくなるほど薄くはしない） */
  calendarOutsideMonthSurface: "#F2F3F6",
  /** 今日のセル・列にごく薄くかける背景（今日バッジ本体の色とは別トークン） */
  calendarTodaySurface: "#EDF2FE",
  /** 選択中の日付（月表示でfocusedDateと一致するセル）にかける背景 */
  calendarSelectedSurface: "#E1E9FC",
  /**
   * 週末列用に予約したトークン。日曜・土曜の既存の文字色分け（sunday/saturday）は維持しつつ、
   * 曜日ごとに背景色を塗り分けることは今回行わない方針のため、現状はどのビューからも
   * 参照していない（将来週末だけ背景を付けたくなった場合の一元管理先として定義のみ行う）。
   */
  calendarWeekendSurface: "#F6F7FA",
  /** 週表示・日表示の左側時刻ラベル欄の背景 */
  calendarTimeGutterSurface: "#FAFBFC",
} as const;

export type AppColors = typeof colors;
