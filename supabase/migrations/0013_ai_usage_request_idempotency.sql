-- 単独修正(2026-08): requestIdのライフサイクル修正。
--
-- 背景: 0012のreserve_ai_usageは、既存のai_usage_requests行が見つかった場合を
-- 一律duplicate_requestとして拒否するだけで、「処理中」「確定済み（同じ回答を
-- 返せる）」「失敗して返却済み（安全に再試行可能）」を区別していなかった。
-- また、同じ新規requestIdが同時に2件届いた場合の原子性（存在チェックとINSERTの間の
-- 競合）にも穴があった。0012自体は編集せず、本migrationで対象関数を作り直す。

alter table public.ai_usage_requests
  add column if not exists request_hash text,
  add column if not exists response_payload jsonb,
  add column if not exists attempt_count int not null default 1,
  add column if not exists last_attempt_at timestamptz not null default now();

-- 利用枠を原子的に予約する。requestId単位の状態（reserved=処理中／confirmed=確定済み／
-- released=返却済みで再試行可能）に応じて正しく振る舞う。
--
-- 同時に同じ「新規」requestIdが複数届いた場合の原子性は、Edge Function側のメモリ上
-- フラグではなく、(user_id, request_id)の一意制約に対するinsert ... on conflict do
-- nothingで保証する（Postgresの行ロックにより、勝者は1つだけになる）。
drop function if exists public.reserve_ai_usage(text, int, int, int, date);

