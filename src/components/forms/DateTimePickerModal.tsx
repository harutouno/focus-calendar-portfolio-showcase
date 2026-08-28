import React from "react";
import {
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  visible: boolean;
  title: string;
  mode: "date" | "time";
  value: Date;
  /** 時刻ピッカーの分単位。1分単位指定に対応するため既定値は1。 */
  minuteInterval?: 1 | 2 | 3 | 4 | 5 | 6 | 10 | 12 | 15 | 20 | 30;
  onClose: () => void;
  onConfirm: (date: Date) => void;
}

/**
 * iOS/Android両対応の日付・時刻ピッカーモーダル。
 * Androidはネイティブダイアログが選択と同時に閉じるため、
 * onChange の時点で確定として扱う。
 */
export function DateTimePickerModal({
  visible,
  title,
  mode,
  value,
  minuteInterval = 1,
  onClose,
  onConfirm,
}: Props) {
  const { t, locale } = useLocale();
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

  const handleChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS === "android") {
      if (event.type === "set" && selected) {
        onConfirm(selected);
      }
      onClose();
      return;
    }
    if (selected) setDraft(selected);
  };

  if (Platform.OS === "android") {
    if (!visible) return null;
    return (
      <DateTimePicker
        value={value}
        mode={mode}
        display="default"
        minuteInterval={mode === "time" ? minuteInterval : undefined}
        onChange={handleChange}
      />
    );
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <SafeAreaView style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>
          <DateTimePicker
            value={draft}
            mode={mode}
            display="spinner"
            minuteInterval={mode === "time" ? minuteInterval : undefined}
            locale={locale === "ja" ? "ja-JP" : "en-US"}
            onChange={handleChange}
            style={styles.picker}
          />
          <View style={styles.footer}>
            <PrimaryButton
              label={t("common.confirm")}
              onPress={() => {
                onConfirm(draft);
                onClose();
              }}
            />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  closeBtn: {
    width: minTapSize,
    height: minTapSize,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -spacing.sm,
  },
  picker: {
    alignSelf: "center",
  },
  footer: {
    padding: spacing.lg,
  },
});
