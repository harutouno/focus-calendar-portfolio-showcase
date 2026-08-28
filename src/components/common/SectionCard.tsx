import React from "react";
import { StyleSheet, View, ViewStyle } from "react-native";
import { colors } from "@/theme/colors";
import { radius, shadow, spacing } from "@/theme/spacing";

export function SectionCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    overflow: "hidden",
  },
});
