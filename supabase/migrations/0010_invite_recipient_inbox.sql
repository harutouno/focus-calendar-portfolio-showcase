-- Stage 3: 招待に受信者（メールアドレス）を紐づけ、受信者本人が一覧・参加・拒否できるようにする
--
-- 背景:
--   これまでのcalendar_invitesは完全に匿名のトークン付きリンクで、「誰宛てか」を示す列が
--   一切無かった（生トークンはDBに保存されずtoken_hashのみ保持、RLSも「オーナーだけが
--   自分のカレンダーの招待一覧を見られる」ポリシーしか無い）。招待タブで「自分宛てに届いた
--   招待」を一覧表示・参加・拒否できるようにするには、招待に受信者を紐づける情報と、
--   受信者本人だけが認可される参加・拒否経路が必要になる。
--
-- 方針:
--   * このファイルは作成のみで、Supabaseへは適用しない（レビュー後にユーザー自身が実行する）。
--   * 既存のリンク発行・トークン生成の仕組み自体（create_calendar_invite/accept_calendar_invite/
--     revoke_calendar_invite、app/invite/[token].tsxのディープリンク受諾フロー）はそのまま残す。
--     invitee_emailは「任意の追加情報」であり、無指定の招待は従来どおりトークンリンクのみで
--     機能する（一覧には出ないだけで、リンクを開いての参加は今までどおり可能）。
--   * service_roleは一切使わない。受信者の識別はSupabase Authのauth.jwt()->>'email'を正本とする
--     （クライアントから送られたメールアドレス文字列を認可判定に使うことは無い）。
--
-- rollback時の注意:
--   * 3つの新規列（invitee_email/accepted_at/declined_at）はnullable・追加のみのため、
--     列を残したままrollbackしても既存機能への影響は無い。
--   * create_calendar_inviteは引数の数が変わる（3引数→4引数）ため、古い3引数版を明示的に
--     dropしてから作り直す。rollbackする場合は下記の4引数版をdropし、0001_init.sqlの
--     3引数版を再適用すること。
--   * 新設した3つのRPC（fetch_my_pending_invites/accept_calendar_invite_by_id/
--     decline_calendar_invite）をrollbackする場合は、対応するdrop functionを実行すればよい
--     （他のオブジェクトはこれらに依存していない）。

-- ============================================================
-- 1. calendar_invites へ列を追加（既存列は変更しない）
-- ============================================================
alter table public.calendar_invites
  add column if not exists invitee_email text,
  add column if not exists accepted_at timestamptz,
  add column if not exists declined_at timestamptz;

-- verify: select column_name from information_schema.columns
--   where table_name = 'calendar_invites'
--     and column_name in ('invitee_email', 'accepted_at', 'declined_at');

-- ============================================================
-- 2. create_calendar_invite: 任意のinvitee_email引数を追加
--    （既存の3引数呼び出しは新引数がデフォルトnullになるため挙動不変）
-- ============================================================
drop function if exists public.create_calendar_invite(uuid, text, int);

create or replace function public.create_calendar_invite(
  p_calendar_id uuid,
  p_role text,
  p_expires_in_hours int default 168,
  p_invitee_email text default null
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

  insert into public.calendar_invites (calendar_id, role, token_hash, created_by, expires_at, invitee_email)
  values (
    p_calendar_id,
    p_role,
    encode(digest(v_token, 'sha256'), 'hex'),
    auth.uid(),
    v_expires,
    nullif(lower(trim(p_invitee_email)), '')
  )
  returning id into v_id;

  return query select v_id, v_token, v_expires;
end;
$$;

revoke all on function public.create_calendar_invite(uuid, text, int, text) from public;
grant execute on function public.create_calendar_invite(uuid, text, int, text) to authenticated;

-- ============================================================
-- 3. fetch_my_pending_invites: 自分宛ての未処理招待一覧
--    「未処理（pending）」の判定はこのWHERE句だけが正本。一覧・バッジの両方がこの結果を
--    そのまま使う（別実装のフィルタを作らない）。期限切れは取得段階で除外する
--    （expires_at > nowの条件により、呼び出し側は期限切れ表示のUIを別途持つ必要が無い）。
-- ============================================================
create or replace function public.fetch_my_pending_invites()
returns table (
  invite_id uuid,
  calendar_id uuid,
  calendar_name text,
  calendar_color text,
  calendar_cover_image_url text,
  role text,
  created_at timestamptz,
  expires_at timestamptz,
  inviter_display_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    i.id,
    c.id,
    c.name,
    c.color,
    c.cover_image_url,
    i.role,
    i.created_at,
    i.expires_at,
    p.display_name
  from public.calendar_invites i
  join public.calendars c on c.id = i.calendar_id
  left join public.profiles p on p.id = i.created_by
  where i.invitee_email is not null
    and lower(i.invitee_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and i.revoked_at is null
    and i.declined_at is null
    and i.accepted_at is null
    and i.expires_at > now()
  order by i.created_at desc;
$$;

revoke all on function public.fetch_my_pending_invites() from public;
grant execute on function public.fetch_my_pending_invites() to authenticated;

-- verify: select proname from pg_proc where proname = 'fetch_my_pending_invites';

-- ============================================================
-- 4. accept_calendar_invite_by_id: 招待一覧（IDのみ保持、生トークンは持たない）からの参加
--    既存のaccept_calendar_invite(token)とは別ルート。認可はメールアドレス一致で行う
--    （クライアントの自己申告ではなく、常にauth.jwt()->>'email'を照合する）。
-- ============================================================
create or replace function public.accept_calendar_invite_by_id(p_invite_id uuid)
returns table (calendar_id uuid, calendar_name text, role text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite record;
  v_email text;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  select * into v_invite from public.calendar_invites where id = p_invite_id;

  if v_invite is null then
    raise exception 'invite not found';
  end if;
  if v_invite.invitee_email is null or lower(v_invite.invitee_email) != v_email then
    raise exception 'not authorized';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'invite revoked';
  end if;
  if v_invite.declined_at is not null then
    raise exception 'invite already declined';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invite already accepted';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite expired';
  end if;

  insert into public.calendar_members (calendar_id, user_id, role)
  values (v_invite.calendar_id, auth.uid(), v_invite.role)
  on conflict (calendar_id, user_id) do nothing;

  update public.calendar_invites set accepted_at = now() where id = p_invite_id;

  return query
    select c.id, c.name, m.role
    from public.calendars c
    join public.calendar_members m on m.calendar_id = c.id
    where c.id = v_invite.calendar_id and m.user_id = auth.uid();
end;
$$;

revoke all on function public.accept_calendar_invite_by_id(uuid) from public;
grant execute on function public.accept_calendar_invite_by_id(uuid) to authenticated;

-- ============================================================
-- 5. decline_calendar_invite: 招待の拒否（calendar_membersには一切触れない）
-- ============================================================
create or replace function public.decline_calendar_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite record;
  v_email text;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  select * into v_invite from public.calendar_invites where id = p_invite_id;

  if v_invite is null then
    raise exception 'invite not found';
  end if;
  if v_invite.invitee_email is null or lower(v_invite.invitee_email) != v_email then
    raise exception 'not authorized';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invite already accepted';
  end if;

  update public.calendar_invites set declined_at = now()
  where id = p_invite_id and declined_at is null;
end;
$$;

revoke all on function public.decline_calendar_invite(uuid) from public;
grant execute on function public.decline_calendar_invite(uuid) to authenticated;

-- verify: select proname from pg_proc
--   where proname in ('accept_calendar_invite_by_id', 'decline_calendar_invite');
