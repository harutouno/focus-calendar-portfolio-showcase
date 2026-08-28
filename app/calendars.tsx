import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { PageLayout } from "@/components/common/PageLayout";
import { SectionCard } from "@/components/common/SectionCard";
import { EmptyState } from "@/components/common/EmptyState";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { CalendarTabKey, CalendarTabs } from "@/components/calendar/CalendarTabs";
import { CalendarCard } from "@/components/calendar/CalendarCard";
import { BaseCalendarCard } from "@/components/calendar/BaseCalendarCard";
import { MyCalendarRow } from "@/components/calendar/MyCalendarRow";
import { CalendarActionSheet } from "@/components/calendar/CalendarActionSheet";
import { SharedCalendarRow } from "@/components/calendar/SharedCalendarRow";
import { SharedCalendarActionSheet } from "@/components/calendar/SharedCalendarActionSheet";
import { EventDisplayModeSwitch } from "@/components/calendar/EventDisplayModeSwitch";
import { InvitationCard } from "@/components/calendar/InvitationCard";
import { useAppData } from "@/context/AppDataContext";
import { useAuth } from "@/context/AuthContext";
import { generateId } from "@/utils/id";
import { NewCalendarModal } from "@/components/forms/NewCalendarModal";
import { classifySharedCalendars, filterSharedCalendarsByQuery } from "@/utils/calendarListRows";
import { eventDisplayModeFromOverlay } from "@/utils/eventDisplayMode";
import {
  SHARED_CALENDAR_LIMIT,
  countOwnedSharedCalendars,
  getMyCalendarLimit,
  isBaseCalendar,
  remainingMyCalendars,
  totalMyCalendars,
} from "@/constants/calendarLimits";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { JoinedCalendarSummary } from "@/types/sharing";
import { TranslationKey } from "@/i18n/translations";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";

type CreateStep = "choose" | "local" | "shared";

type SharedRowItem =
  | { type: "calendar"; summary: JoinedCalendarSummary }
  | { type: "empty"; messageKey: TranslationKey };

interface SharedSection {
  key: "owned" | "joined";
  title: string;
  countLabel: string;
  data: SharedRowItem[];
}

function buildSectionData(
  all: JoinedCalendarSummary[],
  filtered: JoinedCalendarSummary[],
  query: string,
  emptyTitleKey: TranslationKey
): SharedRowItem[] {
  if (filtered.length > 0) {
    return filtered.map((summary) => ({ type: "calendar" as const, summary }));
  }
  // 元々0件（未作成／未参加）の場合は、検索中であっても「一致なし」ではなく本来の空状態を
  // 表示する（検索欄に何か入力しているせいで「作成データが0件であるかのような表示」に
  // 見えてしまうことを避けるための区別。逆に、元々は存在するのに検索で絞り込まれて
  // 0件になった場合だけ「一致する共有カレンダーがありません」にする）。
  const messageKey: TranslationKey = query.trim() && all.length > 0 ? "calendars.searchNoMatchText" : emptyTitleKey;
  return [{ type: "empty", messageKey }];
}

