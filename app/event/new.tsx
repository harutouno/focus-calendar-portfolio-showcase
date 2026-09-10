import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { NormalEvent } from "@/types/event";
import { useAppData } from "@/context/AppDataContext";
import { useAuth } from "@/context/AuthContext";
import {
  NormalEventForm,
  NormalEventFormValue,
} from "@/components/forms/NormalEventForm";
import { BulkEventForm } from "@/components/forms/BulkEventForm";
import { generateId } from "@/utils/id";
import { todayLocalDateString } from "@/utils/date";
import { deleteDraftSession } from "@/services/attachmentDraftStorage";
import { defaultEndTime, resolveDefaultCalendarId, resolveDefaultEventStart, resolveEndDate } from "@/utils/time";
import { colors } from "@/theme/colors";
import { minTapSize, spacing } from "@/theme/spacing";
import { useLocale } from "@/context/LocaleContext";
import {
  STALE_SHARED_MUTATION_IDENTITY_MESSAGE,
  SharedMutationIdentity,
  buildIdentityRemountKey,
  isCurrentSharedMutationIdentity,
  runCurrentSharedMutation,
} from "@/auth/sharedMutationIdentity";

type CreateMode = "single" | "bulk";

/**
 * 完全remountする、NormalEventFormと同じouter/inner分割。A→Bの識別情報切替が起きた場合、
 * 既にremountされるが、これらのIDを発行するのはこの画面側のため、画面自体もremountする
 * 必要がある）。
 */
export default function NewEventScreen() {
  const { user, sessionInstanceId } = useAuth();
  const identityKey = buildIdentityRemountKey(user?.id, sessionInstanceId);
  return <NewEventScreenInner key={identityKey} />;
}

