import { AppEvent } from "@/types/event";
import * as calendarCrud from "@/services/calendarService";
import * as eventOps from "@/services/eventService";
import { SharedMutationIdentity } from "@/auth/sharedMutationIdentity";
import { captureSharedMutationAuthSnapshot } from "@/auth/sharedMutationAuthSnapshot";

/**
 * ユーザーが求める語彙（createEvent/updateEvent/deleteEvent/moveEvent/shareCalendar等）に
 * 対応する薄いファサード。既存の calendarService.ts（カレンダーCRUD・招待）と
 * eventService.ts（予定CRUD）を束ねるだけで、どちらも置き換えない・新しいロジックは追加しない。
 *
 * ファイル名について: Windowsはファイル名の大文字小文字を区別しないため、
 * "CalendarService.ts" は既存の "calendarService.ts" と衝突する。そのため
 * "calendarFacade.ts" という別名にしている。
 *
 * 現時点でAppDataContext.tsxはこれを経由しない（変更面を最小化するため、既存の
 * 個別importのまま）。将来、DIレジストリ（registry.ts）経由・ExternalAppServiceの
 * 実装から使う入口として用意する。
 *
 * 注意: createEvent/updateEvent/moveEvent/deleteEventは呼び出し時に
 * EventMutationContext（ローカルか共有か、共有ならuserId・オフラインキュー投入関数）を
 * 渡す必要があり、まだ「外部から単体で呼べるクリーンなAPI」にはなっていない
 * （今回はインターフェースの土台を用意するところまでで、磨き込みは対象外）。
 */

export type EventMutationContext =
  | {
      isShared: true;
      /**
       * REVISE対応（第8ラウンド、P2）: 呼び出し元が個別のuserId/sessionInstanceIdを
       * 自己申告する形をやめ、eventService.ts・calendarService.tsと同じ
       * SharedMutationIdentityを要求する。eventOps.saveSharedEvent自身がこのidentityを
       * 権威あるauthSessionIdentityStoreと照合するため、このfacade経由でも検証を
       * 迂回できない。
       */
      identity: SharedMutationIdentity;
      enqueueUpsert: eventOps.SaveEventDeps["enqueueUpsert"];
    }
  | { isShared: false };

export type EventDeletionContext =
  | {
      isShared: true;
      /** REVISE対応（第8ラウンド、P2）: EventMutationContextと同じ理由。 */
      identity: SharedMutationIdentity;
      enqueueDelete: eventOps.RemoveEventDeps["enqueueDelete"];
    }
  | { isShared: false };

async function upsertEvent(event: AppEvent, ctx: EventMutationContext) {
  if (!ctx.isShared) return eventOps.saveLocalEvent(event);
  // [P0080 AUTH-F013-F017-001] 実際のfetch送信直前にauth snapshotを1回だけ捕捉する。
  const auth = await captureSharedMutationAuthSnapshot(ctx.identity);
  return eventOps.saveSharedEvent(event, {
    auth,
    enqueueUpsert: ctx.enqueueUpsert,
  });
}

async function deleteEvent(
  event: Pick<AppEvent, "id" | "calendarId">,
  ctx: EventDeletionContext
) {
  if (!ctx.isShared) return eventOps.removeLocalEvent(event.id);
  // [P0080 AUTH-F013-F017-001] 実際のfetch送信直前にauth snapshotを1回だけ捕捉する。
  const auth = await captureSharedMutationAuthSnapshot(ctx.identity);
  return eventOps.removeSharedEvent(event.id, event.calendarId, {
    enqueueDelete: ctx.enqueueDelete,
    auth,
  });
}

export const calendarFacade = {
  createCalendar: calendarCrud.createSharedCalendar,
  updateCalendar: calendarCrud.updateCalendar,
  deleteCalendar: calendarCrud.deleteCalendar,
  shareCalendar: calendarCrud.createInvite,
  joinCalendar: calendarCrud.acceptInvite,

  createEvent: upsertEvent,
  updateEvent: upsertEvent,
  /** 移動＝時刻/日付変更を伴う保存。専用の移動ロジックは無いためupsertEventへのエイリアス */
  moveEvent: upsertEvent,
  deleteEvent,
};

export type CalendarFacade = typeof calendarFacade;
