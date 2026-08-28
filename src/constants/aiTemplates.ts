import { Ionicons } from "@expo/vector-icons";
import { AIRequestKind } from "@/types/ai";
import { TranslationKey } from "@/i18n/translations";

type TFunction = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export interface AISupportTemplate {
  /** Reactのkey・識別子として使う安定したID（表示文言の変化に影響されない） */
  id: string;
  kind: AIRequestKind;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  /**
   * タップ時に入力欄へ挿入するテンプレート文（送信はしない）。
   * ローカルの分類処理が日本語パターンを使うため、表示言語（title/description）に
   * 関わらずこの値は常に日本語のままにする。
   */
  template: string;
}

/**
 * AIホーム画面「おすすめ」カード（2026-07-25更新: 5件）。
 * title/descriptionは呼び出し元（useLocale()の`t`）から渡された関数で表示言語に応じて
 * 切り替わる。2026-07-29: アプリ全体の言語切替に追従できるよう、モジュール読み込み時に
 * 一度だけ評価される定数配列ではなく、現在のtを受け取って毎回組み立てる関数にした。
 * kindは4種類のため複数のカードが同じkindを共有する。たとえば
 * organizeToday / organizeTodos / reviewThisWeek は suggest_schedule を使う。
 */
export function getAiSupportTemplates(t: TFunction): AISupportTemplate[] {
  return [
    {
      id: "organize_today",
      kind: "suggest_schedule",
      icon: "calendar-outline",
      title: t("ai.suggestion.organizeToday"),
      description: t("ai.suggestion.organizeToday.description"),
      template: "今日の予定を整理する",
    },
    {
      id: "find_free_time",
      kind: "suggest_schedule",
      icon: "time-outline",
      title: t("ai.suggestion.findFreeTime"),
      description: t("ai.suggestion.findFreeTime.description"),
      template: "空き時間を探す",
    },
    {
      id: "organize_todos",
      kind: "suggest_schedule",
      icon: "checkmark-circle-outline",
      title: t("ai.suggestion.organizeTodos"),
      description: t("ai.suggestion.organizeTodos.description"),
      template: "今日やることを整理する",
    },
    {
      id: "reserve_study_time",
      kind: "create_schedule",
      icon: "book-outline",
      title: t("ai.suggestion.reserveStudyTime"),
      description: t("ai.suggestion.reserveStudyTime.description"),
      template: "勉強時間を確保したい",
    },
    {
      id: "review_this_week",
      kind: "suggest_schedule",
      icon: "list-outline",
      title: t("ai.suggestion.reviewThisWeek"),
      description: t("ai.suggestion.reviewThisWeek.description"),
      template: "今週の予定を確認する",
    },
  ];
}
