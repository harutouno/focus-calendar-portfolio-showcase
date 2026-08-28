# セキュリティ設計

本リポジトリは選考提出用 Portfolio Edition であり、実際の鍵・プロジェクト ID・端末情報は
含めていません。本書では、共有データの保護に関する設計と検証結果を記載します。

## 1. 権限の正本は Row Level Security

共有カレンダーでは、複数ユーザーのデータが同一テーブルに格納されます。
権限判定をアプリ側のみに置くと、判定を経由しない経路が発生した時点で保護が失われます。

権限の正本を PostgreSQL の Row Level Security に置いています。

- `calendars` / `calendar_members` / `calendar_invites` / `events` / `profiles`
  の 5 テーブルすべてで RLS を有効化
- 各ポリシーは `is_calendar_member(calendar_id, min_role)` を基礎とする
- クライアント側の権限判定は UI 制御を目的とし、除いた場合でも他ユーザーのデータへ到達しない

## 2. 特権操作を RPC に限定する

招待の発行・受諾・辞退・取り消し、共有カレンダーからの退出は、
テーブルへの直接書き込みではなく `security definer` の RPC で実行します。

- `create_calendar_invite` — 実行できるのは owner のみ
- `accept_calendar_invite_by_id` — 実行できるのは招待の宛先本人のみ。
  宛先の一致はクライアントの申告ではなく JWT の email で判定する
- `leave_shared_calendar` — 自身の所属のみを解除できる

各 RPC は `revoke all from public` を行ったうえで、`authenticated` にのみ
`grant execute` を付与しています。

## 3. 書き込みの成否を影響行数で判定する

RLS の `USING` 句のみのポリシーでは、権限のない UPDATE / DELETE は
エラーではなく 0 行更新として返ります。
`if (error) throw` のみの実装では、権限がない場合も成功として扱われます。

書き込みは `src/services/writeEffectAuthority.ts` を経由し、影響行数を確認して判定します。

```
NO_ERROR  ≠  EFFECT_APPLIED
NO_ROWS   ≠  DENY           （対象行が存在しない場合と権限がない場合は区別が必要）
```

## 4. 操作を認証セッションへ紐づける

共有カレンダーの操作中にアカウントが切り替わると、
先行操作の続きが別セッションで実行される可能性があります。

- `src/auth/sharedMutationIdentity.ts` が操作開始時点の identity を固定する
- 各 await の前後で identity の同一性を確認し、変化していれば後続の副作用を実行しない
- オフライン同期キュー（`useSyncQueueProcessor`）もユーザー単位で分離し、
  前ユーザーのキューを新しいセッションで処理しない

AI の依頼も同様に、依頼の所有者を明示的な操作時点で固定しています
（`src/ai/aiOperationOwner.ts`）。

## 5. リポジトリに秘密情報を含めない

- `.env` は追跡対象外。`.env.example` は変数名のみで値は空
- 外部 LLM の API キー、Edge Function、service_role キーは含まない
- Supabase プロジェクト ID、端末 ID、署名鍵は含まない
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` はクライアント公開を前提とする値だが、
  値自体はリポジトリに置かず、各環境で設定する

## 6. 検証方法と結果

ローカルの使い捨てデータベース（PostgreSQL 17）に所有者 / メンバー / 第三者の
3 ユーザーを作成し、RLS を実測しています。18 項目の内訳は、第三者 12 /
所有者・メンバー 4 / 書き込みガード 2 で、全項目が期待どおりの結果でした。
本番環境での運用実績ではありません。

第三者について成立しないことを確認した操作

| 操作 | 期待 | 実測 |
|---|---|---|
| 共有カレンダーの一覧取得 | 0 件 | 0 件 |
| 予定の閲覧 | 0 件 | 0 件 |
| 予定の更新 | 0 行 | 0 行 |
| 予定の削除 | 0 行 | 0 行 |
| 予定の追加 | 拒否 | 拒否 |
| メンバー一覧の取得 | 0 件 | 0 件 |
| 自身をメンバーに追加 | 拒否 | 拒否 |
| メンバーの削除 | 0 行 | 0 行 |
| 招待の発行 | 拒否 | 拒否 |
| 招待一覧の取得 | 0 件 | 0 件 |
| カレンダー名の変更 | 0 行 | 0 行 |
| カレンダーの削除 | 0 行 | 0 行 |

所有者・メンバーについて成立することを確認した操作

| 操作 | 実測 |
|---|---|
| 所有者: カレンダー一覧 | 1 件 |
| メンバー: カレンダー一覧 | 1 件 |
| メンバー: 予定の閲覧 | 1 件 |
| 所有者: 招待の発行 | 成功 |

書き込みガードの単体確認

| 入力 | 期待 | 実測 |
|---|---|---|
| `account_write_allowed(null)` | false | false |
| `account_write_allowed(存在しない uuid)` | false | false |

`account_write_allowed()` は `p_user_id is not null` と `profiles` への実在を
同時に要求する定義であり、この 2 条件を満たす認証済みユーザーに対してのみ true を返します
（`supabase/migrations/0002_portfolio_compat_account_write_allowed.sql`）。

## 7. 本リポジトリの適用範囲外

- 本番環境での運用実績（検証はローカル環境のみ）
- 外部 LLM を接続した場合の安全性（接続実装を含まない）
- 課金・広告・添付・退会に関する安全性（該当機能を含まない）
