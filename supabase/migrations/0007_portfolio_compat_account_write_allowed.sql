-- ============================================================================
-- Portfolio Edition compatibility — 後続 migration の前提として適用する
-- ============================================================================
-- このファイルは公開用 Portfolio Edition だけに存在する。本体アプリには無い。
--
-- 目的
--   本体では共通の書き込みガードを定義し、共有機能の 2 つの RPC が
--   そのガードを呼ぶ。
--     0023_shared_calendar_self_leave.sql        leave_shared_calendar
--     0028_pending_invite_recipient_authority.sql accept_calendar_invite_by_id
--   Portfolio Edition は退会機能を含まないため 0020 を収録していない。
--   0020 を収録しないまま上記 2 本を適用すると、実行時に関数未定義で失敗する。
--
-- 適用順序
--   番号は 0007（本体の0002_storage/0003_avatar_and_cover等と衝突しない、
--   本体では0007_profile_prefill_from_providerが未適用のまま空いている枠）。
--   前提となる先行 migration: 0001_init が profiles テーブルと handle_new_user
--     トリガを作るため、下の実装が参照する public.profiles はこの時点で存在する。
--   前提として必要とする後続 migration: 上記 2 本（0023 / 0028）の RPC は実行時に
--     この関数を呼ぶため、それらより前に定義されている必要がある。
--
-- 本体の元実装（0020）
--   account_write_allowed(p_user_id uuid) は 2 つの役割を持っていた。
--     (1) p_user_id が null なら false を返す        ← 呼び出し元の本人性ガード
--     (2) 削除処理中（requested / manifest_ready /
--         auth_delete_unknown）なら false を返す      ← 退会機能固有
--
-- Portfolio での方針
--   (1) は **絶対に落とさない**。呼び出し元はいずれも auth.uid() を渡しており、
--       未認証（anon）なら auth.uid() は null になる。ここで false を返すことが、
--       未認証の招待受諾・退出を止めている唯一のガードなので、そのまま維持する。
--   (2) は退会機能に固有なので落とす。代わりに「profiles に実在するユーザーか」を
--       要求する。profiles の行は 0001 の handle_new_user トリガが
--       auth.users への挿入時に作るため、実在する認証済みユーザーだけが true になる。
--
--   結果として、この実装は元実装より弱くならない。
--     未認証（null）              → false（元と同じ）
--     存在しないユーザー          → false（元より厳しい）
--     認証済みの実在ユーザー      → true （元では「削除処理中でなければ true」）
--
--   無条件 true にはしていない。RLS も一切緩めていない。
--   認証済み本人以外の操作は、引き続き各 RPC 内の is_calendar_member() と
--   テーブルの RLS ポリシーが拒否する。
-- ============================================================================

create or replace function public.account_write_allowed(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and exists (
       select 1 from public.profiles p where p.id = p_user_id
     );
$$;

revoke all on function public.account_write_allowed(uuid) from public;
grant execute on function public.account_write_allowed(uuid) to authenticated;

-- 呼び出し規約は本体（0020）と同一。違反時の例外メッセージも同じにしておく。
create or replace function public.assert_account_write_allowed(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.account_write_allowed(p_user_id) then
    raise exception 'account_write_not_allowed';
  end if;
end;
$$;

revoke all on function public.assert_account_write_allowed(uuid) from public;
grant execute on function public.assert_account_write_allowed(uuid) to authenticated;

comment on function public.account_write_allowed(uuid) is
  'Portfolio Edition 用。null 拒否と実在ユーザー要求だけを残し、退会状態の判定は含まない。';

-- ----------------------------------------------------------------------------
-- 手動確認用
-- ----------------------------------------------------------------------------
-- select public.account_write_allowed(null);                       -- false であること
-- select public.account_write_allowed(gen_random_uuid());           -- false であること
-- select public.account_write_allowed((select id from public.profiles limit 1)); -- true
