import React from "react";
import { Image, Modal, Pressable, SafeAreaView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme/colors";
import { minTapSize, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";

interface Props {
  visible: boolean;
  uri: string | null;
  onClose: () => void;
}

/** 添付画像の全画面プレビュー。新規ライブラリは使わずRN標準のModal+Imageのみで実装する。 */
export function AttachmentPreviewModal({ visible, uri, onClose }: Props) {
  const { t } = useLocale();
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <SafeAreaView style={styles.safeArea}>
          <Pressable
            style={styles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("attachments.previewCloseA11y")}
            hitSlop={8}
          >
            <Ionicons name="close" size={28} color={colors.textInverse} />
          </Pressable>
          {uri && <Image source={{ uri }} style={styles.image} resizeMode="contain" />}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.9)",
  },
  safeArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  closeButton: {
    position: "absolute",
    top: spacing.lg,
    right: spacing.lg,
    width: minTapSize,
    height: minTapSize,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  image: {
    width: "100%",
    height: "80%",
  },
});
