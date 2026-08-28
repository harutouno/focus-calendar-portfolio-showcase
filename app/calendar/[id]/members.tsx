import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { LoadingView } from "@/components/common/LoadingView";
import { PickerModal, PickerOption } from "@/components/forms/PickerModal";
import { useAppData } from "@/context/AppDataContext";
import { useAuth } from "@/context/AuthContext";
import {
  fetchCalendarMembers,
  removeMember,
  updateMemberRole,
} from "@/services/calendarService";
import {
  SharedMutationIdentity,
  buildIdentityRemountKey,
  isCurrentSharedMutationIdentity,
  runCurrentSharedMutation,
} from "@/auth/sharedMutationIdentity";
import { CalendarMembership, CalendarRole } from "@/types/sharing";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";

const ROLE_LABEL_KEY: Record<CalendarRole, TranslationKey> = {
  owner: "calendarRole.owner",
  editor: "calendarRole.editor",
  viewer: "calendarRole.viewer",
};

/**
 * REVISE対応（第10ラウンド、P1-1）: このコンポーネントが保持するmembers・editingMember等の
 * ローカルstateはAのメンバー名・権限を含みうる機密性の高い表示情報のため、identity
 * （userId+sessionInstanceId）が変わった最初のコミットで一切公開しないよう、薄い外側
 * wrapperでidentityKeyを作り、実装本体をkey付きで再マウントする（Reactは同じ位置の
 * 要素のkeyが変わると、古いサブツリーをアンマウントしてから新しいサブツリーを
 * マウントするため、中間状態が観測されない）。ログアウト・A→B・A/session1→A/session2の
 * いずれでもkeyが変わり、ローカルstateが初期値へ戻る。
 */
export default function CalendarMembersScreen() {
  const { user, sessionInstanceId } = useAuth();
  const identityKey = buildIdentityRemountKey(user?.id, sessionInstanceId);
  return <CalendarMembersScreenInner key={identityKey} />;
}

