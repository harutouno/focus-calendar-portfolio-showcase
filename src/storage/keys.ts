export const STORAGE_KEYS = {
  events: "@focus_calendar/events",
  overlaySettings: "@focus_calendar/overlay_settings",
  shareTargets: "@focus_calendar/share_targets",
  userCalendars: "@focus_calendar/user_calendars_v2",
  focusSession: "@focus_calendar/focus_session_active",
  focusHistory: "@focus_calendar/focus_session_history",
  seedApplied: "@focus_calendar/seed_applied_v1",
  chatHistory: "@focus_calendar/ai_chat_history",
  syncQueue: "@focus_calendar/sync_queue_v1",
  favoriteCalendarIds: "@focus_calendar/favorite_calendar_ids_v1",
  notificationMap: "@focus_calendar/notification_map_v1",
  /**
   * SEC-F007-001 REVISE対応（P1-3、スキーマv3）: notificationMapのスキーマ移行
   * （論理キーにscope/owner/session/eventId/slotを織り込んだv3形式への移行）が
   * 完了済みかどうかのフラグ。旧`notification_registry_migrated_v2`キー（v1→v2移行用）は
   * このv3移行が旧v2データも含めて丸ごと再度対応表を破棄するため、以後は参照しない
   * （端末に残った旧キーの値は無害な孤児データとして放置する。過去にv2移行が
   * 完了していたかどうかに関わらず、v3移行は改めて対応表全体を破棄するため区別不要）。
   */
  notificationRegistryMigratedV3: "@focus_calendar/notification_registry_migrated_v3",
  /** Stage I-5: 集中タイマー終了通知のID（カレンダー予定用notificationMapとは別管理） */
  focusTimerNotificationId: "@focus_calendar/focus_timer_notification_id_v1",
  /** 2026-07-29: ユーザーが明示的に選択した（または初回起動時に確定した）表示言語 */
  locale: "@focus_calendar/locale_v1",
  /**
   * ユーザーが明示的に選択した（または初回起動時に確定した）祝日の国・地域。
   * 表示言語(locale)とは独立した設定値。
   */
  holidayRegion: "@focus_calendar/holiday_region_v1",
  /**
   * 2026-07-31: 予定作成画面（通常予定・タスク共通）で最後に選択したカレンダーID。
   * 次回の予定作成画面を開いた際の初期値として使う（端末内のみのローカル設定）。
   */
  lastUsedCalendarId: "@focus_calendar/last_used_calendar_id_v1",
  /**
   * 未完了の Demo AI 依頼を、アプリ再起動をまたいでも同じ requestId で復元するための記録。
   * 同じ依頼を二重に処理しないために使う。
   */
  aiPendingRequest: "@focus_calendar/ai_pending_request_v1",
  /**
   * [P0080 DATA-F017-001] 一括作成（期間・曜日指定）の論理的なattemptの永続化。
   * アプリの強制終了・プロセス再起動・フォームの再マウントをまたいでも、同じ
   * fingerprint（title/calendarId/期間/曜日/時刻/メモ等の内容）での再送であれば
   * 同じrecurringGroupId・event idsを再利用する。access_token等の認証情報は
   * 一切含まない（BulkAttemptRecordにその項目自体が存在しない）。
   */
  bulkAttemptJournal: "@focus_calendar/bulk_attempt_journal_v1",
  /**
   * REVISE対応（第6ラウンド、P1-3）: 前所有者の共有通知一括取消
   * （cancelAllSharedNotificationsForOwner）が1件でも失敗した場合に、そのownerUserIdを
   * 記録しておく永続リスト。アプリ再起動・AppState復帰・次の所有者切替時に再試行し、
   * 全ステップが成功した場合のみこの一覧から除去する。
   */
  pendingOwnerNotificationCleanup: "@focus_calendar/pending_owner_notification_cleanup_v1",
  /**
   * create()/remove()が、副作用（Storageアップロード・soft delete等）を開始する前に
   * 必ず永続化する「意図（intent）」の記録。stale化を検知した場合はここに記録済みの
   * intentのみを頼りに、後から同じownerUserIdでログインしたセッション（sessionInstanceIdは
   * 問わない）が再試行する——stale検知時点で（現在誰のセッションか分からない状態のまま）
   * 即座にStorage操作を行うことは一切しない。旧v1形式（Round12、storagePathを持たない
   * interrupted-delete等）が残っている場合は、読込み時に安全に検証できるものだけ
   * 新形式へ移行し、パスを確定できないものは`legacy-delete-unresolved`として隔離する
   * （同じキーのまま内部形式だけ段階移行するため、キー名自体は変更しない）。
   */
  /**
   * P0016 Batch1.3: shared calendar IDを含みうる端末内設定（overlay/favorite/last-used）の
   * owner-bound書込みが、write成功後・identity再確認前後で中断（プロセス終了・repair write
   * 失敗）した場合に備える、単一スロットの永続化された「保留中envelope」。
   * commitOwnerBoundLocalPreferenceImpl（AppDataContext.tsx）は3フィールドを同一の
   * Promiseチェーンで直列化しているため、同時に存在しうるenvelopeは常に最大1件
   * （ownerBoundPreferenceRepository.tsのdoc参照）。
   */
  ownerBoundPreferencePending: "@focus_calendar/owner_bound_preference_pending_v1",
  /**
   * [P0134 QA-F021 / DATA-F021-001] 共有カレンダー作成の unknown outcome を再判定するための
   * durable な operation identity。INSERT を送る**前**に必ずここへ書き、成功が確定したら消す。
   *
   * 応答喪失（サーバはcommit済みだがクライアントには失敗に見える）の後、
   * アプリ再起動を跨いでも「その操作で使った calendarId」を復元できなければ、
   * リトライは新しいUUIDで2件目を作るしかない（P0134 F021-IDEMP-2 で実証）。
   * `calendars.id` はサーバ既定採番だが GENERATED ALWAYS ではないため、
   * クライアントが決めた id をそのまま operation identity として再利用する
   * （新しい DB 列を増やさない。ローカルカレンダーが既に generateId("cal") で
   * クライアント採番している既存慣行と揃う）。
   *
   * `aiPendingRequest`（AI用）とは別スキーマ・別キー。共有create専用の小さな権威として持つ。
   */
  sharedCalendarCreateJournal: "@focus_calendar/shared_calendar_create_journal_v1",
} as const;
