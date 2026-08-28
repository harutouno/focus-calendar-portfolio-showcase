import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";

interface Props {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  description?: string;
}

export function EmptyState({ icon = "file-tray-outline", title, description }: Props) {
  return (
    <View style={styles.container}>
      <Ionicons name={icon} size={40} color={colors.textTertiary} />
      <Text style={styles.title}>{title}</Text>
      {description ? (
        <Text style={styles.description}>{description}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textSecondary,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  description: {
    fontSize: 13,
    color: colors.textTertiary,
    textAlign: "center",
  },
});
