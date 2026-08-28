import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { minTapSize, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  icon?: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  placeholder?: string;
  onPress?: () => void;
  disabled?: boolean;
  danger?: boolean;
  showChevron?: boolean;
  errorText?: string;
  /** 未入力のままでは保存できない項目であることをラベル横に示す（表示のみ。バリデーション自体は変更しない） */
  required?: boolean;
}

/**
 * iOS設定画面風の1行フィールド。
 * アイコン＋ラベル（左）／値＋シェブロン（右）で、タップするとピッカーやモーダルを開く。
 */
export function FieldRow({
  icon,
  label,
  value,
  placeholder,
  onPress,
  disabled,
  danger,
  showChevron = true,
  errorText,
  required,
}: Props) {
  const { t } = useLocale();
  const accessibleValue = value || placeholder || t("common.notSet");
  const accessibilityLabel = `${label}${required ? t("common.requiredSuffix") : ""}${t(
    "common.a11ySeparator"
  )}${accessibleValue}${errorText ? t("common.errorSuffix", { error: errorText }) : ""}`;
  return (
    <View>
      <Pressable
        onPress={onPress}
        disabled={disabled || !onPress}
        style={({ pressed }) => [
          styles.row,
          pressed && onPress && styles.pressed,
        ]}
        accessibilityRole={onPress ? "button" : undefined}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={onPress ? t("common.tapToChangeHint") : undefined}
      >
        <View style={styles.left}>
          {icon ? (
            <Ionicons
              name={icon}
              size={20}
              color={danger ? colors.warning : colors.primary}
              style={styles.icon}
            />
          ) : null}
          <Text style={[styles.label, danger && styles.dangerText]}>
            {label}
            {required ? <Text style={styles.requiredBadge}> {t("fieldRow.requiredBadge")}</Text> : null}
          </Text>
        </View>
        <View style={styles.right}>
          <Text
            style={[
              styles.value,
              !value && styles.placeholder,
              danger && styles.dangerText,
            ]}
            numberOfLines={1}
          >
            {value || placeholder || ""}
          </Text>
          {onPress && showChevron ? (
            <Ionicons
              name="chevron-forward"
              size={18}
              color={colors.textTertiary}
            />
          ) : null}
        </View>
      </Pressable>
      {errorText ? <Text style={styles.error}>{errorText}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: minTapSize + 8,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  pressed: {
    backgroundColor: colors.surfaceAlt,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexShrink: 0,
  },
  icon: {
    width: 22,
  },
  label: {
    fontSize: 16,
    color: colors.textPrimary,
  },
  requiredBadge: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textTertiary,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    flexShrink: 1,
    marginLeft: spacing.md,
  },
  value: {
    fontSize: 16,
    color: colors.primary,
    maxWidth: 200,
    textAlign: "right",
  },
  placeholder: {
    color: colors.placeholder,
  },
  dangerText: {
    color: colors.warning,
  },
  error: {
    color: colors.warning,
    fontSize: 12,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
});
