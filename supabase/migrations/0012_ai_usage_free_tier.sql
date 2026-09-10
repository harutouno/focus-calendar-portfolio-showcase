-- 単独改善: 無料版AI利用回数を「毎日3回＋リワード広告で+3回×最大2回＝最大9回/日」へ
-- 統一し、サーバー側（DB RPC）を唯一の正本にする。
--
-- 背景: 旧increment_ai_usage RPCは広告ボーナスの概念を持たないフラットな1日上限
-- （Edge FunctionのAI_DAILY_LIMIT環境変数、既定18）をバックストップとして持つだけで、
-- 実際の「無料枠+広告ボーナス」の判定・表示はクライアント（AsyncStorage）にしかなく、
-- AsyncStorageを書き換えれば残り回数がいつでも復活してしまっていた。
-- 本migrationはai_usage_dailyを拡張し、予約(reserve)→確定(confirm)/返却(release)の
-- 冪等な仕組みと、広告報酬の冪等な付与を、すべてサーバー側の原子的UPDATEで
-- 保証する。既存のservice_roleを使わない方針・SECURITY DEFINER RPC経由のみで
-- 書き込む方針は0005を踏襲する（0005自体は無編集）。
--
-- プレミアムのAI利用回数は現状まったく差別化されておらず、今回もその状態を維持する
-- （上限値はテーブルのCHECK制約にせず、RPC側の引数として渡す。将来tier別上限を
-- 導入する際にCHECK制約の緩和というDB変更を追加で強いられないようにするため）。

alter table public.ai_usage_daily rename column request_count to used_count;

alter table public.ai_usage_daily
  add column if not exists rewarded_ad_count int not null default 0;

alter table public.ai_usage_daily
  add constraint ai_usage_daily_used_count_nonneg check (used_count >= 0);
alter table public.ai_usage_daily
  add constraint ai_usage_daily_rewarded_ad_count_nonneg check (rewarded_ad_count >= 0);

-- リクエスト単位の冪等性台帳。同じrequest_idでの二重予約・二重消費（連打・リトライ・
-- ネットワーク再送）を防ぐ。reservation_tokenはEdge Function内部の処理でのみ扱われ、
-- クライアントへ返すレスポンスには含めない値（クライアントが知っているrequest_idだけ
-- ではconfirm/releaseを呼べないようにし、「予約直後に自分でreleaseを呼んで騙し取る」
-- 類のレースを防ぐ）。
create table if not exists public.ai_usage_requests (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  request_id text not null,
  reservation_token uuid not null default gen_random_uuid(),
  status text not null default 'reserved' check (status in ('reserved', 'confirmed', 'released')),
  reserved_at timestamptz not null default now(),
  confirmed_at timestamptz,
  released_at timestamptz,
  primary key (user_id, request_id)
);

create unique index if not exists ai_usage_requests_token_idx
  on public.ai_usage_requests (reservation_token);

alter table public.ai_usage_requests enable row level security;

create policy "ai_usage_requests_select_own"
  on public.ai_usage_requests for select
  using (user_id = auth.uid());

-- 広告報酬の冪等性台帳。同じreward_event_idでの二重付与を防ぐ。
create table if not exists public.ai_usage_ad_rewards (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  reward_event_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, reward_event_id)
);

alter table public.ai_usage_ad_rewards enable row level security;

create policy "ai_usage_ad_rewards_select_own"
  on public.ai_usage_ad_rewards for select
  using (user_id = auth.uid());

-- クライアントから渡された「ユーザーのローカル日付」をそのまま信用せず、サーバーの
-- current_dateと±1日（時差の範囲）を超えて乖離していればサーバー日付へフォールバック
-- する。正当な時差は尊重しつつ、日付偽装による無制限復活は防ぐ。
create or replace function public.clamp_ai_usage_date(p_usage_date date)
returns date
language sql
immutable
as $$
  select case
    when p_usage_date is null then current_date
    when abs(p_usage_date - current_date) > 1 then current_date
    else p_usage_date
  end;
$$;

