-- フェーズ1: 予定メモへの画像添付機能（型・DB基盤のみ。画像処理・UIはフェーズ2以降）
--
-- 方針:
--   * 既存のテーブル・カラム・RLSポリシー・RPC関数は一切変更・削除しない（追加のみ）。
--   * このファイルは作成のみで、Supabaseへは適用しない（レビュー後にユーザー自身が実行する）。
--   * service_role は一切使わない。
--   * 未適用でもアプリは今まで通り動作する（画像添付UIはまだ存在しないため）。
--
-- 重要な制約（現時点の既知の限界）:
--   * Supabaseはユーザーのプラン状態（無料/プレミアム）を一切保持していない
--     （正式課金が未実装。src/services/localPremiumService.ts は端末内AsyncStorageのみで完結する）。
--     そのためresolve_owner_plan()は当面常に'free'を返す。将来の課金機能実装時は、
--     この関数の中身だけを書き換えれば、enforce_attachment_quota()トリガー側は無変更で対応できる。
--   * 枚数・容量の数値は src/constants/attachmentLimits.ts の ATTACHMENT_LIMITS と
--     同じ値をここに複製している（PL/pgSQLからTS定数を直接参照できないため）。
--     どちらかを変更したら、必ずもう片方も合わせて変更すること。

-- ============================================================
-- 1. event_attachments テーブル
-- ============================================================
create table if not exists public.event_attachments (
  id uuid primary key default gen_random_uuid(),
  -- events.id は generateId() が生成する非UUID文字列（"evt_..."）のため text 型
  -- （0006_events_id_text.sql と同じ理由）。
  event_id text not null references public.events (id) on delete cascade,
  storage_path text not null unique,
  thumbnail_path text,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint not null check (byte_size >= 0),
  width int,
  height int,
  sort_order int not null default 0 check (sort_order >= 0),
  -- "uploading": アップロード中（フェーズ2で使用）/ "ready": 有効な添付 / "failed": 失敗
  upload_status text not null default 'ready' check (upload_status in ('uploading', 'ready', 'failed')),
  created_by uuid not null references auth.users (id) on delete cascade,
  -- 二段階削除用（22番: DBとStorageの削除を完全な単一トランザクションにできないため、
  -- 先にdeleted_atを立ててからStorage削除→行の物理削除、の順で行う。孤立防止はフェーズ3で扱う）。
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 二重登録防止: クライアントは添付ごとに一意なuuidを1回だけ生成し、そのままidとして使う
-- （events.upsertSharedEvent が onConflict:"id" で行っている冪等パターンと同じ）。
-- 挿入は upsert(row, {onConflict:"id"}) で行うため、再送しても新しい行は増えない。
-- このためrequest_idのような別列は追加しない。

drop trigger if exists event_attachments_set_updated_at on public.event_attachments;
create trigger event_attachments_set_updated_at
  before update on public.event_attachments
  for each row execute function public.set_updated_at();

create index if not exists event_attachments_event_id_idx on public.event_attachments (event_id);

alter table public.event_attachments enable row level security;

-- verify: select column_name from information_schema.columns where table_name = 'event_attachments';

-- ============================================================
-- 2. プラン判定（将来の課金接続ポイントを1関数に集約）
-- ============================================================
create or replace function public.resolve_owner_plan(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- 現時点ではプラン状態を保持するテーブルが存在しないため、常に'free'を返す。
  -- 将来、profilesへプラン列（またはentitlementsテーブル）を追加した際は、
  -- この関数の中身だけをそのカラム参照に置き換える（呼び出し元は無変更でよい）。
  select 'free'::text;
$$;

revoke all on function public.resolve_owner_plan(uuid) from public;
grant execute on function public.resolve_owner_plan(uuid) to authenticated;

-- ============================================================
-- 3. 容量・枚数のサーバー側最終判定（BEFORE INSERTトリガー）
--    権限（editor以上）チェックはRLSのINSERTポリシーに任せ、ここでは数量のみ判定する。
-- ============================================================
create or replace function public.enforce_attachment_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calendar_id uuid;
  v_owner_id uuid;
  v_plan text;
  v_max_images int;
  v_max_bytes_per_image bigint;
  v_max_total_bytes bigint;
  v_current_images int;
  v_current_total_bytes bigint;
begin
  select e.calendar_id, c.owner_id
    into v_calendar_id, v_owner_id
    from public.events e
    join public.calendars c on c.id = e.calendar_id
    where e.id = new.event_id;

  if v_owner_id is null then
    raise exception 'event_not_found';
  end if;

  v_plan := public.resolve_owner_plan(v_owner_id);

  if v_plan = 'premium' then
    v_max_images := 5;
    v_max_bytes_per_image := 3 * 1024 * 1024;
    v_max_total_bytes := 1024 * 1024 * 1024;
  else
    v_max_images := 1;
    v_max_bytes_per_image := 1 * 1024 * 1024;
    v_max_total_bytes := 50 * 1024 * 1024;
  end if;

  if new.byte_size > v_max_bytes_per_image then
    raise exception 'attachment_too_large';
  end if;

  select count(*) into v_current_images
    from public.event_attachments a
    where a.event_id = new.event_id
      and a.upload_status = 'ready'
      and a.deleted_at is null
      and a.id <> new.id;

  if v_current_images >= v_max_images then
    raise exception 'attachment_event_limit';
  end if;

  select coalesce(sum(a.byte_size), 0) into v_current_total_bytes
    from public.event_attachments a
    join public.events e2 on e2.id = a.event_id
    join public.calendars c2 on c2.id = e2.calendar_id
    where c2.owner_id = v_owner_id
      and a.upload_status = 'ready'
      and a.deleted_at is null
      and a.id <> new.id;

  if v_current_total_bytes + new.byte_size > v_max_total_bytes then
    raise exception 'attachment_quota_exceeded';
  end if;

  return new;
end;
$$;

drop trigger if exists event_attachments_enforce_quota on public.event_attachments;
create trigger event_attachments_enforce_quota
  before insert on public.event_attachments
  for each row execute function public.enforce_attachment_quota();

-- ============================================================
-- 4. RLS（event_attachments）: eventsを経由してカレンダー権限を判定する
-- ============================================================
create policy "event_attachments_select_members"
  on public.event_attachments for select
  using (
    exists (
      select 1 from public.events e
      where e.id = event_attachments.event_id
        and public.is_calendar_member(e.calendar_id, 'viewer')
    )
  );

create policy "event_attachments_insert_editor"
  on public.event_attachments for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.events e
      where e.id = event_attachments.event_id
        and public.is_calendar_member(e.calendar_id, 'editor')
    )
  );

