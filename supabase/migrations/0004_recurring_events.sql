-- Stage E: 共有カレンダーの一括作成（期間・曜日指定）を保存するためのDB基盤（追加のみ）
--
-- 方針は0001〜0003と同じ: 既存のテーブル・列・RLSポリシー・RPC関数は一切変更・削除しない。
-- 一括作成は「独立したN件の予定」として1行ずつINSERTされるだけなので、
-- 既存のevents_insert_editor等のRLSポリシー（calendar_id/created_byの行単位チェック）は
-- 無変更のまま機能する（複数行の一括upsertも、Postgres/RLSからは1行ずつのINSERTの
-- 集合として評価されるため、「一括」という概念自体がRLSには見えない）。

-- ============================================================
-- 1. recurring_group_id / recurrence_index 列を追加（既存列は無変更）
--    client側で生成するID(generateId())はUUID形式ではないため、text型にする
--    （events.id列は既存のuuid型のままで、ここでは変更しない）。
-- ============================================================
alter table public.events
  add column if not exists recurring_group_id text;

alter table public.events
  add column if not exists recurrence_index int;

-- 将来の「これ以降/すべて」編集・削除機能で recurring_group_id 検索を使う想定のため、
-- 参照用インデックスも合わせて追加しておく（今回の一括保存機能自体には必須ではない）。
create index if not exists events_recurring_group_id_idx
  on public.events (recurring_group_id);

-- verify: select column_name from information_schema.columns
--   where table_name = 'events' and column_name in ('recurring_group_id','recurrence_index');
