-- Stage 2: 共有カレンダーのカバー画像をprivate Storage方式へ移行（セキュリティ修正）
--
-- 背景:
--   Stage 1-C（0002_storage.sql, 0003_avatar_and_cover.sql）ではcalendar-coversバケットを
--   public=trueのまま運用し、cover_image_urlには誰でも閲覧可能な公開URLを保存していた。
--   このmigrationは、共有カレンダーのメンバー（owner/editor/viewer）だけが画像を閲覧できる
--   ようにバケットをprivate化し、Storage RLSを最小権限（閲覧=メンバーのみ、変更・削除=
--   オーナーのみ）へ絞り込む。
--
-- 方針:
--   * このファイルは作成のみで、Supabaseへは適用しない（レビュー後にユーザー自身が実行する）。
--   * 既存テーブルの列・型は変更しない（cover_image_urlは引き続きtext型のまま。保存する
--     「値の意味」が公開URLからバケット内相対パスへ変わるだけで、アプリ側コードで対応する）。
--   * service_roleは一切使わない。
--
-- rollback時の注意（このmigrationを取り消す場合）:
--   * バケットをpublicへ戻す（`update storage.buckets set public = true where id = 'calendar-covers';`）
--     だけではデータの整合性は壊れない（ベアパス形式の値はpublicバケットでも
--     `{project}/storage/v1/object/public/calendar-covers/{path}`として引き続き有効なため）。
--   * ただし本migrationのSELECTポリシー（calendar_covers_members_read）・DROPした
--     旧ポリシー群は、rollback時に手動で作り直す必要がある（このファイルは冪等なDROPしか
--     行わないため、逆方向の migration ファイルは別途用意すること）。
--   * update_calendar_coverをeditor許可へ戻す場合は、下記4番のcreate or replaceを
--     0003_avatar_and_cover.sqlの元の定義（'editor'）に戻すだけでよい。
--   * 5番のデータ移行（既存公開URL→ベアパス書き換え）はUPDATE文であり、実行前に
--     `select id, cover_image_url from public.calendars where cover_image_url is not null;`
--     等でバックアップを取ってから適用することを推奨する。

-- ============================================================
-- 1. Storage: calendar-covers バケットをprivateへ変更
-- ============================================================
update storage.buckets set public = false where id = 'calendar-covers';

-- verify: select id, public from storage.buckets where id = 'calendar-covers';

-- ============================================================
-- 2. Storage RLS: 過剰な権限を持つ旧ポリシーを削除
--    - calendar_covers_public_read: 無条件公開読み取り（privateバケットの目的と矛盾するため削除）。
--    - calendar_covers_editor_write/_update/_delete（0003で追加）: エディタは予定の編集権限とは
--      別に、共有カレンダー画像そのものは変更・削除できない仕様へ変更するため削除する。
--      影響: 現在この3ポリシーにより editor はカバー画像のアップロード・上書き・削除が
--      可能だったが、削除後はRLS拒否（403相当）になる。UI側（app/calendar/[id]/settings.tsx）も
--      同じタイミングでオーナー限定へ変更する。
--    - calendar_covers_owner_update（0002）: 保存パスが一意なリビジョンファイル名方式になり
--      同一パスへの上書き（UPDATE）は発生しない設計のため、原則不要な権限として削除する。
-- ============================================================
drop policy if exists "calendar_covers_public_read" on storage.objects;
drop policy if exists "calendar_covers_editor_write" on storage.objects;
drop policy if exists "calendar_covers_editor_update" on storage.objects;
drop policy if exists "calendar_covers_editor_delete" on storage.objects;
drop policy if exists "calendar_covers_owner_update" on storage.objects;

-- ============================================================
-- 3. Storage RLS: メンバーのみ閲覧可能な新しいSELECTポリシー
--    is_calendar_member(calendarId, 'viewer') は「viewer以上」＝owner/editor/viewerの
--    いずれでも真になる（0001_init.sqlのis_calendar_member定義を参照）。
--    非メンバー・未認証（auth.uid()がnull）は必ず偽になる。
--
--    既存の calendar_covers_owner_write（INSERT）・calendar_covers_owner_delete（DELETE）
--    （いずれも0002_storage.sql）はオーナー限定のまま今回の仕様と一致するため変更しない。
--    UPDATEポリシーは上記2番で削除済みのまま復活させない（一意パス方式のため原則不要）。
-- ============================================================
create policy "calendar_covers_members_read"
  on storage.objects for select
  using (
    bucket_id = 'calendar-covers'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'viewer')
  );

-- verify: select policyname, cmd from pg_policies
--   where tablename = 'objects' and policyname like 'calendar_covers%';

-- ============================================================
-- 4. update_calendar_cover RPC: editor許可 → owner限定へ厳格化
--    （0003_avatar_and_cover.sqlの定義をcreate or replaceで置き換える。関数シグネチャ・
--    権限grantは変更しない）
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
  if not public.is_calendar_member(p_calendar_id, 'owner') then
    raise exception 'not authorized';
  end if;
  update public.calendars
    set cover_image_url = p_cover_image_url
    where id = p_calendar_id;
end;
$$;

-- verify: select prosrc from pg_proc where proname = 'update_calendar_cover';
--   （本文に 'owner' が含まれ 'editor' が含まれていないことを確認）

-- ============================================================
-- 5. 既存データ移行: 公開URL形式のcover_image_urlをバケット内相対パスへ書き換え
--    アプリ側は今後cover_image_urlを「バケット内相対パス」として扱う
--    （表示のたびに署名付きURLを発行する）。既存行のうち、旧imageUploadService.tsが
--    生成した公開URL形式（.../object/public/calendar-covers/{calendarId}/{revisionId}.jpg
--    に "?t=..." キャッシュ回避クエリが付いたものを含む）に一致する行だけを対象にし、
--    calendarId・ファイル名部分は一切変更しない（Storage上のファイル自体は移動しないため安全）。
--    一致しない値（想定外の外部URL等）は一切触らない。
-- ============================================================
update public.calendars
set cover_image_url = regexp_replace(
  cover_image_url,
  '^.*/storage/v1/object/public/calendar-covers/([^?]*).*$',
  '\1'
)
where cover_image_url like '%/storage/v1/object/public/calendar-covers/%';

-- verify: select id, cover_image_url from public.calendars where cover_image_url is not null;
--   （残っている値がすべて "{calendarId}/{revisionId}.jpg" 形式のベアパスであることを確認）
