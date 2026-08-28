-- ============================================================
-- 0023_shared_calendar_self_leave.sql
--
-- [P0164 §3 / CORRECT-F029-001] 共有カレンダーからの「自己退出」に、
-- **型付きの明示 outcome を返すサーバ関数**を導入する。
--
-- 根本不変条件（P0164）:
--
--   NO_ERROR != EFFECT_APPLIED
--   効果を及ぼすことが意味的に必須な mutation は、権威ある効果証跡なしに
--   primary success を報告してはならない。
--   RLS による不可視は「グローバルな不在」の証明ではない。
--
-- ## なぜ必要か（0001 を読んで確認した事実）
--
-- `public.calendar_members` の DELETE ポリシーは 0001_init.sql の
-- `members_delete_owner` **ただ1つ**であり、その定義は
--
--     on public.calendar_members for delete
--     using (public.is_calendar_member(calendar_id, 'owner'))
--
-- である。`using` 句だけのポリシーなので、条件に合致しない行は
-- **エラーではなく「0 行が一致した」**という扱いになる。
--
-- 結果として、editor / viewer のメンバーが自分自身の行を DELETE しても
-- **常に 0 行・エラー無し**で返る。クライアントが `.select()` を付けずに
-- 直接 DELETE していた従来実装では、これが「退出成功」として表示され、
-- 実際にはメンバーのまま残り続けていた（＝レースではなく恒常的な偽成功）。
--
-- クライアント側の `.select()` 化だけでは「退出できない」ことを正しく
-- エラーにできるだけで、**退出そのものが依然として不可能**なままになる。
-- そのため、ここでサーバ側に自己退出の正規経路を用意する。
--
-- ## 設計方針
--
-- - `security definer` だが**広域バイパスにはしない**。関数は
--   `auth.uid()` **自身の行のみ**を対象とし、他人の user_id を指定する
--   引数を一切受け取らない（対象の明示チェックを内包している）。
-- - owner は退出できない（カレンダーが所有者不在になるのを防ぐ）。
--   owner には既存の削除導線（calendars_delete_owner）がある。
-- - 戻り値は text の**明示 outcome**:
--     'left'                … 実際に自分の行を削除した
--     'not_member'          … 元からメンバーではない（冪等な成功）
--     'owner_cannot_leave'  … owner のため退出不可（拒否が確定）
--   これにより RLS の可視性から結果を推測する必要が構造的に消える
--   （P0164 の分類でいう SERVER_EXPLICIT_OUTCOME）。
-- - [P0057/P0062] 書き込みガードに従う。対象ユーザーの状態が有効でない間に
--   メンバーシップを変更することを防ぐ。
-- - 削除対象行を `for update` で確定させてから削除し、同一ユーザーの
--   同時退出要求どうしが二重に 'left' を返さないようにする。
--
-- 適用方針: このバッチでは **適用しない**（MIGRATION_APPLY=NO）。
-- ============================================================

create or replace function public.leave_shared_calendar(p_calendar_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  if p_calendar_id is null then
    raise exception 'calendar_not_found';
  end if;

  -- [P0057/P0062] 書き込みガードを満たさない場合は他の write と同様に拒否する。
  perform public.assert_account_write_allowed(v_user_id);

  -- 対象は「呼び出し本人の行」だけ。他人の user_id を指定する手段は無い。
  -- for update により、同一ユーザーの同時退出が二重に 'left' を返さない。
  select role
    into v_role
    from public.calendar_members
   where calendar_id = p_calendar_id
     and user_id = v_user_id
     for update;

  if not found then
    -- 元からメンバーでない＝望む状態が既に達成されている（冪等な成功）。
    -- security definer で読んでいるため、これは RLS 不可視ではなく
    -- **権威ある不在の確認**である。
    return 'not_member';
  end if;

  if v_role = 'owner' then
    -- owner が抜けると所有者不在のカレンダーが残るため許可しない。
    -- 拒否は「確定」しているので unconfirmed ではなく明示 outcome で返す。
    return 'owner_cannot_leave';
  end if;

  delete from public.calendar_members
   where calendar_id = p_calendar_id
     and user_id = v_user_id;

  return 'left';
end;
$$;

revoke all on function public.leave_shared_calendar(uuid) from public;
grant execute on function public.leave_shared_calendar(uuid) to authenticated;

comment on function public.leave_shared_calendar(uuid) is
  '[P0164] 共有カレンダーからの自己退出。auth.uid() 自身の行のみを対象とし、left/not_member/owner_cannot_leave の明示 outcome を返す。';

-- ============================================================
-- 手動確認用（このバッチでは実行しない）
-- ============================================================
-- -- 1) editor として参加しているカレンダーから退出できる
-- --    → 'left' が返り、行が消えていること
-- -- select public.leave_shared_calendar('<calendar_id>');
-- -- select * from public.calendar_members where calendar_id = '<calendar_id>';
--
-- -- 2) 同じ呼び出しをもう一度実行する
-- --    → 'not_member'（冪等）。'left' が二度返らないこと
-- -- select public.leave_shared_calendar('<calendar_id>');
--
-- -- 3) owner 本人が自分のカレンダーに対して実行する
-- --    → 'owner_cannot_leave' が返り、行が残っていること
-- -- select public.leave_shared_calendar('<owned_calendar_id>');
--
-- -- 4) 参加していないカレンダーID（他人のカレンダー）を指定する
-- --    → 'not_member' が返り、**他人の行が一切変化しないこと**
-- -- select public.leave_shared_calendar('<foreign_calendar_id>');
-- -- select count(*) from public.calendar_members where calendar_id = '<foreign_calendar_id>';
--
-- -- 5) 権限確認: 未認証ロールから実行できないこと
-- -- select has_function_privilege('anon', 'public.leave_shared_calendar(uuid)', 'execute');  -- false
-- -- select has_function_privilege('authenticated', 'public.leave_shared_calendar(uuid)', 'execute');  -- true
