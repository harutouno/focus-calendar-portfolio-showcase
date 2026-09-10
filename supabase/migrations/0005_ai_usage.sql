-- Stage I-9A: AIサポート機能の最小限の利用回数制限（ユーザー単位・1日単位）。
--
-- 方針: 既存プロジェクトと同じく service_role は使わない。
-- ai-support Edge Functionは呼び出しユーザーのJWTを積んだクライアントで
-- increment_ai_usage を呼ぶため、auth.uid() がそのユーザーに解決され、RLS配下で安全に動く。

create table if not exists public.ai_usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  request_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

alter table public.ai_usage_daily enable row level security;

-- 自分の利用状況のみ閲覧可能。insert/update/deleteはRPC経由のみ（直接の書込み権限は付与しない）。
create policy "ai_usage_select_own"
  on public.ai_usage_daily for select
  using (user_id = auth.uid());

-- 呼び出しごとに当日の件数を1増やし、上限を超えていないかを返す。
-- p_daily_limitはEdge Function側の環境変数(AI_DAILY_LIMIT)から渡される。
create or replace function public.increment_ai_usage(p_daily_limit int)
returns table (allowed boolean, used_count int, daily_limit int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.ai_usage_daily (user_id, usage_date, request_count)
  values (auth.uid(), current_date, 1)
  on conflict (user_id, usage_date)
  do update set request_count = public.ai_usage_daily.request_count + 1,
                updated_at = now()
  returning request_count into v_count;

  return query select (v_count <= p_daily_limit), v_count, p_daily_limit;
end;
$$;

revoke all on function public.increment_ai_usage(int) from public;
grant execute on function public.increment_ai_usage(int) to authenticated;

-- verify: select * from pg_policies where tablename = 'ai_usage_daily';
-- verify: select proname, prosecdef from pg_proc where proname = 'increment_ai_usage';
