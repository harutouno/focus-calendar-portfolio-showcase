-- ============================================================================
-- Portfolio Edition compatibility — 既存 migration の参照互換カラムのみ
-- ============================================================================
-- このファイルは公開用 Portfolio Edition だけに存在する。本体アプリには無い。
--
-- 本体では 0003_avatar_and_cover.sql が次の 3 つをまとめて行っていた。
--   (a) profiles.avatar_url カラム追加
--   (b) calendars.cover_image_url カラム追加
--   (c) Storage(calendar-covers バケット) の RLS ポリシーと update_calendar_cover RPC
--
-- Portfolio Edition は画像アップロードを含まないため (c) を収録していない。
-- しかし (a)(b) は Storage とは無関係なカラムであり、収録済みの
-- migration が実際に参照している。
--   calendars.cover_image_url を参照する収録 migration
--     0010_invite_recipient_inbox.sql       招待一覧にカバー URL を返す
--     0016_calendar_creation_limits.sql
--     0028_pending_invite_recipient_authority.sql
--
-- そのためカラムだけをここで追加する。Storage ポリシーもアップロード RPC も作らない。
-- Portfolio Edition はどちらの値も書き込まない。avatar_url は将来の認証プロバイダ
-- 由来の表示名互換として、cover_image_url は既存 migration の参照互換としてだけ残す。
-- ============================================================================

alter table public.profiles
  add column if not exists avatar_url text;

alter table public.calendars
  add column if not exists cover_image_url text;

comment on column public.profiles.avatar_url is
  'Portfolio Edition は画像アップロードを含まない。認証プロバイダ由来の表示値との互換カラム。';
comment on column public.calendars.cover_image_url is
  'Portfolio Edition は画像アップロードを含まない。既存 migration の参照互換カラム。';
