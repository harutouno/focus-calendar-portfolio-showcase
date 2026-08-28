import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { exchangeCodeForSession } from "@/services/authService";
import { LoadingView } from "@/components/common/LoadingView";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { resolveReturnToPath } from "@/utils/returnToAllowlist";
import { useAuth } from "@/context/AuthContext";
import type { AuthAttemptCompletionDisposition } from "@/context/AuthContext";
import { useLocale } from "@/context/LocaleContext";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";

/**
 * メール内のMagic Linkから戻ってきたときの受け口。
 * ?code= をセッションに交換し、返り先(returnTo)またはアカウント画面へ遷移する。
 */
export default function AuthCallbackScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const { beginExplicitAuthAttempt, completeExplicitAuthAttempt } = useAuth();
  const { code, returnTo } = useLocalSearchParams<{
    code?: string;
    returnTo?: string;
  }>();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!code) {
      setErrorMessage(t("authCallback.missingCodeError"));
      return;
    }
    let active = true;
    // P0047(C18): この試行を「明示的な試行」として記録してから交換する。
    const myAttempt = beginExplicitAuthAttempt();
    exchangeCodeForSession(code).then(async ({ error, session }) => {
      // security/auth state machineの完了は画面のunmountで止めない
      // （見捨てられた試行のSDK内部session訂正・stale side effect防止は必須）。
      let disposition: AuthAttemptCompletionDisposition;
      if (error || !session) {
        disposition = await completeExplicitAuthAttempt(myAttempt, { type: "error" });
      } else {
        disposition = await completeExplicitAuthAttempt(myAttempt, { type: "success", session });
      }
      // ここから先はUIの副作用のみ。unmount済み、または見捨てられた/fail-closedされた
      // 試行なら何もしない（P0048: "accepted"だけがUI遷移の権限を持つ）。
      if (!active) return;
      if (disposition !== "accepted") return;
      if (error || !session) {
        setErrorMessage(
          toFriendlyMessage(
            error ?? "",
            t("authCallback.genericErrorFallback"),
            t
          )
        );
        return;
      }
      router.replace(resolveReturnToPath(returnTo) as never);
    });
    return () => {
      active = false;
    };
  }, [code, returnTo, router, t, beginExplicitAuthAttempt, completeExplicitAuthAttempt]);

  if (!errorMessage) return <LoadingView />;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>{t("authCallback.errorTitle")}</Text>
        <Text style={styles.message}>{errorMessage}</Text>
        <PrimaryButton
          label={t("authCallback.backButton")}
          onPress={() => router.replace("/auth/sign-in")}
          style={styles.button}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.sm },
  title: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
  message: { fontSize: 14, color: colors.textSecondary, textAlign: "center" },
  button: { marginTop: spacing.lg, minWidth: 200 },
});
