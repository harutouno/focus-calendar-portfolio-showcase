import React, { useEffect } from "react";
import { Stack } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "@/context/AuthContext";
import { AppDataProvider } from "@/context/AppDataContext";
import { LocaleProvider } from "@/context/LocaleContext";
import { HolidayRegionProvider } from "@/context/HolidayRegionContext";
import { AppDataInitializationGate } from "@/components/common/AppDataInitializationGate";
import { RootErrorBoundaryFallback } from "@/components/common/RootErrorBoundaryFallback";
import { initializeNotifications } from "@/services/notificationService";
import { useNotificationResponseRouting } from "@/hooks/useNotificationResponseRouting";
import { getProductionEnvIssues } from "@/config/envValidation";

/**
 * 単独修正(2026-08、ROBUST-F001-001): ルートError Boundary。
 * Expo Routerの規約（ルートファイルが`default`と`ErrorBoundary`を両方exportすると、
 * `default`側の描画をExpo Router自身が内部の`Try`（通常のReactクラス型Error Boundary）で
 * 包む）に従うだけで、下の`RootLayout`（＝全Providerツリー）を外側から捕捉できる
 * ようにしている。詳細な設計根拠はRootErrorBoundaryFallback.tsx側のコメントを参照。
 */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <RootErrorBoundaryFallback {...props} />;
}

export default function RootLayout() {
  // 通知基盤の初期化（ハンドラ設定・Androidチャンネル作成のみ）。
  // 予定の通知スケジュールとは無関係で、失敗してもアプリの起動を妨げない
  // （initializeNotifications内部で例外を握りつぶす設計のため、ここでは待ち受けやcatchは不要）。
  useEffect(() => {
    initializeNotifications();
  }, []);

  // 通知タップ時のルーティング（集中予定の開始通知のみ対象。Stack配下でuseRouter()を
  // 使う必要があるため、RootLayoutコンポーネント内で1回だけマウントする）。
  useNotificationResponseRouting();


  // 本番ビルド（__DEV__===false）でのみ、提出前に設定を忘れやすい環境変数
  // になっていないかをログへ出す（検出のみ、値の書き換えや起動の中断は行わない）。
  useEffect(() => {
    if (__DEV__) return;
    const issues = getProductionEnvIssues({
      supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
      supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    });
    if (issues.length === 0) return;
    // eslint-disable-next-line no-console -- 本番ビルドの設定不備に開発者が気づけるようにするための意図的なログ
    console.error(
      `[envValidation] 本番ビルドの環境変数設定を確認してください:\n${issues
        .map((issue) => `- ${issue.key}: ${issue.message}`)
        .join("\n")}`
    );
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <LocaleProvider>
          <HolidayRegionProvider>
            <AuthProvider>
                <AppDataProvider>
                  <StatusBar style="dark" />
                  <AppDataInitializationGate>
                    <Stack screenOptions={{ headerShown: false }}>
                      <Stack.Screen name="index" />
                      <Stack.Screen name="event/new" options={{ presentation: "modal" }} />
                      <Stack.Screen name="event/[id]" options={{ presentation: "modal" }} />
                      <Stack.Screen name="day/[date]" options={{ presentation: "modal" }} />
                      <Stack.Screen name="focus/new" options={{ presentation: "modal" }} />
                      <Stack.Screen name="focus/[id]" options={{ presentation: "modal" }} />
                      <Stack.Screen
                        name="focus/active/[id]"
                        options={{ presentation: "fullScreenModal" }}
                      />
                      <Stack.Screen name="records" options={{ presentation: "modal" }} />
                      <Stack.Screen name="ai/index" options={{ presentation: "modal" }} />
                      <Stack.Screen name="ai/processing" />
                      <Stack.Screen name="ai/result" />
                      <Stack.Screen name="overlay" options={{ presentation: "modal" }} />
                      <Stack.Screen name="menu" options={{ presentation: "modal" }} />
                      <Stack.Screen name="calendars" options={{ presentation: "modal" }} />
                      <Stack.Screen name="activity" options={{ presentation: "modal" }} />
                      <Stack.Screen name="contact" options={{ presentation: "modal" }} />
                      <Stack.Screen name="support" options={{ presentation: "modal" }} />
                      <Stack.Screen name="account" options={{ presentation: "modal" }} />
                      <Stack.Screen name="auth/sign-in" options={{ presentation: "modal" }} />
                      <Stack.Screen name="auth/check-email" options={{ presentation: "modal" }} />
                      <Stack.Screen name="auth/callback" options={{ presentation: "modal" }} />
                      <Stack.Screen name="calendar/[id]/index" options={{ presentation: "modal" }} />
                      <Stack.Screen name="calendar/[id]/members" options={{ presentation: "modal" }} />
                      <Stack.Screen name="calendar/[id]/invite" options={{ presentation: "modal" }} />
                      <Stack.Screen name="calendar/[id]/settings" options={{ presentation: "modal" }} />
                      <Stack.Screen name="invite/[token]" options={{ presentation: "modal" }} />
                      <Stack.Screen name="+not-found" />
                    </Stack>
                  </AppDataInitializationGate>
                </AppDataProvider>
            </AuthProvider>
          </HolidayRegionProvider>
        </LocaleProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
