import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";
import { getRestrictedAppOptions } from "@/constants/options";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  appIds: string[];
}

export function RestrictedAppsList({ appIds }: Props) {
  const { t } = useLocale();
  const options = getRestrictedAppOptions(t);
  const names = appIds
    .map((id) => options.find((o) => o.id === id)?.name)
    .filter(Boolean) as string[];

  return (
    <View style={styles.container}>
      <Ionicons name="lock-closed" size={18} color={colors.focusStrong} />
      <Text style={styles.text} numberOfLines={2}>
        {names.length > 0
          ? t("restrictedAppsList.restrictingText", {
              names: names.join(t("restrictedAppsList.listSeparator")),
            })
          : t("restrictedAppsList.noneSet")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginHorizontal: spacing.lg,
  },
  text: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: "600",
  },
});