export default function CalendarsScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const {
    userCalendars,
    addUserCalendar,
    sharedCalendars,
    createSharedCalendar,
    overlaySettings,
    setEventDisplayModeIntent,
    toggleCalendarVisibilityIntent,
    refreshShared,
    pendingInvites,
    loadingPendingInvites,
    pendingInvitesError,
    refreshPendingInvites,
    acceptPendingInvite,
    declinePendingInvite,
  } = useAppData();
  const { user, isSupabaseConfigured } = useAuth();

  const [tab, setTab] = useState<CalendarTabKey>("personal");
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [createInitialStep, setCreateInitialStep] = useState<CreateStep>("choose");
  const [actionSheetCalendarId, setActionSheetCalendarId] = useState<string | null>(null);
  const [sharedActionSheetCalendarId, setSharedActionSheetCalendarId] = useState<string | null>(null);
  const [sharedSearchQuery, setSharedSearchQuery] = useState("");
  // 同時に処理できる招待は1件だけにする（招待タブ内での二重タップ防止）。
  const [processingInviteId, setProcessingInviteId] = useState<string | null>(null);
  const [processingAction, setProcessingAction] = useState<"accept" | "decline" | null>(null);

  // 他デバイスでの共有カレンダーの変更（名前・画像・メンバー等）・新着招待を、既存の
  // 高頻度ポーリングを追加せずに反映するための最小限の対応。既存のrefreshShared・
  // 今回追加したrefreshPendingInvitesをフォーカス時に呼ぶだけ。
  useFocusEffect(
    useCallback(() => {
      refreshShared();
      refreshPendingInvites();
    }, [refreshShared, refreshPendingInvites])
  );

  const handleAcceptInvite = async (inviteId: string) => {
    if (processingInviteId) return;
    setProcessingInviteId(inviteId);
    setProcessingAction("accept");
    try {
      const result = await acceptPendingInvite(inviteId);
      Alert.alert(
        t("calendarInvite.acceptedSuccessTitle"),
        t("calendarInvite.acceptedSuccessMessage", { name: result.calendarName })
      );
    } catch (e) {
      Alert.alert(
        t("calendarInvite.acceptFailedMessage"),
        toFriendlyMessage(e instanceof Error ? e.message : undefined, t("calendarInvite.acceptFailedMessage"), t)
      );
    } finally {
      setProcessingInviteId(null);
      setProcessingAction(null);
    }
  };

  const handleDeclineInvite = (inviteId: string) => {
    if (processingInviteId) return;
    Alert.alert(t("calendarInvite.declineConfirmTitle"), t("calendarInvite.declineConfirmMessage"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("calendarInvite.declineButton"),
        style: "destructive",
        onPress: async () => {
          setProcessingInviteId(inviteId);
          setProcessingAction("decline");
          try {
            await declinePendingInvite(inviteId);
          } catch (e) {
            Alert.alert(
              t("calendarInvite.declineFailedMessage"),
              toFriendlyMessage(
                e instanceof Error ? e.message : undefined,
                t("calendarInvite.declineFailedMessage"),
                t
              )
            );
          } finally {
            setProcessingInviteId(null);
            setProcessingAction(null);
          }
        },
      },
    ]);
  };

  const myCalendarLimit = getMyCalendarLimit();
  const sharedCalendarLimit = SHARED_CALENDAR_LIMIT;

  const handleRequestLogin = () => {
    router.push({ pathname: "/auth/sign-in", params: { returnTo: "/calendars" } });
  };

  const handleCreateLocal = async (name: string, color: string) => {
    await addUserCalendar({ id: generateId("cal"), name, color, memberNames: [] });
  };

  const handleCreateShared = async (name: string, color: string) => {
    if (!user) {
      handleRequestLogin();
      return;
    }
    await createSharedCalendar(name, color);
  };

  const openCreateModal = (step: CreateStep) => {
    setCreateInitialStep(step);
    setCreateModalVisible(true);
  };

  const { solo, owner, joined } = classifySharedCalendars(sharedCalendars);
  const ownedSharedCalendars = [...solo, ...owner];
  const myCalendarCount = totalMyCalendars(userCalendars);
  const ownedSharedCalendarCount = countOwnedSharedCalendars(sharedCalendars);
  const myCalendarRemaining = remainingMyCalendars(userCalendars);
  const sharedCalendarRemaining = sharedCalendarLimit - ownedSharedCalendarCount;

  const baseCalendar = userCalendars.find((c) => isBaseCalendar(c.id));
  const additionalCalendars = userCalendars.filter((c) => !isBaseCalendar(c.id));
  const displayMode = eventDisplayModeFromOverlay(overlaySettings);

  // マイカレンダー・共有タブ共通のトグルハンドラ。マイ＋共有合計5個までの同時表示上限は
  // src/utils/calendarVisibility.tsの1関数だけで判定する（画面ごとの重複実装を避けるため、
  // app/overlay.tsx・CalendarVisibilityChips.tsxも同じ関数を使う）。
  const toggleCalendarVisible = (id: string) => {
    // [P0094 CORRECT-F019-001] 事前にtoggleCalendarVisibilityで絶対値を計算せず、
    // calendarIdだけをintentとして渡す。直列化された時点の最新値からトグル結果を導出する
    // ことで、連続した2つの表示切替が互いを上書きしない（詳細はAppDataContext.tsxの
    // toggleCalendarVisibilityIntent定義のdoc参照）。上限到達時のアラート文言は既存のまま。
    toggleCalendarVisibilityIntent(id)
      .then((result) => {
        if (result.status === "limitReached") {
          Alert.alert(t("newCalendarModal.limitReachedTitle"), t("calendars.visibleLimitReachedMessage"));
        }
      })
      .catch(() => {
        Alert.alert(t("common.couldNotChange"), toFriendlyMessage(undefined, t("overlay.saveErrorFallback"), t));
      });
  };

  const handleDisplayModeChange = (mode: Parameters<typeof setEventDisplayModeIntent>[0]) => {
    // [P0096 CORRECT-F019-002] 絶対値を再計算して積む汎用の書込みではなく、
    // 直列化された最新値からshowNormalEvents/showTasksを設定する専用intentを使う。
    setEventDisplayModeIntent(mode).catch(() => {
      Alert.alert(t("common.couldNotChange"), toFriendlyMessage(undefined, t("overlay.saveErrorFallback"), t));
    });
  };

  const ownedFiltered = filterSharedCalendarsByQuery(ownedSharedCalendars, sharedSearchQuery);
  const joinedFiltered = filterSharedCalendarsByQuery(joined, sharedSearchQuery);

  const sharedSections: SharedSection[] = [
    {
      key: "owned",
      title: t("calendars.ownedSharedSectionTitle"),
      countLabel: t("overlay.countLabel", { count: ownedSharedCalendarCount, limit: sharedCalendarLimit }),
      data: buildSectionData(ownedSharedCalendars, ownedFiltered, sharedSearchQuery, "calendars.ownedSharedEmptyTitle"),
    },
    {
      key: "joined",
      title: t("calendars.joinedSharedSectionTitle"),
      countLabel: t("calendars.joinedSharedCountLabel", { count: joined.length }),
      data: buildSectionData(joined, joinedFiltered, sharedSearchQuery, "calendars.joinedSharedEmptyTitle"),
    },
  ];

  const renderSharedSectionHeader = ({ section }: { section: SharedSection }) => (
    <View style={styles.sectionHeaderRow}>
      <Text style={styles.sectionLabel}>
        {section.title} {section.countLabel}
      </Text>
    </View>
  );

  const renderSharedSectionFooter = ({ section }: { section: SharedSection }) => {
    if (section.key !== "owned") return null;
    return (
      <Pressable
        style={styles.createButton}
        onPress={() => openCreateModal("shared")}
        accessibilityRole="button"
      >
        <Text style={styles.createButtonText}>{t("calendars.createSharedCalendarButton")}</Text>
      </Pressable>
    );
  };

  const renderSharedItem = ({ item }: { item: SharedRowItem }) => {
    if (item.type === "empty") {
      return (
        <View style={styles.sharedEmptyRow}>
          <Text style={styles.sharedEmptyText}>{t(item.messageKey)}</Text>
        </View>
      );
    }
    const { summary } = item;
    return (
      <SharedCalendarRow
        summary={summary}
        visible={overlaySettings.visibleCalendarIds.includes(summary.calendar.id)}
        onToggleVisible={() => toggleCalendarVisible(summary.calendar.id)}
        onPress={() => router.push({ pathname: "/calendar/[id]", params: { id: summary.calendar.id } })}
        onPressMenu={() => setSharedActionSheetCalendarId(summary.calendar.id)}
      />
    );
  };

  const sharedListHeader = (
    <View style={styles.searchWrap}>
      <Ionicons name="search-outline" size={16} color={colors.textTertiary} />
      <TextInput
        style={styles.searchInput}
        value={sharedSearchQuery}
        onChangeText={setSharedSearchQuery}
        placeholder={t("calendars.searchPlaceholder")}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={t("calendars.searchPlaceholder")}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );

  const sharedListFooter = (
    <>
      <Pressable
        style={styles.viewInvitationsLink}
        onPress={() => setTab("invitations")}
        accessibilityRole="button"
      >
        <Ionicons name="mail-outline" size={16} color={colors.primary} />
        <Text style={styles.viewInvitationsLinkText}>{t("calendars.viewInvitationsLink")}</Text>
      </Pressable>

      <SectionCard>
        <View style={styles.displayModeCard}>
          <EventDisplayModeSwitch value={displayMode} onChange={handleDisplayModeChange} />
        </View>
      </SectionCard>

      {!isSupabaseConfigured && (
        <View style={styles.cloudNotice}>
          <Ionicons name="cloud-offline-outline" size={14} color={colors.textTertiary} />
          <Text style={styles.cloudNoticeText}>{t("calendars.cloudNotice")}</Text>
        </View>
      )}
    </>
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <PageLayout
        header={
          <ScreenHeader
            title={t("calendars.title")}
            onBack={() => router.back()}
            right={
              <Pressable
                hitSlop={8}
                style={styles.headerAddButton}
                onPress={() => openCreateModal("choose")}
                accessibilityLabel={t("calendars.createRowText")}
              >
                <Ionicons name="add" size={22} color={colors.textInverse} />
              </Pressable>
            }
          />
        }
      >
        <View style={styles.tabsWrap}>
          <CalendarTabs value={tab} onChange={setTab} invitationsBadgeCount={pendingInvites.length} />
        </View>

        {tab === "personal" && (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            {baseCalendar ? (
              <>
                <BaseCalendarCard
                  calendar={baseCalendar}
                  visible={overlaySettings.visibleCalendarIds.includes(baseCalendar.id)}
                  onToggleVisible={() => toggleCalendarVisible(baseCalendar.id)}
                  onPressMenu={() => setActionSheetCalendarId(baseCalendar.id)}
                />

                <SectionCard style={styles.myCalendarsCard}>
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionLabel}>
                      {t("overlay.myCalendarsSectionTitle")}{" "}
                      {t("overlay.countLabel", { count: myCalendarCount, limit: myCalendarLimit })}
                    </Text>
                  </View>
                  {additionalCalendars.map((c) => (
                    <MyCalendarRow
                      key={c.id}
                      calendar={c}
                      visible={overlaySettings.visibleCalendarIds.includes(c.id)}
                      onToggleVisible={() => toggleCalendarVisible(c.id)}
                      onPressMenu={() => setActionSheetCalendarId(c.id)}
                    />
                  ))}
                </SectionCard>

                <Pressable
                  style={styles.createButton}
                  onPress={() => openCreateModal("local")}
                  accessibilityRole="button"
                >
                  <Text style={styles.createButtonText}>{t("calendars.createMyCalendarButton")}</Text>
                </Pressable>

                <SectionCard>
                  <View style={styles.displayModeCard}>
                    <EventDisplayModeSwitch value={displayMode} onChange={handleDisplayModeChange} />
                  </View>
                </SectionCard>

              </>
            ) : (
              <EmptyState
                icon="person-outline"
                title={t("calendars.personalEmptyText")}
                description={t("newCalendarModal.localOptionSubtitle")}
              />
            )}

            <View style={styles.linkCard}>
              <Ionicons name="barbell-outline" size={18} color={colors.textTertiary} />
              <Text style={styles.linkCardText}>{t("menu.trainingIntegration")}</Text>
              <Text style={styles.linkCardHelper}>{t("common.comingSoon")}</Text>
            </View>
          </ScrollView>
        )}

        {tab === "shared" && (
          !user ? (
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
              <View style={styles.requiresLoginContainer}>
                <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
                <Text style={styles.requiresLoginTitle}>{t("calendars.sharedRequiresLoginTitle")}</Text>
                <PrimaryButton
                  label={t("calendars.requiresLoginButton")}
                  onPress={handleRequestLogin}
                  style={styles.requiresLoginButton}
                />
              </View>
            </ScrollView>
          ) : (
            <SectionList
              style={styles.scroll}
              contentContainerStyle={styles.content}
              sections={sharedSections}
              keyExtractor={(item, index) =>
                item.type === "calendar" ? item.summary.calendar.id : `empty-${index}`
              }
              renderItem={renderSharedItem}
              renderSectionHeader={renderSharedSectionHeader}
              renderSectionFooter={renderSharedSectionFooter}
              ListHeaderComponent={sharedListHeader}
              ListFooterComponent={sharedListFooter}
              stickySectionHeadersEnabled={false}
              keyboardShouldPersistTaps="handled"
            />
          )
        )}

        {tab === "invitations" && !user && (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <View style={styles.requiresLoginContainer}>
              <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
              <Text style={styles.requiresLoginTitle}>{t("calendars.invitationsRequiresLoginTitle")}</Text>
              <PrimaryButton
                label={t("calendars.requiresLoginButton")}
                onPress={handleRequestLogin}
                style={styles.requiresLoginButton}
              />
            </View>
          </ScrollView>
        )}

        {tab === "invitations" && user && (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            {ownedSharedCalendars.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>{t("calendars.manageInvitesSectionTitle")}</Text>
                {ownedSharedCalendars.map((s) => (
                  <CalendarCard
                    key={s.calendar.id}
                    name={s.calendar.name}
                    color={s.calendar.color}
                    icon="people-outline"
                    statusText={t("calendars.manageInvitesRowSubtitle")}
                    chevronOnly
                    onPress={() =>
                      router.push({ pathname: "/calendar/[id]/invite", params: { id: s.calendar.id } })
                    }
                    accessibilityLabel={t("calendars.rowA11y", {
                      name: s.calendar.name,
                      status: t("calendars.manageInvitesRowSubtitle"),
                    })}
                  />
                ))}
              </>
            )}

            <Text style={styles.sectionTitle}>{t("calendars.receivedInvitationsSectionTitle")}</Text>

            {pendingInvitesError && (
              <View style={styles.invitesErrorBox}>
                <Ionicons name="alert-circle-outline" size={18} color={colors.warning} />
                <Text style={styles.invitesErrorText}>{t("calendarInvite.loadFailedMessage")}</Text>
                <Pressable
                  style={styles.reloadButton}
                  onPress={() => refreshPendingInvites()}
                  accessibilityRole="button"
                >
                  <Text style={styles.reloadButtonText}>{t("calendarInvite.reloadButton")}</Text>
                </Pressable>
              </View>
            )}

            {loadingPendingInvites && pendingInvites.length === 0 && !pendingInvitesError ? (
              <View style={styles.invitesLoadingBox}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : pendingInvites.length === 0 ? (
              !pendingInvitesError && (
                <EmptyState
                  icon="mail-outline"
                  title={t("calendars.pendingInvitesEmptyTitle")}
                  description={t("calendars.pendingInvitesEmptyBody")}
                />
              )
            ) : (
              <View style={styles.invitesListWrap}>
                {pendingInvites.map((invite) => (
                  <InvitationCard
                    key={invite.id}
                    invite={invite}
                    onAccept={() => handleAcceptInvite(invite.id)}
                    onDecline={() => handleDeclineInvite(invite.id)}
                    accepting={processingInviteId === invite.id && processingAction === "accept"}
                    declining={processingInviteId === invite.id && processingAction === "decline"}
                  />
                ))}
              </View>
            )}
          </ScrollView>
        )}
      </PageLayout>

      <NewCalendarModal
        visible={createModalVisible}
        onClose={() => setCreateModalVisible(false)}
        isLoggedIn={!!user}
        isSupabaseConfigured={isSupabaseConfigured}
        onRequestLogin={handleRequestLogin}
        onCreateLocal={handleCreateLocal}
        onCreateShared={handleCreateShared}
        myCalendarRemaining={myCalendarRemaining}
        myCalendarLimit={myCalendarLimit}
        sharedCalendarRemaining={sharedCalendarRemaining}
        sharedCalendarLimit={sharedCalendarLimit}
        initialStep={createInitialStep}
      />

      <CalendarActionSheet
        calendarId={actionSheetCalendarId}
        onClose={() => setActionSheetCalendarId(null)}
      />

      <SharedCalendarActionSheet
        calendarId={sharedActionSheetCalendarId}
        onClose={() => setSharedActionSheetCalendarId(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  // PageLayoutのcontent領域（flex:1）いっぱいに広がるよう明示する。これが無いと、
  // コンテンツの高さのままになり、下に空白が残ってしまう（RNのScrollView系コンポーネントは
  // 既定でflexが無いと親の残り領域を自動では埋めないため）。
  scroll: { flex: 1 },
  content: { paddingBottom: 40 },
  headerAddButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  tabsWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  myCalendarsCard: { paddingBottom: spacing.xs },
  sectionHeaderRow: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    backgroundColor: colors.background,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textTertiary,
  },
  createButton: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    minHeight: minTapSize,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  createButtonText: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.primary,
  },
  displayModeCard: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    fontSize: 13,
    fontWeight: "700",
    color: colors.textTertiary,
  },
  invitesListWrap: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
  invitesLoadingBox: {
    alignItems: "center",
    paddingVertical: spacing.xl,
  },
  invitesErrorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
  },
  invitesErrorText: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
  },
  reloadButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  reloadButtonText: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.warning,
  },
  linkCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: minTapSize,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
    opacity: 0.5,
  },
  linkCardText: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.textSecondary },
  linkCardHelper: {
    fontSize: 11,
    color: colors.textTertiary,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
  },
  cloudNotice: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  cloudNoticeText: { flex: 1, color: colors.textTertiary, fontSize: 11, lineHeight: 15 },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.md,
    minHeight: minTapSize - 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: colors.textPrimary,
    paddingVertical: spacing.xs,
  },
  sharedEmptyRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  sharedEmptyText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  requiresLoginContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  requiresLoginTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textSecondary,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  requiresLoginButton: {
    marginTop: spacing.md,
    alignSelf: "stretch",
  },
  viewInvitationsLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: minTapSize,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
  viewInvitationsLinkText: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.primary,
  },
});
