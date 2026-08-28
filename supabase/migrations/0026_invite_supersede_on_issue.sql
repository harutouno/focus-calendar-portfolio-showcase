-- ============================================================
-- 0026_invite_supersede_on_issue.sql
-- CORRECT-F024-001 (P2) — SUPERSEDE_ON_ISSUE
-- ============================================================
-- 【解決する問題】
--   create_calendar_invite は呼ばれるたびに fresh token を生成して無条件に INSERT する。
--   calendar_invites の UNIQUE は token_hash のみで、同一宛先に対する一意性は無い。
--   したがって
--       server commit -> 応答喪失 -> client は UNKNOWN -> ユーザーが再試行
--   あるいは同一フレーム二度押しで、**同時に有効な invite authority が複数**生まれる。
--   0018 の count_effective_shared_calendar_members は「未取消・未拒否・未承認・未期限切れ」の
--   pending invite を人数枠として数えるため、この重複は
--   **誰も保持していない dead token が所有者の人数枠を食い潰す**という形で顕在化し、
--   最終的に正当な招待が shared_calendar_member_limit_exceeded で拒否されうる。
--
-- 【採らない方針】
--   「再試行時に同じ token を返す」形の冪等化は**実装しない**。
--   本システムは生 token を保存せず token_hash のみを保持する設計であり
--   （0001 で確立、0010/0018 でも維持）、これはセキュリティ上正しい。
--   同じ token を返すには生 token の保存が必要になるため、この設計は崩さない。
--
-- 【採る方針: SUPERSEDE_ON_ISSUE】
--   新しい invite を発行する際、同一の発行スコープに属する「現在有効な」invite を
--   先に revoked_at で無効化してから、fresh token を 1 件だけ INSERT する。
--   結果として同一スコープの active authority は常に高々 1 件へ収束する。
--
-- 【直列化 — 新しいロックを作らない】
--   0018 が既に create_calendar_invite / enforce_shared_calendar_member_limit の双方で
--       pg_advisory_xact_lock(hashtext(<calendar_id>::text))
--   を取得しており、「招待発行・招待承認・直接INSERTの全経路が同じロックキーを使うため
--   ロック順序は常に単一」と明記している。
--   本migrationは**その既存キーをそのまま流用**し、supersede をロック取得後に置く。
--   新しいロック対象・逆順ロックは一切導入しない（デッドロック順序を変えない）。
--
-- 【順序が重要】
--   supersede は人数カウントより**前**に行う。
--   count_effective_shared_calendar_members は revoked_at is null の行だけを数えるため、
--   先に supersede することで解放された枠が正しくカウントへ反映される。
--   逆順にすると、自分が今から置き換える古い招待によって自分自身が上限拒否されうる。
--
-- 【supersede スコープ — TARGETED / GENERIC のハイブリッド】
--   単純な「calendar + role」も「calendar + role + invitee_email」も、どちらも不正解である。
--
--   (a) calendar + role だけにすると:
--         alice を editor として招待 -> bob を editor として招待
--       で alice のリンクが巻き添え失効し、**正当な同時招待を破壊する**
--       （0010 が invitee_email 列と宛先別受信箱 fetch_my_pending_invites を導入しており、
--         同一 role で異なる宛先へ出す運用は product として成立している）。
--
--   (b) calendar + role + invitee_email にすると、逆に**権限の巻き戻しが残る**:
--         alice へ editor 招待 -> 後から alice へ viewer 招待
--       のとき role が違うため旧 editor 招待が supersede されず、
--       alice は古い editor token を使える。owner の最新意図は viewer なのに、
--       **古い credential が最新の role intent を上書きできる**。これは authority 欠陥であり、
--       単なる UX の問題ではない。
--
--   よって発行スコープを宛先の有無で分ける:
--
--     TARGETED（invitee_email IS NOT NULL）:
--       scope = (calendar_id, normalized invitee_email)   ※ role は key に含めない
--       -> 同一 recipient への以前の active invite は role を問わず supersede
--          （editor -> viewer の下げ直しで旧 editor token が残らない）
--
--     GENERIC（invitee_email IS NULL）:
--       scope = (calendar_id, role, invitee_email IS NULL)
--       -> generic editor link の再発行は古い generic editor だけを supersede
--          （generic viewer link とは併存できる）
--
--   正規化（nullif(lower(trim(...)))）は 1 回だけ行い、supersede と INSERT で同じ値を使う
--   （2 箇所で別々に正規化すると、突き合わせと保存がずれる）。
--
-- 【本migrationが証明しないこと】
--   静的な SQL 構造として supersede + 既存 serialization 契約が組み込まれたことのみを主張する。
--   実 PostgreSQL/Supabase 上で N 並行発行の結果 active invite authority が
--   ちょうど 1 件へ収束することは **REQUIRES_LIVE_DB_VALIDATION** であり、
--   本migrationは未適用（MIGRATION_APPLY = NO）である。
--
-- 依存: 0018（resolve_shared_calendar_member_limit / count_effective_shared_calendar_members /
--       同一 advisory lock キー）。0018 自体は編集しない。
-- ============================================================

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
  v_email text;
