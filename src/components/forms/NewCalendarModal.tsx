import React, { useEffect, useRef, useState } from "react";
import { Alert, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { useLocale } from "@/context/LocaleContext";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";
import { CALENDAR_COLOR_PALETTE } from "@/constants/options";

const PALETTE = CALENDAR_COLOR_PALETTE;

type Step = "choose" | "local" | "shared";

interface Props {
  visible: boolean;
  onClose: () => void;
  isLoggedIn: boolean;
  isSupabaseConfigured: boolean;
  /** 「共有カレンダー」を選んだが未ログインだった場合に呼ぶ（ログイン画面へ誘導する） */
  onRequestLogin: () => void;
  onCreateLocal: (name: string, color: string) => Promise<void>;
  onCreateShared: (name: string, color: string) => Promise<void>;
  /** あと何個マイカレンダーを作成できるか（無料/プレミアムの上限 - 現在の作成数）。0以下で上限到達。 */
  myCalendarRemaining: number;
  myCalendarLimit: number;
  /** あと何個、自分が所有する共有カレンダーを作成できるか。招待されて参加しただけのカレンダーは含まない。 */
  sharedCalendarRemaining: number;
  sharedCalendarLimit: number;
  /**
   * 開いた瞬間にどのステップから始めるか（既定は"choose"）。
   * マイカレンダー画面の「＋ マイカレンダーを作成する」ボタンのように、種別選択を経由せず
   * ローカル作成フォームへ直接入るための入口として使う。上限到達時は"local"を指定しても
   * 既存のhandleSelectLocalと同じAlert導線を経由する（直接フォームへは進まない）。
   */
  initialStep?: Step;
}

/**
 * 一覧画面の「＋」／「新しいカレンダーを作る」から開く作成モーダル。
 * 一覧画面へ大きな入力フォームを常設しないため、作成種別の選択〜名前・色の入力までを
 * このモーダル内で完結させる。
 */
export function NewCalendarModal({
  visible,
  onClose,
  isLoggedIn,
  isSupabaseConfigured,
  onRequestLogin,
  onCreateLocal,
  onCreateShared,
  myCalendarRemaining,
  myCalendarLimit,
  sharedCalendarRemaining,
  sharedCalendarLimit,
  initialStep = "choose",
}: Props) {
  const { t } = useLocale();
  const [step, setStep] = useState<Step>("choose");
  const [name, setName] = useState("");
  const [colorIndex, setColorIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  // P0092 QA-F018: creating（React state）だけに頼ると、setCreating(true)の再レンダー・
  // Pressableのdisabled反映が間に合わない極めて短い間隔の連続タップで、handleCreateが
  // 二重に実行され得る（app/event/[id].tsxのsaveAttemptInFlightRefと同じ理由・同じ対策）。
  // 二重実行時、両方の呼び出しが同じ古いuserCalendars/カウントを見て上限チェックを
  // 通過し得るため、同期的なrefで最初の呼び出し以外を即座に弾く。
  const creatingRef = useRef(false);

  const myCalendarAtLimit = myCalendarRemaining <= 0;
  const sharedCalendarAtLimit = sharedCalendarRemaining <= 0;

  const handleSelectLocal = () => {
    if (myCalendarAtLimit) {
      Alert.alert(
        t("newCalendarModal.limitReachedTitle"),
        t("newCalendarModal.myCalendarLimitReachedMessage", { limit: myCalendarLimit }),
        [
          { text: t("newCalendarModal.manageExistingButton"), onPress: onClose },
          { text: t("common.close"), style: "cancel" },
        ]
      );
      return;
    }
    setStep("local");
  };

  const handleSelectShared = () => {
    if (!isSupabaseConfigured) return;
    if (!isLoggedIn) {
      onClose();
      onRequestLogin();
      return;
    }
    if (sharedCalendarAtLimit) {
      Alert.alert(
        t("newCalendarModal.limitReachedTitle"),
        t("newCalendarModal.sharedCalendarLimitReachedMessage", { limit: sharedCalendarLimit }),
        [
          { text: t("newCalendarModal.manageExistingButton"), onPress: onClose },
          { text: t("common.close"), style: "cancel" },
        ]
      );
      return;
    }
    setStep("shared");
  };

  useEffect(() => {
    if (!visible) return;
    setName("");
    setColorIndex(0);
    if (initialStep === "local") {
      // 上限到達時はhandleSelectLocal自身がAlertを出して"choose"のままにするため、
      // ここで無条件にsetStep("local")しない。
      handleSelectLocal();
    } else if (initialStep === "shared") {
      // 同様に、未ログイン・上限到達・Supabase未設定はhandleSelectShared自身が
      // 案内（ログイン導線・Alert・何もしない）を出すため、ここで無条件にsetStep("shared")しない。
      handleSelectShared();
    } else {
      setStep(initialStep);
    }
    // visibleが変化した瞬間だけ実行する初期化処理。handleSelectLocal等は依存に含めると
    // visible=true中の再レンダーのたびに再実行されてしまい、ユーザーが選んだstepを
    // 勝手に巻き戻してしまう。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || step === "choose") return;
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      if (step === "local") {
        await onCreateLocal(trimmed, PALETTE[colorIndex]);
      } else {
        await onCreateShared(trimmed, PALETTE[colorIndex]);
      }
      onClose();
    } catch (e) {
      // 単独修正(2026-08, FP-002): UIの事前チェックをすり抜けて実作成処理（AppDataContext.
      // addUserCalendar）が上限到達で拒否した場合も、handleSelectLocalと同じ既存の上限案内を
      // 再利用する（新しい翻訳文言は追加しない）。
      const message = e instanceof Error ? e.message : undefined;
      if (message === "my_calendar_limit_exceeded") {
        Alert.alert(
          t("newCalendarModal.limitReachedTitle"),
          t("newCalendarModal.myCalendarLimitReachedMessage", { limit: myCalendarLimit }),
          [
            { text: t("newCalendarModal.manageExistingButton"), onPress: onClose },
            { text: t("common.close"), style: "cancel" },
          ]
        );
        return;
      }
      Alert.alert(
        t("newCalendarModal.createErrorTitle"),
        toFriendlyMessage(message, t("newCalendarModal.createErrorFallback"), t)
      );
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t("common.close")} />
      <View style={styles.sheet}>
        {step === "choose" ? (
          <>
            <Text style={styles.title}>{t("newCalendarModal.chooseTitle")}</Text>
            <Pressable
              style={[styles.optionRow, myCalendarAtLimit && styles.optionRowDisabled]}
              onPress={handleSelectLocal}
            >
              <View style={[styles.optionIcon, { backgroundColor: colors.primarySoft }]}>
                <Ionicons name="person-outline" size={20} color={colors.primary} />
              </View>
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>{t("newCalendarModal.localOptionTitle")}</Text>
                <Text style={styles.optionSub}>
                  {myCalendarAtLimit
                    ? t("newCalendarModal.limitReachedSubtitle", { limit: myCalendarLimit })
                    : t("newCalendarModal.localOptionSubtitle")}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>
            <Pressable
              style={[styles.optionRow, (!isSupabaseConfigured || sharedCalendarAtLimit) && styles.optionRowDisabled]}
              onPress={handleSelectShared}
              disabled={!isSupabaseConfigured}
            >
              <View style={[styles.optionIcon, { backgroundColor: colors.primarySoft }]}>
                <Ionicons name="people-outline" size={20} color={colors.primary} />
              </View>
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>{t("newCalendarModal.sharedOptionTitle")}</Text>
                <Text style={styles.optionSub}>
                  {!isSupabaseConfigured
                    ? t("newCalendarModal.sharedNotConfiguredSubtitle")
                    : !isLoggedIn
                    ? t("newCalendarModal.sharedNeedsLoginSubtitle")
                    : sharedCalendarAtLimit
                    ? t("newCalendarModal.limitReachedSubtitle", { limit: sharedCalendarLimit })
                    : t("newCalendarModal.sharedDefaultSubtitle")}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>
            <Pressable style={styles.cancelRow} onPress={onClose}>
              <Text style={styles.cancelText}>{t("common.cancel")}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.formHeader}>
              <Pressable hitSlop={8} onPress={() => setStep("choose")}>
                <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
              </Pressable>
              <Text style={styles.title}>
                {step === "local" ? t("newCalendarModal.localOptionTitle") : t("newCalendarModal.sharedOptionTitle")}
              </Text>
              <View style={{ width: 22 }} />
            </View>
            <View style={styles.palette}>
              {PALETTE.map((c, i) => (
                <Pressable
                  key={c}
                  accessibilityLabel={t("newCalendarModal.colorSwatchA11y", { n: i + 1 })}
                  onPress={() => setColorIndex(i)}
                  style={[styles.colorChoice, { backgroundColor: c }, colorIndex === i && styles.colorSelected]}
                />
              ))}
            </View>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={step === "local" ? t("newCalendarModal.localNamePlaceholder") : t("newCalendarModal.sharedNamePlaceholder")}
              style={styles.input}
              autoFocus
            />
            <PrimaryButton
              label={t("newCalendarModal.createButton")}
              onPress={handleCreate}
              loading={creating}
              disabled={!name.trim()}
              style={styles.createButton}
            />
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  title: { fontSize: 16, fontWeight: "700", color: colors.textPrimary, marginBottom: spacing.md },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  optionRowDisabled: { opacity: 0.45 },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  optionText: { flex: 1 },
  optionTitle: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  optionSub: { fontSize: 12, color: colors.textTertiary, marginTop: 2 },
  cancelRow: { alignItems: "center", paddingVertical: spacing.md, marginTop: spacing.xs },
  cancelText: { fontSize: 14, color: colors.textSecondary, fontWeight: "600" },
  formHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  palette: { flexDirection: "row", gap: 10, marginBottom: spacing.md },
  colorChoice: { width: 28, height: 28, borderRadius: 14 },
  colorSelected: { borderWidth: 3, borderColor: colors.textPrimary },
  input: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 46,
    fontSize: 16,
    color: colors.textPrimary,
    marginBottom: spacing.lg,
  },
  createButton: { marginTop: 0 },
});
