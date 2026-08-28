import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { useLocale } from "@/context/LocaleContext";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";

/**
 * UX-F005-004: 不正・未一致のDeep Link等、Expo Routerがどのルートにもマッチできなかった
 * 場合に使うアプリ独自の画面。ファイル名`+not-found.tsx`はExpo Router自身が特別扱いする
 * 規約のため、他のスクリーンと違いパスパラメータを持たない。
 */
export default function NotFoundScreen() {
  const router = useRouter();
  const { t } = useLocale();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Ionicons name="help-circle-outline" size={40} color={colors.textTertiary} />
        <Text style={styles.title} accessibilityRole="header">
          {t("notFound.title")}
        </Text>
        <Text style={styles.message}>{t("notFound.message")}</Text>
        <PrimaryButton
          label={t("notFound.homeButton")}
          onPress={() => router.replace("/")}
          style={styles.homeButton}
        />
      </View>
    </SafeAreaView>
  );
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
  homeButton: { alignSelf: "stretch", marginTop: spacing.sm, minWidth: 200 },
});
