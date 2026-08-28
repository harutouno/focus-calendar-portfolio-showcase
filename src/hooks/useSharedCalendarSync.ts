import { useEffect } from "react";
import { AppEvent } from "@/types/event";
import { subscribeToCalendarEvents } from "@/services/sharedEventsService";
import { isCurrentSharedMutationIdentity } from "@/auth/sharedMutationIdentity";

/**
 * 参加中カレンダーごとにRealtimeチャンネルを1つ購読する。
 * calendarIds・ownerUserId・sessionInstanceIdのいずれかが変化するたびに、
 * 既存の購読を全て解除してから作り直す（SEC-F007-001以前は差分だけ解除/購読していたが、
 * 所有者・認証セッション境界が変わった際に必ず全購読を作り直す必要があるため、
 * 差分更新の最適化は廃止し、常に全解除→全購読へ単純化した）。
 * アンマウント時も同じcleanupで必ず全チャンネルを解除する（多重購読防止）。
 *
 * SEC-F007-001: onEventChange/onEventDeleteには、この購読が作られた時点の
 * ownerUserId/sessionInstanceIdを常に引数として渡す。呼び出し先（AppDataContext）は
 * これを、現在committedな所有者と照合してから初めてstateへ反映する（reduceSharedDataの
 * REALTIME_EVENT_UPSERT/_DELETE参照）。これにより、解除待ちの旧購読から遅れて
 * イベントが届いても、それがどの所有者・どの認証セッション向けの購読だったかを
 * 呼び出し先が正しく判定できる——`ref.current`をレンダー中に書き込んで最新値を
 * 追わせる方式（旧実装のonEventChangeRef等）は廃止した。
 *
 * REVISE対応（P1-3）: 以前はこのフック自身が、onUpsert/onDelete内で
 * sharedNotificationCoordinatorのschedule/cancelを無条件に呼んでいた。しかし
 * reducer（reduceSharedData）は「現在参加していないカレンダーのイベントは反映しない」
 * という、通知側には存在しない追加の認可判定（カレンダー所属チェック）を持つため、
 * reducerがstateへの反映を拒否したイベントについても、通知だけは予約・取消され続ける
 * 不整合があった（解除待ちの旧購読から届いたイベント等）。このフックはRealtimeで
 * 受信した内容をそのままonEventChange/onEventDeleteへ伝える「状態変化の通知」役に
 * 徹し、通知API・sharedNotificationCoordinatorには一切触れない。通知の予約・取消は、
 * reducerが実際にコミットした`sharedData.remoteEvents`を入力とする所有者付き
 * reconcile（AppDataContext側）へ一本化した——reducerに拒否されたイベントは
 * `remoteEvents`に反映されないため、自動的に通知にも反映されなくなる。
 *
 * Supabaseのチャンネル購読自体（channel/on/subscribe）は
 * src/services/sharedEventsService.ts の subscribeToCalendarEvents に集約されており、
 * このフックはSupabaseへ直接依存しない。
 */
export function useSharedCalendarSync(
  calendarIds: string[],
  ownerUserId: string,
  sessionInstanceId: string,
  onEventChange: (event: AppEvent, ownerUserId: string, sessionInstanceId: string) => void,
  onEventDelete: (eventId: string, ownerUserId: string, sessionInstanceId: string) => void
): void {
  const calendarIdsKey = calendarIds.join(",");

  /**
   * P0015 Batch1.2、P1: onUpsert/onDeleteコールバック自身に、購読作成時点のownerUserId/
   * sessionInstanceIdが権威あるauthSessionIdentityStoreの現在値と一致するかを同期確認する
   * auth-currentゲートと、このeffectインスタンスが既にcleanup済みでないかを確認する
   * lifetimeゲート（`active`フラグ）の2つを追加する。
   *
   * - auth-currentゲート: authSessionIdentityStoreだけが先に切り替わり、Reactの
   *   コミット（このeffectの依存配列変化に伴う再実行、または呼び出し元コンポーネントの
   *   アンマウント）がまだ済んでいない短い窓の間に旧購読からイベントが届いても、
   *   新しいownerが確定するまでAppDataContext側のcallbackを一切呼ばない。
   * - lifetimeゲート: calendarIds/ownerUserId/sessionInstanceId変更によるこのeffectの
   *   再実行、またはコンポーネントのアンマウントのいずれでも、Reactは同じcleanup関数
   *   （`active = false`を含む）を呼ぶ。cleanup後（=unsubscribe呼出し後）に旧Supabase
   *   channelから遅れて届くcallbackも、この`active`チェックによりno-opになる
   *   （unsubscribe自体は非同期であるため、呼出し後もコールバックが飛んでくる余地がある）。
   *
   * AppDataContext側のreducer（reduceSharedData）が持つowner/session一致判定（多層防御）は
   * このHook側のゲートで置き換えず、両方とも維持する。
   */
  useEffect(() => {
    let active = true;
    const ids = calendarIdsKey ? calendarIdsKey.split(",") : [];
    const unsubscribes = ids.map((calendarId) =>
      subscribeToCalendarEvents(calendarId, {
        onUpsert: (event) => {
          if (!active) return;
          if (!isCurrentSharedMutationIdentity({ userId: ownerUserId, sessionInstanceId })) return;
          onEventChange(event, ownerUserId, sessionInstanceId);
        },
        onDelete: (eventId) => {
          if (!active) return;
          if (!isCurrentSharedMutationIdentity({ userId: ownerUserId, sessionInstanceId })) return;
          onEventDelete(eventId, ownerUserId, sessionInstanceId);
        },
      })
    );
    return () => {
      active = false;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [calendarIdsKey, ownerUserId, sessionInstanceId, onEventChange, onEventDelete]);
}
