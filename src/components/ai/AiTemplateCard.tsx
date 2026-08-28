import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";
import { AISupportTemplate } from "@/constants/aiTemplates";

interface Props {
  template: AISupportTemplate;
  onPress: (template: AISupportTemplate) => void;
}

/** AIホーム画面の「よく使うサポート」カード。タップで入力欄へテンプレートを入れるだけで送信はしない。 */
export function AiTemplateCard({ template, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={() => onPress(template)}
      accessibilityRole="button"
      accessibilityLabel={template.title}
    >
      <View style={styles.iconWrap}>
        <Ionicons name={template.icon} size={20} color={colors.primary} />
      </View>
      <View style={styles.textWrap}>
        <Text style={styles.title}>{template.title}</Text>
        <Text style={styles.description}>{template.description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  pressed: {
    backgroundColor: colors.surfaceAlt,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  textWrap: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  description: {
    fontSize: 12,
    color: colors.textSecondary,
  },
});
