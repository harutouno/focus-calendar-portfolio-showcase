-- Stage 1-C: プロフィール画像・カレンダーのカバー画像を保存するためのDB基盤（追加のみ）
--
-- 方針:
--   * 既存のテーブル・カラム・RLSポリシー・RPC関数は一切変更・削除しない。
--   * このファイルは「追加」のみで構成する（列追加・新規RPC・新規Storageポリシー）。
--   * 既存の "calendar_covers_owner_write/update/delete"（0002_storage.sql）は
--     そのまま残す。editor向けの権限は、それとは別名の新しいpermissiveポリシーを
--     追加することで実現する（PostgreSQLのRLSは同一コマンドに対する複数の
--     permissiveポリシーをORで評価するため、既存ポリシーを削除・緩和せずに
--     「オーナー"または"編集者」を許可できる）。
--   * service_role は一切使わない。
--   * 未適用でもアプリは今まで通り動作する。適用しても既存データ（profiles /
--     calendars の既存行）は一切変更されない（新しい列はnullで追加されるのみ）。

-- ============================================================
-- 1. 列追加（既存カラムは変更しない）
-- ============================================================
alter table public.profiles
  add column if not exists avatar_url text;

alter table public.calendars
  add column if not exists cover_image_url text;

-- verify: select column_name from information_schema.columns
--   where table_name in ('profiles','calendars') and column_name in ('avatar_url','cover_image_url');

-- ============================================================
-- 2. カバー画像更新RPC（新規追加。既存RPCは無変更）
--    オーナー・編集者のみ許可（閲覧者は不可）。名前・色の変更は既存の
--    "calendars_update_owner" ポリシー（オーナー限定）のまま、今回は一切触れない。
-- ============================================================
create or replace function public.update_calendar_cover(
  p_calendar_id uuid,
  p_cover_image_url text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_calendar_member(p_calendar_id, 'editor') then
    raise exception 'not authorized';
  end if;
  update public.calendars
    set cover_image_url = p_cover_image_url
    where id = p_calendar_id;
end;
$$;

revoke all on function public.update_calendar_cover(uuid, text) from public;
grant execute on function public.update_calendar_cover(uuid, text) to authenticated;

-- verify: select proname from pg_proc where proname = 'update_calendar_cover';

-- ============================================================
-- 3. Storage: calendar-covers バケットへ「編集者も書き込み可」を追加
--    （0002_storage.sql実行済みの場合のみ意味を持つ。未実行でもエラーにはならない）
--    既存の calendar_covers_owner_write / _update / _delete ポリシーは削除・変更しない。
--    別名の新しいpermissiveポリシーを追加するだけなので、既存ポリシーとORで
--    評価され、「オーナー または 編集者」が書き込み可能になる。
-- ============================================================
create policy "calendar_covers_editor_write"
  on storage.objects for insert
  with check (
    bucket_id = 'calendar-covers'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'editor')
  );

create policy "calendar_covers_editor_update"
  on storage.objects for update
  using (
    bucket_id = 'calendar-covers'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'editor')
  );

create policy "calendar_covers_editor_delete"
  on storage.objects for delete
  using (
    bucket_id = 'calendar-covers'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'editor')
  );

-- avatars バケットは変更しない（既に本人のみ書き込み可で、今回の要件と一致するため）。

-- verify: select policyname, cmd from pg_policies
--   where tablename = 'objects' and policyname like 'calendar_covers%';
