-- 単独修正(2026-08): FP-003「所有共有カレンダーの作成上限をサーバー側でも強制する」。
--
-- 背景: public.calendarsのRLS（0001の"calendars_insert_self"）はowner_id = auth.uid()しか
-- 見ておらず、件数の上限チェックが無い。作成経路（calendarService.createSharedCalendar）は
-- RPCを介さず直接INSERTしているため、UI側のAlertだけでは改変クライアント・直接API呼び出し・
-- 同時作成による上限超過を防げない。
--
-- 重要な前提（調査の結果、判明した事実）: 「マイカレンダー」（自分一人用＋追加の個人用
-- カレンダー）はSupabaseに一切保存されておらず、端末内AsyncStorageのみで管理されている
-- （UserCalendar型にowner_idすら存在しない）。そのため本migrationは、実在するSupabase
-- テーブルpublic.calendars（＝「自分が所有する共有カレンダー」）の上限だけを対象にする。
-- マイカレンダーの上限をサーバー側で強制する手段は、現状のアーキテクチャには存在しない
-- （差異管理台帳FP-011として別途記録する、今回はこの制約を解消しない）。
--
-- 単独修正(2026-08、補正): 初版はowner_id変更（UPDATE）時に新所有者の上限を確認して
-- 「上限内なら譲渡を許可する」という設計だったが、Focus Calendarには正式な所有権譲渡
-- 機能が存在しない。上限を確認して譲渡を許可するのではなく、一般クライアントからの
-- owner_id変更自体を禁止する方針へ改めた（3節参照）。所有権譲渡機能を正式に追加する
-- 場合は、専用RPC・譲渡相手の承認・上限確認・calendar_membersとの整合性維持を備えた
-- 別工程として実装すること。
--
-- 0012〜0015は無編集。適用順は 0012 → 0013 → 0014 → 0015 → 0016。0016自体はai_usage_*
-- テーブル/RPCへ一切触れないため、この0016単体の適用にai-support Edge Functionの
-- 再デプロイは不要。

-- ============================================================
-- 1. is_premium_active_for(p_user_id): 対象ユーザーを明示的に指定するプレミアム判定
-- ============================================================
-- 0014のis_premium_active()はauth.uid()固定（呼び出し本人の判定専用）。calendarsの
-- トリガーはNEW.owner_id（作成・譲渡先の対象所有者）を判定する必要があり、auth.uid()に
-- 暗黙依存すると「本人以外の所有者を指定した経路」で誤判定しうる。そのため対象user_idを
-- 明示的に受け取る内部専用版を追加する（一般ユーザーへは絶対にgrantしない＝他人の資格を
-- 取得できるRPCにはしない）。
create or replace function public.is_premium_active_for(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_entitlements e
    where e.user_id = p_user_id
      and e.entitlement_key = 'premium'
      and e.status = 'active'
      and e.starts_at <= now()
      and (e.expires_at is null or e.expires_at > now())
  );
$$;

revoke all on function public.is_premium_active_for(uuid) from public;

-- ============================================================
-- 2. enforce_owned_shared_calendar_limit(): BEFORE INSERT
-- ============================================================
-- 対象所有者ごとにトランザクションスコープのadvisory lockで直列化してから件数を数え直す
-- ことで、同時作成による上限超過（count確認→INSERTの間に別トランザクションが割り込む
-- レース）を防ぐ。ロックはトランザクション終了時に自動解放され、対象ユーザーにつき
-- 単一の名前空間しか使わないため、ロック順序を意識する必要はない。
--
-- 上限値（無料3・プレミアム10）はsrc/constants/calendarLimits.tsの
-- FREE_SHARED_CALENDAR_LIMIT/PREMIUM_SHARED_CALENDAR_LIMITと手動で同期する
-- （0008のenforce_attachment_quota()がattachmentLimits.tsと手動同期しているのと同じ
-- 既存の運用方式）。この定数を変更する場合は、必ずこの関数の数値も合わせて変更すること。
--
-- 単独修正(2026-08、補正)でINSERT専用に単純化した。owner_idは3節のトリガーで
-- 変更自体を禁止するため、「譲渡時に新所有者の上限を確認する」という分岐は
-- 不要になった（所有権譲渡が正式に対応しているように見える構造を残さないため、
-- あえて削除する）。
create or replace function public.enforce_owned_shared_calendar_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_premium boolean;
  v_limit int;
  v_owned_count int;
begin
  perform pg_advisory_xact_lock(hashtext(new.owner_id::text));

  v_is_premium := public.is_premium_active_for(new.owner_id);
  v_limit := case when v_is_premium then 10 else 3 end;

  select count(*) into v_owned_count
    from public.calendars c
   where c.owner_id = new.owner_id;

  if v_owned_count >= v_limit then
    raise exception 'owned_shared_calendar_limit_exceeded';
  end if;

  return new;
end;
$$;

drop trigger if exists calendars_enforce_owned_limit_insert on public.calendars;
create trigger calendars_enforce_owned_limit_insert
  before insert on public.calendars
  for each row execute function public.enforce_owned_shared_calendar_limit();

-- ============================================================
-- 3. prevent_calendar_owner_change(): owner_idを不変にする（BEFORE UPDATE OF owner_id）
-- ============================================================
-- Focus Calendarには正式な所有権譲渡機能が存在しない。既存の"calendars_update_owner"
-- RLSポリシー（0001）はowner権限の有無だけを見ており、UPDATE後のowner_id自体を
-- 制限していないため、既存所有者がowner_idを任意の別ユーザーへ書き換えられる経路が
-- 開いていた（上限を回避して所有数を減らす、他人へ押し付ける等）。
--
-- 対応方針: RLSポリシー自体は変更しない（既存のUSING/WITH CHECK条件を弱めるリスクを
-- 避けるため）。かわりに、OLD/NEWの値を確実に比較できるBEFORE UPDATE OF owner_idの
-- トリガーでowner_idの変更そのものを一般クライアントから禁止する。この方式は
-- RLSのWITH CHECK句だけでOLD値と比較するより確実で、ロールに関わらず一律に働く。
-- "UPDATE OF owner_id"のためname/color/cover_image_urlだけの通常更新（owner_idを
-- SET句に含まない）はこのトリガー自体が発火せず、既存の編集機能に影響しない。
-- owner_idを同じ値のままSET句に含めた場合もIS DISTINCT FROMがfalseになるため妨げない。
create or replace function public.prevent_calendar_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'calendar_owner_change_not_allowed';
  end if;
  return new;
end;
$$;

drop trigger if exists calendars_enforce_owned_limit_update on public.calendars;
drop trigger if exists calendars_prevent_owner_change on public.calendars;
create trigger calendars_prevent_owner_change
  before update of owner_id on public.calendars
  for each row execute function public.prevent_calendar_owner_change();

-- verify (許可されているロールが内部関数を直接実行できないことの確認):
-- select grantee, privilege_type from information_schema.routine_privileges
--   where routine_name in ('is_premium_active_for', 'enforce_owned_shared_calendar_limit');
-- verify (無料ユーザーで3件所有した状態から4件目を試み、例外を確認する):
-- insert into public.calendars (name, color, owner_id) values ('4th', '#000000', '<free-user-uuid>');
-- verify (owner_idの変更が拒否されることの確認。オーナー本人のセッションで実行する):
-- update public.calendars set owner_id = '<other-user-uuid>' where id = '<calendar-uuid>';
-- verify (トリガーが両方登録されていることの確認):
-- select tgname from pg_trigger where tgrelid = 'public.calendars'::regclass and not tgisinternal;
