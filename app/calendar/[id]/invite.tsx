import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import * as Clipboard from "expo-clipboard";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { LoadingView } from "@/components/common/LoadingView";
import { useAppData } from "@/context/AppDataContext";
import { useAuth } from "@/context/AuthContext";
import {
  createInvite,
  fetchInvites,
  fetchSharedCalendarMemberLimitStatus,
  revokeInvite,
} from "@/services/calendarService";
import {
  SharedMutationIdentity,
  buildIdentityRemountKey,
  isCurrentSharedMutationIdentity,
  runCurrentSharedMutation,
} from "@/auth/sharedMutationIdentity";
import { CalendarInvite, CalendarRole, SharedCalendarMemberLimitStatus } from "@/types/sharing";
import {
  CachedInviteCredential,
  classifyInviteScope,
  isCachedCredentialCurrentAgainstInviteSnapshot,
} from "@/utils/inviteAuthority";
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

function formatExpiryDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * REVISE対応（第10ラウンド、P1-1）: invites・lastLink（生招待リンク）・inviteeEmailは
 * 機密性の高いローカルstateのため、identityが変わった最初のコミットで一切公開しない
 * よう、薄い外側wrapperでidentityKeyを作り実装本体をkey付きで再マウントする
 * （members.tsxと同じパターン、詳細はそちらのコメント参照）。
 */
export default function CalendarInviteScreen() {
  const { user, sessionInstanceId } = useAuth();
  const identityKey = buildIdentityRemountKey(user?.id, sessionInstanceId);
  return <CalendarInviteScreenInner key={identityKey} />;
}

