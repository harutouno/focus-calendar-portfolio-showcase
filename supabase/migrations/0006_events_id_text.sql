-- events.id の型修正: uuid -> text
--
-- 背景（重大バグの修正）:
--   クライアント側の generateId()（src/utils/id.ts）は "evt_<timestamp36>_<random36>" という
--   非UUID形式の文字列IDを生成する。0001_init.sql では events.id が uuid 型だったため、
--   共有カレンダーへの予定保存（upsertSharedEvent / upsertSharedEventsBulk）は
--   実際のSupabase環境では常に「invalid input syntax for type uuid」エラーで失敗していた。
--   このmigrationは、既に0001_init.sqlを実行済みのSupabaseプロジェクト向けに列の型を修正する。
--
-- 使い方: Supabaseダッシュボード → SQL Editor に、このファイルの内容をそのまま貼り付けて
-- 実行してください（0001〜0005を実行済みの既存プロジェクトのみ必要。新規セットアップでは
-- 0001_init.sql が既にtext型で作成されるため、このファイルは不要です）。
--
-- 影響範囲: events.id を参照する外部キーは他のテーブルに存在しないため、
-- この列の型変更単体で完結する（他のテーブル・RLSポリシー・RPCへの追加変更は不要）。

-- 既存データがあっても安全に変換されるよう、USING で明示的にuuid->textへキャストする
-- （uuidの正規テキスト表現に変換されるだけで、値の欠落・破損は発生しない）。
-- events.id を参照する外部キーは他テーブルに存在しないため、この変更はevents単体で完結する。
alter table public.events
  alter column id type text using id::text;

-- verify: select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'events' and column_name = 'id';
--   -- data_type が 'text' になっていればOK。