begin
  -- 既存の権限・入力検証（0010/0018 と同一。弱めない）。
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

  -- 正規化を supersede と INSERT で必ず同一にするため、先に一度だけ確定させる
  -- （0010/0018 は INSERT 内で nullif(lower(trim(...))) していた。同じ規則をここへ引き上げる）。
  v_email := nullif(lower(trim(p_invitee_email)), '');

  -- 0018 と同一のロックキー。新規ロックは導入しない。
  perform pg_advisory_xact_lock(hashtext(p_calendar_id::text));

  -- ── SUPERSEDE_ON_ISSUE ────────────────────────────────────
  -- 同一スコープの「現在有効な」招待を無効化する。述語は
  -- count_effective_shared_calendar_members の有効判定と厳密に一致させる
  -- （数える条件と潰す条件がずれると、枠の解放とカウントが食い違う）。
  update public.calendar_invites i
     set revoked_at = now()
   where i.calendar_id = p_calendar_id
     -- 「有効な pending invite」の定義は count 側と厳密に同一にする。
     and i.revoked_at is null
     and i.declined_at is null
     and i.accepted_at is null
     and i.expires_at > now()
     and (
       -- TARGETED: 宛先が同一なら role を問わず supersede する（role-independent）。
       -- これにより editor -> viewer の再発行で旧 editor token が生き残らない。
       (v_email is not null and i.invitee_email = v_email)
       or
       -- GENERIC: 宛先なしリンク同士は、同一 role のものだけを supersede する
       -- （generic editor link と generic viewer link は併存できる）。
       (v_email is null and i.invitee_email is null and i.role = p_role)
     );

  -- supersede 後にカウントする（解放された枠を反映させるため）。
  v_limit := public.resolve_shared_calendar_member_limit(v_owner_id);
  v_current := public.count_effective_shared_calendar_members(p_calendar_id);

  if v_current >= v_limit then
    raise exception 'shared_calendar_member_limit_exceeded';
  end if;

  -- 生 token は保存しない。token_hash のみを保持する（設計不変）。
  v_token := translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');
  v_expires := now() + make_interval(hours => p_expires_in_hours);

  insert into public.calendar_invites (calendar_id, role, token_hash, created_by, expires_at, invitee_email)
  values (
    p_calendar_id,
    p_role,
    encode(digest(v_token, 'sha256'), 'hex'),
    auth.uid(),
    v_expires,
    v_email
  )
  returning id into v_id;

  return query select v_id, v_token, v_expires;
end;
$$;

revoke all on function public.create_calendar_invite(uuid, text, int, text) from public;
grant execute on function public.create_calendar_invite(uuid, text, int, text) to authenticated;

-- verify（手動確認用。本batchでは実行しない）:
--   select proname, prosecdef from pg_proc where proname = 'create_calendar_invite';
--   -- supersede 後に同一スコープの active invite が 1 件であること:
--   select count(*) from public.calendar_invites
--    where calendar_id = '<id>' and role = 'editor' and invitee_email is null
--      and revoked_at is null and declined_at is null and accepted_at is null
--      and expires_at > now();
