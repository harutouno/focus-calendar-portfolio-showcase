-- P0078 DATA-F014-001: 共有カレンダー内の通常予定「同一カレンダー内編集」を、
-- 楽観的排他制御（CAS: compare-and-swap）で保護するRPC。
--
-- 背景（実バグ）: これまでの共有予定の同一カレンダー内保存
-- （sharedEventsService.upsertSharedEvent）は無条件の.upsert()で、events.updated_at
-- （バージョン）を一切確認していなかった。そのため:
--   1. AがV1を開く
--   2. B（または別端末のRealtime反映）がV2へタイトルを変更する
--   3. Aが（V2を認識しないまま）メモだけを変更して保存する
--   4. AのV1ベースの保存がV2のタイトルを含む全フィールドをそのまま上書きする
-- という、他者の新しい変更を検知なく静かに上書きする実データ損失が起きていた。
--
-- 修正方針: 単一のUPDATE文でid一致・現在のupdated_at一致・editor権限の3条件を
-- 同時に検証する。行ロック（for update）を先に取ることで、2つの並行呼び出しが
-- どちらも「一致した」と誤認する競合（TOCTOU）を防ぐ（同じ行への並行呼び出しは
-- 後者が必ず「実は既に更新された後」を見ることになり、確実にconflictへ倒れる）。
--
-- 出力（outcome）:
--   committed      -- 保存成功。committed_updated_atに新しいバージョンを返す。
--   conflict       -- expected_updated_atが現在のDBの値と一致しない
--                     （他者が先に更新済み）。committed_updated_atに現在値を返す
--                     （呼び出し元がreload案内等に使える）。
--   not_found      -- 指定idの行が存在しない（削除済み等）。
--   not_authorized -- 呼び出し元がこのカレンダーのeditor権限を持たない。
--
-- カレンダー移動（calendar_id変更）はこのRPCの対象外。既存のC14 atomic RPC
-- （0019）が引き続きその唯一の経路であり、本RPCはcalendar_id自体を一切
-- 更新しない（SET句に含めない）。
--
-- 適用方法: Supabaseダッシュボード → SQL Editor に貼り付けて実行する。
-- 本batchでは未適用（コード上のレビューのみ）。0021（end_date列追加）を先に
-- 適用しておく必要がある（このRPCがp_end_dateを書き込むため）。

create or replace function public.update_normal_event_with_version_check(
  p_event_id text,
  p_expected_updated_at timestamptz,
  p_title text,
  p_date date,
  p_start_time text,
  p_end_time text,
  p_end_date date,
  p_all_day boolean,
  p_location text,
  p_notification jsonb,
  p_repeat jsonb,
  p_memo text,
  p_completed boolean
)
returns table (committed_updated_at timestamptz, outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calendar_id uuid;
  v_current_updated_at timestamptz;
  v_new_updated_at timestamptz;
begin
  -- 行ロックを取ってから比較する（for update）。これにより、同じ行への2つの
  -- 並行呼び出しが両方とも「一致した」と誤認してどちらもUPDATEしてしまう競合を防ぐ
  -- ——後から実行される呼び出しは、前の呼び出しのcommitを必ず見てから比較する。
  select calendar_id, updated_at
    into v_calendar_id, v_current_updated_at
  from public.events
  where id = p_event_id
    and kind = 'normal'
  for update;

  if v_calendar_id is null then
    return query select null::timestamptz, 'not_found'::text;
    return;
  end if;

  -- events_update_editorのRLSポリシーと同一の権限判定
  -- （SECURITY DEFINERはRLSを迂回するため、ここで明示的に検証する）。
  if not public.is_calendar_member(v_calendar_id, 'editor') then
    return query select null::timestamptz, 'not_authorized'::text;
    return;
  end if;

  if v_current_updated_at <> p_expected_updated_at then
    return query select v_current_updated_at, 'conflict'::text;
    return;
  end if;

  update public.events
  set
    title = p_title,
    date = p_date,
    start_time = p_start_time,
    end_time = p_end_time,
    end_date = p_end_date,
    all_day = p_all_day,
    location = p_location,
    notification = p_notification,
    repeat = p_repeat,
    memo = p_memo,
    completed = p_completed
  where id = p_event_id
  returning updated_at into v_new_updated_at;

  return query select v_new_updated_at, 'committed'::text;
end;
$$;

revoke all on function public.update_normal_event_with_version_check(
  text, timestamptz, text, date, text, text, date, boolean, text, jsonb, jsonb, text, boolean
) from public;
grant execute on function public.update_normal_event_with_version_check(
  text, timestamptz, text, date, text, text, date, boolean, text, jsonb, jsonb, text, boolean
) to authenticated;

-- verify: select proname, prosecdef from pg_proc where proname = 'update_normal_event_with_version_check';
-- verify（想定シナリオ、手動実行用）:
--   1. 通常予定を1件作成し、そのid・updated_atを控える。
--   2. select public.update_normal_event_with_version_check(id, 控えたupdated_at, ...新しい値...)
--      を呼び、outcome='committed'・committed_updated_atが更新されることを確認する。
--   3. 同じ古いupdated_at（控えた値、既に古い）で再度呼び、outcome='conflict'・
--      committed_updated_atが手順2の新しいupdated_atと一致することを確認する。
--   4. 存在しないidで呼び、outcome='not_found'を確認する。
--   5. editor権限を持たない（viewerのみの）カレンダーの予定に対して呼び、
--      outcome='not_authorized'を確認する。