create policy "event_attachments_update_editor"
  on public.event_attachments for update
  using (
    exists (
      select 1 from public.events e
      where e.id = event_attachments.event_id
        and public.is_calendar_member(e.calendar_id, 'editor')
    )
  );

create policy "event_attachments_delete_editor"
  on public.event_attachments for delete
  using (
    exists (
      select 1 from public.events e
      where e.id = event_attachments.event_id
        and public.is_calendar_member(e.calendar_id, 'editor')
    )
  );

-- verify: select * from pg_policies where tablename = 'event_attachments';

-- ============================================================
-- 5. Realtime: 予定編集時に他端末の添付一覧も追従できるようにする
-- ============================================================
alter publication supabase_realtime add table public.event_attachments;

-- ============================================================
-- 6. Storage: event-attachments バケット（非公開）
--    パス規約: event-attachments/{calendarId}/{eventId}/{attachmentId}/original.<ext>
--    （サムネイルは同フォルダに thumb.<ext>、フェーズ2で使用）。
--    先頭フォルダをcalendarIdにすることで、既存のcalendar-coversと同じ
--    storage.foldername(name)[1] パターンでRLSを組める。
-- ============================================================
insert into storage.buckets (id, name, public)
values ('event-attachments', 'event-attachments', false)
on conflict (id) do nothing;

create policy "event_attachments_storage_select"
  on storage.objects for select
  using (
    bucket_id = 'event-attachments'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'viewer')
  );

create policy "event_attachments_storage_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'event-attachments'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'editor')
  );

create policy "event_attachments_storage_update"
  on storage.objects for update
  using (
    bucket_id = 'event-attachments'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'editor')
  );

create policy "event_attachments_storage_delete"
  on storage.objects for delete
  using (
    bucket_id = 'event-attachments'
    and public.is_calendar_member(((storage.foldername(name))[1])::uuid, 'editor')
  );

-- 意図的に "_public_read" ポリシーは作らない（非公開が今回の中核要件のため）。

-- verify: select id, public from storage.buckets where id = 'event-attachments';
-- verify: select policyname, cmd from pg_policies where tablename = 'objects' and policyname like 'event_attachments_storage%';
