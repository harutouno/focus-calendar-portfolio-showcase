import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import * as Clipboard from "expo-clipboard";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { FieldRow } from "@/components/forms/FieldRow";
import { TextEditModal } from "@/components/forms/TextEditModal";
import { PickerModal, PickerOption } from "@/components/forms/PickerModal";
import { Avatar } from "@/components/common/Avatar";
import { DefaultCalendarCover } from "@/components/calendar/DefaultCalendarCover";
import { useAppData } from "@/context/AppDataContext";
import { useAuth } from "@/context/AuthContext";
import {
  createInvite,
  fetchCalendarMembers,
  fetchInvites,
  fetchSharedCalendarMemberLimitStatus,
  leaveSharedCalendar,
  removeMember,
  revokeInvite,
  updateMemberRole,
} from "@/services/calendarService";
import {
  SharedMutationIdentity,
  buildIdentityRemountKey,
  isCurrentSharedMutationIdentity,
  runCurrentSharedMutation,
} from "@/auth/sharedMutationIdentity";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";
import {
  CalendarInvite,
  CalendarMembership,
  CalendarRole,
  SharedCalendarMemberLimitStatus,
} from "@/types/sharing";
import {
  CachedInviteCredential,
  classifyInviteScope,
  findActiveGenericViewerInvite,
  isCachedCredentialCurrentAgainstInviteSnapshot,
} from "@/utils/inviteAuthority";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { CALENDAR_COLOR_PALETTE } from "@/constants/options";
import { isBaseCalendar } from "@/constants/calendarLimits";

const PALETTE = CALENDAR_COLOR_PALETTE;
const ROLE_LABEL_KEY: Record<CalendarRole, TranslationKey> = {
  owner: "calendarRole.owner",
  editor: "calendarRole.editor",
  viewer: "calendarRole.viewer",
};

/**
 * メンバー・招待の詳細な管理は既存の members.tsx / invite.tsx への導線として維持し、
 * ここではそれぞれの既存サービス関数（updateMemberRole/removeMember/createInvite/revokeInvite等）
 * を直接呼び出す（ロジックの重複実装は行わない）。
 */
/**
 * REVISE対応（第10ラウンド、P1-1）: members・invites・viewerLinkToken等のローカルstateは
 * Aのメンバー名・招待リンクを含みうる機密性の高い表示情報のため、identityが変わった
 * 最初のコミットで一切公開しないよう、薄い外側wrapperでidentityKeyを作り実装本体を
 * key付きで再マウントする（members.tsxと同じパターン、詳細はそちらのコメント参照）。
 * ローカルカレンダーのみを扱っている最中にログアウトした場合も同様に再マウントされるが、
 * ローカルカレンダーのstate自体は認証ユーザーに紐づく機密情報ではないため実害はない。
 */
export default function CalendarSettingsScreen() {
  const { user, sessionInstanceId } = useAuth();
  const identityKey = buildIdentityRemountKey(user?.id, sessionInstanceId);
  return <CalendarSettingsScreenInner key={identityKey} />;
}

