import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAppData } from "@/context/AppDataContext";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { PageLayout } from "@/components/common/PageLayout";
import { LoadingView } from "@/components/common/LoadingView";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { StatCard } from "@/components/records/StatCard";
import { MonthlyTrendChart } from "@/components/records/MonthlyTrendChart";
import { PeriodSwitcher, PeriodSwitcherOption } from "@/components/records/PeriodSwitcher";
import { CustomRangeModal } from "@/components/records/CustomRangeModal";
import { RecentDaysChart } from "@/components/records/RecentDaysChart";
import { FocusHistoryList } from "@/components/records/FocusHistoryList";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { streaksByTask } from "@/utils/records";
import {
  DateKeyRange,
  computeCompletionRate,
  computeCurrentStreakDays,
  computeLongestStreakDaysEver,
  computePeriodComparison,
  computePeriodSummary,
  filterRecordsInRange,
  formatFocusDuration,
  getFocusByCalendar,
  getFocusByTask,
  getInterruptionStats,
  getLast12MonthsFocus,
  getPreviousMonthComparison,
  getRecentDaysFocus,
  getTimeOfDayTendency,
  getWeekdayTendency,
  resolvePeriodRange,
  resolvePreviousPeriodRange,
} from "@/utils/focusStats";
import { FOCUS_ANALYTICS_RANGES } from "@/constants/focusAnalyticsLimits";
import { formatLocalDate } from "@/utils/date";
import { shareFocusHistoryCsv } from "@/services/focusCsvExportService";
import { useLocale } from "@/context/LocaleContext";
import { TranslationKey } from "@/i18n/translations";

type RangeValue = (typeof FOCUS_ANALYTICS_RANGES)[number];

const RANGE_LABEL_KEYS: Record<RangeValue, TranslationKey> = {
  today: "records.rangeToday",
  last7Days: "records.rangeLast7Days",
  last30Days: "records.rangeLast30Days",
  thisWeek: "records.rangeThisWeek",
  thisMonth: "records.rangeThisMonth",
  thisYear: "records.rangeThisYear",
  allTime: "records.rangeAllTime",
  custom: "records.rangeCustom",
};

