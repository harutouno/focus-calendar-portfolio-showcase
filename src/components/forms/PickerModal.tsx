import React from "react";
import {
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { useLocale } from "@/context/LocaleContext";

export interface PickerOption {
  id: string;
  label: string;
  disabled?: boolean;
  helperText?: string;
}

interface Props {
  visible: boolean;
  title: string;
  options: PickerOption[];
  selectedIds: string[];
  multiple?: boolean;
  onClose: () => void;
  onApply: (ids: string[]) => void;
}

/**
 * 単一／複数選択の両方に対応する汎用ピッカーモーダル。
 * 「重ねる」の表示対象選択や、繰り返し・通知・制限アプリなどの選択肢に使う。
 */
export function PickerModal({
  visible,
  title,
  options,
  selectedIds,
  multiple = false,
  onClose,
  onApply,
}: Props) {
  const { t } = useLocale();
  const [draft, setDraft] = React.useState<string[]>(selectedIds);

  React.useEffect(() => {
    if (visible) setDraft(selectedIds);
  }, [visible, selectedIds]);

  const toggle = (id: string) => {
    if (multiple) {
      setDraft((prev) =>
        prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]
      );
    } else {
      setDraft([id]);
    }
  };

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
          <FlatList
            data={options}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => {
              const selected = draft.includes(item.id);
              return (
                <Pressable
                  disabled={item.disabled}
                  onPress={() => toggle(item.id)}
                  style={[styles.optionRow, item.disabled && styles.disabled]}
                  accessibilityRole={multiple ? "checkbox" : "radio"}
                  accessibilityState={{
                    disabled: item.disabled,
                    selected,
                    checked: multiple ? selected : undefined,
                  }}
                  accessibilityLabel={`${item.label}${item.helperText ? `${t("common.a11ySeparator")}${item.helperText}` : ""}`}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.optionLabel}>{item.label}</Text>
                    {item.helperText ? (
                      <Text style={styles.helperText}>{item.helperText}</Text>
                    ) : null}
                  </View>
                  {selected ? (
                    <Ionicons
                      name="checkmark-circle"
                      size={22}
                      color={colors.primary}
                    />
                  ) : (
                    <Ionicons
                      name="ellipse-outline"
                      size={22}
                      color={colors.border}
                    />
                  )}
                </Pressable>
              );
            }}
          />
          <View style={styles.footer}>
            <PrimaryButton
              label={t("common.apply")}
              onPress={() => {
                onApply(draft);
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
    maxHeight: "80%",
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
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: minTapSize + 8,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  disabled: {
    opacity: 0.4,
  },
  optionLabel: {
    fontSize: 16,
    color: colors.textPrimary,
  },
  helperText: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
  },
  footer: {
    padding: spacing.lg,
  },
});
