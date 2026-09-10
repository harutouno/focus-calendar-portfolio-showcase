import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAppData } from "@/context/AppDataContext";
import { useAuth } from "@/context/AuthContext";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { SectionCard } from "@/components/common/SectionCard";
import { PageLayout } from "@/components/common/PageLayout";
import { NewCalendarModal } from "@/components/forms/NewCalendarModal";
import { CoverImage } from "@/components/calendar/CoverImage";
import {
  classifySharedCalendars,
  joinedStatusLabel,
  ownerStatusLabel,
  soloOwnerStatusLabel,
} from "@/utils/calendarListRows";
import {
  FREE_SHARED_CALENDAR_LIMIT,
  PREMIUM_SHARED_CALENDAR_LIMIT,
  countOwnedSharedCalendars,
  getMyCalendarLimit,
  isBaseCalendar,
  remainingMyCalendars,
  totalMyCalendars,
} from "@/constants/calendarLimits";
import { usePremiumStatus } from "@/hooks/usePremiumStatus";
import { useSignedCoverUrl } from "@/hooks/useSignedCoverUrl";
import { generateId } from "@/utils/id";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { colors } from "@/theme/colors";
import { minTapSize, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";

interface CalendarRowItem {
  id: string;
  name: string;
  color: string;
  coverImageUrl?: string;
  statusText?: string;
  /** 基本カレンダー「自分一人用」はこの画面からは編集導線を出さない（マイカレンダー画面から編集する） */
  editable: boolean;
}

function CalendarRow({
  item,
  checked,
  onToggle,
  onPressManage,
  manageA11yLabel,
}: {
  item: CalendarRowItem;
  checked: boolean;
  onToggle: () => void;
  onPressManage: () => void;
  manageA11yLabel: string;
}) {
  // item.coverImageUrlはローカルカレンダーのfile://と共有カレンダーの値が混在するフィールド。
  // このHookは共有カレンダー由来の値だけを署名付きURLへ解決し、ローカルのfile://は
  // そのまま素通しする（マイカレンダー画像の表示は一切変化しない）。
  const coverUri = useSignedCoverUrl(item.coverImageUrl);
  return (
    <Pressable
      style={styles.calendarRow}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={item.name}
    >
      <Ionicons
        name={checked ? "checkbox" : "square-outline"}
        size={22}
        color={checked ? colors.primary : colors.borderStrong}
      />
      <View style={styles.coverDot}>
        <CoverImage uri={coverUri} color={item.color} />
      </View>
      <View style={styles.rowTextWrap}>
        <Text style={styles.rowName} numberOfLines={1}>
          {item.name}
        </Text>
        {item.statusText ? (
          <Text style={styles.rowStatus} numberOfLines={1}>
            {item.statusText}
          </Text>
        ) : null}
      </View>
      {item.editable && (
        <Pressable
          hitSlop={8}
          onPress={onPressManage}
          accessibilityRole="button"
          accessibilityLabel={manageA11yLabel}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={colors.textTertiary} />
        </Pressable>
      )}
    </Pressable>
  );
}

function CheckRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      style={styles.checkRow}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
    >
      <Ionicons
        name={checked ? "checkbox" : "square-outline"}
        size={22}
        color={checked ? colors.primary : colors.borderStrong}
      />
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * 表示設定画面（2026-07-31再設計、旧「表示するカレンダー」画面）。
 * マイカレンダー／共有カレンダー／表示する予定の種類の3セクションに分け、
 * 各操作は即座に専用intent（[P0096]toggleShowNormalEventsIntent/toggleShowTasksIntent/
 * toggleCalendarVisibilityIntent）を呼んで保存する（適用ボタンは廃止）。
 */
export default function OverlayScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const { user, isSupabaseConfigured } = useAuth();
  const {
    overlaySettings,
    toggleCalendarVisibilityIntent,
    toggleShowNormalEventsIntent,
    toggleShowTasksIntent,
    userCalendars,
    addUserCalendar,
    sharedCalendars,
    createSharedCalendar,
  } = useAppData();
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const isPremium = usePremiumStatus();

  const myCalendarLimit = getMyCalendarLimit(isPremium);
  const sharedCalendarLimit = isPremium ? PREMIUM_SHARED_CALENDAR_LIMIT : FREE_SHARED_CALENDAR_LIMIT;

  const { solo, owner, joined } = classifySharedCalendars(sharedCalendars);
  const myCalendarCount = totalMyCalendars(userCalendars);
  const ownedSharedCalendarCount = countOwnedSharedCalendars(sharedCalendars);
  const myCalendarRemaining = remainingMyCalendars(userCalendars, isPremium);
  const sharedCalendarRemaining = sharedCalendarLimit - ownedSharedCalendarCount;

  // 2026-08: 「main」（自分一人用）はAppDataContext.refresh()が起動時に実体化するため、
  // userCalendarsに常に含まれる。ここで手動prependする必要は無くなった。
  const myCalendarItems: CalendarRowItem[] = userCalendars.map<CalendarRowItem>((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    coverImageUrl: c.coverImageUri,
    editable: !isBaseCalendar(c.id),
  }));

  const sharedCalendarItems: CalendarRowItem[] = [
    ...solo.map<CalendarRowItem>((s) => ({
      id: s.calendar.id,
      name: s.calendar.name,
      color: s.calendar.color,
      coverImageUrl: s.calendar.coverImageUrl,
      statusText: soloOwnerStatusLabel(t),
      editable: true,
    })),
    ...owner.map<CalendarRowItem>((s) => ({
      id: s.calendar.id,
      name: s.calendar.name,
      color: s.calendar.color,
      coverImageUrl: s.calendar.coverImageUrl,
      statusText: ownerStatusLabel(s.memberCount, t),
      editable: true,
    })),
    ...joined.map<CalendarRowItem>((s) => ({
      id: s.calendar.id,
      name: s.calendar.name,
      color: s.calendar.color,
      coverImageUrl: s.calendar.coverImageUrl,
      statusText: joinedStatusLabel(s.role, s.memberCount, t),
      editable: true,
    })),
  ];

  const toggleCalendar = (id: string) => {
    // [P0094 CORRECT-F019-001] マイカレンダー画面（app/calendars.tsx）と同じ
    // toggleCalendarVisibilityIntentを使い、マイ＋共有合計5個までの同時表示上限をこの画面
    // でも一貫して適用する（同じvisibleCalendarIdsを操作できる画面でだけ上限を回避できて
    // しまうことを防ぐため）。calendarIdだけをintentとして渡し、直列化された時点の最新値
    // からトグル結果を導出することで、連続した2回のタップが互いを上書きしない。
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

  const toggleShowNormalEvents = () => {
    // [P0096 CORRECT-F019-002] 絶対値を再計算して積む汎用の書込みではなく、
    // 直列化された最新値からトグルする専用intentを使う。
    toggleShowNormalEventsIntent().catch(() => {
      Alert.alert(t("common.couldNotChange"), toFriendlyMessage(undefined, t("overlay.saveErrorFallback"), t));
    });
  };

  const toggleShowTasks = () => {
    toggleShowTasksIntent().catch(() => {
      Alert.alert(t("common.couldNotChange"), toFriendlyMessage(undefined, t("overlay.saveErrorFallback"), t));
    });
  };

  const handleRequestLogin = () => {
    router.push({ pathname: "/auth/sign-in", params: { returnTo: "/overlay" } });
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

  const goToCalendarSettings = (id: string) => {
    router.push({ pathname: "/calendar/[id]/settings", params: { id } });
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <PageLayout header={<ScreenHeader title={t("overlay.title")} onBack={() => router.back()} />}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Text style={styles.description}>{t("overlay.description")}</Text>

          <SectionCard>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionLabel}>
                {t("overlay.myCalendarsSectionTitle")}{" "}
                {t("overlay.countLabel", { count: myCalendarCount, limit: myCalendarLimit })}
              </Text>
              <Pressable hitSlop={8} onPress={() => setCreateModalVisible(true)}>
                <Text style={styles.addButtonText}>{t("overlay.addMyCalendarButton")}</Text>
              </Pressable>
            </View>
            {myCalendarItems.map((item) => (
              <CalendarRow
                key={item.id}
                item={item}
                checked={overlaySettings.visibleCalendarIds.includes(item.id)}
                onToggle={() => toggleCalendar(item.id)}
                onPressManage={() => goToCalendarSettings(item.id)}
                manageA11yLabel={t("overlay.rowMenuA11y", { name: item.name })}
              />
            ))}
          </SectionCard>

          <SectionCard>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionLabel}>
                {t("overlay.sharedCalendarsSectionTitle")}{" "}
                {t("overlay.countLabel", { count: ownedSharedCalendarCount, limit: sharedCalendarLimit })}
              </Text>
              <Pressable hitSlop={8} onPress={() => setCreateModalVisible(true)}>
                <Text style={styles.addButtonText}>{t("overlay.addSharedCalendarButton")}</Text>
              </Pressable>
            </View>
            {sharedCalendarItems.length === 0 ? (
              <Text style={styles.emptyText}>{t("overlay.sharedCalendarsEmptyText")}</Text>
            ) : (
              sharedCalendarItems.map((item) => (
                <CalendarRow
                  key={item.id}
                  item={item}
                  checked={overlaySettings.visibleCalendarIds.includes(item.id)}
                  onToggle={() => toggleCalendar(item.id)}
                  onPressManage={() => goToCalendarSettings(item.id)}
                  manageA11yLabel={t("overlay.rowMenuA11y", { name: item.name })}
                />
              ))
            )}
          </SectionCard>

          <SectionCard>
            <View style={styles.sectionLabelWrap}>
              <Text style={styles.sectionLabel}>{t("overlay.eventTypesSectionTitle")}</Text>
            </View>
            <CheckRow
              label={t("overlay.normalEventsLabel")}
              checked={overlaySettings.showNormalEvents}
              onToggle={toggleShowNormalEvents}
            />
            <CheckRow
              label={t("overlay.tasksLabel")}
              checked={overlaySettings.showTasks}
              onToggle={toggleShowTasks}
            />
          </SectionCard>

          <Text style={styles.autoSaveNote}>{t("overlay.autoSaveNote")}</Text>
        </ScrollView>
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
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    paddingBottom: spacing.xl,
  },
  description: {
    fontSize: 13,
    color: colors.textSecondary,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    lineHeight: 18,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  sectionLabelWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textTertiary,
  },
  addButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.primary,
  },
  calendarRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: minTapSize + 4,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  coverDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    overflow: "hidden",
  },
  rowTextWrap: {
    flex: 1,
  },
  rowName: {
    fontSize: 16,
    color: colors.textPrimary,
  },
  rowStatus: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 1,
  },
  emptyText: {
    fontSize: 13,
    color: colors.textTertiary,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: minTapSize + 4,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  checkLabel: {
    fontSize: 16,
    color: colors.textPrimary,
    flex: 1,
  },
  autoSaveNote: {
    fontSize: 11,
    color: colors.textTertiary,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    lineHeight: 15,
  },
});
