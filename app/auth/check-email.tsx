import React, { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { useAuth } from "@/context/AuthContext";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { useLocale } from "@/context/LocaleContext";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";

/**
 * Magic Linkメール送信後の案内画面。
 * ログイン自体はメール内のリンクを開いたときに app/auth/callback.tsx で完了する。
 * この画面は「メールを確認してください」という案内と再送信操作、および
 * 「localhostに接続できない」トラブル調査用にredirect URLの診断表示を持つ。
 * 診断表示は開発者がSupabaseのRedirect URLsを設定する際にのみ必要なため、
 * 本番ビルドの一般ユーザーには出さないよう__DEV__でガードしている（Stage 8）。
 */
export default function CheckEmailScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const { signInWithMagicLink } = useAuth();
  const { email, returnTo, redirectTo: initialRedirectTo } = useLocalSearchParams<{
    email: string;
    returnTo?: string;
    redirectTo?: string;
  }>();
  const [resending, setResending] = useState(false);
  const [redirectTo, setRedirectTo] = useState(initialRedirectTo ?? "");

  const handleResend = async () => {
    if (resending) return;
    if (!email) return;
    setResending(true);
    const result = await signInWithMagicLink(email, returnTo);
    setResending(false);
    if (result.error) {
      Alert.alert(
        t("authCheckEmail.resendFailedTitle"),
        toFriendlyMessage(result.error, t("authCheckEmail.resendFailedFallback"), t)
      );
      return;
    }
    if (result.redirectTo) setRedirectTo(result.redirectTo);
    Alert.alert(t("authCheckEmail.resendSuccessTitle"), t("authCheckEmail.resendSuccessMessage"));
  };

  const handleCopyRedirectTo = async () => {
    if (!redirectTo) return;
    await Clipboard.setStringAsync(redirectTo);
    Alert.alert(t("common.copied"), t("authCheckEmail.copiedMessage"));
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("authCheckEmail.title")} onBack={() => router.back()} />
      <View style={styles.content}>
        <SectionCard>
          <View style={styles.box}>
            <Ionicons name="mail-outline" size={40} color={colors.primary} />
            <Text style={styles.title}>{t("authCheckEmail.headline", { email })}</Text>
            <Text style={styles.description}>{t("authCheckEmail.description")}</Text>
          </View>
        </SectionCard>
        <PrimaryButton
          label={t("authCheckEmail.resendButton")}
          variant="secondary"
          onPress={handleResend}
          loading={resending}
          style={styles.button}
        />

        {__DEV__ && redirectTo ? (
          <View style={styles.debugBox}>
            <Text style={styles.debugLabel}>{t("authCheckEmail.debugLabel")}</Text>
            <Text style={styles.debugUrl} selectable numberOfLines={3}>
              {redirectTo}
            </Text>
            <Pressable
              style={styles.debugCopyButton}
              onPress={handleCopyRedirectTo}
              accessibilityRole="button"
              accessibilityLabel={t("authCheckEmail.debugCopyA11y")}
            >
              <Ionicons name="copy-outline" size={14} color={colors.primary} />
              <Text style={styles.debugCopyText}>{t("authCheckEmail.debugCopyButton")}</Text>
            </Pressable>
            <Text style={styles.debugNote}>{t("authCheckEmail.debugNote")}</Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  box: { alignItems: "center", padding: spacing.xl, gap: spacing.sm },
  title: { fontSize: 16, fontWeight: "700", color: colors.textPrimary, textAlign: "center" },
  description: { fontSize: 13, color: colors.textSecondary, textAlign: "center", lineHeight: 19 },
  button: { marginTop: spacing.lg },
  debugBox: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderRadius: 10,
    backgroundColor: colors.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  debugLabel: { fontSize: 11, fontWeight: "700", color: colors.textTertiary, marginBottom: spacing.xs },
  debugUrl: {
    fontSize: 11,
    color: colors.textSecondary,
    fontFamily: "monospace",
  },
  debugCopyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: spacing.xs,
    alignSelf: "flex-start",
  },
  debugCopyText: { fontSize: 12, fontWeight: "700", color: colors.primary },
  debugNote: { fontSize: 10, color: colors.textTertiary, marginTop: spacing.xs, lineHeight: 14 },
});
