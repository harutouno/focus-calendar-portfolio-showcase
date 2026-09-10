-- 単独修正(2026-08): FP-008「共有カレンダーのメンバー数上限を正式決定し、サーバー側で強制する」。
--
-- 正式決定（docs/free-premium-spec.md §4.4参照）:
--   * 無料所有者のカレンダー: 所有者を含めて最大5人
--   * プレミアム所有者のカレンダー: 所有者を含めて最大20人
--   * 適用されるプランは「操作している本人」ではなく「カレンダー所有者」のプラン
--   * 数える対象: 所有者(1人、calendar_membersのowner行の有無に関わらず常に1人として数える)
--     + editor/viewerとして参加済みのcalendar_members行 + まだ有効な承認待ちcalendar_invites行
--   * 数えない対象: 拒否済み・取消済み・期限切れ・（既に承認済みで参加行へ変換済みの）招待、
--     脱退済み・削除済みメンバー
--
-- 背景（実装前調査で確認した事実）:
--   * calendar_members（0001）: PK(calendar_id, user_id)、role in ('owner','editor','viewer')。
--     所有者はcalendars作成時のon_calendar_createdトリガー（handle_new_calendar、0001）で
--     自動的にrole='owner'の行として登録される。
--   * calendar_invites（0001, 0010で列追加）: revoked_at（取消, 0001）・invitee_email/
--     accepted_at/declined_at（受信者紐付け・承認・拒否、0010）を持つ。「未処理(pending)」の
--     判定はfetch_my_pending_invites（0010）のWHERE句が正本: revoked_at is null and
--     declined_at is null and accepted_at is null and expires_at > now()。本migrationの
--     人数集計もこれと完全に同じ条件を使う（別の判定基準を作らない）。
--   * 招待の発行/失効/参加経路: create_calendar_invite（0001→0010で4引数化）、
--     revoke_calendar_invite（0001）、accept_calendar_invite（token、0001）、
--     accept_calendar_invite_by_id（招待ID、0010）、decline_calendar_invite（0010）。
--   * 重要な既存の欠落: accept_calendar_invite（token版、0001）は参加成功時に
--     calendar_membersへINSERTするだけで、calendar_invites.accepted_atを一切更新して
--     いなかった（accepted_atはaccept_calendar_invite_by_id専用の列として0010で
--     追加されたため）。これを直さないと、token版で参加が成立した招待が
--     「まだ未処理(pending)」として数え続けられ、既に実メンバーになった人物を
--     招待1件分＋メンバー1人分の二重計上にしてしまう。本migrationのaccept_calendar_invite
--     再定義でこの欠落を修正する（他の検証ロジック・トークン照合方式は一切変更しない）。
--   * calendar_membersへの直接INSERT経路: 既存RLS "members_insert_owner_or_self_via_rpc"
--     （0001）はowner本人にのみinsertを許可している（`with check
--     (is_calendar_member(calendar_id, 'owner'))`）。つまりRPCを経由しない直接INSERTの
--     悪用経路は「オーナーが招待フローを介さず任意のuser_idを直接メンバーとして追加する」
--     ケースに限られる。BEFORE INSERTトリガーで、この経路も含めてINSERT全経路を一律に
--     防御対象にする。
--   * 同時実行対策の前例: 0016/0017と同じくpg_advisory_xact_lock(hashtext(...))方式を使う。
--     本migrationでは対象カレンダーのメンバー枠を扱うため、ロックキーはowner_idではなく
--     calendar_id単位にする（招待発行・招待承認・直接INSERTのすべてで同じ
--     hashtext(calendar_id::text)を使い、ロック順序を単一に保ってデッドロックを避ける）。
--   * is_premium_active_for(p_user_id)（0016で追加済み）をそのまま再利用する
--     （呼び出し本人ではなく指定した所有者のプランを判定する内部専用関数、
--     一般ロールへは一切grantされていない）。
--
-- 変更しないもの: 所有共有カレンダー数の上限（FP-003、0016）、マイカレンダー上限、
-- 同時表示5個、owner/editor/viewerの既存権限、owner_id変更禁止（0016）、
-- 画像上限（0017）、AI・広告・集中分析・CSV・購入処理。0001〜0017は無編集。
--
-- 適用順: 0012 → 0013 → 0014 → 0015 → 0016 → 0017 → 0018。0018はai_usage_*・
-- event_attachments*のいずれにも触れないため、Edge Function再デプロイは不要。
-- このファイルは作成のみで、実環境へは適用しない（レビュー後にユーザー自身が実行する）。