function CalendarInviteScreenInner() {
  const router = useRouter();
  const { t } = useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { sharedCalendars } = useAppData();
  const { user, sessionInstanceId } = useAuth();
  const [invites, setInvites] = useState<CalendarInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  /**
   * P0176 / CORRECT-F024-002: 招待発行の**同期的** single-flight 権威。
   *
   * `creating`（React state）は再レンダリングを経て初めて `disabled` に反映されるため、
   * 同一フレームの二重起動を止められない。ref は同期的に読み書きできるので、
   * 同じ commit の中で 2 回目の起動を確実に弾ける。
   */
  const issuingInviteRef = useRef(false);
  /**
   * P0180 / CORRECT-F024-003-D: 「前回のリンク」を **inviteId + scope に束縛**して持つ。
   *
   * 旧 `lastLink: string | null` は URL だけで、どの招待行のものか覚えていなかった。
   * そのため server 側の現行権威が変わっても client のキャッシュは変わらず、
   * 別導線（設定画面）が同一スコープで再発行したあとでも古いリンクを配れた。
   * 生 token は永続化しない（in-memory のみ。identity-key remount で消える）。
   */
  const [lastCredential, setLastCredential] = useState<CachedInviteCredential | null>(null);
  /**
   * 「前回のリンクをコピー」ボタンの表示条件は従来どおり資格の有無で決まる。
   * 実際に外部化してよいかは **ハンドラ内の権威照合**が決めるのであって、
   * この表示用の値ではない。
   */
  const lastLink = lastCredential ? Linking.createURL(`invite/${lastCredential.token}`) : null;
  const [inviteeEmail, setInviteeEmail] = useState("");
  const [memberLimitStatus, setMemberLimitStatus] = useState<SharedCalendarMemberLimitStatus | null>(null);

  const summary = useMemo(
    () => sharedCalendars.find((s) => s.calendar.id === id),
    [sharedCalendars, id]
  );
  // 招待の作成・失効はowner限定（RLS/RPC側でも既に強制されているため、これは案内表示のための補助）
  const isOwner = summary?.role === "owner";

  // REVISE対応（第9ラウンド、P1-2）: createInvite/revokeInviteへ渡すSharedMutationIdentityを
  // ここで一元的に組み立てる。
  // REVISE対応（第10ラウンド、P1-1/P1-2）: userオブジェクト自体ではなくuser?.id（文字列）に
  // 依存させる。AuthContextはTOKEN_REFRESHED等でidentity値が変わらない場合でもsessionオブジェクト
  // （ひいてはuser参照）を再生成しうるため、user自体を依存配列に含めるとrequireIdentityの参照が
  // 不必要に変化し、これを依存配列に含むload/loadMemberLimitStatus用useCallback/useEffectが
  // 不要な再取得を繰り返してしまう（P1-1テスト6「同一identityのTOKEN_REFRESHEDでは不必要に
  // stateを初期化しない」に反する）。
  const userId = user?.id ?? null;
  const requireIdentity = useCallback((): SharedMutationIdentity => {
    if (!userId || !sessionInstanceId) {
      throw new Error("認証セッション情報を確認できないため、この操作を行えません");
    }
    return { userId, sessionInstanceId };
  }, [userId, sessionInstanceId]);

  // REVISE対応（第10ラウンド、P1-2）: fetchInvites/fetchSharedCalendarMemberLimitStatusへ
  // SharedMutationIdentityを渡す（remote呼出し完了後にも呼び出し元自身が独立に検証する）。
  // 加えて、同一identityのまま複数回呼ばれた場合（handleCreate等がload()を連続で呼ぶ経路）に
  // 古い要求が新しい要求の結果を上書きしないよう、要求ごとに単調増加するtokenで
  // 「最後に発行した要求の結果だけを反映する」latest-wins判定を行う。
  // P0015 Batch1.2、P1-3: identityを取得し、その時点でcurrentである場合だけ
  // setLoading(true)から始める（stale closureからの呼出しでloading表示だけ開始して
  // しまうことを防ぐ）。完了時（setInvites/setLoading(false)）も同じidentityで再確認する。
  const loadTokenRef = useRef(0);
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
      const result = await fetchInvites(id, identity);
      if (loadTokenRef.current !== token) return; // 新しい要求に追い越された
      if (!isCurrentSharedMutationIdentity(identity)) return;
      setInvites(result);
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

  // FP-008(2026-08): 人数上限（無料5人/プレミアム20人、所有者を含む）の現在状態。
  // 取得に失敗しても（未適用環境等）表示を省略するだけで、招待作成自体はサーバー側が
  // 引き続き正しく判定・拒否する（このstateは表示専用で、送信可否の最終判定には使わない）。
  // P0015 Batch1.2、P1-3: loadと同じくcurrent identityの場合だけ開始・完了する。
  const memberLimitTokenRef = useRef(0);
  const loadMemberLimitStatus = useCallback(async () => {
    if (!id) return;
    let identity: SharedMutationIdentity;
    try {
      identity = requireIdentity();
    } catch {
      return;
    }
    if (!isCurrentSharedMutationIdentity(identity)) return;
    const token = ++memberLimitTokenRef.current;
    try {
      const result = await fetchSharedCalendarMemberLimitStatus(id, identity);
      if (memberLimitTokenRef.current !== token) return;
      if (!isCurrentSharedMutationIdentity(identity)) return;
      setMemberLimitStatus(result);
    } catch {
      if (memberLimitTokenRef.current === token && isCurrentSharedMutationIdentity(identity)) {
        setMemberLimitStatus(null);
      }
    }
  }, [id, requireIdentity]);

  useEffect(() => {
    loadMemberLimitStatus();
  }, [loadMemberLimitStatus]);

  // REVISE対応（第10ラウンド、P1-3）: サービス呼出しだけでなく、そのあとのtoken保存
  // （setLastLink）・Clipboard/Share・再取得（load/loadMemberLimitStatus）まで含めた
  // ハンドラー全体を1つのidentity-scoped操作としてrunCurrentSharedMutationで囲む。
  // identityはハンドラー開始時に一度だけ固定し、各awaitの直後・次の副作用の前で
  // assertCurrentを呼ぶ。途中でBへ切り替わった場合、生token（lastLink）はstateへ
  // 一切書き込まれず、Clipboard/Shareにも進まない。
  // REVISE対応（P0014 Batch1.1、P1-3）: 失敗Alert・creatingのbusy解除のいずれも、
  // 開始時に固定したidentityがcurrentの場合だけ行う。stale時は「lastLinkをstateへ
  // 書き込まない」既存のassertCurrent配置に加え、失敗Alertも表示せず、creating状態も
  // 更新しない（この画面はidentity-key remount対象のため、実際の後始末は再マウントに
  // 委ねる）。
  const handleCreate = async (role: Extract<CalendarRole, "editor" | "viewer">) => {
    if (!id) return;
    // P0015 Batch1.2、P1-3: identityの固定・現在性確認を、setCreating(true)という
    // user-visibleな副作用より前に行う。
    let identity: SharedMutationIdentity | null = null;
    try {
      identity = requireIdentity();
      if (!isCurrentSharedMutationIdentity(identity)) return;
    } catch {
      return;
    }
    // P0176 / CORRECT-F024-002: 同期的な single-flight claim。
    //
    // `creating` は React state であり **同期的なプロセスロックではない**。
    // 同一 commit/frame 内の 2 回の押下はどちらも `creating === false` を観測しうるため、
    // `disabled={creating}`（PrimaryButton）だけでは二重起動を止められない。
    // その結果 server で 2 件の発行が走り、後発が先発を supersede し（migration 0026 の
    // 設計どおり）、応答が逆順で届くと **supersede 済みの死んだ token が
    // lastLink / Clipboard / Share に採用されうる**。
    //
    // ここでの claim は identity 確定の直後・**最初の React state 変更より前**に置く。
    // 併せて、この claim は client 側の防御であり、**server 側 migration 0026 の正しさは
    // これに依存しない**（0026 は単独で supersede + 直列化を保証する）。
    if (issuingInviteRef.current) return;
    issuingInviteRef.current = true;
    setCreating(true);
    try {
      const trimmedEmail = inviteeEmail.trim();
      await runCurrentSharedMutation(identity, async (assertCurrent) => {
        const created = await createInvite(
          id,
          role,
          identity!,
          trimmedEmail ? { inviteeEmail: trimmedEmail } : undefined
        );
        assertCurrent();
        const link = Linking.createURL(`invite/${created.token}`);
        // P0180: token だけでなく inviteId + scope を束ねて保持する。
        setLastCredential({
          inviteId: created.invite.id,
          token: created.token,
          scope: classifyInviteScope(created.invite),
        });
        setInviteeEmail("");
        await load();
        assertCurrent();
        await loadMemberLimitStatus();
        assertCurrent();
        // [P0120 Group D / D6 ROBUST-POSTPRIMARY-001-C08-a] createInviteは既にdurableに
        // 確定しており（tokenはstateへ保存済み・画面のコピー導線も表示済み）、Share.shareは
        // その後の二次的な提示ステップである。共有シートの失敗を
        // 「招待リンクを発行できませんでした」として提示すると、実際には発行済みなのに
        // 失敗と伝えることになり、ユーザーの再試行がtokenを増殖させる。
        // 真実に沿った提示のため、既存の承認済み文言 calendarSettings.shareFailedTitle
        // （settings.tsx#handleShareViewerLink が同一意図に対して既に使用している
        // 「共有できませんでした」/「Couldn't share it」）をそのまま使う。
        // **新規の文言・翻訳キー・UIフローは追加しない。**
        try {
          await Share.share({
            message: t("calendarInvite.shareMessage", { link }),
          });
        } catch (shareError) {
          if (isCurrentSharedMutationIdentity(identity!)) {
            Alert.alert(
              t("calendarSettings.shareFailedTitle"),
              toFriendlyMessage(
                shareError instanceof Error ? shareError.message : undefined,
                t("calendarSettings.shareFailedTitle"),
                t
              )
            );
          }
        }
      });
    } catch (e) {
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        Alert.alert(
          t("calendarInvite.createFailedTitle"),
          toFriendlyMessage(e instanceof Error ? e.message : undefined, t("calendarInvite.createFailedFallback"), t)
        );
      }
    } finally {
      // P0176: claim の解放は **identity 条件を付けない**。
      // stale 時に解放しないと、この画面が（identity-key remount されずに）残った場合に
      // 恒久ロックアウトになる。single-flight は「同時実行の抑止」であって
      // 「以後の意図的な操作の禁止」ではない。setCreating の identity ガードは従来どおり。
      issuingInviteRef.current = false;
      if (!identity || isCurrentSharedMutationIdentity(identity)) {
        setCreating(false);
      }
    }
  };

  /**
   * REVISE対応（第11ラウンド、P1-3）: identity-key再マウントはReactの次のコミットで
   * 初めてローカルstateを消すため、authSessionIdentityStoreがBへ変わった直後・
   * この画面がまだAの古いクロージャのままの短い窓では、Aの生招待リンクをコピーできて
   * しまう余地があった。handleCreate/handleRevokeと同じくrunCurrentSharedMutationで
   * 開始時点のidentityを固定し、Clipboard書込み完了後・完了Alert表示前にも
   * assertCurrentで再確認する。
   */
  const handleCopyLastLink = async () => {
    const credential = lastCredential;
    if (!credential) return;
    /**
     * P0178 / CORRECT-F024-003: `lastLink` は **CLIENT_VISIBLE_CURRENT_CREDENTIAL** であって
     * REDEEMABLE_TOKEN_AUTHORITY ではない。発行が in-flight の間、サーバ側では既に
     * `create_calendar_invite` が commit を終えて `lastLink` を supersede している可能性がある
     * （応答が返る前に他デバイス/他画面がそのリンクで参加を試みる窓）。
     *
     * その窓でこれをコピーすると、owner は**もう使えないリンク**を成功 Alert 付きで
     * 配ってしまう。よって発行 in-flight 中は「まだ答えを持っていない」として何もしない。
     *
     * ボタン側の `disabled` だけでは不十分である——ハンドラ参照は発行開始より前の
     * render で既に取得されていることがあり、押下は disabled を経由せずここへ到達しうる。
     * したがって**同期的**な ref をハンドラの中でも読む（描画は UX、ここが権威）。
     */
    if (issuingInviteRef.current) return;
    try {
      const identity = requireIdentity();
      await runCurrentSharedMutation(identity, async (assertCurrent) => {
        /**
         * P0180 / CORRECT-F024-003-D: **外部化の直前に権威スナップショットで現行性を証明する。**
         *
         * P0176 の同期 ref（上）は「この画面がいま発行中でないこと」しか保証しない。
         * 別導線（設定画面）が同一スコープで再発行していれば、この画面の資格は
         * 発行中でなくても既に supersede 済みである。**それは id で照合しない限り分からない。**
         *
         * 取得に失敗した場合はここから例外が伝播し、外側の catch が
         * 「静かに何もしない」既存の失敗挙動へ落ちる。Clipboard も成功 Alert も出ない。
         * **[] へフォールバックしない**——UNKNOWN を「不在」と偽ってはならない。
         */
        const snapshot = await fetchInvites(id!, identity);
        assertCurrent();
        setInvites(snapshot);
        const currency = isCachedCredentialCurrentAgainstInviteSnapshot(
          credential,
          snapshot,
          Date.now()
        );
        if (currency.status === "stale") {
          // 権威的に stale と証明できた場合だけキャッシュを捨てる。
          // ここは identity 確認済みの文脈である（assertCurrent 済み）。
          setLastCredential(null);
          await loadMemberLimitStatus();
          return;
        }
        await Clipboard.setStringAsync(
          Linking.createURL(`invite/${credential.token}`)
        );
        assertCurrent();
        Alert.alert(t("common.copied"), t("calendarInvite.copiedMessage"));
      });
    } catch {
      // identity失効・権威取得失敗のいずれも、静かに何もしない。
      // （Aの生招待リンクをBのクリップボードへコピーしない・完了Alertも表示しない・
      //   読めなかっただけのキャッシュを「消えた」と扱って削除もしない。）
    }
  };

  // REVISE対応（第10ラウンド、P1-3）: 失効後の再取得（load/loadMemberLimitStatus）まで
  // 含めて1つのidentity-scoped操作として扱う。また、以前はここにtry/catchが無く
  // （revokeInviteが投げた場合に未捕捉rejectionとなり得た）、identityガードの追加と
  // あわせて修正する。
  const handleRevoke = (invite: CalendarInvite) => {
    // P0015 Batch1.2、P1-3: 失効確認Alert自体も、開いた時点でcurrent identityの場合だけ
    // 表示する。
    try {
      if (!isCurrentSharedMutationIdentity(requireIdentity())) return;
    } catch {
      return;
    }
    Alert.alert(t("calendarInvite.revokeConfirmTitle"), t("calendarInvite.revokeConfirmMessage"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("calendarInvite.revokeButton"),
        style: "destructive",
        onPress: async () => {
          let identity: SharedMutationIdentity | null = null;
          try {
            identity = requireIdentity();
            await runCurrentSharedMutation(identity, async (assertCurrent) => {
              await revokeInvite(invite.id, identity!);
              assertCurrent();
              await load();
              assertCurrent();
              await loadMemberLimitStatus();
            });
          } catch (e) {
            if (!identity || isCurrentSharedMutationIdentity(identity)) {
              Alert.alert(
                t("common.couldNotChange"),
                toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotChange"), t)
              );
            }
          }
        },
      },
    ]);
  };

  if (loading) return <LoadingView />;

  // REVISE対応（第10ラウンド、P1-1）: 以前は`summary && !isOwner`のみで判定していたため、
  // summaryがまだ解決できていない（未取得・対象カレンダーがsharedCalendarsに存在しない）
  // 場合はowner確認自体ができていないにもかかわらず、通常の招待作成UI（既存招待一覧・
  // 招待作成ボタン）へフォールスルーしてしまっていた。所有者であると確認できた場合
  // （`summary && isOwner`）のみ以降のUIを表示し、それ以外はfail-closedで
  // オーナー専用の案内へ倒す。
  if (!summary || !isOwner) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <ScreenHeader title={t("calendarInvite.title")} onBack={() => router.back()} />
        <View style={styles.empty}>
          <Ionicons name="lock-closed-outline" size={32} color={colors.textTertiary} />
          <Text style={styles.emptyText}>{t("calendarInvite.ownerOnlyNotice")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("calendarInvite.title")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <SectionCard>
          <View style={styles.createRow}>
            <Text style={styles.createTitle}>{t("calendarInvite.createSectionTitle")}</Text>
            <Text style={styles.createSub}>{t("calendarInvite.createHelper")}</Text>
            {memberLimitStatus && (
              <Text style={styles.memberLimitStatusText}>
                {memberLimitStatus.activeInviteCount > 0
                  ? t("calendarSettings.memberLimitStatusWithInvites", {
                      used: memberLimitStatus.usedSlotCount,
                      limit: memberLimitStatus.memberLimit,
                      invites: memberLimitStatus.activeInviteCount,
                    })
                  : t("calendarSettings.memberLimitStatus", {
                      used: memberLimitStatus.usedSlotCount,
                      limit: memberLimitStatus.memberLimit,
                    })}
              </Text>
            )}
            {memberLimitStatus?.limitReached && (
              <Text style={styles.memberLimitReachedText}>
                {t("calendarSettings.memberLimitReachedNotice")}
              </Text>
            )}
            <Text style={styles.inviteeEmailLabel}>{t("calendarInvite.inviteeEmailLabel")}</Text>
            <TextInput
              style={styles.inviteeEmailInput}
              value={inviteeEmail}
              onChangeText={setInviteeEmail}
              placeholder="example@email.com"
              placeholderTextColor={colors.placeholder}
              accessibilityLabel={t("calendarInvite.inviteeEmailLabel")}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
            <Text style={styles.inviteeEmailHelper}>{t("calendarInvite.inviteeEmailHelper")}</Text>
            <View style={styles.createButtons}>
              <PrimaryButton
                label={t("calendarInvite.inviteAsEditorButton")}
                onPress={() => handleCreate("editor")}
                loading={creating}
                disabled={memberLimitStatus?.limitReached}
                style={styles.createButton}
              />
              <PrimaryButton
                label={t("calendarInvite.inviteAsViewerButton")}
                variant="secondary"
                onPress={() => handleCreate("viewer")}
                loading={creating}
                disabled={memberLimitStatus?.limitReached}
                style={styles.createButton}
              />
              {lastLink && (
                <PrimaryButton
                  label={t("calendarInvite.copyLastLinkButton")}
                  variant="ghost"
                  onPress={handleCopyLastLink}
                  // P0178: 発行中は「今どのリンクが生きているか」が確定していない。
                  // 権威は handleCopyLastLink 内の同期 ref 側にあり、これはその UX 表現。
                  disabled={creating}
                  style={styles.createButton}
                />
              )}
            </View>
          </View>
        </SectionCard>

        {invites.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="link-outline" size={32} color={colors.textTertiary} />
            <Text style={styles.emptyText}>{t("calendarInvite.emptyText")}</Text>
          </View>
        ) : (
          invites.map((invite) => {
            const revoked = !!invite.revokedAt;
            const accepted = !!invite.acceptedAt;
            const declined = !!invite.declinedAt;
            const expired = new Date(invite.expiresAt) < new Date();
            const isTerminal = revoked || accepted || declined || expired;
            return (
              <View key={invite.id} style={styles.inviteRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inviteRole}>
                    {t("calendarInvite.inviteRoleText", { role: t(ROLE_LABEL_KEY[invite.role]) })}
                  </Text>
                  <Text style={styles.inviteSub}>
                    {revoked
                      ? t("calendarInvite.revokedStatus")
                      : accepted
                        ? t("calendarInvite.acceptedStatus")
                        : declined
                          ? t("calendarInvite.declinedStatus")
                          : expired
                            ? t("calendarInvite.expiredStatus")
                            : t("calendarInvite.expiryText", { date: formatExpiryDate(invite.expiresAt) })}
                  </Text>
                </View>
                {!isTerminal && (
                  <PrimaryButton
                    label={t("calendarInvite.revokeButton")}
                    variant="danger"
                    onPress={() => handleRevoke(invite)}
                    style={styles.revokeButton}
                  />
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },
  createRow: { padding: spacing.lg },
  createTitle: { fontSize: 16, fontWeight: "700", color: colors.textPrimary },
  createSub: { fontSize: 12, color: colors.textTertiary, marginTop: 4, marginBottom: spacing.md },
  memberLimitStatusText: { fontSize: 12, color: colors.textSecondary, marginBottom: spacing.xs },
  memberLimitReachedText: {
    fontSize: 12,
    color: colors.warning,
    marginBottom: spacing.md,
  },
  inviteeEmailLabel: { fontSize: 13, fontWeight: "700", color: colors.textPrimary, marginBottom: spacing.xs },
  inviteeEmailInput: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  inviteeEmailHelper: {
    fontSize: 11,
    color: colors.textTertiary,
    marginTop: 4,
    marginBottom: spacing.md,
  },
  createButtons: { gap: spacing.sm },
  createButton: { marginTop: 0 },
  empty: { alignItems: "center", padding: spacing.xl, gap: spacing.sm },
  emptyText: { color: colors.textTertiary, fontSize: 13 },
  inviteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 64,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  inviteRole: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  inviteSub: { fontSize: 12, color: colors.textTertiary, marginTop: 2 },
  revokeButton: { minHeight: 36, paddingHorizontal: spacing.md },
});