export default function RecordsScreen() {
  const router = useRouter();
  const { t, locale } = useLocale();
  const { focusHistory, events, refreshFocusHistory } = useAppData();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedRange, setSelectedRange] = useState<RangeValue>("today");
  const [customRange, setCustomRange] = useState<DateKeyRange>(() => {
    const todayKey = formatLocalDate(new Date());
    return { startDateKey: todayKey, endDateKey: todayKey };
  });
  const [customRangeModalVisible, setCustomRangeModalVisible] = useState(false);
  const [csvExporting, setCsvExporting] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      await refreshFocusHistory();
    } catch (e) {
      console.warn("[RecordsScreen] 集中記録の読み込みに失敗しました", e);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [refreshFocusHistory]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初回マウント時のみ実行する
  }, []);


  const periodRange = useMemo<DateKeyRange | null>(() => {
    if (selectedRange === "custom") return customRange;
    return resolvePeriodRange(selectedRange);
  }, [selectedRange, customRange]);

  const previousPeriodRange = useMemo(
    () => resolvePreviousPeriodRange(periodRange),
    [periodRange]
  );

  const recordsInPeriod = useMemo(
    () => filterRecordsInRange(focusHistory, periodRange),
    [focusHistory, periodRange]
  );
  const recordsInPreviousPeriod = useMemo(
    () => filterRecordsInRange(focusHistory, previousPeriodRange),
    [focusHistory, previousPeriodRange]
  );

  const summary = useMemo(() => computePeriodSummary(recordsInPeriod), [recordsInPeriod]);
  const previousSummary = useMemo(
    () => computePeriodSummary(recordsInPreviousPeriod),
    [recordsInPreviousPeriod]
  );
  const completionRate = useMemo(() => computeCompletionRate(recordsInPeriod), [recordsInPeriod]);
  const periodComparison = useMemo(
    () => (previousPeriodRange ? computePeriodComparison(summary, previousSummary) : null),
    [previousPeriodRange, summary, previousSummary]
  );
  const currentStreak = useMemo(() => computeCurrentStreakDays(focusHistory), [focusHistory]);
  const longestStreakEver = useMemo(
    () => computeLongestStreakDaysEver(focusHistory),
    [focusHistory]
  );
  const recentDaysPoints = useMemo(() => getRecentDaysFocus(focusHistory, 7), [focusHistory]);

  // Portfolio Edition: 履歴の表示件数に上限を設けない。
  const historyToShow = focusHistory;

  // （recordsInPeriodをそのまま使う＝完了・中断のいずれも含み、検索/絞り込みは行わない）。
  // 実際の購入導線・新しい画面遷移は追加しない。
  const handleCsvExport = useCallback(async () => {
    setCsvExporting(true);
    try {
      await shareFocusHistoryCsv(recordsInPeriod, {
        unknownCalendar: t("records.unknownCalendar"),
        calendarTypeMy: t("records.calendarTypeMy"),
        calendarTypeShared: t("records.calendarTypeShared"),
        statusCompleted: t("records.completedLabel"),
        statusIncomplete: t("records.statusIncomplete"),
      });
    } catch (e) {
      console.warn("[RecordsScreen] CSV出力に失敗しました", e);
      Alert.alert(t("records.csvExportFailedMessage"));
    } finally {
      setCsvExporting(false);
    }
  }, [recordsInPeriod, t]);

  const calendarStats = useMemo(
    () => getFocusByCalendar(recordsInPeriod, t("records.unknownCalendar")),
    [recordsInPeriod, t]
  );
  const interruptionStats = useMemo(
    () => getInterruptionStats(recordsInPeriod),
    [recordsInPeriod]
  );
  const weekdayTendency = useMemo(
    () => getWeekdayTendency(recordsInPeriod),
    [recordsInPeriod]
  );
  const timeOfDayTendency = useMemo(
    () => getTimeOfDayTendency(recordsInPeriod),
    [recordsInPeriod]
  );

  // 既存の詳細分析（無改修・期間スイッチャーに依存しない従来どおりの固定ウィンドウ）
  const legacyStats = useMemo(
    () =>
      ({
            monthly: getPreviousMonthComparison(focusHistory),
            last12Months: getLast12MonthsFocus(focusHistory, new Date(), locale),
            byTask: getFocusByTask(focusHistory, events, 5, t),
      }),
    [focusHistory, events, locale, t]
  );
  const ongoingStreaks = useMemo(
    () => streaksByTask(focusHistory),
    [focusHistory]
  );

  if (loading) return <LoadingView />;

  const hasAnyHistory = focusHistory.length > 0;

  if (loadError) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <ScreenHeader title={t("records.screenTitle")} />
        <View style={styles.centerFill}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.stateTitle}>{t("records.loadFailedMessage")}</Text>
          <PrimaryButton
            label={t("records.reloadButton")}
            onPress={load}
            style={{ marginTop: spacing.lg }}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (!hasAnyHistory) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <ScreenHeader title={t("records.screenTitle")} />
        <View style={styles.centerFill}>
          <Ionicons name="stats-chart-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.stateTitle}>{t("records.noHistoryEmptyTitle")}</Text>
          <Text style={styles.stateBody}>{t("records.noHistoryEmptyBody")}</Text>
          <PrimaryButton
            label={t("records.createFocusTaskButton")}
            onPress={() => router.push("/focus/new")}
            style={{ marginTop: spacing.lg }}
          />
        </View>
      </SafeAreaView>
    );
  }

  const rangeOptions: PeriodSwitcherOption<RangeValue>[] = FOCUS_ANALYTICS_RANGES.map(
    (value) => ({ value, label: t(RANGE_LABEL_KEYS[value]) })
  );

  const handleSelectRange = (value: RangeValue) => {
    if (value === "custom") {
      setCustomRangeModalVisible(true);
      return;
    }
    setSelectedRange(value);
  };

  const totalTimeLabel = formatFocusDuration(Math.round(summary.totalCreditedSeconds / 60), locale);
  const averageTimeLabel = formatFocusDuration(
    Math.round(summary.averageCreditedSeconds / 60),
    locale
  );

  const listHeader = (
    <>
      <PeriodSwitcher options={rangeOptions} selected={selectedRange} onSelect={handleSelectRange} />

      <View style={styles.statRow}>
        <StatCard icon="time-outline" label={t("records.periodTotalTimeLabel")} value={totalTimeLabel} />
        <StatCard
          icon="checkmark-circle-outline"
          label={t("records.periodCompletedCountLabel")}
          value={t("records.completedCount", { count: summary.completedCount })}
        />
      </View>
      <View style={styles.statRow}>
        <StatCard
          icon="speedometer-outline"
          label={t("records.periodAverageTimeLabel")}
          value={averageTimeLabel}
        />
        <StatCard
          icon="flame-outline"
          label={t("records.currentStreakLabel")}
          value={t("records.streakDaysCount", { count: currentStreak })}
          tone="focus"
        />
      </View>

      {recordsInPeriod.length === 0 && (
        <Text style={styles.noDataInPeriodHint}>{t("records.noHistoryInPeriod")}</Text>
      )}

      <RecentDaysChart points={recentDaysPoints} />

      <View style={styles.rateCard}>
        <Text style={styles.rateLabel}>{t("records.completionRateLabel")}</Text>
        <Text style={styles.rateValue}>
          {completionRate.ratePercent === null
            ? t("records.noDataLabel")
            : `${completionRate.ratePercent}%`}
        </Text>
      </View>

      <View style={styles.csvSection}>
        <PrimaryButton
          label={t("records.csvExportButton")}
          variant="secondary"
          onPress={handleCsvExport}
          disabled={csvExporting || recordsInPeriod.length === 0}
          loading={csvExporting}
        />
      </View>

      <Text style={styles.standaloneSectionTitle}>{t("records.recentHistoryLabel")}</Text>
    </>
  );

  const listFooter = (
    <View>
      {periodComparison && (
        <View style={styles.rateCard}>
          <Text style={styles.rateLabel}>{t("records.periodComparisonLabel")}</Text>
          <Text style={styles.rateValue}>
            {periodComparison.totalCreditedSecondsChangePercent === null
              ? t("records.newLabel")
              : t("records.periodComparisonChange", {
                  sign: periodComparison.totalCreditedSecondsChangePercent >= 0 ? "+" : "",
                  percent: periodComparison.totalCreditedSecondsChangePercent,
                })}
          </Text>
        </View>
      )}

      <View style={styles.statRow}>
        <StatCard
          icon="trophy-outline"
          label={t("records.longestStreakEverLabel")}
          value={t("records.streakDaysCount", { count: longestStreakEver })}
          tone="focus"
        />
      </View>

      {/* カレンダー別（新規・期間連動） */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("records.byCalendarLabel")}</Text>
        {calendarStats.length === 0 ? (
          <Text style={styles.emptyHint}>{t("records.noDataLabel")}</Text>
        ) : (
          calendarStats.map((c) => (
            <View key={c.calendarId} style={styles.taskRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.taskTitle}>{c.name}</Text>
                <Text style={styles.taskSub}>
                  {c.calendarType === "shared"
                    ? t("records.calendarTypeShared")
                    : c.calendarType === "my"
                      ? t("records.calendarTypeMy")
                      : ""}
                  {" ・ "}
                  {c.shareOfTotalPercent}%
                </Text>
              </View>
              <Text style={styles.taskMinutes}>
                {formatFocusDuration(Math.round(c.totalCreditedSeconds / 60), locale)}
              </Text>
            </View>
          ))
        )}
      </View>

      {/* 曜日別・時間帯別傾向（新規・期間連動・完遂率つき） */}
      {weekdayTendency && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("records.byWeekdayLabel")}</Text>
          <View style={styles.weekdayRow}>
            {weekdayTendency.stats.map((w) => {
              const dayLabel = weekdayLabelFromMondayFirst(w.weekday, t);
              const durationLabel = formatFocusDuration(
                Math.round(w.totalCreditedSeconds / 60),
                locale
              );
              const rateLabel = w.completionRatePercent === null ? "-" : `${w.completionRatePercent}%`;
              return (
                <View
                  key={w.weekday}
                  style={styles.weekdayCell}
                  accessible
                  accessibilityLabel={`${dayLabel} ${durationLabel} ${rateLabel} ${t("records.completedCount", { count: w.startedCount })}`}
                >
                  <Text style={styles.weekdayDayLabel}>{dayLabel}</Text>
                  <Text style={styles.weekdayMinutes}>{durationLabel}</Text>
                  <Text style={styles.weekdayLabel}>{rateLabel}</Text>
                </View>
              );
            })}
          </View>
          <Text style={styles.topHint}>
            {weekdayTendency.bestCompletionRateWeekday === null
              ? t("records.insufficientDataLabel")
              : t("records.weekdayTendencyBestHint", {
                  label: weekdayLabelFromMondayFirst(weekdayTendency.bestCompletionRateWeekday, t),
                })}
          </Text>
        </View>
      )}

      {timeOfDayTendency && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("records.byTimeOfDayLabel")}</Text>
          <View style={styles.weekdayRow}>
            {timeOfDayTendency.stats.map((p) => {
              const periodLabel = timeOfDayPeriodLabel(p.period, t);
              const durationLabel = formatFocusDuration(
                Math.round(p.totalCreditedSeconds / 60),
                locale
              );
              const rateLabel = p.completionRatePercent === null ? "-" : `${p.completionRatePercent}%`;
              return (
                <View
                  key={p.period}
                  style={styles.weekdayCell}
                  accessible
                  accessibilityLabel={`${periodLabel} ${durationLabel} ${rateLabel} ${t("records.completedCount", { count: p.startedCount })}`}
                >
                  <Text style={styles.weekdayDayLabel} numberOfLines={1}>
                    {periodLabel}
                  </Text>
                  <Text style={styles.weekdayMinutes}>{durationLabel}</Text>
                  <Text style={styles.weekdayLabel}>{rateLabel}</Text>
                </View>
              );
            })}
          </View>
          <Text style={styles.topHint}>
            {timeOfDayTendency.bestCompletionRatePeriod === null
              ? t("records.insufficientDataLabel")
              : t("records.timeOfDayTendencyBestHint", {
                  label: timeOfDayPeriodLabel(timeOfDayTendency.bestCompletionRatePeriod, t),
                })}
          </Text>
        </View>
      )}

      {/* 中断分析（新規・期間連動） */}
      {interruptionStats && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("records.interruptionAnalysisLabel")}</Text>
          <View style={styles.statRow}>
            <StatCard
              icon="play-circle-outline"
              label={t("records.periodCompletedCountLabel")}
              value={t("records.completedCount", { count: interruptionStats.completedCount })}
            />
            <StatCard
              icon="pause-circle-outline"
              label={t("records.statusIncomplete")}
              value={t("records.completedCount", { count: interruptionStats.incompleteCount })}
            />
          </View>
          <View style={styles.statRow}>
            <StatCard
              icon="repeat-outline"
              label={t("records.pauseCountLabel")}
              value={t("records.completedCount", { count: interruptionStats.totalInterruptions })}
            />
            <StatCard
              icon="calculator-outline"
              label={t("records.periodAverageTimeLabel")}
              value={`${interruptionStats.averageInterruptions}`}
            />
          </View>
          <Text style={styles.topHint}>
            {interruptionStats.mostInterruptedWeekday === null
              ? t("records.insufficientDataLabel")
              : weekdayLabelFromMondayFirst(interruptionStats.mostInterruptedWeekday, t)}
          </Text>
        </View>
      )}

      {/* 既存の詳細分析（無改修のまま移設） */}
      {legacyStats && (
        <>
          {ongoingStreaks.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t("records.ongoingTasksLabel")}</Text>
              {ongoingStreaks.map((s) => (
                <View key={s.taskTitle} style={styles.taskRow}>
                  <View style={styles.taskIcon}>
                    <Text style={styles.taskIconText}>{s.taskTitle.slice(0, 2)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.taskTitle}>{s.taskTitle}</Text>
                    <Text style={styles.taskSub}>
                      {t("records.streakDaysCount", { count: s.currentStreakDays })}
                    </Text>
                  </View>
                  <Text style={styles.taskMinutes}>{formatFocusDuration(s.totalMinutes, locale)}</Text>
                </View>
              ))}
            </View>
          )}

          <View style={styles.monthlyCard}>
            <Text style={styles.monthlyCardLabel}>{t("records.monthlyFocusLabel")}</Text>
            <Text style={styles.monthlyCardValue}>
              {formatFocusDuration(legacyStats.monthly.currentMinutes, locale)}
            </Text>
            <Text style={styles.monthlyCardChange}>
              {legacyStats.monthly.changePercent === null
                ? t("records.newLabel")
                : t("records.monthOverMonth", {
                    sign: legacyStats.monthly.changePercent >= 0 ? "+" : "",
                    percent: legacyStats.monthly.changePercent,
                  })}
            </Text>
          </View>

          <MonthlyTrendChart months={legacyStats.last12Months} />

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t("records.byTaskLabel")}</Text>
            {legacyStats.byTask.length === 0 ? (
              <Text style={styles.emptyHint}>{t("records.noDataLabel")}</Text>
            ) : (
              legacyStats.byTask.map((taskStat, index) => (
                <View key={taskStat.taskId} style={styles.taskRow}>
                  <View style={styles.taskIcon}>
                    <Text style={styles.taskIconText}>{index + 1}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.taskTitle}>{taskStat.title}</Text>
                  </View>
                  <Text style={styles.taskMinutes}>{formatFocusDuration(taskStat.minutes, locale)}</Text>
                </View>
              ))
            )}
          </View>
        </>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <PageLayout header={<ScreenHeader title={t("records.screenTitle")} />}>
        <FocusHistoryList
          records={historyToShow}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
        />
      </PageLayout>
      <CustomRangeModal
        visible={customRangeModalVisible}
        initialRange={customRange}
        onClose={() => setCustomRangeModalVisible(false)}
        onConfirm={(range) => {
          setCustomRange(range);
          setSelectedRange("custom");
        }}
      />
    </SafeAreaView>
  );
}

