-- ============================================================
-- 0025_attachment_absence_authority_uuid_contract.sql
--
-- [P0168 §1 / SQL-P0166-001]
-- migration 0024 で追加した `verify_attachment_delete_target` の
-- **添付 ID の型契約が誤っていた**ことの是正。
--
-- ## 何が誤っていたか
--
-- 0024 の宣言と述語:
--
--   verify_attachment_delete_target(p_attachment_id text, p_calendar_id uuid)
--   ...
--   where a.id = p_attachment_id
--
-- しかし正典スキーマ（0008_event_attachments.sql）では
--
--   public.event_attachments.id  uuid primary key default gen_random_uuid()
--
-- である。PostgreSQL に `uuid = text` の演算子は**存在しない**ため、
-- この関数は作成/実行時に `operator does not exist: uuid = text` で失敗する。
-- つまり 0024 は**適用しても動かない**。
--
-- 対比のため明示しておく: 同じ 0008 内で `event_id` だけは `text` である
-- （`events.id` がクライアント生成の非 UUID 文字列 "evt_..." のため。0006 参照）。
-- 「添付テーブルの ID はすべて text」ではない。**列ごとに型が違う。**
--
-- ## なぜ signature を変えるのか（`::uuid` キャストではなく）
--
-- P0168 §1 は `where a.id = p_attachment_id::uuid` という同一 wire 形の
-- 是正も許容している。しかし本 migration は **`(uuid, uuid)` へ変更**する:
--
--   - 添付 ID はクライアントの `Crypto.randomUUID()` 生成であり
--     （`src/hooks/useEventAttachments.ts`）、正典契約は一貫して UUID。
--     パラメータ型を UUID にすることが契約の正しい表現である。
--   - 不正な ID は**関数本体に入る前に** PostgREST/PostgreSQL の入力変換で
--     22P02 として拒否される（fail-closed）。本体内キャストだと
--     「関数に入ってから落ちる」ため、将来の分岐追加で
--     破壊的後続処理の前に到達しうる余地が残る。
--   - wire 形は変わらない。PostgREST は JSON 文字列を uuid へ変換するため、
--     クライアント（`p_attachment_id: id` に文字列を渡す）は無変更でよい。
--
-- ## overload の明示的削除
--
-- 旧 `(text, uuid)` を残したまま `(uuid, uuid)` を足すと、PostgREST から見て
-- **同じ JSON 引数名で呼べる overload が 2 つ**になり、どちらが呼ばれるか
-- 曖昧になる（PostgREST は 300 Multiple Choices を返しうる）。
-- そのため新規作成の**前に**旧 signature を明示的に drop する。
--
-- ## 変えていないもの（0024 からの不変部分）
--
--   - `security definer` + `set search_path = public, pg_temp`
--   - `revoke all from public` / `grant execute to authenticated`
--   - 呼び出し元 identity は `auth.uid()` のみ（対象ユーザー引数を持たない）
--   - **メンバーシップ確立を存在読み取りより先に行う**順序
--   - 非メンバーの outcome は `unconfirmed`（行の有無を一切参照しない）
--   - メタデータ（event_id / storage_path）はメンバーの場合のみ返す
--
-- 適用方針: このバッチでは **適用しない**（MIGRATION_APPLY=NO）。
-- ============================================================

-- 旧 signature を先に落とす（PostgREST の overload 曖昧化を防ぐ）。
drop function if exists public.verify_attachment_delete_target(text, uuid);

create or replace function public.verify_attachment_delete_target(
  p_attachment_id uuid,
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
  --    「グローバルな不在」に化けてしまう（CORRECT-CLOUDATTACH-002 そのもの）。
  if not public.is_calendar_member(p_calendar_id, 'viewer') then
    return query select 'unconfirmed'::text, null::text, null::text;
    return;
  end if;

  -- ② メンバーであることが確定した同一スナップショット内で、
  --    期待カレンダーに属する添付を探す。
  --    a.id は uuid、p_attachment_id も uuid（0025 で是正）。
  --    a.event_id は text（events.id が非 UUID 文字列のため。0006/0008 参照）。
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

revoke all on function public.verify_attachment_delete_target(uuid, uuid) from public;
grant execute on function public.verify_attachment_delete_target(uuid, uuid) to authenticated;

comment on function public.verify_attachment_delete_target(uuid, uuid) is
  '[P0168] 添付削除の検証。メンバーシップを先に確立し、found / authoritatively-absent / unconfirmed を明示的に返す。RLS 不可視を不在と読み替えさせない。添付IDは正典どおり uuid。';

-- ============================================================
-- 手動確認用（このバッチでは実行しない）
-- ============================================================
-- -- 0) overload が 1 つだけであること（PostgREST の曖昧化が無いこと）
-- -- select p.oid::regprocedure
-- --   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- --  where n.nspname = 'public' and p.proname = 'verify_attachment_delete_target';
-- --  → verify_attachment_delete_target(uuid,uuid) の 1 行だけ
--
-- -- 1) メンバーであり添付が現存する → outcome='found' + メタデータ
-- -- select * from public.verify_attachment_delete_target('<uuid>', '<calendar_uuid>');
--
-- -- 2) メンバーだが添付は削除済み → outcome='authoritatively-absent'、メタデータは null
--
-- -- 3) **メンバーを外された後** → outcome='unconfirmed'
-- --    （'authoritatively-absent' に**ならないこと**が本修正系列の核心）
--
-- -- 4) 一度もメンバーでないカレンダー → 'unconfirmed'。行の有無は一切開示されない
--
-- -- 5) 不正な添付ID（UUID でない文字列）→ 22P02 で拒否され、関数本体に入らない
-- -- select * from public.verify_attachment_delete_target('not-a-uuid', '<calendar_uuid>');
--
-- -- 6) 権限
-- -- select has_function_privilege('anon', 'public.verify_attachment_delete_target(uuid, uuid)', 'execute');           -- false
-- -- select has_function_privilege('authenticated', 'public.verify_attachment_delete_target(uuid, uuid)', 'execute');  -- true
