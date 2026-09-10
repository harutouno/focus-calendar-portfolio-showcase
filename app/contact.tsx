import React, { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { ScreenHeader } from "@/components/common/ScreenHeader";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";

// 未設定の場合、メニュー側（app/menu.tsx）でこの画面への導線自体を非表示にしている。
// それでも直接この画面に到達した場合に備え、ここでも未設定時は安全にガードする。
const SUPPORT_EMAIL = process.env.EXPO_PUBLIC_SUPPORT_EMAIL;

export default function ContactScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [email, setEmail] = useState("");

  const send = async () => {
    if (!subject.trim() || !body.trim()) {
      Alert.alert(t("contact.missingFieldsTitle"), t("contact.missingFieldsMessage"));
      return;
    }
    if (!SUPPORT_EMAIL) {
      Alert.alert(t("contact.unavailableTitle"), t("contact.unavailableMessage"));
      return;
    }

    const mailBody = email.trim()
      ? t("contact.mailBodyReplyLine", { body, email: email.trim() })
      : body;
    const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(mailBody)}`;

    const canOpen = await Linking.canOpenURL(url);
    if (!canOpen) {
      Alert.alert(
        t("contact.mailClientErrorTitle"),
        t("contact.mailClientErrorMessage")
      );
      return;
    }
    await Linking.openURL(url);
    router.back();
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title={t("contact.title")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.help}>{t("contact.introText")}</Text>

        <Text style={styles.label}>{t("contact.subjectLabel")}</Text>
        <TextInput
          style={styles.input}
          value={subject}
          onChangeText={setSubject}
          placeholder={t("contact.subjectPlaceholder")}
        />

        <Text style={styles.label}>{t("contact.bodyLabel")}</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          multiline
          value={body}
          onChangeText={setBody}
          placeholder={t("contact.bodyPlaceholder")}
        />

        <Text style={styles.label}>{t("contact.replyEmailLabel")}</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />

        <PrimaryButton label={t("contact.sendButton")} onPress={send} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
    gap: 10,
  },
  help: {
    color: colors.textSecondary,
    lineHeight: 21,
    marginBottom: 8,
  },
  label: {
    fontWeight: "700",
    color: colors.textPrimary,
    marginTop: 6,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 12,
    padding: 12,
    minHeight: 48,
  },
  multiline: {
    height: 150,
    textAlignVertical: "top",
  },
});
