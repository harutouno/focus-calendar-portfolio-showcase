import { getLocales } from "expo-localization";

/**
 * 軽量なi18n（app/ai/*専用として開始し、2026-07-29にアプリ全体の言語切替機能で拡張、
 * 同日中にアプリ全体（全画面・全コンポーネント）への完全移行で再拡張）。
 * このアプリにはi18nライブラリ（react-i18next等）は導入していない。
 * 辞書＋translate()/t()関数だけの最小構成。
 *
 * アプリ全体からのリアクティブな利用は`src/context/LocaleContext.tsx`の`useLocale()`
 * フック経由（ユーザーが選択した言語に即時追従する）。この`t()`はそれとは別に、
 * 端末ロケールのみに基づく非リアクティブな簡易アクセス用に残してある
 * （既存テストとの後方互換のため）。
 *
 * キー命名規則: 画面・コンポーネント単位の名前空間（例: `account.*`, `monthView.*`）を
 * 基本とし、複数箇所で文言が完全に一致するもの（ボタン・ラベルの定型文言）だけを
 * `common.*`/`calendarRole.*`/`date.*`に集約する。同じ文字列でも文脈が異なる場合は
 * 名前空間ごとに別キーとして持つ（重複キー名は作らない）。
 */
export type SupportedLocale = "ja" | "en";

/** useLocale()の`t`と同じ形。Contextを持てない純粋関数（validation/friendlyError等）へ
 *  呼び出し元から明示的に渡すためのエイリアス型。 */