/** 月曜始まりのインデックス(0=月)から曜日ラベルを引く（focusStats.tsの内部並びに合わせる）。 */
function weekdayLabelFromMondayFirst(mondayFirstIndex: number, t: (key: TranslationKey) => string): string {
  const keys: TranslationKey[] = [
    "date.weekday1",
    "date.weekday2",
    "date.weekday3",
    "date.weekday4",
    "date.weekday5",
    "date.weekday6",
    "date.weekday0",
  ];
  return t(keys[mondayFirstIndex] ?? "date.weekday0");
}

function timeOfDayPeriodLabel(
  period: "morning" | "afternoon" | "evening" | "midnight",
  t: (key: TranslationKey) => string
): string {
  const keys: Record<typeof period, TranslationKey> = {
    morning: "records.periodMorning",
    afternoon: "records.periodAfternoon",
    evening: "records.periodEvening",
    midnight: "records.periodMidnight",
  };
  return t(keys[period]);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centerFill: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  stateTitle: {
    marginTop: spacing.md,
    fontSize: 15,
    fontWeight: "700",
    color: colors.textSecondary,
    textAlign: "center",
  },
  stateBody: {
    marginTop: spacing.xs,
    fontSize: 13,
    color: colors.textTertiary,
    textAlign: "center",
  },
  statRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  noDataInPeriodHint: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    fontSize: 12,
    color: colors.textTertiary,
  },
  rateCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  rateLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  rateValue: {
    fontSize: 24,
    fontWeight: "800",
    color: colors.textPrimary,
    marginTop: 2,
  },
  csvSection: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },


  section: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.xl,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  standaloneSectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
    marginTop: spacing.xl,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  taskIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  taskIconText: {
    color: colors.primaryStrong,
    fontWeight: "700",
    fontSize: 12,
  },
  taskTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  taskSub: {
    fontSize: 12,
    color: colors.meeting,
    marginTop: 2,
  },
  taskMinutes: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  monthlyCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  monthlyCardLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  monthlyCardValue: {
    fontSize: 24,
    fontWeight: "800",
    color: colors.textPrimary,
    marginTop: 2,
  },
  monthlyCardChange: {
    fontSize: 12,
    fontWeight: "700",
    marginTop: 4,
    color: colors.textTertiary,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  weekdayRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  weekdayCell: {
    alignItems: "center",
    flex: 1,
    gap: 4,
  },
  weekdayLabel: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  weekdayDayLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  weekdayMinutes: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  topHint: {
    marginTop: spacing.sm,
    fontSize: 12,
    color: colors.textSecondary,
  },

});
