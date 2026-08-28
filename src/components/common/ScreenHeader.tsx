import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { colors } from "@/theme/colors";
import { minTapSize, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  title: string;
  onBack?: () => void;
  right?: React.ReactNode;
  /** 未保存の入力を破棄して戻ることを明確にしたい画面（フォーム等）で「戻る」の代わりに表示するラベル */
  backLabel?: string;
}

/** 「戻る」導線付きの共通ヘッダー（フォーム・サブ画面用） */
export function ScreenHeader({ title, onBack, right, backLabel }: Props) {
  const router = useRouter();
  const { t } = useLocale();
  const label = backLabel ?? t("common.back");
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onBack ?? (() => router.back())}
        style={styles.backButton}
        hitSlop={8}
      >
        <Ionicons name="chevron-back" size={22} color={colors.primary} />
        <Text style={styles.backText}>{label}</Text>
      </Pressable>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.right}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: minTapSize + 8,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 72,
    minHeight: minTapSize,
    paddingHorizontal: spacing.xs,
  },
  backText: {
    color: colors.primary,
    fontSize: 16,
  },
  title: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontWeight: "700",
    color: colors.textPrimary,
    marginRight: 72,
  },
  right: {
    minWidth: 44,
    alignItems: "flex-end",
  },
});