-- 呼び出し中のユーザーの当日バケット行を無ければ作成する（内部ヘルパー、直接は公開しない）。
create or replace function public.ensure_ai_usage_daily_row(p_user_id uuid, p_usage_date date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.ai_usage_daily (user_id, usage_date, used_count, rewarded_ad_count)
  values (p_user_id, p_usage_date, 0, 0)
  on conflict (user_id, usage_date) do nothing;
end;
$$;

revoke all on function public.ensure_ai_usage_daily_row(uuid, date) from public;

-- 読み取り専用: 表示用に現在の利用状況を返す（副作用は当日バケット行の遅延作成のみ）。
create or replace function public.get_ai_usage_status(
  p_base_limit int,
  p_bonus_per_ad int,
  p_max_ad_bonuses int,
  p_usage_date date default null
)
returns table (usage_date date, used_count int, rewarded_ad_count int, daily_limit int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_date date;
  v_used int;
  v_ads int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  v_date := public.clamp_ai_usage_date(p_usage_date);
  perform public.ensure_ai_usage_daily_row(auth.uid(), v_date);

  select d.used_count, d.rewarded_ad_count into v_used, v_ads
    from public.ai_usage_daily d
   where d.user_id = auth.uid() and d.usage_date = v_date;

  return query select v_date, v_used, v_ads,
    least(p_base_limit + v_ads * p_bonus_per_ad, p_base_limit + p_max_ad_bonuses * p_bonus_per_ad);
end;
$$;

revoke all on function public.get_ai_usage_status(int, int, int, date) from public;
grant execute on function public.get_ai_usage_status(int, int, int, date) to authenticated;

-- 利用枠を原子的に予約する。同じrequest_idの再送は「二重消費」せず、既存の状態を
-- allowed=falseで返す。原子的UPDATE（where used_count < entitlement）により、
-- 同時リクエストでも1日の上限を超えない。
create or replace function public.reserve_ai_usage(
  p_request_id text,
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
  daily_limit int
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

  select * into v_existing from public.ai_usage_requests r
   where r.user_id = v_uid and r.request_id = p_request_id;

  if found then
    select d.used_count, d.rewarded_ad_count into used_count, rewarded_ad_count
      from public.ai_usage_daily d
     where d.user_id = v_uid and d.usage_date = v_existing.usage_date;
    daily_limit := least(p_base_limit + coalesce(rewarded_ad_count, 0) * p_bonus_per_ad,
                          p_base_limit + p_max_ad_bonuses * p_bonus_per_ad);
    allowed := false;
    reason := 'duplicate_request';
    reservation_token := null;
    return next;
    return;
  end if;

  perform public.ensure_ai_usage_daily_row(v_uid, v_date);

  select d.rewarded_ad_count into v_ads
    from public.ai_usage_daily d
   where d.user_id = v_uid and d.usage_date = v_date;

  v_entitlement := least(p_base_limit + v_ads * p_bonus_per_ad, p_base_limit + p_max_ad_bonuses * p_bonus_per_ad);

  update public.ai_usage_daily d
     set used_count = d.used_count + 1, updated_at = now()
   where d.user_id = v_uid and d.usage_date = v_date and d.used_count < v_entitlement
  returning d.used_count into v_new_used;

  if v_new_used is null then
    select d.used_count into v_new_used from public.ai_usage_daily d
     where d.user_id = v_uid and d.usage_date = v_date;
    allowed := false;
    reason := 'usage_limit_exceeded';
    reservation_token := null;
    used_count := v_new_used;
    rewarded_ad_count := v_ads;
    daily_limit := v_entitlement;
    return next;
    return;
  end if;

  v_token := gen_random_uuid();
  insert into public.ai_usage_requests (user_id, usage_date, request_id, reservation_token, status)
  values (v_uid, v_date, p_request_id, v_token, 'reserved');

  allowed := true;
  reason := null;
  reservation_token := v_token;
  used_count := v_new_used;
  rewarded_ad_count := v_ads;
  daily_limit := v_entitlement;
  return next;
end;
$$;

revoke all on function public.reserve_ai_usage(text, int, int, int, date) from public;
grant execute on function public.reserve_ai_usage(text, int, int, int, date) to authenticated;

-- 予約を確定する（ブックキーピングのみ。カウントは予約時に確定済みのため、
-- このRPCが失敗してもused_countには影響しない＝ベストエフォートで安全）。
create or replace function public.confirm_ai_usage(p_reservation_token uuid)
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
     set status = 'confirmed', confirmed_at = now()
   where reservation_token = p_reservation_token
     and user_id = auth.uid()
     and status = 'reserved';

  ok := found;
  return next;
end;
$$;

revoke all on function public.confirm_ai_usage(uuid) from public;
grant execute on function public.confirm_ai_usage(uuid) to authenticated;

-- 予約を返却する（used_countを-1し、予約行をreleasedにする）。既にconfirmed/released、
-- または存在しないtokenの場合は何もせずok=falseを返す（安全に冪等）。
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

  ok := true;
  return next;
end;
$$;

revoke all on function public.release_ai_usage(uuid) from public;
grant execute on function public.release_ai_usage(uuid) to authenticated;

-- リワード広告の完了報酬を冪等に付与する。同じreward_event_idでの再呼び出しは
-- 付与せずgranted=falseを返す。上限到達時もgranted=falseだが、そのイベント自体は
-- 「見た」記録として台帳に残す（同じイベントを繰り返し送っても結果は変わらないため）。
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

revoke all on function public.grant_ai_ad_bonus(text, int, int, int, date) from public;
grant execute on function public.grant_ai_ad_bonus(text, int, int, int, date) to authenticated;

-- 旧・フラット上限RPCを正式に退役させる（0005自体は無編集。ai_usage_dailyテーブルと
-- 既存データは維持したまま、以後この関数は使われない）。
drop function if exists public.increment_ai_usage(int);

-- verify: select column_name from information_schema.columns where table_name = 'ai_usage_daily';
-- verify: select proname from pg_proc where proname in
--   ('get_ai_usage_status','reserve_ai_usage','confirm_ai_usage','release_ai_usage','grant_ai_ad_bonus');
-- verify: select proname from pg_proc where proname = 'increment_ai_usage'; -- 0件になっていること