function NewEventScreenInner() {
  const router = useRouter();
  const { t } = useLocale();
  const { user, sessionInstanceId } = useAuth();
  const {
    shareTargets,
    userCalendars,
    sharedCalendars,
    saveEvent,
    saveEventsBulk,
    lastUsedCalendarId,
    recordLastUsedCalendar,
  } = useAppData();
  const params = useLocalSearchParams<{ date?: string; startTime?: string }>();
  const [mode, setMode] = useState<CreateMode>("single");

  // 2026-07-31: 画面がフォーカスされるたび（＝この作成画面が新しく開かれるたび）に
  // 「開いた時点の現在時刻」を取り直す。expo-routerの画面インスタンスが再利用されても、
  // openedAtの変化をNormalEventForm/BulkEventFormのkeyに使うことで両フォームを完全に
  // 再マウントし、以前開いた時点の古い日時・入力内容が残り続けないようにする。
  const [openedAt, setOpenedAt] = useState(() => new Date());
  // 2026-07-31: draftEventId／draftSessionIdは、この画面インスタンスが最初にマウントされた
  // 時にだけ1回発行し、以後はコンポーネントが生存している間ずっと不変にする。
  // 以前はuseFocusEffect内で毎回再生成しており、「フォーカスの再取得」を「新しい作成
  // セッションの開始」と誤って同一視していた——画像ピッカー・プレビュー・日付/時刻ピッカー
  // 自体はReact Navigationのルート遷移を伴わないため通常は再フォーカスを起こさないが、
  // 将来この画面から他画面をpush（位置情報選択・テンプレート選択等）して戻るケースが
  // 追加された場合、その再フォーカスだけでID・ドラフトが失われてしまう設計上の不備だった。
  // openedAtの更新（現在時刻の取り直し）とこのID発行は意図的に分離し、openedAtが
  // 変化してもdraftEventId／draftSessionIdは変わらない。
  const [draftEventId] = useState(() => generateId("evt"));
  const [draftSessionId] = useState(() => generateId("draft"));
  useFocusEffect(
    useCallback(() => {
      setOpenedAt(new Date());
    }, [])
  );
  // draftSessionIdは画面が生存する間ずっと不変のため、このクリーンアップは実質的に
  // 「この画面インスタンスが本当にアンマウントされた時」にのみ実行される
  // （フォーカスを失っただけ・再フォーカスしただけでは実行されない）。予定保存＋添付
  // コミットが成功した分のドラフトファイルはコミット時に個別削除済みのため、ここで
  // 消しても正式登録済みの添付（別ディレクトリ/Storage/DB）には影響しない。コミットに
  // 失敗して残っているドラフトも、画面が本当に閉じられた時点で確実に破棄する
  // （未保存の画像を保持し続けない）。deleteDraftSession自体はディレクトリが既に
  // 存在しない場合は何もしない設計のため、二重に呼ばれても安全（冪等）。
  useEffect(() => {
    return () => {
      deleteDraftSession(draftSessionId).catch((e) => {
        if (__DEV__) {
          // eslint-disable-next-line no-console -- 開発時のみ。ドラフトID以外の内容は出力しない
          console.warn("[event/new] ドラフトディレクトリの削除に失敗しました（次回の孤立ファイル清掃で対象にできる）", draftSessionId, e);
        }
      });
    };
  }, [draftSessionId]);

  // タイムラインのタップ（週・日表示）で開いた場合はparams.date/startTimeが渡され、
  // タップした日付・時刻（1分単位、15分スナップなし）を優先する。
  // ヘッダー「+」・日別一覧「+」・月表示経由（日別一覧の「+」）等、明示的な指定が
  // 無い場合のみ「今日・現在時刻」を初期値にする（集中モード側と共通のresolveDefaultEventStartを使用）。
  const { date, startTime } = resolveDefaultEventStart(params, todayLocalDateString(), openedAt);
  const initial: NormalEventFormValue = {
    title: "",
    date,
    startTime,
    endTime: defaultEndTime(startTime),
    allDay: false,
    location: "",
    memo: "",
    calendarId: resolveDefaultCalendarId(lastUsedCalendarId, userCalendars, sharedCalendars),
    notificationMinutes: 0,
    repeatType: "none",
    shareWith: [],
  };

  // 予定本体の保存のみを行う（画面遷移はしない）。NormalEventFormがこれの成功を
  // Round 12（SEC-F007-004、P1-5）: 保存先が共有カレンダーの場合、saveEvent直後・
  // recordLastUsedCalendar呼出し前後でidentityの現在性を確認する（runCurrentSharedMutation）。
  // stale化した場合はSTALE_SHARED_MUTATION_IDENTITY_MESSAGEを持つ例外を投げ、NormalEventForm側の
  // 呼び出し元がこれを検知して失敗Alertを出さず静かに終了する。ローカルカレンダーへの保存は
  // 従来どおりidentityに一切依存しない。
  const handleSave = async (value: NormalEventFormValue) => {
    const now = new Date().toISOString();
    // [P0078 CORRECT-F016-001] resolveEndDateだけがendDateの正本。全日予定はdateと同一日
    // （endDateは省略＝undefined、最小表現）のまま変更しない。
    const endDate =
      value.allDay ? undefined : (() => {
        const resolved = resolveEndDate(value.date, value.startTime, value.endTime);
        return resolved === value.date ? undefined : resolved;
      })();
    const event: NormalEvent = {
      id: draftEventId,
      kind: "normal",
      title: value.title.trim(),
      date: value.date,
      startTime: value.allDay ? "00:00" : value.startTime,
      endTime: value.allDay ? "23:59" : value.endTime,
      endDate,
      allDay: value.allDay,
      location: value.location.trim() || undefined,
      memo: value.memo.trim() || undefined,
      calendarId: value.calendarId,
      shareWith: value.shareWith,
      notification: {
        enabled: value.notificationMinutes >= 0,
        minutesBefore: Math.max(value.notificationMinutes, 0),
      },
      repeat: { type: value.repeatType },
      completed: false,
      createdAt: now,
      updatedAt: now,
    };
    const isCloudTarget = sharedCalendars.some((s) => s.calendar.id === value.calendarId);
    if (isCloudTarget) {
      if (!(user?.id && sessionInstanceId)) {
        // Round14、P1-4: 共有カレンダーへの保存だがidentityが用意できていない
        // （画面remount直前の短い遷移window等）。保存を一切開始せず、staleと同じ扱いで
        // 静かに中断する（NormalEventForm.handleSubmit側のisStaleMutationErrorが検知する）。
        throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
      }
      const identity: SharedMutationIdentity = { userId: user.id, sessionInstanceId };
      await runCurrentSharedMutation(identity, async (assertCurrent) => {
        await saveEvent(event);
        assertCurrent();
        await recordLastUsedCalendar(value.calendarId);
      });
      return;
    }
    await saveEvent(event);
    await recordLastUsedCalendar(value.calendarId);
  };

  const handleSaveComplete = () => {
    // Round13、P1-4: router.back()直前の最終ゲート。NormalEventForm側で既に
    // stale確認済みだが、この画面自身でも二重に確認する（将来この間に別の
    // awaitが追加された場合の回帰を防ぐための明示的な最終ゲート）。
    if (user?.id && sessionInstanceId) {
      const identity: SharedMutationIdentity = { userId: user.id, sessionInstanceId };
      if (!isCurrentSharedMutationIdentity(identity)) return;
    }
    router.back();
  };

  const handleBulkSave = async (events: NormalEvent[]) => {
    // Round15、P1-4: 以前はsaveEventsBulk()を先に呼んでから保存先を判定していたため、
    // 共有カレンダーへの一括保存でもidentityが用意できていない状態のまま呼び出しが
    // 開始されてしまっていた（handleSaveの既存fail-closedと非対称）。events[0]だけでなく
    // 配列全体を確認し（呼び出し元の不具合等でカレンダーが混在している場合でも見逃さない）、
    // 共有カレンダーが対象に含まれるのにidentityが無ければ、saveEventsBulk自体を呼ばずに
    // staleと同じ扱いで静かに中断する（BulkEventForm.handleSubmit側のisStaleMutationErrorが検知する）。
    const isCloudTarget = events.some((e) => sharedCalendars.some((s) => s.calendar.id === e.calendarId));
    if (isCloudTarget && !(user?.id && sessionInstanceId)) {
      throw new Error(STALE_SHARED_MUTATION_IDENTITY_MESSAGE);
    }

    // 端末内・共有どちらのカレンダーでも、保存後は通常作成と同じ画面遷移にする。
    // 共有カレンダーの失敗時はsaveEventと同じくオフライン同期キューへ積まれ、例外は投げない
    // （UIは楽観的に反映済み）。ただし何も表示しないと「保存できたか分からない」状態に
    // なってしまうため、Stage F確認中に見つかったこの点だけ最小限に補い、
    // 失敗件数がある場合は再送予定であることを案内する（画面遷移自体は変えない）。
    const result = await saveEventsBulk(events);
    // Round14、P1-4: router.back()・Alert表示の直前に、保存先が共有カレンダーの場合だけ
    // 同じ固定identityがまだ現在のものかを最終確認する（handleSaveCompleteと同じ最終ゲート）。
    // stale化していれば、Alertも画面遷移も行わず静かに終了する（画面はidentity変化により
    // 既にremountされているはず）。
    if (isCloudTarget) {
      if (!(user?.id && sessionInstanceId)) return result;
      const identity: SharedMutationIdentity = { userId: user.id, sessionInstanceId };
      if (!isCurrentSharedMutationIdentity(identity)) return result;
    }
    // REVISE対応（第6ラウンド、P1-1）: discardedStaleCountが1件でもあれば、その分は
    // 「オフラインなので後で再送される」わけではなく実際に保存されなかった。同じ
    // failureCount>0でも、原因（オフライン再送予定 or 破棄）によって案内文言を分ける。
    if (result.discardedStaleCount) {
      Alert.alert(
        t("eventNew.partialFailTitle"),
        t("eventNew.partialFailDiscardedMessage")
      );
    } else if (result.failureCount > 0) {
      Alert.alert(
        t("eventNew.partialFailTitle"),
        t("eventNew.partialFailMessage")
      );
    }
    router.back();
    return result;
  };

  return (
    <View style={styles.container}>
      <View style={styles.modeSwitch}>
        <Pressable
          style={[styles.modeButton, mode === "single" && styles.modeButtonSelected]}
          onPress={() => setMode("single")}
          accessibilityRole="button"
          accessibilityState={{ selected: mode === "single" }}
          accessibilityLabel={t("eventNew.singleTabLabel")}
        >
          <Text style={[styles.modeText, mode === "single" && styles.modeTextSelected]}>
            {t("eventNew.singleTabLabel")}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.modeButton, mode === "bulk" && styles.modeButtonSelected]}
          onPress={() => setMode("bulk")}
          accessibilityRole="button"
          accessibilityState={{ selected: mode === "bulk" }}
          accessibilityLabel={t("eventNew.bulkTabLabel")}
        >
          <Text style={[styles.modeText, mode === "bulk" && styles.modeTextSelected]}>
            {t("eventNew.bulkTabLabel")}
          </Text>
        </Pressable>
      </View>
      {mode === "single" ? (
        <NormalEventForm
          key={openedAt.getTime()}
          initial={initial}
          shareTargets={shareTargets}
          userCalendars={userCalendars}
          sharedCalendars={sharedCalendars}
          isEditing={false}
          onSave={handleSave}
          onSaveComplete={handleSaveComplete}
          eventId={draftEventId}
          draftSessionId={draftSessionId}
        />
      ) : (
        <BulkEventForm
          key={openedAt.getTime()}
          userCalendars={userCalendars}
          sharedCalendars={sharedCalendars}
          onSave={handleBulkSave}
          ownerUserId={user?.id ?? null}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  modeSwitch: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  modeButton: {
    flex: 1,
    minHeight: minTapSize,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceAlt,
  },
  modeButtonSelected: { backgroundColor: colors.primary },
  modeText: { fontSize: 13, fontWeight: "700", color: colors.textSecondary },
  modeTextSelected: { color: colors.textInverse },
});
