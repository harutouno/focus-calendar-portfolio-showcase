import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { LoadingView } from "@/components/common/LoadingView";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { Avatar } from "@/components/common/Avatar";
import { DefaultCalendarCover } from "@/components/calendar/DefaultCalendarCover";
import { useAppData } from "@/context/AppDataContext";
import { useAuth } from "@/context/AuthContext";
import { fetchCalendarMembers } from "@/services/calendarService";
import {
  SharedMutationIdentity,
  buildIdentityRemountKey,
  isCurrentSharedMutationIdentity,
} from "@/auth/sharedMutationIdentity";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";
import { CalendarMembership, CalendarRole } from "@/types/sharing";
import { isFocusTask } from "@/types/event";

const ROLE_LABEL_KEY: Record<CalendarRole, TranslationKey> = {
  owner: "calendarRole.owner",
  editor: "calendarRole.editor",
  viewer: "calendarRole.viewer",
};

const MAX_AVATARS = 5;
const MAX_UPCOMING = 5;

/**
 * REVISE対応（第10ラウンド、P1-1）: membersローカルstateはAのメンバー名を含みうる
 * 機密性の高い表示情報のため、identityが変わった最初のコミットで一切公開しないよう、
 * 薄い外側wrapperでidentityKeyを作り実装本体をkey付きで再マウントする
 * （app/calendar/[id]/members.tsxと同じパターン、詳細はそちらのコメント参照）。
 */
export default function CalendarDetailScreen() {
  const { user, sessionInstanceId } = useAuth();
  const identityKey = buildIdentityRemountKey(user?.id, sessionInstanceId);
  return <CalendarDetailScreenInner key={identityKey} />;
}

