-- =====================================================================
-- 0029 — events_end_date_valid_check の NULL 通過を塞ぐ（最小修正）
--
-- FINDING_ID           CORRECT-F016-RUNTIME-001
-- SOURCE_INVENTORY_ID  2A-CON-045
-- SOURCE_MIGRATION     0021_normal_event_end_date.sql（**編集しない**）
-- ROOT_CAUSE_FAMILY    SQL CHECK NULL/UNKNOWN PASS-THROUGH
--
-- 事象
--   branch 4 は `end_date = (date + 1)` を IS NOT NULL ガード無しで比較している。
--   end_date が NULL のとき比較結果が NULL となり、branch 全体が UNKNOWN、
--   OR 全体も UNKNOWN になる。PostgreSQL の CHECK 制約は式が NULL のとき通過するため、
--   overnight（end_time < start_time）なのに end_date を持たない行が
--   INSERT / UPDATE の両経路で受理されていた（ローカル実 Postgres で実測）。
--
-- 修正範囲
--   branch 4 に `end_date IS NOT NULL` を追加するのみ。
--   branch 1 / 2 / 3 と他の条件は今回の finding を理由に一切変更しない。
--   branch 3 は既に `end_time IS NOT NULL` で短絡するため UNKNOWN 化しない。
--   NULL を受け取れる列は end_time / end_date のみ（kind・date・start_time・all_day は NOT NULL）。
--
-- validation state について（重要）
--   現行 constraint は convalidated = true だが、本 migration では
--   新しい constraint を **NOT VALID** で追加する。
--   理由: 既存 production 行の状態は UNKNOWN であり、
--         旧（緩い）条件で通っていた行が新（厳しい）条件に違反している可能性がある。
--         無条件に VALIDATE すると未知の既存行を理由に migration 全体が失敗する。
--   本 migration の目的は future INSERT / future UPDATE の強制を正すこと。
--   NOT VALID でも新規の INSERT / UPDATE は検査される。
--   既存行の検査・backfill・VALIDATE CONSTRAINT は、
--   production データを安全に確認できる後続 gate へ分離する。
--
--   VALIDATION_STATE_CHANGE = true -> false（意図的。上記理由による）
-- =====================================================================

alter table public.events
  drop constraint if exists events_end_date_valid_check;

alter table public.events
  add constraint events_end_date_valid_check check (
    ((kind <> 'normal') and (end_date is null))
    or ((kind = 'normal') and all_day and (end_date is null))
    or ((kind = 'normal') and (not all_day) and (end_time is not null)
        and (end_time > start_time) and (end_date is null))
    or ((kind = 'normal') and (not all_day) and (end_time is not null)
        and (end_time < start_time)
        and (end_date is not null)              -- ★ 今回追加した唯一の変更
        and (end_date = (date + 1)))
  ) not valid;

-- ---------------------------------------------------------------------
-- 手動確認用（本 migration では実行しない）
--
--   -- 既存行のうち新条件に違反するものを数える（後続 gate 用）
--   select count(*) from public.events e
--    where not (
--      ((e.kind <> 'normal') and (e.end_date is null))
--      or ((e.kind = 'normal') and e.all_day and (e.end_date is null))
--      or ((e.kind = 'normal') and (not e.all_day) and (e.end_time is not null)
--          and (e.end_time > e.start_time) and (e.end_date is null))
--      or ((e.kind = 'normal') and (not e.all_day) and (e.end_time is not null)
--          and (e.end_time < e.start_time) and (e.end_date is not null)
--          and (e.end_date = (e.date + 1)))
--    );
--
--   -- 上が 0 であることを確認できたときだけ実行する
--   -- alter table public.events validate constraint events_end_date_valid_check;
-- ---------------------------------------------------------------------
