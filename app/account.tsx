import React, { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { useAuth } from "@/context/AuthContext";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { useLocale } from "@/context/LocaleContext";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";

/**
 * Portfolio Edition: アカウント削除は含めない（サーバー側のEdge Function
 * account-deletion-status/account-deletion-workerに依存する機能のため）。
 * ログイン状態の表示とサインアウトのみを扱う。
 */
export default function AccountScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const { user, signOut, isSupabaseConfigured } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = () => {
    if (signingOut) return;
    Alert.alert(t("account.signOutConfirmTitle"), t("account.signOutConfirmMessage"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("account.signOutButton"),
        style: "destructive",
        onPress: async () => {
          setSigningOut(true);
          try {
            await signOut();
          } catch (e) {
            setSigningOut(false);
            Alert.alert(
              t("account.signOutErrorTitle"),
              toFriendlyMessage(e instanceof Error ? e.message : undefined, t("account.signOutErrorFallback"), t)
            );
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("account.title")} onBack={() => router.back()} />
      <View style={styles.content}>
        {user ? (
          <>
            <SectionCard>
              <View
                style={styles.row}
                accessible
                accessibilityLabel={t("account.loggedInA11y", { email: user.email ?? "" })}
              >
                <Ionicons name="person-circle-outline" size={28} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.email}>{user.email}</Text>
                  <Text style={styles.sub}>{t("account.loggedInLabel")}</Text>
                </View>
              </View>
            </SectionCard>
            <Text style={styles.note}>{t("account.loggedInNote")}</Text>
            <PrimaryButton
              label={t("account.signOutButton")}
              variant="danger"
              loading={signingOut}
              accessibilityLabel={signingOut ? t("account.signOutInProgressA11y") : undefined}
              onPress={handleSignOut}
              style={styles.button}
            />
          </>
        ) : (
          <>
            <SectionCard>
              <View
                style={styles.row}
                accessible
                accessibilityLabel={t("account.loggedOutA11y")}
              >
                <Ionicons name="person-circle-outline" size={28} color={colors.textTertiary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.email}>{t("account.loggedOutLabel")}</Text>
                  <Text style={styles.sub}>{t("account.loggedOutSubLabel")}</Text>
                </View>
              </View>
            </SectionCard>
            <Text style={styles.note}>{t("account.loggedOutNote")}</Text>
            <PrimaryButton
              label={t("account.signInButton")}
              onPress={() => router.push("/auth/sign-in")}
              disabled={!isSupabaseConfigured}
              style={styles.button}
            />
            {!isSupabaseConfigured && (
              <Text style={styles.warningNote}>{t("account.supabaseNotConfigured")}</Text>
            )}
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.lg },
  email: { fontSize: 16, fontWeight: "700", color: colors.textPrimary },
  sub: { fontSize: 12, color: colors.textTertiary, marginTop: 2 },
  note: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: spacing.md },
  warningNote: { color: colors.warning, fontSize: 12, marginTop: spacing.sm, textAlign: "center" },
  button: { marginTop: spacing.lg },
});
