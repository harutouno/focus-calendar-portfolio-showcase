# コードレビューガイド

本書は、各ファイルの責務と確認事項を記載したものです。
節の順序は、画面から権限層へ降りる読み順に対応しています。

---

## 1. 画面の入口

[`app/index.tsx`](../app/index.tsx) がカレンダーのメイン画面です。
Expo Router のファイルベースルーティングを採用しているため、
`app/` 配下のディレクトリ構成がそのまま画面構成に対応します。

確認事項:
- 月 / 週 / 日ビューの切り替えを、単一の状態（`view`）とコンポーネントの差し替えで表現している
- 表示対象カレンダーの絞り込み（`CalendarVisibilityChips`）と、
  予定データの取得（`AppDataContext`）を分離している
- 画面層は描画のみを担当し、権限や整合性の判定は下位層に置いている

関連: [`app/_layout.tsx`](../app/_layout.tsx) — Provider の構成順序

---

## 2. カレンダー表示

| ファイル | 確認事項 |
|---|---|
| [`src/components/calendar/MonthView.tsx`](../src/components/calendar/MonthView.tsx) | 月グリッドの生成と、日単位の予定配置 |
| [`src/components/calendar/WeekView.tsx`](../src/components/calendar/WeekView.tsx) | タイムライン描画とドラッグ移動の処理 |
| [`src/components/calendar/timelineLayout.ts`](../src/components/calendar/timelineLayout.ts) | 重複する予定の列割り当てアルゴリズム。純関数として実装 |
| [`src/utils/recurringEvents.ts`](../src/utils/recurringEvents.ts) | 繰り返し予定の展開。保存は 1 件、表示時に展開する |
| [`src/utils/eventDaySlice.ts`](../src/utils/eventDaySlice.ts) | 日をまたぐ予定を対象日の区間へ切り出す |
| [`src/utils/time.ts`](../src/utils/time.ts) | 終了日の決定（`resolveEndDate`）。日跨ぎ判定の定義箇所を 1 つに限定している |

設計意図: 日時計算はコンポーネントから分離し、純関数として単体テスト可能な形にしています。

---

## 3. 共有カレンダーの権限モデル

### クライアント側

| ファイル | 確認事項 |
|---|---|
| [`src/services/calendarService.ts`](../src/services/calendarService.ts) | 共有カレンダーの CRUD・招待・メンバー操作。書き込みの成否を影響行数で判定している |
| [`src/services/writeEffectAuthority.ts`](../src/services/writeEffectAuthority.ts) | エラー不発生と適用完了を区別するための判定層 |
| [`src/utils/permissions.ts`](../src/utils/permissions.ts) | owner / editor / viewer の判定（純関数） |
| [`src/utils/inviteAuthority.ts`](../src/utils/inviteAuthority.ts) | 招待の発行・取り消しが可能な条件 |
| [`src/hooks/useSyncQueueProcessor.ts`](../src/hooks/useSyncQueueProcessor.ts) | オフライン同期。ユーザー切り替え時に前ユーザーのキューを処理しない |

### サーバー側

| ファイル | 確認事項 |
|---|---|
| [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql) | テーブル 5 つと RLS の定義。`is_calendar_member()` が各ポリシーの基礎 |
| [`supabase/migrations/0010_invite_recipient_inbox.sql`](../supabase/migrations/0010_invite_recipient_inbox.sql) | 招待の発行・受諾・辞退を `security definer` の RPC に限定する構成 |
| [`supabase/migrations/0018_shared_calendar_member_limits.sql`](../supabase/migrations/0018_shared_calendar_member_limits.sql) | メンバー上限をトリガで強制。クライアント側の集計には依存しない |
| [`supabase/migrations/0028_pending_invite_recipient_authority.sql`](../supabase/migrations/0028_pending_invite_recipient_authority.sql) | 招待の宛先一致を JWT の email で判定する |

検証内容: ローカルの使い捨て DB に第三者ユーザーを作成し、`select * from calendars` を
実行して 0 件が返ることを確認しています。画面側の制御ではなく、
データベースが行を返さない構成である点が確認対象です。
実測結果は [README の検証結果](../README.md#7-テスト検証結果) と
[docs/SECURITY.md](SECURITY.md) に記載しています。

---

## 4. AI 提案から予定反映まで

```
app/ai/index.tsx        入力・テンプレート選択
  ↓  publishAiIntent（所有者を伴う一時ストア）
app/ai/processing.tsx   DemoAIService を呼び出す
  ↓  publishAiResult
app/ai/result.tsx       提案カードを表示し、カレンダーへの追加操作を受け付ける
  ↓  convertAiScheduleToNormalEvent（変換不可の場合は null）
  ↓  確認ダイアログ
AppDataContext.saveEvent  通常の予定作成と同一の保存経路
```

| ファイル | 確認事項 |
|---|---|
| [`src/services/aiService.ts`](../src/services/aiService.ts) | `AIService` インターフェースと `DemoAIService`。画面は実装に依存しない |
| [`src/utils/aiScheduleToEvent.ts`](../src/utils/aiScheduleToEvent.ts) | AI 出力とデータモデルの境界。変換不可の提案を保存経路へ渡さない |
| [`app/ai/result.tsx`](../app/ai/result.tsx) | 確認ダイアログを経て `saveEvent` を呼ぶ。AI 専用の保存経路を設けていない |
| [`src/ai/aiOperationOwner.ts`](../src/ai/aiOperationOwner.ts) | 依頼の所有者を操作時点で固定し、アカウント切り替え時の混入を防ぐ |

---

## 5. テスト

`npx jest` で 15 スイート / 225 ケースを実行します。
主要な検証対象は次の 5 本です。

| ファイル | 確認事項 |
|---|---|
| [`__tests__/aiScheduleToEvent.test.ts`](../__tests__/aiScheduleToEvent.test.ts) | AI 提案から予定への変換。日跨ぎと不正入力に対する fail-closed |
| [`__tests__/timelineLayout.test.ts`](../__tests__/timelineLayout.test.ts) | 重複する予定のレイアウト計算 |
| [`__tests__/recurringEvents.test.ts`](../__tests__/recurringEvents.test.ts) | 繰り返し予定の展開規則 |
| [`__tests__/permissions.test.ts`](../__tests__/permissions.test.ts) | ロール別の操作可否 |
| [`__tests__/syncQueueRepository.test.ts`](../__tests__/syncQueueRepository.test.ts) | オフラインキューのユーザー分離 |

その他の対象は、日時境界（`date` / `time` / `eventDaySlice`）、招待の権限
（`inviteAuthority` / `inviteScope`）、共有カレンダー作成、
フォーム挙動（`NormalEventForm.endTimeSync`）です。

いずれも境界条件と権限判定に対する回帰検証を目的としています。
