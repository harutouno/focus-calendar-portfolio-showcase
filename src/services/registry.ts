import { AIService, aiService as defaultAiService } from "@/services/aiService";
import { HolidayService } from "@/services/holidayService";
import { holidayService as defaultHolidayService } from "@/services/holidayDataService";
import * as authServiceModule from "@/services/authService";
import * as eventServiceModule from "@/services/eventService";
import { calendarFacade, CalendarFacade } from "@/services/calendarFacade";
import { LocaleService } from "@/services/localeService";
import { localeService as defaultLocaleService } from "@/services/deviceLocaleService";
import { HolidayRegionService } from "@/services/holidayRegionService";
import { holidayRegionService as defaultHolidayRegionService } from "@/services/deviceHolidayRegionService";

/**
 * 最小限のサービスレジストリ（DI）。
 * 既存コードが既に採用しているsingleton+interfaceパターン（aiService.ts・
 * holidayDataService.ts）を置き換えず、そこへ「差し替え可能な1点」を足すだけの構成。
 * フルのDIコンテナ（自動解決・スコープ管理等）は作らない。
 *
 * 呼び出し側（フック・コンテキスト）は、モジュールのsingletonを直接importする代わりに
 * getServices()経由でサービスを取得することで、サービス同士・呼び出し側同士が
 * 直接依存し合わない。テスト時はsetServicesForTesting()で差し替えられる。
 */
export interface ServiceRegistry {
  aiService: AIService;
  holidayService: HolidayService;
  authService: typeof authServiceModule;
  eventService: typeof eventServiceModule;
  calendarFacade: CalendarFacade;
  localeService: LocaleService;
  holidayRegionService: HolidayRegionService;
}

/**
 * 単独改善(2026-08): aiServiceの選択（aiService.tsのcreateAIService()）と同じ条件で、
 * Mock/開発専用）かを切り替える。Remote AI未接続時は本物のAI利用がそもそも
 * サーバーで発生しないため、ローカルのAsyncStorage実装のままでよい。
 */

const defaultRegistry: ServiceRegistry = {
  aiService: defaultAiService,
  holidayService: defaultHolidayService,
  authService: authServiceModule,
  eventService: eventServiceModule,
  calendarFacade,
  localeService: defaultLocaleService,
  holidayRegionService: defaultHolidayRegionService,
};

let registry: ServiceRegistry = defaultRegistry;

export function getServices(): ServiceRegistry {
  return registry;
}

/** テスト専用。本番コードから呼ばない。 */
export function setServicesForTesting(overrides: Partial<ServiceRegistry>): void {
  registry = { ...registry, ...overrides };
}

/** テスト専用。setServicesForTestingで上書きした内容を元に戻す。 */
export function resetServicesForTesting(): void {
  registry = defaultRegistry;
}
