-- 任意migration: プロフィール画像・カレンダーのカバー画像用Storageバケット
--
-- 現時点ではアプリ側に画像アップロードUIは実装されていない。将来の機能追加に備えて
-- バケットとアクセス権だけを先に用意しておくためのもの。実行しなくてもアプリの動作に
-- 影響はない（SUPABASE_SETUP.md の「4.5 画像用Storageバケット（任意）」参照）。
--
-- 方針は 0001_init.sql と同じ: service_role は一切使わず、anonキー経由のRLSで守る。

-- ============================================================
-- avatars: プロフィール画像。ファイル名は "{自分のuser_id}/..." のように
-- 先頭フォルダを本人のuser_idにする想定
-- ============================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatars_public_read"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "avatars_owner_write"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_owner_update"
  on storage.objects for update
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_owner_delete"
  on storage.objects for delete
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================
-- calendar-covers: 共有カレンダーのカバー画像。先頭フォルダを calendar_id にする想定
-- ============================================================
insert into storage.buckets (id, name, public)
values ('calendar-covers', 'calendar-covers', true)
on conflict (id) do nothing;

create policy "calendar_covers_public_read"
  on storage.objects for select
  using (bucket_id = 'calendar-covers');

create policy "calendar_covers_owner_write"
  on storage.objects for insert
  with check (
    bucket_id = 'calendar-covers'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'owner')
  );

create policy "calendar_covers_owner_update"
  on storage.objects for update
  using (
    bucket_id = 'calendar-covers'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'owner')
  );

create policy "calendar_covers_owner_delete"
  on storage.objects for delete
  using (
    bucket_id = 'calendar-covers'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'owner')
  );

-- verify: select id, public from storage.buckets where id in ('avatars', 'calendar-covers');
