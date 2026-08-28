import React, { useEffect, useRef } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { useAISupportRequest } from "@/hooks/useAISupportRequest";
import { classifyAIRequest } from "@/utils/aiRequestClassifier";
import { appendAiChatHistory } from "@/storage/aiChatHistoryRepository";
import { generateId } from "@/utils/id";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { AiIntentEntry, publishAiIntent, readAiIntent } from "@/ai/aiIntentHandoffStore";
import { isAiOperationOwnerCurrent } from "@/ai/aiOperationOwner";
import { publishAiResult } from "@/ai/aiResultHandoffStore";
import { getCurrentAuthIdentity } from "@/auth/authSessionIdentityStore";

function debugLog(message: string, data: Record<string, unknown>): void {
  if (__DEV__) {
    // eslint-disable-next-line no-console -- 開発時のみ、種別・件数・真偽値のみを出力する調査用ログ（本文・機密情報は出力しない）
    console.log(`[aiRequest] ${message}`, data);
  }
}

/**
 * AI処理画面（Stage I-8）。チャット形式の画面遷移・デザインは変更せず、結果が出たら
 * /ai/resultへ差し替え遷移する。2026-07-25: 結果を受け取った時点で1件だけ履歴へ保存する
 * （このuseEffectが「成功」を検知する唯一の場所のため、ここに追加するのが最小差分）。
 * 2026-07-31: 利用回数の確定（recordUsage）もこの「成功」検知箇所でのみ行う。以前は送信直後
 * （app/ai/index.tsxのhandleSend）で確定していたため、AIリクエストが失敗しても1回分消費された
 * ままになっていた。成功時にのみ呼ぶことで、失敗時に利用回数を失わない。
 *
 * P0148 (SEC-F007-005) §5/§6/§7: この画面はhookのsuccessを「いつまでも信用してよい」ものと
 * して扱っていた。成功は**その依頼を開始した正確なidentity**に束縛されており、
 * 他サブシステムへ波及する終端動作（利用回数の確定・履歴保存・結果の公開・遷移）は
 * それぞれの直前に権威identityを再確認する。途中でstale化したら残りは実行しない。
 * また、生の応答をルートパラメータへ載せるのをやめ、所有者付きの一時ストアへ公開して
 * `resultId`だけを渡す。
 *
 * P0150 (SEC-F007-006) §3: この画面はもう「入力」も「所有者」もルートから作らない。
 * ルートが運ぶのは `intentId` だけで、入力と**明示的操作の時点で確定した不変の所有者**は
 * `aiIntentHandoffStore` から取り出す。取り出せるのは現在の権威identityがその所有者と
 * 完全一致するときだけで、一致しなければ（＝送信操作から到着までの間に切り替わった）
 * 依頼は成立せず、安全にAIホームへ戻す。
 *
 * 1つの `intentId` ＝ 1つのマウント（`key`によるremount）。これにより
 * 「1つの明示的な意図 ＝ 1つの不変の所有者」がReactの構造として保証され、
 * 途中でintentが差し替わって所有者が変わることがない
 * （conflict時のResumeは**新しい明示的操作**として新しいintentを発行する）。
 */
export default function AiProcessingScreen() {
  const { intentId } = useLocalSearchParams<{ intentId?: string }>();
  const normalizedIntentId = typeof intentId === "string" ? intentId : "";
  return <AiProcessingScreenInner key={normalizedIntentId} intentId={normalizedIntentId} />;
}