create or replace function public.reserve_ai_usage(
  p_request_id text,
  p_request_hash text,
  p_base_limit int,
  p_bonus_per_ad int,
  p_max_ad_bonuses int,
  p_usage_date date default null
)
returns table (
  allowed boolean,
  reason text,
  reservation_token uuid,
  used_count int,
  rewarded_ad_count int,
  daily_limit int,
  response_payload jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_date date;
  v_existing record;
  v_ads int;
  v_entitlement int;
  v_new_used int;
  v_token uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_request_id is null or length(p_request_id) = 0 then
    raise exception 'request_id is required';
  end if;

  v_date := public.clamp_ai_usage_date(p_usage_date);

  -- 1. 新規requestIdとしての原子的な行獲得を試みる（同時に同じ新規IDが2件届いても
  --    1件だけが成功する）。
  begin
    insert into public.ai_usage_requests
      (user_id, usage_date, request_id, request_hash, reservation_token, status,
       attempt_count, reserved_at, last_attempt_at)
    values (v_uid, v_date, p_request_id, p_request_hash, gen_random_uuid(), 'reserved',
            1, now(), now())
    returning ai_usage_requests.reservation_token into v_token;
  exception when unique_violation then
    v_token := null;
  end;

  if v_token is not null then
    perform public.ensure_ai_usage_daily_row(v_uid, v_date);
    select d.rewarded_ad_count into v_ads
      from public.ai_usage_daily d where d.user_id = v_uid and d.usage_date = v_date;
    v_entitlement := least(p_base_limit + v_ads * p_bonus_per_ad, p_base_limit + p_max_ad_bonuses * p_bonus_per_ad);

    update public.ai_usage_daily d
       set used_count = d.used_count + 1, updated_at = now()
     where d.user_id = v_uid and d.usage_date = v_date and d.used_count < v_entitlement
    returning d.used_count into v_new_used;

    if v_new_used is null then
      -- 上限到達。今作った予約行はreleasedへ戻し、将来released→reserved経路で再試行できるようにする。
      update public.ai_usage_requests
         set status = 'released', released_at = now()
       where user_id = v_uid and request_id = p_request_id;

      select d.used_count into v_new_used from public.ai_usage_daily d
       where d.user_id = v_uid and d.usage_date = v_date;
      allowed := false;
      reason := 'usage_limit_exceeded';
      reservation_token := null;
      response_payload := null;
      used_count := v_new_used;
      rewarded_ad_count := v_ads;
      daily_limit := v_entitlement;
      return next;
      return;
    end if;

    allowed := true;
    reason := null;
    reservation_token := v_token;
    used_count := v_new_used;
    rewarded_ad_count := v_ads;
    daily_limit := v_entitlement;
    response_payload := null;
    return next;
    return;
  end if;

  -- 2. 既存行がある（同じrequestIdの再送）。行ロックしてから状態ごとに分岐する。
  select * into v_existing from public.ai_usage_requests r
   where r.user_id = v_uid and r.request_id = p_request_id
   for update;

  select d.used_count, d.rewarded_ad_count into used_count, rewarded_ad_count
    from public.ai_usage_daily d where d.user_id = v_uid and d.usage_date = v_existing.usage_date;
  daily_limit := least(p_base_limit + coalesce(rewarded_ad_count, 0) * p_bonus_per_ad,
                        p_base_limit + p_max_ad_bonuses * p_bonus_per_ad);

  -- 同じrequestIdで異なる内容（kind/input）が届いた場合は常に拒否する。
  if v_existing.request_hash is not null and p_request_hash is not null
     and v_existing.request_hash <> p_request_hash then
    allowed := false;
    reason := 'content_mismatch';
    reservation_token := null;
    response_payload := null;
    return next;
    return;
  end if;

  if v_existing.status = 'reserved' then
    -- 別の呼び出し（またはこの依頼自体の前回試行）が処理中。新規消費・新規AI呼び出しはしない。
    allowed := false;
    reason := 'processing';
    reservation_token := null;
    response_payload := null;
    return next;
    return;
  end if;

  if v_existing.status = 'confirmed' then
    -- 既に成功済み。OpenAIを再実行せず、保存済みの同じ回答を返す。
    allowed := false;
    reason := 'already_confirmed';
    reservation_token := null;
    response_payload := v_existing.response_payload;
    return next;
    return;
  end if;

  -- status = 'released': 以前の試行が失敗し枠は返却済み。同じ行を再利用して再予約する。
  perform public.ensure_ai_usage_daily_row(v_uid, v_existing.usage_date);
  select d.rewarded_ad_count into v_ads from public.ai_usage_daily d
   where d.user_id = v_uid and d.usage_date = v_existing.usage_date;
  v_entitlement := least(p_base_limit + v_ads * p_bonus_per_ad, p_base_limit + p_max_ad_bonuses * p_bonus_per_ad);

  update public.ai_usage_daily d
     set used_count = d.used_count + 1, updated_at = now()
   where d.user_id = v_uid and d.usage_date = v_existing.usage_date and d.used_count < v_entitlement
  returning d.used_count into v_new_used;

  if v_new_used is null then
    select d.used_count into v_new_used from public.ai_usage_daily d
     where d.user_id = v_uid and d.usage_date = v_existing.usage_date;
    allowed := false;
    reason := 'usage_limit_exceeded';
    reservation_token := null;
    response_payload := null;
    used_count := v_new_used;
    rewarded_ad_count := v_ads;
    daily_limit := v_entitlement;
    return next;
    return;
  end if;

  v_token := gen_random_uuid();
  update public.ai_usage_requests
     set status = 'reserved',
         reservation_token = v_token,
         attempt_count = attempt_count + 1,
         last_attempt_at = now(),
         reserved_at = now(),
         confirmed_at = null,
         released_at = null,
         response_payload = null
   where user_id = v_uid and request_id = p_request_id;

  allowed := true;
  reason := null;
  reservation_token := v_token;
  used_count := v_new_used;
  rewarded_ad_count := v_ads;
  daily_limit := v_entitlement;
  response_payload := null;
  return next;
end;
$$;

revoke all on function public.reserve_ai_usage(text, text, int, int, int, date) from public;
grant execute on function public.reserve_ai_usage(text, text, int, int, int, date) to authenticated;

-- 予約を確定する。最終的にクライアントへ返した応答をresponse_payloadへ保存し、
-- 同じrequestIdが確定後に再送された場合に同じ回答を再返却できるようにする。
-- response_payloadにはクライアントへ返すAI応答のみを保存し、APIキー・
-- Authorizationヘッダー・reservation_token・内部エラー等は一切含めない
-- （呼び出し側であるhandler.tsがwireResponseだけを渡す設計とする）。
drop function if exists public.confirm_ai_usage(uuid);

create or replace function public.confirm_ai_usage(p_reservation_token uuid, p_response_payload jsonb)
returns table (ok boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update public.ai_usage_requests
     set status = 'confirmed', confirmed_at = now(), response_payload = p_response_payload
   where reservation_token = p_reservation_token
     and user_id = auth.uid()
     and status = 'reserved';

  ok := found;
  return next;
end;
$$;

revoke all on function public.confirm_ai_usage(uuid, jsonb) from public;
grant execute on function public.confirm_ai_usage(uuid, jsonb) to authenticated;

-- 保持期間について: response_payload等を含むai_usage_requests行の自動期限切れ削除
-- （pg_cron等）は本修正のスコープ外のため未実装。行はai_usage_dailyと同じく無期限に
-- 残る。冪等再送に必要な情報として「行が存在する限り再返却可能」という設計であり、
-- 将来的には一定時間（例: 24〜48時間）経過後にresponse_payloadをnull化する等の
-- 定期処理を追加することが望ましい（完了報告に明記）。

-- verify: select column_name from information_schema.columns where table_name = 'ai_usage_requests';
-- verify: select proname, pronargs from pg_proc where proname in ('reserve_ai_usage','confirm_ai_usage');