function CalendarSettingsScreenInner() {
  const router = useRouter();
  const { t } = useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    userCalendars,
    sharedCalendars,
    favoriteCalendarIds,
    toggleFavoriteCalendar,
    updateUserCalendar,
    removeUserCalendar,
    updateSharedCalendar,
    deleteSharedCalendar,
    refreshShared,
  } = useAppData();
  const { user, sessionInstanceId } = useAuth();

  // REVISE対応（第9ラウンド、P1-2）: 共有mutation系サービス関数へ渡すSharedMutationIdentityを
  // ここで一元的に組み立てる。認証セッション情報が確認できない場合は例外を投げ、呼び出し元の
  // try/catchがAlert表示にフォールバックする（既存のassertSessionReadyと同じ設計方針）。
  // REVISE対応（第10ラウンド、P1-1/P1-2）: userオブジェクト自体ではなくuser?.id（文字列）に
  // 依存させる。AuthContextはTOKEN_REFRESHED等でidentity値が変わらない場合でもsessionオブジェクト
  // （ひいてはuser参照）を再生成しうるため、user自体を依存配列に含めるとrequireIdentityの参照が
  // 不必要に変化し、これを依存配列に含むload系useCallback/useEffectが不要な再取得を繰り返して
  // しまう（P1-1テスト6「同一identityのTOKEN_REFRESHEDでは不必要にstateを初期化しない」に反する）。
  const userId = user?.id ?? null;
  const requireIdentity = useCallback((): SharedMutationIdentity => {
    if (!userId || !sessionInstanceId) {
      throw new Error("認証セッション情報を確認できないため、この操作を行えません");
    }
    return { userId, sessionInstanceId };
  }, [userId, sessionInstanceId]);

  const localCalendar = useMemo(
    () => userCalendars.find((c) => c.id === id),
    [userCalendars, id]
  );
  const sharedSummary = useMemo(
    () => sharedCalendars.find((s) => s.calendar.id === id),
    [sharedCalendars, id]
  );

  /**
   * P0015 Batch1.2、P1-2: shared branchのnavigation/favorite等、副作用の種類が
   * setState一つではない箇所（router.push・toggleFavoriteCalendar呼出し）向けの
   * 簡易ゲート。sharedSummaryが無い（ローカルカレンダー画面）場合は常にtrueを返す
   * （local分岐はauth identityに一切依存させない）。
   */
  const isSharedActionCurrent = useCallback((): boolean => {
    if (!sharedSummary) return true;
    if (!userId || !sessionInstanceId) return false;
    return isCurrentSharedMutationIdentity({ userId, sessionInstanceId });
  }, [sharedSummary, userId, sessionInstanceId]);

  const [invites, setInvites] = useState<CalendarInvite[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<CalendarMembership[]>([]);
  const [memberLimitStatus, setMemberLimitStatus] = useState<SharedCalendarMemberLimitStatus | null>(null);
  const [editingMember, setEditingMember] = useState<CalendarMembership | null>(null);
  /**
   * P0180 / CORRECT-F024-003-D: 生 token だけでなく **inviteId + scope に束縛した資格**を持つ。
   *
   * 旧 `viewerLinkToken: string | null` は、その token がどの招待行のものかを
   * 覚えていなかった。そのため server 側の現行権威が変わっても client のキャッシュは
   * 変わらず、別導線が再発行したあとでも古い token を配れてしまった。
   * **id が無ければ「まだ現行か」という問いすら立てられない。**
   *
   * 生 token は**永続化しない**（in-memory のみ。identity-key remount で消える）。
   *
   * **state ではなく ref で持つ。** 旧 `viewerLinkToken` も描画には一切使われておらず、
   * この資格は「外部化の直前に照合する対象」でしかない。ref にすることで、
   * これを読む `loadInvites`（useCallback）の依存配列を汚さずに常に最新値へ到達できる
   * （依存に入れると再取得ループを招く。P0014/P0015 が整えた load 系の安定性を壊さない）。
   */
  const viewerLinkCredentialRef = useRef<CachedInviteCredential | null>(null);
  const setViewerLinkCredential = useCallback((next: CachedInviteCredential | null) => {
    viewerLinkCredentialRef.current = next;
  }, []);
  const [viewerLinkBusy, setViewerLinkBusy] = useState(false);
  /**
   * P0176 / CORRECT-F024-002: viewer-link 操作族の**同期的**かつ**ハンドラ横断**の
   * single-flight 権威。
   *
   * `viewerLinkBusy` は React state であり、同一 commit/frame 内の 2 つのハンドラ起動は
   * どちらも `false` を観測しうる。さらに危険なのは、これが**単一のハンドラの再入**では
   * なく**ハンドラ横断の競合**である点である:
   *
   *   - toggle ON/OFF   … createInvite / revokeInvite
   *   - リンクをコピー   … resolveExternalizableViewerLink（権威照合 → 再利用 or 再発行）
   *   - 共有する         … 同上
   *
   * これらは**同一の generic viewer-link authority**を書き換える。ハンドラごとに
   * 別々の ref を持つと copy と share が互いに競合したままになるため、
   * **3 ハンドラで 1 つの ref を共有する**。
   */
  const viewerLinkOperationRef = useRef(false);

  const isOwner = sharedSummary?.role === "owner";
  const canEdit = !sharedSummary || isOwner;
  // 所有者本人が操作しているため、常に変更可。
  // ローカルカレンダーのfile://はこのHookの中でそのまま素通しされる（一切変化しない）。

  // REVISE対応（第10ラウンド、P1-2）: fetchInvites/fetchCalendarMembers/
  // fetchSharedCalendarMemberLimitStatusへSharedMutationIdentityを渡す。同一identityのまま
  // 複数回呼ばれた場合（各handleXxxがload系関数を連続で呼ぶ経路）に古い要求が新しい要求の
  // 結果を上書きしないよう、それぞれlatest-wins判定用のtokenを併用する。
  // P0015 Batch1.2、P1-2: identityを取得し、その時点でcurrentである場合だけ処理を開始する
  // （stale closureからの呼出しでloading表示・state更新だけ開始してしまうことを防ぐ）。
  // 完了時（setInvites/setLoadingInvites(false)）も同じidentityで再確認する。
  const loadInvitesTokenRef = useRef(0);
  const loadInvites = useCallback(async () => {
    if (!sharedSummary || !isOwner) return;
    let identity: SharedMutationIdentity;
    try {
      identity = requireIdentity();
    } catch {
      return;
    }
    if (!isCurrentSharedMutationIdentity(identity)) return;
    const token = ++loadInvitesTokenRef.current;
    setLoadingInvites(true);
    try {
      const result = await fetchInvites(sharedSummary.calendar.id, identity);
      if (loadInvitesTokenRef.current !== token) return;
      if (!isCurrentSharedMutationIdentity(identity)) return;
      setInvites(result);
      /**
       * P0180 / CORRECT-F024-003-D: **権威的に取得できたときだけ**、
       * stale と証明されたキャッシュ資格を捨てる。
       *
       * これは Copy/Share を待たずに UI の陳腐化を減らすための掃除であり、
       * 外部化直前の照合（resolveExternalizableViewerLink）を置き換えるものではない。
       *
       * **失敗時には絶対に消さない。** 下の catch には掃除を置いていない——
       * 「読めなかった」を「もう存在しない」と扱うのは、UNKNOWN を権威的な
       * 不在へ格上げする典型的な誤りである。
       */
      const cached = viewerLinkCredentialRef.current;
      if (cached) {
        const currency = isCachedCredentialCurrentAgainstInviteSnapshot(cached, result, Date.now());
        if (currency.status === "stale") setViewerLinkCredential(null);
      }
    } catch {
      // identity失効・通信失敗のいずれも、既存の一覧表示は変更しない。
      // **キャッシュ資格もここでは触らない**（UNKNOWN != 不在）。
    } finally {
      if (loadInvitesTokenRef.current === token && isCurrentSharedMutationIdentity(identity)) {
        setLoadingInvites(false);
      }
    }
  }, [sharedSummary, isOwner, requireIdentity, setViewerLinkCredential]);

  useEffect(() => {
    loadInvites();
  }, [loadInvites]);

  const loadMembersTokenRef = useRef(0);
  const loadMembers = useCallback(async () => {
    if (!sharedSummary) {
      setMembers([]);
      return;
    }
    let identity: SharedMutationIdentity;
    try {
      identity = requireIdentity();
    } catch {
      return;
    }
    if (!isCurrentSharedMutationIdentity(identity)) return;
    const token = ++loadMembersTokenRef.current;
    try {
      const result = await fetchCalendarMembers(sharedSummary.calendar.id, identity);
      if (loadMembersTokenRef.current !== token) return;
      if (!isCurrentSharedMutationIdentity(identity)) return;
      setMembers(result);
    } catch {
      // identity失効・通信失敗のいずれも、既存の一覧表示は変更しない。
    }
  }, [sharedSummary, requireIdentity]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  // FP-008(2026-08): 人数上限（無料5人/プレミアム20人、所有者を含む）の現在状態。
  // サーバー側RPCの値をそのまま表示するだけで、クライアント側では再計算しない。
  // 取得に失敗しても（未適用環境等）既存の表示（membersSummary）へ安全にフォールバックする。
  // P0015 Batch1.2、P1-2: loadInvites/loadMembersと同じくcurrent identityの場合だけ
  // 開始・完了する。
  const loadMemberLimitStatusTokenRef = useRef(0);
  const loadMemberLimitStatus = useCallback(async () => {
    if (!sharedSummary) {
      setMemberLimitStatus(null);
      return;
    }
    let identity: SharedMutationIdentity;
    try {
      identity = requireIdentity();
    } catch {
      return;
    }
    if (!isCurrentSharedMutationIdentity(identity)) return;
    const token = ++loadMemberLimitStatusTokenRef.current;
    try {
      const result = await fetchSharedCalendarMemberLimitStatus(sharedSummary.calendar.id, identity);
      if (loadMemberLimitStatusTokenRef.current !== token) return;
      if (!isCurrentSharedMutationIdentity(identity)) return;
      setMemberLimitStatus(result);
    } catch {
      if (loadMemberLimitStatusTokenRef.current === token && isCurrentSharedMutationIdentity(identity)) {
        setMemberLimitStatus(null);
      }
    }
  }, [sharedSummary, requireIdentity]);

  useEffect(() => {
    loadMemberLimitStatus();
  }, [loadMemberLimitStatus]);

  if (!localCalendar && !sharedSummary) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <ScreenHeader title={t("calendarSettings.title")} onBack={() => router.back()} />
        <View style={styles.notFound}>
          <Text style={styles.notFoundText}>{t("calendarDetail.notFoundText")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const calendarId = (sharedSummary?.calendar.id ?? localCalendar?.id) as string;
  const name = sharedSummary?.calendar.name ?? localCalendar?.name ?? "";
  const color = sharedSummary?.calendar.color ?? localCalendar?.color ?? colors.primary;
  const isFavorite = favoriteCalendarIds.includes(calendarId);

  // REVISE対応（P0014 Batch1.1、P1-3）: shared分岐は、開始時に固定したidentityが
  // catch/finally時点でもcurrentの場合だけ失敗Alert・busy state（saving）を更新する。
  // local分岐はidentityに一切依存しないため、identityがnullのまま従来どおり動作する。
  const handleRenameSubmit = async (value: string) => {
    if (saving) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === name) return;
    // P0015 Batch1.2、P1-2: shared分岐は、setSaving(true)という副作用より前にcurrent
    // identityを確認する。local分岐は従来どおりauth identityに依存しない。
    let identity: SharedMutationIdentity | null = null;
    if (sharedSummary) {
      try {
        identity = requireIdentity();
      } catch {
        return;
      }
      if (!isCurrentSharedMutationIdentity(identity)) return;
    }
    setSaving(true);
    try {
      if (sharedSummary) {
        await updateSharedCalendar(calendarId, { name: trimmed });
      } else if (localCalendar) {
        await updateUserCalendar({ ...localCalendar, name: trimmed });
      }
    } catch (e) {
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        Alert.alert(t("common.couldNotChange"), toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotChange"), t));
      }
    } finally {
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        setSaving(false);
      }
    }
  };

  const handleColorChange = async (nextColor: string) => {
    if (!canEdit || saving) return;
    // P0015 Batch1.2、P1-2: handleRenameSubmitと同じ理由でshared分岐だけ事前確認する。
    let identity: SharedMutationIdentity | null = null;
    if (sharedSummary) {
      try {
        identity = requireIdentity();
      } catch {
        return;
      }
      if (!isCurrentSharedMutationIdentity(identity)) return;
    }
    setSaving(true);
    try {
      if (sharedSummary) {
        await updateSharedCalendar(calendarId, { color: nextColor });
      } else if (localCalendar) {
        await updateUserCalendar({ ...localCalendar, color: nextColor });
      }
    } catch (e) {
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        Alert.alert(t("common.couldNotChange"), toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotChange"), t));
      }
    } finally {
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        setSaving(false);
      }
    }
  };

  // identity契約が入るまでは、この画面側の後続副作用だけを保護する）。ローカルカレンダー分岐は
  // auth identityに一切依存しないため変更しない。

  // まで含めて1つのidentity-scoped操作として扱う。

  // REVISE対応（第10ラウンド、P1-3）: updateMemberRole/removeMemberの呼出しと、その後の
  // 再取得（loadMembers/loadMemberLimitStatus）まで含めて1つのidentity-scoped操作として扱う。
  const handleChangeMemberRole = async (member: CalendarMembership, role: CalendarRole) => {
    let identity: SharedMutationIdentity | null = null;
    try {
      identity = requireIdentity();
      await runCurrentSharedMutation(identity, async (assertCurrent) => {
        await updateMemberRole(member.calendarId, member.userId, role, identity!);
        assertCurrent();
        await loadMembers();
      });
    } catch (e) {
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        Alert.alert(t("common.couldNotChange"), toFriendlyMessage(e instanceof Error ? e.message : undefined, t("calendarMembers.roleChangeFailedFallback"), t));
      }
    }
  };

  const handleRemoveMemberRow = (member: CalendarMembership) => {
    // P0015 Batch1.2、P1-2: 削除確認Alert自体もcurrent identityの場合だけ表示する。
    if (!isSharedActionCurrent()) return;
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
                await loadMembers();
                assertCurrent();
                await loadMemberLimitStatus();
              });
            } catch (e) {
              if (!identity || isCurrentSharedMutationIdentity(identity)) {
                Alert.alert(t("common.couldNotDelete"), toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotDelete"), t));
              }
            }
          },
        },
      ]
    );
  };

  /**
   * P0178 / CORRECT-F024-003: **generic viewer-link 権威だけ**を選ぶ。
   *
   * 旧実装は `role === "viewer" && !revokedAt && 未期限切れ` だけで判定しており、
   * **targeted（宛先付き）viewer 招待を generic リンクと誤分類**していた。その結果:
   *
   *   Alice 宛 targeted viewer 招待しか無いのに Switch が ON に見え、
   *   「リンクをコピー」すると Alice の招待を revoke して generic を作っていた。
   *
   * 判定は `findActiveGenericViewerInvite`（純関数）へ委譲する。redeemability の
   * 定義（未取消・未期限切れ。accepted は除外しない）は token 受諾の権威
   * migration 0020 G2 に一致させてある。
   */
  const activeGenericViewerInvite = findActiveGenericViewerInvite(invites, Date.now());

  // REVISE対応（第10ラウンド、P1-3）: viewerLinkTokenの更新（createInvite/revokeInviteと
  // その後のsetViewerLinkToken）・再取得まで含めて1つのidentity-scoped操作として扱う。
  const handleToggleViewerLink = async (next: boolean) => {
    if (viewerLinkBusy || !sharedSummary) return;
    // P0015 Batch1.2、P1-2: identityの固定・現在性確認を、setViewerLinkBusy(true)という
    // 副作用より前に行う。
    let identity: SharedMutationIdentity | null = null;
    try {
      identity = requireIdentity();
      if (!isCurrentSharedMutationIdentity(identity)) return;
    } catch {
      return;
    }
    // P0176 / CORRECT-F024-002: **ハンドラ横断**の同期的 single-flight claim。
    // `viewerLinkBusy`（React state）は同一フレームでは両方のハンドラに false と見える。
    // claim は `setViewerLinkBusy(true)` より**前**に取る（最初の state 変更より前）。
    if (viewerLinkOperationRef.current) return;
    viewerLinkOperationRef.current = true;
    setViewerLinkBusy(true);
    try {
      await runCurrentSharedMutation(identity, async (assertCurrent) => {
        if (next) {
          const created = await createInvite(sharedSummary.calendar.id, "viewer", identity!);
          assertCurrent();
          // P0180: token だけでなく inviteId + scope を束ねて保持する。
          setViewerLinkCredential({
            inviteId: created.invite.id,
            token: created.token,
            scope: classifyInviteScope(created.invite),
          });
        } else if (activeGenericViewerInvite) {
          // P0178: toggle OFF は「generic リンクを閉じる」という**明示的**操作なので
          // ここでの revoke は正当。ただし対象は generic 権威に限る——
          // targeted 招待は別の宛先への約束であり、この操作の射程外である。
          await revokeInvite(activeGenericViewerInvite.id, identity!);
          assertCurrent();
          setViewerLinkCredential(null);
        }
        await loadInvites();
        assertCurrent();
        await loadMemberLimitStatus();
      });
    } catch (e) {
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        Alert.alert(t("common.couldNotChange"), toFriendlyMessage(e instanceof Error ? e.message : undefined, t("calendarSettings.inviteToggleFailedFallback"), t));
      }
    } finally {
      // P0176: claim の解放は identity 条件を付けない（永久ロックアウト防止）。
      // setViewerLinkBusy の identity ガードは従来どおり維持する。
      viewerLinkOperationRef.current = false;
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        setViewerLinkBusy(false);
      }
    }
  };

  // REVISE対応（第10ラウンド、P1-3）: identity・assertCurrentを引数として受け取り、
  // 呼び出し元（handleCopyViewerLink/handleShareViewerLink）が開始したrunCurrentSharedMutation
  // 1回分の中で完結させる（ここで別途runCurrentSharedMutationを二重にかけない）。
  /**
   * P0180 / CORRECT-F024-003-D: **外部化してよいリンクを解決する。**
   *
   * 旧 `ensureViewerLink()` は「`viewerLinkToken` が非 null なら即返す」だった。
   * それは *client が過去に受け取った* という事実だけを根拠にしており、
   * **その資格がいま現行権威かどうかを一切問うていなかった**。
   * 別導線（招待画面）が同一スコープで再発行していれば、0027 が supersede した
   * 死んだ token をそのまま配ることになる。
   *
   * 現在の契約:
   *
   * ```text
   * 1. 権威スナップショットを取り直す（fetchInvites）
   *    → 取得できなければ **例外がそのまま伝播** する。
   *      呼び出し元の catch が既存の失敗 UI を出し、Clipboard/Share/成功表示には進まない。
   *      **ここで [] にフォールバックしてはならない**——UNKNOWN を「不在」と偽ることになる。
   * 2. ローカル一覧をそのスナップショットで整合させる
   * 3. キャッシュ資格が現行なら **その token を再利用**（不要な再発行をしない）
   * 4. 権威的に stale なら再発行。hash-only 保存のため他行の生 token は復元不能であり、
   *    Copy/Share の回復意味論を保つには新規発行しかない。
   *    **client 側の事前 revoke は行わない**（0027 が同一トランザクションで supersede する）。
   * ```
   *
   * 観測後に server 側で revoke / 再発行が起きる可能性までは排除しない。
   * それは通常の分散失効であり、本関数はその不可能性を主張しない。
   */
  const resolveExternalizableViewerLink = async (
    identity: SharedMutationIdentity,
    assertCurrent: () => void
  ): Promise<string | null> => {
    if (!sharedSummary) return null;

    // 1. 権威スナップショット。失敗は throw させる（fail-closed）。
    const snapshot = await fetchInvites(sharedSummary.calendar.id, identity);
    assertCurrent();
    setInvites(snapshot);

    // 2/3. キャッシュ資格の現行性を証明する。
    const cached = viewerLinkCredentialRef.current;
    if (cached) {
      const currency = isCachedCredentialCurrentAgainstInviteSnapshot(cached, snapshot, Date.now());
      if (currency.status === "current") {
        return Linking.createURL(`invite/${cached.token}`);
      }
      // 権威的に stale と分かったのでキャッシュを捨てる（この判断はスナップショットに基づく）。
      setViewerLinkCredential(null);
    }

    // 4. 再発行して、その資格を id 付きでキャッシュする。
    {
      // 生トークンは作成直後にしか取得できないため、手元に無ければ発行し直す。
      //
      // P0178 / CORRECT-F024-003: **ここで client 側 revoke は行わない。**
      //
      // 旧実装は「既存リンクがあれば失効させて発行し直す」として `activeViewerInvite`
      // を revoke していた。これは 2 つの点で誤りだった:
      //
      //   1. その `activeViewerInvite` は targeted 招待でもあり得た。
      //      「コピー」という**読み取りに見える操作**が、他人宛の招待を破棄していた。
      //   2. revoke と create が別 statement なので、両者の間で失敗すると
      //      「古いリンクは死に、新しいリンクは無い」状態が残る。
      //
      // migration 0027 の create_calendar_invite は、同一 GENERIC スコープ
      // （calendar_id, role, invitee_email is null）の redeemable な招待を
      // **同一トランザクション内で** supersede してから新規発行する。
      // よって「古い generic リンクを無効化する」責務はサーバ側に一本化されており、
      // client が先回りして revoke する必要はない。
      const created = await createInvite(sharedSummary.calendar.id, "viewer", identity);
      assertCurrent();
      setViewerLinkCredential({
        inviteId: created.invite.id,
        token: created.token,
        scope: classifyInviteScope(created.invite),
      });
      await loadInvites();
      assertCurrent();
      await loadMemberLimitStatus();
      assertCurrent();
      return Linking.createURL(`invite/${created.token}`);
    }
  };

  // REVISE対応（P0014 Batch1.1、P1-3）: Clipboard書込み待機中にidentityが切り替わった
  // 場合、success Alert（既存のassertCurrent配置で防止済み）だけでなく、catchの
  // failure Alert・finallyのbusy解除も表示・更新しない。
  const handleCopyViewerLink = async () => {
    if (viewerLinkBusy || !sharedSummary) return;
    // P0015 Batch1.2、P1-2: identityの固定・現在性確認を、setViewerLinkBusy(true)という
    // 副作用より前に行う。
    let identity: SharedMutationIdentity | null = null;
    try {
      identity = requireIdentity();
      if (!isCurrentSharedMutationIdentity(identity)) return;
    } catch {
      return;
    }
    // P0176 / CORRECT-F024-002: **ハンドラ横断**の同期的 single-flight claim。
    // `viewerLinkBusy`（React state）は同一フレームでは両方のハンドラに false と見える。
    // claim は `setViewerLinkBusy(true)` より**前**に取る（最初の state 変更より前）。
    if (viewerLinkOperationRef.current) return;
    viewerLinkOperationRef.current = true;
    setViewerLinkBusy(true);
    try {
      await runCurrentSharedMutation(identity, async (assertCurrent) => {
        const link = await resolveExternalizableViewerLink(identity!, assertCurrent);
        if (!link) return;
        assertCurrent();
        await Clipboard.setStringAsync(link);
        assertCurrent();
        Alert.alert(t("common.copied"), t("calendarInvite.copiedMessage"));
      });
    } catch (e) {
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        Alert.alert(t("calendarSettings.copyFailedTitle"), toFriendlyMessage(e instanceof Error ? e.message : undefined, t("calendarSettings.copyFailedTitle"), t));
      }
    } finally {
      // P0176: claim の解放は identity 条件を付けない（永久ロックアウト防止）。
      // setViewerLinkBusy の identity ガードは従来どおり維持する。
      viewerLinkOperationRef.current = false;
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        setViewerLinkBusy(false);
      }
    }
  };

  const handleShareViewerLink = async () => {
    if (viewerLinkBusy || !sharedSummary) return;
    // P0015 Batch1.2、P1-2: handleCopyViewerLinkと同じ理由で順序を変更する。
    let identity: SharedMutationIdentity | null = null;
    try {
      identity = requireIdentity();
      if (!isCurrentSharedMutationIdentity(identity)) return;
    } catch {
      return;
    }
    // P0176 / CORRECT-F024-002: **ハンドラ横断**の同期的 single-flight claim。
    // `viewerLinkBusy`（React state）は同一フレームでは両方のハンドラに false と見える。
    // claim は `setViewerLinkBusy(true)` より**前**に取る（最初の state 変更より前）。
    if (viewerLinkOperationRef.current) return;
    viewerLinkOperationRef.current = true;
    setViewerLinkBusy(true);
    try {
      await runCurrentSharedMutation(identity, async (assertCurrent) => {
        const link = await resolveExternalizableViewerLink(identity!, assertCurrent);
        if (!link) return;
        assertCurrent();
        await Share.share({
          message: t("calendarInvite.shareMessage", { link }),
        });
      });
    } catch (e) {
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        Alert.alert(t("calendarSettings.shareFailedTitle"), toFriendlyMessage(e instanceof Error ? e.message : undefined, t("calendarSettings.shareFailedTitle"), t));
      }
    } finally {
      // P0176: claim の解放は identity 条件を付けない（永久ロックアウト防止）。
      // setViewerLinkBusy の identity ガードは従来どおり維持する。
      viewerLinkOperationRef.current = false;
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        setViewerLinkBusy(false);
      }
    }
  };

  // REVISE対応（P0014 Batch1.1、P1-3）: shared分岐は、開始時に固定したidentityを
  // router.replace('/calendars')直前でも再確認する（deleteSharedCalendar自体は
  // P1-2でstale時にthrowするようになったため実際には到達しない防御線だが、画面側の
  // 契約を実装の詳細に依存させないための構造的ガードとして明示的に置く）。失敗Alertも
  // 同じidentityチェックで抑止する。local分岐は従来どおり。
  const handleDelete = () => {
    // P0015 Batch1.2、P1-2: shared分岐は、削除確認Alert自体もcurrent identityの場合だけ
    // 表示する。local分岐は従来どおり。
    if (sharedSummary && !isSharedActionCurrent()) return;
    const message = sharedSummary
      ? t("calendarSettings.deleteSharedMessage", { name, count: sharedSummary.memberCount })
      : t("calendarSettings.deleteLocalMessage", { name });
    Alert.alert(t("calendarSettings.deleteConfirmTitle"), message, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.deleteAction"),
        style: "destructive",
        onPress: async () => {
          const identity: SharedMutationIdentity | null =
            sharedSummary && userId && sessionInstanceId ? { userId, sessionInstanceId } : null;
          try {
            if (sharedSummary) {
              await deleteSharedCalendar(calendarId);
              if (identity && !isCurrentSharedMutationIdentity(identity)) return;
            } else {
              await removeUserCalendar(calendarId);
            }
            router.replace("/calendars");
          } catch (e) {
            if (!identity || isCurrentSharedMutationIdentity(identity)) {
              Alert.alert(t("common.couldNotDelete"), toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotDelete"), t));
            }
          }
        },
      },
    ]);
  };

  // REVISE対応（第10ラウンド、P1-3）: removeMember呼出しと、その後のrefreshShared・画面遷移
  // まで含めて1つのidentity-scoped操作として扱う。
  const handleLeave = () => {
    if (!user || !sharedSummary) return;
    // P0015 Batch1.2、P1-2: 退出確認Alert自体もcurrent identityの場合だけ表示する。
    if (!isSharedActionCurrent()) return;
    Alert.alert(
      t("calendarSettings.leaveConfirmTitle"),
      t("calendarSettings.leaveMessage", { name, count: sharedSummary.memberCount }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("calendarSettings.leaveButton"),
          style: "destructive",
          onPress: async () => {
            // navigation（router.replace）は既存どおりrunCurrentSharedMutationの
            // 操作内・最後のassertCurrent直後に置かれているためstale時には到達しない。
            // REVISE対応（P0014 Batch1.1、P1-3）: catchのfailure Alertもstale時は
            // 抑止する。
            let identity: SharedMutationIdentity | null = null;
            try {
              identity = requireIdentity();
              await runCurrentSharedMutation(identity, async (assertCurrent) => {
                // [P0164 §3 / CORRECT-F029-001] 自己退出は `calendar_members` への
                // 直接 DELETE ではなく、**型付き outcome を返す RPC** を使う。
                // members_delete_owner は USING 句のみのポリシーなので、直接 DELETE では
                // 「owner に降格されて消せなかった」場合も 0 行・エラー無しで返り、
                // 退出できていないのに「退出しました」と表示されてしまう。
                // RPC は left / not_member / owner_cannot_leave を明示的に返すため、
                // RLS の可視性から結果を推測する必要がそもそも無くなる（構造的解決）。
                await leaveSharedCalendar(calendarId, identity!);
                assertCurrent();
                // 参加中一覧から即座に消えるよう、退出後は必ず共有データを再取得する
                await refreshShared();
                assertCurrent();
                router.replace("/calendars");
              });
            } catch (e) {
              if (!identity || isCurrentSharedMutationIdentity(identity)) {
                Alert.alert(t("calendarSettings.leaveFailedTitle"), toFriendlyMessage(e instanceof Error ? e.message : undefined, t("calendarSettings.leaveFailedTitle"), t));
              }
            }
          },
        },
      ]
    );
  };

  const activeInviteCount = invites.filter(
    (i) => !i.revokedAt && !i.acceptedAt && !i.declinedAt && new Date(i.expiresAt) > new Date()
  ).length;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("calendarSettings.title")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.coverPreview}>
          <DefaultCalendarCover
            color={color}
            icon={sharedSummary ? "people-outline" : "person-outline"}
            iconSize={36}
            style={StyleSheet.absoluteFillObject}
          />
        </View>
        <Text style={styles.identityName} numberOfLines={1}>{name}</Text>
        <Text style={styles.identitySub}>
          {sharedSummary
            ? t("calendarDetail.subtitleShared", {
                role: t(ROLE_LABEL_KEY[sharedSummary.role]),
                count: sharedSummary.memberCount,
              })
            : t("calendarDetail.subtitleLocal")}
        </Text>

        <SectionCard>
          <FieldRow
            icon="pricetag-outline"
            label={t("calendarSettings.nameLabel")}
            value={name}
            onPress={canEdit ? () => setNameModalVisible(true) : undefined}
            showChevron={canEdit}
          />
          <View style={styles.paletteRow}>
            <Text style={styles.paletteLabel}>{t("calendarSettings.themeColorLabel")}</Text>
            <View style={styles.palette}>
              {PALETTE.map((c) => (
                <Pressable
                  key={c}
                  accessibilityLabel={t("calendarSettings.colorSwatchA11y", { color: c })}
                  disabled={!canEdit || saving}
                  onPress={() => handleColorChange(c)}
                  style={[
                    styles.colorChoice,
                    { backgroundColor: c },
                    color === c && styles.colorSelected,
                    (!canEdit || saving) && styles.colorDisabled,
                  ]}
                />
              ))}
            </View>
          </View>
          <FieldRow
            icon={isFavorite ? "star" : "star-outline"}
            label={t("calendars.filterFavorite")}
            value={isFavorite ? t("calendarSettings.favoriteAdded") : t("calendarSettings.favoriteNotAdded")}
            onPress={() => {
              // P0015 Batch1.2、P1-2: shared branchのお気に入り切替もcurrent identityの
              // 場合だけ行う。
              if (isSharedActionCurrent()) toggleFavoriteCalendar(calendarId);
            }}
          />
        </SectionCard>

        {!canEdit && sharedSummary && (
          <View style={styles.notice}>
            <Ionicons name="information-circle-outline" size={18} color={colors.textSecondary} />
            <Text style={styles.noticeText}>
              {sharedSummary.role === "editor"
                ? t("calendarSettings.roleNoticeOwnerEditor")
                : t("calendarDetail.roleNoticeViewer")}
            </Text>
          </View>
        )}

        {sharedSummary && (
          <>
            <SectionCard>
              <FieldRow
                icon="people-outline"
                label={t("calendarDetail.membersLabel")}
                value={
                  memberLimitStatus
                    ? memberLimitStatus.activeInviteCount > 0
                      ? t("calendarSettings.memberLimitStatusWithInvites", {
                          used: memberLimitStatus.usedSlotCount,
                          limit: memberLimitStatus.memberLimit,
                          invites: memberLimitStatus.activeInviteCount,
                        })
                      : t("calendarSettings.memberLimitStatus", {
                          used: memberLimitStatus.usedSlotCount,
                          limit: memberLimitStatus.memberLimit,
                        })
                    : t("calendarSettings.membersSummary", {
                        count: sharedSummary.memberCount,
                        role: t(ROLE_LABEL_KEY[sharedSummary.role]),
                      })
                }
                errorText={memberLimitStatus?.limitReached ? t("calendarSettings.memberLimitReachedNotice") : undefined}
                onPress={() => {
                  // P0015 Batch1.2、P1-2: メンバー画面への遷移もcurrent identityの場合
                  // だけ行う。
                  if (isSharedActionCurrent()) {
                    router.push({ pathname: "/calendar/[id]/members", params: { id: calendarId } });
                  }
                }}
              />
              {members.map((m) => (
                <View key={m.userId} style={styles.memberRow}>
                  <Avatar uri={m.avatarUrl} label={m.displayName ?? "?"} size={28} />
                  <View style={styles.memberRowText}>
                    <Text style={styles.memberName} numberOfLines={1}>
                      {m.displayName ?? t("calendarMembers.memberFallbackName")}
                      {m.userId === user?.id ? t("common.selfSuffix") : ""}
                    </Text>
                    <Text style={styles.memberRole}>{t(ROLE_LABEL_KEY[m.role])}</Text>
                  </View>
                  {isOwner && m.role !== "owner" && (
                    <View style={styles.memberActions}>
                      <Pressable
                        hitSlop={8}
                        style={styles.memberActionButton}
                        onPress={() => {
                          // P0015 Batch1.2、P1-2: 編集モーダルを開く操作もcurrent
                          // identityの場合だけ行う。
                          if (isSharedActionCurrent()) setEditingMember(m);
                        }}
                        accessibilityLabel={t("calendarMembers.editRoleA11y")}
                      >
                        <Ionicons name="create-outline" size={18} color={colors.primary} />
                      </Pressable>
                      <Pressable
                        hitSlop={8}
                        style={styles.memberActionButton}
                        onPress={() => handleRemoveMemberRow(m)}
                        accessibilityLabel={t("common.delete")}
                      >
                        <Ionicons name="trash-outline" size={18} color={colors.warning} />
                      </Pressable>
                    </View>
                  )}
                </View>
              ))}
            </SectionCard>

            {isOwner && (
              <SectionCard>
                <View style={styles.inviteToggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inviteToggleLabel}>{t("calendarSettings.inviteToggleLabel")}</Text>
                    <Text style={styles.inviteToggleSub}>
                      {t("calendarSettings.inviteToggleHelper")}
                    </Text>
                  </View>
                  <Switch
                    value={!!activeGenericViewerInvite}
                    onValueChange={handleToggleViewerLink}
                    disabled={viewerLinkBusy || loadingInvites}
                    accessibilityLabel={t("calendarSettings.inviteToggleLabel")}
                    accessibilityHint={t("calendarSettings.inviteToggleHelper")}
                  />
                </View>
                <View style={styles.linkActionsRow}>
                  <Pressable
                    style={[styles.copyLinkButton, styles.linkActionButton, (!activeGenericViewerInvite || viewerLinkBusy) && styles.copyLinkButtonDisabled]}
                    onPress={handleShareViewerLink}
                    disabled={!activeGenericViewerInvite || viewerLinkBusy}
                  >
                    <Ionicons name="share-outline" size={16} color={colors.primary} />
                    <Text style={styles.copyLinkText}>{t("calendarSettings.shareButton")}</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.copyLinkButton, styles.linkActionButton, (!activeGenericViewerInvite || viewerLinkBusy) && styles.copyLinkButtonDisabled]}
                    onPress={handleCopyViewerLink}
                    disabled={!activeGenericViewerInvite || viewerLinkBusy}
                  >
                    <Ionicons name="link-outline" size={16} color={colors.primary} />
                    <Text style={styles.copyLinkText}>{t("calendarSettings.copyLinkButton")}</Text>
                  </Pressable>
                </View>
                <FieldRow
                  icon="paper-plane-outline"
                  label={t("calendarSettings.inviteManagementLabel")}
                  value={loadingInvites ? t("calendarSettings.checkingStatus") : t("calendarSettings.activeInvitesCount", { count: activeInviteCount })}
                  onPress={() => {
                    // P0015 Batch1.2、P1-2: 招待画面への遷移もcurrent identityの場合
                    // だけ行う。
                    if (isSharedActionCurrent()) {
                      router.push({ pathname: "/calendar/[id]/invite", params: { id: calendarId } });
                    }
                  }}
                />
              </SectionCard>
            )}

            <SectionCard>
              {isOwner ? (
                <FieldRow
                  icon="trash-outline"
                  label={t("calendarSettings.deleteConfirmTitle")}
                  danger
                  showChevron={false}
                  onPress={handleDelete}
                />
              ) : (
                <FieldRow
                  icon="exit-outline"
                  label={t("calendarSettings.leaveConfirmTitle")}
                  danger
                  showChevron={false}
                  onPress={handleLeave}
                />
              )}
            </SectionCard>
          </>
        )}

        {!sharedSummary && !isBaseCalendar(calendarId) && (
          <SectionCard>
            <FieldRow
              icon="trash-outline"
              label={t("calendarSettings.deleteConfirmTitle")}
              danger
              showChevron={false}
              onPress={handleDelete}
            />
          </SectionCard>
        )}
      </ScrollView>

      <TextEditModal
        visible={nameModalVisible}
        title={t("calendarSettings.nameLabel")}
        initialValue={name}
        placeholder={t("calendarSettings.nameLabel")}
        onClose={() => setNameModalVisible(false)}
        onSubmit={handleRenameSubmit}
      />

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
          // REVISE対応（P0014 Batch1.1、P1-3）: モーダルを閉じるstate更新は、開始時に
          // 固定したidentityがcurrentの場合だけ行う（stale時はモーダルを開いたままにし、
          // 実際の後始末は再マウントに委ねる）。
          const identity: SharedMutationIdentity | null =
            userId && sessionInstanceId ? { userId, sessionInstanceId } : null;
          await handleChangeMemberRole(editingMember, ids[0] as CalendarRole);
          if (!identity || isCurrentSharedMutationIdentity(identity)) {
            setEditingMember(null);
          }
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },
  coverPreview: {
    height: 120,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: 16,
    overflow: "hidden",
  },
  identityName: { fontSize: 18, fontWeight: "700", color: colors.textPrimary, marginTop: spacing.md, marginHorizontal: spacing.lg },
  identitySub: { fontSize: 12, color: colors.textTertiary, marginTop: 2, marginHorizontal: spacing.lg, marginBottom: spacing.sm },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  memberRowText: { flex: 1 },
  memberName: { fontSize: 14, fontWeight: "700", color: colors.textPrimary },
  memberRole: { fontSize: 11, color: colors.textTertiary, marginTop: 1 },
  memberActions: { flexDirection: "row", gap: spacing.xs },
  memberActionButton: { padding: spacing.xs },
  inviteToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  inviteToggleLabel: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  inviteToggleSub: { fontSize: 11, color: colors.textTertiary, marginTop: 2 },
  linkActionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  linkActionButton: { flex: 1 },
  copyLinkButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  copyLinkButtonDisabled: { opacity: 0.4 },
  copyLinkText: { fontSize: 13, fontWeight: "700", color: colors.primary },
  paletteRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  paletteLabel: { fontSize: 16, color: colors.textPrimary, marginBottom: spacing.sm },
  palette: { flexDirection: "row", gap: 10 },
  colorChoice: { width: 28, height: 28, borderRadius: 14 },
  colorSelected: { borderWidth: 3, borderColor: colors.textPrimary },
  colorDisabled: { opacity: 0.4 },
  notice: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  noticeText: { flex: 1, fontSize: 12, color: colors.textSecondary },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { color: colors.textSecondary, fontSize: 15 },
});
