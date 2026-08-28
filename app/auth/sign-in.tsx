import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from "expo-apple-authentication";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { useAuth } from "@/context/AuthContext";
import type { AuthAttemptCompletionDisposition } from "@/context/AuthContext";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { resolveReturnToPath } from "@/utils/returnToAllowlist";
import { useLocale } from "@/context/LocaleContext";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";

type OAuthProvider = "google" | "apple";

/**
 * Googleの正式なGoogleSigninButton（@react-native-google-signin/google-signin）はJS側から
 * ラベル文言を差し替えられない（size/color/disabled/onPressのみ）ため、
 * 「Googleで続ける」「Continue with Google」という指定文言をアプリの言語切替と連動させて
 * 表示できない。そのため、@expo/vector-iconsのGoogleロゴアイコン（単色）を使った
 * 自前ボタンで、指定文言・既存画面と統一したデザイン（白背景・薄い境界線・角丸）を実現する
 * （Googleの正式な多色Gロゴそのものではないが、独自の文字ロゴでの代用ではない）。
 */
function GoogleContinueButton({
  label,
  loading,
  disabled,
  onPress,
}: {
  label: string;
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.googleButton,
        pressed && !disabled && styles.googleButtonPressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.textPrimary} />
      ) : (
        <>
          <Ionicons name="logo-google" size={20} color="#4285F4" />
          <Text style={styles.googleButtonText} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export default function SignInScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const {
    signInWithMagicLink,
    signInWithGoogle,
    signInWithApple,
    isSupabaseConfigured,
    isGoogleSignInConfigured,
    isAppleSignInAvailableAsync,
    beginExplicitAuthAttempt,
    completeExplicitAuthAttempt,
  } = useAuth();
  // C18(SEC-F007-003): この画面がアンマウントされた後にGoogle/Appleサインインが解決しても、
  // アンマウント後のsetState・アンマウント後の画面遷移を行わない。
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  // Google/Appleどちらか一方だけを同時に処理中とする（二重タップ防止・処理中表示に使う）。
  const [oauthProvider, setOauthProvider] = useState<OAuthProvider | null>(null);
  const busy = sending || oauthProvider !== null;
  // 2026-08: 「表示するか」と「実際に認証可能か」を分離する。
  // ボタンの表示自体はOSだけで決まる（外部設定の有無に関わらず、UI確認ができるようにするため）。
  // Googleはios/androidどちらでも常に表示する。Appleはネイティブ機能自体がiOS専用のため、
  // 表示条件も常にPlatform.OS==="ios"のみで決める（端末側のisAppleSignInAvailableAsync()の
  // 結果は「実際に認証できるか＝appleReady」の判定にのみ使い、表示のON/OFFには使わない）。
  const showGoogleButton = true;
  const showAppleButton = Platform.OS === "ios";
  // 実際に認証できるか（外部設定・ネイティブ対応状況に依存）。falseの間にボタンを押した場合は、
  // GoogleSignin.signIn()/AppleAuthentication.signInAsync()を一切呼ばず、準備中メッセージのみ表示する。
  const googleReady = isGoogleSignInConfigured;
  const [appleReady, setAppleReady] = useState(false);

  useEffect(() => {
    let active = true;
    isAppleSignInAvailableAsync().then((available) => {
      if (active) setAppleReady(available);
    });
    return () => {
      active = false;
    };
  }, [isAppleSignInAvailableAsync]);

  const handleSend = async () => {
    if (busy) return;
    const trimmed = email.trim();
    if (!trimmed) {
      Alert.alert(t("authSignIn.emailRequiredAlert"));
      return;
    }
    setSending(true);
    const { error, redirectTo } = await signInWithMagicLink(trimmed, returnTo);
    setSending(false);
    if (error) {
      Alert.alert(
        t("authCheckEmail.resendFailedTitle"),
        toFriendlyMessage(error, t("authCheckEmail.resendFailedFallback"), t)
      );
      return;
    }
    router.push({
      pathname: "/auth/check-email",
      params: { email: trimmed, returnTo: returnTo ?? "", redirectTo: redirectTo ?? "" },
    });
  };

  /**
   * Google/Appleはネイティブサインインのためディープリンク（app/auth/callback.tsx）を
   * 経由しない。そのため、招待画面等からreturnTo付きでこの画面へ来ていた場合の
   * 戻り先復帰は、成功時にここで直接resolveReturnToPath()を呼んで行う
   * （callback.tsxと同じ関数を再利用し、許可ルートの判定ロジックを重複させない）。
   */
  const handleOAuthResult = (result: { error?: string; cancelled?: boolean }) => {
    if (result.cancelled) return;
    if (result.error) {
      Alert.alert(
        t("authCheckEmail.resendFailedTitle"),
        toFriendlyMessage(result.error, t("authSignIn.oauthErrorFallback"), t)
      );
      return;
    }
    router.replace(resolveReturnToPath(returnTo) as never);
  };

  const handleGooglePress = async () => {
    if (busy) return;
    // 外部設定（Client ID等）が未完了の間は、GoogleSignin.signIn()を一切呼ばず、
    // 内部設定名や詳細を含まない案内だけを表示する（Supabaseへの認証要求も発生しない）。
    if (!googleReady) {
      Alert.alert(t("authSignIn.comingSoonMessage"));
      return;
    }
    setOauthProvider("google");
    // P0047(C18): この試行を明示的なattemptとして記録してから開始する。
    const myAttempt = beginExplicitAuthAttempt();
    const result = await signInWithGoogle();
    // security/auth state machineの完了は画面のunmountで止めない。
    let disposition: AuthAttemptCompletionDisposition;
    if (result.cancelled) {
      disposition = await completeExplicitAuthAttempt(myAttempt, { type: "cancelled" });
    } else if (result.session) {
      disposition = await completeExplicitAuthAttempt(myAttempt, {
        type: "success",
        session: result.session,
      });
    } else {
      disposition = await completeExplicitAuthAttempt(myAttempt, { type: "error" });
    }
    // ここから先はUIの副作用のみ。unmount済み、または見捨てられた/fail-closedされた
    // 試行なら何もしない（P0048: "accepted"だけがsuccess UIの権限を持つ）。
    if (!mountedRef.current) return;
    setOauthProvider(null);
    if (disposition !== "accepted") return;
    handleOAuthResult(result);
  };

  const handleApplePress = async () => {
    if (busy) return;
    // 端末がApple Sign-Inに対応していない、または設定未完了の間はAppleAuthentication.signInAsync()を
    // 一切呼ばず、案内だけを表示する。
    if (!appleReady) {
      Alert.alert(t("authSignIn.comingSoonMessage"));
      return;
    }
    setOauthProvider("apple");
    const myAttempt = beginExplicitAuthAttempt();
    const result = await signInWithApple();
    let disposition: AuthAttemptCompletionDisposition;
    if (result.cancelled) {
      disposition = await completeExplicitAuthAttempt(myAttempt, { type: "cancelled" });
    } else if (result.session) {
      disposition = await completeExplicitAuthAttempt(myAttempt, {
        type: "success",
        session: result.session,
      });
    } else {
      disposition = await completeExplicitAuthAttempt(myAttempt, { type: "error" });
    }
    if (!mountedRef.current) return;
    setOauthProvider(null);
    if (disposition !== "accepted") return;
    handleOAuthResult(result);
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("authSignIn.title")} onBack={() => router.back()} />
      <View style={styles.content}>
        <Text style={styles.intro}>{t("authSignIn.introText")}</Text>
        {!isSupabaseConfigured && (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{t("authSignIn.notConfiguredNotice")}</Text>
          </View>
        )}

        {/*
          2026-08: 「表示するか（OSだけで決まる）」と「実際に認証できるか（外部設定・
          ネイティブ対応状況で決まる）」を分離した。外部設定が未完了でもUI確認ができるよう、
          Googleはios/androidどちらでも常に表示し、Appleはios専用で常に表示する
          （Androidでは非表示のまま）。未設定のままタップした場合は各handlerが
          準備中メッセージを表示するだけで、認証SDKやSupabaseへの要求は一切発生しない。
        */}
        {showGoogleButton && (
          <GoogleContinueButton
            label={t("authSignIn.continueWithGoogle")}
            loading={oauthProvider === "google"}
            disabled={busy}
            onPress={handleGooglePress}
          />
        )}

        {showAppleButton && (
          <View pointerEvents={busy ? "none" : "auto"} style={styles.appleButtonWrap}>
            <AppleAuthenticationButton
              buttonType={AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={AppleAuthenticationButtonStyle.BLACK}
              cornerRadius={10}
              style={styles.appleButton}
              onPress={handleApplePress}
            />
            {oauthProvider === "apple" && (
              <ActivityIndicator style={styles.oauthLoading} color={colors.primary} />
            )}
          </View>
        )}

        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>{t("authSignIn.orDividerText")}</Text>
          <View style={styles.dividerLine} />
        </View>

        <SectionCard>
          <View style={styles.field}>
            <Text style={styles.label}>{t("authSignIn.emailLabel")}</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              style={styles.input}
              accessibilityLabel={t("authSignIn.emailLabel")}
            />
          </View>
        </SectionCard>
        <PrimaryButton
          label={t("authSignIn.sendLinkButton")}
          onPress={handleSend}
          loading={sending}
          disabled={!isSupabaseConfigured || busy}
          style={styles.button}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  intro: { color: colors.textSecondary, lineHeight: 21, marginBottom: spacing.lg },
  notice: {
    backgroundColor: colors.warningSoft,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  noticeText: { color: colors.warning, fontSize: 13, lineHeight: 18 },
  appleButtonWrap: { marginBottom: spacing.sm },
  appleButton: { height: 46, width: "100%" },
  googleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    minHeight: 48,
    width: "100%",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  googleButtonPressed: { backgroundColor: colors.surfaceAlt },
  googleButtonText: { fontSize: 15, fontWeight: "600", color: colors.textPrimary },
  oauthLoading: { marginTop: spacing.sm },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginVertical: spacing.lg,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.divider },
  dividerText: { fontSize: 12, color: colors.textTertiary },
  field: { padding: spacing.lg },
  label: { fontSize: 13, fontWeight: "600", color: colors.textSecondary, marginBottom: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    minHeight: 46,
    fontSize: 16,
    color: colors.textPrimary,
  },
  button: { marginTop: spacing.lg },
});
