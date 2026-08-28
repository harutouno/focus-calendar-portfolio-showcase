import React from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppData } from "@/context/AppDataContext";
import { classifySharedCalendars } from "@/utils/calendarListRows";
import { isBaseCalendar } from "@/constants/calendarLimits";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import { toFriendlyMessage } from "@/utils/friendlyError";

interface ChipData {
  id: string;
  name: string;
  color: string;
  /** 共有状態アイコン。基本カレンダーはundefined（アイコンなし） */
  icon?: keyof typeof Ionicons.glyphMap;
}

interface Props {
  /** 右端の「⌄」を押したときに、既存の「表示するカレンダー」画面（/overlay）へ遷移させる */
  onPressManage: () => void;
}

/**
 * 月・週・日表示の共通ヘッダー直下に置く、TimeTree風のカレンダー表示切替チップ列。
 * 状態は既存のAppDataContext（overlaySettings/toggleCalendarVisibilityIntent）をそのまま使い、
 * 新しいstate・保存先は追加しない。表示フィルタリング（eventVisibility.ts）にも一切触れない。
 * 2026-07-31: 「main」チップも他のカレンダーと同じくvisibleCalendarIdsでON/OFFを判定・
 * トグルできるようにした（表示設定画面の再設計に合わせ、常時表示固定をやめた）。
 * 2026-08: 「main」（自分一人用）はAppDataContext.refresh()が起動時に実体化するため、
 * 通常はuserCalendarsに実データとして含まれる。起動直後のごく短い読み込み中など、
 * 万一まだ含まれていない場合だけ、既存のフォールバック文言でチップが消えないようにする。
 */
export function CalendarVisibilityChips({ onPressManage }: Props) {
  const { t } = useLocale();
  const { userCalendars, sharedCalendars, overlaySettings, toggleCalendarVisibilityIntent } =
    useAppData();

  const { solo, owner, joined } = classifySharedCalendars(sharedCalendars);
  const hasBaseCalendar = userCalendars.some((c) => isBaseCalendar(c.id));

  const chips: ChipData[] = [
    ...(hasBaseCalendar
      ? []
      : [{ id: "main", name: t("calendarVisibilityChips.mainChipName"), color: colors.primary }]),
    ...userCalendars.map<ChipData>((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      icon: isBaseCalendar(c.id) ? undefined : "lock-closed",
    })),
    ...solo.map<ChipData>((s) => ({
      id: s.calendar.id,
      name: s.calendar.name,
      color: s.calendar.color,
      icon: "lock-closed",
    })),
    ...owner.map<ChipData>((s) => ({
      id: s.calendar.id,
      name: s.calendar.name,
      color: s.calendar.color,
      icon: "people",
    })),
    ...joined.map<ChipData>((s) => ({
      id: s.calendar.id,
      name: s.calendar.name,
      color: s.calendar.color,
      icon: s.role === "editor" ? "people" : "eye",
    })),
  ];

  const isVisible = (chip: ChipData) =>
    overlaySettings.visibleCalendarIds.includes(chip.id);

  const handleToggle = (chip: ChipData) => {
    // [P0094 CORRECT-F019-001] マイカレンダー画面・/overlayと同じtoggleCalendarVisibilityIntent
    // を使い、マイ＋共有合計5個までの同時表示上限をここでも一貫して適用する（この一覧だけ
    // 上限を回避できてしまうことを防ぐため）。calendarIdだけをintentとして渡し、直列化された
    // 時点の最新値からトグル結果を導出することで、連続した2回のタップが互いを上書きしない。
    toggleCalendarVisibilityIntent(chip.id)
      .then((result) => {
        if (result.status === "limitReached") {
          Alert.alert(t("newCalendarModal.limitReachedTitle"), t("calendars.visibleLimitReachedMessage"));
        }
      })
      .catch(() => {
        Alert.alert(t("common.couldNotChange"), toFriendlyMessage(undefined, t("overlay.saveErrorFallback"), t));
      });
  };

  return (
    <View style={styles.row}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {chips.map((chip) => {
          const visible = isVisible(chip);
          return (
            <Pressable
              key={chip.id}
              onPress={() => handleToggle(chip)}
              style={[
                styles.chip,
                { borderColor: visible ? chip.color : colors.border },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: visible }}
              accessibilityLabel={`${chip.name}${
                visible
                  ? t("calendarVisibilityChips.suffixShowing")
                  : t("calendarVisibilityChips.suffixHidden")
              }`}
            >
              {visible && (
                <Ionicons name="checkmark" size={14} color={chip.color} style={styles.chipIcon} />
              )}
              {chip.icon && (
                <Ionicons
                  name={chip.icon}
                  size={12}
                  color={visible ? colors.textSecondary : colors.textTertiary}
                  style={styles.chipIcon}
                />
              )}
              <Text
                style={[styles.chipText, !visible && styles.chipTextHidden]}
                numberOfLines={1}
              >
                {chip.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable
        onPress={onPressManage}
        style={styles.manageButton}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("calendarVisibilityChips.manageA11y")}
      >
        <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    // フィルター欄は操作エリアの一部として、カレンダー本体よりわずかに沈んだ補助サーフェスにし、
    // 下端に主要区切り線（曜日ヘッダー/カレンダー本体との境目）を入れる。
    backgroundColor: colors.calendarSubtleSurface,
    borderBottomWidth: 1,
    borderBottomColor: colors.calendarMajorDivider,
  },
  scrollContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: minTapSize - 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    backgroundColor: colors.surface,
  },
  chipIcon: {
    marginRight: 4,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  chipTextHidden: {
    color: colors.textTertiary,
    fontWeight: "600",
  },
  manageButton: {
    width: minTapSize,
    height: minTapSize,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.xs,
  },
});
