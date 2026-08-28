import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { useAuth } from "@/context/AuthContext";
import { useAppData } from "@/context/AppDataContext";
import { AcceptInviteResult, acceptInvite } from "@/services/calendarService";
import {
  SharedMutationIdentity,
  buildIdentityRemountKey,
  isCurrentSharedMutationIdentity,
  runCurrentSharedMutation,
} from "@/auth/sharedMutationIdentity";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";

const ROLE_LABEL_KEY: Record<string, TranslationKey> = {
  owner: "calendarRole.owner",
  editor: "calendarRole.editor",
  viewer: "calendarRole.viewer",
};

/**
 * REVISE対応（第10ラウンド、P1-1、必須テスト4）: 参加結果`result`（参加したカレンダー名・
 * 役割）は、`!user`判定より前の分岐で表示されるため、ログアウト・別ユーザーへの切替後も
 * 画面が再マウントされない限り残り続けてしまう。薄い外側wrapperでidentityKeyを作り
 * 実装本体をkey付きで再マウントすることで、identityが変わった最初のコミットで
 * `result`を含む全ローカルstateが初期値へ戻る（members.tsxと同じパターン）。
 */
export default function AcceptInviteScreen() {
  const { user, sessionInstanceId } = useAuth();
  const identityKey = buildIdentityRemountKey(user?.id, sessionInstanceId);
  return <AcceptInviteScreenInner key={identityKey} />;
}

function AcceptInviteScreenInner() {
  const router = useRouter();
  const { t } = useLocale();
  const { token } = useLocalSearchParams<{ token: string }>();
  const { user, sessionInstanceId, isSupabaseConfigured, loading: authLoading } = useAuth();
  const { refreshShared, markCalendarVisible } = useAppData();
  const [joining, setJoining] = useState(false);
  const [result, setResult] = useState<AcceptInviteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // REVISE対応（第10ラウンド、P1-3）: acceptInvite呼出しだけでなく、その後のsetResult
  // （参加結果＝カレンダー名等の表示）・refreshShared・markCalendarVisibleまで含めた
  // ハンドラー全体を1つのidentity-scoped操作としてrunCurrentSharedMutationで囲む。
  // この画面は既にidentity-key付き再マウント（P1-1）されているため、identity切替時は
  // mountedRefのガードも働くが、ここでは呼び出し元の規律に依存しない多層防御として
  // 明示的にassertCurrentも行う。
  const handleJoin = async () => {
    if (!token) return;
    // P0015 Batch1.2、P1-5: identityの固定・現在性確認を、setJoining(true)/setError(null)
    // というuser-visibleな副作用より前に行う（stale closureからの押下ではbusy状態にも
    // エラー表示クリアにも一切入らない）。未ログイン等でidentity自体を組み立てられない
    // 場合は、従来どおりcatchでエラー表示する（この分岐はstaleではなく前提条件エラーのため）。
    let identity: SharedMutationIdentity | null = null;
    try {
      if (!user || !sessionInstanceId) {
        throw new Error("認証セッション情報を確認できないため、この操作を行えません");
      }
      identity = { userId: user.id, sessionInstanceId };
      if (!isCurrentSharedMutationIdentity(identity)) return;
      setJoining(true);
      setError(null);
      // REVISE対応（P0014 Batch1.1、P1-3）: mountedRefだけでなく、開始時に固定した
      // identityも使う。authSessionIdentityStoreだけが先にBへ切り替わり、このコンポーネントの
      // identity-key remountがまだcommitされていない短い窓（mountedRef.currentは依然
      // trueのまま）でacceptがstale rejectしても、setError・setJoining(false)のいずれも
      // 行わない（navigation/markCalendarVisibleへは既存のassertCurrent配置により
      // 元々進まない）。
      await runCurrentSharedMutation(identity, async (assertCurrent) => {
        const res = await acceptInvite(token, identity!);
        assertCurrent();
        if (!mountedRef.current) return;
        setResult(res);
        await refreshShared();
        assertCurrent();
        if (!mountedRef.current) return;
        // P0015 Batch1.2、P1-1（残存ギャップ対応）: markCalendarVisibleの内部isShared判定は、
        // このクロージャが捕捉したrefreshShared()実行前のsharedCalendarsスナップショットを
        // 参照するため、今回の受諾で初めて参加が確定したres.calendarIdを構造的に検出できない
        // （クロージャは実行中に自動更新されない）。この画面が既に検証済みのidentityを
        // 明示的に渡す。
        await markCalendarVisible(res.calendarId, identity!);
      });
    } catch (e) {
      if (!mountedRef.current) return;
      if (identity && !isCurrentSharedMutationIdentity(identity)) return;
      setError(
        toFriendlyMessage(e instanceof Error ? e.message : undefined, t("inviteToken.joinFailedFallback"), t)
      );
    } finally {
      if (!mountedRef.current) return;
      if (identity && !isCurrentSharedMutationIdentity(identity)) return;
      setJoining(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("inviteToken.title")} onBack={() => router.back()} />
      <View style={styles.content}>
        {authLoading ? (
          <SectionCard>
            <View style={styles.resultBox}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          </SectionCard>
        ) : result ? (
          <SectionCard>
            <View style={styles.resultBox}>
              <Ionicons name="checkmark-circle" size={40} color={colors.meeting} />
              <Text style={styles.resultTitle}>
                {t("inviteToken.joinedHeadline", { name: result.calendarName })}
              </Text>
              <Text style={styles.resultSub}>
                {t("inviteToken.roleSummary", { role: t(ROLE_LABEL_KEY[result.role]) })}
              </Text>
              <PrimaryButton
                label={t("inviteToken.openCalendarButton")}
                onPress={() =>
                  router.replace({
                    pathname: "/calendar/[id]",
                    params: { id: result.calendarId },
                  })
                }
                style={styles.button}
              />
            </View>
          </SectionCard>
        ) : !user ? (
          <SectionCard>
            <View style={styles.resultBox}>
              <Ionicons name="log-in-outline" size={36} color={colors.primary} />
              <Text style={styles.resultTitle}>{t("inviteToken.needsLoginHeadline")}</Text>
              <PrimaryButton
                label={t("inviteToken.signInButton")}
                onPress={() =>
                  router.push({
                    pathname: "/auth/sign-in",
                    params: { returnTo: `/invite/${token}` },
                  })
                }
                disabled={!isSupabaseConfigured}
                style={styles.button}
              />
            </View>
          </SectionCard>
        ) : (
          <SectionCard>
            <View style={styles.resultBox}>
              <Ionicons name="people-outline" size={36} color={colors.primary} />
              <Text style={styles.resultTitle}>{t("inviteToken.confirmHeadline")}</Text>
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
              <PrimaryButton
                label={t("inviteToken.joinButton")}
                onPress={handleJoin}
                loading={joining}
                style={styles.button}
              />
            </View>
          </SectionCard>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  resultBox: { alignItems: "center", padding: spacing.xl, gap: spacing.sm },
  resultTitle: { fontSize: 16, fontWeight: "700", color: colors.textPrimary, textAlign: "center" },
  resultSub: { fontSize: 13, color: colors.textSecondary },
  errorText: { fontSize: 13, color: colors.warning, textAlign: "center" },
  button: { marginTop: spacing.md, minWidth: 200 },
});
