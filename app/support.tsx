import React, { useEffect } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { TFunction, TranslationKey } from "@/i18n/translations";
import { SUPPORT_TIER_FEATURE_ENABLED } from "@/config/featureFlags";

interface SupportTier {
  id: string;
  emoji: string;
  nameKey: TranslationKey;
  price: number;
  descriptionKey: TranslationKey;
}

/**
 * 応援プランの一覧（表示専用のダミーデータ）。
 * 実際の決済は未接続で、ボタンを押すと「準備中」の案内を表示するだけ。
 * 実装方針：iOS/Androidとも、消耗型（Consumable）のアプリ内課金として、
 * この3プランをそれぞれ個別の商品としてストア側に登録する想定
 * （実際のIAP接続・ストア申請は本ファイルの範囲外）。
 */
const SUPPORT_TIERS: SupportTier[] = [
  {
    id: "coffee",
    emoji: "☕",
    nameKey: "support.tierCoffeeName",
    price: 300,
    descriptionKey: "support.tierCoffeeDesc",
  },
  {
    id: "lunch",
    emoji: "🍔",
    nameKey: "support.tierLunchName",
    price: 1000,
    descriptionKey: "support.tierLunchDesc",
  },
  {
    id: "sponsor",
    emoji: "🚀",
    nameKey: "support.tierSponsorName",
    price: 3000,
    descriptionKey: "support.tierSponsorDesc",
  },
];

function buildHandleSupport(t: TFunction) {
  return (tier: SupportTier) => {
    Alert.alert(
      t("support.notReadyTitle"),
      t("support.notReadyMessage", { name: t(tier.nameKey), price: tier.price.toLocaleString() })
    );
  };
}

export default function SupportScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const handleSupport = buildHandleSupport(t);

  // 未実装（IAP未接続）の画面のため、フラグが立っていない限り直接遷移（deep link等）
  // されても安全にホームへ戻す。app/ai/index.tsxの既存ガードと同じパターン。
  useEffect(() => {
    if (!SUPPORT_TIER_FEATURE_ENABLED) {
      router.replace("/");
    }
  }, [router]);

  if (!SUPPORT_TIER_FEATURE_ENABLED) return null;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("support.headerTitle")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Ionicons name="star" size={48} color={colors.favorite} />
          <Text style={styles.heroTitle}>{t("support.headerTitle")}</Text>
          <Text style={styles.heroDescription}>{t("support.heroDescription")}</Text>
        </View>

        <SectionCard style={styles.reasonCard}>
          <Text style={styles.reasonLabel}>{t("support.whyBuiltLabel")}</Text>
          <Text style={styles.reasonText}>{t("support.whyBuiltBody")}</Text>
        </SectionCard>

        {SUPPORT_TIERS.map((tier) => (
          <SectionCard key={tier.id} style={styles.tierCard}>
            <View style={styles.tierHeader}>
              <Text style={styles.tierEmoji}>{tier.emoji}</Text>
              <View style={styles.tierText}>
                <Text style={styles.tierName}>{t(tier.nameKey)}</Text>
                <Text style={styles.tierDescription}>{t(tier.descriptionKey)}</Text>
              </View>
              <Text style={styles.tierPrice}>¥{tier.price.toLocaleString()}</Text>
            </View>
            <PrimaryButton
              label={t("support.supportButton")}
              onPress={() => handleSupport(tier)}
              style={styles.tierButton}
            />
          </SectionCard>
        ))}

        <View style={styles.noticeBox}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textTertiary} />
          <Text style={styles.noticeText}>{t("support.futurePerksNotice")}</Text>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>{t("support.footerThanks")}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },
  hero: {
    alignItems: "center",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  heroTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  heroDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 20,
    textAlign: "center",
  },
  reasonCard: {
    padding: spacing.lg,
  },
  reasonLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textTertiary,
    marginBottom: spacing.xs,
  },
  reasonText: {
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 21,
  },
  tierCard: {
    padding: spacing.lg,
  },
  tierHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  tierEmoji: {
    fontSize: 28,
  },
  tierText: {
    flex: 1,
  },
  tierName: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  tierDescription: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
  },
  tierPrice: {
    fontSize: 17,
    fontWeight: "800",
    color: colors.primary,
  },
  tierButton: {
    marginTop: 0,
  },
  noticeBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  noticeText: {
    flex: 1,
    fontSize: 12,
    color: colors.textTertiary,
  },
  footer: {
    paddingHorizontal: spacing.xl,
    alignItems: "center",
  },
  footerText: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 20,
    textAlign: "center",
  },
});
