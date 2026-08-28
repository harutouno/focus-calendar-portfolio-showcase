import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAppData } from "@/context/AppDataContext";
import { useLocale } from "@/context/LocaleContext";
import { LoadingView } from "@/components/common/LoadingView";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";

/**
 * 単独修正(2026-08、ROBUST-F001-002): 必須ローカルデータ（AppDataContext）の初期化状態に
 * 応じて、全ルート共通で描画を差し替えるゲート。app/_layout.tsxのStackを直接この
 * コンポーネントの子として渡すことで、Deep Link・通知タップ・ルート復元等どの経路から
 * アプリが開始しても、初期化が完了する（"ready"になる）まで通常の画面が一切マウントされない
 * ことを保証する（app/index.tsx等の個別画面がそれぞれ独自にloadingを見て判断する方式だと、
 * 別ルートから直接開始した場合に保護が漏れるため、ルートで一箇所にまとめる）。
 *
 * UI責務はこのコンポーネントに閉じ、AppDataContext自体は状態（"loading"|"ready"|"error"）と
 * 再試行関数を公開するだけに留める。
 */
export function AppDataInitializationGate({ children }: { children: React.ReactNode }) {
  const { initializationStatus, retryInitialization } = useAppData();
  const { t } = useLocale();

  if (initializationStatus === "loading") {
    return <LoadingView />;
  }

  if (initializationStatus === "error") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.warning} />
          <Text style={styles.title}>{t("appDataInit.errorTitle")}</Text>
          <Text style={styles.message}>{t("appDataInit.errorMessage")}</Text>
          <PrimaryButton
            label={t("appDataInit.retryButton")}
            onPress={() => {
              void retryInitialization();
            }}
            style={styles.retryButton}
          />
        </View>
      </SafeAreaView>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textPrimary,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  message: {
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  retryButton: { alignSelf: "stretch", marginTop: spacing.sm },
});
