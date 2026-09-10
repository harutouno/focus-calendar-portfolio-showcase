/**
 * 第2工程: Supabase共有カレンダー関連のデータモデル。
 *
 * 端末内データ（src/types/event.ts の AppEvent）とは独立して扱い、
 * Supabaseの行 ⇄ AppEvent の変換は src/services/sharedEventsService.ts に閉じ込める。
 */

export type CalendarRole = "owner" | "editor" | "viewer";

export interface SharedCalendar {
  id: string;
  name: string;
  color: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  /** 未設定ならnull/undefined。その場合はテーマカラーのデフォルトカバーを表示する */
  coverImageUrl?: string;
}

export interface CalendarMembership {
  calendarId: string;
  userId: string;
  role: CalendarRole;
  displayName?: string;
  avatarUrl?: string;
}

export interface CalendarInvite {
  id: string;
  calendarId: string;
  role: CalendarRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  /** 招待受信者側で参加が完了した日時。未参加ならundefined */
  acceptedAt?: string;
  /** 招待受信者側で拒否された日時。未拒否ならundefined */
  declinedAt?: string;
  /**
   * P0178 / CORRECT-F024-003: **発行スコープ**を表す唯一のフィールド。
   *
   * 値あり = TARGETED（その宛先だけのための招待）
   * undefined = GENERIC（宛先なしの共有リンク。誰でも使える）
   *
   * これが無いと client は targeted と generic を区別できず、
   * generic リンクを得るためだけに他人宛の招待を失効させてしまう。
   * 判定は `src/utils/inviteAuthority.ts` の `classifyInviteScope` を使うこと。
   */
  inviteeEmail?: string;
  /** 生トークン。作成直後のレスポンスにのみ含まれ、DBには保存されない */
  token?: string;
}

/**
 * 自分（現在ログイン中のユーザー）宛てに届いている未処理の招待。
 * fetch_my_pending_invites RPCの結果をそのまま写した表示用の型で、pending判定
 * （revoked/declined/accepted/expiresAtのいずれにも該当しない）はRPC側のWHERE句が正本。
 */
export interface PendingInvite {
  id: string;
  calendarId: string;
  calendarName: string;
  calendarColor: string;
  /** 未設定ならundefined。calendar-coversバケット内のStorageパス、または旧形式の公開URL */
  calendarCoverImageUrl?: string;
  role: Extract<CalendarRole, "editor" | "viewer">;
  createdAt: string;
  expiresAt: string;
  /** 招待を作成したオーナーの表示名。プロフィール未設定ならundefined */
  inviterDisplayName?: string;
}

/** 共有予定1件ごとの送信状態（端末内のみで保持し、Supabaseへは送らない） */
export type SyncStatus = "synced" | "pending" | "error";

/** 一覧画面でのアバター表示用に、メンバーの一部をプレビューとして持たせる */
export interface MemberPreview {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface JoinedCalendarSummary {
  calendar: SharedCalendar;
  role: CalendarRole;
  memberCount: number;
  /** 一覧のアバター表示用（先頭数名のみ、全件ではない） */
  memberPreviews: MemberPreview[];
}

/**
 * FP-008(2026-08): 共有カレンダー1件あたりのメンバー数上限の状態。
 * get_shared_calendar_member_limit_status RPCの結果をそのまま写した表示専用の型。
 * 上限は所有者を含めて5人に固定する。usedSlotCount = currentMemberCount +
 * activeInviteCount（有効な承認待ち招待も枠に含む）で、この合計をmemberLimitと
 * 比較したものがlimitReached。数値の正本はサーバー側（このRPC）であり、
 * クライアントはこの値をそのまま表示するだけで独自に計算し直さない。
 */
export interface SharedCalendarMemberLimitStatus {
  memberLimit: number;
  currentMemberCount: number;
  activeInviteCount: number;
  usedSlotCount: number;
  remainingSlots: number;
  limitReached: boolean;
}
