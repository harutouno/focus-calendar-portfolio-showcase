import React, { useState } from "react";
import { Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { FieldRow } from "@/components/forms/FieldRow";
import { TextEditModal } from "@/components/forms/TextEditModal";
import { useAppData } from "@/context/AppDataContext";
import { useImagePicker } from "@/hooks/useImagePicker";
import { deleteLocalCalendarCoverImage, saveLocalCalendarCoverImage } from "@/services/localImageStorage";
import { isBaseCalendar } from "@/constants/calendarLimits";
import { CALENDAR_COLOR_PALETTE } from "@/constants/options";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { useLocale } from "@/context/LocaleContext";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";

const PALETTE = CALENDAR_COLOR_PALETTE;

interface Props {
  /** 開く対象のマイカレンダーID。nullのときは非表示。 */
  calendarId: string | null;
  onClose: () => void;
}

/**
 * マイカレンダー画面の3点メニュー（名前を編集／画像を設定・変更／テーマカラーを変更／削除）。
 * 新しい保存経路は作らず、既存のAppDataContext（updateUserCalendar/removeUserCalendar）・
 * useImagePicker・localImageStorageをそのまま呼び出すだけにする
 * （app/calendar/[id]/settings.tsxの各handlerと同じロジックをこのシート用に薄く再構成したもの）。
 * 基本カレンダー（自分一人用）では削除行を表示しない。
 */
export function CalendarActionSheet({ calendarId, onClose }: Props) {
  const { t } = useLocale();
  const { userCalendars, updateUserCalendar, removeUserCalendar } = useAppData();
  const { pickImage } = useImagePicker();
  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [colorEditorOpen, setColorEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const calendar = calendarId ? userCalendars.find((c) => c.id === calendarId) : undefined;
  const visible = !!calendarId && !!calendar;
  const isBase = calendarId ? isBaseCalendar(calendarId) : false;

  const handleClose = () => {
    setColorEditorOpen(false);
    setNameModalVisible(false);
    onClose();
  };

  const handleRenameSubmit = async (value: string) => {
    if (!calendar || busy) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === calendar.name) return;
    setBusy(true);
    try {
      await updateUserCalendar({ ...calendar, name: trimmed });
    } catch (e) {
      Alert.alert(
        t("common.couldNotChange"),
        toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotChange"), t)
      );
    } finally {
      setBusy(false);
    }
  };

  const handleColorChange = async (color: string) => {
    if (!calendar || busy) return;
    setBusy(true);
    try {
      await updateUserCalendar({ ...calendar, color });
    } catch (e) {
      Alert.alert(
        t("common.couldNotChange"),
        toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotChange"), t)
      );
    } finally {
      setBusy(false);
    }
  };

  const pickAndSaveImage = async () => {
    if (!calendar || busy) return;
    const picked = await pickImage({ aspect: [1, 1] });
    if (!picked) return; // キャンセル・権限拒否時は何も変更しない
    setBusy(true);
    const previousUri = calendar.coverImageUri;
    try {
      // 安全な更新順序: 新画像を保存→カレンダーデータを更新→更新成功後にだけ旧画像を削除する。
      // 新画像の保存に失敗した場合はここで例外が飛び、旧画像・旧データは一切触れない。
      const savedUri = await saveLocalCalendarCoverImage(calendar.id, picked.uri);
      try {
        await updateUserCalendar({ ...calendar, coverImageUri: savedUri });
      } catch (e) {
        // カレンダーデータの更新に失敗した場合は、今保存した新画像を掃除して整合性を保つ。
        await deleteLocalCalendarCoverImage(savedUri).catch(() => {});
        throw e;
      }
      // 更新成功後にだけ旧画像を削除する（削除に失敗しても新画像の設定自体は取り消さない）。
      if (previousUri) {
        deleteLocalCalendarCoverImage(previousUri).catch(() => {});
      }
    } catch (e) {
      Alert.alert(
        t("calendarSettings.coverUploadFailedTitle"),
        toFriendlyMessage(e instanceof Error ? e.message : undefined, t("calendarSettings.coverUploadFailedTitle"), t)
      );
    } finally {
      setBusy(false);
    }
  };

  const revertToDefaultImage = async () => {
    if (!calendar || busy) return;
    setBusy(true);
    const previousUri = calendar.coverImageUri;
    try {
      // 先にカレンダーデータを更新し、成功したあとにだけ画像ファイルを削除する
      // （データ更新に失敗した場合はファイルを残し、表示との不整合を防ぐ）。
      await updateUserCalendar({ ...calendar, coverImageUri: undefined });
      if (previousUri) {
        deleteLocalCalendarCoverImage(previousUri).catch(() => {});
      }
    } catch (e) {
      Alert.alert(
        t("common.couldNotChange"),
        toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotChange"), t)
      );
    } finally {
      setBusy(false);
    }
  };

  const handlePressImageRow = () => {
    if (!calendar) return;
    if (!calendar.coverImageUri) {
      pickAndSaveImage();
      return;
    }
    // 既に画像がある場合だけ、変更／標準表示に戻す／キャンセルの3択を出す。
    Alert.alert(calendar.name, undefined, [
      { text: t("calendars.actionChangeImage"), onPress: pickAndSaveImage },
      { text: t("calendars.actionRevertToDefaultImage"), onPress: revertToDefaultImage, style: "destructive" },
      { text: t("common.cancel"), style: "cancel" },
    ]);
  };

  const handleDelete = () => {
    if (!calendar) return;
    Alert.alert(
      t("calendarSettings.deleteConfirmTitle"),
      t("calendarSettings.deleteLocalMessage", { name: calendar.name }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.deleteAction"),
          style: "destructive",
          onPress: async () => {
            try {
              await removeUserCalendar(calendar.id);
              handleClose();
            } catch (e) {
              Alert.alert(
                t("common.couldNotDelete"),
                toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotDelete"), t)
              );
            }
          },
        },
      ]
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose} accessibilityLabel={t("common.close")} />
      <View style={styles.sheet}>
        {calendar && (
          <>
            <Text style={styles.title} numberOfLines={1}>
              {calendar.name}
            </Text>
            <FieldRow
              icon="pencil-outline"
              label={t("calendars.actionRename")}
              onPress={() => setNameModalVisible(true)}
              showChevron={false}
            />
            <FieldRow
              icon="image-outline"
              label={t("calendars.actionChangeImage")}
              onPress={handlePressImageRow}
              showChevron={false}
            />
            <FieldRow
              icon="color-palette-outline"
              label={t("calendars.actionChangeColor")}
              onPress={() => setColorEditorOpen((v) => !v)}
              showChevron={false}
            />
            {colorEditorOpen && (
              <View style={styles.palette}>
                {PALETTE.map((c) => (
                  <Pressable
                    key={c}
                    accessibilityLabel={t("calendarSettings.colorSwatchA11y", { color: c })}
                    disabled={busy}
                    onPress={() => handleColorChange(c)}
                    style={[styles.colorChoice, { backgroundColor: c }, calendar.color === c && styles.colorSelected]}
                  />
                ))}
              </View>
            )}
            {!isBase && (
              <FieldRow
                icon="trash-outline"
                label={t("calendarSettings.deleteConfirmTitle")}
                danger
                onPress={handleDelete}
                showChevron={false}
              />
            )}
            <Pressable style={styles.cancelRow} onPress={handleClose}>
              <Text style={styles.cancelText}>{t("common.close")}</Text>
            </Pressable>
          </>
        )}
      </View>
      {calendar && (
        <TextEditModal
          visible={nameModalVisible}
          title={t("calendarSettings.nameLabel")}
          initialValue={calendar.name}
          placeholder={t("calendarSettings.nameLabel")}
          onClose={() => setNameModalVisible(false)}
          onSubmit={handleRenameSubmit}
        />
      )}
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
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  palette: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  colorChoice: { width: 28, height: 28, borderRadius: 14 },
  colorSelected: { borderWidth: 3, borderColor: colors.textPrimary },
  cancelRow: { alignItems: "center", paddingVertical: spacing.md, marginTop: spacing.xs },
  cancelText: { fontSize: 14, color: colors.textSecondary, fontWeight: "600" },
});
