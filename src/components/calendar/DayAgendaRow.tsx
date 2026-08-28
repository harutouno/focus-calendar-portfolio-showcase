import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppEvent, isFocusTask, isNormalEvent } from "@/types/event";
import { JoinedCalendarSummary } from "@/types/sharing";
import { getEventRegistrantInfo } from "@/utils/dayAgenda";
import { formatDuration } from "@/utils/time";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";
import { Avatar } from "@/components/common/Avatar";
import { eventColor, isCompletedFocusTask } from "./EventChip";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  event: AppEvent;
  sharedCalendars: JoinedCalendarSummary[];
  onPress: (event: AppEvent) => void;
}

/** 日別予定一覧の1行（Stage I-8.7）。予定タップで既存の詳細/編集画面へ遷移する想定。 */
export function DayAgendaRow({ event, sharedCalendars, onPress }: Props) {
  const { t, locale } = useLocale();
  const { fg } = eventColor(event);
  const registrant = getEventRegistrantInfo(event, sharedCalendars, t);
  const allDay = isNormalEvent(event) && event.allDay;
  const focus = isFocusTask(event);
  const completed = isCompletedFocusTask(event);
  const endLabel = focus ? formatDuration(event.durationMinutes, locale) : event.endTime;
  const stripeColor = registrant.isOwn ? fg : (registrant.calendarColor ?? fg);

  return (
    <Pressable
      onPress={() => onPress(event)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${event.title}${t("common.a11ySeparator")}${
        allDay ? t("common.allDay") : t("dayAgendaRow.timeRangeA11y", { start: event.startTime, end: endLabel })
      }`}
    >
      <View style={[styles.stripe, { backgroundColor: stripeColor }]} />
      <View style={styles.timeCol}>
        {allDay ? (
          <Text style={styles.allDayText}>{t("common.allDay")}</Text>
        ) : (
          <>
            <Text style={styles.startTime}>{event.startTime}</Text>
            <Text style={styles.endTime}>{endLabel}</Text>
          </>
        )}
      </View>
      <View style={styles.mainCol}>
        <View style={styles.titleRow}>
          <Ionicons
            name={completed ? "checkmark-circle" : focus ? "lock-closed" : "calendar-outline"}
            size={13}
            color={fg}
          />
          <Text style={styles.title} numberOfLines={1}>
            {event.title}
          </Text>
          {focus && <Text style={[styles.focusTag, { color: fg }]}>{t("dayAgendaRow.focusTag")}</Text>}
        </View>
        <View style={styles.registrantRow}>
          <Avatar label={registrant.label} size={16} />
          <Text style={styles.registrantText} numberOfLines={1}>
            {registrant.isOwn ? t("dayAgendaRow.selfLabel") : registrant.calendarName}
          </Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingVertical: spacing.sm,
    paddingRight: spacing.md,
    gap: spacing.sm,
    overflow: "hidden",
  },
  pressed: {
    backgroundColor: colors.surfaceAlt,
  },
  stripe: {
    width: 4,
    alignSelf: "stretch",
    borderRadius: 2,
  },
  timeCol: {
    width: 52,
    alignItems: "flex-start",
  },
  startTime: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  endTime: {
    fontSize: 11,
    color: colors.textTertiary,
    marginTop: 2,
  },
  allDayText: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.primary,
  },
  mainCol: {
    flex: 1,
    gap: 4,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  title: {
    flex: 1,
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  focusTag: {
    fontSize: 10,
    fontWeight: "700",
  },
  registrantRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  registrantText: {
    fontSize: 11,
    color: colors.textSecondary,
  },
});
