-- ============================================================
-- 0024_attachment_absence_authority.sql
--
-- [P0166 §1 / CORRECT-CLOUDATTACH-002]
-- 添付の削除検証に「**権威ある不在**」と「**確認不能**」を区別させる。
--
-- 根本不変条件:
--
--   RLS invisibility != global absence
--
-- ## なぜ必要か
--
-- 従来の `getAttachmentDeleteVerificationRow()` はクライアントから
-- `event_attachments` を素の SELECT で引き、行が返らなければ `not-found` を返していた。
-- `event_attachments` の SELECT は RLS で「そのカレンダーのメンバーだけ」に絞られるため、
-- **メンバーシップ／読取権を失った直後も同じ `not-found` になる**。
-- 呼び出し元（performRemove / retryDeleteIntent / retryLegacyUnresolved）は
-- これを「既に無い」と読み、成功を報告し durable な cleanup intent を消していた。
--
-- クライアント側で「メンバーか？」「行はあるか？」を別々に問い合わせても、
-- 2 つのクエリの間で権限が変わりうるため**原子的に判定できない**。
-- そこでサーバ側の 1 スナップショットで両方を決める。
--
-- ## 情報開示について
--
-- この関数は `security definer` だが、**存在プローブの開示チャネルにしない**:
--   - まず `is_calendar_member(p_calendar_id, 'viewer')` を評価し、
--     メンバーでなければ **行の有無を一切見ずに** `unconfirmed` を返す。
--   - メンバーの場合にのみ、`p_calendar_id` に属する添付だけを探す。
--     これは通常の RLS で既に読める範囲と完全に一致しており、
--     新たに漏れる情報は無い。
--   - `event_id` / `storage_path` はメンバーの場合のみ返す。
--   - 任意の対象ユーザーを指定する引数は無い。呼び出し元 identity は `auth.uid()` のみ。
--
-- ## 戻り値
--
--   outcome = 'found'                 … 期待カレンダー内に添付が現存する
--   outcome = 'authoritatively-absent'… メンバーであることを確認したうえで不在
--   outcome = 'unconfirmed'           … 読取権限を確立できない（不在と断定してはならない）
--
-- 適用方針: このバッチでは **適用しない**（MIGRATION_APPLY=NO）。
-- ============================================================

create or replace function public.verify_attachment_delete_target(
  p_attachment_id text,
  p_calendar_id uuid
)
returns table (
  outcome text,
  event_id text,
  storage_path text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  -- 入力が欠けている場合は「不在」ではなく「確認不能」。
  -- （旧 v1 の legacy-delete-unresolved は calendarId を持たないため、
  --  クライアント側で問い合わせる前に unconfirmed を返す設計だが、
  --  サーバ側でも同じ側へ倒しておく。）
  if p_attachment_id is null or p_calendar_id is null then
    return query select 'unconfirmed'::text, null::text, null::text;
    return;
  end if;

  -- ① まず読取権限を確立する。メンバーでなければ**行の有無を一切参照しない**。
  --    ここで 'authoritatively-absent' を返してしまうと、権限喪失が
  --    「グローバルな不在」に化けてしまう（これが CORRECT-CLOUDATTACH-002 そのもの）。
  if not public.is_calendar_member(p_calendar_id, 'viewer') then
    return query select 'unconfirmed'::text, null::text, null::text;
    return;
  end if;

  -- ② メンバーであることが確定した同一スナップショット内で、
  --    期待カレンダーに属する添付を探す。
  return query
  select
    'found'::text,
    a.event_id::text,
    a.storage_path::text
  from public.event_attachments a
  join public.events e on e.id = a.event_id
  where a.id = p_attachment_id
    and e.calendar_id = p_calendar_id;

  if found then
    return;
  end if;

  -- ③ メンバーとして探して見つからなかった＝**権威ある不在**。
  return query select 'authoritatively-absent'::text, null::text, null::text;
end;
$$;

revoke all on function public.verify_attachment_delete_target(text, uuid) from public;
grant execute on function public.verify_attachment_delete_target(text, uuid) to authenticated;

comment on function public.verify_attachment_delete_target(text, uuid) is
  '[P0166] 添付削除の検証。メンバーシップを先に確立し、found / authoritatively-absent / unconfirmed を明示的に返す。RLS 不可視を不在と読み替えさせない。';

-- ============================================================
-- 手動確認用（このバッチでは実行しない）
-- ============================================================
-- -- 1) メンバーであり添付が現存する
-- --    → outcome='found', event_id/storage_path が返ること
-- -- select * from public.verify_attachment_delete_target('<attachment_id>', '<calendar_id>');
--
-- -- 2) メンバーだが添付は既に削除済み
-- --    → outcome='authoritatively-absent', メタデータは null
--
-- -- 3) **メンバーを外された後**に同じ呼び出しをする
-- --    → outcome='unconfirmed'（'authoritatively-absent' に**ならないこと**が本修正の核心）
--
-- -- 4) 一度もメンバーでないカレンダーIDを指定する
-- --    → outcome='unconfirmed'。行の有無は一切開示されないこと
--
-- -- 5) 添付は存在するが別カレンダーに属する（calendarId 不一致）
-- --    → 呼び出し元がそのカレンダーのメンバーなら 'authoritatively-absent'
-- --      （期待カレンダー内には無い、という正しい判定）
--
-- -- 6) 権限確認
-- -- select has_function_privilege('anon', 'public.verify_attachment_delete_target(text, uuid)', 'execute');  -- false
-- -- select has_function_privilege('authenticated', 'public.verify_attachment_delete_target(text, uuid)', 'execute');  -- true
