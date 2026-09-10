-- 単独実装(2026-08): 全クライアント機能が同じuser_entitlements由来のプレミアム状態を
-- 参照するための読み取り専用RPC。
--
-- 背景: user_entitlements/is_premium_active()（0014）はこれまでRemote AIのRPC群からしか
-- 参照されておらず、マイカレンダー上限・集中分析・CSV・広告非表示・ローカル予定の画像添付
-- 上限はクライアント側のみ（LocalPremiumService、本番では常にfree固定）で判定していた。
-- 本migrationはuser_entitlementsを唯一の正本として全クライアント機能が参照できるよう、
-- 認証済みユーザーが自分自身の資格だけを取得できるget_my_premium_status()を追加する。
-- 判定ロジックは0014のis_premium_active()をそのまま呼び出して再利用し、重複させない。
--
-- 0014は無編集。適用順は 0012 → 0013 → 0014 → 0015。0015自体はai_usage_*テーブル/RPCへ
-- 一切触れないため、この0015単体の適用にai-support Edge Functionの再デプロイは不要。

-- ============================================================
-- 1. is_premium_active()のPUBLIC実行権限を明示的に閉じる
-- ============================================================
-- 0014のis_premium_active()はコメントで「内部専用」とされているが、revoke文が
-- 付いていなかったため、Postgresのデフォルト（新規関数のEXECUTEはPUBLICへ自動付与）
-- により理論上どのロールからも直接呼び出せる状態だった（漏洩するのは呼び出し本人自身の
-- ブール値のみで他人の資格ではないが、意図と食い違うため閉じる）。他のSECURITY DEFINER
-- 関数（reserve_ai_usage・grant_ai_ad_bonus・get_ai_usage_status・本ファイルのget_my_premium_status）
-- からの内部呼び出しは、関数所有者の権限で評価されるため、この変更による影響を受けない。
revoke all on function public.is_premium_active() from public;

-- ============================================================
-- 2. get_my_premium_status(): 認証済みユーザーが自分自身の資格を取得するRPC
-- ============================================================
create or replace function public.get_my_premium_status()
returns table (
  plan text,
  is_premium boolean,
  entitlement_status text,
  starts_at timestamptz,
  expires_at timestamptz,
  checked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.user_entitlements%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select * into v_row
    from public.user_entitlements e
   where e.user_id = v_uid
     and e.entitlement_key = 'premium'
   limit 1;

  is_premium := public.is_premium_active();
  plan := case when is_premium then 'premium' else 'free' end;
  checked_at := now();

  if v_row.user_id is null then
    entitlement_status := null;
    starts_at := null;
    expires_at := null;
  else
    entitlement_status := v_row.status;
    starts_at := v_row.starts_at;
    expires_at := v_row.expires_at;
  end if;

  return next;
end;
$$;

revoke all on function public.get_my_premium_status() from public;
grant execute on function public.get_my_premium_status() to authenticated;

-- verify (認証済みセッションから実行し、自分の行だけが返ることを確認する):
-- select * from public.get_my_premium_status();
-- verify: select proname, pronargs from pg_proc where proname = 'get_my_premium_status';
-- verify: select grantee, privilege_type from information_schema.routine_privileges
--   where routine_name in ('get_my_premium_status', 'is_premium_active');