function CalendarDetailScreenInner() {
  const router = useRouter();
  const { t } = useLocale();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, sessionInstanceId } = useAuth();
  const {
    userCalendars,
    sharedCalendars,
    events,
    loadingShared,
    favoriteCalendarIds,
    toggleFavoriteCalendar,
  } = useAppData();

  const localCalendar = useMemo(
    () => userCalendars.find((c) => c.id === id),
    [userCalendars, id]
  );
  const sharedSummary = useMemo(
    () => sharedCalendars.find((s) => s.calendar.id === id),
    [sharedCalendars, id]
  );

  const [members, setMembers] = useState<CalendarMembership[]>([]);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);

  // REVISE対応（第10ラウンド、P1-1/P1-2）: userオブジェクト自体ではなくuser?.id（文字列）に
  // 依存させる。AuthContextはTOKEN_REFRESHED等でidentity値が変わらない場合でもsession
  // オブジェクト（ひいてはuser参照）を再生成しうるため、user自体を依存配列に含めると
  // 不要な再取得を繰り返してしまう（P1-1テスト6に反する）。
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!sharedSummary) {
      setMembers([]);
      return;
    }
    if (!userId || !sessionInstanceId) return;
    const identity: SharedMutationIdentity = { userId, sessionInstanceId };
    let active = true;
    fetchCalendarMembers(sharedSummary.calendar.id, identity)
      .then((m) => {
        if (active) setMembers(m);
      })
      .catch(() => {
        // identity失効・通信失敗いずれも、既存表示を変更せず静かに諦める
        // （このセクションは補助的な表示で、失敗時のAlertは不要）。
      });
    return () => {
      active = false;
    };
  }, [sharedSummary, userId, sessionInstanceId]);

  if (loadingShared && !sharedSummary && !localCalendar) return <LoadingView />;

  if (!sharedSummary && !localCalendar) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <ScreenHeader title={t("calendars.title")} onBack={() => router.back()} />
        <View style={styles.notFound}>
          <Text style={styles.notFoundText}>{t("calendarDetail.notFoundText")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const calendarId = (sharedSummary?.calendar.id ?? localCalendar?.id) as string;
  const name = sharedSummary?.calendar.name ?? localCalendar?.name ?? "";
  const color = sharedSummary?.calendar.color ?? localCalendar?.color ?? colors.primary;
  const isOwner = sharedSummary?.role === "owner";
  const isFavorite = favoriteCalendarIds.includes(calendarId);
  // オーナー・編集者は設定画面を開ける。閲覧のみのメンバーには導線を出さない
  const canOpenSettings = !sharedSummary || isOwner || sharedSummary.role === "editor";

  const allUpcoming = events
    .filter((e) => e.calendarId === calendarId)
    .sort((a, b) => (a.date === b.date ? (a.startTime < b.startTime ? -1 : 1) : a.date < b.date ? -1 : 1));
  const upcoming = showAllUpcoming ? allUpcoming : allUpcoming.slice(0, MAX_UPCOMING);

  /**
   * P0015 Batch1.2、P1-1: shared calendar時、navigation/favorite副作用より前に
   * 同期的にcurrent identityを確認する。ローカルカレンダー（!sharedSummary）は
   * auth identityに一切依存させず、常にtrueを返す。
   */
  const isNavigationIdentityCurrent = (): boolean => {
    if (!sharedSummary) return true;
    if (!userId || !sessionInstanceId) return false;
    return isCurrentSharedMutationIdentity({ userId, sessionInstanceId });
  };

  const handleOpenSettings = () => {
    if (!canOpenSettings || !isNavigationIdentityCurrent()) return;
    router.push({ pathname: "/calendar/[id]/settings", params: { id: calendarId } });
  };

  const handleOtherMenu = () => {
    // shared calendar時、Alert自体もcurrent identityの場合だけ表示する。
    if (!isNavigationIdentityCurrent()) return;
    const options: { text: string; onPress?: () => void; style?: "destructive" | "cancel" }[] = [];
    if (canOpenSettings) {
      options.push({ text: t("calendarDetail.openSettingsOption"), onPress: handleOpenSettings });
    }
    if (sharedSummary && isOwner) {
      options.push({
        text: t("calendarDetail.shareInviteOption"),
        onPress: () => {
          if (isNavigationIdentityCurrent()) {
            router.push({ pathname: "/calendar/[id]/invite", params: { id: calendarId } });
          }
        },
      });
    }
    options.push({
      text: isFavorite ? t("calendars.menuRemoveFavorite") : t("calendars.menuAddFavorite"),
      onPress: () => {
        if (isNavigationIdentityCurrent()) toggleFavoriteCalendar(calendarId);
      },
    });
    options.push({ text: t("common.cancel"), style: "cancel" });
    Alert.alert(name, undefined, options);
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.cover}>
          <DefaultCalendarCover
            color={color}
            style={StyleSheet.absoluteFillObject}
          />
          <View style={[styles.coverButtonsRow, { paddingTop: insets.top + spacing.xs }]}>
            <Pressable
              hitSlop={8}
              style={styles.coverCircleButton}
              onPress={() => router.back()}
              accessibilityLabel={t("common.back")}
            >
              <Ionicons name="chevron-back" size={20} color={colors.textInverse} />
            </Pressable>
            <Pressable
              hitSlop={8}
              style={styles.coverCircleButton}
              onPress={handleOtherMenu}
              accessibilityLabel={t("calendars.overflowMenuA11y")}
            >
              <Ionicons name="ellipsis-horizontal" size={20} color={colors.textInverse} />
            </Pressable>
          </View>
        </View>

        <View style={styles.infoSection}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={2}>{name}</Text>
            <Pressable
              hitSlop={8}
              onPress={() => {
                if (isNavigationIdentityCurrent()) toggleFavoriteCalendar(calendarId);
              }}
              accessibilityLabel={isFavorite ? t("calendars.menuRemoveFavorite") : t("calendars.menuAddFavorite")}
            >
              <Ionicons
                name={isFavorite ? "star" : "star-outline"}
                size={22}
                color={isFavorite ? colors.favorite : colors.textTertiary}
              />
            </Pressable>
          </View>
          {sharedSummary ? (
            <Text style={styles.subtitle}>
              {t("calendarDetail.subtitleShared", {
                role: t(ROLE_LABEL_KEY[sharedSummary.role]),
                count: sharedSummary.memberCount,
              })}
            </Text>
          ) : (
            <Text style={styles.subtitle}>{t("calendarDetail.subtitleLocal")}</Text>
          )}

          {sharedSummary && members.length > 0 && (
            <View style={styles.avatarRow}>
              {members.slice(0, MAX_AVATARS).map((m) => (
                <Avatar key={m.userId} uri={m.avatarUrl} label={m.displayName ?? "?"} size={32} style={styles.avatar} />
              ))}
              {members.length > MAX_AVATARS && (
                <View style={[styles.avatar, styles.avatarMore]}>
                  <Text style={styles.avatarText}>
                    {t("calendarDetail.overflowAvatarCount", { count: members.length - MAX_AVATARS })}
                  </Text>
                </View>
              )}
              {isOwner && (
                <Pressable
                  style={styles.inviteChip}
                  onPress={() => {
                    if (isNavigationIdentityCurrent()) {
                      router.push({ pathname: "/calendar/[id]/invite", params: { id: calendarId } });
                    }
                  }}
                >
                  <Ionicons name="add" size={14} color={colors.primary} />
                  <Text style={styles.inviteChipText}>{t("calendarDetail.inviteChipLabel")}</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>

        <PrimaryButton
          label={t("common.addEvent")}
          onPress={() => router.push("/event/new")}
          style={styles.primaryAction}
        />

        <View style={styles.tileRow}>
          <Pressable
            style={styles.tile}
            onPress={() => router.push("/")}
            accessibilityRole="button"
            accessibilityLabel={t("calendarDetail.showEventsA11y")}
          >
            <Ionicons name="calendar-outline" size={24} color={colors.primary} />
            <Text style={styles.tileLabel}>{t("calendarDetail.showEventsA11y")}</Text>
          </Pressable>
          {sharedSummary && (
            <Pressable
              style={styles.tile}
              onPress={() => {
                if (isNavigationIdentityCurrent()) {
                  router.push({ pathname: "/calendar/[id]/members", params: { id: calendarId } });
                }
              }}
              accessibilityRole="button"
              accessibilityLabel={t("calendarDetail.membersA11y", { count: sharedSummary.memberCount })}
            >
              <Ionicons name="people-outline" size={24} color={colors.primary} />
              <Text style={styles.tileLabel}>{t("calendarDetail.membersLabel")}</Text>
            </Pressable>
          )}
          {canOpenSettings && (
            <Pressable
              style={styles.tile}
              onPress={handleOpenSettings}
              accessibilityRole="button"
              accessibilityLabel={t("calendarDetail.settingsA11y")}
            >
              <Ionicons name="settings-outline" size={24} color={colors.primary} />
              <Text style={styles.tileLabel}>{t("calendarDetail.settingsA11y")}</Text>
            </Pressable>
          )}
        </View>

        {sharedSummary && !isOwner && (
          <View style={styles.notice}>
            <Ionicons name="information-circle-outline" size={18} color={colors.textSecondary} />
            <Text style={styles.noticeText}>
              {sharedSummary.role === "editor"
                ? t("calendarDetail.roleNoticeOwnerEditor")
                : t("calendarDetail.roleNoticeViewer")}
            </Text>
          </View>
        )}

        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>{t("calendarDetail.upcomingSectionTitle")}</Text>
          {allUpcoming.length > MAX_UPCOMING && (
            <Pressable hitSlop={8} onPress={() => setShowAllUpcoming((v) => !v)}>
              <Text style={styles.sectionHeaderLink}>
                {showAllUpcoming ? t("common.close") : t("calendarDetail.showAllToggle")}
              </Text>
            </Pressable>
          )}
        </View>
        {upcoming.length === 0 ? (
          <View style={styles.emptyUpcoming}>
            <Text style={styles.emptyUpcomingText}>{t("calendarDetail.upcomingEmptyText")}</Text>
          </View>
        ) : (
          upcoming.map((event) => (
            <Pressable
              key={event.id}
              style={styles.upcomingRow}
              onPress={() => {
                // P0015 Batch1.2、P1-1: shared calendarの予定行からの遷移もcurrent
                // identityの場合だけ行う。
                if (!isNavigationIdentityCurrent()) return;
                router.push({
                  pathname: isFocusTask(event) ? "/focus/[id]" : "/event/[id]",
                  params: { id: event.id },
                });
              }}
            >
              <View style={styles.upcomingDate}>
                <Text style={styles.upcomingDateText}>{event.date.slice(5).replace("-", "/")}</Text>
                <Text style={styles.upcomingTimeText}>{event.startTime}</Text>
              </View>
              <Text style={styles.upcomingTitle} numberOfLines={1}>{event.title}</Text>
              {sharedSummary && members.length > 0 && (
                <View style={styles.upcomingAvatarRow}>
                  {members.slice(0, 3).map((m, index) => (
                    <Avatar
                      key={m.userId}
                      uri={m.avatarUrl}
                      label={m.displayName ?? "?"}
                      size={18}
                      style={[styles.upcomingAvatar, index > 0 && styles.upcomingAvatarOverlap]}
                    />
                  ))}
                </View>
              )}
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },
  cover: {
    height: 220,
    overflow: "hidden",
  },
  coverButtonsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
  },
  coverCircleButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(17,20,27,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  infoSection: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: { flex: 1, fontSize: 21, fontWeight: "700", color: colors.textPrimary },
  subtitle: { fontSize: 13, color: colors.textTertiary, marginTop: 4 },
  avatarRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: spacing.md },
  inviteChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginLeft: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  inviteChipText: { fontSize: 12, fontWeight: "700", color: colors.primary },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarMore: { backgroundColor: colors.primarySoft },
  avatarText: { fontSize: 12, fontWeight: "700", color: colors.textSecondary },
  primaryAction: { marginHorizontal: spacing.lg, marginTop: spacing.lg, marginBottom: spacing.md },
  tileRow: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: "center",
    gap: 6,
  },
  tileLabel: { fontSize: 12, fontWeight: "700", color: colors.textPrimary },
  notice: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  noticeText: { flex: 1, fontSize: 12, color: colors.textSecondary },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xs,
  },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.textTertiary },
  sectionHeaderLink: { fontSize: 12, fontWeight: "700", color: colors.primary },
  emptyUpcoming: { marginHorizontal: spacing.lg, padding: spacing.lg, alignItems: "center" },
  emptyUpcomingText: { color: colors.textTertiary, fontSize: 13 },
  upcomingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  upcomingDate: { width: 56 },
  upcomingDateText: { fontSize: 12, fontWeight: "700", color: colors.textPrimary },
  upcomingTimeText: { fontSize: 11, color: colors.textTertiary },
  upcomingTitle: { flex: 1, fontSize: 14, color: colors.textPrimary },
  upcomingAvatarRow: { flexDirection: "row" },
  upcomingAvatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  upcomingAvatarOverlap: { marginLeft: -6 },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { color: colors.textSecondary, fontSize: 15 },
});
