import { useEffect } from "react";
import { useRouter } from "expo-router";
import * as Notifications from "expo-notifications";

/** アプリプロセス内で一度だけコールドスタート応答を処理する（再マウントで二重遷移しないため） */
let coldStartHandled = false;

interface FocusNotificationData {
  type?: string;
  eventId?: string;
}

interface RoutingCallbacks {
  navigateToActiveStart: (eventId: string) => void;
  navigateToDetail: (eventId: string) => void;
}

function handleResponse(
  response: Notifications.NotificationResponse,
  callbacks: RoutingCallbacks
): void {
  const data = response.notification.request.content.data as
    | FocusNotificationData
    | undefined;
  if (!data?.eventId) return;
  if (data.type === "focus_session_start") {
    callbacks.navigateToActiveStart(data.eventId);
    return;
  }
  if (data.type === "focus_session_reminder") {
    callbacks.navigateToDetail(data.eventId);
  }
  // それ以外（通常予定の通知等）は何もしない（＝タップしても特別な遷移は起きないという既存の挙動を変えない）。
}

/**
 * ローカル通知タップ時のルーティング。このアプリには元々この処理自体が存在しなかったため
 * 新規追加する。集中予定の通知2種類だけを対象に、それぞれ異なる遷移先へルーティングする。
 * それ以外（通常予定の通知等）は何もしない。app/_layout.tsxのルート直下で一度だけマウントする。
 *
 * - 開始通知（focus_session_start）: 集中セッション画面（/focus/active/[id]）へ、
 *   autostart=1 + source=notification 付きで遷移する（既存のuseFocusSession側の
 *   isBeforeScheduledStartガードが、開始時刻前ならここでの自動開始をブロックする）。
 * - 事前リマインダー（focus_session_reminder）: 予定の自動開始やセッション作成を
 *   一切行わず、集中予定の詳細画面（/focus/[id]）を開くだけにする。ユーザーが
 *   その画面の「集中を開始」ボタンを自分で押すまでセッションは作られない
 *   （このボタンは既存どおりautostart/sourceパラメータを付けずに/focus/active/[id]へ
 *   遷移する、通知経由ではない手動開始として扱われる）。
 */
export function useNotificationResponseRouting(): void {
  const router = useRouter();

  useEffect(() => {
    const callbacks: RoutingCallbacks = {
      navigateToActiveStart: (eventId: string) => {
        router.push({
          pathname: "/focus/active/[id]",
          // source:"notification" は、遷移先の画面が「通知経由のautostartだけ」開始時刻で
          // ガードするための目印。予定詳細画面の「集中を開始」ボタン等、他の経路からの
          // autostart（このsourceパラメータを付けない）とは区別する。
          params: { id: eventId, autostart: "1", source: "notification" },
        });
      },
      navigateToDetail: (eventId: string) => {
        router.push({
          pathname: "/focus/[id]",
          params: { id: eventId },
        });
      },
    };

    // コールドスタート（通知タップでアプリが起動した）場合を拾う。
    if (!coldStartHandled) {
      coldStartHandled = true;
      Notifications.getLastNotificationResponseAsync()
        .then((response) => {
          if (response) handleResponse(response, callbacks);
        })
        .catch(() => undefined);
    }

    const subscription = Notifications.addNotificationResponseReceivedListener((response) =>
      handleResponse(response, callbacks)
    );
    return () => subscription.remove();
  }, [router]);
}