export type TFunction = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export type TranslationKey =
  // ai.* (既存)
  | "ai.header"
  | "ai.usageRemainingToday"
  | "ai.usageRemainingThisMonth"
  | "ai.freeUsedUpTitle"
  | "ai.watchAdBonusButton"
  | "ai.adBonusRemainingHint"
  | "ai.dailyLimitReachedTitle"
  | "ai.dailyLimitResetHint"
  | "ai.usageFetchFailedTitle"
  | "ai.usageRetryButton"
  | "ai.usageRequiresLoginTitle"
  | "ai.usageRequiresLoginButton"
  | "ai.suggestionsHeading"
  | "ai.historyHeading"
  | "ai.historyEmpty"
  | "ai.description"
  | "ai.demoNotice"
  | "aiResult.applyToCalendarAction"
  | "aiResult.applyConfirmTitle"
  | "aiResult.applyConfirmMessage"
  | "aiResult.applyConfirmAction"
  | "aiResult.applyDoneTitle"
  | "aiResult.applyDoneMessage"
  | "aiResult.applyDoneAction"
  | "aiResult.applyFailedTitle"
  | "aiResult.applyFailedMessage"
  | "aiResult.applyInvalidMessage"
  | "ai.voiceInputTitle"
  | "ai.voiceInputComingSoon"
  | "ai.voiceInputA11y"
  | "ai.inputPlaceholder"
  | "ai.sendA11y"
  | "ai.suggestion.organizeToday"
  | "ai.suggestion.organizeToday.description"
  | "ai.suggestion.findFreeTime"
  | "ai.suggestion.findFreeTime.description"
  | "ai.suggestion.organizeTodos"
  | "ai.suggestion.organizeTodos.description"
  | "ai.suggestion.reserveStudyTime"
  | "ai.suggestion.reserveStudyTime.description"
  | "ai.suggestion.reviewThisWeek"
  | "ai.suggestion.reviewThisWeek.description"
  // language.* (既存)
  | "language.pickerTitle"
  | "language.jaLabel"
  | "language.enLabel"
  | "language.sheetTitle"
  // calendarHeader.* (既存)
  | "calendarHeader.menuLabel"
  | "calendarHeader.addLabel"
  | "calendarHeader.selectMonthLabel"
  | "calendarHeader.previousMonthLabel"
  | "calendarHeader.nextMonthLabel"
  | "calendarHeader.todayLabel"
  | "calendarHeader.todayA11yLabel"
  | "calendarHeader.languageA11yLabel"
  // yearMonthPicker.* (既存)
  | "yearMonthPicker.title"
  | "yearMonthPicker.backToThisMonth"
  | "yearMonthPicker.close"
  // menu.* (既存)
  | "menu.title"
  | "menu.calendar"
  | "menu.account"
  | "menu.accountLoggedInFallback"
  | "menu.accountLoggedOut"
  | "menu.records"
  | "menu.visibleCalendars"
  | "menu.aiSupport"
  | "menu.trainingIntegration"
  | "menu.trainingComingSoon"
  | "menu.support"
  | "menu.contact"
  | "menu.adPrivacySettings"
  | "menu.holidayRegionLabel"
  // common.*
  | "common.a11ySeparator"
  | "common.close"
  | "common.confirm"
  | "common.apply"
  | "common.cancel"
  | "common.delete"
  | "common.deleteAction"
  | "common.save"
  | "common.back"
  | "common.notSet"
  | "common.notEntered"
  | "common.couldNotChange"
  | "common.couldNotDelete"
  | "common.copied"
  | "common.allDay"
  | "common.selfSuffix"
  | "common.comingSoon"
  | "common.todaySuffix"
  | "common.requiredSuffix"
  | "common.errorSuffix"
  | "common.moreCount"
  | "common.rangeSeparator"
  | "common.startTime"
  | "common.endTime"
  | "common.tapToChangeHint"
  | "common.notification"
  | "common.repeat"
  | "common.shared"
  | "common.saveFailedTitle"
  | "common.completed"
  | "common.addEvent"
  | "common.durationHours"
  | "common.durationMinutes"
  | "common.durationHoursMinutes"
  | "common.cannotMoveTitle"
  | "common.saveFailedMessage"
  | "common.timeSlotSuffix"
  | "common.createEventHint"
  | "common.noVisibleEventsHint"
  // calendarRole.*
  | "calendarRole.owner"
  | "calendarRole.editor"
  | "calendarRole.viewer"
  // date.*
  | "date.weekday0"
  | "date.weekday1"
  | "date.weekday2"
  | "date.weekday3"
  | "date.weekday4"
  | "date.weekday5"
  | "date.weekday6"
  // validation.*
  | "validation.titleRequired"
  | "validation.dateRequired"
  | "validation.dateInvalid"
  | "validation.timeInvalid"
  | "validation.startTimeRequired"
  | "validation.endTimeRequired"
  | "validation.endTimeAfterStart"
  | "validation.taskNameRequired"
  | "validation.executionDateRequired"
  | "validation.durationRequired"
  | "validation.calendarRequired"
  | "validation.startDateRequired"
  | "validation.endDateRequired"
  | "validation.weekdayRequired"
  | "validation.rangeFallback"
  // recurringDates.*
  | "recurringDates.weekdayInvalid"
  | "recurringDates.startBeforeEnd"
  | "recurringDates.rangeTooLong"
  | "recurringDates.tooManyGenerated"
  // friendlyError.*
  | "friendlyError.inviteNotFound"
  | "friendlyError.inviteRevoked"
  | "friendlyError.inviteExpired"
  | "friendlyError.rateLimit"
  | "friendlyError.invalidEmail"
  | "friendlyError.network"
  | "friendlyError.notAuthorized"
  | "friendlyError.session"
  | "friendlyError.ownedSharedCalendarLimitExceeded"
  | "friendlyError.sharedCalendarMemberLimitExceeded"
  | "friendlyError.localPersistenceFailed"
  | "friendlyError.sharedEventDeleteUnconfirmed"
  // permissions.*
  | "permissions.viewerCannotMove"
  | "permissions.overnightContinuationCannotMove"
  // options.*
  | "options.mainCalendar"
  | "options.restrictedAppYoutube"
  | "options.restrictedAppX"
  | "options.restrictedAppGame"
  | "options.restrictedAppSns"
  | "options.restrictedAppBrowser"
  | "options.notificationNone"
  | "options.notificationAtStart"
  | "options.notification5Min"
  | "options.notification10Min"
  | "options.notification15Min"
  | "options.notification30Min"
  | "options.notification1Hour"
  | "options.notification2Hour"
  | "options.notification1Day"
  | "options.repeatNone"
  | "options.repeatDaily"
  | "options.repeatWeekly"
  | "options.repeatMonthly"
  | "options.repeatYearly"
  | "options.unlockConditionNone"
  | "options.unlockConditionCalculation"
  // holiday.* (日本の祝日名)
  | "holiday.newYearsDay"
  | "holiday.comingOfAgeDay"
  | "holiday.nationalFoundationDay"
  | "holiday.emperorsBirthday"
  | "holiday.vernalEquinoxDay"
  | "holiday.showaDay"
  | "holiday.constitutionMemorialDay"
  | "holiday.greeneryDay"
  | "holiday.childrensDay"
  | "holiday.marineDay"
  | "holiday.mountainDay"
  | "holiday.respectForTheAgedDay"
  | "holiday.autumnalEquinoxDay"
  | "holiday.sportsDay"
  | "holiday.healthAndSportsDay"
  | "holiday.cultureDay"
  | "holiday.laborThanksgivingDay"
  | "holiday.citizensHoliday"
  | "holiday.substituteHoliday"
  // holidayRegion.*
  | "holidayRegion.pickerTitle"
  | "holidayRegion.jp"
  | "holidayRegion.us"
  | "holidayRegion.gb"
  | "holidayRegion.none"
  // notification.* (通知サービス)
  | "notification.channelName"
  | "notification.eventBody"
  | "notification.focusEndTitle"
  | "notification.focusEndBody"
  | "notification.focusStartTitle"
  | "notification.focusStartBody"
  | "notification.focusReminderTitle"
  | "notification.focusReminderBody"
  | "notification.untitledEventFallback"
  // syncStatusBadge.*
  | "syncStatusBadge.synced"
  | "syncStatusBadge.pending"
  | "syncStatusBadge.error"
  // adPlaceholder.*
  | "adPlaceholder.fallback"
  // viewSwitcher.*
  | "viewSwitcher.month"
  | "viewSwitcher.week"
  | "viewSwitcher.day"
  // focus.*
  | "focus.startButton"
  // dayAgendaRow.*
  | "dayAgendaRow.focusTag"
  | "dayAgendaRow.selfLabel"
  | "dayAgendaRow.timeRangeA11y"
  // bottomActionBar.*
  | "bottomActionBar.overlay"
  | "bottomActionBar.calendar"
  | "bottomActionBar.focus"
  | "bottomActionBar.ai"
  | "bottomActionBar.activity"
  // calendarVisibilityChips.*
  | "calendarVisibilityChips.mainChipName"
  | "calendarVisibilityChips.manageA11y"
  | "calendarVisibilityChips.suffixShowing"
  | "calendarVisibilityChips.suffixHidden"
  // monthDropConfirm.*
  | "monthDropConfirm.title"
  | "monthDropConfirm.focusDurationKept"
  | "monthDropConfirm.originalTimeLabel"
  | "monthDropConfirm.newDateLabel"
  | "monthDropConfirm.confirmButton"
  | "monthDropConfirm.keepOriginalButton"
  // focusTaskForm.*
  | "focusTaskForm.deleteConfirmTitle"
  | "focusTaskForm.deleteConfirmMessage"
  | "focusTaskForm.editHeaderTitle"
  | "focusTaskForm.createHeaderTitle"
  | "focusTaskForm.submitButton"
  | "focusTaskForm.taskNameLabel"
  | "focusTaskForm.executionDateLabel"
  | "focusTaskForm.durationLabel"
  | "focusTaskForm.calendarLabel"
  | "focusTaskForm.restrictedAppsLabel"
  | "focusTaskForm.midUnlockLabel"
  | "focusTaskForm.unlockConditionLabel"
  | "focusTaskForm.memoLabel"
  | "focusTaskForm.alreadyCompletedLabel"
  | "focusTaskForm.lockedNoticeLabel"
  | "focusTaskForm.taskNamePlaceholder"
  | "focusTaskForm.memoPlaceholder"
  | "focusTaskForm.unlockConditionModalTitle"
  | "focusTaskForm.unlockCountModalTitle"
  | "focusTaskForm.unlockCountSummary"
  | "focusTaskForm.unlockCountOption"
  | "focusTaskForm.viewRecordsButton"
  | "focusTaskForm.viewRecordsAccessibilityLabel"
  // bulkEventForm.*
  | "bulkEventForm.weekdayFallback"
  | "bulkEventForm.headerTitle"
  | "bulkEventForm.titleLabel"
  | "bulkEventForm.descriptionLabel"
  | "bulkEventForm.startDateLabel"
  | "bulkEventForm.endDateLabel"
  | "bulkEventForm.weekdayLabel"
  | "bulkEventForm.targetCalendarLabel"
  | "bulkEventForm.titlePlaceholder"
  | "bulkEventForm.descriptionPlaceholder"
  | "bulkEventForm.weekdayModalTitle"
  | "bulkEventForm.previewCountText"
  | "bulkEventForm.saveErrorFallback"
  | "bulkEventForm.weekdayOptionSuffix"
  // normalEventForm.*
  | "normalEventForm.notificationFallback"
  | "normalEventForm.shareFallback"
  | "normalEventForm.deleteConfirmTitle"
  | "normalEventForm.deleteConfirmMessage"
  | "normalEventForm.editHeaderTitle"
  | "normalEventForm.createHeaderTitle"
  | "normalEventForm.titleLabel"
  | "normalEventForm.dateLabel"
  | "normalEventForm.startFieldLabel"
  | "normalEventForm.endFieldLabel"
  | "normalEventForm.calendarLabel"
  | "normalEventForm.memoLabel"
  | "normalEventForm.titlePlaceholder"
  | "normalEventForm.memoPlaceholder"
  | "normalEventForm.shareModalTitle"
  | "normalEventForm.shareSelectedCount"
  | "normalEventForm.sharedNoticeError"
  | "normalEventForm.sharedNoticePending"
  | "normalEventForm.sharedNoticeSynced"
  | "normalEventForm.sharedNoticeNew"
  // newCalendarModal.*
  | "newCalendarModal.createErrorTitle"
  | "newCalendarModal.chooseTitle"
  | "newCalendarModal.localOptionTitle"
  | "newCalendarModal.localOptionSubtitle"
  | "newCalendarModal.sharedOptionTitle"
  | "newCalendarModal.sharedNotConfiguredSubtitle"
  | "newCalendarModal.sharedNeedsLoginSubtitle"
  | "newCalendarModal.sharedDefaultSubtitle"
  | "newCalendarModal.localNamePlaceholder"
  | "newCalendarModal.sharedNamePlaceholder"
  | "newCalendarModal.createButton"
  | "newCalendarModal.colorSwatchA11y"
  | "newCalendarModal.createErrorFallback"
  | "newCalendarModal.limitReachedTitle"
  | "newCalendarModal.myCalendarLimitReachedMessage"
  | "newCalendarModal.sharedCalendarLimitReachedMessage"
  | "newCalendarModal.manageExistingButton"
  | "newCalendarModal.limitReachedSubtitle"
  // fieldRow.*
  | "fieldRow.requiredBadge"
  // restrictedAppsList.*
  | "restrictedAppsList.noneSet"
  | "restrictedAppsList.restrictingText"
  | "restrictedAppsList.listSeparator"
  // records components (共通コンポーネント)
  | "streakGrid.title"
  | "weeklyBarChart.title"
  | "monthlyTrendChart.title"
  // aiScheduleCard.*
  | "aiScheduleCard.header"
  // account.*
  | "account.signOutConfirmTitle"
  | "account.signOutConfirmMessage"
  | "account.signOutErrorTitle"
  | "account.signOutErrorFallback"
  | "account.title"
  | "account.loggedInA11y"
  | "account.loggedInLabel"
  | "account.loggedInNote"
  | "account.signOutButton"
  | "account.signOutInProgressA11y"
  | "account.loggedOutA11y"
  | "account.loggedOutLabel"
  | "account.loggedOutSubLabel"
  | "account.loggedOutNote"
  | "account.signInButton"
  | "account.supabaseNotConfigured"
  // activity.*
  | "activity.title"
  | "activity.helperText"
  | "activity.emptyText"
  | "activity.completedLabel"
  | "activity.createdLabel"
  | "activity.updatedLabel"
  | "activity.dateTimeRow"
  // calendars.*
  | "calendars.filterFavorite"
  | "calendars.menuRemoveFavorite"
  | "calendars.menuAddFavorite"
  | "calendars.rowA11y"
  | "calendars.overflowMenuA11y"
  | "calendars.title"
  | "calendars.createRowText"
  | "calendars.cloudNotice"
  | "calendars.tabPersonal"
  | "calendars.tabShared"
  | "calendars.tabInvitations"
  | "calendars.personalIndicatorLabel"
  | "calendars.personalEmptyText"
  | "calendars.baseCalendarName"
  | "calendars.baseCalendarSubtitle"
  | "calendars.actionRename"
  | "calendars.actionChangeImage"
  | "calendars.actionChangeColor"
  | "calendars.actionRevertToDefaultImage"
  | "calendars.eventDisplaySectionTitle"
  | "calendars.eventDisplayEventsOnly"
  | "calendars.eventDisplayBoth"
  | "calendars.eventDisplayFocusOnly"
  | "calendars.eventDisplayHideAll"
  | "calendars.eventDisplaySummaryEventsOnly"
  | "calendars.eventDisplaySummaryBoth"
  | "calendars.eventDisplaySummaryFocusOnly"
  | "calendars.eventDisplaySummaryHideAll"
  | "calendars.createMyCalendarButton"
  | "calendars.actionViewDetail"
  | "calendars.actionShowOnlyThis"
  | "calendars.actionManageMembers"
  | "calendars.actionInviteMembers"
  | "calendars.actionEditSharedCalendar"
  | "calendars.actionViewMembers"
  | "calendars.ownedSharedSectionTitle"
  | "calendars.joinedSharedSectionTitle"
  | "calendars.joinedSharedCountLabel"
  | "calendars.createSharedCalendarButton"
  | "calendars.viewInvitationsLink"
  | "calendars.visibleLimitReachedMessage"
  | "calendars.searchPlaceholder"
  | "calendars.searchNoMatchText"
  | "calendars.ownedSharedEmptyTitle"
  | "calendars.joinedSharedEmptyTitle"
  | "calendars.ownerSoloLabel"
  | "calendars.nextEventLabel"
  | "calendars.eventCountLabel"
  | "calendars.noEventsLabel"
  | "calendars.invitationsExplainerTitle"
  | "calendars.invitationsExplainerBody"
  | "calendars.invitationsInboxComingSoonLabel"
  | "calendars.manageInvitesSectionTitle"
  | "calendars.manageInvitesRowSubtitle"
  | "calendars.receivedInvitationsSectionTitle"
  | "calendars.pendingInvitesEmptyTitle"
  | "calendars.pendingInvitesEmptyBody"
  | "calendars.sharedRequiresLoginTitle"
  | "calendars.invitationsRequiresLoginTitle"
  | "calendars.requiresLoginButton"
  | "calendars.tabInvitationsA11yWithCount"
  | "calendars.invitationsBadgeOverflow"
  // contact.*
  | "contact.missingFieldsTitle"
  | "contact.missingFieldsMessage"
  | "contact.unavailableTitle"
  | "contact.unavailableMessage"
  | "contact.mailBodyReplyLine"
  | "contact.mailClientErrorTitle"
  | "contact.mailClientErrorMessage"
  | "contact.title"
  | "contact.introText"
  | "contact.subjectLabel"
  | "contact.subjectPlaceholder"
  | "contact.bodyLabel"
  | "contact.bodyPlaceholder"
  | "contact.replyEmailLabel"
  | "contact.sendButton"
  // support.*
  | "support.tierCoffeeName"
  | "support.tierCoffeeDesc"
  | "support.tierLunchName"
  | "support.tierLunchDesc"
  | "support.tierSponsorName"
  | "support.tierSponsorDesc"
  | "support.notReadyTitle"
  | "support.notReadyMessage"
  | "support.headerTitle"
  | "support.heroDescription"
  | "support.whyBuiltLabel"
  | "support.whyBuiltBody"
  | "support.supportButton"
  | "support.futurePerksNotice"
  | "support.footerThanks"
  // overlay.*
  | "overlay.title"
  | "overlay.description"
  | "overlay.myCalendarsSectionTitle"
  | "overlay.sharedCalendarsSectionTitle"
  | "overlay.eventTypesSectionTitle"
  | "overlay.countLabel"
  | "overlay.addMyCalendarButton"
  | "overlay.addSharedCalendarButton"
  | "overlay.sharedCalendarsEmptyText"
  | "overlay.rowMenuA11y"
  | "overlay.normalEventsLabel"
  | "overlay.tasksLabel"
  | "overlay.autoSaveNote"
  | "overlay.saveErrorFallback"
  // records.*
  | "records.emptyTitle"
  | "records.emptyDescription"
  | "records.totalTimeLabel"
  | "records.completedLabel"
  | "records.completedCount"
  | "records.longestStreakLabel"
  | "records.longestStreakCount"
  | "records.ongoingTasksLabel"
  | "records.streakDaysCount"
  | "records.monthlyFocusLabel"
  | "records.newLabel"
  | "records.monthOverMonth"
  | "records.byTaskLabel"
  | "records.byWeekdayLabel"
  | "records.topWeekdayHint"
  | "records.trendHint"
  | "records.byTimeOfDayLabel"
  | "records.topTimeHint"
  | "records.yesterday"
  | "records.daysAgo"
  | "records.unknownTask"
  | "records.otherTasks"
  | "records.periodMorning"
  | "records.periodAfternoon"
  | "records.periodEvening"
  | "records.periodMidnight"
  // records.* (2026-08: 集中記録・分析システム 無料/プレミアム分析画面)
  | "records.screenTitle"
  | "records.rangeToday"
  | "records.rangeLast7Days"
  | "records.rangeLast30Days"
  | "records.rangeThisWeek"
  | "records.rangeThisMonth"
  | "records.rangeThisYear"
  | "records.rangeAllTime"
  | "records.rangeCustom"
  | "records.periodTotalTimeLabel"
  | "records.periodCompletedCountLabel"
  | "records.periodAverageTimeLabel"
  | "records.currentStreakLabel"
  | "records.longestStreakEverLabel"
  | "records.completionRateLabel"
  | "records.periodComparisonLabel"
  | "records.periodComparisonChange"
  | "records.byCalendarLabel"
  | "records.weekdayTendencyBestHint"
  | "records.timeOfDayTendencyBestHint"
  | "records.interruptionAnalysisLabel"
  | "records.pauseCountLabel"
  | "records.recentHistoryLabel"
  | "records.statusIncomplete"
  | "records.noDataLabel"
  | "records.insufficientDataLabel"
  | "records.noHistoryEmptyTitle"
  | "records.noHistoryEmptyBody"
  | "records.createFocusTaskButton"
  | "records.loadFailedMessage"
  | "records.reloadButton"
  | "records.recentDaysChartTitle"
  | "records.recentDaysChartBarA11y"
  | "records.todayMarker"
  | "records.customRangeStartLabel"
  | "records.customRangeEndLabel"
  | "records.customRangeInvalidMessage"
  | "records.calendarTypeMy"
  | "records.calendarTypeShared"
  | "records.unknownCalendar"
  | "records.historyItemA11y"
  | "records.noHistoryInPeriod"
  | "records.csvExportButton"
  | "records.csvExportFailedMessage"
  // authCallback.*
  | "authCallback.missingCodeError"
  | "authCallback.genericErrorFallback"
  | "authCallback.errorTitle"
  | "authCallback.backButton"
  // authCheckEmail.*
  | "authCheckEmail.resendFailedTitle"
  | "authCheckEmail.resendFailedFallback"
  | "authCheckEmail.resendSuccessTitle"
  | "authCheckEmail.resendSuccessMessage"
  | "authCheckEmail.copiedMessage"
  | "authCheckEmail.title"
  | "authCheckEmail.headline"
  | "authCheckEmail.description"
  | "authCheckEmail.resendButton"
  | "authCheckEmail.debugLabel"
  | "authCheckEmail.debugCopyA11y"
  | "authCheckEmail.debugCopyButton"
  | "authCheckEmail.debugNote"
  // authSignIn.*
  | "authSignIn.emailRequiredAlert"
  | "authSignIn.title"
  | "authSignIn.introText"
  | "authSignIn.notConfiguredNotice"
  | "authSignIn.emailLabel"
  | "authSignIn.sendLinkButton"
  | "authSignIn.orDividerText"
  | "authSignIn.oauthErrorFallback"
  | "authSignIn.continueWithGoogle"
  | "authSignIn.comingSoonMessage"
  // aiProcessing.*
  | "aiProcessing.errorTitleFallback"
  | "aiProcessing.errorDescription"
  | "aiProcessing.retryButton"
  | "aiProcessing.backToAiButton"
  | "aiProcessing.loadingText"
  | "aiProcessing.pendingSaveFailedFallback"
  | "aiProcessing.pendingRestoreFailedTitle"
  | "aiProcessing.pendingReloadButton"
  | "aiProcessing.pendingDiscardButton"
  | "aiProcessing.pendingConflictTitle"
  | "aiProcessing.pendingResumeButton"
  | "aiProcessing.pendingDiscardAndResendButton"
  // aiResult.*
  | "aiResult.emptyTitle"
  | "aiResult.emptyDescription"
  | "aiResult.weeklySummaryTitle"
  // aiMock.* (DemoAIServiceのデモ応答文言)
  | "aiMock.createScheduleHeadline"
  | "aiMock.sampleTaskTitle"
  | "aiMock.viewCalendarAction"
  | "aiMock.regenerateOtherAction"
  | "aiMock.suggestScheduleHeadline"
  | "aiMock.suggestScheduleDescription"
  | "aiMock.focusAnalysisHeadline"
  | "aiMock.focusAnalysisDescription"
  | "aiMock.summaryTotalFocusTimeLabel"
  | "aiMock.summaryTotalFocusTimeValue"
  | "aiMock.summaryTopTimeLabel"
  | "aiMock.summaryTopTimeValue"
  | "aiMock.summaryTopWeekdayLabel"
  | "aiMock.summaryTopWeekdayValue"
  | "aiMock.summaryTopTaskLabel"
  | "aiMock.summaryWeekOverWeekLabel"
  | "aiMock.summaryWeekOverWeekValue"
  | "aiMock.viewRecordsAction"
  | "aiMock.featureHelpHeadline"
  | "aiMock.featureHelpDescription"
  // seedData.* (初回起動時のデモ予定タイトル)
  | "seedData.work"
  | "seedData.meeting"
  | "seedData.hospitalVisit"
  | "seedData.novel"
  // eventDetail.*
  | "eventDetail.recurringAlertTitle"
  | "eventDetail.scopeThisOnly"
  | "eventDetail.scopeThisAndFuture"
  | "eventDetail.scopeAll"
  | "eventDetail.notFoundText"
  | "eventDetail.editScopeMessage"
  | "eventDetail.deleteScopeMessage"
  // P0040（QA-F007 C14 production integration）: 新しいC14統合経路の失敗メッセージ。
  // 既存のcommon.saveFailedTitleと組み合わせて使う（新しいAlert/Modalは追加しない）。
  | "eventDetail.unsupportedCrossDomainMoveMessage"
  | "eventDetail.unsupportedRecurringCalendarMoveMessage"
  | "eventDetail.migrationPendingRetryMessage"
  | "eventDetail.migrationConflictMessage"
  // P0078 DATA-F014-001: 共有カレンダー内の通常予定編集CAS保存の非committed結果。
  | "eventDetail.editConflictTitle"
  | "eventDetail.editConflictMessage"
  | "eventDetail.editNotFoundMessage"
  | "eventDetail.editNotAuthorizedMessage"
  | "eventDetail.editRetryableMessage"
  | "eventDetail.editUnknownOutcomeMessage"
  // eventNew.*
  | "eventNew.partialFailTitle"
  | "eventNew.partialFailMessage"
  | "eventNew.partialFailDiscardedMessage"
  | "eventNew.singleTabLabel"
  | "eventNew.bulkTabLabel"
  // dayAgenda.*
  | "dayAgenda.emptyTitle"
  | "dayAgenda.emptyDescription"
  | "dayAgenda.addFocusTaskButton"
  // focusDetail.*
  | "focusDetail.notFoundText"
  // focusActive.*
  | "focusActive.startButton"
  | "focusActive.preStartDescription"
  | "focusActive.unlockPenaltyText"
  | "focusActive.cancelConfirmTitle"
  | "focusActive.cancelConfirmMessage"
  | "focusActive.endButton"
  | "focusActive.inProgressLabel"
  | "focusActive.rangeSummary"
  | "focusActive.resumeButton"
  | "focusActive.pauseButton"
  | "focusActive.completeButton"
  | "focusActive.endEarlyButton"
  | "focusActive.unlockNote"
  | "focusActive.screenTitle"
  | "focusActive.menuA11y"
  | "focusActive.menuTitle"
  | "focusActive.conflictTitle"
  | "focusActive.conflictMessage"
  | "focusActive.conflictGoToActive"
  | "focusActive.conflictEndAndStartNew"
  | "focusActive.conflictCancelNewStart"
  | "focusActive.viewRecordsButton"
  | "focusActive.completedTitle"
  | "focusActive.cancelledTitle"
  | "focusActive.statusRunning"
  | "focusActive.statusPaused"
  | "focusActive.statusReady"
  | "focusActive.statElapsed"
  | "focusActive.statInterruptions"
  | "focusActive.statPausedDuration"
  | "focusActive.statPlanned"
  | "focusActive.statCountSuffix"
  | "focusActive.statMinutesSuffix"
  | "focusActive.completeHint"
  | "focusActive.notYetStartableMessage"
  | "dueFocusBanner.title"
  | "dueFocusBanner.startButton"
  // monthView.*
  | "monthView.movePreviewSuffix"
  // weekView.*
  | "weekView.dragPreviewLabel"
  | "weekView.prevWeekA11y"
  | "weekView.prevWeekLabel"
  | "weekView.swipeHint"
  | "weekView.nextWeekA11y"
  | "weekView.nextWeekLabel"
  // calendarDetail.*
  | "calendarDetail.notFoundText"
  | "calendarDetail.openSettingsOption"
  | "calendarDetail.shareInviteOption"
  | "calendarDetail.subtitleShared"
  | "calendarDetail.subtitleLocal"
  | "calendarDetail.overflowAvatarCount"
  | "calendarDetail.inviteChipLabel"
  | "calendarDetail.showEventsA11y"
  | "calendarDetail.membersA11y"
  | "calendarDetail.membersLabel"
  | "calendarDetail.settingsA11y"
  | "calendarDetail.roleNoticeOwnerEditor"
  | "calendarDetail.roleNoticeViewer"
  | "calendarDetail.upcomingSectionTitle"
  | "calendarDetail.showAllToggle"
  | "calendarDetail.upcomingEmptyText"
  // calendarMembers.*
  | "calendarMembers.removeConfirmTitle"
  | "calendarMembers.removeConfirmMessage"
  | "calendarMembers.memberFallbackNameForRemove"
  | "calendarMembers.title"
  | "calendarMembers.memberFallbackName"
  | "calendarMembers.editRoleA11y"
  | "calendarMembers.roleChangeFailedFallback"
  // calendarInvite.*
  | "calendarInvite.expiryText"
  | "calendarInvite.shareMessage"
  | "calendarInvite.createFailedTitle"
  | "calendarInvite.createFailedFallback"
  | "calendarInvite.copiedMessage"
  | "calendarInvite.revokeConfirmTitle"
  | "calendarInvite.revokeConfirmMessage"
  | "calendarInvite.revokeButton"
  | "calendarInvite.title"
  | "calendarInvite.ownerOnlyNotice"
  | "calendarInvite.createSectionTitle"
  | "calendarInvite.createHelper"
  | "calendarInvite.inviteAsEditorButton"
  | "calendarInvite.inviteAsViewerButton"
  | "calendarInvite.copyLastLinkButton"
  | "calendarInvite.emptyText"
  | "calendarInvite.inviteRoleText"
  | "calendarInvite.revokedStatus"
  | "calendarInvite.expiredStatus"
  | "calendarInvite.inviteeEmailLabel"
  | "calendarInvite.inviteeEmailHelper"
  | "calendarInvite.acceptedStatus"
  | "calendarInvite.declinedStatus"
  | "calendarInvite.acceptButton"
  | "calendarInvite.declineButton"
  | "calendarInvite.declineConfirmTitle"
  | "calendarInvite.declineConfirmMessage"
  | "calendarInvite.acceptingStatus"
  | "calendarInvite.decliningStatus"
  | "calendarInvite.acceptFailedMessage"
  | "calendarInvite.declineFailedMessage"
  | "calendarInvite.acceptedSuccessTitle"
  | "calendarInvite.acceptedSuccessMessage"
  | "calendarInvite.invitedBy"
  | "calendarInvite.inviterFallbackName"
  | "calendarInvite.reloadButton"
  | "calendarInvite.loadFailedMessage"
  // calendarSettings.*
  | "calendarSettings.inviteToggleFailedFallback"
  | "calendarSettings.copyFailedTitle"
  | "calendarSettings.shareFailedTitle"
  | "calendarSettings.deleteSharedMessage"
  | "calendarSettings.deleteLocalMessage"
  | "calendarSettings.deleteConfirmTitle"
  | "calendarSettings.leaveMessage"
  | "calendarSettings.leaveConfirmTitle"
  | "calendarSettings.leaveButton"
  | "calendarSettings.leaveFailedTitle"
  | "calendarSettings.title"
  | "calendarSettings.nameLabel"
  | "calendarSettings.themeColorLabel"
  | "calendarSettings.colorSwatchA11y"
  | "calendarSettings.favoriteAdded"
  | "calendarSettings.favoriteNotAdded"
  | "calendarSettings.roleNoticeOwnerEditor"
  | "calendarSettings.membersSummary"
  | "calendarSettings.inviteToggleLabel"
  | "calendarSettings.inviteToggleHelper"
  | "calendarSettings.shareButton"
  | "calendarSettings.copyLinkButton"
  | "calendarSettings.inviteManagementLabel"
  | "calendarSettings.checkingStatus"
  | "calendarSettings.activeInvitesCount"
  | "calendarSettings.memberLimitStatus"
  | "calendarSettings.memberLimitStatusWithInvites"
  | "calendarSettings.memberLimitReachedNotice"
  // inviteToken.*
  | "inviteToken.joinFailedFallback"
  | "inviteToken.title"
  | "inviteToken.joinedHeadline"
  | "inviteToken.roleSummary"
  | "inviteToken.openCalendarButton"
  | "inviteToken.needsLoginHeadline"
  | "inviteToken.signInButton"
  | "inviteToken.confirmHeadline"
  | "inviteToken.joinButton"
  // appDataContext.*
  | "appDataContext.notificationFailedTitle"
  | "appDataContext.notificationFailedMessage"
  // appDataInit.*（ROBUST-F001-002: 必須ローカルデータ初期化失敗時の全ルート共通エラー画面）
  | "appDataInit.errorTitle"
  | "appDataInit.errorMessage"
  | "appDataInit.retryButton"
  // rootErrorBoundary.*（ROBUST-F001-001: ルートError Boundaryのフォールバック画面。
  // LocaleProvider等のContextに依存できないため、この文言はProvider非依存の`t()`で読む）
  | "rootErrorBoundary.title"
  | "rootErrorBoundary.message"
  | "rootErrorBoundary.retryButton"
  // notFound.*（UX-F005-004: 不正・未一致のDeep Link等、Expo Routerが未一致ルートに使うアプリ独自の画面）
  | "notFound.title"
  | "notFound.message"
  | "notFound.homeButton";

