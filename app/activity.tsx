import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { PageLayout } from "@/components/common/PageLayout";
import { useAppData } from "@/context/AppDataContext";
import { isFocusTask } from "@/types/event";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";

export default function ActivityScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const { events } = useAppData();
  const recent = [...events].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <PageLayout header={<ScreenHeader title={t("activity.title")} onBack={() => router.back()} />}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <Text style={styles.helper}>{t("activity.helperText")}</Text>
          {recent.length === 0 ? (
            <Text style={styles.empty}>{t("activity.emptyText")}</Text>
          ) : (
            recent.map((e) => (
              <Pressable
                key={e.id}
                style={styles.card}
                onPress={() =>
                  router.push({
                    pathname: isFocusTask(e) ? "/focus/[id]" : "/event/[id]",
                    params: { id: e.id },
                  })
                }
              >
                <View style={[styles.icon, isFocusTask(e) && styles.focusIcon]}>
                  <Ionicons name={isFocusTask(e) ? "lock-closed" : "calendar"} size={18} color={colors.textInverse} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>{e.title}</Text>
                  <Text style={styles.date}>{t("activity.dateTimeRow", { date: e.date, time: e.startTime })}</Text>
                  <Text style={styles.action}>
                    {e.completed
                      ? t("activity.completedLabel")
                      : e.createdAt === e.updatedAt
                        ? t("activity.createdLabel")
                        : t("activity.updatedLabel")}
                  </Text>
                </View>
              </Pressable>
            ))
          )}
        </ScrollView>
      </PageLayout>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  // PageLayoutのcontent領域（flex:1）いっぱいに広がるよう明示する。
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: 10 },
  helper: { color: colors.textSecondary, lineHeight: 20, marginBottom: 6 },
  empty: { textAlign: "center", color: colors.textTertiary, marginTop: 50 },
  card: { flexDirection: "row", gap: 12, padding: 16, borderRadius: 16, backgroundColor: colors.surface },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  focusIcon: { backgroundColor: colors.focus },
  title: { fontSize: 16, fontWeight: "700", color: colors.textPrimary },
  date: { marginTop: 3, color: colors.textSecondary },
  action: { marginTop: 8, color: colors.primary, fontWeight: "600" },
});
