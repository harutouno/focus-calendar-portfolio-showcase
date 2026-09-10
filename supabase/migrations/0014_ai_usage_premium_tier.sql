-- 単独実装(2026-08): プレミアムAI「1日30回・月500回・広告不要」。
--
-- 背景: 無料版AI利用回数（3+広告3×2=最大9/日）はサーバー正本（0012/0013）で実装済みだが、
-- プレミアム/無料の分岐が一切存在しなかった。プレミアム状態は現状クライアント側
-- （AsyncStorage、LocalPremiumService）だけで管理されており、サーバー側に信頼できる
-- 購読・資格テーブルは存在しない。本migrationはサーバー側の最小限の資格テーブルを新設し、
-- それを正本としてAI利用回数RPCへプレミアム分岐を追加する。実際のストア課金・レシート
-- 検証は対象外（別工程、資格は管理者SQL/service_role経由でのみ付与できる状態にする）。
--
-- 0012・0013は無編集。適用順は 0012 → 0013 → 0014 → Edge Function再デプロイ。

-- ============================================================
-- 1. サーバー側の信頼できるプレミアム資格テーブル
-- ============================================================
create table if not exists public.user_entitlements (
  user_id uuid not null references auth.users (id) on delete cascade,
  entitlement_key text not null,
  status text not null check (status in ('active', 'revoked', 'expired')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entitlement_key)
);

alter table public.user_entitlements enable row level security;

-- 自分の資格のみ閲覧可能。INSERT/UPDATE/DELETEのポリシーは意図的に作らない
-- （0001/0005/0012と同じ流儀：ポリシーが無ければRLS配下でauthenticatedからの
-- 書き込みは暗黙に拒否される）。書き込みはSupabase Studio（postgresロール）または
-- 将来の購入検証処理（service_role）からのみ行う。アプリへservice_roleキーは入れない。
create policy "user_entitlements_select_own"
  on public.user_entitlements for select
  using (user_id = auth.uid());

-- 内部専用（authenticatedへgrantしない、他のSECURITY DEFINER関数からのみ呼ぶ）。
create or replace function public.is_premium_active()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_entitlements e
    where e.user_id = auth.uid()
      and e.entitlement_key = 'premium'
      and e.status = 'active'
      and e.starts_at <= now()
      and (e.expires_at is null or e.expires_at > now())
  );
$$;

-- verify (テスト用資格の付与例。一般ユーザーは実行できない。管理者/service_roleのみ):
-- insert into public.user_entitlements (user_id, entitlement_key, status, source)
--   values ('<test-user-uuid>', 'premium', 'active', 'manual_test');

-- ============================================================
-- 2. プレミアム月次利用バケット（無料版利用はここに加算しない）
-- ============================================================
create table if not exists public.ai_usage_monthly (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_month date not null,
  premium_used_count int not null default 0 check (premium_used_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_month)
);

alter table public.ai_usage_monthly enable row level security;

create policy "ai_usage_monthly_select_own"
  on public.ai_usage_monthly for select
  using (user_id = auth.uid());

