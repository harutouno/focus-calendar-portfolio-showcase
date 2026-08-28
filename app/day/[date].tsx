import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AppEvent, isFocusTask } from "@/types/event";
import { useAppData } from "@/context/AppDataContext";
import { useHolidays } from "@/hooks/useHolidays";
import { filterVisibleEvents } from "@/utils/eventVisibility";
import { selectEventsForDate } from "@/utils/dayAgenda";
import { formatAgendaDayTitle, todayLocalDateString } from "@/utils/date";
import { DayAgendaRow } from "@/components/calendar/DayAgendaRow";
import { EmptyState } from "@/components/common/EmptyState";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { PageLayout } from "@/components/common/PageLayout";
import { colors } from "@/theme/colors";
import { minTapSize, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { useHolidayRegion } from "@/context/HolidayRegionContext";

/**
 * 月表示で日付をタップしたときに開く、その日の予定一覧画面（Stage I-8.7）。
 * DayView（週間タイムライン内の1日分）とは責務が異なるため、無理に統合していない。
 */
export default function DayAgendaScreen() {
  const router = useRouter();
  const { t, locale } = useLocale();
  const { region } = useHolidayRegion();
  const { date } = useLocalSearchParams<{ date?: string }>();
  const focusedDate = date ?? todayLocalDateString();
  const { events, overlaySettings, sharedCalendars } = useAppData();

  const rawDayEvents = useMemo(
    () => selectEventsForDate(events, focusedDate),
    [events, focusedDate]
  );
  const dayEvents = useMemo(() => {
    const visible = filterVisibleEvents(events, overlaySettings);
    return selectEventsForDate(visible, focusedDate);
  }, [events, overlaySettings, focusedDate]);
  // 表示設定でフィルタされて0件になった場合（元データ自体は存在する）は、
  // 「予定が無い」ではなく「表示設定を確認してください」という案内にする。
  const allFilteredOut = dayEvents.length === 0 && rawDayEvents.length > 0;

  const holidays = useHolidays([focusedDate], locale, region);
  const holidayName = holidays[focusedDate];

  const handleSelectEvent = (event: AppEvent) => {
    if (isFocusTask(event)) {
      router.push({ pathname: "/focus/[id]", params: { id: event.id } });
    } else {
      router.push({ pathname: "/event/[id]", params: { id: event.id } });
    }
  };

  const handleAddEvent = () => {
    router.push({ pathname: "/event/new", params: { date: focusedDate } });
  };

  const handleAddFocusTask = () => {
    router.push({ pathname: "/focus/new", params: { date: focusedDate } });
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <PageLayout
        header={
          <>
            <View style={styles.header}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common.back")}
                onPress={() => router.back()}
                style={styles.backButton}
                hitSlop={8}
              >
                <Ionicons name="chevron-back" size={22} color={colors.primary} />
                <Text style={styles.backText}>{t("common.back")}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common.addEvent")}
                onPress={handleAddEvent}
                style={styles.addButton}
                hitSlop={8}
              >
                <Ionicons name="add" size={22} color={colors.textInverse} />
              </Pressable>
            </View>

            <View style={styles.titleWrap}>
              <Text style={styles.title}>{formatAgendaDayTitle(focusedDate, locale)}</Text>
              {holidayName ? <Text style={styles.holidayText}>{holidayName}</Text> : null}
            </View>
          </>
        }
      >
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {allFilteredOut ? (
            <EmptyState icon="eye-off-outline" title={t("common.noVisibleEventsHint")} />
          ) : dayEvents.length === 0 ? (
            <>
              <EmptyState
                icon="calendar-outline"
                title={t("dayAgenda.emptyTitle")}
                description={t("dayAgenda.emptyDescription")}
              />
              <View style={styles.emptyActions}>
                <PrimaryButton label={t("common.addEvent")} onPress={handleAddEvent} />
                <PrimaryButton
                  label={t("dayAgenda.addFocusTaskButton")}
                  variant="secondary"
                  onPress={handleAddFocusTask}
                  style={styles.secondaryActionButton}
                />
              </View>
            </>
          ) : (
            <>
              {dayEvents.map((event) => (
                <DayAgendaRow
                  key={event.id}
                  event={event}
                  sharedCalendars={sharedCalendars}
                  onPress={handleSelectEvent}
                />
              ))}
              <View style={styles.listActions}>
                <PrimaryButton
                  label={t("dayAgenda.addFocusTaskButton")}
                  variant="secondary"
                  onPress={handleAddFocusTask}
                />
              </View>
            </>
          )}
        </ScrollView>
      </PageLayout>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // PageLayoutのcontent領域（flex:1）いっぱいに広がるよう明示する。
  scroll: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: minTapSize + 8,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: minTapSize,
    paddingHorizontal: spacing.xs,
  },
  backText: {
    color: colors.primary,
    fontSize: 16,
  },
  addButton: {
    width: minTapSize,
    height: minTapSize,
    borderRadius: minTapSize / 2,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  titleWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  holidayText: {
    marginTop: 2,
    fontSize: 13,
    fontWeight: "700",
    color: colors.holiday,
  },
  scrollContent: {
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  emptyActions: {
    marginHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  secondaryActionButton: {
    marginTop: 0,
  },
  listActions: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
});