function AiProcessingScreenInner({ intentId }: { intentId: string }) {
  const router = useRouter();
  const { t } = useLocale();
  /**
   * このマウント（＝この意図）に対して1回だけ解決する。所有者検証は
   * `readAiIntent` の内部で現在の権威identityに対して行われるため、
   * ここで「今のidentity」を渡す余地はない。
   */
  const intentRef = useRef<{ resolved: boolean; intent: AiIntentEntry | null }>({
    resolved: false,
    intent: null,
  });
  if (!intentRef.current.resolved) {
    intentRef.current = { resolved: true, intent: readAiIntent(intentId) };
  }
  const intent = intentRef.current.intent;
  const normalizedInput = intent?.input ?? "";
  const kind = intent ? classifyAIRequest(normalizedInput) : null;
  const {
    status,
    response,
    error,
    retry,
    restoreStatus,
    conflictingRequest,
    retryRestore,
    discardPending,
    operationOwner,
    ownerDisposition,
  } = useAISupportRequest(kind, normalizedInput, intent?.owner ?? null);

  // P0150 §3-9: 意図が見つからない／不正／期限切れ／所有者不一致。既存の安全な
  // 戻り経路（AIホーム）へ倒す。所有者チェックを緩めて復元しようとはしない。
  useEffect(() => {
    if (!intent) {
      router.replace("/ai");
    }
  }, [intent, router]);

  useEffect(() => {
    if (status === "loading") {
      debugLog("start", { kind, inputLength: normalizedInput.length });
    } else if (status === "error") {
      debugLog("error", { kind });
    }
  }, [status, kind, normalizedInput.length]);

  // P0148: この画面が開いたままアカウント/セッションが切り替わった。
  // 前の持ち主の意図をそのまま引き継がず、AIホームへ戻す
  // （新しい持ち主は、新しい明示的な操作からのみAI依頼を開始できる）。
  useEffect(() => {
    if (ownerDisposition === "stale") {
      router.replace("/ai");
    }
  }, [ownerDisposition, router]);

  useEffect(() => {
    if (status !== "success" || !response || !kind) return;
    // 所有者が確定していない成功は扱わない（fail-closed）。
    if (!operationOwner || !isAiOperationOwnerCurrent(operationOwner)) return;
    debugLog("success", { kind: response.kind });

    // 確認する。途中で切り替わったら残りの副作用は実行しない（別アカウントの
    // 待たない（従来どおり結果表示を遅らせない）。
    void (async () => {
      if (!isAiOperationOwnerCurrent(operationOwner)) return;
      try {
        // 履歴の所有者は「今ログインしているユーザー」ではなく、この依頼の不変の所有者。
        await appendAiChatHistory({
          id: generateId("ai_history"),
          createdAt: new Date().toISOString(),
          kind,
          input: normalizedInput,
          response,
          ownerUserId: operationOwner.userId,
        });
      } catch (e) {
        if (__DEV__) {
          console.warn("[AiProcessingScreen] appendAiChatHistory失敗", e);
        }
      }
    })();

    // 結果は所有者付きの一時ストアへ公開し、ルートには`resultId`だけを渡す
    // （生の応答をunownedなnavigation stateに残さない）。公開自体が所有者検証を
    // 行うため、直前に切り替わっていればnullが返り、遷移しない。
    const resultId = publishAiResult(response, operationOwner);
    if (!resultId) return;
    router.replace({ pathname: "/ai/result", params: { resultId } });
  }, [status, response, router, kind, normalizedInput, operationOwner]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("menu.aiSupport")} />
      <View style={styles.content}>
        {restoreStatus === "failed" ? (
          <>
            <Ionicons name="sad-outline" size={40} color={colors.warning} />
            <Text style={styles.errorTitle}>{t("aiProcessing.pendingRestoreFailedTitle")}</Text>
            <PrimaryButton
              label={t("aiProcessing.pendingReloadButton")}
              onPress={retryRestore}
              style={styles.actionButton}
            />
            <PrimaryButton
              label={t("aiProcessing.pendingDiscardButton")}
              variant="secondary"
              onPress={discardPending}
              style={styles.actionButton}
            />
          </>
        ) : restoreStatus === "conflict" ? (
          <>
            <Ionicons name="alert-circle-outline" size={40} color={colors.warning} />
            <Text style={styles.errorTitle}>{t("aiProcessing.pendingConflictTitle")}</Text>
            <PrimaryButton
              label={t("aiProcessing.pendingResumeButton")}
              onPress={() => {
                if (!conflictingRequest) return;
                // P0150 §3「conflict/resume」: 「前回の依頼を続ける」は
                // **新しい明示的なユーザー操作**。この操作の時点の正確な権威identityを
                // 所有者として捕捉し直し、新しいowner束縛のintentを発行してから遷移する
                // （生の入力をルートに載せない・古い所有者を引き継がない）。
                // 保存済みrequestIdの再利用は従来どおり:新しいマウントの
                // loadPending()が、同じ所有者・同じkind/inputなら既存のrequestIdを
                // 採用する（cross-sessionの自動再送は導入していない)。
                const owner = getCurrentAuthIdentity();
                const resumedIntentId = publishAiIntent(conflictingRequest.input, owner);
                if (!resumedIntentId) return;
                router.replace({
                  pathname: "/ai/processing",
                  params: { intentId: resumedIntentId },
                });
              }}
              style={styles.actionButton}
            />
            <PrimaryButton
              label={t("aiProcessing.pendingDiscardAndResendButton")}
              variant="secondary"
              onPress={discardPending}
              style={styles.actionButton}
            />
          </>
        ) : status === "error" ? (
          <>
            <Ionicons name="sad-outline" size={40} color={colors.warning} />
            <Text style={styles.errorTitle}>{error ?? t("aiProcessing.errorTitleFallback")}</Text>
            <Text style={styles.errorDescription}>
              {t("aiProcessing.errorDescription")}
            </Text>
            <PrimaryButton label={t("aiProcessing.retryButton")} onPress={retry} style={styles.actionButton} />
            <PrimaryButton
              label={t("aiProcessing.backToAiButton")}
              variant="secondary"
              onPress={() => router.replace("/ai")}
              style={styles.actionButton}
            />
          </>
        ) : (
          <>
            <Ionicons name="sparkles-outline" size={40} color={colors.primary} />
            <Text style={styles.loadingText}>{t("aiProcessing.loadingText")}</Text>
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  loadingText: {
    fontSize: 15,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  spinner: {
    marginTop: spacing.md,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textPrimary,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  errorDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  actionButton: {
    alignSelf: "stretch",
    marginTop: spacing.sm,
  },
});
