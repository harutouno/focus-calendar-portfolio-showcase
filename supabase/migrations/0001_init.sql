-- 第2工程: 共有カレンダー・招待・RLS の初期スキーマ
--
-- 使い方: Supabaseダッシュボード → SQL Editor に、このファイルの内容を
-- そのまま貼り付けて実行してください（SUPABASE_SETUP.md 参照）。
--
-- 方針:
--   * service_role は一切使わない。すべてanonキー経由のRLSで守る。
--   * 招待トークンは生値をDBへ保存しない（sha256ハッシュのみ保存）。
--   * RLSポリシーの再帰参照を避けるため、判定ロジックは SECURITY DEFINER 関数に閉じ込め、
--     search_path を固定して権限を最小化する。

create extension if not exists "pgcrypto";

-- ============================================================
-- 1. profiles: auth.users と 1:1
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles_update_own"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- 新規サインアップ時に profiles 行を自動作成する
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- verify: select * from pg_policies where tablename = 'profiles';

-- ============================================================
-- 2. calendars
-- ============================================================
create table if not exists public.calendars (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#2E5FE8',
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists calendars_set_updated_at on public.calendars;
create trigger calendars_set_updated_at
  before update on public.calendars
  for each row execute function public.set_updated_at();

alter table public.calendars enable row level security;

-- ============================================================
-- 3. calendar_members
-- ============================================================
create table if not exists public.calendar_members (
  calendar_id uuid not null references public.calendars (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (calendar_id, user_id)
);

alter table public.calendar_members enable row level security;

-- カレンダー作成者を owner として自動登録
create or replace function public.handle_new_calendar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.calendar_members (calendar_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (calendar_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_calendar_created on public.calendars;
create trigger on_calendar_created
  after insert on public.calendars
  for each row execute function public.handle_new_calendar();

-- ============================================================
-- 4. 権限判定ヘルパー（RLSの再帰参照を避けるため SECURITY DEFINER）
-- ============================================================
create or replace function public.is_calendar_member(
  p_calendar_id uuid,
  p_min_role text default 'viewer'
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.calendar_members m
    where m.calendar_id = p_calendar_id
      and m.user_id = auth.uid()
      and (
        p_min_role = 'viewer'
        or (p_min_role = 'editor' and m.role in ('editor', 'owner'))
        or (p_min_role = 'owner' and m.role = 'owner')
      )
  );
$$;

revoke all on function public.is_calendar_member(uuid, text) from public;
grant execute on function public.is_calendar_member(uuid, text) to authenticated;

-- calendars のRLSポリシー（is_calendar_member定義後に作成）
create policy "calendars_select_members"
  on public.calendars for select
  using (public.is_calendar_member(id, 'viewer'));

create policy "calendars_insert_self"
  on public.calendars for insert
  with check (owner_id = auth.uid());

create policy "calendars_update_owner"
  on public.calendars for update
  using (public.is_calendar_member(id, 'owner'))
  with check (public.is_calendar_member(id, 'owner'));

create policy "calendars_delete_owner"
  on public.calendars for delete
  using (public.is_calendar_member(id, 'owner'));

-- calendar_members のRLSポリシー
create policy "members_select_same_calendar"
  on public.calendar_members for select
  using (public.is_calendar_member(calendar_id, 'viewer'));

create policy "members_insert_owner_or_self_via_rpc"
  on public.calendar_members for insert
  with check (public.is_calendar_member(calendar_id, 'owner'));

create policy "members_update_owner"
  on public.calendar_members for update
  using (public.is_calendar_member(calendar_id, 'owner'))
  with check (public.is_calendar_member(calendar_id, 'owner'));

create policy "members_delete_owner"
  on public.calendar_members for delete
  using (public.is_calendar_member(calendar_id, 'owner'));

-- verify: select * from pg_policies where tablename in ('calendars', 'calendar_members');

-- ============================================================
-- 5. calendar_invites（生トークンは保存しない）
-- ============================================================
create table if not exists public.calendar_invites (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.calendars (id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  token_hash text not null unique,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

alter table public.calendar_invites enable row level security;

create policy "invites_select_owner"
  on public.calendar_invites for select
  using (public.is_calendar_member(calendar_id, 'owner'));

create policy "invites_insert_owner"
  on public.calendar_invites for insert
  with check (public.is_calendar_member(calendar_id, 'owner') and created_by = auth.uid());

create policy "invites_update_owner"
  on public.calendar_invites for update
  using (public.is_calendar_member(calendar_id, 'owner'))
  with check (public.is_calendar_member(calendar_id, 'owner'));

-- verify: select * from pg_policies where tablename = 'calendar_invites';

-- 招待作成RPC: 生トークンはこの呼び出しの戻り値にのみ含まれる
create or replace function public.create_calendar_invite(
  p_calendar_id uuid,
  p_role text,
  p_expires_in_hours int default 168
)
returns table (invite_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  if not public.is_calendar_member(p_calendar_id, 'owner') then
    raise exception 'not authorized';
  end if;
  if p_role not in ('editor', 'viewer') then
    raise exception 'invalid role';
  end if;

  v_token := translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');
  v_expires := now() + make_interval(hours => p_expires_in_hours);

  insert into public.calendar_invites (calendar_id, role, token_hash, created_by, expires_at)
  values (p_calendar_id, p_role, encode(digest(v_token, 'sha256'), 'hex'), auth.uid(), v_expires)
  returning id into v_id;

  return query select v_id, v_token, v_expires;
end;
$$;

revoke all on function public.create_calendar_invite(uuid, text, int) from public;
grant execute on function public.create_calendar_invite(uuid, text, int) to authenticated;

-- 招待失効RPC
create or replace function public.revoke_calendar_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calendar_id uuid;
begin
  select calendar_id into v_calendar_id from public.calendar_invites where id = p_invite_id;
  if v_calendar_id is null or not public.is_calendar_member(v_calendar_id, 'owner') then
    raise exception 'not authorized';
  end if;
  update public.calendar_invites set revoked_at = now() where id = p_invite_id;
end;
$$;

revoke all on function public.revoke_calendar_invite(uuid) from public;
grant execute on function public.revoke_calendar_invite(uuid) to authenticated;

-- 招待参加RPC: ハッシュ照合・期限/失効チェック・冪等な参加（重複メンバーを作らない）
create or replace function public.accept_calendar_invite(p_token text)
returns table (calendar_id uuid, calendar_name text, role text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite record;
begin
  select * into v_invite
  from public.calendar_invites
  where token_hash = encode(digest(p_token, 'sha256'), 'hex');

  if v_invite is null then
    raise exception 'invite not found';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'invite revoked';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite expired';
  end if;

  insert into public.calendar_members (calendar_id, user_id, role)
  values (v_invite.calendar_id, auth.uid(), v_invite.role)
  on conflict (calendar_id, user_id) do nothing;

  return query
    select c.id, c.name, m.role
    from public.calendars c
    join public.calendar_members m on m.calendar_id = c.id
    where c.id = v_invite.calendar_id and m.user_id = auth.uid();
end;
$$;

revoke all on function public.accept_calendar_invite(text) from public;
grant execute on function public.accept_calendar_invite(text) to authenticated;

-- verify: select proname, prosecdef from pg_proc where proname in
--   ('create_calendar_invite', 'revoke_calendar_invite', 'accept_calendar_invite', 'is_calendar_member');

-- ============================================================
-- 6. events（共有カレンダーの予定。端末内のみの個人予定はここに置かない）
-- ============================================================
create table if not exists public.events (
  -- クライアント側 generateId() は "evt_<timestamp36>_<random36>" 形式の非UUID文字列を
  -- 生成するため、id列はuuidではなくtextにする（0006_events_id_text.sql参照）。
  id text primary key,
  calendar_id uuid not null references public.calendars (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('normal', 'focus')),
  title text not null,
  date date not null,
  start_time text not null,
  end_time text,
  all_day boolean not null default false,
  location text,
  duration_minutes int,
  restricted_apps jsonb not null default '[]'::jsonb,
  unlock_condition jsonb,
  notification jsonb not null default '{"enabled": false, "minutesBefore": 0}'::jsonb,
  repeat jsonb not null default '{"type": "none"}'::jsonb,
  memo text,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists events_set_updated_at on public.events;
create trigger events_set_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

create index if not exists events_calendar_id_idx on public.events (calendar_id);

alter table public.events enable row level security;

create policy "events_select_members"
  on public.events for select
  using (public.is_calendar_member(calendar_id, 'viewer'));

create policy "events_insert_editor"
  on public.events for insert
  with check (public.is_calendar_member(calendar_id, 'editor') and created_by = auth.uid());

create policy "events_update_editor"
  on public.events for update
  using (public.is_calendar_member(calendar_id, 'editor'))
  with check (public.is_calendar_member(calendar_id, 'editor'));

create policy "events_delete_editor"
  on public.events for delete
  using (public.is_calendar_member(calendar_id, 'editor'));

-- verify: select * from pg_policies where tablename = 'events';
-- verify: select relname, relrowsecurity from pg_class
--   where relname in ('profiles','calendars','calendar_members','calendar_invites','events');

-- ============================================================
-- 7. Realtime: events テーブルの変更を配信対象にする
-- ============================================================
alter publication supabase_realtime add table public.events;
