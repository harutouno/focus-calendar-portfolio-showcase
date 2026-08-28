-- P0182 / SEC-F025-001: 招待受信者（recipient）同定を fail-closed へ統一する
--
-- ============================================================================
-- 背景（現行ソースで確認した事実。歴史ではなく実バイトから）
-- ============================================================================
--
-- recipient 同定は現在 4 か所にあり、**1 か所だけが fail-closed、3 か所が fail-open**
-- という割れた状態にある。
--
--   0011 can_read_pending_invite_calendar_cover  … 正しい
--       v_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
--       if v_email = '' then return false; end if;          ← 空で閉じる
--       ... and lower(trim(ci.invitee_email)) = v_email      ← 両側 trim
--
--   0010 fetch_my_pending_invites                … fail-open
--   0010 decline_calendar_invite                 … fail-open
--   0020 accept_calendar_invite_by_id（現行権威）… fail-open
--       いずれも lower(coalesce(auth.jwt()->>'email','')) を比較値にし、
--       空文字ガードが無く、保存側に trim を掛けない。
--
-- 【到達可能性】「invitee_email = '' の行は作れない」は成り立たない。
-- 発行 RPC（0010/0018/0020/0026/0027）は nullif(lower(trim(...)), '') で正規化するが、
-- **RPC は唯一の書き込み経路ではない**。0001 で作られ 0020 で強化された RLS ポリシー
--   invites_insert_owner / invites_update_owner
-- は invitee_email に一切制約を課しておらず、テーブルにも CHECK 制約が無い。
-- migration 全走査の結果、public スキーマのテーブル権限を REVOKE している箇所も無いため、
-- `authenticated` ロールは Supabase 既定の table GRANT を保持している。
-- すなわち **通常権限のカレンダー所有者が PostgREST 直 INSERT/UPDATE で
-- invitee_email = '' の行を作れる**（service_role も手動 DB 操作も不要）。
--
-- その行と「JWT に email claim を持たない呼び出し元」が揃うと
--   '' = ''  ⇒ TRUE
-- となり、無関係なカレンダーの招待が受信箱に出て、参加・拒否まで通ってしまう。
--
-- ============================================================================
-- 本 migration の射程（意図的に狭い）
-- ============================================================================
--
-- 変えるのは **RECIPIENT_IDENTITY_AUTHORITY だけ**である。
--
--   固定する不変条件:
--     CURRENT_NORMALIZED_EMAIL = NULL
--       => recipient-authorized operation 不可
--
--   正規化契約（比較の両側で同一）:
--     JWT email        -> trim -> lower -> 空なら NULL -> NULL なら fail closed
--     stored invitee_email -> trim -> lower -> 空なら NULL -> recipient として不成立
--
-- **変えないもの（F026/F027 の product/security semantics）**:
--   * accepted_at / declined_at / revoked_at / expires_at の意味論と検査順序
--   * token 受諾経路（accept_calendar_invite(token)）の bearer semantics
--   * OBS-F024-004（bearer token 受諾が declined_at を by-id 経路と同じには扱わない件）
--     は P3 / DEFER_TO_F026_F027 のまま。本 migration は一切判断しない。
--   * pending-for-inbox と P0178 の token redeemability の区別（別概念のまま）
--
-- 適用しない（レビュー後にユーザー自身が実行する）。

-- ============================================================================
-- 1. 正規化ヘルパー（唯一の正本）
-- ============================================================================

