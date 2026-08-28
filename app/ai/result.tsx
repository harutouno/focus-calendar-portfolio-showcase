import React, { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { EmptyState } from "@/components/common/EmptyState";
import { AiScheduleCard } from "@/components/ai/AiScheduleCard";
import { AiSummaryCard } from "@/components/ai/AiSummaryCard";
import { AIResultActionType } from "@/types/ai";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { useAuthIdentity } from "@/auth/useAuthIdentity";
import { readAiResult } from "@/ai/aiResultHandoffStore";
import { useAppData } from "@/context/AppDataContext";
import { convertAiScheduleToNormalEvent } from "@/utils/aiScheduleToEvent";
import { BASE_CALENDAR_ID } from "@/constants/options";

/**
 * AI結果画面（Stage I-8）。吹き出しではなくカードで結果を表示する。
 *
 * P0148 (SEC-F007-005) §7: ルートは`resultId`だけを運ぶ。実体は所有者付きの
 * 一時ストア（aiResultHandoffStore）にあり、**現在の権威identityが公開時の所有者と
 * 完全一致したときだけ**読み出せる。identityは`useAuthIdentity()`でストアを直接購読
 * しているため、この画面が開いたままアカウントが切り替わっても、effectの実行を待たず
 * その場のrenderで結果が読めなくなる（既存の空状態UIへ落ちる）。
 * プロセス再起動後にストアが空でも、所有者検証を緩めて復元することはしない。
 *
 * P0150 (MAINT-AI-001) §6: 所有者検証に使う「現在のidentity」は`readAiResult`の内部で
 * 権威ストアから直接読むようになったため、引数では渡さない（画面が渡した値を
 * 権威にしない）。ここで`useAuthIdentity()`を呼び続けているのは値のためではなく、
 * identityが変わった瞬間にこの画面を再renderさせ、読み直しを発生させるための購読。
 */
export default function AiResultScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const { resultId } = useLocalSearchParams<{ resultId?: string }>();
  useAuthIdentity();
  const parsed = readAiResult(resultId);

  const { saveEvent } = useAppData();
  const [applying, setApplying] = useState(false);

  /**
   * Demo AI の提案を実際の予定として保存する。
   *
   * 保存前に必ず確認ダイアログを出す（AI の出力をユーザー確認なしで永続化しない）。
   * 変換は convertAiScheduleToNormalEvent が単独で責任を持ち、変換できない提案は
   * null を返して保存経路へ入らない（fail-closed）。保存自体は通常の予定作成と
   * まったく同じ saveEvent 経路を通るので、カレンダー種別の判定・共有カレンダーの
   * 権限チェック・オフラインキューは既存実装がそのまま効く。
   */
  const applyScheduleToCalendar = () => {
    if (!parsed?.schedule || applying) return;
    const event = convertAiScheduleToNormalEvent({
      schedule: parsed.schedule,
      calendarId: BASE_CALENDAR_ID,
    });
    if (!event) {
      Alert.alert(t("aiResult.applyFailedTitle"), t("aiResult.applyInvalidMessage"));
      return;
    }
    Alert.alert(
      t("aiResult.applyConfirmTitle"),
      t("aiResult.applyConfirmMessage", {
        title: event.title,
        date: event.date,
        start: event.startTime,
        end: event.endTime,
      }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("aiResult.applyConfirmAction"),
          onPress: async () => {
            setApplying(true);
            try {
              await saveEvent(event);
              Alert.alert(t("aiResult.applyDoneTitle"), t("aiResult.applyDoneMessage"), [
                { text: t("aiResult.applyDoneAction"), onPress: () => router.push("/") },
              ]);
            } catch {
              Alert.alert(t("aiResult.applyFailedTitle"), t("aiResult.applyFailedMessage"));
            } finally {
              setApplying(false);
            }
          },
        },
      ]
    );
  };

  const handleAction = (type: AIResultActionType) => {
    if (type === "apply_to_calendar") applyScheduleToCalendar();
    else if (type === "view_calendar") router.push("/");
    else if (type === "view_records") router.push("/records");
    else router.replace("/ai");
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("menu.aiSupport")} />
      {!parsed ? (
        <EmptyState
          icon="alert-circle-outline"
          title={t("aiResult.emptyTitle")}
          description={t("aiResult.emptyDescription")}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.headlineRow}>
            <Ionicons name="checkmark-circle" size={20} color={colors.meeting} />
            <Text style={styles.headline}>{parsed.headline}</Text>
          </View>

          {parsed.description ? (
            <Text style={styles.description}>{parsed.description}</Text>
          ) : null}

          {parsed.schedule ? <AiScheduleCard schedule={parsed.schedule} /> : null}
          {parsed.summaryRows ? (
            <AiSummaryCard title={t("aiResult.weeklySummaryTitle")} rows={parsed.summaryRows} />
          ) : null}

          <View style={styles.actions}>
            {parsed.actions.map((action, index) => (
              <PrimaryButton
                key={action.type}
                label={action.label}
                variant={index === 0 ? "primary" : "secondary"}
                onPress={() => handleAction(action.type)}
                disabled={action.type === "apply_to_calendar" && applying}
              />
            ))}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  headlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  headline: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  description: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  actions: {
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
});
