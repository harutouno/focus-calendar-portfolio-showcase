import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { AiTemplateCard } from "@/components/ai/AiTemplateCard";
import { getAiSupportTemplates, AISupportTemplate } from "@/constants/aiTemplates";
import { AI_SUPPORT_FEATURE_ENABLED } from "@/config/featureFlags";
import { useAiChatHistory } from "@/hooks/useAiChatHistory";
import { useLocale } from "@/context/LocaleContext";
import { useAuthOptional } from "@/context/AuthContext";
import { useAuthIdentityKey } from "@/auth/useAuthIdentity";
import { getCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";
import { publishAiIntent } from "@/ai/aiIntentHandoffStore";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";

/**
 * P0148 (SEC-F007-005) §4: AIホームのローカル`input`は利用者の私的な下書き。
 * 権威identity（authSessionIdentityStore）が変わった瞬間に、下書きを含む画面内の
 * ローカルstateごと作り直す。Reactは同じ位置の要素のkeyが変わると古いサブツリーを
 * アンマウントしてから新しいサブツリーをマウントするため、**非同期effectの完了を
 * 待たずに**前の持ち主の下書きが見えなくなり、そのまま送信されることもない
 * （app/event/new.tsx・NormalEventForm.tsxと同じremountパターン。ただしidentityの
 * 取得元はAuthContextではなく権威ストア）。UI・画面遷移・デザインは変更していない。
 */
export default function AiHomeScreen() {
  const identityKey = useAuthIdentityKey();
  return <AiHomeScreenInner key={identityKey} />;
}

/**
 * チャット画面ではなく「テンプレートを選ぶ／入力する→送信」の1リクエスト構成という
 * 既存の画面遷移・デザインは変更していない。
 */
function AiHomeScreenInner() {
  const router = useRouter();
  const { t } = useLocale();
  const auth = useAuthOptional();
  // P0150 §3-2: 認証状態が復元途中の間は「誰の依頼か」を確定できない。
  // 所有者を確定できない状態では送信しない（fail-closed）。identityの値そのものは
  // AuthContextからではなく権威ストアから読む（AuthContextはsetCurrentAuthIdentityの
  // **後**にsetStateするため、値の権威にしてはならない）。
  const authLoading = auth?.loading ?? false;
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const { entries: historyEntries } = useAiChatHistory();
  const templates = useMemo(() => getAiSupportTemplates(t), [t]);

  // v1.0ではメニュー・ホーム画面の導線を非表示にしているが、直接URL遷移（ディープリンク等）
  // で到達された場合に備え、安全にホームへ戻す。
  useEffect(() => {
    if (!AI_SUPPORT_FEATURE_ENABLED) {
      router.replace("/");
    }
  }, [router]);

  if (!AI_SUPPORT_FEATURE_ENABLED) return null;

  const handleTemplatePress = (template: AISupportTemplate) => {
    setInput(template.template);
  };

  /**
   * P0150 (SEC-F007-006) §3: 「送信」は**明示的なユーザー操作**であり、この依頼の
   * 所有者はここで確定する。従来は生の入力文字列だけをrouteパラメータへ載せて
   * pushしており、所有者の確定は遷移先（processing画面）のマウント時点だった。
   * その隙間でidentityが切り替わると、Aの私的な入力がBの依頼として送信されていた。
   *
   * 現在は
   *   1. この操作の時点の正確な権威identityを所有者として捕捉し、
   *   2. 入力をその所有者に束縛した状態でintentストアへ登録し、
   *   3. routeには `intentId` だけを載せる（生の入力を運ばない）。
   * 所有者を確定できない／既に権威でない場合は遷移しない（fail-closed）。
   */
  const handleSend = () => {
    if (sending) return;
    const trimmed = input.trim();
    if (!trimmed) return;
    if (authLoading) return;
    setSending(true);
    try {
      const owner = getCurrentAuthIdentity();
      const intentId = publishAiIntent(trimmed, owner);
      if (!intentId) return;
      router.push({ pathname: "/ai/processing", params: { intentId } });
    } finally {
      setSending(false);
    }
  };

  const handleMicPress = () => {
    Alert.alert(t("ai.voiceInputTitle"), t("ai.voiceInputComingSoon"));
  };

  const canSend = !sending;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("ai.header")} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={80}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>{t("ai.header")}</Text>
          <Text style={styles.description}>{t("ai.description")}</Text>
          <View style={styles.demoBadge}>
            <Ionicons name="flask-outline" size={14} color={colors.textSecondary} />
            <Text style={styles.demoBadgeText}>{t("ai.demoNotice")}</Text>
          </View>


          <Text style={styles.sectionTitle}>{t("ai.suggestionsHeading")}</Text>
          {templates.map((template) => (
            <AiTemplateCard
              key={template.id}
              template={template}
              onPress={handleTemplatePress}
            />
          ))}

          <Text style={styles.sectionTitle}>{t("ai.historyHeading")}</Text>
          {historyEntries.length === 0 ? (
            <Text style={styles.historyEmpty}>{t("ai.historyEmpty")}</Text>
          ) : (
            historyEntries.map((entry) => (
              <View key={entry.id} style={styles.historyRow}>
                <Ionicons name="time-outline" size={16} color={colors.textTertiary} />
                <View style={styles.historyTextWrap}>
                  <Text style={styles.historyInput} numberOfLines={1}>
                    {entry.input}
                  </Text>
                  <Text style={styles.historyHeadline} numberOfLines={1}>
                    {entry.response.headline}
                  </Text>
                </View>
              </View>
            ))
          )}
        </ScrollView>

          <View style={styles.inputRow}>
            <Pressable
              style={styles.micButton}
              onPress={handleMicPress}
              accessibilityRole="button"
              accessibilityLabel={t("ai.voiceInputA11y")}
            >
              <Ionicons name="mic-outline" size={20} color={colors.textInverse} />
            </Pressable>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder={t("ai.inputPlaceholder")}
              placeholderTextColor={colors.placeholder}
              onSubmitEditing={handleSend}
              returnKeyType="send"
            />
            <Pressable
              style={[
                styles.sendButton,
                (!input.trim() || !canSend) && styles.sendButtonDisabled,
              ]}
              onPress={handleSend}
              disabled={!input.trim() || !canSend}
              accessibilityRole="button"
              accessibilityLabel={t("ai.sendA11y")}
            >
              <Ionicons name="arrow-forward" size={18} color={colors.textInverse} />
            </Pressable>
          </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing.xl,
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.textPrimary,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  description: {
    fontSize: 13,
    color: colors.textSecondary,
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
    lineHeight: 18,
  },
  usageSection: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    gap: 4,
  },
  usageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  usageText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  usageFetchFailedText: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  usageRetryText: {
    fontSize: 12,
    color: colors.primary,
    fontWeight: "700",
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textSecondary,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
  },
  historyEmpty: {
    fontSize: 13,
    color: colors.textTertiary,
    marginHorizontal: spacing.lg,
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  historyTextWrap: {
    flex: 1,
  },
  historyInput: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: "600",
  },
  historyHeadline: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 1,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
  },
  micButton: {
    width: minTapSize,
    height: minTapSize,
    borderRadius: minTapSize / 2,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    flex: 1,
    minHeight: minTapSize,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    fontSize: 15,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceAlt,
  },
  sendButton: {
    width: minTapSize,
    height: minTapSize,
    borderRadius: minTapSize / 2,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  demoBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: spacing.sm,
  },
  demoBadgeText: { fontSize: 12, color: colors.textSecondary },
  depletedRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
    gap: spacing.sm,
  },
  depletedTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textPrimary,
    textAlign: "center",
  },
  depletedHint: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: "center",
  },
  watchAdButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: minTapSize,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  watchAdButtonDisabled: {
    opacity: 0.4,
  },
  watchAdButtonText: {
    color: colors.textInverse,
    fontSize: 14,
    fontWeight: "700",
  },
});
