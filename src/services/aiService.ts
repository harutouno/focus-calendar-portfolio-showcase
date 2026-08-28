import { AISupportRequest, AISupportResponse } from "@/types/ai";
import { addDays, todayLocalDateString } from "@/utils/date";
import { AuthIdentity } from "@/auth/authSessionIdentityStore";
import { TFunction } from "@/i18n/translations";

/**
 * Portfolio Edition の AI サービス境界。
 * 画面と hook はこのインターフェースだけに依存し、この提出版では端末内で固定応答を
 * 生成する DemoAIService のみを使う。外部 API、Edge Function、API キー、通信は使わない。
 * `owner` は AI 操作を作成したユーザーと結びつける既存の境界として受け取る。
 */
export interface AIService {
  generateSupport(
    request: AISupportRequest,
    t: TFunction,
    owner: AuthIdentity | null
  ): Promise<AISupportResponse>;
}

// ============================================================
// DemoAIService（Portfolio Edition の唯一の実装。端末内で固定サンプル応答を生成する）
// ============================================================

const DEMO_RESPONSE_DELAY_MS = 900;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCreateScheduleResponse(t: TFunction): AISupportResponse {
  return {
    kind: "create_schedule",
    headline: t("aiMock.createScheduleHeadline"),
    schedule: {
      title: t("aiMock.sampleTaskTitle"),
      date: addDays(todayLocalDateString(), 1),
      startTime: "19:00",
      endTime: "20:00",
    },
    actions: [
      { type: "apply_to_calendar", label: t("aiResult.applyToCalendarAction") },
      { type: "view_calendar", label: t("aiMock.viewCalendarAction") },
      { type: "regenerate", label: t("aiMock.regenerateOtherAction") },
    ],
  };
}

function buildSuggestScheduleResponse(t: TFunction): AISupportResponse {
  return {
    kind: "suggest_schedule",
    headline: t("aiMock.suggestScheduleHeadline"),
    description: t("aiMock.suggestScheduleDescription"),
    actions: [
      { type: "view_calendar", label: t("aiMock.viewCalendarAction") },
      { type: "regenerate", label: t("aiMock.regenerateOtherAction") },
    ],
  };
}

function buildFocusAnalysisResponse(t: TFunction): AISupportResponse {
  const sampleTaskTitle = t("aiMock.sampleTaskTitle");
  return {
    kind: "focus_analysis",
    headline: t("aiMock.focusAnalysisHeadline"),
    description: t("aiMock.focusAnalysisDescription", { task: sampleTaskTitle }),
    summaryRows: [
      { label: t("aiMock.summaryTotalFocusTimeLabel"), value: t("aiMock.summaryTotalFocusTimeValue") },
      { label: t("aiMock.summaryTopTimeLabel"), value: t("aiMock.summaryTopTimeValue") },
      { label: t("aiMock.summaryTopWeekdayLabel"), value: t("aiMock.summaryTopWeekdayValue") },
      { label: t("aiMock.summaryTopTaskLabel"), value: sampleTaskTitle },
      { label: t("aiMock.summaryWeekOverWeekLabel"), value: t("aiMock.summaryWeekOverWeekValue") },
    ],
    actions: [
      { type: "view_records", label: t("aiMock.viewRecordsAction") },
      { type: "regenerate", label: t("aiProcessing.backToAiButton") },
    ],
  };
}

function buildFeatureHelpResponse(t: TFunction): AISupportResponse {
  return {
    kind: "feature_help",
    headline: t("aiMock.featureHelpHeadline"),
    description: t("aiMock.featureHelpDescription"),
    actions: [{ type: "regenerate", label: t("aiProcessing.backToAiButton") }],
  };
}

export class DemoAIService implements AIService {
  /** Demo 実装はネットワークへ送信しないため、所有者は保存済みの操作境界にだけ使う。 */
  async generateSupport(
    request: AISupportRequest,
    t: TFunction,
    _owner?: AuthIdentity | null
  ): Promise<AISupportResponse> {
    await delay(DEMO_RESPONSE_DELAY_MS);
    switch (request.kind) {
      case "create_schedule":
        return buildCreateScheduleResponse(t);
      case "suggest_schedule":
        return buildSuggestScheduleResponse(t);
      case "focus_analysis":
        return buildFocusAnalysisResponse(t);
      case "feature_help":
        return buildFeatureHelpResponse(t);
    }
  }
}

// ============================================================
// Portfolio Edition のサービス選択
// ============================================================

/** 本提出版は常に DemoAIService を使う。 */
export const aiService: AIService = new DemoAIService();