-- 保存値・入力値の双方に使う。空/空白のみは「受信者として不成立」= NULL。
create or replace function public.normalize_invite_recipient_email(p_email text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(lower(trim(p_email)), '')
$$;

revoke all on function public.normalize_invite_recipient_email(text) from public;
grant execute on function public.normalize_invite_recipient_email(text) to authenticated;

-- 現在の呼び出し元の recipient identity。claim 欠落・空白のみは NULL を返す。
-- NULL を返したときは、いかなる recipient-authorized 操作も成立してはならない。
create or replace function public.current_recipient_email()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select public.normalize_invite_recipient_email(auth.jwt() ->> 'email')
$$;

revoke all on function public.current_recipient_email() from public;
grant execute on function public.current_recipient_email() to authenticated;

-- verify: select public.normalize_invite_recipient_email('  A@B.com ');  -- => a@b.com
-- verify: select public.normalize_invite_recipient_email('   ');         -- => NULL

-- ============================================================================
-- 2. fetch_my_pending_invites: 一覧の recipient 述語を fail-closed 化
--    pending 述語（revoked/declined/accepted/expires）は 0010 のまま 1 文字も変えない。
-- ============================================================================
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
  where public.current_recipient_email() is not null
    and public.normalize_invite_recipient_email(i.invitee_email) = public.current_recipient_email()
    and i.revoked_at is null
    and i.declined_at is null
    and i.accepted_at is null
    and i.expires_at > now()
  order by i.created_at desc;
$$;

revoke all on function public.fetch_my_pending_invites() from public;
grant execute on function public.fetch_my_pending_invites() to authenticated;

-- ============================================================================
-- 3. accept_calendar_invite_by_id: recipient guard のみ差し替え
--    0020 の barrier・検査順序・エラー文言はそのまま維持する。
-- ============================================================================
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
  perform public.assert_account_write_allowed(auth.uid());

  v_email := public.current_recipient_email();
  select * into v_invite from public.calendar_invites where id = p_invite_id;

  if v_invite is null then
    raise exception 'invite not found';
  end if;
  if v_email is null
     or public.normalize_invite_recipient_email(v_invite.invitee_email) is null
     or public.normalize_invite_recipient_email(v_invite.invitee_email) != v_email then
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

  update public.calendar_invites set accepted_at = now() where id = p_invite_id;

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

revoke all on function public.accept_calendar_invite_by_id(uuid) from public;
grant execute on function public.accept_calendar_invite_by_id(uuid) to authenticated;

-- ============================================================================
-- 4. decline_calendar_invite: recipient guard のみ差し替え
--    declined_at の意味論（accepted 済みは拒否できない等）は 0010 のまま。
-- ============================================================================
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
  v_email := public.current_recipient_email();
  select * into v_invite from public.calendar_invites where id = p_invite_id;

  if v_invite is null then
    raise exception 'invite not found';
  end if;
  if v_email is null
     or public.normalize_invite_recipient_email(v_invite.invitee_email) is null
     or public.normalize_invite_recipient_email(v_invite.invitee_email) != v_email then
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

-- ============================================================================
-- 5. defense-in-depth: 空文字 invitee_email 行の発生源を塞ぐ（NOT VALID）
-- ============================================================================
--
-- 【なぜ NOT VALID か】
-- 既存 production に dirty row（invitee_email = '' や空白のみ）が存在するかを
-- 本バッチは**確認できない**（live Supabase 接続なし）。VALIDATE を伴う CHECK は
-- 既存行を全走査するため、dirty row が 1 行でもあれば **migration 自体が適用不能**になる。
-- 「関数レベルの fail-closed」は §2-4 で既に必須要件として満たしているので、
-- この CHECK はあくまで **将来の書き込みに対する第 2 の防壁**である。
--
--   function-level fail closed = 必須（2-4 で達成済み）
--   blank-row prevention       = defense-in-depth（ここ）
--
-- NOT VALID は「以後の INSERT/UPDATE には効くが、既存行は検査しない」。
-- generic invite は invitee_email IS NULL なので、この制約に一切抵触しない。
alter table public.calendar_invites
  drop constraint if exists calendar_invites_invitee_email_not_blank;

alter table public.calendar_invites
  add constraint calendar_invites_invitee_email_not_blank
  check (invitee_email is null or trim(invitee_email) <> '')
  not valid;

-- 運用者向け（本 migration では実行しない）:
--   1) 既存 dirty row を調べる
--        select id, calendar_id, invitee_email from public.calendar_invites
--        where invitee_email is not null and trim(invitee_email) = '';
--   2) 0 件、もしくは NULL 化などで解消したあとに初めて:
--        alter table public.calendar_invites
--          validate constraint calendar_invites_invitee_email_not_blank;
--   VALIDATE は既存行を走査するため、1) を飛ばして実行してはならない。

-- verify: select conname, convalidated from pg_constraint
--   where conname = 'calendar_invites_invitee_email_not_blank';
-- verify: select proname from pg_proc
--   where proname in ('normalize_invite_recipient_email', 'current_recipient_email');