const translations: Record<SupportedLocale, Record<TranslationKey, string>> = {
  ja: {
    "ai.header": "AIアシスト",
    "ai.usageRemainingToday": "今日あと{count}回",
    "ai.usageRemainingThisMonth": "今月あと{count}回",
    "ai.freeUsedUpTitle": "今日の無料利用分を使い切りました",
    "ai.watchAdBonusButton": "広告を見て{bonus}回追加",
    "ai.adBonusRemainingHint": "本日あと{count}回まで追加できます",
    "ai.dailyLimitReachedTitle": "本日のAI利用上限に達しました",
    "ai.dailyLimitResetHint": "明日、無料利用回数がリセットされます",
    "ai.usageFetchFailedTitle": "利用状況を取得できませんでした",
    "ai.usageRetryButton": "再試行",
    "ai.usageRequiresLoginTitle": "AIサポートの利用にはログインが必要です",
    "ai.usageRequiresLoginButton": "ログイン画面へ",
    "ai.suggestionsHeading": "おすすめ",
    "ai.historyHeading": "最近の履歴",
    "ai.historyEmpty": "まだ履歴がありません",
    "ai.description": "予定作成や集中の振り返り、\n機能説明などをAIがお手伝いします。",
    "ai.demoNotice": "Demo AI（端末内で生成される固定サンプル応答。外部LLMには接続しません）",
    "aiResult.applyToCalendarAction": "この予定をカレンダーへ追加",
    "aiResult.applyConfirmTitle": "カレンダーへ追加しますか？",
    "aiResult.applyConfirmMessage": "{{title}}\n{{date}} {{start}}〜{{end}}",
    "aiResult.applyConfirmAction": "追加する",
    "aiResult.applyDoneTitle": "追加しました",
    "aiResult.applyDoneMessage": "カレンダーに予定を追加しました。",
    "aiResult.applyDoneAction": "カレンダーを見る",
    "aiResult.applyFailedTitle": "追加できませんでした",
    "aiResult.applyFailedMessage": "予定の保存に失敗しました。時間をおいて試してください。",
    "aiResult.applyInvalidMessage": "提案された内容から予定を作成できませんでした。",
    "ai.voiceInputTitle": "音声入力",
    "ai.voiceInputComingSoon": "今後対応予定です",
    "ai.voiceInputA11y": "音声入力",
    "ai.inputPlaceholder": "やりたいことを入力してください",
    "ai.sendA11y": "送信",
    "ai.suggestion.organizeToday": "今日の予定を整理する",
    "ai.suggestion.organizeToday.description": "今日の予定を見やすく整理します",
    "ai.suggestion.findFreeTime": "空き時間を探す",
    "ai.suggestion.findFreeTime.description": "あなたの空き時間を見つけます",
    "ai.suggestion.organizeTodos": "今日やることを整理する",
    "ai.suggestion.organizeTodos.description": "今日のタスクを整理します",
    "ai.suggestion.reserveStudyTime": "勉強時間を確保したい",
    "ai.suggestion.reserveStudyTime.description": "学習時間を確保する提案をします",
    "ai.suggestion.reviewThisWeek": "今週の予定を確認する",
    "ai.suggestion.reviewThisWeek.description": "今週の予定をまとめて確認します",
    "language.pickerTitle": "言語",
    "language.jaLabel": "🇯🇵 日本語",
    "language.enLabel": "🇺🇸 English",
    "language.sheetTitle": "表示設定",
    "calendarHeader.menuLabel": "メニュー",
    "calendarHeader.addLabel": "新規登録",
    "calendarHeader.selectMonthLabel": "年月を選択",
    "calendarHeader.previousMonthLabel": "前の月へ",
    "calendarHeader.nextMonthLabel": "次の月へ",
    "calendarHeader.todayLabel": "今日",
    "calendarHeader.todayA11yLabel": "今日に移動",
    "calendarHeader.languageA11yLabel": "言語を切り替え",
    "yearMonthPicker.title": "年月を選択",
    "yearMonthPicker.backToThisMonth": "今月へ戻る",
    "yearMonthPicker.close": "閉じる",
    "menu.title": "メニュー",
    "menu.calendar": "カレンダー",
    "menu.account": "アカウント",
    "menu.accountLoggedInFallback": "ログイン中",
    "menu.accountLoggedOut": "未ログイン",
    "menu.records": "記録",
    "menu.visibleCalendars": "表示するカレンダー",
    "menu.aiSupport": "AIサポート",
    "menu.trainingIntegration": "トレーニングアプリ連携",
    "menu.trainingComingSoon": "今後対応予定",
    "menu.support": "開発を応援する",
    "menu.contact": "運営へのお問い合わせ",
    "menu.adPrivacySettings": "広告のプライバシー設定",
    "menu.holidayRegionLabel": "祝日の国・地域",
    "common.a11ySeparator": "、",
    "common.close": "閉じる",
    "common.confirm": "決定",
    "common.apply": "適用",
    "common.cancel": "キャンセル",
    "common.delete": "削除",
    "common.deleteAction": "削除する",
    "common.save": "保存",
    "common.back": "戻る",
    "common.notSet": "未設定",
    "common.notEntered": "未入力",
    "common.couldNotChange": "変更できませんでした",
    "common.couldNotDelete": "削除できませんでした",
    "common.copied": "コピーしました",
    "common.allDay": "終日",
    "common.selfSuffix": "（自分）",
    "common.comingSoon": "今後対応予定",
    "common.todaySuffix": "、今日",
    "common.requiredSuffix": "、必須",
    "common.errorSuffix": "、エラー: {error}",
    "common.moreCount": "他{count}件",
    "common.rangeSeparator": "〜",
    "common.startTime": "開始時刻",
    "common.endTime": "終了時刻",
    "common.tapToChangeHint": "タップして変更します",
    "common.notification": "通知",
    "common.repeat": "繰り返し",
    "common.shared": "共有",
    "common.saveFailedTitle": "保存できませんでした",
    "common.completed": "完了済み",
    "common.addEvent": "予定を追加",
    "common.durationHours": "{hours}時間",
    "common.durationMinutes": "{minutes}分",
    "common.durationHoursMinutes": "{hours}時間{minutes}分",
    "common.cannotMoveTitle": "移動できません",
    "common.saveFailedMessage": "元の位置に戻しました。もう一度お試しください。",
    "common.timeSlotSuffix": "の時間帯",
    "common.createEventHint": "タップした時間に新しい予定を作成します",
    "common.noVisibleEventsHint": "表示対象の予定がありません。表示設定からカレンダーまたは予定の種類を選択してください。",
    "calendarRole.owner": "オーナー",
    "calendarRole.editor": "編集者",
    "calendarRole.viewer": "閲覧のみ",
    "date.weekday0": "日",
    "date.weekday1": "月",
    "date.weekday2": "火",
    "date.weekday3": "水",
    "date.weekday4": "木",
    "date.weekday5": "金",
    "date.weekday6": "土",
    "validation.titleRequired": "予定名を入力してください",
    "validation.dateRequired": "日付を選択してください",
    "validation.dateInvalid": "日付の形式が正しくありません",
    "validation.timeInvalid": "時刻の形式が正しくありません",
    "validation.startTimeRequired": "開始時刻を入力してください",
    "validation.endTimeRequired": "終了時刻を入力してください",
    "validation.endTimeAfterStart": "終了時刻は開始時刻より後にしてください",
    "validation.taskNameRequired": "タスク名を入力してください",
    "validation.executionDateRequired": "実行日を選択してください",
    "validation.durationRequired": "集中時間を1分以上で設定してください",
    "validation.calendarRequired": "カレンダーを選択してください",
    "validation.startDateRequired": "開始日を選択してください",
    "validation.endDateRequired": "終了日を選択してください",
    "validation.weekdayRequired": "曜日を1つ以上選択してください",
    "validation.rangeFallback": "期間・曜日の指定を見直してください",
    "recurringDates.weekdayInvalid": "曜日の指定が不正です",
    "recurringDates.startBeforeEnd": "開始日は終了日より前の日付にしてください",
    "recurringDates.rangeTooLong": "期間は最大{max}日までにしてください",
    "recurringDates.tooManyGenerated": "生成できる予定は最大{max}件までです",
    "friendlyError.inviteNotFound": "招待リンクが見つかりませんでした",
    "friendlyError.inviteRevoked": "この招待は失効しています",
    "friendlyError.inviteExpired": "この招待は期限切れです",
    "friendlyError.rateLimit":
      "送信回数の上限に達しました。しばらく時間をおいてから、もう一度お試しください",
    "friendlyError.invalidEmail": "メールアドレスの形式が正しくありません",
    "friendlyError.network":
      "通信エラーが発生しました。電波状況をご確認のうえ、もう一度お試しください",
    "friendlyError.notAuthorized": "この操作を行う権限がありません",
    "friendlyError.session":
      "ログイン状態を確認できませんでした。もう一度ログインし直してください",
    "friendlyError.ownedSharedCalendarLimitExceeded":
      "所有できる共有カレンダーの上限に達しています。既存のカレンダーを整理してからもう一度お試しください",
    "friendlyError.sharedCalendarMemberLimitExceeded":
      "この共有カレンダーは人数上限に達しています。所有者を含めて最大5人まで参加できます",
    "friendlyError.localPersistenceFailed":
      "端末に保存できませんでした。空き容量を確認して、もう一度お試しください。",
    "friendlyError.sharedEventDeleteUnconfirmed":
      "削除できたかどうかを確認できませんでした。もう一度お試しください",
    "permissions.viewerCannotMove": "閲覧のみのため、この予定は移動できません",
    "permissions.overnightContinuationCannotMove": "前日から続く予定です。移動するには開始日から操作してください",
    "options.mainCalendar": "基本カレンダー",
    "options.restrictedAppYoutube": "YouTube",
    "options.restrictedAppX": "X",
    "options.restrictedAppGame": "ゲーム",
    "options.restrictedAppSns": "SNS全般",
    "options.restrictedAppBrowser": "ブラウザ",
    "options.notificationNone": "通知なし",
    "options.notificationAtStart": "開始時刻",
    "options.notification5Min": "5分前",
    "options.notification10Min": "10分前",
    "options.notification15Min": "15分前",
    "options.notification30Min": "30分前",
    "options.notification1Hour": "1時間前",
    "options.notification2Hour": "2時間前",
    "options.notification1Day": "1日前",
    "options.repeatNone": "なし",
    "options.repeatDaily": "毎日",
    "options.repeatWeekly": "毎週",
    "options.repeatMonthly": "毎月",
    "options.repeatYearly": "毎年",
    "options.unlockConditionNone": "設定しない",
    "options.unlockConditionCalculation": "計算問題で解除",
    "holiday.newYearsDay": "元日",
    "holiday.comingOfAgeDay": "成人の日",
    "holiday.nationalFoundationDay": "建国記念の日",
    "holiday.emperorsBirthday": "天皇誕生日",
    "holiday.vernalEquinoxDay": "春分の日",
    "holiday.showaDay": "昭和の日",
    "holiday.constitutionMemorialDay": "憲法記念日",
    "holiday.greeneryDay": "みどりの日",
    "holiday.childrensDay": "こどもの日",
    "holiday.marineDay": "海の日",
    "holiday.mountainDay": "山の日",
    "holiday.respectForTheAgedDay": "敬老の日",
    "holiday.autumnalEquinoxDay": "秋分の日",
    "holiday.sportsDay": "スポーツの日",
    "holiday.healthAndSportsDay": "体育の日",
    "holiday.cultureDay": "文化の日",
    "holiday.laborThanksgivingDay": "勤労感謝の日",
    "holiday.citizensHoliday": "国民の休日",
    "holiday.substituteHoliday": "振替休日",
    "holidayRegion.pickerTitle": "祝日の国・地域",
    "holidayRegion.jp": "日本",
    "holidayRegion.us": "アメリカ",
    "holidayRegion.gb": "イギリス",
    "holidayRegion.none": "祝日を表示しない",
    "notification.channelName": "予定の通知",
    "notification.eventBody": "{time}に開始予定です",
    "notification.focusEndTitle": "集中時間が終了しました",
    "notification.focusEndBody": "設定した集中時間が終了しました",
    "notification.focusStartTitle": "集中時間です",
    "notification.focusStartBody": "「{title}」を始めましょう",
    "notification.focusReminderTitle": "集中予定の{minutes}分前です",
    "notification.focusReminderBody": "「{title}」は{time}からです",
    "notification.untitledEventFallback": "無題の予定",
    "syncStatusBadge.synced": "共有カレンダーへ送信済み",
    "syncStatusBadge.pending": "送信待ち。オンラインになると自動的に送信されます",
    "syncStatusBadge.error":
      "送信できませんでした。オンラインになると自動的に再送信されます",
    "adPlaceholder.fallback": "広告",
    "viewSwitcher.month": "月",
    "viewSwitcher.week": "週",
    "viewSwitcher.day": "日",
    "focus.startButton": "集中モードを開始",
    "dayAgendaRow.focusTag": "集中",
    "dayAgendaRow.selfLabel": "自分",
    "dayAgendaRow.timeRangeA11y": "{start}から{end}",
    "bottomActionBar.overlay": "表示切替",
    "bottomActionBar.calendar": "カレンダー",
    "bottomActionBar.focus": "集中",
    "bottomActionBar.ai": "AI",
    "bottomActionBar.activity": "新着",
    "calendarVisibilityChips.mainChipName": "予定",
    "calendarVisibilityChips.manageA11y": "表示するカレンダーを管理",
    "calendarVisibilityChips.suffixShowing": "、表示中",
    "calendarVisibilityChips.suffixHidden": "、非表示",
    "monthDropConfirm.title": "移動先の時刻を確認",
    "monthDropConfirm.focusDurationKept": "（集中時間を維持）",
    "monthDropConfirm.originalTimeLabel": "元の時刻: {time}",
    "monthDropConfirm.newDateLabel": "移動先の日付: {date}",
    "monthDropConfirm.confirmButton": "この時刻で保存",
    "monthDropConfirm.keepOriginalButton": "元の時刻のまま保存",
    "focusTaskForm.deleteConfirmTitle": "集中タスクを削除",
    "focusTaskForm.deleteConfirmMessage": "このタスクを削除しますか？",
    "focusTaskForm.editHeaderTitle": "集中タスクを編集",
    "focusTaskForm.createHeaderTitle": "集中タスクを作成",
    "focusTaskForm.submitButton": "内容を確認",
    "focusTaskForm.taskNameLabel": "タスク名",
    "focusTaskForm.executionDateLabel": "実行日",
    "focusTaskForm.durationLabel": "集中時間",
    "focusTaskForm.calendarLabel": "予定表",
    "focusTaskForm.restrictedAppsLabel": "制限するアプリ",
    "focusTaskForm.midUnlockLabel": "途中解除",
    "focusTaskForm.unlockConditionLabel": "解除の条件",
    "focusTaskForm.memoLabel": "その他の設定／メモ",
    "focusTaskForm.alreadyCompletedLabel": "完了済み",
    "focusTaskForm.lockedNoticeLabel": "カレンダーに鍵付きで登録されます",
    "focusTaskForm.taskNamePlaceholder": "例：AWS学習",
    "focusTaskForm.memoPlaceholder": "メモを入力",
    "focusTaskForm.unlockConditionModalTitle": "途中解除の条件",
    "focusTaskForm.unlockCountModalTitle": "解除の条件（計算問題の問題数）",
    "focusTaskForm.unlockCountSummary": "計算問題{count}問",
    "focusTaskForm.unlockCountOption": "{count}問",
    "focusTaskForm.viewRecordsButton": "集中記録・分析を見る",
    "focusTaskForm.viewRecordsAccessibilityLabel": "集中記録・分析画面を開く",
    "bulkEventForm.weekdayFallback": "未選択",
    "bulkEventForm.headerTitle": "予定を追加（一括作成）",
    "bulkEventForm.titleLabel": "タイトル",
    "bulkEventForm.descriptionLabel": "説明",
    "bulkEventForm.startDateLabel": "開始日",
    "bulkEventForm.endDateLabel": "終了日",
    "bulkEventForm.weekdayLabel": "曜日",
    "bulkEventForm.targetCalendarLabel": "対象カレンダー",
    "bulkEventForm.titlePlaceholder": "例：ジム",
    "bulkEventForm.descriptionPlaceholder": "説明を入力",
    "bulkEventForm.weekdayModalTitle": "曜日（複数選択可）",
    "bulkEventForm.previewCountText": "{count}件の予定が作成されます",
    "bulkEventForm.saveErrorFallback": "保存できませんでした。もう一度お試しください",
    "bulkEventForm.weekdayOptionSuffix": "{label}曜日",
    "normalEventForm.notificationFallback": "通知しない",
    "normalEventForm.shareFallback": "共有しない",
    "normalEventForm.deleteConfirmTitle": "予定を削除",
    "normalEventForm.deleteConfirmMessage": "この予定を削除しますか？",
    "normalEventForm.editHeaderTitle": "予定を編集",
    "normalEventForm.createHeaderTitle": "予定を追加",
    "normalEventForm.titleLabel": "予定名",
    "normalEventForm.dateLabel": "日付",
    "normalEventForm.startFieldLabel": "開始",
    "normalEventForm.endFieldLabel": "終了",
    "normalEventForm.calendarLabel": "予定表",
    "normalEventForm.memoLabel": "メモ",
    "normalEventForm.titlePlaceholder": "例：面談",
    "normalEventForm.memoPlaceholder": "メモを入力",
    "normalEventForm.shareModalTitle": "共有する予定",
    "normalEventForm.shareSelectedCount": "{count}件選択中",
    "normalEventForm.sharedNoticeError":
      "共有カレンダー「{name}」の予定です。前回の変更を送信できませんでした。もう一度保存すると再送信されます。",
    "normalEventForm.sharedNoticePending":
      "共有カレンダー「{name}」の予定です。前回の変更はまだ送信されていません。オンラインになると自動的に送信されます。",
    "normalEventForm.sharedNoticeSynced":
      "共有カレンダー「{name}」の予定です。参加しているメンバーに表示されます。",
    "normalEventForm.sharedNoticeNew":
      "共有カレンダー「{name}」の予定として保存されます。参加しているメンバーに表示されます。",
    "newCalendarModal.createErrorTitle": "作成できませんでした",
    "newCalendarModal.chooseTitle": "新しいカレンダーを作る",
    "newCalendarModal.localOptionTitle": "個人カレンダー",
    "newCalendarModal.localOptionSubtitle": "自分だけで予定を管理します",
    "newCalendarModal.sharedOptionTitle": "共有カレンダー",
    "newCalendarModal.sharedNotConfiguredSubtitle": "Supabase未設定のため利用できません",
    "newCalendarModal.sharedNeedsLoginSubtitle": "ログインすると作成できます",
    "newCalendarModal.sharedDefaultSubtitle": "家族や友人と予定を共有します",
    "newCalendarModal.localNamePlaceholder": "例：小説制作メモ",
    "newCalendarModal.sharedNamePlaceholder": "例：家族の予定",
    "newCalendarModal.createButton": "作成する",
    "newCalendarModal.colorSwatchA11y": "{n}番目の色",
    "newCalendarModal.createErrorFallback": "作成できませんでした。もう一度お試しください",
    "newCalendarModal.limitReachedTitle": "上限に達しています",
    "newCalendarModal.myCalendarLimitReachedMessage": "マイカレンダーは自分一人用を含めて合計{limit}個までです。",
    "newCalendarModal.sharedCalendarLimitReachedMessage": "共有カレンダーは{limit}個まで作成できます。",
    "newCalendarModal.manageExistingButton": "既存カレンダーを管理",
    "newCalendarModal.limitReachedSubtitle": "上限（{limit}個）に達しています",
    "fieldRow.requiredBadge": "必須",
    "restrictedAppsList.noneSet": "制限アプリは未設定です",
    "restrictedAppsList.restrictingText": "{names}を制限中",
    "restrictedAppsList.listSeparator": "・",
    "streakGrid.title": "完了状況（過去7日間）",
    "weeklyBarChart.title": "今週の達成",
    "monthlyTrendChart.title": "過去12か月の推移",
    "aiScheduleCard.header": "予定案",
    "account.signOutConfirmTitle": "ログアウトしますか？",
    "account.signOutConfirmMessage": "端末内の個人予定・集中機能はログアウト後も残ります。",
    "account.signOutErrorTitle": "ログアウトできませんでした",
    "account.signOutErrorFallback": "ログアウトできませんでした。もう一度お試しください",
    "account.title": "アカウント",
    "account.loggedInA11y": "{email}、ログイン中",
    "account.loggedInLabel": "ログイン中",
    "account.loggedInNote":
      "ログアウトしても、この端末内の個人の予定・集中タスクは消えません。共有カレンダーの予定は再ログインするまで見られなくなります。",
    "account.signOutButton": "ログアウト",
    "account.signOutInProgressA11y": "ログアウト処理中",
    "account.loggedOutA11y": "未ログイン、個人の予定・集中機能はこのままお使いいただけます",
    "account.loggedOutLabel": "未ログイン",
    "account.loggedOutSubLabel": "個人の予定・集中機能はこのままお使いいただけます",
    "account.loggedOutNote": "カレンダーを人と共有する・招待に参加するときだけログインが必要です。",
    "account.signInButton": "ログイン",
    "account.supabaseNotConfigured": "Supabase未設定のため、ログインは利用できません。",
    "activity.title": "新着",
    "activity.helperText": "追加・変更した予定や、集中タスクの達成履歴を確認できます。",
    "activity.emptyText": "新着はまだありません",
    "activity.completedLabel": "達成しました",
    "activity.createdLabel": "予定を作成しました",
    "activity.updatedLabel": "予定を更新しました",
    "activity.dateTimeRow": "{date}　{time}",
    "calendars.filterFavorite": "お気に入り",
    "calendars.menuRemoveFavorite": "お気に入りから外す",
    "calendars.menuAddFavorite": "お気に入りに追加",
    "calendars.rowA11y": "{name}、{status}",
    "calendars.overflowMenuA11y": "その他のメニュー",
    "calendars.title": "カレンダー",
    "calendars.createRowText": "新しいカレンダーを作る",
    "calendars.cloudNotice": "Supabase未設定のため、共有カレンダーは現在利用できません",
    "calendars.tabPersonal": "マイカレンダー",
    "calendars.tabShared": "共有",
    "calendars.tabInvitations": "招待",
    "calendars.personalIndicatorLabel": "端末内",
    "calendars.personalEmptyText": "個人カレンダーがありません",
    "calendars.baseCalendarName": "自分一人用",
    "calendars.baseCalendarSubtitle": "削除できない基本のカレンダー",
    "calendars.actionRename": "名前を編集",
    "calendars.actionChangeImage": "画像を設定・変更",
    "calendars.actionChangeColor": "テーマカラーを変更",
    "calendars.actionRevertToDefaultImage": "標準表示に戻す",
    "calendars.eventDisplaySectionTitle": "表示する予定",
    "calendars.eventDisplayEventsOnly": "通常のみ",
    "calendars.eventDisplayBoth": "両方",
    "calendars.eventDisplayFocusOnly": "集中のみ",
    "calendars.eventDisplayHideAll": "すべて非表示",
    "calendars.eventDisplaySummaryEventsOnly": "通常の予定だけを表示します。",
    "calendars.eventDisplaySummaryBoth": "通常の予定と集中タスクを同じカレンダー上に表示します。",
    "calendars.eventDisplaySummaryFocusOnly": "集中タスクだけを表示します。",
    "calendars.eventDisplaySummaryHideAll": "予定を表示しません。",
    "calendars.createMyCalendarButton": "＋ マイカレンダーを作成する",
    "calendars.actionViewDetail": "カレンダー詳細を見る",
    "calendars.actionShowOnlyThis": "このカレンダーだけ表示",
    "calendars.actionManageMembers": "メンバーを管理",
    "calendars.actionInviteMembers": "メンバーを招待",
    "calendars.actionEditSharedCalendar": "名前・画像・カラーを変更",
    "calendars.actionViewMembers": "メンバーを見る",
    "calendars.ownedSharedSectionTitle": "自分が作成した共有カレンダー",
    "calendars.joinedSharedSectionTitle": "参加中の共有カレンダー",
    "calendars.joinedSharedCountLabel": "{count}件",
    "calendars.createSharedCalendarButton": "＋ 共有カレンダーを作成する",
    "calendars.viewInvitationsLink": "招待を確認する",
    "calendars.visibleLimitReachedMessage":
      "同時に表示できるカレンダーは5個までです。表示中のカレンダーを1つ外してください。",
    "calendars.searchPlaceholder": "共有カレンダーを検索",
    "calendars.searchNoMatchText": "一致する共有カレンダーがありません",
    "calendars.ownedSharedEmptyTitle": "まだ共有カレンダーを作成していません",
    "calendars.joinedSharedEmptyTitle": "参加中の共有カレンダーはありません",
    "calendars.ownerSoloLabel": "オーナー（自分のみ）",
    "calendars.nextEventLabel": "次の予定: {date} {title}",
    "calendars.eventCountLabel": "予定{count}件",
    "calendars.noEventsLabel": "予定なし",
    "calendars.invitationsExplainerTitle": "招待はリンクで届きます",
    "calendars.invitationsExplainerBody":
      "共有カレンダーのオーナーから送られた招待リンクを開くと参加できます。",
    "calendars.invitationsInboxComingSoonLabel": "招待の受信一覧",
    "calendars.manageInvitesSectionTitle": "自分のカレンダーへの招待を管理",
    "calendars.manageInvitesRowSubtitle": "招待リンクを管理",
    "calendars.receivedInvitationsSectionTitle": "受信した招待",
    "calendars.pendingInvitesEmptyTitle": "招待はありません",
    "calendars.pendingInvitesEmptyBody": "新しい招待が届くと、ここに表示されます",
    "calendars.sharedRequiresLoginTitle": "共有カレンダーの利用にはログインが必要です",
    "calendars.invitationsRequiresLoginTitle": "招待の確認・参加にはログインが必要です",
    "calendars.requiresLoginButton": "ログイン画面へ",
    "calendars.tabInvitationsA11yWithCount": "招待、未処理{count}件",
    "calendars.invitationsBadgeOverflow": "99+",
    "contact.missingFieldsTitle": "未入力があります",
    "contact.missingFieldsMessage": "件名と内容を入力してください",
    "contact.unavailableTitle": "お問い合わせを利用できません",
    "contact.unavailableMessage": "現在お問い合わせ機能は準備中です。",
    "contact.mailBodyReplyLine": "{body}\n\n---\n返信用メールアドレス: {email}",
    "contact.mailClientErrorTitle": "メールアプリを起動できませんでした",
    "contact.mailClientErrorMessage": "端末にメールアプリが設定されているかご確認ください。",
    "contact.title": "運営へのお問い合わせ",
    "contact.introText":
      "不具合、使い方、要望などを運営へ送るフォームです。AIサポートとは別に、人へ伝えたい内容に使えます。",
    "contact.subjectLabel": "件名",
    "contact.subjectPlaceholder": "例：週表示について",
    "contact.bodyLabel": "内容",
    "contact.bodyPlaceholder": "詳しい内容を入力",
    "contact.replyEmailLabel": "返信用メール（任意）",
    "contact.sendButton": "確認して送る",
    "support.tierCoffeeName": "コーヒー1杯応援",
    "support.tierCoffeeDesc": "ちょっとした応援に",
    "support.tierLunchName": "ランチ応援",
    "support.tierLunchDesc": "しっかり応援したい方に",
    "support.tierSponsorName": "スポンサー",
    "support.tierSponsorDesc": "開発を強力に後押し",
    "support.notReadyTitle": "準備中です",
    "support.notReadyMessage":
      "「{name}」（¥{price}）は、正式リリース時にApp Store／Google Playの購入の仕組みでご利用いただけるようになります。",
    "support.headerTitle": "運営を応援する",
    "support.heroDescription":
      "Focus Calendarの開発を応援していただけると、新機能追加や改善を継続できます。{br}いただいた支援は、サーバー代・開発費・デザイン制作などに活用します。",
    "support.whyBuiltLabel": "このアプリを作った理由",
    "support.whyBuiltBody":
      "忙しい毎日でも、目標や大切な予定を忘れず、自分の時間を大切にできるカレンダーを作りたい。その思いでFocus Calendarを開発しています。",
    "support.supportButton": "応援する",
    "support.futurePerksNotice": "支援者特典（将来）：現在はありません",
    "support.footerThanks":
      "応援ありがとうございます！{br}皆さんに「毎日使いたくなるカレンダー」を届けられるよう開発を続けます。",
    "overlay.title": "表示設定",
    "overlay.description": "表示するカレンダーと予定の種類を選択できます。",
    "overlay.myCalendarsSectionTitle": "マイカレンダー",
    "overlay.sharedCalendarsSectionTitle": "共有カレンダー",
    "overlay.eventTypesSectionTitle": "表示する予定の種類",
    "overlay.countLabel": "{count} / {limit}",
    "overlay.addMyCalendarButton": "＋ 新しいカレンダー",
    "overlay.addSharedCalendarButton": "＋ 共有カレンダーを作成・参加",
    "overlay.sharedCalendarsEmptyText": "共有カレンダーはまだありません",
    "overlay.rowMenuA11y": "{name}の設定を開く",
    "overlay.normalEventsLabel": "通常の予定",
    "overlay.tasksLabel": "タスク",
    "overlay.autoSaveNote": "変更は自動的に保存され、すぐにカレンダーへ反映されます。",
    "overlay.saveErrorFallback": "表示設定を保存できませんでした。もう一度お試しください",
    "records.emptyTitle": "まだ記録がありません",
    "records.emptyDescription": "集中モードを完了すると、ここに達成記録が表示されます",
    "records.totalTimeLabel": "累計達成時間",
    "records.completedLabel": "完了",
    "records.completedCount": "{count}回",
    "records.longestStreakLabel": "最長継続",
    "records.longestStreakCount": "{count}日",
    "records.ongoingTasksLabel": "継続中のタスク",
    "records.streakDaysCount": "{count}日継続中",
    "records.monthlyFocusLabel": "今月の集中時間",
    "records.newLabel": "新規",
    "records.monthOverMonth": "前月比 {sign}{percent}%",
    "records.byTaskLabel": "タスク別",
    "records.byWeekdayLabel": "曜日別集中傾向",
    "records.topWeekdayHint": "最も集中している曜日：{label}曜日",
    "records.trendHint": "記録が増えると傾向を確認できます",
    "records.byTimeOfDayLabel": "時間帯別集中傾向",
    "records.topTimeHint": "最も集中できる時間帯：{label}",
    "records.yesterday": "昨日",
    "records.daysAgo": "{days}日前",
    "records.unknownTask": "不明なタスク",
    "records.otherTasks": "その他",
    "records.periodMorning": "朝",
    "records.periodAfternoon": "昼",
    "records.periodEvening": "夜",
    "records.periodMidnight": "深夜",
    "records.screenTitle": "集中記録・分析",
    "records.rangeToday": "今日",
    "records.rangeLast7Days": "直近7日",
    "records.rangeLast30Days": "直近30日",
    "records.rangeThisWeek": "今週",
    "records.rangeThisMonth": "今月",
    "records.rangeThisYear": "今年",
    "records.rangeAllTime": "全期間",
    "records.rangeCustom": "期間を選択",
    "records.periodTotalTimeLabel": "総集中時間",
    "records.periodCompletedCountLabel": "完了回数",
    "records.periodAverageTimeLabel": "平均集中時間",
    "records.currentStreakLabel": "現在の連続記録",
    "records.longestStreakEverLabel": "最長連続記録",
    "records.completionRateLabel": "完遂率",
    "records.periodComparisonLabel": "前期間との比較",
    "records.periodComparisonChange": "前期間比 {sign}{percent}%",
    "records.byCalendarLabel": "カレンダー別",
    "records.weekdayTendencyBestHint": "完遂率が一番高い曜日：{label}曜日",
    "records.timeOfDayTendencyBestHint": "完遂率が一番高い時間帯：{label}",
    "records.interruptionAnalysisLabel": "中断分析",
    "records.pauseCountLabel": "一時停止回数",
    "records.recentHistoryLabel": "最近の集中履歴",
    "records.statusIncomplete": "未完了",
    "records.noDataLabel": "データなし",
    "records.insufficientDataLabel": "十分なデータがありません",
    "records.noHistoryEmptyTitle": "まだ集中記録がありません",
    "records.noHistoryEmptyBody": "集中モードを最後まで完了すると、ここに記録されます",
    "records.createFocusTaskButton": "集中タスクを作成する",
    "records.loadFailedMessage": "記録を読み込めませんでした",
    "records.reloadButton": "再読み込み",
    "records.recentDaysChartTitle": "直近7日間の集中時間",
    "records.recentDaysChartBarA11y": "{day}、{duration}",
    "records.todayMarker": "今日",
    "records.customRangeStartLabel": "開始日",
    "records.customRangeEndLabel": "終了日",
    "records.customRangeInvalidMessage": "終了日は開始日以降にしてください",
    "records.calendarTypeMy": "マイカレンダー",
    "records.calendarTypeShared": "共有",
    "records.unknownCalendar": "不明なカレンダー",
    "records.historyItemA11y": "{title}、{date} {time}開始、{duration}、{status}",
    "records.noHistoryInPeriod": "この期間の記録はありません",
    "records.csvExportButton": "CSVで出力",
    "records.csvExportFailedMessage": "CSV出力に失敗しました",
    "authCallback.missingCodeError": "リンクの情報が見つかりませんでした",
    "authCallback.genericErrorFallback": "ログインを確認できませんでした。もう一度お試しください",
    "authCallback.errorTitle": "ログインを確認できませんでした",
    "authCallback.backButton": "ログイン画面へ戻る",
    "authCheckEmail.resendFailedTitle": "送信できませんでした",
    "authCheckEmail.resendFailedFallback":
      "ログインリンクを送信できませんでした。もう一度お試しください",
    "authCheckEmail.resendSuccessTitle": "送信しました",
    "authCheckEmail.resendSuccessMessage": "メールを再度ご確認ください。",
    "authCheckEmail.copiedMessage":
      "Supabaseの「Redirect URLs」に貼り付けて追加・保存してください。",
    "authCheckEmail.title": "メールを確認",
    "authCheckEmail.headline": "{email} にログインリンクを送信しました",
    "authCheckEmail.description":
      "メールを開き、本文中の「Sign in」（ログイン）リンクをタップしてください。このアプリに戻り、自動的にログインが完了します。リンクは一定時間で無効になります。",
    "authCheckEmail.resendButton": "メールが届かない場合はもう一度送る",
    "authCheckEmail.debugLabel": "診断用（リンクを開いてもlocalhostに接続できない場合）",
    "authCheckEmail.debugCopyA11y": "診断用URLをコピー",
    "authCheckEmail.debugCopyButton": "コピー",
    "authCheckEmail.debugNote":
      "このURLをSupabaseの「Authentication → URL Configuration → Redirect URLs」に貼り付けて保存してください。保存しただけでは今回送信済みのメールには反映されないため、保存後は必ず「もう一度送る」から新しいログインリンクを送信し直して確認してください。",
    "authSignIn.emailRequiredAlert": "メールアドレスを入力してください",
    "authSignIn.title": "ログイン",
    "authSignIn.introText":
      "共有カレンダーの作成・招待・参加にはログインが必要です。個人の予定・集中機能はログインなしで引き続き使えます。",
    "authSignIn.notConfiguredNotice":
      "現在Supabaseが未設定のため、ログインは利用できません。SUPABASE_SETUP.mdの手順を完了してください。",
    "authSignIn.emailLabel": "メールアドレス",
    "authSignIn.sendLinkButton": "ログインリンクを送る",
    "authSignIn.orDividerText": "または",
    "authSignIn.oauthErrorFallback": "ログインに失敗しました。時間をおいて再度お試しください。",
    "authSignIn.continueWithGoogle": "Googleで続ける",
    "authSignIn.comingSoonMessage": "このログイン方法は現在準備中です。",
    "aiProcessing.errorTitleFallback": "通信できませんでした",
    "aiProcessing.errorDescription": "しばらくしてからもう一度お試しください。",
    "aiProcessing.retryButton": "もう一度試す",
    "aiProcessing.backToAiButton": "AIサポートに戻る",
    "aiProcessing.loadingText": "考えています…",
    "aiProcessing.pendingSaveFailedFallback": "依頼の保存に失敗しました。もう一度お試しください。",
    "aiProcessing.pendingRestoreFailedTitle": "未完了のAI依頼を確認できませんでした",
    "aiProcessing.pendingReloadButton": "再読み込み",
    "aiProcessing.pendingDiscardButton": "破棄する",
    "aiProcessing.pendingConflictTitle": "前回完了しなかった依頼があります",
    "aiProcessing.pendingResumeButton": "前回の依頼を続ける",
    "aiProcessing.pendingDiscardAndResendButton": "破棄して今回の内容を送信する",
    "aiResult.emptyTitle": "結果を表示できませんでした",
    "aiResult.emptyDescription": "AIサポートに戻ってもう一度お試しください",
    "aiResult.weeklySummaryTitle": "今週の集中サマリー",
    "aiMock.createScheduleHeadline": "予定を作成しました",
    "aiMock.sampleTaskTitle": "AWS学習",
    "aiMock.viewCalendarAction": "カレンダーで確認",
    "aiMock.regenerateOtherAction": "別の提案を見る",
    "aiMock.suggestScheduleHeadline": "空き時間を見つけました",
    "aiMock.suggestScheduleDescription": "今週は火曜19:00〜20:00、木曜20:00〜21:00が空いています。",
    "aiMock.focusAnalysisHeadline": "集中の分析結果",
    "aiMock.focusAnalysisDescription":
      "今週は夜に集中する傾向があります。{task}が最も多く、先週より15%増えています。",
    "aiMock.summaryTotalFocusTimeLabel": "総集中時間",
    "aiMock.summaryTotalFocusTimeValue": "8時間40分",
    "aiMock.summaryTopTimeLabel": "最も集中した時間帯",
    "aiMock.summaryTopTimeValue": "夜（17時〜22時）",
    "aiMock.summaryTopWeekdayLabel": "最も集中した曜日",
    "aiMock.summaryTopWeekdayValue": "土曜日",
    "aiMock.summaryTopTaskLabel": "最も集中したタスク",
    "aiMock.summaryWeekOverWeekLabel": "先週比",
    "aiMock.summaryWeekOverWeekValue": "+15%",
    "aiMock.viewRecordsAction": "もっと詳しく分析する",
    "aiMock.featureHelpHeadline": "使い方をご案内します",
    "aiMock.featureHelpDescription":
      "画面下部の入力欄に「予定を作成」のように話しかけると、AIが内容を理解して予定案を作ります。集中モードの分析やアプリの操作方法についても質問できます。",
    "seedData.work": "仕事",
    "seedData.meeting": "面談",
    "seedData.hospitalVisit": "通院",
    "seedData.novel": "小説",
    "eventDetail.recurringAlertTitle": "繰り返し予定です",
    "eventDetail.scopeThisOnly": "この予定だけ",
    "eventDetail.scopeThisAndFuture": "この予定以降",
    "eventDetail.scopeAll": "すべて",
    "eventDetail.notFoundText": "予定が見つかりませんでした",
    "eventDetail.editScopeMessage": "変更を反映する範囲を選択してください。",
    "eventDetail.deleteScopeMessage": "削除する範囲を選択してください。",
    "eventDetail.unsupportedCrossDomainMoveMessage":
      "端末内カレンダーと共有カレンダーの間での移動は現在サポートされていません。",
    "eventDetail.unsupportedRecurringCalendarMoveMessage":
      "繰り返し予定の「この予定以降」「すべて」では、予定表（カレンダー）の変更はできません。「この予定だけ」を選ぶか、予定表を変更せずに保存してください。",
    "eventDetail.migrationPendingRetryMessage":
      "予定の移動を処理しています。この状態は確認・再試行が必要です。しばらくしてからもう一度お試しください。",
    "eventDetail.migrationConflictMessage":
      "他の場所で予定が変更されたため、この移動を完了できませんでした。最新の内容を確認してからやり直してください。",
    "eventDetail.editConflictTitle": "他の変更と競合しました",
    "eventDetail.editConflictMessage":
      "この予定はあなたが開いた後に他の人が先に保存しました。入力内容はそのまま残っていますので、最新の内容を確認してからもう一度保存してください。",
    "eventDetail.editNotFoundMessage":
      "この予定は他の場所で削除された可能性があります。画面を開き直して最新の状態を確認してください。",
    "eventDetail.editNotAuthorizedMessage":
      "この予定表を編集する権限がなくなっている可能性があります。参加状況を確認してください。",
    "eventDetail.editRetryableMessage":
      "通信が不安定なため保存できませんでした。この予定はまだ保存されていません。もう一度保存をお試しください。",
    "eventDetail.editUnknownOutcomeMessage":
      "保存できたかどうかを確認できませんでした。画面を開き直して最新の内容を確認してください。",
    "eventNew.partialFailTitle": "一部の予定を送信できませんでした",
    "eventNew.partialFailMessage":
      "オフラインまたは通信エラーの可能性があります。オンライン復帰後に自動的に再送信されます。",
    "eventNew.partialFailDiscardedMessage":
      "処理中にログイン中のアカウントが切り替わったため、一部の予定は保存されませんでした。もう一度お試しください。",
    "eventNew.singleTabLabel": "通常作成",
    "eventNew.bulkTabLabel": "一括作成",
    "dayAgenda.emptyTitle": "予定がありません",
    "dayAgenda.emptyDescription": "この日の予定はまだ登録されていません",
    "dayAgenda.addFocusTaskButton": "集中タスクを追加",
    "focusDetail.notFoundText": "集中タスクが見つかりませんでした",
    "focusActive.startButton": "集中モードを開始",
    "focusActive.preStartDescription": "{start}から{duration}分の集中予定です",
    "focusActive.unlockPenaltyText": "解除には計算問題{count}問の正解が必要です。",
    "focusActive.cancelConfirmTitle": "集中モードを途中で終了しますか？",
    "focusActive.cancelConfirmMessage": "{penalty}\n本当に終了する場合は「終了する」を押してください。",
    "focusActive.endButton": "終了する",
    "focusActive.inProgressLabel": "集中予定",
    "focusActive.rangeSummary": "{start}から{duration}分",
    "focusActive.resumeButton": "再開する",
    "focusActive.pauseButton": "中断する",
    "focusActive.completeButton": "完了する",
    "focusActive.endEarlyButton": "集中を終了する",
    "focusActive.unlockNote": "解除には計算問題{count}問が必要です",
    "focusActive.screenTitle": "集中",
    "focusActive.menuA11y": "その他のメニュー",
    "focusActive.menuTitle": "集中セッションの操作",
    "focusActive.conflictTitle": "現在集中中の予定があります",
    "focusActive.conflictMessage": "「{title}」を集中中です。新しい集中セッションは、現在のセッションを完了または終了してから開始できます。",
    "focusActive.conflictGoToActive": "そちらへ戻る",
    "focusActive.conflictEndAndStartNew": "終了して新しく始める",
    "focusActive.conflictCancelNewStart": "新しい開始をやめる",
    "focusActive.viewRecordsButton": "記録を見る",
    "focusActive.completedTitle": "集中が完了しました",
    "focusActive.cancelledTitle": "集中を終了しました",
    "focusActive.statusRunning": "集中中",
    "focusActive.statusPaused": "中断中",
    "focusActive.statusReady": "完了可能",
    "focusActive.statElapsed": "経過時間",
    "focusActive.statInterruptions": "中断回数",
    "focusActive.statPausedDuration": "中断時間",
    "focusActive.statPlanned": "予定時間",
    "focusActive.statCountSuffix": "{count}回",
    "focusActive.statMinutesSuffix": "{count}分",
    "focusActive.completeHint": "残り時間が00:00になると完了できます",
    "focusActive.notYetStartableMessage": "この集中予定は{start}から開始できます。",
    "dueFocusBanner.title": "集中予定の開始時刻です",
    "dueFocusBanner.startButton": "集中を開始",
    "monthView.movePreviewSuffix": "{day}日へ移動",
    "weekView.dragPreviewLabel": "{weekday}曜{day}日 {time}",
    "weekView.prevWeekA11y": "前の週へ",
    "weekView.prevWeekLabel": "‹ 前の週",
    "weekView.swipeHint": "横にスライドして日を移動",
    "weekView.nextWeekA11y": "次の週へ",
    "weekView.nextWeekLabel": "次の週 ›",
    "calendarDetail.notFoundText": "カレンダーが見つかりませんでした",
    "calendarDetail.openSettingsOption": "設定を開く",
    "calendarDetail.shareInviteOption": "共有する（招待リンク）",
    "calendarDetail.subtitleShared": "{role}・参加者{count}人",
    "calendarDetail.subtitleLocal": "端末内カレンダー",
    "calendarDetail.overflowAvatarCount": "+{count}",
    "calendarDetail.inviteChipLabel": "招待",
    "calendarDetail.showEventsA11y": "予定を表示",
    "calendarDetail.membersA11y": "メンバー、{count}人",
    "calendarDetail.membersLabel": "メンバー",
    "calendarDetail.settingsA11y": "設定",
    "calendarDetail.roleNoticeOwnerEditor":
      "招待の作成・権限変更・カレンダー設定はオーナーのみ行えます。",
    "calendarDetail.roleNoticeViewer":
      "閲覧のみの参加のため、予定の編集や設定はできません。",
    "calendarDetail.upcomingSectionTitle": "次の予定",
    "calendarDetail.showAllToggle": "すべて見る",
    "calendarDetail.upcomingEmptyText": "予定はまだありません",
    "calendarMembers.removeConfirmTitle": "参加者を削除",
    "calendarMembers.removeConfirmMessage": "{name}をカレンダーから削除しますか？",
    "calendarMembers.memberFallbackNameForRemove": "このメンバー",
    "calendarMembers.title": "参加者・権限",
    "calendarMembers.memberFallbackName": "メンバー",
    "calendarMembers.editRoleA11y": "権限を変更",
    "calendarMembers.roleChangeFailedFallback": "権限を変更できませんでした",
    "calendarInvite.expiryText": "{date} まで有効",
    "calendarInvite.shareMessage": "カレンダーへ招待します。このリンクから参加できます: {link}",
    "calendarInvite.createFailedTitle": "招待を作成できませんでした",
    "calendarInvite.createFailedFallback": "招待を作成できませんでした。もう一度お試しください",
    "calendarInvite.copiedMessage": "招待リンクをクリップボードにコピーしました。",
    "calendarInvite.revokeConfirmTitle": "この招待を失効させますか？",
    "calendarInvite.revokeConfirmMessage": "リンクを持っている人は今後参加できなくなります。",
    "calendarInvite.revokeButton": "失効させる",
    "calendarInvite.title": "招待リンク",
    "calendarInvite.ownerOnlyNotice": "招待リンクの作成・管理はオーナーのみ行えます",
    "calendarInvite.createSectionTitle": "新しい招待リンクを作る",
    "calendarInvite.createHelper": "7日間有効・作成後にOSの共有シートが開きます",
    "calendarInvite.inviteAsEditorButton": "編集者として招待",
    "calendarInvite.inviteAsViewerButton": "閲覧のみで招待",
    "calendarInvite.copyLastLinkButton": "最後に作成したリンクをコピー",
    "calendarInvite.emptyText": "まだ招待リンクはありません",
    "calendarInvite.inviteRoleText": "{role}として招待",
    "calendarInvite.revokedStatus": "失効済み",
    "calendarInvite.expiredStatus": "期限切れ",
    "calendarInvite.inviteeEmailLabel": "招待するメールアドレス（任意）",
    "calendarInvite.inviteeEmailHelper": "入力すると、相手の「招待」タブにも表示されます",
    "calendarInvite.acceptedStatus": "承認済み",
    "calendarInvite.declinedStatus": "拒否されました",
    "calendarInvite.acceptButton": "参加",
    "calendarInvite.declineButton": "拒否",
    "calendarInvite.declineConfirmTitle": "招待を拒否しますか？",
    "calendarInvite.declineConfirmMessage": "この操作は取り消せません。",
    "calendarInvite.acceptingStatus": "招待を承認しています",
    "calendarInvite.decliningStatus": "招待を拒否しています",
    "calendarInvite.acceptFailedMessage": "招待への参加に失敗しました",
    "calendarInvite.declineFailedMessage": "招待の拒否に失敗しました",
    "calendarInvite.acceptedSuccessTitle": "参加しました",
    "calendarInvite.acceptedSuccessMessage": "{name}に参加しました",
    "calendarInvite.invitedBy": "{name}さんからの招待",
    "calendarInvite.inviterFallbackName": "メンバー",
    "calendarInvite.reloadButton": "再読み込み",
    "calendarInvite.loadFailedMessage": "招待を読み込めませんでした",
    "calendarSettings.inviteToggleFailedFallback": "招待リンクを変更できませんでした",
    "calendarSettings.copyFailedTitle": "コピーできませんでした",
    "calendarSettings.shareFailedTitle": "共有できませんでした",
    "calendarSettings.deleteSharedMessage":
      "「{name}」を削除します。参加している{count}人全員がこのカレンダーと予定を見られなくなり、カレンダー内の共有予定もすべて削除されます。この操作は取り消せません。",
    "calendarSettings.deleteLocalMessage": "「{name}」を削除します。この操作は取り消せません。",
    "calendarSettings.deleteConfirmTitle": "カレンダーを削除",
    "calendarSettings.leaveMessage":
      "「{name}」から退出します。参加中のカレンダー一覧から削除され、以後このカレンダーの予定は見られなくなります。あなた以外のメンバーやカレンダー自体には影響しません。",
    "calendarSettings.leaveConfirmTitle": "カレンダーから退出",
    "calendarSettings.leaveButton": "退出する",
    "calendarSettings.leaveFailedTitle": "退出できませんでした",
    "calendarSettings.title": "設定",
    "calendarSettings.nameLabel": "カレンダー名",
    "calendarSettings.themeColorLabel": "テーマカラー",
    "calendarSettings.colorSwatchA11y": "色を{color}に変更",
    "calendarSettings.favoriteAdded": "追加済み",
    "calendarSettings.favoriteNotAdded": "未追加",
    "calendarSettings.roleNoticeOwnerEditor":
      "編集者は予定を追加・編集できますが、名前・色の変更はオーナーのみ行えます。",
    "calendarSettings.membersSummary": "{count}人・自分は{role}",
    "calendarSettings.inviteToggleLabel": "招待リンクを有効にする",
    "calendarSettings.inviteToggleHelper": "オンにすると閲覧のみの招待リンクが有効になります",
    "calendarSettings.shareButton": "共有する",
    "calendarSettings.copyLinkButton": "リンクをコピー",
    "calendarSettings.inviteManagementLabel": "役割別の招待管理",
    "calendarSettings.checkingStatus": "確認中…",
    "calendarSettings.activeInvitesCount": "有効{count}件",
    "calendarSettings.memberLimitStatus": "{used} / {limit}人",
    "calendarSettings.memberLimitStatusWithInvites": "{used} / {limit}人（招待中{invites}人を含む）",
    "calendarSettings.memberLimitReachedNotice":
      "この共有カレンダーは人数上限に達しています。所有者を含めて最大5人まで参加できます",
    "inviteToken.joinFailedFallback": "参加できませんでした",
    "inviteToken.title": "カレンダーへの招待",
    "inviteToken.joinedHeadline": "{name} に参加しました",
    "inviteToken.roleSummary": "あなたの権限: {role}",
    "inviteToken.openCalendarButton": "カレンダーを開く",
    "inviteToken.needsLoginHeadline": "参加するにはログインが必要です",
    "inviteToken.signInButton": "ログインする",
    "inviteToken.confirmHeadline": "このカレンダーへ参加しますか？",
    "inviteToken.joinButton": "参加する",
    "appDataContext.notificationFailedTitle": "通知を有効にできませんでした",
    "appDataContext.notificationFailedMessage":
      "通知の許可が得られなかったため、この予定の通知は届きません。予定自体は保存されています。",
    "appDataInit.errorTitle": "データを読み込めませんでした",
    "appDataInit.errorMessage": "端末内のデータは削除されていません。もう一度お試しください。",
    "appDataInit.retryButton": "もう一度試す",
    "rootErrorBoundary.title": "アプリを表示できませんでした",
    "rootErrorBoundary.message": "端末内のデータは削除されていません",
    "rootErrorBoundary.retryButton": "もう一度試してください",
    "notFound.title": "ページが見つかりません",
    "notFound.message": "お探しのページは移動または削除された可能性があります。",
    "notFound.homeButton": "ホームに戻る",
  },
  en: {
    "ai.header": "AI Assist",
    "ai.usageRemainingToday": "{count} left today",
    "ai.usageRemainingThisMonth": "{count} left this month",
    "ai.freeUsedUpTitle": "You've used today's free AI requests",
    "ai.watchAdBonusButton": "Watch an ad for +{bonus}",
    "ai.adBonusRemainingHint": "You can add bonus uses up to {count} more time(s) today",
    "ai.dailyLimitReachedTitle": "You've reached today's AI limit",
    "ai.dailyLimitResetHint": "Your free uses reset tomorrow",
    "ai.usageFetchFailedTitle": "Couldn't load your usage status",
    "ai.usageRetryButton": "Retry",
    "ai.usageRequiresLoginTitle": "Sign in to use AI Support",
    "ai.usageRequiresLoginButton": "Go to sign in",
    "ai.suggestionsHeading": "Suggestions",
    "ai.historyHeading": "Recent history",
    "ai.historyEmpty": "No history yet",
    "ai.description": "AI can help you create events, review your focus time,\nand explain how features work.",
    "ai.demoNotice": "Demo AI (locally generated sample responses; no external LLM)",
    "aiResult.applyToCalendarAction": "Add this to my calendar",
    "aiResult.applyConfirmTitle": "Add to calendar?",
    "aiResult.applyConfirmMessage": "{{title}}\n{{date}} {{start}}-{{end}}",
    "aiResult.applyConfirmAction": "Add",
    "aiResult.applyDoneTitle": "Added",
    "aiResult.applyDoneMessage": "The event was added to your calendar.",
    "aiResult.applyDoneAction": "Open calendar",
    "aiResult.applyFailedTitle": "Could not add",
    "aiResult.applyFailedMessage": "Saving the event failed. Please try again later.",
    "aiResult.applyInvalidMessage": "The suggestion could not be turned into an event.",
    "ai.voiceInputTitle": "Voice input",
    "ai.voiceInputComingSoon": "Coming soon",
    "ai.voiceInputA11y": "Voice input",
    "ai.inputPlaceholder": "Type what you'd like to do",
    "ai.sendA11y": "Send",
    "ai.suggestion.organizeToday": "Organize today's schedule",
    "ai.suggestion.organizeToday.description": "Tidy up today's schedule for you",
    "ai.suggestion.findFreeTime": "Find free time",
    "ai.suggestion.findFreeTime.description": "Find gaps in your schedule",
    "ai.suggestion.organizeTodos": "Organize today's to-dos",
    "ai.suggestion.organizeTodos.description": "Sort out today's tasks",
    "ai.suggestion.reserveStudyTime": "Reserve study time",
    "ai.suggestion.reserveStudyTime.description": "Suggest time to focus on studying",
    "ai.suggestion.reviewThisWeek": "Review this week's schedule",
    "ai.suggestion.reviewThisWeek.description": "Summarize this week's schedule",
    "language.pickerTitle": "Language",
    "language.jaLabel": "🇯🇵 日本語",
    "language.enLabel": "🇺🇸 English",
    "language.sheetTitle": "Display settings",
    "calendarHeader.menuLabel": "Menu",
    "calendarHeader.addLabel": "Add",
    "calendarHeader.selectMonthLabel": "Select month",
    "calendarHeader.previousMonthLabel": "Previous month",
    "calendarHeader.nextMonthLabel": "Next month",
    "calendarHeader.todayLabel": "Today",
    "calendarHeader.todayA11yLabel": "Go to today",
    "calendarHeader.languageA11yLabel": "Switch language",
    "yearMonthPicker.title": "Select year and month",
    "yearMonthPicker.backToThisMonth": "Back to this month",
    "yearMonthPicker.close": "Close",
    "menu.title": "Menu",
    "menu.calendar": "Calendar",
    "menu.account": "Account",
    "menu.accountLoggedInFallback": "Signed in",
    "menu.accountLoggedOut": "Not signed in",
    "menu.records": "Records",
    "menu.visibleCalendars": "Visible calendars",
    "menu.aiSupport": "AI Support",
    "menu.trainingIntegration": "Training app integration",
    "menu.trainingComingSoon": "Coming soon",
    "menu.support": "Support the developer",
    "menu.contact": "Contact us",
    "menu.adPrivacySettings": "Ad privacy settings",
    "menu.holidayRegionLabel": "Holiday region",
    "common.a11ySeparator": ", ",
    "common.close": "Close",
    "common.confirm": "Confirm",
    "common.apply": "Apply",
    "common.cancel": "Cancel",
    "common.delete": "Delete",
    "common.deleteAction": "Delete",
    "common.save": "Save",
    "common.back": "Back",
    "common.notSet": "Not set",
    "common.notEntered": "Not entered",
    "common.couldNotChange": "Couldn't change this",
    "common.couldNotDelete": "Couldn't delete this",
    "common.copied": "Copied",
    "common.allDay": "All day",
    "common.selfSuffix": " (You)",
    "common.comingSoon": "Coming soon",
    "common.todaySuffix": ", today",
    "common.requiredSuffix": ", required",
    "common.errorSuffix": ", error: {error}",
    "common.moreCount": "{count} more",
    "common.rangeSeparator": "–",
    "common.startTime": "Start time",
    "common.endTime": "End time",
    "common.tapToChangeHint": "Tap to change",
    "common.notification": "Notification",
    "common.repeat": "Repeat",
    "common.shared": "Shared",
    "common.saveFailedTitle": "Couldn't save",
    "common.completed": "Completed",
    "common.addEvent": "Add event",
    "common.durationHours": "{hours}h",
    "common.durationMinutes": "{minutes}m",
    "common.durationHoursMinutes": "{hours}h {minutes}m",
    "common.cannotMoveTitle": "Can't move this",
    "common.saveFailedMessage": "It's been moved back to its original position. Please try again.",
    "common.timeSlotSuffix": " time slot",
    "common.createEventHint": "Creates a new event at the tapped time",
    "common.noVisibleEventsHint": "No events to show. Choose calendars or event types in Display settings.",
    "calendarRole.owner": "Owner",
    "calendarRole.editor": "Editor",
    "calendarRole.viewer": "Viewer",
    "date.weekday0": "Sun",
    "date.weekday1": "Mon",
    "date.weekday2": "Tue",
    "date.weekday3": "Wed",
    "date.weekday4": "Thu",
    "date.weekday5": "Fri",
    "date.weekday6": "Sat",
    "validation.titleRequired": "Please enter a title",
    "validation.dateRequired": "Please select a date",
    "validation.dateInvalid": "The date format is invalid",
    "validation.timeInvalid": "The time format is invalid",
    "validation.startTimeRequired": "Please enter a start time",
    "validation.endTimeRequired": "Please enter an end time",
    "validation.endTimeAfterStart": "End time must be after the start time",
    "validation.taskNameRequired": "Please enter a task name",
    "validation.executionDateRequired": "Please select a date",
    "validation.durationRequired": "Please set a focus duration of at least 1 minute",
    "validation.calendarRequired": "Please select a calendar",
    "validation.startDateRequired": "Please select a start date",
    "validation.endDateRequired": "Please select an end date",
    "validation.weekdayRequired": "Please select at least one day of the week",
    "validation.rangeFallback": "Please check the date range and days of the week",
    "recurringDates.weekdayInvalid": "The day of week values are invalid",
    "recurringDates.startBeforeEnd": "The start date must be before the end date",
    "recurringDates.rangeTooLong": "The date range can be at most {max} days",
    "recurringDates.tooManyGenerated": "You can generate at most {max} events at once",
    "friendlyError.inviteNotFound": "We couldn't find that invite link",
    "friendlyError.inviteRevoked": "This invite has been revoked",
    "friendlyError.inviteExpired": "This invite has expired",
    "friendlyError.rateLimit":
      "You've reached the sending limit. Please wait a while and try again",
    "friendlyError.invalidEmail": "That email address doesn't look valid",
    "friendlyError.network":
      "A network error occurred. Please check your connection and try again",
    "friendlyError.notAuthorized": "You don't have permission to do this",
    "friendlyError.session": "We couldn't verify your sign-in. Please sign in again",
    "friendlyError.ownedSharedCalendarLimitExceeded":
      "You've reached the limit for shared calendars you own. Remove an existing calendar and try again.",
    "friendlyError.sharedCalendarMemberLimitExceeded":
      "This shared calendar has reached its member limit. It supports up to 5 people including the owner.",
    "friendlyError.localPersistenceFailed":
      "Couldn't save to this device. Check available storage and try again.",
    "friendlyError.sharedEventDeleteUnconfirmed":
      "We couldn't confirm whether this was deleted. Please try again",
    "permissions.viewerCannotMove": "This event can't be moved because you only have view access",
    "permissions.overnightContinuationCannotMove": "This is a continuation from the previous day. Move it from its start day instead",
    "options.mainCalendar": "Main calendar",
    "options.restrictedAppYoutube": "YouTube",
    "options.restrictedAppX": "X",
    "options.restrictedAppGame": "Games",
    "options.restrictedAppSns": "Social media",
    "options.restrictedAppBrowser": "Browser",
    "options.notificationNone": "No notification",
    "options.notificationAtStart": "At start time",
    "options.notification5Min": "5 minutes before",
    "options.notification10Min": "10 minutes before",
    "options.notification15Min": "15 minutes before",
    "options.notification30Min": "30 minutes before",
    "options.notification1Hour": "1 hour before",
    "options.notification2Hour": "2 hours before",
    "options.notification1Day": "1 day before",
    "options.repeatNone": "None",
    "options.repeatDaily": "Daily",
    "options.repeatWeekly": "Weekly",
    "options.repeatMonthly": "Monthly",
    "options.repeatYearly": "Yearly",
    "options.unlockConditionNone": "Not set",
    "options.unlockConditionCalculation": "Unlock with a math problem",
    "holiday.newYearsDay": "New Year's Day",
    "holiday.comingOfAgeDay": "Coming of Age Day",
    "holiday.nationalFoundationDay": "National Foundation Day",
    "holiday.emperorsBirthday": "Emperor's Birthday",
    "holiday.vernalEquinoxDay": "Vernal Equinox Day",
    "holiday.showaDay": "Showa Day",
    "holiday.constitutionMemorialDay": "Constitution Memorial Day",
    "holiday.greeneryDay": "Greenery Day",
    "holiday.childrensDay": "Children's Day",
    "holiday.marineDay": "Marine Day",
    "holiday.mountainDay": "Mountain Day",
    "holiday.respectForTheAgedDay": "Respect for the Aged Day",
    "holiday.autumnalEquinoxDay": "Autumnal Equinox Day",
    "holiday.sportsDay": "Sports Day",
    "holiday.healthAndSportsDay": "Health and Sports Day",
    "holiday.cultureDay": "Culture Day",
    "holiday.laborThanksgivingDay": "Labor Thanksgiving Day",
    "holiday.citizensHoliday": "Citizens' Holiday",
    "holiday.substituteHoliday": "Substitute Holiday",
    "holidayRegion.pickerTitle": "Holiday region",
    "holidayRegion.jp": "Japan",
    "holidayRegion.us": "United States",
    "holidayRegion.gb": "United Kingdom",
    "holidayRegion.none": "Do not show holidays",
    "notification.channelName": "Event notifications",
    "notification.eventBody": "Starting at {time}",
    "notification.focusEndTitle": "Focus session ended",
    "notification.focusEndBody": "Your focus session has ended",
    "notification.focusStartTitle": "Time to focus",
    "notification.focusStartBody": "Let's start \"{title}\".",
    "notification.focusReminderTitle": "{minutes} min until your focus session",
    "notification.focusReminderBody": "\"{title}\" starts at {time}",
    "notification.untitledEventFallback": "Untitled event",
    "syncStatusBadge.synced": "Synced to shared calendar",
    "syncStatusBadge.pending":
      "Waiting to send. It'll send automatically once you're back online",
    "syncStatusBadge.error":
      "Couldn't send. It'll retry automatically once you're back online",
    "adPlaceholder.fallback": "Ad",
    "viewSwitcher.month": "M",
    "viewSwitcher.week": "W",
    "viewSwitcher.day": "D",
    "focus.startButton": "Start focus mode",
    "dayAgendaRow.focusTag": "Focus",
    "dayAgendaRow.selfLabel": "You",
    "dayAgendaRow.timeRangeA11y": "{start} to {end}",
    "bottomActionBar.overlay": "Views",
    "bottomActionBar.calendar": "Calendar",
    "bottomActionBar.focus": "Focus",
    "bottomActionBar.ai": "AI",
    "bottomActionBar.activity": "Updates",
    "calendarVisibilityChips.mainChipName": "Events",
    "calendarVisibilityChips.manageA11y": "Manage visible calendars",
    "calendarVisibilityChips.suffixShowing": ", showing",
    "calendarVisibilityChips.suffixHidden": ", hidden",
    "monthDropConfirm.title": "Confirm the new time",
    "monthDropConfirm.focusDurationKept": " (duration kept)",
    "monthDropConfirm.originalTimeLabel": "Original time: {time}",
    "monthDropConfirm.newDateLabel": "New date: {date}",
    "monthDropConfirm.confirmButton": "Save with this time",
    "monthDropConfirm.keepOriginalButton": "Save with the original time",
    "focusTaskForm.deleteConfirmTitle": "Delete focus task",
    "focusTaskForm.deleteConfirmMessage": "Delete this task?",
    "focusTaskForm.editHeaderTitle": "Edit focus task",
    "focusTaskForm.createHeaderTitle": "Create focus task",
    "focusTaskForm.submitButton": "Review details",
    "focusTaskForm.taskNameLabel": "Task name",
    "focusTaskForm.executionDateLabel": "Date",
    "focusTaskForm.durationLabel": "Focus duration",
    "focusTaskForm.calendarLabel": "Calendar",
    "focusTaskForm.restrictedAppsLabel": "Restricted apps",
    "focusTaskForm.midUnlockLabel": "Early unlock",
    "focusTaskForm.unlockConditionLabel": "Unlock condition",
    "focusTaskForm.memoLabel": "Other settings / notes",
    "focusTaskForm.alreadyCompletedLabel": "Already completed",
    "focusTaskForm.lockedNoticeLabel": "This will be added to the calendar with a lock",
    "focusTaskForm.taskNamePlaceholder": "e.g. AWS certification study",
    "focusTaskForm.memoPlaceholder": "Enter notes",
    "focusTaskForm.unlockConditionModalTitle": "Early unlock condition",
    "focusTaskForm.unlockCountModalTitle": "Unlock condition (number of math problems)",
    "focusTaskForm.unlockCountSummary": "{count} math problems",
    "focusTaskForm.unlockCountOption": "{count} problems",
    "focusTaskForm.viewRecordsButton": "View focus records and analytics",
    "focusTaskForm.viewRecordsAccessibilityLabel": "Open focus records and analytics",
    "bulkEventForm.weekdayFallback": "None selected",
    "bulkEventForm.headerTitle": "Add events (bulk create)",
    "bulkEventForm.titleLabel": "Title",
    "bulkEventForm.descriptionLabel": "Description",
    "bulkEventForm.startDateLabel": "Start date",
    "bulkEventForm.endDateLabel": "End date",
    "bulkEventForm.weekdayLabel": "Days of week",
    "bulkEventForm.targetCalendarLabel": "Calendar",
    "bulkEventForm.titlePlaceholder": "e.g. Gym",
    "bulkEventForm.descriptionPlaceholder": "Enter a description",
    "bulkEventForm.weekdayModalTitle": "Days of week (select multiple)",
    "bulkEventForm.previewCountText": "{count} events will be created",
    "bulkEventForm.saveErrorFallback": "Couldn't save. Please try again",
    "bulkEventForm.weekdayOptionSuffix": "{label}",
    "normalEventForm.notificationFallback": "No notification",
    "normalEventForm.shareFallback": "Not shared",
    "normalEventForm.deleteConfirmTitle": "Delete event",
    "normalEventForm.deleteConfirmMessage": "Delete this event?",
    "normalEventForm.editHeaderTitle": "Edit event",
    "normalEventForm.createHeaderTitle": "Add event",
    "normalEventForm.titleLabel": "Title",
    "normalEventForm.dateLabel": "Date",
    "normalEventForm.startFieldLabel": "Start",
    "normalEventForm.endFieldLabel": "End",
    "normalEventForm.calendarLabel": "Calendar",
    "normalEventForm.memoLabel": "Notes",
    "normalEventForm.titlePlaceholder": "e.g. Meeting",
    "normalEventForm.memoPlaceholder": "Enter notes",
    "normalEventForm.shareModalTitle": "Shared with",
    "normalEventForm.shareSelectedCount": "{count} selected",
    "normalEventForm.sharedNoticeError":
      "This event is on the shared calendar \"{name}\". Your last change couldn't be sent. Saving again will retry.",
    "normalEventForm.sharedNoticePending":
      "This event is on the shared calendar \"{name}\". Your last change hasn't been sent yet. It'll send automatically once you're back online.",
    "normalEventForm.sharedNoticeSynced":
      "This event is on the shared calendar \"{name}\". It's visible to the members.",
    "normalEventForm.sharedNoticeNew":
      "This will be saved as an event on the shared calendar \"{name}\". It'll be visible to the members.",
    "newCalendarModal.createErrorTitle": "Couldn't create it",
    "newCalendarModal.chooseTitle": "Create a new calendar",
    "newCalendarModal.localOptionTitle": "Personal calendar",
    "newCalendarModal.localOptionSubtitle": "Manage events just for yourself",
    "newCalendarModal.sharedOptionTitle": "Shared calendar",
    "newCalendarModal.sharedNotConfiguredSubtitle":
      "Not available because Supabase isn't configured",
    "newCalendarModal.sharedNeedsLoginSubtitle": "Sign in to create one",
    "newCalendarModal.sharedDefaultSubtitle": "Share events with family and friends",
    "newCalendarModal.localNamePlaceholder": "e.g. Novel writing notes",
    "newCalendarModal.sharedNamePlaceholder": "e.g. Family schedule",
    "newCalendarModal.createButton": "Create",
    "newCalendarModal.colorSwatchA11y": "Color {n}",
    "newCalendarModal.createErrorFallback": "Couldn't create it. Please try again",
    "newCalendarModal.limitReachedTitle": "Limit reached",
    "newCalendarModal.myCalendarLimitReachedMessage": "My Calendars are limited to {limit} in total, including your personal calendar.",
    "newCalendarModal.sharedCalendarLimitReachedMessage": "You can create up to {limit} shared calendars.",
    "newCalendarModal.manageExistingButton": "Manage existing calendars",
    "newCalendarModal.limitReachedSubtitle": "Limit reached ({limit})",
    "fieldRow.requiredBadge": "Required",
    "restrictedAppsList.noneSet": "No restricted apps set",
    "restrictedAppsList.restrictingText": "Restricting {names}",
    "restrictedAppsList.listSeparator": ", ",
    "streakGrid.title": "Completion status (past 7 days)",
    "weeklyBarChart.title": "This week's progress",
    "monthlyTrendChart.title": "Past 12 months",
    "aiScheduleCard.header": "Suggested schedule",
    "account.signOutConfirmTitle": "Sign out?",
    "account.signOutConfirmMessage":
      "Your personal events and focus features on this device will remain after signing out.",
    "account.signOutErrorTitle": "Couldn't sign out",
    "account.signOutErrorFallback": "Couldn't sign out. Please try again",
    "account.title": "Account",
    "account.loggedInA11y": "{email}, signed in",
    "account.loggedInLabel": "Signed in",
    "account.loggedInNote":
      "Signing out won't delete personal events or focus tasks on this device. Shared calendar events won't be visible until you sign in again.",
    "account.signOutButton": "Sign out",
    "account.signOutInProgressA11y": "Signing out",
    "account.loggedOutA11y": "Not signed in. You can still use personal events and focus features",
    "account.loggedOutLabel": "Not signed in",
    "account.loggedOutSubLabel": "You can still use personal events and focus features",
    "account.loggedOutNote":
      "Signing in is only needed to share calendars with others or join an invite.",
    "account.signInButton": "Sign in",
    "account.supabaseNotConfigured": "Sign-in isn't available because Supabase isn't configured.",
    "activity.title": "Updates",
    "activity.helperText":
      "See events you've added or changed, and your focus task completion history.",
    "activity.emptyText": "No updates yet",
    "activity.completedLabel": "Completed",
    "activity.createdLabel": "Event created",
    "activity.updatedLabel": "Event updated",
    "activity.dateTimeRow": "{date} {time}",
    "calendars.filterFavorite": "Favorites",
    "calendars.menuRemoveFavorite": "Remove from favorites",
    "calendars.menuAddFavorite": "Add to favorites",
    "calendars.rowA11y": "{name}, {status}",
    "calendars.overflowMenuA11y": "More options",
    "calendars.title": "Calendars",
    "calendars.createRowText": "Create a new calendar",
    "calendars.cloudNotice": "Shared calendars aren't available because Supabase isn't configured",
    "calendars.tabPersonal": "My Calendars",
    "calendars.tabShared": "Shared",
    "calendars.tabInvitations": "Invitations",
    "calendars.personalIndicatorLabel": "On this device",
    "calendars.personalEmptyText": "No personal calendars",
    "calendars.baseCalendarName": "Personal",
    "calendars.baseCalendarSubtitle": "The default calendar — can't be deleted",
    "calendars.actionRename": "Edit name",
    "calendars.actionChangeImage": "Set or change image",
    "calendars.actionChangeColor": "Change theme color",
    "calendars.actionRevertToDefaultImage": "Revert to default",
    "calendars.eventDisplaySectionTitle": "Events to show",
    "calendars.eventDisplayEventsOnly": "Events",
    "calendars.eventDisplayBoth": "Both",
    "calendars.eventDisplayFocusOnly": "Focus",
    "calendars.eventDisplayHideAll": "Hide all",
    "calendars.eventDisplaySummaryEventsOnly": "Shows regular events only.",
    "calendars.eventDisplaySummaryBoth": "Shows regular events and focus tasks together on the same calendar.",
    "calendars.eventDisplaySummaryFocusOnly": "Shows focus tasks only.",
    "calendars.eventDisplaySummaryHideAll": "Nothing is shown.",
    "calendars.createMyCalendarButton": "+ Create a My Calendar",
    "calendars.actionViewDetail": "View calendar details",
    "calendars.actionShowOnlyThis": "Show only this calendar",
    "calendars.actionManageMembers": "Manage members",
    "calendars.actionInviteMembers": "Invite members",
    "calendars.actionEditSharedCalendar": "Edit name, image, and color",
    "calendars.actionViewMembers": "View members",
    "calendars.ownedSharedSectionTitle": "Shared Calendars You Own",
    "calendars.joinedSharedSectionTitle": "Joined Shared Calendars",
    "calendars.joinedSharedCountLabel": "{count} calendars",
    "calendars.createSharedCalendarButton": "+ Create a Shared Calendar",
    "calendars.viewInvitationsLink": "View Invitations",
    "calendars.visibleLimitReachedMessage":
      "You can display up to 5 calendars at the same time. Turn off one of the currently visible calendars first.",
    "calendars.searchPlaceholder": "Search shared calendars",
    "calendars.searchNoMatchText": "No shared calendars match your search",
    "calendars.ownedSharedEmptyTitle": "You haven't created any shared calendars yet",
    "calendars.joinedSharedEmptyTitle": "You haven't joined any shared calendars",
    "calendars.ownerSoloLabel": "Owner (only you)",
    "calendars.nextEventLabel": "Next: {date} {title}",
    "calendars.eventCountLabel": "{count} events",
    "calendars.noEventsLabel": "No events",
    "calendars.invitationsExplainerTitle": "Invitations arrive as links",
    "calendars.invitationsExplainerBody":
      "Open an invite link sent by a calendar owner to join their shared calendar.",
    "calendars.invitationsInboxComingSoonLabel": "Received invitations",
    "calendars.manageInvitesSectionTitle": "Manage invites for your calendars",
    "calendars.manageInvitesRowSubtitle": "Manage invite link",
    "calendars.receivedInvitationsSectionTitle": "Received invitations",
    "calendars.pendingInvitesEmptyTitle": "No invitations",
    "calendars.pendingInvitesEmptyBody": "New invitations will appear here",
    "calendars.sharedRequiresLoginTitle": "Sign in to use shared calendars",
    "calendars.invitationsRequiresLoginTitle": "Sign in to view and accept invitations",
    "calendars.requiresLoginButton": "Go to sign in",
    "calendars.tabInvitationsA11yWithCount": "Invitations, {count} pending",
    "calendars.invitationsBadgeOverflow": "99+",
    "contact.missingFieldsTitle": "Missing information",
    "contact.missingFieldsMessage": "Please enter a subject and message",
    "contact.unavailableTitle": "Contact form unavailable",
    "contact.unavailableMessage": "The contact feature is currently being prepared.",
    "contact.mailBodyReplyLine": "{body}\n\n---\nReply-to email: {email}",
    "contact.mailClientErrorTitle": "Couldn't open the mail app",
    "contact.mailClientErrorMessage": "Please check that a mail app is set up on your device.",
    "contact.title": "Contact us",
    "contact.introText":
      "Use this form to send bug reports, questions, or requests directly to us — separate from AI Support, for anything you'd like a person to see.",
    "contact.subjectLabel": "Subject",
    "contact.subjectPlaceholder": "e.g. About the week view",
    "contact.bodyLabel": "Message",
    "contact.bodyPlaceholder": "Enter the details",
    "contact.replyEmailLabel": "Reply email (optional)",
    "contact.sendButton": "Review and send",
    "support.tierCoffeeName": "Buy a coffee",
    "support.tierCoffeeDesc": "A small show of support",
    "support.tierLunchName": "Buy lunch",
    "support.tierLunchDesc": "For those who want to support generously",
    "support.tierSponsorName": "Sponsor",
    "support.tierSponsorDesc": "Give development a big boost",
    "support.notReadyTitle": "Coming soon",
    "support.notReadyMessage":
      "\"{name}\" (¥{price}) will be available through the App Store/Google Play purchase system at the official release.",
    "support.headerTitle": "Support the developer",
    "support.heroDescription":
      "Your support helps keep new features and improvements coming for Focus Calendar.{br}Contributions go toward server costs, development, and design.",
    "support.whyBuiltLabel": "Why I built this app",
    "support.whyBuiltBody":
      "I wanted to build a calendar that helps you keep track of your goals and important plans — and make time for yourself — even on busy days. That's why I created Focus Calendar.",
    "support.supportButton": "Support",
    "support.futurePerksNotice": "Supporter perks (future): none at this time",
    "support.footerThanks":
      "Thank you for your support!{br}I'll keep working to build a calendar you'll want to use every day.",
    "overlay.title": "Display settings",
    "overlay.description": "Choose which calendars and event types appear in your calendar views.",
    "overlay.myCalendarsSectionTitle": "My Calendars",
    "overlay.sharedCalendarsSectionTitle": "Shared Calendars",
    "overlay.eventTypesSectionTitle": "Event types to show",
    "overlay.countLabel": "{count} / {limit}",
    "overlay.addMyCalendarButton": "+ New calendar",
    "overlay.addSharedCalendarButton": "+ Create or join a shared calendar",
    "overlay.sharedCalendarsEmptyText": "No shared calendars yet",
    "overlay.rowMenuA11y": "Open settings for {name}",
    "overlay.normalEventsLabel": "Regular events",
    "overlay.tasksLabel": "Tasks",
    "overlay.autoSaveNote": "Changes are saved automatically and reflected right away.",
    "overlay.saveErrorFallback": "Couldn't save display settings. Please try again",
    "records.emptyTitle": "No records yet",
    "records.emptyDescription": "Complete a focus session to see your achievements here",
    "records.totalTimeLabel": "Total focus time",
    "records.completedLabel": "Completed",
    "records.completedCount": "{count} times",
    "records.longestStreakLabel": "Longest streak",
    "records.longestStreakCount": "{count} days",
    "records.ongoingTasksLabel": "Ongoing tasks",
    "records.streakDaysCount": "{count}-day streak",
    "records.monthlyFocusLabel": "This month's focus time",
    "records.newLabel": "New",
    "records.monthOverMonth": "{sign}{percent}% vs last month",
    "records.byTaskLabel": "By task",
    "records.byWeekdayLabel": "Focus trends by day of week",
    "records.topWeekdayHint": "Most focused day: {label}",
    "records.trendHint": "Trends will appear as you add more records",
    "records.byTimeOfDayLabel": "Focus trends by time of day",
    "records.topTimeHint": "Most focused time: {label}",
    "records.yesterday": "Yesterday",
    "records.daysAgo": "{days} days ago",
    "records.unknownTask": "Unknown task",
    "records.otherTasks": "Other",
    "records.periodMorning": "Morning",
    "records.periodAfternoon": "Afternoon",
    "records.periodEvening": "Evening",
    "records.periodMidnight": "Late night",
    "records.screenTitle": "Focus Records & Analytics",
    "records.rangeToday": "Today",
    "records.rangeLast7Days": "Last 7 days",
    "records.rangeLast30Days": "Last 30 days",
    "records.rangeThisWeek": "This week",
    "records.rangeThisMonth": "This month",
    "records.rangeThisYear": "This year",
    "records.rangeAllTime": "All time",
    "records.rangeCustom": "Custom range",
    "records.periodTotalTimeLabel": "Total focus time",
    "records.periodCompletedCountLabel": "Completed sessions",
    "records.periodAverageTimeLabel": "Average focus time",
    "records.currentStreakLabel": "Current streak",
    "records.longestStreakEverLabel": "Longest streak ever",
    "records.completionRateLabel": "Completion rate",
    "records.periodComparisonLabel": "Compared to previous period",
    "records.periodComparisonChange": "{sign}{percent}% vs previous period",
    "records.byCalendarLabel": "By calendar",
    "records.weekdayTendencyBestHint": "Highest completion rate: {label}",
    "records.timeOfDayTendencyBestHint": "Highest completion rate: {label}",
    "records.interruptionAnalysisLabel": "Interruption analysis",
    "records.pauseCountLabel": "Pause count",
    "records.recentHistoryLabel": "Recent focus history",
    "records.statusIncomplete": "Incomplete",
    "records.noDataLabel": "No data",
    "records.insufficientDataLabel": "Not enough data yet",
    "records.noHistoryEmptyTitle": "No focus records yet",
    "records.noHistoryEmptyBody": "Complete a focus session all the way through to see it recorded here",
    "records.createFocusTaskButton": "Create a focus task",
    "records.loadFailedMessage": "Couldn't load your records",
    "records.reloadButton": "Reload",
    "records.recentDaysChartTitle": "Focus time (last 7 days)",
    "records.recentDaysChartBarA11y": "{day}, {duration}",
    "records.todayMarker": "Today",
    "records.customRangeStartLabel": "Start date",
    "records.customRangeEndLabel": "End date",
    "records.customRangeInvalidMessage": "End date must be on or after the start date",
    "records.calendarTypeMy": "My calendar",
    "records.calendarTypeShared": "Shared",
    "records.unknownCalendar": "Unknown calendar",
    "records.historyItemA11y": "{title}, started {date} {time}, {duration}, {status}",
    "records.noHistoryInPeriod": "No records in this period",
    "records.csvExportButton": "Export CSV",
    "records.csvExportFailedMessage": "Couldn't export CSV",
    "authCallback.missingCodeError": "We couldn't find the link information",
    "authCallback.genericErrorFallback": "We couldn't verify your sign-in. Please try again",
    "authCallback.errorTitle": "We couldn't verify your sign-in",
    "authCallback.backButton": "Back to sign in",
    "authCheckEmail.resendFailedTitle": "Couldn't send it",
    "authCheckEmail.resendFailedFallback":
      "We couldn't send the sign-in link. Please try again",
    "authCheckEmail.resendSuccessTitle": "Sent",
    "authCheckEmail.resendSuccessMessage": "Please check your email again.",
    "authCheckEmail.copiedMessage": "Paste this into Supabase's \"Redirect URLs\" and save it.",
    "authCheckEmail.title": "Check your email",
    "authCheckEmail.headline": "We sent a sign-in link to {email}",
    "authCheckEmail.description":
      "Open the email and tap the \"Sign in\" link. You'll return to this app and be signed in automatically. The link expires after a while.",
    "authCheckEmail.resendButton": "Didn't get it? Send again",
    "authCheckEmail.debugLabel": "For debugging (if the link can't connect to localhost)",
    "authCheckEmail.debugCopyA11y": "Copy debug URL",
    "authCheckEmail.debugCopyButton": "Copy",
    "authCheckEmail.debugNote":
      "Paste this URL into Supabase's \"Authentication → URL Configuration → Redirect URLs\" and save it. Saving alone won't affect the email already sent, so be sure to use \"Send again\" afterward to send a new sign-in link.",
    "authSignIn.emailRequiredAlert": "Please enter your email address",
    "authSignIn.title": "Sign in",
    "authSignIn.introText":
      "Signing in is required to create, invite to, or join shared calendars. Personal events and focus features continue to work without signing in.",
    "authSignIn.notConfiguredNotice":
      "Sign-in isn't available because Supabase isn't configured yet. Please complete the steps in SUPABASE_SETUP.md.",
    "authSignIn.emailLabel": "Email address",
    "authSignIn.sendLinkButton": "Send sign-in link",
    "authSignIn.orDividerText": "or",
    "authSignIn.oauthErrorFallback": "Couldn't sign in. Please try again later.",
    "authSignIn.continueWithGoogle": "Continue with Google",
    "authSignIn.comingSoonMessage": "This sign-in method is currently being prepared.",
    "aiProcessing.errorTitleFallback": "Couldn't connect",
    "aiProcessing.errorDescription": "Please try again in a little while.",
    "aiProcessing.retryButton": "Try again",
    "aiProcessing.backToAiButton": "Back to AI Support",
    "aiProcessing.loadingText": "Thinking…",
    "aiProcessing.pendingSaveFailedFallback": "Couldn't save your request. Please try again.",
    "aiProcessing.pendingRestoreFailedTitle": "Couldn't check for an unfinished AI request",
    "aiProcessing.pendingReloadButton": "Reload",
    "aiProcessing.pendingDiscardButton": "Discard",
    "aiProcessing.pendingConflictTitle": "You have an unfinished request from before",
    "aiProcessing.pendingResumeButton": "Continue previous request",
    "aiProcessing.pendingDiscardAndResendButton": "Discard and send this instead",
    "aiResult.emptyTitle": "Couldn't show the result",
    "aiResult.emptyDescription": "Please go back to AI Support and try again",
    "aiResult.weeklySummaryTitle": "This week's focus summary",
    "aiMock.createScheduleHeadline": "Event created",
    "aiMock.sampleTaskTitle": "AWS Study",
    "aiMock.viewCalendarAction": "View in calendar",
    "aiMock.regenerateOtherAction": "See another suggestion",
    "aiMock.suggestScheduleHeadline": "Found some free time",
    "aiMock.suggestScheduleDescription": "You're free Tue 7:00–8:00 PM and Thu 8:00–9:00 PM this week.",
    "aiMock.focusAnalysisHeadline": "Your focus analysis",
    "aiMock.focusAnalysisDescription":
      "You tend to focus in the evenings this week. {task} tops the list, up 15% from last week.",
    "aiMock.summaryTotalFocusTimeLabel": "Total focus time",
    "aiMock.summaryTotalFocusTimeValue": "8h 40m",
    "aiMock.summaryTopTimeLabel": "Most focused time of day",
    "aiMock.summaryTopTimeValue": "Evening (5–10 PM)",
    "aiMock.summaryTopWeekdayLabel": "Most focused day",
    "aiMock.summaryTopWeekdayValue": "Saturday",
    "aiMock.summaryTopTaskLabel": "Most focused task",
    "aiMock.summaryWeekOverWeekLabel": "vs. last week",
    "aiMock.summaryWeekOverWeekValue": "+15%",
    "aiMock.viewRecordsAction": "See a deeper analysis",
    "aiMock.featureHelpHeadline": "Here's how it works",
    "aiMock.featureHelpDescription":
      "Type something like \"create an event\" in the box below and AI will turn it into a schedule. You can also ask about focus-mode analysis or how features work.",
    "seedData.work": "Work",
    "seedData.meeting": "Meeting",
    "seedData.hospitalVisit": "Doctor's appointment",
    "seedData.novel": "Novel writing",
    "eventDetail.recurringAlertTitle": "This is a recurring event",
    "eventDetail.scopeThisOnly": "Just this event",
    "eventDetail.scopeThisAndFuture": "This and future events",
    "eventDetail.scopeAll": "All events",
    "eventDetail.notFoundText": "Event not found",
    "eventDetail.editScopeMessage": "Choose which events to apply this change to.",
    "eventDetail.deleteScopeMessage": "Choose which events to delete.",
    "eventDetail.unsupportedCrossDomainMoveMessage":
      "Moving events between an on-device calendar and a shared calendar isn't supported yet.",
    "eventDetail.unsupportedRecurringCalendarMoveMessage":
      "You can't change the calendar for \"this and future events\" or \"all events\" on a recurring event. Choose \"just this event\", or save without changing the calendar.",
    "eventDetail.migrationPendingRetryMessage":
      "Your event move is still being processed and needs to be confirmed or retried. Please try again in a little while.",
    "eventDetail.migrationConflictMessage":
      "This move couldn't be completed because the event changed somewhere else. Please check the latest version and try again.",
    "eventDetail.editConflictTitle": "Conflicts with another change",
    "eventDetail.editConflictMessage":
      "This event was already saved elsewhere after you opened it. Your input here has been kept — please check the latest version before saving again.",
    "eventDetail.editNotFoundMessage":
      "This event may have been deleted elsewhere. Please reopen it to check the latest state.",
    "eventDetail.editNotAuthorizedMessage":
      "You may no longer have permission to edit this calendar. Please check your membership.",
    "eventDetail.editRetryableMessage":
      "The save failed due to a connection issue. This event has not been saved yet — please try saving again.",
    "eventDetail.editUnknownOutcomeMessage":
      "We couldn't confirm whether the save succeeded. Please reopen the event to check its latest content.",
    "eventNew.partialFailTitle": "Some events couldn't be sent",
    "eventNew.partialFailMessage":
      "This may be due to being offline or a network error. They'll be sent automatically once you're back online.",
    "eventNew.partialFailDiscardedMessage":
      "Some events weren't saved because the signed-in account changed while saving. Please try again.",
    "eventNew.singleTabLabel": "Single event",
    "eventNew.bulkTabLabel": "Bulk create",
    "dayAgenda.emptyTitle": "No events",
    "dayAgenda.emptyDescription": "No events have been added for this day yet",
    "dayAgenda.addFocusTaskButton": "Add focus task",
    "focusDetail.notFoundText": "Focus task not found",
    "focusActive.startButton": "Start focus mode",
    "focusActive.preStartDescription": "A {duration}-minute focus session starting at {start}",
    "focusActive.unlockPenaltyText":
      "You'll need to answer {count} math problems correctly to unlock.",
    "focusActive.cancelConfirmTitle": "End focus mode early?",
    "focusActive.cancelConfirmMessage": "{penalty}\nIf you're sure you want to end it, tap \"End\".",
    "focusActive.endButton": "End",
    "focusActive.inProgressLabel": "Focus session",
    "focusActive.rangeSummary": "{duration} min from {start}",
    "focusActive.resumeButton": "Resume",
    "focusActive.pauseButton": "Pause",
    "focusActive.completeButton": "Complete",
    "focusActive.endEarlyButton": "End focus session",
    "focusActive.unlockNote": "You'll need {count} math problems to unlock",
    "focusActive.screenTitle": "Focus",
    "focusActive.menuA11y": "More options",
    "focusActive.menuTitle": "Focus session options",
    "focusActive.conflictTitle": "You already have an active focus session",
    "focusActive.conflictMessage": "You're focusing on \"{title}\". Finish or end that session before starting a new one.",
    "focusActive.conflictGoToActive": "Go to that session",
    "focusActive.conflictEndAndStartNew": "End it and start new",
    "focusActive.conflictCancelNewStart": "Don't start a new one",
    "focusActive.viewRecordsButton": "View records",
    "focusActive.completedTitle": "Focus session complete",
    "focusActive.cancelledTitle": "Focus session ended",
    "focusActive.statusRunning": "Focusing",
    "focusActive.statusPaused": "Paused",
    "focusActive.statusReady": "Ready to complete",
    "focusActive.statElapsed": "Elapsed",
    "focusActive.statInterruptions": "Interruptions",
    "focusActive.statPausedDuration": "Paused time",
    "focusActive.statPlanned": "Planned",
    "focusActive.statCountSuffix": "{count}",
    "focusActive.statMinutesSuffix": "{count} min",
    "focusActive.completeHint": "You can complete once the timer reaches 00:00",
    "focusActive.notYetStartableMessage": "This focus session can start at {start}.",
    "dueFocusBanner.title": "Time to start your focus session",
    "dueFocusBanner.startButton": "Start focus",
    "monthView.movePreviewSuffix": "Move to the {day}",
    "weekView.dragPreviewLabel": "{weekday} {day} · {time}",
    "weekView.prevWeekA11y": "Previous week",
    "weekView.prevWeekLabel": "‹ Prev week",
    "weekView.swipeHint": "Swipe sideways to change day",
    "weekView.nextWeekA11y": "Next week",
    "weekView.nextWeekLabel": "Next week ›",
    "calendarDetail.notFoundText": "Calendar not found",
    "calendarDetail.openSettingsOption": "Open settings",
    "calendarDetail.shareInviteOption": "Share (invite link)",
    "calendarDetail.subtitleShared": "{role} · {count} members",
    "calendarDetail.subtitleLocal": "On-device calendar",
    "calendarDetail.overflowAvatarCount": "+{count}",
    "calendarDetail.inviteChipLabel": "Invite",
    "calendarDetail.showEventsA11y": "Show events",
    "calendarDetail.membersA11y": "Members, {count}",
    "calendarDetail.membersLabel": "Members",
    "calendarDetail.settingsA11y": "Settings",
    "calendarDetail.roleNoticeOwnerEditor":
      "Only the owner can create invites, change permissions, or edit calendar settings.",
    "calendarDetail.roleNoticeViewer":
      "You have view-only access, so you can't edit events or settings.",
    "calendarDetail.upcomingSectionTitle": "Upcoming",
    "calendarDetail.showAllToggle": "Show all",
    "calendarDetail.upcomingEmptyText": "No upcoming events",
    "calendarMembers.removeConfirmTitle": "Remove member",
    "calendarMembers.removeConfirmMessage": "Remove {name} from this calendar?",
    "calendarMembers.memberFallbackNameForRemove": "this member",
    "calendarMembers.title": "Members & permissions",
    "calendarMembers.memberFallbackName": "Member",
    "calendarMembers.editRoleA11y": "Change role",
    "calendarMembers.roleChangeFailedFallback": "Couldn't change the role",
    "calendarInvite.expiryText": "Valid until {date}",
    "calendarInvite.shareMessage": "You're invited to a calendar. Join using this link: {link}",
    "calendarInvite.createFailedTitle": "Couldn't create the invite",
    "calendarInvite.createFailedFallback": "Couldn't create the invite. Please try again",
    "calendarInvite.copiedMessage": "The invite link was copied to your clipboard.",
    "calendarInvite.revokeConfirmTitle": "Revoke this invite?",
    "calendarInvite.revokeConfirmMessage": "People with the link will no longer be able to join.",
    "calendarInvite.revokeButton": "Revoke",
    "calendarInvite.title": "Invite link",
    "calendarInvite.ownerOnlyNotice": "Only the owner can create or manage invite links",
    "calendarInvite.createSectionTitle": "Create a new invite link",
    "calendarInvite.createHelper": "Valid for 7 days · the share sheet opens after creating",
    "calendarInvite.inviteAsEditorButton": "Invite as editor",
    "calendarInvite.inviteAsViewerButton": "Invite as viewer",
    "calendarInvite.copyLastLinkButton": "Copy the last created link",
    "calendarInvite.emptyText": "No invite links yet",
    "calendarInvite.inviteRoleText": "Invited as {role}",
    "calendarInvite.revokedStatus": "Revoked",
    "calendarInvite.expiredStatus": "Expired",
    "calendarInvite.inviteeEmailLabel": "Recipient email (optional)",
    "calendarInvite.inviteeEmailHelper": "If provided, this also appears in their Invitations tab",
    "calendarInvite.acceptedStatus": "Accepted",
    "calendarInvite.declinedStatus": "Declined",
    "calendarInvite.acceptButton": "Join",
    "calendarInvite.declineButton": "Decline",
    "calendarInvite.declineConfirmTitle": "Decline this invitation?",
    "calendarInvite.declineConfirmMessage": "This can't be undone.",
    "calendarInvite.acceptingStatus": "Accepting invitation",
    "calendarInvite.decliningStatus": "Declining invitation",
    "calendarInvite.acceptFailedMessage": "Failed to join the invitation",
    "calendarInvite.declineFailedMessage": "Failed to decline the invitation",
    "calendarInvite.acceptedSuccessTitle": "Joined",
    "calendarInvite.acceptedSuccessMessage": "You joined {name}",
    "calendarInvite.invitedBy": "Invitation from {name}",
    "calendarInvite.inviterFallbackName": "A member",
    "calendarInvite.reloadButton": "Reload",
    "calendarInvite.loadFailedMessage": "Couldn't load invitations",
    "calendarSettings.inviteToggleFailedFallback": "Couldn't change the invite link",
    "calendarSettings.copyFailedTitle": "Couldn't copy it",
    "calendarSettings.shareFailedTitle": "Couldn't share it",
    "calendarSettings.deleteSharedMessage":
      "This will delete \"{name}\". All {count} members will lose access to this calendar and its events, and every shared event will be deleted. This can't be undone.",
    "calendarSettings.deleteLocalMessage": "This will delete \"{name}\". This can't be undone.",
    "calendarSettings.deleteConfirmTitle": "Delete calendar",
    "calendarSettings.leaveMessage":
      "You'll leave \"{name}\". It will be removed from your calendar list, and you won't be able to see its events anymore. This won't affect the calendar or its other members.",
    "calendarSettings.leaveConfirmTitle": "Leave calendar",
    "calendarSettings.leaveButton": "Leave",
    "calendarSettings.leaveFailedTitle": "Couldn't leave",
    "calendarSettings.title": "Settings",
    "calendarSettings.nameLabel": "Calendar name",
    "calendarSettings.themeColorLabel": "Theme color",
    "calendarSettings.colorSwatchA11y": "Change color to {color}",
    "calendarSettings.favoriteAdded": "Added",
    "calendarSettings.favoriteNotAdded": "Not added",
    "calendarSettings.roleNoticeOwnerEditor":
      "Editors can add and edit events, but only the owner can change the name or color.",
    "calendarSettings.membersSummary": "{count} members · you're the {role}",
    "calendarSettings.inviteToggleLabel": "Enable invite link",
    "calendarSettings.inviteToggleHelper": "Turning this on enables a view-only invite link",
    "calendarSettings.shareButton": "Share",
    "calendarSettings.copyLinkButton": "Copy link",
    "calendarSettings.inviteManagementLabel": "Manage invites by role",
    "calendarSettings.checkingStatus": "Checking…",
    "calendarSettings.activeInvitesCount": "{count} active",
    "calendarSettings.memberLimitStatus": "{used} / {limit} people",
    "calendarSettings.memberLimitStatusWithInvites": "{used} / {limit} people (includes {invites} invited)",
    "calendarSettings.memberLimitReachedNotice":
      "This shared calendar has reached its member limit. It supports up to 5 people including the owner.",
    "inviteToken.joinFailedFallback": "Couldn't join",
    "inviteToken.title": "Calendar invite",
    "inviteToken.joinedHeadline": "You joined {name}",
    "inviteToken.roleSummary": "Your role: {role}",
    "inviteToken.openCalendarButton": "Open calendar",
    "inviteToken.needsLoginHeadline": "Sign in to join",
    "inviteToken.signInButton": "Sign in",
    "inviteToken.confirmHeadline": "Join this calendar?",
    "inviteToken.joinButton": "Join",
    "appDataContext.notificationFailedTitle": "Couldn't enable notifications",
    "appDataContext.notificationFailedMessage":
      "Notification permission wasn't granted, so you won't get a reminder for this event. The event itself has been saved.",
    "appDataInit.errorTitle": "Couldn't load your data",
    "appDataInit.errorMessage": "Your on-device data has not been deleted. Please try again.",
    "appDataInit.retryButton": "Try again",
    "rootErrorBoundary.title": "The app couldn't be displayed",
    "rootErrorBoundary.message": "Your on-device data has not been deleted.",
    "rootErrorBoundary.retryButton": "Please try again.",
    "notFound.title": "Page not found",
    "notFound.message": "The page you're looking for may have been moved or removed.",
    "notFound.homeButton": "Go to home",
  },
};

/**
 * 端末の最優先ロケールから対応言語を決める。
 * 要件どおり「日本語端末→日本語、英語端末→English、その他→English」
 * （languageCodeが"ja"で始まる場合のみja、それ以外は全てen）。
 */
export function getDeviceLocale(): SupportedLocale {
  const languageCode = getLocales()[0]?.languageCode ?? "";
  return languageCode.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/** 明示的にlocaleを指定して翻訳する純粋関数。LocaleContextのt()はこれを内部で使う。 */
export function translate(
  locale: SupportedLocale,
  key: TranslationKey,
  vars?: Record<string, string | number>
): string {
  const template = translations[locale][key];
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    template
  );
}

/**
 * 端末ロケールのみに基づく非リアクティブな翻訳（後方互換用）。
 * アプリ内でユーザーが選択した言語には追従しない。画面内で使う場合は
 * 代わりに`useLocale()`（`src/context/LocaleContext.tsx`）の`t()`を使うこと。
 */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  return translate(getDeviceLocale(), key, vars);
}
