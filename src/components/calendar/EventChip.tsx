import React from "react";
import { Pressable, StyleSheet, Text, View, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppEvent, isFocusTask, isNormalEvent } from "@/types/event";
import { colors } from "@/theme/colors";
import { radius } from "@/theme/spacing";
import { getCalendarOptions } from "@/constants/options";
import { useAppData } from "@/context/AppDataContext";
import { SyncStatus } from "@/types/sharing";
import { SyncStatusBadge } from "@/components/common/SyncStatusBadge";
import { useLocale } from "@/context/LocaleContext";
import { t as staticT } from "@/i18n/translations";

/** 共有カレンダーの予定だけ送信状態を返す。端末内予定はundefined（バッジ非表示） */
function useSharedSyncStatus(event: AppEvent): SyncStatus | undefined {
  const { sharedCalendars, syncStatusByEventId } = useAppData();
  const isShared = sharedCalendars.some((s) => s.calendar.id === event.calendarId);
  if (!isShared) return undefined;
  return syncStatusByEventId[event.id] ?? "synced";
}

export function eventColor(event: AppEvent): { bg: string; fg: string } {
  if (isFocusTask(event)) {
    return { bg: colors.focusSoft, fg: colors.focusStrong };
  }
  const option = getCalendarOptions(staticT).find((c) => c.id === event.calendarId);
  if (option?.id === "health") {
    return { bg: colors.meetingSoft, fg: colors.meeting };
  }
  return { bg: colors.primarySoft, fg: colors.primaryStrong };
}

/**
 * Stage I-6: 完了済みFocusTaskとして扱うかどうかの判定を一か所へ集約する。
 * 既存の型ガード（isFocusTask）を再利用し、タイトル文字列などでの推測は行わない。
 * 通常予定や、completedがfalse/undefinedのFocusTaskはfalseを返し、既存表示を維持する。
 */
export function isCompletedFocusTask(event: AppEvent): boolean {
  return isFocusTask(event) && event.completed === true;
}

interface CompactProps {
  event: AppEvent;
  onPress: (event: AppEvent) => void;
}

/** 月表示セル内で使う、1行に収まるコンパクトな予定チップ */
export function EventChipCompact({ event, onPress }: CompactProps) {
  const { t } = useLocale();
  const { bg, fg } = eventColor(event);
  const syncStatus = useSharedSyncStatus(event);
  const completed = isCompletedFocusTask(event);
  return (
    <Pressable
      onPress={() => onPress(event)}
      accessibilityLabel={
        completed ? `${t("common.completed")}${t("common.a11ySeparator")}${event.title}` : event.title
      }
      style={[styles.compact, { backgroundColor: bg, borderLeftColor: fg }, completed && styles.completed]}
    >
      {completed ? (
        <Ionicons name="checkmark-circle" size={9} color={fg} style={styles.lockIcon} />
      ) : (
        isFocusTask(event) && (
          <Ionicons name="lock-closed" size={9} color={fg} style={styles.lockIcon} />
        )
      )}
      <Text style={[styles.compactText, { color: fg }]} numberOfLines={1}>
        {event.title}
      </Text>
      {syncStatus && <View style={styles.syncBadge}><SyncStatusBadge status={syncStatus} size={9} /></View>}
    </Pressable>
  );
}

interface BlockProps {
  event: AppEvent;
  style: ViewStyle;
  onPress: (event: AppEvent) => void;
  dense?: boolean;
}

/** 週表示・日表示のタイムライン上に絶対配置される予定ブロック */
export function EventBlock({ event, style, onPress, dense }: BlockProps) {
  const { t } = useLocale();
  const { bg, fg } = eventColor(event);
  const syncStatus = useSharedSyncStatus(event);
  const completed = isCompletedFocusTask(event);
  return (
    <Pressable
      onPress={() => onPress(event)}
      accessibilityLabel={
        completed ? `${t("common.completed")}${t("common.a11ySeparator")}${event.title}` : event.title
      }
      style={[
        styles.block,
        { backgroundColor: bg, borderColor: fg },
        completed && styles.completed,
        style,
      ]}
    >
      <View style={styles.blockHeaderRow}>
        {completed ? (
          <Ionicons name="checkmark-circle" size={10} color={fg} style={styles.lockIcon} />
        ) : (
          isFocusTask(event) && (
            <Ionicons name="lock-closed" size={10} color={fg} style={styles.lockIcon} />
          )
        )}
        <Text
          style={[styles.blockTitle, { color: fg }, dense && styles.blockTitleDense]}
          numberOfLines={dense ? 1 : 2}
        >
          {event.title}
        </Text>
        {syncStatus && <SyncStatusBadge status={syncStatus} size={10} />}
      </View>
      {!dense && (
        <Text style={[styles.blockTime, { color: fg }]} numberOfLines={1}>
          {isNormalEvent(event) && event.allDay
            ? t("common.allDay")
            : `${event.startTime}${isFocusTask(event) ? t("common.rangeSeparator") : `-${event.endTime}`}`}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  compact: {
    borderRadius: 4,
    // 予定名が日付数字・祝日名と混ざらないよう、上の余白を少し増やす。左側にカテゴリ色の
    // 細いアクセントラインを付け、週・日表示のEventBlock（borderLeftWidth）と統一する。
    borderLeftWidth: 2,
    paddingHorizontal: 4,
    paddingVertical: 2,
    marginTop: 3,
    flexDirection: "row",
    alignItems: "center",
  },
  compactText: {
    fontSize: 10,
    fontWeight: "600",
  },
  /**
   * Stage I-6: 完了済みFocusTaskの強調を少し下げる。既存のFocusTask配色（focusSoft/focusStrong）は
   * そのまま維持し、トーンだけを弱める（新しい色は導入しない）。タイトルの可読性は保つため、
   * 大きく下げすぎない値にしている。
   */
  completed: {
    opacity: 0.72,
  },
  lockIcon: {
    marginRight: 2,
  },
  syncBadge: {
    marginLeft: 3,
  },
  block: {
    position: "absolute",
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    paddingHorizontal: 6,
    paddingVertical: 4,
    marginRight: 2,
    overflow: "hidden",
  },
  blockHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  blockTitle: {
    fontSize: 12,
    fontWeight: "700",
  },
  blockTitleDense: {
    fontSize: 11,
  },
  blockTime: {
    fontSize: 10,
    marginTop: 2,
    opacity: 0.85,
  },
});
