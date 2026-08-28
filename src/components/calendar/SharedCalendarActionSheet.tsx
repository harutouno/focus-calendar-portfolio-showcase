import React from "react";
import { Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { FieldRow } from "@/components/forms/FieldRow";
import { useAppData } from "@/context/AppDataContext";
import { useAuth } from "@/context/AuthContext";
import { removeMember } from "@/services/calendarService";
import {
  SharedMutationIdentity,
  isCurrentSharedMutationIdentity,
  runCurrentSharedMutation,
} from "@/auth/sharedMutationIdentity";
import { toFriendlyMessage } from "@/utils/friendlyError";
import { useLocale } from "@/context/LocaleContext";
import { colors } from "@/theme/colors";
import { radius, spacing } from "@/theme/spacing";

interface Props {
  /** 開く対象の共有カレンダーID。nullのときは非表示。 */
  calendarId: string | null;
  onClose: () => void;
}

/**
 * 共有タブの3点メニュー。ownerと参加者（editor/viewer）で表示行を出し分ける。
 * 「名前・画像・カラーを変更」「メンバーを管理/見る」「メンバーを招待」「カレンダー詳細を見る」は
 * 新しいUIを作らず、既存の/calendar/[id]・/calendar/[id]/members・/calendar/[id]/invite・
 * /calendar/[id]/settings（共有ブランチは既に全機能を持つ）へ遷移するだけにする。
 * 「このカレンダーだけ表示」「削除する/退出する」だけがこのシート内のインライン処理。
 * 権限はUI上の出し分けのみで、実際の可否は既存のRLS・サーバー側権限が正本
 * （settings.tsx等、既存画面と同じ方針）。
 */
export function SharedCalendarActionSheet({ calendarId, onClose }: Props) {
  const { t } = useLocale();
  const router = useRouter();
  const { user, sessionInstanceId } = useAuth();
  const { sharedCalendars, showOnlyCalendarIntent, deleteSharedCalendar, refreshShared } =
    useAppData();

  const summary = calendarId ? sharedCalendars.find((s) => s.calendar.id === calendarId) : undefined;
  const visible = !!calendarId && !!summary;
  const isOwner = summary?.role === "owner";

  // REVISE対応（P0014 Batch1.1、P1-3）: このコンポーネントはidentity-key remount対象外
  // （members.tsx等と違い、authSessionIdentityStoreが切り替わっても即座に再マウントされる
  // 保証がない）ため、各navigationハンドラーの実行直前に、現在描画中のuser/sessionInstanceId
  // （＝このシートが表示しているcalendarIdの根拠となったidentity）がまだ権威ある
  // authSessionIdentityStoreのcurrent値と一致するかを同期的に確認する。一致しない
  // （=stale）場合はonClose()もrouter.push()も行わない。
  const isNavigationIdentityCurrent = (): boolean => {
    if (!user || !sessionInstanceId) return false;
    return isCurrentSharedMutationIdentity({ userId: user.id, sessionInstanceId });
  };

  const navigateToDetail = () => {
    if (!calendarId || !isNavigationIdentityCurrent()) return;
    onClose();
    router.push({ pathname: "/calendar/[id]", params: { id: calendarId } });
  };

  const navigateToMembers = () => {
    if (!calendarId || !isNavigationIdentityCurrent()) return;
    onClose();
    router.push({ pathname: "/calendar/[id]/members", params: { id: calendarId } });
  };

  const navigateToInvite = () => {
    if (!calendarId || !isNavigationIdentityCurrent()) return;
    onClose();
    router.push({ pathname: "/calendar/[id]/invite", params: { id: calendarId } });
  };

  const navigateToSettings = () => {
    if (!calendarId || !isNavigationIdentityCurrent()) return;
    onClose();
    router.push({ pathname: "/calendar/[id]/settings", params: { id: calendarId } });
  };

  // REVISE対応（第10ラウンド、P1-3）: このシートはidentity-key付き再マウントの対象外
  // （メンバー名等の機密情報を保持しないため）だが、[P0096 CORRECT-F019-002]
  // showOnlyCalendarIntent呼出しはA視点で開いたcalendarIdをBのoverlaySettingsへ誤って
  // 適用しうるため、identityを固定してから呼び出し、完了直前にも再検証する
  // （showOnlyCalendarIntent自身も内部でownership分類・owner-bound識別情報チェックを
  // 行うが、このシートはidentity-key remount対象外のためUI/navigation側の防御もそのまま残す）。
  const handleShowOnly = () => {
    if (!calendarId || !user || !sessionInstanceId) return;
    const identity: SharedMutationIdentity = { userId: user.id, sessionInstanceId };
    runCurrentSharedMutation(identity, async (assertCurrent) => {
      assertCurrent();
      await showOnlyCalendarIntent(calendarId);
      assertCurrent();
      onClose();
    }).catch(() => {
      // REVISE対応（P0014 Batch1.1、P1-3）: stale完了・stale error時は失敗Alertも出さない。
      if (isCurrentSharedMutationIdentity(identity)) {
        Alert.alert(t("common.couldNotChange"), toFriendlyMessage(undefined, t("overlay.saveErrorFallback"), t));
      }
    });
  };

  const handleDelete = () => {
    if (!calendarId || !summary) return;
    // P0015 Batch1.2、P1-3: 削除確認Alert自体も、開いた時点でcurrent identityの場合だけ
    // 表示する（stale closureからの押下では確認ダイアログすら出さない）。
    if (!isNavigationIdentityCurrent()) return;
    Alert.alert(
      t("calendarSettings.deleteConfirmTitle"),
      t("calendarSettings.deleteSharedMessage", { name: summary.calendar.name, count: summary.memberCount }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.deleteAction"),
          style: "destructive",
          onPress: async () => {
            // REVISE対応（P0014 Batch1.1、P1-3）: onClose()・失敗Alertのいずれも、
            // 開始時に固定したidentityがcurrentの場合だけ行う。
            const identity: SharedMutationIdentity | null =
              user && sessionInstanceId ? { userId: user.id, sessionInstanceId } : null;
            try {
              await deleteSharedCalendar(calendarId);
              if (identity && !isCurrentSharedMutationIdentity(identity)) return;
              onClose();
            } catch (e) {
              if (!identity || isCurrentSharedMutationIdentity(identity)) {
                Alert.alert(
                  t("common.couldNotDelete"),
                  toFriendlyMessage(e instanceof Error ? e.message : undefined, t("common.couldNotDelete"), t)
                );
              }
            }
          },
        },
      ]
    );
  };

  const handleLeave = () => {
    if (!calendarId || !summary || !user) return;
    // P0015 Batch1.2、P1-3: 退出確認Alert自体も、開いた時点でcurrent identityの場合だけ
    // 表示する。
    if (!isNavigationIdentityCurrent()) return;
    Alert.alert(
      t("calendarSettings.leaveConfirmTitle"),
      t("calendarSettings.leaveMessage", { name: summary.calendar.name, count: summary.memberCount }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("calendarSettings.leaveButton"),
          style: "destructive",
          onPress: async () => {
            // onClose()は既存どおりrunCurrentSharedMutationの操作内・最後のassertCurrent
            // 直後にあるため、stale時には到達しない。
            // REVISE対応（P0014 Batch1.1、P1-3）: catchの失敗Alertもstale時は抑止する。
            let identity: SharedMutationIdentity | null = null;
            try {
              if (!sessionInstanceId) {
                throw new Error("認証セッション情報を確認できないため、この操作を行えません");
              }
              identity = { userId: user.id, sessionInstanceId };
              await runCurrentSharedMutation(identity, async (assertCurrent) => {
                await removeMember(calendarId, user.id, identity!);
                assertCurrent();
                await refreshShared();
                assertCurrent();
                onClose();
              });
            } catch (e) {
              if (!identity || isCurrentSharedMutationIdentity(identity)) {
                Alert.alert(
                  t("calendarSettings.leaveFailedTitle"),
                  toFriendlyMessage(e instanceof Error ? e.message : undefined, t("calendarSettings.leaveFailedTitle"), t)
                );
              }
            }
          },
        },
      ]
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t("common.close")} />
      <View style={styles.sheet}>
        {summary && (
          <>
            <Text style={styles.title} numberOfLines={1}>
              {summary.calendar.name}
            </Text>
            <FieldRow
              icon="information-circle-outline"
              label={t("calendars.actionViewDetail")}
              onPress={navigateToDetail}
              showChevron={false}
            />
            <FieldRow
              icon="eye-outline"
              label={t("calendars.actionShowOnlyThis")}
              onPress={handleShowOnly}
              showChevron={false}
            />
            {isOwner ? (
              <>
                <FieldRow
                  icon="people-outline"
                  label={t("calendars.actionManageMembers")}
                  onPress={navigateToMembers}
                  showChevron={false}
                />
                <FieldRow
                  icon="person-add-outline"
                  label={t("calendars.actionInviteMembers")}
                  onPress={navigateToInvite}
                  showChevron={false}
                />
                <FieldRow
                  icon="create-outline"
                  label={t("calendars.actionEditSharedCalendar")}
                  onPress={navigateToSettings}
                  showChevron={false}
                />
                <FieldRow
                  icon="trash-outline"
                  label={t("calendarSettings.deleteConfirmTitle")}
                  danger
                  onPress={handleDelete}
                  showChevron={false}
                />
              </>
            ) : (
              <>
                <FieldRow
                  icon="people-outline"
                  label={t("calendars.actionViewMembers")}
                  onPress={navigateToMembers}
                  showChevron={false}
                />
                <FieldRow
                  icon="exit-outline"
                  label={t("calendarSettings.leaveButton")}
                  danger
                  onPress={handleLeave}
                  showChevron={false}
                />
              </>
            )}
            <Pressable style={styles.cancelRow} onPress={onClose}>
              <Text style={styles.cancelText}>{t("common.close")}</Text>
            </Pressable>
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
  cancelRow: { alignItems: "center", paddingVertical: spacing.md, marginTop: spacing.xs },
  cancelText: { fontSize: 14, color: colors.textSecondary, fontWeight: "600" },
});
