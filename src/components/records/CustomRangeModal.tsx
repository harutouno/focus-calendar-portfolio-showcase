import React, { useEffect, useState } from "react";
import { Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { DateTimePickerModal } from "@/components/forms/DateTimePickerModal";
import { formatLocalDate, parseLocalDateString } from "@/utils/date";
import { DateKeyRange } from "@/utils/focusStats";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  visible: boolean;
  initialRange: DateKeyRange;
  onClose: () => void;
  onConfirm: (range: DateKeyRange) => void;
}

/**
 * プレミアム専用のカスタム期間選択（仕様13番の自由な開始〜終了日）。
 * 既存のDateTimePickerModalを開始日・終了日それぞれに再利用するだけで、
 * 新しいネイティブ依存は追加しない。
 */
export function CustomRangeModal({ visible, initialRange, onClose, onConfirm }: Props) {
  const { t } = useLocale();
  const [startDateKey, setStartDateKey] = useState(initialRange.startDateKey);
  const [endDateKey, setEndDateKey] = useState(initialRange.endDateKey);
  const [editingField, setEditingField] = useState<"start" | "end" | null>(null);

  useEffect(() => {
    if (visible) {
      setStartDateKey(initialRange.startDateKey);
      setEndDateKey(initialRange.endDateKey);
    }
  }, [visible, initialRange.startDateKey, initialRange.endDateKey]);

  const isInvalid = startDateKey > endDateKey;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <SafeAreaView style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t("records.rangeCustom")}</Text>
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

          <View style={styles.body}>
            <Pressable
              style={styles.fieldRow}
              onPress={() => setEditingField("start")}
              accessibilityRole="button"
              accessibilityLabel={`${t("records.customRangeStartLabel")}: ${startDateKey}`}
            >
              <Text style={styles.fieldLabel}>{t("records.customRangeStartLabel")}</Text>
              <Text style={styles.fieldValue}>{startDateKey}</Text>
            </Pressable>
            <Pressable
              style={styles.fieldRow}
              onPress={() => setEditingField("end")}
              accessibilityRole="button"
              accessibilityLabel={`${t("records.customRangeEndLabel")}: ${endDateKey}`}
            >
              <Text style={styles.fieldLabel}>{t("records.customRangeEndLabel")}</Text>
              <Text style={styles.fieldValue}>{endDateKey}</Text>
            </Pressable>
            {isInvalid && (
              <Text style={styles.errorText}>{t("records.customRangeInvalidMessage")}</Text>
            )}
          </View>

          <View style={styles.footer}>
            <PrimaryButton
              label={t("common.confirm")}
              disabled={isInvalid}
              onPress={() => {
                onConfirm({ startDateKey, endDateKey });
                onClose();
              }}
            />
          </View>
        </SafeAreaView>
      </View>

      <DateTimePickerModal
        visible={editingField !== null}
        title={
          editingField === "start"
            ? t("records.customRangeStartLabel")
            : t("records.customRangeEndLabel")
        }
        mode="date"
        value={parseLocalDateString(editingField === "start" ? startDateKey : endDateKey)}
        onClose={() => setEditingField(null)}
        onConfirm={(date) => {
          const key = formatLocalDate(date);
          if (editingField === "start") setStartDateKey(key);
          else setEndDateKey(key);
          setEditingField(null);
        }}
      />
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
  body: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  fieldRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: minTapSize,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  fieldLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  fieldValue: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  errorText: {
    fontSize: 12,
    color: colors.warning,
  },
  footer: {
    padding: spacing.lg,
    paddingTop: 0,
  },
});
