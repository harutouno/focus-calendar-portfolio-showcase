import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { PageLayout } from "@/components/common/PageLayout";
import { PickerModal, PickerOption } from "@/components/forms/PickerModal";
import { useAuth } from "@/context/AuthContext";
import { AI_SUPPORT_FEATURE_ENABLED, SUPPORT_TIER_FEATURE_ENABLED } from "@/config/featureFlags";
import { useLocale } from "@/context/LocaleContext";
import { useHolidayRegion } from "@/context/HolidayRegionContext";
import { HolidayRegion, SUPPORTED_HOLIDAY_REGIONS } from "@/types/holidayRegion";
import { colors } from "@/theme/colors";
import { minTapSize, spacing } from "@/theme/spacing";

const HOLIDAY_REGION_LABEL_KEY: Record<HolidayRegion, "holidayRegion.jp" | "holidayRegion.us" | "holidayRegion.gb" | "holidayRegion.none"> = {
  JP: "holidayRegion.jp",
  US: "holidayRegion.us",
  GB: "holidayRegion.gb",
  NONE: "holidayRegion.none",
};

interface MenuItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  helperText?: string;
}

// 未設定の場合、お問い合わせ導線自体をメニューから非表示にする（実際には送信できない
// 状態でユーザーに「送信した」と誤認させないための安全側フォールバック）。
const SUPPORT_EMAIL_CONFIGURED = Boolean(process.env.EXPO_PUBLIC_SUPPORT_EMAIL);

export default function SideMenuScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { t } = useLocale();
  const { region: holidayRegion, setRegion: setHolidayRegion } = useHolidayRegion();
  const [holidayRegionPickerVisible, setHolidayRegionPickerVisible] = useState(false);

  const items: MenuItem[] = [
    {
      icon: "calendar-outline",
      label: t("menu.calendar"),
      onPress: () => {
        router.back();
      },
    },
    {
      icon: "person-circle-outline",
      label: t("menu.account"),
      helperText: user ? user.email ?? t("menu.accountLoggedInFallback") : t("menu.accountLoggedOut"),
      onPress: () => {
        router.back();
        router.push("/account");
      },
    },
    {
      icon: "stats-chart-outline",
      label: t("menu.records"),
      onPress: () => {
        router.back();
        router.push("/records");
      },
    },
    {
      icon: "layers-outline",
      label: t("menu.visibleCalendars"),
      onPress: () => {
        router.back();
        router.push("/overlay");
      },
    },
    {
      icon: "earth-outline",
      label: t("menu.holidayRegionLabel"),
      helperText: t(HOLIDAY_REGION_LABEL_KEY[holidayRegion]),
      onPress: () => setHolidayRegionPickerVisible(true),
    },
    ...(AI_SUPPORT_FEATURE_ENABLED
      ? [
          {
            icon: "sparkles-outline" as const,
            label: t("menu.aiSupport"),
            onPress: () => {
              router.back();
              router.push("/ai");
            },
          },
        ]
      : []),
    {
      icon: "barbell-outline",
      label: t("menu.trainingIntegration"),
      disabled: true,
      helperText: t("menu.trainingComingSoon"),
    },
    ...(SUPPORT_TIER_FEATURE_ENABLED
      ? [
          {
            icon: "heart-outline" as const,
            label: t("menu.support"),
            onPress: () => {
              router.back();
              router.push("/support");
            },
          },
        ]
      : []),
    ...(SUPPORT_EMAIL_CONFIGURED
      ? [
          {
            icon: "chatbubble-ellipses-outline" as const,
            label: t("menu.contact"),
            onPress: () => router.push("/contact"),
          },
        ]
      : []),
  ];

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <PageLayout header={<ScreenHeader title={t("menu.title")} onBack={() => router.back()} />}>
        <View style={styles.list}>
          {items.map((item) => (
            <Pressable
              key={item.label}
              onPress={item.disabled ? undefined : item.onPress}
              style={[styles.row, item.disabled && styles.rowDisabled]}
              accessibilityRole="button"
              accessibilityState={{ disabled: item.disabled }}
              accessibilityLabel={`${item.label}${item.helperText ? `${t("common.a11ySeparator")}${item.helperText}` : ""}`}
            >
              <Ionicons
                name={item.icon}
                size={22}
                color={item.disabled ? colors.disabled : colors.primary}
              />
              <Text style={[styles.label, item.disabled && styles.labelDisabled]}>
                {item.label}
              </Text>
              {item.helperText ? (
                <Text style={styles.helperTag}>{item.helperText}</Text>
              ) : (
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              )}
            </Pressable>
          ))}
        </View>
      </PageLayout>
      <PickerModal
        visible={holidayRegionPickerVisible}
        title={t("holidayRegion.pickerTitle")}
        options={SUPPORTED_HOLIDAY_REGIONS.map<PickerOption>((option) => ({
          id: option.region,
          label: t(HOLIDAY_REGION_LABEL_KEY[option.region]),
        }))}
        selectedIds={[holidayRegion]}
        onClose={() => setHolidayRegionPickerVisible(false)}
        onApply={(ids) => {
          const next = ids[0] as HolidayRegion | undefined;
          if (next) setHolidayRegion(next);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  list: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: minTapSize + 8,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  label: {
    fontSize: 16,
    color: colors.textPrimary,
    flex: 1,
  },
  labelDisabled: {
    color: colors.textTertiary,
  },
  helperTag: {
    fontSize: 11,
    color: colors.textTertiary,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
  },
});
