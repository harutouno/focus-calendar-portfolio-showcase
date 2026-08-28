import React from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { minTapSize, radius, spacing } from "@/theme/spacing";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  visible: boolean;
  title: string;
  initialValue: string;
  placeholder?: string;
  multiline?: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void;
}

export function TextEditModal({
  visible,
  title,
  initialValue,
  placeholder,
  multiline,
  onClose,
  onSubmit,
}: Props) {
  const { t } = useLocale();
  const [value, setValue] = React.useState(initialValue);

  React.useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
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
          <View style={styles.body}>
            <TextInput
              value={value}
              onChangeText={setValue}
              placeholder={placeholder}
              placeholderTextColor={colors.placeholder}
              style={[styles.input, multiline && styles.multiline]}
              multiline={multiline}
              autoFocus
              accessibilityLabel={title}
            />
          </View>
          <View style={styles.footer}>
            <PrimaryButton
              label={t("common.confirm")}
              onPress={() => {
                onSubmit(value);
                onClose();
              }}
            />
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
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
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceAlt,
  },
  multiline: {
    minHeight: 100,
    maxHeight: 220,
    textAlignVertical: "top",
  },
  footer: {
    padding: spacing.lg,
  },
});
