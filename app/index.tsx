import React, { useMemo, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { AppEvent, isFocusTask } from "@/types/event";
import { useAppData } from "@/context/AppDataContext";
import { filterVisibleEvents } from "@/utils/eventVisibility";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { CalendarHeader } from "@/components/calendar/CalendarHeader";
import { CalendarViewMode } from "@/components/calendar/ViewSwitcher";
import { BottomActionBar } from "@/components/calendar/BottomActionBar";
import { PageLayout } from "@/components/common/PageLayout";
import { MonthView, MonthViewHandle } from "@/components/calendar/MonthView";
import { WeekView } from "@/components/calendar/WeekView";
import { DayView } from "@/components/calendar/DayView";
import { CalendarVisibilityChips } from "@/components/calendar/CalendarVisibilityChips";
import { LoadingView } from "@/components/common/LoadingView";
import { AI_SUPPORT_FEATURE_ENABLED } from "@/config/featureFlags";
import { useLocale } from "@/context/LocaleContext";
import { useHolidayRegion } from "@/context/HolidayRegionContext";
import { HolidayRegion, SUPPORTED_HOLIDAY_REGIONS } from "@/types/holidayRegion";
import { PickerModal, PickerOption } from "@/components/forms/PickerModal";
import { SupportedLocale } from "@/i18n/translations";
import {
  resolveCalendarHeaderTitle,
  todayLocalDateString,
  addDays,
  addMonthsToPreferredDay,
  formatLocalDate,
  parseLocalDateString,
} from "@/utils/date";
import { YearMonthPicker } from "@/components/calendar/YearMonthPicker";
import { getActiveFocusSession } from "@/storage/focusSessionRepository";
import { useDueFocusTaskWatcher } from "@/hooks/useDueFocusTaskWatcher";

// menu.tsx（オプション画面）にある祝日の国・地域設定と同じ表示文言を、この画面の
// 表示設定シートでも使うための対応表（menu.tsx側は変更しない、独立した表示先を増やすだけ）。
const HOLIDAY_REGION_LABEL_KEY: Record<HolidayRegion, "holidayRegion.jp" | "holidayRegion.us" | "holidayRegion.gb" | "holidayRegion.none"> = {
  JP: "holidayRegion.jp",
  US: "holidayRegion.us",
  GB: "holidayRegion.gb",
  NONE: "holidayRegion.none",
};

export default function CalendarScreen() {
  const router = useRouter();
  const { loading, events, overlaySettings, refresh } = useAppData();
  const { t, locale, setLocale } = useLocale();
  const { region: holidayRegion, setRegion: setHolidayRegion } = useHolidayRegion();
  const [viewMode, setViewMode] = useState<CalendarViewMode>("week");
  const [focusedDate, setFocusedDate] = useState(todayLocalDateString());
  /**
   * [P0074 CORRECT-F009-001] 月送りナビゲーションが月末クランプを跨いでも
   * ユーザーの「論理的に希望する日」を保持するためのアンカー。addMonths自体は
   * 純粋関数のまま変更せず、この永続化された希望日をnavigate()内で
   * addMonthsToPreferredDayへ明示的に渡すことで往復可逆性を実現する
   * （例: 1/31→+1ヶ月→2/28(クランプ)→+1ヶ月→3/31(希望日31を復元)）。
   * 月送り以外の経路でfocusedDateが変わる場合は、必ずこのrefも同じ日付の
   * 日部分に更新する（Today・年月ジャンプ・週/日表示でのナビゲーション/日付選択）。
   * 月送りでクランプが発生した結果だけはこのrefを一切書き換えない。
   */
  const preferredDayRef = useRef<number>(parseLocalDateString(focusedDate).getDate());
  const [activeFocusTaskId, setActiveFocusTaskId] = useState<string | null>(null);
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  // 2026-08: 従来は言語ピッカーだけを開いていたグローブアイコンを、言語・祝日の
  // 2項目を選べる小さな表示設定シートの入口にする（オプション画面の祝日設定は
  // 残したまま、こちらにも同じ設定を追加する）。
  const [displaySettingsVisible, setDisplaySettingsVisible] = useState(false);
  const [languageOptionsVisible, setLanguageOptionsVisible] = useState(false);
  const [holidayRegionPickerVisible, setHolidayRegionPickerVisible] = useState(false);
  const monthViewRef = useRef<MonthViewHandle>(null);
  // カレンダー画面が実際にフォーカスされているか（別画面・モーダルを開いている間は
  // マウントされたまま残る可能性があるため、AppStateがactiveであることだけを根拠にしない）。
  const isFocused = useIsFocused();
  // 開始時刻を過ぎている・未開始の集中予定を1件だけ非ブロッキングに案内する。通知の予約・
  // 受信状態には依存せず、events変化・画面フォーカス・AppState復帰・開始時刻到達（timeout）
  // のいずれでも再判定する。自動遷移はしない（フォーム編集中の他画面を強制的に破棄しないため）。
  const { dueFocusTask, dismiss: dismissDueFocusTask } = useDueFocusTaskWatcher(events, isFocused);

  useFocusEffect(
    React.useCallback(() => {
      let mounted = true;
      // DATA-F002-002: refresh()はevents/userCalendars等の形状不正なトップレベルデータに
      // 対してthrowするようになったため、未処理のPromise拒否を防ぐためだけに明示的に
      // catchする（開発時のみログ）。失敗時は直前まで表示していた内容をそのまま維持する
      // （起動時の初期化（AppDataInitializationGate）とは別経路の再取得のため、ここで
      // 新たにエラー画面を出す必要はない）。
      refresh().catch((e) => {
        if (__DEV__) {
          console.warn("[CalendarScreen] refresh失敗", e);
        }
      });
      getActiveFocusSession().then((s) => {
        const isActive = !!s && s.status !== "completed" && s.status !== "cancelled";
        if (mounted) setActiveFocusTaskId(isActive ? s!.sourceEventId : null);
      });
      return () => {
        mounted = false;
      };
    }, [refresh])
  );

  const visibleEvents = useMemo(
    () => filterVisibleEvents(events, overlaySettings),
    [events, overlaySettings]
  );

  const title = resolveCalendarHeaderTitle(viewMode === "day", focusedDate, locale);

  const handleSelectEvent = (event: AppEvent) => {
    if (isFocusTask(event)) {
      router.push({ pathname: "/focus/[id]", params: { id: event.id } });
    } else {
      router.push({ pathname: "/event/[id]", params: { id: event.id } });
    }
  };

  const handleCreateAt = (date: string, startTime: string) => {
    router.push({
      pathname: "/event/new",
      params: { date, startTime },
    });
  };

  /**
   * 矢印ボタン（月表示ではMonthViewのアニメーション経由でこの関数へ委譲される）・
   * スワイプ確定・端到達ドラッグの全てが最終的にこの同一関数を呼ぶ（月表示では
   * onDragNavigateMonth/onSwipeNavigateMonthの両方がこのnavigateそのものであり、
   * 矢印ボタンもMonthViewHandle.animateToMonthが内部でonSwipeNavigateMonthを
   * 呼ぶ設計のため、3経路が単一の月送りロジックを共有する——別々の実装を作らない）。
   */
  const navigate = (direction: -1 | 1) => {
    if (viewMode === "month") {
      // 月送り自体はpreferredDayRefを書き換えない（クランプされた結果で
      // 希望日を上書きしないことが、往復可逆性を保つための要）。
      setFocusedDate((current) =>
        addMonthsToPreferredDay(current, direction, preferredDayRef.current)
      );
      return;
    }
    setFocusedDate((current) => {
      const next = addDays(current, direction * (viewMode === "week" ? 7 : 1));
      preferredDayRef.current = parseLocalDateString(next).getDate();
      return next;
    });
  };

  /**
   * 矢印ボタン用（Stage 2）。月表示中はMonthViewのスライドアニメーション経由で移動させ、
   * アニメーション完了後にMonthView自身がonSwipeNavigateMonth（＝navigate）を呼んで
   * focusedDateを更新する。週・日表示中はmonthViewRefがnull（MonthView自体が
   * マウントされていない）ため、従来通りnavigateを直接呼ぶ。
   */
  const handleArrowNavigate = (direction: -1 | 1) => {
    if (monthViewRef.current) {
      monthViewRef.current.animateToMonth(direction);
      return;
    }
    navigate(direction);
  };

  const chooseMonth = (year: number, month: number) => {
    // 年月ジャンプは常に1日を指すため、希望日アンカーも1へリセットする
    // （正本§2「年/月ジャンプ」はアンカーリセット条件の1つ）。
    preferredDayRef.current = 1;
    setFocusedDate(formatLocalDate(new Date(year, month, 1)));
    setDatePickerVisible(false);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <PageLayout
        header={
          <CalendarHeader
            title={title}
            viewMode={viewMode}
            onChangeViewMode={setViewMode}
            onPressMenu={() => router.push("/menu")}
            onPressAdd={() =>
              // 2026-07-31: paramsを一切渡さない従来の呼び出しだと、直前に別経路
              // （週・日表示のタイムラインタップ等、date/startTimeを明示指定する経路）で
              // 開いた/event/newのルートインスタンス・パラメータが実機環境で再利用され、
              // 古いstartTimeが残ったまま表示される事例が報告された。openedAtへ毎回異なる
              // タイムスタンプを積むことで、この「＋」を押すたびに必ず新規かつ一意な
              // ナビゲーションになることを保証し、古いパラメータの再利用を防ぐ。
              // NewEventScreen側はdate/startTime以外のパラメータを読まないため、
              // 初期値の計算ロジック自体（30分切り上げ等）には影響しない。
              router.push({
                pathname: "/event/new",
                params: { openedAt: String(Date.now()) },
              })
            }
            onPressTitle={() => setDatePickerVisible(true)}
            onPressLanguage={() => setDisplaySettingsVisible(true)}
            onNavigatePrevious={() => handleArrowNavigate(-1)}
            onNavigateNext={() => handleArrowNavigate(1)}
            onPressToday={() => {
              const today = todayLocalDateString();
              preferredDayRef.current = parseLocalDateString(today).getDate();
              setFocusedDate(today);
            }}
          />
        }
        footer={
          <BottomActionBar
            onPressOverlay={() => router.push("/overlay")}
            onPressFocus={() => {
              if (activeFocusTaskId) {
                router.push({
                  pathname: "/focus/active/[id]",
                  params: { id: activeFocusTaskId },
                });
              } else {
                router.push("/focus/new");
              }
            }}
            onPressAI={AI_SUPPORT_FEATURE_ENABLED ? () => router.push("/ai") : undefined}
            onPressCalendars={() => router.push("/calendars")}
            onPressActivity={() => router.push("/activity")}
            focusActive={!!activeFocusTaskId}
          />
        }
      >
        <CalendarVisibilityChips onPressManage={() => router.push("/overlay")} />
        {dueFocusTask && (
          <View style={styles.dueFocusBanner}>
            <Ionicons name="alarm-outline" size={20} color={colors.primary} />
            <View style={styles.dueFocusBannerTextWrap}>
              <Text style={styles.dueFocusBannerTitle}>{t("dueFocusBanner.title")}</Text>
              <Text style={styles.dueFocusBannerSubtitle} numberOfLines={1}>
                {dueFocusTask.title}
              </Text>
            </View>
            <Pressable
              onPress={() => {
                const task = dueFocusTask;
                dismissDueFocusTask();
                router.push({
                  pathname: "/focus/active/[id]",
                  params: { id: task.id, autostart: "1" },
                });
              }}
              style={styles.dueFocusBannerButton}
              accessibilityRole="button"
              accessibilityLabel={t("dueFocusBanner.startButton")}
            >
              <Text style={styles.dueFocusBannerButtonText}>{t("dueFocusBanner.startButton")}</Text>
            </Pressable>
            <Pressable
              onPress={() => dismissDueFocusTask()}
              style={styles.dueFocusBannerDismiss}
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
              hitSlop={8}
            >
              <Ionicons name="close" size={16} color={colors.textTertiary} />
            </Pressable>
          </View>
        )}
        {!loading && events.length > 0 && visibleEvents.length === 0 && (
          <View style={styles.noVisibleEventsHint}>
            <Text style={styles.noVisibleEventsHintText}>{t("common.noVisibleEventsHint")}</Text>
          </View>
        )}
        <View style={styles.body}>
          {loading ? (
            <LoadingView />
          ) : viewMode === "month" ? (
            <MonthView
              ref={monthViewRef}
              focusedDate={focusedDate}
              events={visibleEvents}
              onSelectDate={(date) =>
                router.push({ pathname: "/day/[date]", params: { date } })
              }
              onSelectEvent={handleSelectEvent}
              onDragNavigateMonth={navigate}
              onSwipeNavigateMonth={navigate}
            />
          ) : viewMode === "week" ? (
            <WeekView
              focusedDate={focusedDate}
              events={visibleEvents}
              onSelectDate={(date) => {
                preferredDayRef.current = parseLocalDateString(date).getDate();
                setFocusedDate(date);
                setViewMode("day");
              }}
              onSelectEvent={handleSelectEvent}
              onCreateAt={handleCreateAt}
              onNavigateWeek={(amount) =>
                setFocusedDate((d) => {
                  const next = addDays(d, amount * 7);
                  preferredDayRef.current = parseLocalDateString(next).getDate();
                  return next;
                })
              }
            />
          ) : (
            <DayView
              focusedDate={focusedDate}
              events={visibleEvents}
              onSelectEvent={handleSelectEvent}
              onCreateAt={handleCreateAt}
            />
          )}
        </View>
      </PageLayout>
      <YearMonthPicker visible={datePickerVisible} focusedDate={focusedDate} onClose={() => setDatePickerVisible(false)} onChoose={chooseMonth} />
      <DisplaySettingsSheet
        visible={displaySettingsVisible}
        languageValue={locale === "ja" ? t("language.jaLabel") : t("language.enLabel")}
        holidayRegionValue={t(HOLIDAY_REGION_LABEL_KEY[holidayRegion])}
        onClose={() => setDisplaySettingsVisible(false)}
        onPressLanguageRow={() => setLanguageOptionsVisible(true)}
        onPressHolidayRegionRow={() => setHolidayRegionPickerVisible(true)}
      />
      <PickerModal
        visible={languageOptionsVisible}
        title={t("language.pickerTitle")}
        options={[
          { id: "ja", label: t("language.jaLabel") },
          { id: "en", label: t("language.enLabel") },
        ]}
        selectedIds={[locale]}
        onClose={() => setLanguageOptionsVisible(false)}
        onApply={(ids) => {
          const next = ids[0];
          if (next === "ja" || next === "en") setLocale(next as SupportedLocale);
        }}
      />
      <PickerModal
        visible={holidayRegionPickerVisible}
        title={t("holidayRegion.pickerTitle")}
        options={SUPPORTED_HOLIDAY_REGIONS.map<PickerOption>((option) => ({
          id: option.region,
          label: t(HOLIDAY_REGION_LABEL_KEY[option.region]),
        }))}
        selectedIds={[holidayRegion]}
        onClose={() => setHolidayRegionPickerVisible(false)}
        onApply={(ids) => {
          const next = ids[0] as HolidayRegion | undefined;
          if (next) setHolidayRegion(next);
        }}
      />
    </SafeAreaView>
  );
}

/**
 * グローブアイコンから開く、表示言語・祝日の国地域をまとめた小さな設定シート。
 * 実際の選択自体は既存のPickerModal（言語・祝日それぞれ）にそのまま任せ、
 * このシートは行を2つ並べて入口を提供するだけ（menu.tsxの行リストと同じ見た目のパターン）。
 * 祝日の国・地域設定はオプション画面(menu.tsx)にも引き続き存在し、そちらは変更していない。
 */
function DisplaySettingsSheet({
  visible,
  languageValue,
  holidayRegionValue,
  onClose,
  onPressLanguageRow,
  onPressHolidayRegionRow,
}: {
  visible: boolean;
  languageValue: string;
  holidayRegionValue: string;
  onClose: () => void;
  onPressLanguageRow: () => void;
  onPressHolidayRegionRow: () => void;
}) {
  const { t } = useLocale();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <SafeAreaView style={styles.sheetContainer}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{t("language.sheetTitle")}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.sheetCloseBtn}
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>
          <Pressable
            onPress={onPressLanguageRow}
            style={styles.sheetRow}
            accessibilityRole="button"
            accessibilityLabel={`${t("language.pickerTitle")}${t("common.a11ySeparator")}${languageValue}`}
          >
            <Ionicons name="language-outline" size={22} color={colors.primary} />
            <Text style={styles.sheetRowLabel}>{t("language.pickerTitle")}</Text>
            <Text style={styles.sheetRowValue}>{languageValue}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </Pressable>
          <Pressable
            onPress={onPressHolidayRegionRow}
            style={styles.sheetRow}
            accessibilityRole="button"
            accessibilityLabel={`${t("menu.holidayRegionLabel")}${t("common.a11ySeparator")}${holidayRegionValue}`}
          >
            <Ionicons name="earth-outline" size={22} color={colors.primary} />
            <Text style={styles.sheetRowLabel}>{t("menu.holidayRegionLabel")}</Text>
            <Text style={styles.sheetRowValue}>{holidayRegionValue}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  body: {
    flex: 1,
    backgroundColor: colors.background,
  },
  noVisibleEventsHint: {
    // カレンダー本体の一部に見えないよう、フィルター欄と同じ補助サーフェス＋上下の区切り線を
    // 持つ独立した情報バーとして扱う（文言・表示条件自体は変更していない）。
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.calendarSubtleSurface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.calendarNormalDivider,
    borderBottomWidth: 1,
    borderBottomColor: colors.calendarMajorDivider,
  },
  noVisibleEventsHintText: {
    fontSize: 12,
    color: colors.textTertiary,
    textAlign: "center",
  },
  dueFocusBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.calendarMajorDivider,
  },
  dueFocusBannerTextWrap: {
    flex: 1,
  },
  dueFocusBannerTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.primaryStrong,
  },
  dueFocusBannerSubtitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textPrimary,
    marginTop: 1,
  },
  dueFocusBannerButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  dueFocusBannerButtonText: {
    color: colors.textInverse,
    fontSize: 13,
    fontWeight: "700",
  },
  dueFocusBannerDismiss: {
    width: minTapSize - 12,
    height: minTapSize - 12,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetBackdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: "flex-end" },
  sheetContainer: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  sheetTitle: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
  sheetCloseBtn: {
    width: minTapSize,
    height: minTapSize,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -spacing.sm,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: minTapSize + 8,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  sheetRowLabel: { fontSize: 16, color: colors.textPrimary, flex: 1 },
  sheetRowValue: { fontSize: 13, color: colors.textTertiary },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 24 },
  pickerCard: { maxHeight: "82%", backgroundColor: colors.surface, borderRadius: 20, padding: 16 },
  pickerTitle: { fontSize: 20, fontWeight: "800", color: colors.textPrimary, marginBottom: 12 },
  yearScroll: { flexGrow: 0 },
  yearGrid: { paddingBottom: 12 },
  yearBlock: { marginBottom: 18 },
  yearText: { fontSize: 16, fontWeight: "700", color: colors.textPrimary, marginBottom: 8 },
  monthGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  monthButton: { width: "23%", paddingVertical: 10, alignItems: "center", borderRadius: 10, backgroundColor: colors.surfaceAlt },
  monthSelected: { backgroundColor: colors.primary },
  monthText: { color: colors.textPrimary, fontWeight: "600" },
  monthTextSelected: { color: colors.textInverse },
  closeButton: { alignSelf: "flex-end", padding: 12 },
  pickerActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  todayButton: { padding: 12 },
  todayText: { color: colors.primary, fontWeight: "700" },
  closeText: { color: colors.primary, fontWeight: "700" },
});