-- ============================================================
-- 1. calendar_invites.calendar_id への索引（既存に無かったため追加）
-- ============================================================
-- 人数集計（本migrationの複数の関数）がcalendar_idで頻繁に絞り込むため追加する。
-- calendar_membersは既にPK(calendar_id, user_id)の先頭列としてcalendar_idが
-- 索引化済みのため、そちらへの追加索引は不要。
create index if not exists calendar_invites_calendar_id_idx
  on public.calendar_invites (calendar_id);

-- ============================================================
-- 2. resolve_shared_calendar_member_limit(p_owner_id): 所有者プランからメンバー上限を決定
-- ============================================================
-- 内部専用（authenticatedへgrantしない）。is_premium_active_for自体が
-- 0016でrevoke all on ... from publicのみ（grant無し）だが、SECURITY DEFINER関数同士の
-- 内部呼び出しには影響しない（0017のresolve_owner_plan等と同じ既存の前例）。
create or replace function public.resolve_shared_calendar_member_limit(p_owner_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.is_premium_active_for(p_owner_id) then 20 else 5 end;
$$;

revoke all on function public.resolve_shared_calendar_member_limit(uuid) from public;

-- ============================================================
-- 3. count_effective_shared_calendar_members(p_calendar_id): 現在の「使用枠」数
-- ============================================================
-- 所有者(1人)は、calendar_membersにowner行が実在するかどうかに関わらず常に1人として
-- 数える（二重計上を避けるため、calendar_membersのrole='owner'行はここでは一切数えない）。
-- 参加済みeditor/viewerは実際の行数をそのまま数える。承認待ち招待は
-- fetch_my_pending_invites（0010）と全く同じ条件（未取消・未拒否・未承認・未期限切れ）の
-- 行数を数える。内部専用（authenticatedへgrantしない）。
create or replace function public.count_effective_shared_calendar_members(p_calendar_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    1
    + (
        select count(*)::int from public.calendar_members m
        where m.calendar_id = p_calendar_id
          and m.role in ('editor', 'viewer')
      )
    + (
        select count(*)::int from public.calendar_invites i
        where i.calendar_id = p_calendar_id
          and i.revoked_at is null
          and i.declined_at is null
          and i.accepted_at is null
          and i.expires_at > now()
      );
$$;

revoke all on function public.count_effective_shared_calendar_members(uuid) from public;

-- ============================================================
-- 4. enforce_shared_calendar_member_limit(): calendar_members BEFORE INSERTトリガー
-- ============================================================
-- calendar_membersへの新規行INSERT全経路（accept_calendar_invite/
-- accept_calendar_invite_by_id/オーナーによる直接INSERT）に対する最終防衛線。
-- role='owner'の行（カレンダー作成時に一度だけ自動生成される）は対象外にする
-- （所有者は count_effective_shared_calendar_members 側で常に+1として数えるため、
-- ここでさらに枠を消費させると二重に厳しくなってしまう）。
-- 既に同じ(calendar_id, user_id)の行が存在する場合（ON CONFLICT DO NOTHINGで
-- 冪等になる再送・重複呼び出し）は、実際には枠を追加消費しないため上限チェックを
-- スキップする（招待を2回受諾しようとした場合等の誤ブロックを防ぐ）。
create or replace function public.enforce_shared_calendar_member_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_limit int;
  v_current int;
begin
  if new.role = 'owner' then
    return new;
  end if;

  if exists (
    select 1 from public.calendar_members m
    where m.calendar_id = new.calendar_id and m.user_id = new.user_id
  ) then
    return new;
  end if;

  select c.owner_id into v_owner_id
    from public.calendars c
    where c.id = new.calendar_id;

  if v_owner_id is null then
    raise exception 'calendar_not_found';
  end if;

  -- カレンダー単位で直列化してから数え直す（招待発行・招待承認・直接INSERTの
  -- 全経路が同じロックキーhashtext(calendar_id::text)を使うため、ロック順序は
  -- 常に単一でデッドロックの心配はない）。
  perform pg_advisory_xact_lock(hashtext(new.calendar_id::text));

  v_limit := public.resolve_shared_calendar_member_limit(v_owner_id);
  v_current := public.count_effective_shared_calendar_members(new.calendar_id);

  if v_current >= v_limit then
    raise exception 'shared_calendar_member_limit_exceeded';
  end if;

  return new;
end;
$$;

drop trigger if exists calendar_members_enforce_limit_insert on public.calendar_members;
create trigger calendar_members_enforce_limit_insert
  before insert on public.calendar_members
  for each row execute function public.enforce_shared_calendar_member_limit();

-- ============================================================
-- 5. create_calendar_invite: 新規招待発行・再発行時の上限チェックを追加
-- ============================================================
-- 引数シグネチャ（4引数、0010で確定済み）は変更しない。既存のowner権限チェック・
-- role検証・トークン生成・invitee_email正規化はすべてそのまま維持し、
-- 「INSERT直前」にカレンダー単位のロック＋人数チェックを追加するだけ。
-- 「既存招待の再発行」はクライアント側（settings.tsxのensureViewerLink等）が
-- 既存招待をrevoke_calendar_invite後にcreate_calendar_inviteを呼ぶ実装のため、
-- 別関数を用意する必要はなく、本関数のチェックがそのまま両方をカバーする。
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
  v_owner_id uuid;
  v_limit int;
  v_current int;
begin
  if not public.is_calendar_member(p_calendar_id, 'owner') then
    raise exception 'not authorized';
  end if;
  if p_role not in ('editor', 'viewer') then
    raise exception 'invalid role';
  end if;

  select c.owner_id into v_owner_id from public.calendars c where c.id = p_calendar_id;
  if v_owner_id is null then
    raise exception 'calendar_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_calendar_id::text));

  v_limit := public.resolve_shared_calendar_member_limit(v_owner_id);
  v_current := public.count_effective_shared_calendar_members(p_calendar_id);

  if v_current >= v_limit then
    raise exception 'shared_calendar_member_limit_exceeded';
  end if;

  v_token := encode(gen_random_bytes(24), 'base64url');
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
-- 6. accept_calendar_invite（token版）: accepted_atの欠落を修正
-- ============================================================
-- 既存の検証（招待の存在・取消・期限切れ）はすべてそのまま維持する。
-- 変更点は次の2つのみ:
--   (a) calendar_membersへのINSERTより前にaccepted_atを確定させる。これにより
--       count_effective_shared_calendar_members()がこの招待自身を「まだ未処理」として
--       二重計上しない（招待→メンバーへの変換であり、新規に枠を1つ追加消費するわけ
--       ではないため）。上限超過でトリガーが例外を送出した場合、この更新を含む
--       トランザクション全体がロールバックされ、招待は未参加(pending)のまま残る
--       （枠が空き次第、再度参加を試みられる）。
--   (b) このtoken版はrevoked_at/expires_atしか見ておらず、複数人が同じリンクで
--       参加できる仕様（招待作成時にinvitee_emailを指定しない汎用リンク）を維持する
--       ため、accepted_atが既に立っていても後続の参加者をここではブロックしない
--       （ブロックすると1人目が参加した時点で汎用リンクが機能しなくなってしまう）。
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

  update public.calendar_invites set accepted_at = now()
  where id = v_invite.id and accepted_at is null;

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

-- ============================================================
-- 7. accept_calendar_invite_by_id: accepted_at確定の順序をINSERTより前へ変更
-- ============================================================
-- 既存の検証（メールアドレス一致・取消/拒否/承認済み/期限切れ）は一切変更しない。
-- 変更点はaccepted_at更新とcalendar_members INSERTの順序を入れ替えるだけ
-- （理由は6節と同じ: 上限判定がこの招待自身を二重計上しないようにするため）。
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

-- ============================================================
-- 8. get_shared_calendar_member_limit_status(): クライアント表示用の安全な状態取得RPC
-- ============================================================
-- クライアント（settings.tsx/invite.tsx）が「現在何人使っているか・上限は何人か・
-- あと何人招待できるか・上限に達しているか」を、所有者の資格詳細を一切見せずに
-- 取得するためのRPC。get_attachment_quota_status（0017）と同じ設計方針:
-- 呼び出し本人がそのカレンダーのメンバーでない場合はcalendar_not_found例外にする
-- （メンバー外であることと存在しないことを区別しない＝アクセス可否の情報を漏らさない）。
-- current_member_count/active_invite_countはused_slot_count
-- （=count_effective_shared_calendar_members、強制ロジックと必ず同じ値）から
-- 逆算することで、表示側と強制側の数値が常に一致することを保証する
-- （calendar_membersを別途素朴にcount(*)すると、万一owner行が実在しない状態が
-- 生じた場合に強制側の「常に+1」の考え方とズレる可能性があるため、あえて避ける）。
create or replace function public.get_shared_calendar_member_limit_status(p_calendar_id uuid)
returns table (
  member_limit int,
  current_member_count int,
  active_invite_count int,
  used_slot_count int,
  remaining_slots int,
  limit_reached boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_limit int;
  v_invite_count int;
  v_used int;
begin
  if not public.is_calendar_member(p_calendar_id, 'viewer') then
    raise exception 'calendar_not_found';
  end if;

  select c.owner_id into v_owner_id from public.calendars c where c.id = p_calendar_id;
  if v_owner_id is null then
    raise exception 'calendar_not_found';
  end if;

  v_limit := public.resolve_shared_calendar_member_limit(v_owner_id);
  v_used := public.count_effective_shared_calendar_members(p_calendar_id);

  select count(*)::int into v_invite_count
    from public.calendar_invites i
    where i.calendar_id = p_calendar_id
      and i.revoked_at is null
      and i.declined_at is null
      and i.accepted_at is null
      and i.expires_at > now();

  return query select
    v_limit,
    v_used - v_invite_count,
    v_invite_count,
    v_used,
    greatest(v_limit - v_used, 0),
    v_used >= v_limit;
end;
$$;

revoke all on function public.get_shared_calendar_member_limit_status(uuid) from public;
grant execute on function public.get_shared_calendar_member_limit_status(uuid) to authenticated;

-- ============================================================
-- verify（適用後に手動で確認する。実行順序・UUIDは環境に合わせて置き換えること）
-- ============================================================
-- verify (無料所有者のカレンダーで上限5・プレミアム所有者のカレンダーで上限20が
-- 返ることの確認):
-- select public.resolve_shared_calendar_member_limit('<free-owner-uuid>');    -- 5を期待
-- select public.resolve_shared_calendar_member_limit('<premium-owner-uuid>'); -- 20を期待
--
-- verify (無料所有者のカレンダーで、所有者1人のみの状態からeditor/viewerを4人追加できる
-- ことの確認。5人目（合計6人目）の直接INSERTがshared_calendar_member_limit_exceededで
-- 拒否されることの確認):
-- insert into public.calendar_members (calendar_id, user_id, role)
--   values ('<free-owner-calendar-id>', '<6th-user-uuid>', 'viewer');
--
-- verify (有効な承認待ち招待も枠に含まれることの確認。所有者1人+editor/viewer3人+
-- 有効招待1件=5人分で、新規招待作成がshared_calendar_member_limit_exceededで
-- 拒否されることの確認):
-- select * from public.create_calendar_invite('<free-owner-calendar-id>', 'viewer');
--
-- verify (拒否・取消・期限切れの招待は枠に含まれないことの確認。上と同じカレンダーで
-- 該当招待をdecline_calendar_invite/revoke_calendar_invite後、または期限切れ後に
-- 新規招待作成が成功することの確認):
-- select public.decline_calendar_invite('<invite-id>'); -- 招待受信者本人のセッションで実行
-- select * from public.create_calendar_invite('<free-owner-calendar-id>', 'viewer'); -- 成功を期待
--
-- verify (get_shared_calendar_member_limit_statusが所有者の資格詳細を含まず、
-- 必要な6列だけを返すことの確認):
-- select * from public.get_shared_calendar_member_limit_status('<calendar-id>');
--
-- verify (無関係ユーザー・viewerロールのメンバーがcreate_calendar_invite/
-- 直接INSERTを行えないことの確認。既存のnot authorized / RLS拒否がそのまま働くこと):
-- select * from public.create_calendar_invite('<calendar-id-not-a-member>', 'viewer');
--
-- verify (owner_id変更禁止（0016）に回帰が無いことの確認):
-- update public.calendars set owner_id = '<other-user-uuid>' where id = '<calendar-id>';
--
-- verify (一般ロールが内部関数を直接実行できないことの確認):
-- select grantee, privilege_type from information_schema.routine_privileges
--   where routine_name in (
--     'resolve_shared_calendar_member_limit',
--     'count_effective_shared_calendar_members'
--   );
--
-- verify (トリガーが登録されていることの確認):
-- select tgname from pg_trigger where tgrelid = 'public.calendar_members'::regclass and not tgisinternal;
