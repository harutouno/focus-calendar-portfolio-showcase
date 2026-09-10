# Focus Calendar — Portfolio Edition

Focus Calendar は、予定管理・共有・実行記録を統合するモバイルアプリケーションです。
本リポジトリは、選考時の技術レビューを目的として整理した Portfolio Edition です。
共有カレンダーの権限設計、オフライン同期、Demo AI の予定追加フローを中心に記載します。

React Native (Expo) と Supabase (PostgreSQL / Row Level Security) で構成しています。

読む順序と各ファイルの確認事項は [docs/REVIEW_GUIDE.md](docs/REVIEW_GUIDE.md) に記載しています。

---

## 1. 対象領域

予定の作成から実行記録までを、単一の予定データを中心に連携させています。

- 予定（`NormalEvent`）と集中タスク（`FocusTask`）を同一のカレンダー上で扱う
- 集中タスクの実行結果をセッションとして記録する
- 記録を日 / 週 / 月の単位で集計する
- カレンダーを他ユーザーと共有し、ロールごとに操作範囲を分ける

---

## 2. 実装機能

### カレンダー・予定・繰り返し
- 月 / 週 / 日の 3 ビュー、年月ジャンプ、スワイプ移動、週・日ビューのドラッグ移動
- 予定の作成 / 編集 / 削除、終日予定、日をまたぐ予定
- 繰り返し予定（毎日 / 毎週 / 毎月）の展開と、「この予定だけ / これ以降 / すべて」の編集・削除
- 一括入力（期間と曜日を指定した一括作成）
- 祝日表示（地域設定に追随）

### 共有カレンダー・招待・権限・RLS
- 共有カレンダーの作成、一覧、表示 ON/OFF
- 招待の発行 / 受諾 / 辞退 / 取り消し、宛先指定招待と汎用招待の区別
- owner / editor / viewer のロールと、ロールに応じた操作制限
- 退出（self-leave）
- 権限の判定はクライアントではなく PostgreSQL の Row Level Security を正本とする
  （詳細は [docs/SECURITY.md](docs/SECURITY.md)）
- オフライン時の変更は同期キューへ保持し、復帰時にユーザー単位で分離して処理する

### 画像添付・カレンダーカバー
- 予定への画像添付（作成時はドラフト→保存成功後に確定登録、編集時は即時アップロード）
- 端末内保存（マイカレンダー）と共有カレンダーで容量上限・保存先を分離
- カレンダーのカバー画像設定・変更・削除（マイカレンダーは端末内、共有カレンダーはオーナーのみ、Storageの署名付きURLで配信）
- 共有カレンダー間で予定を移動する際、添付ファイルもRPCで原子的に移す（不安定な状態の添付は移動前に検出して拒否する）

### フォーカスタイマー・記録分析
- 集中タスクのタイマー実行、中断記録、完了記録
- 実行履歴の一覧と、日 / 週 / 月の集計
- 連続日数、時間帯傾向、曜日傾向、カレンダー別集計
- CSV 書き出し

### Demo AI 提案と予定反映
- 入力を分類し、提案カードを返す
- 提案された予定は確認ダイアログを経て、ベースカレンダー（`main`）へ追加する
- 追加処理は通常の予定作成と同一の保存経路（`AppDataContext.saveEvent`）を通り、
  AI 専用の保存経路や権限の例外を設けていない

---

## 3. 使用技術

| 層 | 使用技術 |
|---|---|
| アプリ | React Native 0.81 / Expo SDK 54 / TypeScript |
| ルーティング | Expo Router 6（ファイルベース） |
| 状態管理 | React Context による集約（`AppDataContext`） |
| 端末内保存 | AsyncStorage（リポジトリ層で抽象化） |
| バックエンド | Supabase（PostgreSQL / Auth / Row Level Security / RPC） |
| 認証 | Supabase Auth（メール、Google、Apple） |
| テスト | Jest + jest-expo + React Test Renderer |

規模: `app` 28 ファイル / `src` 188 ファイル / migration 27 / テスト 15 スイート・225 ケース

---

## 4. 実行手順

```bash
npm install
cp .env.example .env        # 値を設定する（下記）
npx supabase start          # ローカル Supabase（Docker が必要）
npx supabase db reset       # supabase/migrations を順に適用
npx expo start
```

`.env` に設定が必要なのは次の 2 つです。いずれも `npx supabase start` の出力に表示されます。

```
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_ANON_KEY=
```

Google / Apple サインインを確認する場合のみ、`.env.example` の OAuth クライアント ID を設定します。
未設定の場合はメール認証で動作を確認できます。