create or replace function public.ensure_ai_usage_monthly_row(p_user_id uuid, p_usage_month date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.ai_usage_monthly (user_id, usage_month, premium_used_count)
  values (p_user_id, p_usage_month, 0)
  on conflict (user_id, usage_month) do nothing;
end;
$$;

revoke all on function public.ensure_ai_usage_monthly_row(uuid, date) from public;

-- ============================================================
-- 3. ai_usage_requestsへ予約時プランの記録用列を追加
-- ============================================================
alter table public.ai_usage_requests
  add column if not exists reserved_plan text check (reserved_plan in ('free', 'premium')),
  add column if not exists usage_month date,
  add column if not exists monthly_counted boolean not null default false;

-- ============================================================
-- 4. 原子的な予約ヘルパー（内部専用）。
--    daily行を原子的UPDATEでガード付き+1し、プレミアムならmonthly行も同様に+1する。
--    月次が上限到達なら、直前に加算したdailyを-1で巻き戻してから失敗を返す
--    （日次だけ加算されて月次で失敗する状態を作らない）。
-- ============================================================
create or replace function public._reserve_usage_slot(
  p_user_id uuid,
  p_usage_date date,
  p_usage_month date,
  p_plan text,
  p_free_base_limit int,
  p_free_bonus_per_ad int,
  p_free_max_ad_bonuses int,
  p_premium_daily_limit int,
  p_premium_monthly_limit int
)
returns table (ok boolean, reason text, new_daily int, new_monthly int, counted_monthly boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ads int;
  v_entitlement int;
  v_new_daily int;
  v_new_monthly int;
begin
  perform public.ensure_ai_usage_daily_row(p_user_id, p_usage_date);

  if p_plan = 'premium' then
    perform public.ensure_ai_usage_monthly_row(p_user_id, p_usage_month);

    update public.ai_usage_daily d
       set used_count = d.used_count + 1, updated_at = now()
     where d.user_id = p_user_id and d.usage_date = p_usage_date and d.used_count < p_premium_daily_limit
    returning d.used_count into v_new_daily;

    if v_new_daily is null then
      ok := false;
      reason := 'premium_daily_limit_exceeded';
      return next;
      return;
    end if;

    update public.ai_usage_monthly m
       set premium_used_count = m.premium_used_count + 1, updated_at = now()
     where m.user_id = p_user_id and m.usage_month = p_usage_month
       and m.premium_used_count < p_premium_monthly_limit
    returning m.premium_used_count into v_new_monthly;

    if v_new_monthly is null then
      -- 月次上限到達。直前に加算したdailyを巻き戻す（部分的な加算を残さない）。
      update public.ai_usage_daily d
         set used_count = greatest(d.used_count - 1, 0), updated_at = now()
       where d.user_id = p_user_id and d.usage_date = p_usage_date;
      ok := false;
      reason := 'premium_monthly_limit_exceeded';
      return next;
      return;
    end if;

    ok := true;
    reason := null;
    new_daily := v_new_daily;
    new_monthly := v_new_monthly;
    counted_monthly := true;
    return next;
    return;
  end if;

  -- 無料版: 既存仕様（0012/0013）のまま。dailyEntitlement = min(9, 3 + 広告数*3)。
  select d.rewarded_ad_count into v_ads
    from public.ai_usage_daily d
   where d.user_id = p_user_id and d.usage_date = p_usage_date;

  v_entitlement := least(
    p_free_base_limit + coalesce(v_ads, 0) * p_free_bonus_per_ad,
    p_free_base_limit + p_free_max_ad_bonuses * p_free_bonus_per_ad
  );

  update public.ai_usage_daily d
     set used_count = d.used_count + 1, updated_at = now()
   where d.user_id = p_user_id and d.usage_date = p_usage_date and d.used_count < v_entitlement
  returning d.used_count into v_new_daily;

  if v_new_daily is null then
    ok := false;
    reason := 'free_daily_limit_exceeded';
    return next;
    return;
  end if;

  ok := true;
  reason := null;
  new_daily := v_new_daily;
  new_monthly := null;
  counted_monthly := false;
  return next;
end;
$$;

revoke all on function public._reserve_usage_slot(uuid, date, date, text, int, int, int, int, int) from public;

-- ============================================================
-- 5. reserve_ai_usageの全面書き換え（プラン分岐対応）
-- ============================================================
drop function if exists public.reserve_ai_usage(text, text, int, int, int, date);

create or replace function public.reserve_ai_usage(
  p_request_id text,
  p_request_hash text,
  p_free_base_limit int,
  p_free_bonus_per_ad int,
  p_free_max_ad_bonuses int,
  p_premium_daily_limit int,
  p_premium_monthly_limit int,
  p_usage_date date default null
)
returns table (
  allowed boolean,
  reason text,
  reservation_token uuid,
  plan text,
  used_count int,
  rewarded_ad_count int,
  daily_limit int,
  monthly_used int,
  monthly_limit int,
  response_payload jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_date date;
  v_month date;
  v_plan text;
  v_existing record;
  v_token uuid;
  v_slot record;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_request_id is null or length(p_request_id) = 0 then
    raise exception 'request_id is required';
  end if;

  v_date := public.clamp_ai_usage_date(p_usage_date);
  v_month := date_trunc('month', v_date)::date;
  v_plan := case when public.is_premium_active() then 'premium' else 'free' end;

  -- 1. 新規requestIdとしての原子的な行獲得を試みる（同時に同じ新規IDが2件届いても
  --    1件だけが成功する。insert...on conflict do nothingはPostgresの一意制約に
  --    基づく原子操作のため、Edge Function側のメモリ上フラグには依存しない）。
  begin
    insert into public.ai_usage_requests
      (user_id, usage_date, usage_month, request_id, request_hash, reservation_token, status,
       reserved_plan, monthly_counted, attempt_count, reserved_at, last_attempt_at)
    values (v_uid, v_date, v_month, p_request_id, p_request_hash, gen_random_uuid(), 'reserved',
            v_plan, false, 1, now(), now())
    returning ai_usage_requests.reservation_token into v_token;
  exception when unique_violation then
    v_token := null;
  end;

  if v_token is not null then
    select * into v_slot from public._reserve_usage_slot(
      v_uid, v_date, v_month, v_plan,
      p_free_base_limit, p_free_bonus_per_ad, p_free_max_ad_bonuses,
      p_premium_daily_limit, p_premium_monthly_limit
    );

    if not v_slot.ok then
      -- 枠を確保できなかった予約行はreleasedへ戻す（released→reserved経路で再試行可能にする）。
      update public.ai_usage_requests
         set status = 'released', released_at = now()
       where user_id = v_uid and request_id = p_request_id;

      allowed := false;
      reason := v_slot.reason;
      reservation_token := null;
      plan := v_plan;
      response_payload := null;
      select d.used_count, d.rewarded_ad_count into used_count, rewarded_ad_count
        from public.ai_usage_daily d where d.user_id = v_uid and d.usage_date = v_date;
      if v_plan = 'premium' then
        daily_limit := p_premium_daily_limit;
        monthly_limit := p_premium_monthly_limit;
        select m.premium_used_count into monthly_used from public.ai_usage_monthly m
          where m.user_id = v_uid and m.usage_month = v_month;
      else
        daily_limit := least(p_free_base_limit + coalesce(rewarded_ad_count, 0) * p_free_bonus_per_ad,
                              p_free_base_limit + p_free_max_ad_bonuses * p_free_bonus_per_ad);
        monthly_used := null;
        monthly_limit := null;
      end if;
      return next;
      return;
    end if;

    update public.ai_usage_requests
       set monthly_counted = v_slot.counted_monthly
     where user_id = v_uid and request_id = p_request_id;

    allowed := true;
    reason := null;
    reservation_token := v_token;
    plan := v_plan;
    used_count := v_slot.new_daily;
    response_payload := null;
    select d.rewarded_ad_count into rewarded_ad_count
      from public.ai_usage_daily d where d.user_id = v_uid and d.usage_date = v_date;
    if v_plan = 'premium' then
      daily_limit := p_premium_daily_limit;
      monthly_limit := p_premium_monthly_limit;
      monthly_used := v_slot.new_monthly;
    else
      daily_limit := least(p_free_base_limit + coalesce(rewarded_ad_count, 0) * p_free_bonus_per_ad,
                            p_free_base_limit + p_free_max_ad_bonuses * p_free_bonus_per_ad);
      monthly_used := null;
      monthly_limit := null;
    end if;
    return next;
    return;
  end if;

  -- 2. 既存行がある（同じrequestIdの再送）。行ロックしてから状態ごとに分岐する。
  select * into v_existing from public.ai_usage_requests r
   where r.user_id = v_uid and r.request_id = p_request_id
   for update;

  -- 同じrequestIdで異なる内容（kind/input）が届いた場合は常に拒否する。
  if v_existing.request_hash is not null and p_request_hash is not null
     and v_existing.request_hash <> p_request_hash then
    allowed := false;
    reason := 'content_mismatch';
    reservation_token := null;
    plan := v_existing.reserved_plan;
    response_payload := null;
    return next;
    return;
  end if;

  if v_existing.status = 'reserved' then
    allowed := false;
    reason := 'processing';
    reservation_token := null;
    plan := v_existing.reserved_plan;
    response_payload := null;
    return next;
    return;
  end if;

  if v_existing.status = 'confirmed' then
    -- 現在のプランに関係なく、保存済みの同じ回答を返す。OpenAIは再実行しない。
    allowed := false;
    reason := 'already_confirmed';
    reservation_token := null;
    plan := v_existing.reserved_plan;
    response_payload := v_existing.response_payload;
    return next;
    return;
  end if;

  -- status = 'released': 以前の試行が失敗し枠は返却済み。再試行時点の最新プレミアム資格を
  -- 再判定し、現在のプランで再予約する（予約時プランを新しい値へ更新、古いtokenは無効化）。
  select * into v_slot from public._reserve_usage_slot(
    v_uid, v_existing.usage_date, date_trunc('month', v_existing.usage_date)::date, v_plan,
    p_free_base_limit, p_free_bonus_per_ad, p_free_max_ad_bonuses,
    p_premium_daily_limit, p_premium_monthly_limit
  );

  if not v_slot.ok then
    allowed := false;
    reason := v_slot.reason;
    reservation_token := null;
    plan := v_plan;
    response_payload := null;
    return next;
    return;
  end if;

  v_token := gen_random_uuid();
  update public.ai_usage_requests
     set status = 'reserved',
         reservation_token = v_token,
         reserved_plan = v_plan,
         monthly_counted = v_slot.counted_monthly,
         usage_month = date_trunc('month', v_existing.usage_date)::date,
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
  plan := v_plan;
  used_count := v_slot.new_daily;
  response_payload := null;
  select d.rewarded_ad_count into rewarded_ad_count
    from public.ai_usage_daily d where d.user_id = v_uid and d.usage_date = v_existing.usage_date;
  if v_plan = 'premium' then
    daily_limit := p_premium_daily_limit;
    monthly_limit := p_premium_monthly_limit;
    monthly_used := v_slot.new_monthly;
  else
    daily_limit := least(p_free_base_limit + coalesce(rewarded_ad_count, 0) * p_free_bonus_per_ad,
                          p_free_base_limit + p_free_max_ad_bonuses * p_free_bonus_per_ad);
    monthly_used := null;
    monthly_limit := null;
  end if;
  return next;
end;
$$;

revoke all on function public.reserve_ai_usage(text, text, int, int, int, int, int, date) from public;
grant execute on function public.reserve_ai_usage(text, text, int, int, int, int, int, date) to authenticated;

-- ============================================================
-- 6. release_ai_usage: 予約行のreserved_plan/monthly_countedだけを見て
--    戻すべきカウンターを判断する（処理中に資格が変わっても予約時プランを維持）。
-- ============================================================
create or replace function public.release_ai_usage(p_reservation_token uuid)
returns table (ok boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_row from public.ai_usage_requests
   where reservation_token = p_reservation_token
     and user_id = auth.uid()
     and status = 'reserved'
   for update;

  if not found then
    ok := false;
    return next;
    return;
  end if;

  update public.ai_usage_requests
     set status = 'released', released_at = now()
   where reservation_token = p_reservation_token;

  update public.ai_usage_daily
     set used_count = greatest(used_count - 1, 0), updated_at = now()
   where user_id = v_row.user_id and usage_date = v_row.usage_date;

  if v_row.monthly_counted and v_row.usage_month is not null then
    update public.ai_usage_monthly
       set premium_used_count = greatest(premium_used_count - 1, 0), updated_at = now()
     where user_id = v_row.user_id and usage_month = v_row.usage_month;
  end if;

  ok := true;
  return next;
end;
$$;

-- ============================================================
-- 7. grant_ai_ad_bonus: プレミアム有効なユーザーには報酬を付与しない
--    （冪等性台帳にも触れない。クライアント改変での直接呼び出しでも
--    rewarded_ad_countは増えない）。
-- ============================================================
create or replace function public.grant_ai_ad_bonus(
  p_reward_event_id text,
  p_base_limit int,
  p_bonus_per_ad int,
  p_max_ad_bonuses int,
  p_usage_date date default null
)
returns table (
  granted boolean,
  reason text,
  used_count int,
  rewarded_ad_count int,
  daily_limit int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_date date;
  v_new_ads int;
  v_new_used int;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_reward_event_id is null or length(p_reward_event_id) = 0 then
    raise exception 'reward_event_id is required';
  end if;

  if public.is_premium_active() then
    granted := false;
    reason := 'premium_ad_bonus_not_available';
    return next;
    return;
  end if;

  v_date := public.clamp_ai_usage_date(p_usage_date);

  begin
    insert into public.ai_usage_ad_rewards (user_id, usage_date, reward_event_id)
    values (v_uid, v_date, p_reward_event_id);
  exception when unique_violation then
    select d.used_count, d.rewarded_ad_count into used_count, rewarded_ad_count
      from public.ai_usage_daily d where d.user_id = v_uid and d.usage_date = v_date;
    granted := false;
    reason := 'duplicate_reward_event';
    daily_limit := least(p_base_limit + coalesce(rewarded_ad_count, 0) * p_bonus_per_ad,
                          p_base_limit + p_max_ad_bonuses * p_bonus_per_ad);
    return next;
    return;
  end;

  perform public.ensure_ai_usage_daily_row(v_uid, v_date);

  update public.ai_usage_daily d
     set rewarded_ad_count = d.rewarded_ad_count + 1, updated_at = now()
   where d.user_id = v_uid and d.usage_date = v_date and d.rewarded_ad_count < p_max_ad_bonuses
  returning d.rewarded_ad_count, d.used_count into v_new_ads, v_new_used;

  if v_new_ads is null then
    select d.used_count, d.rewarded_ad_count into v_new_used, rewarded_ad_count
      from public.ai_usage_daily d where d.user_id = v_uid and d.usage_date = v_date;
    granted := false;
    reason := 'ad_bonus_limit_reached';
    used_count := v_new_used;
    daily_limit := least(p_base_limit + rewarded_ad_count * p_bonus_per_ad, p_base_limit + p_max_ad_bonuses * p_bonus_per_ad);
    return next;
    return;
  end if;

  used_count := v_new_used;
  rewarded_ad_count := v_new_ads;
  granted := true;
  reason := null;
  daily_limit := least(p_base_limit + rewarded_ad_count * p_bonus_per_ad, p_base_limit + p_max_ad_bonuses * p_bonus_per_ad);
  return next;
end;
$$;

-- ============================================================
-- 8. get_ai_usage_status: プラン別のレスポンス（表示専用、副作用は当日/当月行の遅延作成のみ）
-- ============================================================
drop function if exists public.get_ai_usage_status(int, int, int, date);

create or replace function public.get_ai_usage_status(
  p_free_base_limit int,
  p_free_bonus_per_ad int,
  p_free_max_ad_bonuses int,
  p_premium_daily_limit int,
  p_premium_monthly_limit int,
  p_usage_date date default null
)
returns table (
  plan text,
  usage_date date,
  daily_used int,
  daily_limit int,
  daily_remaining int,
  effective_remaining int,
  rewarded_ad_count int,
  rewarded_ad_limit int,
  can_watch_rewarded_ad boolean,
  monthly_limit int,
  monthly_used int,
  monthly_remaining int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_date date;
  v_month date;
  v_plan text;
  v_daily_used int;
  v_ads int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  v_date := public.clamp_ai_usage_date(p_usage_date);
  v_month := date_trunc('month', v_date)::date;
  v_plan := case when public.is_premium_active() then 'premium' else 'free' end;

  perform public.ensure_ai_usage_daily_row(auth.uid(), v_date);

  select d.used_count, d.rewarded_ad_count into v_daily_used, v_ads
    from public.ai_usage_daily d
   where d.user_id = auth.uid() and d.usage_date = v_date;

  plan := v_plan;
  usage_date := v_date;
  daily_used := v_daily_used;

  if v_plan = 'premium' then
    perform public.ensure_ai_usage_monthly_row(auth.uid(), v_month);
    select m.premium_used_count into monthly_used
      from public.ai_usage_monthly m where m.user_id = auth.uid() and m.usage_month = v_month;

    daily_limit := p_premium_daily_limit;
    daily_remaining := greatest(0, p_premium_daily_limit - v_daily_used);
    monthly_limit := p_premium_monthly_limit;
    monthly_remaining := greatest(0, p_premium_monthly_limit - monthly_used);
    effective_remaining := least(daily_remaining, monthly_remaining);
    rewarded_ad_count := 0;
    rewarded_ad_limit := 0;
    can_watch_rewarded_ad := false;
  else
    daily_limit := least(p_free_base_limit + v_ads * p_free_bonus_per_ad,
                          p_free_base_limit + p_free_max_ad_bonuses * p_free_bonus_per_ad);
    daily_remaining := greatest(0, daily_limit - v_daily_used);
    effective_remaining := daily_remaining;
    rewarded_ad_count := v_ads;
    rewarded_ad_limit := p_free_max_ad_bonuses;
    can_watch_rewarded_ad := daily_remaining = 0 and v_ads < p_free_max_ad_bonuses;
    monthly_limit := null;
    monthly_used := null;
    monthly_remaining := null;
  end if;

  return next;
end;
$$;

revoke all on function public.get_ai_usage_status(int, int, int, int, int, date) from public;
grant execute on function public.get_ai_usage_status(int, int, int, int, int, date) to authenticated;

-- verify: select column_name from information_schema.columns where table_name = 'user_entitlements';
-- verify: select column_name from information_schema.columns where table_name = 'ai_usage_monthly';
-- verify: select column_name from information_schema.columns where table_name = 'ai_usage_requests'
--   and column_name in ('reserved_plan','usage_month','monthly_counted');
-- verify: select proname, pronargs from pg_proc where proname in
--   ('is_premium_active','_reserve_usage_slot','reserve_ai_usage','release_ai_usage',
--    'grant_ai_ad_bonus','get_ai_usage_status','ensure_ai_usage_monthly_row');
