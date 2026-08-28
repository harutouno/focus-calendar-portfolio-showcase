import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";

interface Props {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  tone?: "primary" | "focus";
}

export function StatCard({ icon, label, value, tone = "primary" }: Props) {
  const tint = tone === "focus" ? colors.focus : colors.primary;
  const soft = tone === "focus" ? colors.focusSoft : colors.primarySoft;
  return (
    <View style={styles.card}>
      <View style={[styles.iconWrap, { backgroundColor: soft }]}>
        <Ionicons name={icon} size={18} color={tint} />
      </View>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

export function BigStatCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.bigCard}>
      <Text style={styles.bigLabel}>{label}</Text>
      <Text style={styles.bigValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    alignItems: "center",
    gap: 4,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  value: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  label: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  bigCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xl,
    alignItems: "center",
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  bigLabel: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  bigValue: {
    fontSize: 34,
    fontWeight: "800",
    color: colors.primary,
  },
});