アプリを起動せずに静的検証のみ行う場合は次を実行します。

```bash
npm run lint
npx tsc --noEmit
npx jest
```

---

## 5. Demo AI の構成

本リポジトリには外部 LLM の呼び出しと API キーを含みません。

- AI 応答は `src/services/aiService.ts` の `DemoAIService` が端末内で生成する固定サンプルです
- 外部 API 呼び出し、Edge Function、使用量課金は Portfolio Edition の対象外です
- AI 画面にも Demo AI である旨を表示しています

設計意図は応答内容ではなく、AI 出力をアプリのデータモデルへ取り込む境界の扱いにあります。

- `src/utils/aiScheduleToEvent.ts` — 提案から予定への変換。変換できない入力は例外ではなく
  `null` を返し、保存経路へ渡さない（fail-closed）
- 保存前に確認ダイアログを表示し、AI 出力をユーザー確認なしで永続化しない
- 追加先はベースカレンダー（`BASE_CALENDAR_ID = "main"`）に固定し、共有カレンダーへは書き込まない
- 変換の検証は `__tests__/aiScheduleToEvent.test.ts`（10 ケース）

---

## 6. セキュリティ設計の要点

詳細は [docs/SECURITY.md](docs/SECURITY.md) に記載しています。

1. 権限判定はサーバー側の Row Level Security を正本とする。
   クライアント側の判定は UI 制御のためであり、これを除いても他ユーザーのデータへは到達しない
2. 書き込みの成否を「エラーが発生しなかったこと」で判定しない。
   RLS が USING 句のみのポリシーでは、権限のない UPDATE は 0 行更新かつエラーなしで返るため、
   影響行数を確認して成否を判定する
3. 共有操作は認証セッションへ紐づけて実行する。処理途中でアカウントが切り替わった場合、
   後続の副作用を実行しない
4. リポジトリに秘密情報を含めない（`.env` は追跡対象外、`.env.example` は変数名のみ）

---

## 7. テスト・検証結果

いずれも本リポジトリの状態で実測した結果です。実行環境はローカルであり、
本番環境での運用実績ではありません。

| 検証 | 結果 |
|---|---|
| lint `npm run lint` | エラー 0 / 警告 0 |
| 型チェック `npx tsc --noEmit` | エラー 0 |
| テスト `npx jest` | 15 スイート / 225 ケース 成功 |
| migration 適用（PostgreSQL 17 / 使い捨て DB） | 15/15 適用成功 |
| RLS 3 ユーザー検証（PostgreSQL 17 / 使い捨て DB） | 18/18 成功 |
| 秘密情報スキャン | 検出 0 |

RLS 検証の 18 項目の内訳は、第三者 12 / 所有者・メンバー 4 / 書き込みガード 2 です。
所有者・メンバー・第三者の 3 ユーザーを作成し、第三者について次の操作が
成立しないことを実測しています。

- 共有カレンダーの一覧取得（0 件）
- 予定の閲覧（0 件） / 更新・削除（0 行） / 追加（拒否）
- メンバー一覧の取得（0 件） / 自身の追加（拒否） / 削除（0 行）
- 招待の発行（拒否） / 招待一覧の取得（0 件）
- カレンダー名の変更・削除（0 行）

---

## 8. 参照ファイル

| 目的 | ファイル |
|---|---|
| 読む順序と確認事項 | [docs/REVIEW_GUIDE.md](docs/REVIEW_GUIDE.md) |
| 全体構成（画面 / 状態 / サービス / Supabase / Demo AI） | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 設計判断とその理由 | [docs/DECISIONS.md](docs/DECISIONS.md) |
| セキュリティ設計 | [docs/SECURITY.md](docs/SECURITY.md) |
| カレンダー画面の入口 | [app/index.tsx](app/index.tsx) |
| 共有カレンダーのサービス層 | [src/services/calendarService.ts](src/services/calendarService.ts) |
| RLS の定義 | [supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql) |
| AI 提案から予定への変換 | [src/utils/aiScheduleToEvent.ts](src/utils/aiScheduleToEvent.ts) |

---

## 9. Portfolio Edition の適用範囲

添付画像・画像アップロード、課金・プレミアム、広告、退会処理、外部 LLM 呼び出しと使用量課金は
本リポジトリに含めていません。

いずれも動作確認に外部サービスの資格情報または契約が必要であり、
レビュー環境で再現できない構成になるためです。
安全に再現可能なレビュー範囲へ限定する目的で対象外としています。
判断の詳細は [docs/DECISIONS.md](docs/DECISIONS.md) に記載しています。
