-- ============================================================
-- 0027_invite_supersede_redeemable_authority.sql
-- CORRECT-F024-003 (P2) — supersede 選択の権威を REDEEMABILITY にする
-- ============================================================
-- 【解決する問題】
--   0026 は supersede の述語に、0018 の**人数枠カウント述語をそのままコピー**していた:
--
--       revoked_at is null and declined_at is null and accepted_at is null
--       and expires_at > now()
--
--   しかし token 受諾の権威は **0020 G2 の accept_calendar_invite(p_token)**
--   （これが最後の置換であり現行契約）
--   であり、そこが実際に拒否するのは次の 3 つだけである:
--
--       行が無い / revoked_at is not null / expires_at < now()
--
--   `accepted_at` は拒否条件ではない——`update ... set accepted_at = now()
--   where id = ... and accepted_at is null` で**初回受諾時刻を記録するだけ**であり、
--   その後も同じ token で別のユーザーが参加できる。これは multi-user generic link を
--   意図的に支えている設計である。`declined_at` も token 経路では見ていない
--   （by_id 経路だけが declined を拒否する）。
--
--   したがって 0026 のもとでは次が成立する:
--
--       generic viewer A を発行 -> 誰かが A を受諾 -> A.accepted_at != NULL
--         -> A は依然 redeemable（誰でも参加できる）
--       owner が generic viewer B を再発行
--         -> 0026 は accepted_at が NULL でない A を supersede 対象から外す
--         -> B を INSERT
--       => A と B が**同時に redeemable**
--
--   逐次操作のみで成立し、live concurrency は不要である。
--   「再発行したのだから古いリンクは無効になったはず」という owner の意図が破られる。
--
-- 【採らない方針】
--   count_effective_shared_calendar_members を書き換えて述語を機械的に一致させることは
--   **しない**。人数枠カウントと token 引き換え可能性は**別の概念**であり、
--   一致させるべきものではない。受諾済み invite が枠を消費しないのは正しい
--   （その人は既に calendar_members に居るので二重計上になる）。
--
-- 【採る方針】
--   supersede の選択を **REDEEMABLE_TOKEN_AUTHORITY** から定義する:
--
--       revoked_at is null AND expires_at > now()      ← まだ引き換えられる
--
--   accepted_at / declined_at は supersede の除外条件にしない。
--   除外すると「まだ使える古い権威」が新しい発行を生き延びてしまう。
--
--   supersede 述語と count 述語は**意図的に文字一致しない**。
--   これは不整合ではなく、2 つの異なる概念を別々にモデル化した結果である:
--
--       PENDING_FOR_SLOT_COUNT     … 枠を消費するか（0018 の count が権威）
--       REDEEMABLE_TOKEN_AUTHORITY … token がまだ使えるか（0020 G2 が権威）
--
-- 【順序】0026 から不変:
--       lock -> normalize -> supersede(redeemable) -> count -> limit -> fresh insert
--   supersede を count より前に置くのは、解放された枠を計数へ反映させるためである。
--
-- 【スコープ】0026 の TARGETED / GENERIC ハイブリッドを不変で維持する
--   （P0174 で設計採用、P0175 で独立受理済み）:
--
--     TARGETED（invitee_email IS NOT NULL）:
--       scope = (calendar_id, normalized invitee_email)  ※ role は key に含めない
--     GENERIC（invitee_email IS NULL）:
--       scope = (calendar_id, role, invitee_email IS NULL)
--
-- 【0026 は書き換えない】
--   本リポジトリの migration は append-only 方針である。0026 のバイト列は歴史として
--   そのまま残し、0027 が create or replace で同じ RPC を上書きする。
--
-- 【本migrationが証明しないこと】
--   静的な SQL 構造として supersede 選択が redeemability に基づくことのみを主張する。
--   実 PostgreSQL/Supabase 上での N 並行発行の収束は **REQUIRES_LIVE_DB_VALIDATION**
--   であり、本migrationは未適用（MIGRATION_APPLY = NO）である。
--
-- 依存: 0018（resolve_shared_calendar_member_limit / count_effective_shared_calendar_members /
--       同一 advisory lock キー）、0020 G2（token 受諾の現行契約）。いずれも編集しない。
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
  -- 既存の権限・入力検証（0010/0018/0026 と同一。弱めない）。
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

  -- 正規化を supersede と INSERT で必ず同一にするため、先に一度だけ確定させる。
  v_email := nullif(lower(trim(p_invitee_email)), '');

  -- 0018 と同一のロックキー。新規ロック・逆順ロックは導入しない。
  perform pg_advisory_xact_lock(hashtext(p_calendar_id::text));

  -- ── SUPERSEDE — REDEEMABLE 権威を対象にする（0026 からの是正点）────────
  --
  -- 判定基準は **token 受諾経路（0020 G2）がまだ受け入れる行かどうか**であり、
  -- 人数枠を消費するかどうかではない。よって accepted_at / declined_at は見ない。
  update public.calendar_invites i
     set revoked_at = now()
   where i.calendar_id = p_calendar_id
     -- REDEEMABLE_TOKEN_AUTHORITY: 0020 G2 が拒否しない条件と厳密に一致させる。
     and i.revoked_at is null
     and i.expires_at > now()
     and (
       -- TARGETED: 宛先が同一なら role を問わず supersede（role-independent）。
       (v_email is not null and i.invitee_email = v_email)
       or
       -- GENERIC: 宛先なしリンク同士は同一 role のものだけを supersede。
       (v_email is null and i.invitee_email is null and i.role = p_role)
     );

  -- supersede 後にカウントする（解放された枠を反映させるため）。
  -- **count 側の述語は 0018 のまま変更しない**（枠の概念は redeemability と別物）。
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
--   -- 再発行後、同一スコープで **redeemable** な invite が 1 件であること
--   -- （accepted_at の有無は問わない点が 0026 との違い）:
--   select count(*) from public.calendar_invites
--    where calendar_id = '<id>' and role = 'viewer' and invitee_email is null
--      and revoked_at is null and expires_at > now();