function CalendarMembersScreenInner() {
  const router = useRouter();
  const { t } = useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { sharedCalendars } = useAppData();
  const { user, sessionInstanceId } = useAuth();
  const [members, setMembers] = useState<CalendarMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingMember, setEditingMember] = useState<CalendarMembership | null>(null);

  const summary = useMemo(
    () => sharedCalendars.find((s) => s.calendar.id === id),
    [sharedCalendars, id]
  );
  const isOwner = summary?.role === "owner";

  // REVISE対応（第9ラウンド、P1-2）: removeMember/updateMemberRoleへ渡すSharedMutationIdentityを
  // ここで一元的に組み立てる。
  // REVISE対応（第10ラウンド、P1-1/P1-2）: userオブジェクト自体ではなくuser?.id（文字列）に
  // 依存させる。AuthContextはTOKEN_REFRESHED等でidentity値が変わらない場合でもsessionオブジェクト
  // （ひいてはuser参照）を再生成しうるため、user自体を依存配列に含めるとrequireIdentityの参照が
  // 不必要に変化し、これを依存配列に含むload用useCallback/useEffectが不要な再取得を繰り返して
  // しまう（P1-1テスト6「同一identityのTOKEN_REFRESHEDでは不必要にstateを初期化しない」に反する）。
  const userId = user?.id ?? null;
  const requireIdentity = useCallback((): SharedMutationIdentity => {
    if (!userId || !sessionInstanceId) {
      throw new Error("認証セッション情報を確認できないため、この操作を行えません");
    }
    return { userId, sessionInstanceId };
  }, [userId, sessionInstanceId]);

  // REVISE対応（第10ラウンド、P1-2）: fetchCalendarMembersへSharedMutationIdentityを渡す。
  // 同一identityのまま複数回呼ばれた場合（handleRemove/onApply等がload()を連続で呼ぶ経路）に
  // 古い要求が新しい要求の結果を上書きしないよう、latest-wins判定用のtokenを併用する。
  const loadTokenRef = useRef(0);
  // P0015 Batch1.2、P1-4: identityを取得し、その時点でcurrentである場合だけ
  // setLoading(true)から始める（stale closureからの呼出しでloading表示だけ開始して
  // しまうことを防ぐ）。完了時（setMembers/setLoading(false)）も同じidentityで
  // 再確認する。
  const load = useCallback(async () => {
    if (!id) return;
    let identity: SharedMutationIdentity;
    try {
      identity = requireIdentity();
    } catch {
      return;
    }
    if (!isCurrentSharedMutationIdentity(identity)) return;
    const token = ++loadTokenRef.current;
    setLoading(true);
    try {
      const result = await fetchCalendarMembers(id, identity);
      if (loadTokenRef.current !== token) return;
      if (!isCurrentSharedMutationIdentity(identity)) return;
      setMembers(result);
    } catch {
      // identity失効・通信失敗のいずれも、既存の一覧表示は変更しない。
    } finally {
      if (loadTokenRef.current === token && isCurrentSharedMutationIdentity(identity)) {
        setLoading(false);
      }
    }
  }, [id, requireIdentity]);

  useEffect(() => {
    load();
  }, [load]);

  // REVISE対応（第10ラウンド、P1-3）: removeMember呼出しと、その後の再取得（load）を
  // 1つのidentity-scoped操作としてrunCurrentSharedMutationで囲む。identityはハンドラー
  // 開始時に一度だけ固定し、removeMember解決直後（load()を呼ぶ前）にassertCurrentする。
  // REVISE対応（P0014 Batch1.1、P1-3）: 失敗Alertは、開始時に固定したidentityが現在も
  // current（=stale切替が原因の中断ではない）場合だけ表示する。stale時はerror message
  // 文字列を見ず、isCurrentSharedMutationIdentityによる構造的判定で抑止する。
  const handleRemove = (member: CalendarMembership) => {
    // P0015 Batch1.2、P1-4: 削除確認Alert自体も、開いた時点でcurrent identityの場合だけ
    // 表示する（stale closureからの押下では確認ダイアログすら出さない）。
    try {
      if (!isCurrentSharedMutationIdentity(requireIdentity())) return;
    } catch {
      return;
    }
    Alert.alert(
      t("calendarMembers.removeConfirmTitle"),
      t("calendarMembers.removeConfirmMessage", {
        name: member.displayName ?? t("calendarMembers.memberFallbackNameForRemove"),
      }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"),
          style: "destructive",
          onPress: async () => {
            let identity: SharedMutationIdentity | null = null;
            try {
              identity = requireIdentity();
              await runCurrentSharedMutation(identity, async (assertCurrent) => {
                await removeMember(member.calendarId, member.userId, identity!);
                assertCurrent();
                await load();
              });
            } catch (e) {
              if (identity && !isCurrentSharedMutationIdentity(identity)) return;
              Alert.alert(
                t("common.couldNotDelete"),
                toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotDelete"), t)
              );
            }
          },
        },
      ]
    );
  };

  if (loading) return <LoadingView />;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("calendarMembers.title")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        {members.map((m) => (
          <View key={m.userId} style={styles.row}>
            <Ionicons name="person-circle-outline" size={28} color={colors.textTertiary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {m.displayName ?? t("calendarMembers.memberFallbackName")}
                {m.userId === user?.id ? t("common.selfSuffix") : ""}
              </Text>
              <Text style={styles.role}>{t(ROLE_LABEL_KEY[m.role])}</Text>
            </View>
            {isOwner && m.role !== "owner" && (
              <>
                <Pressable
                  style={styles.iconButton}
                  onPress={() => {
                    // P0015 Batch1.2、P1-4: 編集モーダルを開く操作自体もcurrent identityの
                    // 場合だけ行う。
                    try {
                      if (!isCurrentSharedMutationIdentity(requireIdentity())) return;
                    } catch {
                      return;
                    }
                    setEditingMember(m);
                  }}
                  accessibilityLabel={t("calendarMembers.editRoleA11y")}
                >
                  <Ionicons name="create-outline" size={20} color={colors.primary} />
                </Pressable>
                <Pressable
                  style={styles.iconButton}
                  onPress={() => handleRemove(m)}
                  accessibilityLabel={t("common.delete")}
                >
                  <Ionicons name="trash-outline" size={20} color={colors.warning} />
                </Pressable>
              </>
            )}
          </View>
        ))}
      </ScrollView>
      <PickerModal
        visible={!!editingMember}
        title={t("calendarMembers.editRoleA11y")}
        options={(["editor", "viewer"] as CalendarRole[]).map<PickerOption>((r) => ({
          id: r,
          label: t(ROLE_LABEL_KEY[r]),
        }))}
        selectedIds={editingMember ? [editingMember.role] : []}
        onClose={() => setEditingMember(null)}
        onApply={async (ids) => {
          if (!editingMember) return;
          // REVISE対応（P0014 Batch1.1、P1-3）: 失敗Alert・モーダルを閉じるstate更新の
          // いずれも、開始時に固定したidentityがcurrentの場合だけ行う（stale時はモーダルを
          // 開いたままにし、実際の再マウントに後始末を委ねる）。
          let identity: SharedMutationIdentity | null = null;
          try {
            identity = requireIdentity();
            await runCurrentSharedMutation(identity, async (assertCurrent) => {
              await updateMemberRole(
                editingMember.calendarId,
                editingMember.userId,
                ids[0] as CalendarRole,
                identity!
              );
              assertCurrent();
              await load();
            });
          } catch (e) {
            if (!identity || isCurrentSharedMutationIdentity(identity)) {
              Alert.alert(
                t("common.couldNotChange"),
                toFriendlyMessage(e instanceof Error ? e.message : undefined, t("calendarMembers.roleChangeFailedFallback"), t)
              );
            }
          } finally {
            if (!identity || isCurrentSharedMutationIdentity(identity)) {
              setEditingMember(null);
            }
          }
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingVertical: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 64,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  name: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  role: { fontSize: 12, color: colors.textTertiary, marginTop: 2 },
  iconButton: { padding: spacing.xs },
});
