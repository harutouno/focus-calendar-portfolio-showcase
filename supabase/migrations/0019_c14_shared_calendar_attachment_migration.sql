-- P0030（QA-F007 C14、Phase 1: DB/Storage foundation）
--
-- 本ファイルは作成のみで、Supabaseへは適用しない（レビュー後にユーザー自身が実行する）。
-- 過去のmigrationファイル（0001〜0018）は一切変更しない。すべて`create or replace`
-- （関数）・新規`create policy`/`drop policy`（Storage RLS）・新規関数のみで構成する。
--
-- 対象（P0026〜P0029のDESIGN LOCKをそのままSQLへ落とす）:
--   A. Storage publication barrier（read/upsert helper分離 + SELECT policy置換）
--   B. attachment quota triggerのevent-row lock補強
--   C. shared calendar A→B の添付付きevent移動を1トランザクションで行うRPC
--   D. grants/revokes・確認用SQLコメント
--
-- 今回のスコープ外（次回P0032以降）:
--   client durable migration repository / move orchestration / NormalEventForm統合 /
--   EditEventScreen統合 / UI文言 / local↔shared migration（DATA-F007-005） /
--   recurring following/all bulk move / source Storage cleanup client retry /
--   DATA-F007-004（Unlinked Event Attachment Storage GC）
--
-- P0031で局所修正（本ファイルの内容が対象）:
--   全attachment rowをFOR UPDATEでlock（manifest ID部分lockのみだった問題を修正） /
--   exact setをstatusを問わない全row件数で判定（ready-only件数一致の抜け穴を修正） /
--   optimistic version gateのNULL迂回を拒否 / can_upsertからevent existence
--   oracleを削除 / manifestの必須key・型を厳格化 / metadata比較にwidth/height/
--   sortOrderを追加。詳細は各該当箇所のP0031コメントを参照。

-- ============================================================
-- A. Storage publication barrier
-- ============================================================

-- ------------------------------------------------------------
-- A1. can_read_event_attachment_storage_object(text)
--     P0027/P0029 DESIGN LOCKの実装。「人間が読めるか」を判定する唯一の関数。
--     Policy Aからのみ使う。
-- ------------------------------------------------------------
create or replace function public.can_read_event_attachment_storage_object(
  p_object_name text
) returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_folders text[];
  v_filename text;
  v_path_calendar_id uuid;
  v_row_calendar_id uuid;
begin
  if auth.uid() is null then
    return false;
  end if;

  -- パス規約: {calendarId}/{eventId}/{attachmentId}/original.jpg
  -- storage.foldername()はディレクトリ部分（先頭3セグメント）のみをtext[]で返し、
  -- storage.filename()は末尾のファイル名部分だけを返す（0008/0009で確立済みの
  -- storage.foldername(name)[1]パターンを、正確な4セグメント構造の検証へ拡張する）。
  v_folders := storage.foldername(p_object_name);
  v_filename := storage.filename(p_object_name);

  if v_folders is null or array_length(v_folders, 1) <> 3 then
    return false;
  end if;
  if v_filename is distinct from 'original.jpg' then
    return false;
  end if;

  -- segment1（calendarId）だけがuuid castを要する。segment2（eventId）はtext型の
  -- events.idと直接比較するためcastしない（0006_events_id_text.sql参照）。
  -- segment3（attachmentId）はevent_attachments.storage_pathとのexact match（下記の
  -- storage_path = p_object_name）で暗黙に照合されるため、ここで個別にcastしない。
  begin
    v_path_calendar_id := v_folders[1]::uuid;
  exception when others then
    return false;
  end;

  -- P0027 publication invariant: 生存するDB行・ready・未削除・exact storage_path一致・
  -- 生存するevent・event.calendar_id==path calendar・viewer以上、のすべてを満たす場合のみtrue。
  -- 将来thumbnail_pathが非nullになった場合は
  -- `where a.storage_path = p_object_name or a.thumbnail_path = p_object_name`
  -- へ拡張できる構造にしておく（P0027 4節）。現状thumbnail_pathは常にnullのため対象外。
  select e.calendar_id
    into v_row_calendar_id
  from public.event_attachments a
  join public.events e on e.id = a.event_id
  where a.storage_path = p_object_name
    and a.upload_status = 'ready'
    and a.deleted_at is null
  limit 1;

  if v_row_calendar_id is null then
    return false;
  end if;

  if v_row_calendar_id <> v_path_calendar_id then
    return false;
  end if;

  return public.is_calendar_member(v_row_calendar_id, 'viewer');
exception when others then
  -- 想定外の例外も含め、必ずfalseへ丸め込む（fail-closed）。
  return false;
end;
$$;

revoke all on function public.can_read_event_attachment_storage_object(text) from public;
grant execute on function public.can_read_event_attachment_storage_object(text) to authenticated;

-- ------------------------------------------------------------
-- A2. can_upsert_event_attachment_storage_object(text)
--     P0031（5節）による修正版。P0029 design reportの`v_event_id uuid`疑似コードは
--     採用しない（events.idはuuidではなくtext、0006_events_id_text.sql参照）。
--     Policy Bからのみ使う。target calendarのeditor + canonical path形状のみを検証し、
--     「eventがtarget calendarに属する」ことは要求しない（C14 Phase 1の時点では
--     eventはまだsource calendarに属したままのため）。event/source/target/manifestの
--     最終検証はC節のRPC自身がfinal authorityとして行う。P0030版にあった
--     「source eventの存在確認」（optional strengthening）はP0031で削除した
--     （5節: SECURITY DEFINER + authenticated EXECUTEのfunctionがpublic.eventsを
--     読むと、他calendarのevent idの存在有無を戻り値のtrue/falseから推測できる
--     RLS外のexistence oracleになるため）。
-- ------------------------------------------------------------
create or replace function public.can_upsert_event_attachment_storage_object(
  p_object_name text
) returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_folders text[];
  v_filename text;
  v_calendar_id uuid;
  v_event_id text;
  v_attachment_id uuid;
begin
  if auth.uid() is null then
    return false;
  end if;

  v_folders := storage.foldername(p_object_name);
  v_filename := storage.filename(p_object_name);

  if v_folders is null or array_length(v_folders, 1) <> 3 then
    return false;
  end if;
  if v_filename is distinct from 'original.jpg' then
    return false;
  end if;

  -- segment2（eventId）はtext型のままevents.idと比較する。`::uuid`へcastしない
  -- （0006_events_id_text.sqlにより非UUID形式の"evt_..."文字列が正規のevent idのため）。
  -- "evt_"prefixも必須化しない（0006より前のUUID文字列由来のevent idとの後方互換を壊さない）。
  v_event_id := v_folders[2];
  if v_event_id is null or length(v_event_id) = 0 then
    return false;
  end if;

  begin
    v_calendar_id := v_folders[1]::uuid;
    v_attachment_id := v_folders[3]::uuid;
  exception when others then
    return false;
  end;
  -- v_attachment_idは形状検証のためにcastするだけで、以降の判定には使わない
  -- （unused variable警告を避けるため、no-opの参照だけ残す）。
  perform v_attachment_id;

  -- P0031（5節）: public.eventsテーブルはこのhelperから一切読まない。event存在確認は
  -- C節のRPC自身がfinal authorityとして行う。v_event_idはpath形状検証（上の
  -- non-empty check）にのみ使う。

  -- target calendarのeditor以上（0001_init.sqlのis_calendar_member、'editor'は
  -- role in ('editor','owner')を満たす）。
  return public.is_calendar_member(v_calendar_id, 'editor');
exception when others then
  return false;
end;
$$;

revoke all on function public.can_upsert_event_attachment_storage_object(text) from public;
grant execute on function public.can_upsert_event_attachment_storage_object(text) to authenticated;

-- ------------------------------------------------------------
-- A3. 旧SELECT policyのDROP（P0029 2節: DROP無しの追加は禁止）
-- ------------------------------------------------------------
drop policy if exists "event_attachments_storage_select" on storage.objects;

-- ------------------------------------------------------------
-- A4. Policy A — generic publication SELECT（operation列挙なし、P0029 3節）
-- ------------------------------------------------------------
create policy "event_attachments_storage_select_publication"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'event-attachments'
    and public.can_read_event_attachment_storage_object(name)
  );

-- ------------------------------------------------------------
-- A5. Policy B — upload/upsert内部SELECT支援（operation-aware、P0029 4節）
--     upload/upsertが内部的に要求するSELECTだけを許可する。human read
--     （get/sign/list/info/render等）のfallbackではない。viewerは不可
--     （can_upsert_...がeditor以上を要求）。
--
--     operation-name nuance（P0030 8節）: `.upload(..., {upsert:true})`が実際に
--     `storage.object.upload`と`storage.object.upload_update`のどちらのcontextで
--     評価されるかは、新規objectか既存objectの上書きかによって変わりうる。
--     どちらのcontextでも同じhelper判定（target calendar editor + canonical path）で
--     一貫して許可されるべきため、両方をALLOWリストに含める
--     （P0030 19節のとおり、実際のoperation contextの実挙動はEXTERNAL_DB_VALIDATION_PENDING）。
-- ------------------------------------------------------------
create policy "event_attachments_storage_select_upsert_support"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'event-attachments'
    and storage.allow_any_operation(ARRAY[
      'storage.object.upload',
      'storage.object.upload_update'
    ])
    and public.can_upsert_event_attachment_storage_object(name)
  );

-- ------------------------------------------------------------
-- A6. 既存write policies（insert/update/delete）は変更しない。
--
--     報告事項（P0030 9節）: event_attachments_storage_insert/_update/_delete
--     （0008_event_attachments.sql）はいずれも
--       `((storage.foldername(name))[1])::uuid`
--     という直接castを使っており、malformedなpath（segment1がuuidとしてparse
--     できない文字列）を渡すと、policy評価自体がSQL例外を送出しうる
--     （A1/A2のようなbegin/exceptionでの捕捉を持たない）。
--
--     今回のsecurity invariantは
--       「malformed pathのwriteは絶対に成功してはならない」
--     であり、
--       「必ずcleanなRLS deny（成功/失敗の二値、例外なし）になる」
--     までは要求しない——例外による失敗も「書き込みが成立しない」という意味では
--     invariantを満たす。この差は11節の実DB test matrix・報告で正確に扱う
--     （malformedなpathでの書き込み試行はSQL例外として観測される可能性がある、
--     という前提でテスト項目23を設計する）。
-- ------------------------------------------------------------
-- （このセクションは意図的にDDLを含まない。既存policyへの変更なし。）

-- verify: select policyname, cmd, roles, qual
--   from pg_policies where schemaname = 'storage' and tablename = 'objects';
--   -- event_attachments_storage_select（旧broad viewer policy）が存在しないこと、
--   -- event_attachments_storage_select_publication・
--   -- event_attachments_storage_select_upsert_supportの2件だけがselect対象として
--   -- 存在すること、他バケット（calendar-covers等）のpolicyには一切変更が無いことを確認する。


-- ============================================================
-- B. attachment quota trigger: event-row lock補強
-- ============================================================
--
-- 過去のmigration（0008/0017）は編集しない。`create or replace function`で
-- 関数本体だけを置き換える（トリガー自体は0008で作成済み・関数名/シグネチャ不変のため
-- 再作成不要、0017のコメントと同じ扱い）。
--
-- 0017の全既存意味を維持する:
--   - free/premium画像枚数上限
--   - 1枚あたりのbyte上限
--   - 所有者横断の総byte上限
--   - exact storage path照合（calendar_id/event_id/idから再構築した正式パスとの完全一致）
--   - Storage object実サイズの読み取り・byte_size上書き
--   - event_id/storage_path変更禁止（TG_OP='UPDATE'時）
--   - plan判定（resolve_owner_plan経由）
--   - owner単位のadvisory xact lock
--
-- 追加する本質（P0030 10節）: event/calendar/ownerを確定する前に、対象event行を
-- lockする。目的は、別端末の通常create（このtrigger）と、C節のC14 migration RPCの
-- event移動処理が、同一event行に対してTOCTOUしないようにすること。
--
-- lock順序不変条件（P0030 10節）:
--   通常INSERT: event行 → owner advisory
--   C14 RPC:    event行 → owner advisory（決定論的順序） → attachment行
-- のいずれも「event行が常に先」であり、逆順で取得する経路は作らない
--   （C節のRPCも、event行を`for update`で最初にlockしてからowner advisory lockへ進む。
--    このtriggerがC14 RPCのトランザクション内でINSERT時に発火する場合、RPCは既に
--    同じevent行をより強いFOR UPDATEでlock済みのため、trigger内の`for share of e`は
--    同一トランザクション内での追加取得となり、PostgreSQLの行lockは同一トランザクション内で
--    自分自身をブロックしない——安全に完了する）。
create or replace function public.enforce_attachment_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calendar_id uuid;
  v_owner_id uuid;
  v_expected_storage_path text;
  v_object_size bigint;
  v_plan text;
  v_max_images int;
  v_max_bytes_per_image bigint;
  v_max_total_bytes bigint;
  v_current_images int;
  v_current_total_bytes bigint;
begin
  -- 正式な添付移動機能（C節のRPC）はevent_id/storage_pathを直接UPDATEしない
  -- （DELETE→INSERTのみ）ため、この既存の変更禁止トリガー契約はそのまま維持される。
  if TG_OP = 'UPDATE' then
    if new.event_id is distinct from old.event_id then
      raise exception 'attachment_event_change_not_allowed';
    end if;
    if new.storage_path is distinct from old.storage_path then
      raise exception 'attachment_storage_path_change_not_allowed';
    end if;
  end if;

  -- P0030（10節）で追加: calendar/ownerを確定するSELECTに`for share of e`を加え、
  -- 対象event行をSHARE-compatibleでlockしてから解決する（owner advisory lockより前）。
  select e.calendar_id, c.owner_id
    into v_calendar_id, v_owner_id
    from public.events e
    join public.calendars c on c.id = e.calendar_id
    where e.id = new.event_id
    for share of e;

  if v_owner_id is null then
    raise exception 'event_not_found';
  end if;

  v_expected_storage_path := v_calendar_id::text || '/' || new.event_id || '/' || new.id::text || '/original.jpg';
  if new.storage_path <> v_expected_storage_path then
    raise exception 'attachment_storage_path_mismatch';
  end if;

  select (o.metadata->>'size')::bigint
    into v_object_size
    from storage.objects o
    where o.bucket_id = 'event-attachments'
      and o.name = new.storage_path;

  if v_object_size is null then
    raise exception 'attachment_storage_object_not_found';
  end if;

  new.byte_size := v_object_size;

  perform pg_advisory_xact_lock(hashtext(v_owner_id::text));

  v_plan := public.resolve_owner_plan(v_owner_id);

  if v_plan = 'premium' then
    v_max_images := 5;
    v_max_bytes_per_image := 3 * 1024 * 1024;
    v_max_total_bytes := 200 * 1024 * 1024;
  else
    v_max_images := 1;
    v_max_bytes_per_image := 1 * 1024 * 1024;
    v_max_total_bytes := 20 * 1024 * 1024;
  end if;

  if new.byte_size > v_max_bytes_per_image then
    raise exception 'attachment_too_large';
  end if;

  select count(*) into v_current_images
    from public.event_attachments a
    where a.event_id = new.event_id
      and a.upload_status = 'ready'
      and a.deleted_at is null
      and a.id <> new.id;

  if v_current_images >= v_max_images then
    raise exception 'attachment_event_limit';
  end if;

  select coalesce(sum(a.byte_size), 0) into v_current_total_bytes
    from public.event_attachments a
    join public.events e2 on e2.id = a.event_id
    join public.calendars c2 on c2.id = e2.calendar_id
    where c2.owner_id = v_owner_id
      and a.upload_status = 'ready'
      and a.deleted_at is null
      and a.id <> new.id;

  if v_current_total_bytes + new.byte_size > v_max_total_bytes then
    raise exception 'attachment_quota_exceeded';
  end if;

  return new;
end;
$$;

-- 関数名・シグネチャは不変のため、既存の2つのトリガー（0008のBEFORE INSERT、
-- 0017のBEFORE UPDATE OF event_id, storage_path, byte_size）はいずれも再作成不要。


-- ============================================================
-- B2. event calendar move guard（添付付きeventの直接move禁止）
-- ============================================================
--
-- P0033（1節 invariant A）: eventに1件でもattachment DB rowが存在する場合、通常の
-- events UPDATE/UPSERT（calendar_id変更）でcalendar移動することを禁止する。添付付き
-- shared A→B moveは、C節のC14 atomic RPC（move_shared_event_and_attachments）だけが
-- 成立経路となる。clientがRPCを使うことを信用するのではなく、DB triggerで強制する
-- （invariant B: clientの善意に依存しないfail-closed設計）。
--
-- 直接bypass経路の実例（P0033 10節Bの証拠）: src/services/sharedEventsService.tsの
-- appEventToRow()はevent.calendarIdを無条件にrowへ設定し、upsertSharedEvent()は
-- `supabase.from("events").upsert(row, { onConflict: "id" })`をそのまま呼ぶ。
-- 0001_init.sqlの`events_update_editor`policy（USING/WITH CHECKともに
-- is_calendar_member(calendar_id, 'editor')のみを要求）は、caller が新旧どちらの
-- calendarでもeditorであれば、通常のUPDATE経路でのcalendar_id変更を許可してしまう
-- ——attachment行の有無を一切見ない。このtriggerが無い場合、添付付きeventも
-- このRPCを経由せず直接moveできてしまう。
--
-- C14 RPC自身はこのguardに抵触しない: RPCのmutation順序は
--   old source attachment DB rows DELETE → event calendar UPDATE → new destination行INSERT
-- のままであり（14節、変更なし）、event UPDATE時点では対象eventのattachment行は
-- 同一トランザクション内で既に0件までDELETE済みのため、下記guardのexists検査は
-- 常にfalseとなりallowされる（5節の並行性証明も参照）。
create or replace function public.guard_event_calendar_move_with_attachments()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- calendar_idが実際に変わる場合のみ検査する（同一calendarへの再UPDATEや
  -- title/memo等の通常編集はcalendar_id同値のため常にallow）。event_attachmentsは
  -- upload_status/deleted_atで絞り込まない——1件でも行があれば理由を問わず拒否する。
  if new.calendar_id is distinct from old.calendar_id
     and exists (
       select 1
       from public.event_attachments ea
       where ea.event_id = old.id
     ) then
    raise exception 'event_calendar_move_requires_attachment_migration';
  end if;

  return new;
end;
$$;

drop trigger if exists events_guard_calendar_move_with_attachments
  on public.events;

create trigger events_guard_calendar_move_with_attachments
  before update of calendar_id on public.events
  for each row
  execute function public.guard_event_calendar_move_with_attachments();

-- 本functionはtrigger専用。authenticatedロールへの直接EXECUTE grantは追加しない
-- （PostgreSQLがtrigger発火時に内部的に呼び出すため、clientからのRPC的直接呼び出しは
-- 想定・許可しない）。

-- P0033（5節）: concurrency proof（設計証拠として固定、実DB実証はEXTERNAL_DB_VALIDATION_PENDING）。
--
-- (1) 通常attachment INSERT vs 直接event calendar UPDATEの2順序:
--     通常attachment INSERT（enforce_attachment_quota、BEFORE INSERT）は最初に
--       `select e.calendar_id, c.owner_id from events e join calendars c ...
--        where e.id = new.event_id for share of e`
--     でevent行をFOR SHAREでlockする。直接event calendar UPDATEはevent行に対する
--     通常のexclusive row lockを取得したのち、このguard triggerがexists()で
--     attachment行の有無を見る。
--
--     順序A（INSERTが先にcommit）: INSERTのFOR SHAREロックが先に確保・commit済みなら、
--     新しいattachment行が存在する状態でguardのexists()がtrueを返し、直接moveは
--     `event_calendar_move_requires_attachment_migration`でreject される。
--
--     順序B（UPDATEが先にlockを確保、その時点でattachment行が0件）: guardは0件を見て
--     直接moveをallowし、UPDATEがcommitする。その後ブロックされていたINSERTのFOR SHAREが
--     再開すると、enforce_attachment_quotaは（committed後の）fresh event.calendar_idから
--     `v_expected_storage_path`を再構築するため、client側が古いcalendar_idを前提に
--     計算したstorage_pathとは一致しなくなり、`attachment_storage_path_mismatch`で
--     拒否される。したがって「guardが0行を見た直後に、古いcalendar_id前提のattachment行が
--     commitする」という不整合な状態は発生しない。
--
-- (2) C14 RPC（move_shared_event_and_attachments）:
--     RPCはevent行をFOR UPDATEで保持したまま、全source attachment行のFOR UPDATE→DELETE→
--     event calendar UPDATE→destination行INSERTを単一トランザクション内で順に行う（14節、
--     変更なし）。通常attachment INSERTのFOR SHAREロック要求は、RPCがevent行のFOR UPDATEを
--     保持している間ブロックされ続けるため、「source行DELETE後・event UPDATE前」の
--     ゼロ行windowに割り込むことはできない。RPC自身のevent UPDATEはこのguardのexists()検査
--     時点で対象event配下のattachment行がまさに0件（同トランザクション内で既にDELETE済み）と
--     なるため、常にallowされる。

-- verify（guardが実際に添付付きeventの直接moveを拒否することの確認、実DBでのみ
-- 可能。EXTERNAL_DB_VALIDATION_PENDING）:
-- update public.events set calendar_id = '<other-calendar-uuid>'
--   where id = '<event-id-with-attachments>';
-- -- expect: ERROR:  event_calendar_move_requires_attachment_migration


-- ============================================================
-- C. shared calendar A→B の添付付きevent移動RPC
-- ============================================================
--
-- 対象: shared calendar A → shared calendar B、単一event（scope=single）のみ。
-- local↔shared（DATA-F007-005）・recurring following/all bulk moveはこのRPCの対象外
-- （P0026/P0029 DESIGN LOCKのまま、今回実装しない）。
--
-- event本体の編集内容は、caller供給のJSONを任意列へ展開せず、固定された個別引数
-- （p_title, p_date, ...）として明示的に受け取る（P0030 15節「caller JSONを任意列へ
-- 展開しない」「dynamic SQLを避ける」を、jsonbのdynamic unpackingすら行わない形で満たす）。
-- 添付migration manifestだけはjsonb配列で受け取るが、各要素は固定のkey名
-- （'sourceAttachmentId'等）でアクセスするのみで、列名・テーブル名を動的構築しない。
--
-- destination storage pathはこのRPCがサーバー側で再構築する（calendar_id/event_id/
-- destinationAttachmentIdから、cloudAttachmentRepository.tsのbuildStoragePathと
-- 同じ規則）。client供給のstoragePathはsource側の検証にのみ使い、DBへ書き込む
-- destination側の値としては信用しない。
create or replace function public.move_shared_event_and_attachments(
  p_event_id text,
  p_source_calendar_id uuid,
  p_target_calendar_id uuid,
  p_expected_updated_at timestamptz,
  p_title text,
  p_date date,
  p_start_time text,
  p_end_time text,
  p_all_day boolean,
  p_location text,
  p_duration_minutes int,
  p_restricted_apps jsonb,
  p_unlock_condition jsonb,
  p_notification jsonb,
  p_repeat jsonb,
  p_memo text,
  p_completed boolean,
  p_recurring_group_id text,
  p_recurrence_index int,
  -- p_attachment_manifest: jsonb配列。各要素は固定key名でのみアクセスする:
  --   sourceAttachmentId (uuid text), destinationAttachmentId (uuid text),
  --   storagePath (source側の期待storage_path、検証専用), mimeType, byteSize (bigint text),
  --   width, height, sortOrder。createdBy/createdAtはclientから受け取らない
  --   （サーバー側でsource行から決定する、P0030 15節「サーバー側でsource行から決定」）。
  p_attachment_manifest jsonb
) returns table (
  event_id text,
  source_calendar_id uuid,
  target_calendar_id uuid,
  committed_updated_at timestamptz,
  source_attachment_ids uuid[],
  destination_attachment_ids uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid;
  v_event record;
  v_source_owner uuid;
  v_target_owner uuid;
  v_lock_first uuid;
  v_lock_second uuid;
  v_manifest_count int;
  v_source_ids uuid[] := '{}';
  v_dest_ids uuid[] := '{}';
  v_created_by_arr uuid[] := '{}';
  v_created_at_arr timestamptz[] := '{}';
  v_width_arr int[] := '{}';
  v_height_arr int[] := '{}';
  v_sort_order_arr int[] := '{}';
  v_mime_arr text[] := '{}';
  v_byte_size_arr bigint[] := '{}';
  v_elem jsonb;
  v_row public.event_attachments%rowtype;
  v_expected_source_path text;
  v_expected_dest_path text;
  v_object_size bigint;
  v_total_row_count int;
  v_new_updated_at timestamptz;
  v_idx int;
  v_source_attachment_id uuid;
  v_destination_attachment_id uuid;
begin
  -- 1. auth.uid() non-null
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'unauthenticated';
  end if;

  -- P0033（6節）: event行lockより前の入力形状検証。p_event_id/p_source_calendar_id/
  -- p_target_calendar_idがNULLまたは空文字のリクエストを、以降のいかなるlock取得よりも
  -- 前に拒否する。
  if p_event_id is null or btrim(p_event_id) = ''
     or p_source_calendar_id is null
     or p_target_calendar_id is null then
    raise exception 'invalid_plan';
  end if;

  if p_source_calendar_id = p_target_calendar_id then
    raise exception 'invalid_plan';
  end if;

  -- P0031（4節）: optimistic version gateをNULLで迂回できないようにする。
  -- `updated_at <> NULL`はSQLの三値論理でNULL（=falsey）になり、後続のif文が
  -- 発火せずチェックをすり抜けてしまうため、入口で明示的にNULLを拒否する。
  if p_expected_updated_at is null then
    raise exception 'invalid_plan';
  end if;

  -- P0031（8節）: NULL manifestを明示的に拒否する。`jsonb_typeof(NULL)`はNULLを
  -- 返すため、旧`<> 'array'`比較だけではNULL入力がすり抜けてしまう（三値論理で
  -- 同じ理由）。空配列（添付0件のevent）は正当なケースとして許可する。
  if p_attachment_manifest is null or jsonb_typeof(p_attachment_manifest) <> 'array' then
    raise exception 'invalid_plan';
  end if;
  v_manifest_count := jsonb_array_length(p_attachment_manifest);

  -- P0032（4節）: 0017の絶対上限（premium plan = 5枚/event、
  -- enforce_attachment_quota()のv_max_images参照。この定数と同期を保つ必要がある）を、
  -- event行FOR UPDATEより前に適用不可能なplanを拒否する形で先に課す。目的は、
  -- 実行不可能なmanifestに対してevent row lock・source/target owner advisory lockを
  -- 取得してしまう「lock amplification」を防ぎ、後続のmanifest要素ループ（重複ID
  -- スキャン等）を最大5要素までに制限すること。
  if v_manifest_count > 5 then
    raise exception 'invalid_plan';
  end if;

  -- P0033（7節）: event行lockより前のpre-authorization。unauthorized callerが
  -- source/target calendar UUIDだけを使ってforeign event rowのFOR UPDATE lockを
  -- 取得できてしまう（targeted availability abuse）ことを防ぐ。このprecheckは
  -- final authorityではない——lock取得後に同じチェックを再度行う（9節）。
  if not public.is_calendar_member(p_source_calendar_id, 'editor') then
    raise exception 'permission_denied';
  end if;
  if not public.is_calendar_member(p_target_calendar_id, 'editor') then
    raise exception 'permission_denied';
  end if;

  -- 2〜3. event exists、event行をFOR UPDATEで最初にlock（owner advisory lockより前）。
  -- P0033（8節）: lock対象predicateにevent idだけでなくp_source_calendar_idを含める
  -- （e.calendar_id = p_source_calendar_id）。これにより、callerがeditorである別の
  -- calendarのIDをsourceとして偽装申告しても、無関係なforeign eventのFOR UPDATE lockを
  -- 取得することができなくなる（該当行が無ければ単にnot foundとなり、下のsource_changedへ
  -- 落ちる）。
  select e.* into v_event
  from public.events e
  where e.id = p_event_id
    and e.calendar_id = p_source_calendar_id
  for update;

  if not found then
    raise exception 'source_changed';
  end if;

  -- 4. event.calendar_id == expected source（上のWHERE条件で既に保証されるが、
  -- 意図を明示する防御的な再確認として維持する）。
  if v_event.calendar_id <> p_source_calendar_id then
    raise exception 'source_changed';
  end if;

  -- 5. event.updated_at == expected（楽観的並行性制御）。IS DISTINCT FROMを使い、
  -- NULLが絡んでも必ずtrue/falseへ確定させる（P0031 4節、`<>`単独への依存を禁止）。
  -- p_expected_updated_atのNULLは入口で既に拒否済みだが、この比較自体も
  -- 独立してnull-safeにしておく。
  if v_event.updated_at is distinct from p_expected_updated_at then
    raise exception 'source_changed';
  end if;

  -- 6〜7. source/target calendar editor（呼び出し本人の現在の権限）。
  -- P0033（9節）: これはpost-lock recheckであり、正本（final authority）である。
  -- 7節のpre-authorizationはlock取得前の早期拒否のみが目的で、ここを削除・弱化しない
  -- ——lock取得〜ここに至るまでの間にcallerの権限がpreflight直後に変わった場合、
  -- このrecheckで確実に止める。
  if not public.is_calendar_member(p_source_calendar_id, 'editor') then
    raise exception 'permission_denied';
  end if;
  if not public.is_calendar_member(p_target_calendar_id, 'editor') then
    raise exception 'permission_denied';
  end if;

  -- 8. source/target ownerをサーバー側で解決（callerの申告を信用しない）
  select owner_id into v_source_owner from public.calendars where id = p_source_calendar_id;
  select owner_id into v_target_owner from public.calendars where id = p_target_calendar_id;
  if v_source_owner is null then
    raise exception 'source_changed';
  end if;
  if v_target_owner is null then
    raise exception 'permission_denied';
  end if;

  -- 9. owner advisory lockを値のdeterministic順序で取得（ABBAデッドロック回避）
  if v_source_owner::text < v_target_owner::text then
    v_lock_first := v_source_owner;
    v_lock_second := v_target_owner;
  else
    v_lock_first := v_target_owner;
    v_lock_second := v_source_owner;
  end if;
  perform pg_advisory_xact_lock(hashtext(v_lock_first::text));
  if v_lock_second <> v_lock_first then
    perform pg_advisory_xact_lock(hashtext(v_lock_second::text));
  end if;

  -- P0031（2節）: event行FOR UPDATE・owner advisory lock取得後に、対象eventに属する
  -- 全attachment row（statusを問わず）をFOR UPDATEでlockする。manifest IDだけの
  -- 部分lockを正本にしない——このlockにより、通常create（quota triggerが先に
  -- event行をFOR SHARE OF eで要求するため待たされる）・他の削除/更新操作（同じ
  -- event配下の行に対するFOR UPDATE）のいずれも、このtransactionのcommit/rollback
  -- までブロックされる。manifest件数に関わらず（0件でも）常に実行する。
  -- P0032（2節）: RETURNS TABLEの`event_id`列はPL/pgSQL上OUT parameter変数として
  -- 扱われるため、event_attachments.event_idへの参照は必ず`ea`等のtable aliasで
  -- 修飾する（未修飾`event_id`はOUT変数とのambiguityになりうる）。
  perform 1
    from public.event_attachments ea
    where ea.event_id = p_event_id
    for update;

  -- source/destination attachment ID配列を組み立てつつ、各manifest要素の必須key・
  -- 型をこの時点で検証する（P0031 6節: 欠落・型不正はいずれもinvalid_plan）。
  for v_elem in select * from jsonb_array_elements(p_attachment_manifest)
  loop
    if not (
      v_elem ? 'sourceAttachmentId' and v_elem ? 'destinationAttachmentId' and
      v_elem ? 'storagePath' and v_elem ? 'mimeType' and v_elem ? 'byteSize' and
      v_elem ? 'width' and v_elem ? 'height' and v_elem ? 'sortOrder'
    ) then
      raise exception 'invalid_plan';
    end if;

    -- P0032（3節）: JSON null（keyは存在するが値がnull）のsourceAttachmentId/
    -- destinationAttachmentIdを明示的に拒否する。`->>`はJSON nullに対してSQL NULLを
    -- 返すため、対策なしだと後続の`(NULL)::uuid`castが例外を送出せず成功してしまい
    -- （NULL::uuidとして）すり抜ける可能性がある。
    if v_elem->>'sourceAttachmentId' is null or v_elem->>'destinationAttachmentId' is null then
      raise exception 'invalid_plan';
    end if;

    begin
      v_source_attachment_id := (v_elem->>'sourceAttachmentId')::uuid;
      v_destination_attachment_id := (v_elem->>'destinationAttachmentId')::uuid;
    exception when others then
      raise exception 'invalid_plan';
    end;

    -- 防御的に、cast後の値自体も改めてNULLでないことを確認する。
    if v_source_attachment_id is null or v_destination_attachment_id is null then
      raise exception 'invalid_plan';
    end if;

    -- P0032（3節、DESIGN LOCK）: sourceAttachmentId != destinationAttachmentIdを
    -- 直接固定する。同一IDだとDELETE→INSERTの順序次第で新規行のデータが失われる、
    -- またはprimary key制約違反等の未定義動作になりうるため。
    if v_source_attachment_id = v_destination_attachment_id then
      raise exception 'invalid_plan';
    end if;

    if coalesce(v_elem->>'storagePath', '') = '' then
      raise exception 'invalid_plan';
    end if;
    if v_elem->>'mimeType' is null then
      raise exception 'invalid_plan';
    end if;
    if (v_elem->>'byteSize') is null then
      raise exception 'invalid_plan';
    end if;
    begin
      perform (v_elem->>'byteSize')::bigint;
    exception when others then
      raise exception 'invalid_plan';
    end;
    -- width/height: integerまたはJSON null（key自体は必須、値はnull許容）。
    if (v_elem->>'width') is not null then
      begin
        perform (v_elem->>'width')::int;
      exception when others then
        raise exception 'invalid_plan';
      end;
    end if;
    if (v_elem->>'height') is not null then
      begin
        perform (v_elem->>'height')::int;
      exception when others then
        raise exception 'invalid_plan';
      end;
    end if;
    -- sortOrder: integer、null不可。
    if (v_elem->>'sortOrder') is null then
      raise exception 'invalid_plan';
    end if;
    begin
      perform (v_elem->>'sortOrder')::int;
    exception when others then
      raise exception 'invalid_plan';
    end;

    if v_source_attachment_id = any(v_source_ids) then
      raise exception 'invalid_plan'; -- manifest内の重複sourceId
    end if;
    if v_destination_attachment_id = any(v_dest_ids) then
      raise exception 'invalid_plan'; -- manifest内の重複destinationId
    end if;
    v_source_ids := array_append(v_source_ids, v_source_attachment_id);
    v_dest_ids := array_append(v_dest_ids, v_destination_attachment_id);
  end loop;

  -- 11. source manifest完全一致（exact set・no extra・no missing）。
  -- P0031（3節）: ready行だけの件数一致ではなく、statusを問わない全row件数で
  -- 判定する。manifest外にuploading/failed/soft-deleted行が1件でも混在していれば
  -- 総件数がmanifest件数と一致しなくなり、必ず検出される（対象event配下の全行は
  -- 既に上でFOR UPDATE済み）。
  select count(*) into v_total_row_count
    from public.event_attachments ea
    where ea.event_id = p_event_id;
  if v_total_row_count <> v_manifest_count then
    raise exception 'source_attachment_conflict';
  end if;

  -- 各manifest要素について、DB行の実態と1件ずつ完全一致することを確認し、
  -- サーバー側で確定させたcreated_by/created_at/width/height/sort_order/mime_type/
  -- byte_sizeを配列へ積み上げる（clientの申告値はここでは書き込みに使わない）。
  for v_idx in 1 .. v_manifest_count loop
    v_elem := p_attachment_manifest -> (v_idx - 1);
    v_source_attachment_id := v_source_ids[v_idx];

    select ea.* into v_row
      from public.event_attachments ea
      where ea.id = v_source_attachment_id
        and ea.event_id = p_event_id;

    if not found then
      raise exception 'source_attachment_conflict';
    end if;
    if v_row.upload_status <> 'ready' then
      raise exception 'source_attachment_conflict';
    end if;
    if v_row.deleted_at is not null then
      raise exception 'source_attachment_conflict';
    end if;
    if v_row.thumbnail_path is not null then
      -- 初版C14はthumbnail移行未対応（P0026 4節/P0030 12節）。
      raise exception 'invalid_plan';
    end if;

    v_expected_source_path := p_source_calendar_id::text || '/' || p_event_id || '/' || v_source_attachment_id::text || '/original.jpg';
    if v_row.storage_path <> v_expected_source_path then
      raise exception 'source_attachment_conflict';
    end if;
    -- P0031（7節）: manifestとlocked source rowの完全一致比較（null-safe、6節の
    -- 必須key検証により全keyが既に存在・型検証済みのため無条件で比較する）。
    if (v_elem->>'storagePath') is distinct from v_row.storage_path then
      raise exception 'source_attachment_conflict';
    end if;
    if (v_elem->>'mimeType') is distinct from v_row.mime_type then
      raise exception 'source_attachment_conflict';
    end if;
    if (v_elem->>'byteSize')::bigint is distinct from v_row.byte_size then
      raise exception 'source_attachment_conflict';
    end if;
    if (v_elem->>'width')::int is distinct from v_row.width then
      raise exception 'source_attachment_conflict';
    end if;
    if (v_elem->>'height')::int is distinct from v_row.height then
      raise exception 'source_attachment_conflict';
    end if;
    if (v_elem->>'sortOrder')::int is distinct from v_row.sort_order then
      raise exception 'source_attachment_conflict';
    end if;

    -- サーバー側の実態をそのまま保持する（15節: createdBy/createdAtはclientから受け取らない）。
    v_created_by_arr := array_append(v_created_by_arr, v_row.created_by);
    v_created_at_arr := array_append(v_created_at_arr, v_row.created_at);
    v_width_arr := array_append(v_width_arr, v_row.width);
    v_height_arr := array_append(v_height_arr, v_row.height);
    v_sort_order_arr := array_append(v_sort_order_arr, v_row.sort_order);
    v_mime_arr := array_append(v_mime_arr, v_row.mime_type);
    v_byte_size_arr := array_append(v_byte_size_arr, v_row.byte_size);
  end loop;

  -- 13. destination検証: exact object exists・size一致・canonical path・
  --     destinationAttachmentIdの既存DB行衝突無し。
  for v_idx in 1 .. v_manifest_count loop
    v_destination_attachment_id := v_dest_ids[v_idx];
    v_expected_dest_path := p_target_calendar_id::text || '/' || p_event_id || '/' || v_destination_attachment_id::text || '/original.jpg';

    select (o.metadata->>'size')::bigint into v_object_size
      from storage.objects o
      where o.bucket_id = 'event-attachments'
        and o.name = v_expected_dest_path;

    if v_object_size is null then
      raise exception 'destination_storage_missing';
    end if;
    if v_object_size <> v_byte_size_arr[v_idx] then
      raise exception 'destination_storage_size_mismatch';
    end if;

    if exists (select 1 from public.event_attachments where id = v_destination_attachment_id) then
      raise exception 'invalid_plan'; -- destinationAttachmentIdが既存行と衝突
    end if;
  end loop;

  -- 14. mutation順序（変更しない）: old DELETE → event UPDATE → new INSERT → 最終quota。
  if v_manifest_count > 0 then
    delete from public.event_attachments ea
      where ea.event_id = p_event_id
        and ea.id = any(v_source_ids);
  end if;

  update public.events
    set
      title = p_title,
      date = p_date,
      start_time = p_start_time,
      end_time = p_end_time,
      all_day = p_all_day,
      location = p_location,
      duration_minutes = p_duration_minutes,
      restricted_apps = coalesce(p_restricted_apps, '[]'::jsonb),
      unlock_condition = p_unlock_condition,
      notification = p_notification,
      repeat = p_repeat,
      memo = p_memo,
      completed = p_completed,
      recurring_group_id = p_recurring_group_id,
      recurrence_index = p_recurrence_index,
      calendar_id = p_target_calendar_id
    where id = p_event_id
    returning updated_at into v_new_updated_at;

  if not found then
    raise exception 'source_changed';
  end if;

  -- 新規destination行をINSERT（既存event_attachments_enforce_quota[_on_update]
  -- トリガーがBEFORE INSERTでそのまま発火し、target calendar/owner基準で枚数・
  -- 総容量・exact path・Storage実サイズを再判定する——B節の変更により、この時点で
  -- 対象event行は既にこのRPC自身がFOR UPDATEで保持済みのため、トリガー内の
  -- `for share of e`はブロックされず安全に完了する）。
  for v_idx in 1 .. v_manifest_count loop
    insert into public.event_attachments (
      id, event_id, storage_path, thumbnail_path, mime_type, byte_size,
      width, height, sort_order, upload_status, created_by, created_at
    ) values (
      v_dest_ids[v_idx],
      p_event_id,
      p_target_calendar_id::text || '/' || p_event_id || '/' || v_dest_ids[v_idx]::text || '/original.jpg',
      null,
      v_mime_arr[v_idx],
      v_byte_size_arr[v_idx],
      v_width_arr[v_idx],
      v_height_arr[v_idx],
      v_sort_order_arr[v_idx],
      'ready',
      v_created_by_arr[v_idx],
      v_created_at_arr[v_idx]
    );
  end loop;

  return query select p_event_id, p_source_calendar_id, p_target_calendar_id, v_new_updated_at, v_source_ids, v_dest_ids;
end;
$$;

revoke all on function public.move_shared_event_and_attachments(
  text, uuid, uuid, timestamptz, text, date, text, text, boolean, text, int,
  jsonb, jsonb, jsonb, jsonb, text, boolean, text, int, jsonb
) from public;
grant execute on function public.move_shared_event_and_attachments(
  text, uuid, uuid, timestamptz, text, date, text, text, boolean, text, int,
  jsonb, jsonb, jsonb, jsonb, text, boolean, text, int, jsonb
) to authenticated;


-- ============================================================
-- D. grants/revokes・確認用SQLコメントのまとめ
-- ============================================================
--
-- 本migrationで新規に定義したSECURITY DEFINER関数はいずれも
-- `revoke all ... from public; grant execute ... to authenticated;`を伴う
-- （0001/0016/0017の既存パターンと同一）。個別のrevoke/grant文は各関数定義の
-- 直後に記載済み（重複掲載しない）。

-- verify（新規helper・trigger functionが正しく定義されていることの確認）:
-- select proname, prosecdef, provolatile from pg_proc
--   where proname in (
--     'can_read_event_attachment_storage_object',
--     'can_upsert_event_attachment_storage_object',
--     'move_shared_event_and_attachments',
--     'guard_event_calendar_move_with_attachments'
--   );

-- verify（P0033: guard triggerがpublic.eventsに正しく登録されていることの確認）:
-- select tgname, tgrelid::regclass, tgenabled from pg_trigger
--   where tgname = 'events_guard_calendar_move_with_attachments';

-- verify（Storage policy inventoryの確認、A6のコメント参照）:
-- select policyname, cmd, roles, qual from pg_policies
--   where schemaname = 'storage' and tablename = 'objects'
--   order by policyname;

-- verify（quota triggerの関数本体が置換されていることの確認。トリガー自体の
-- oid/作成日時は不変のはずだが、関数のsource（pg_get_functiondef）で
-- `for share of e`が含まれることを確認する）:
-- select pg_get_functiondef('public.enforce_attachment_quota'::regproc);

-- verify（RPCの基本的な入力検証、実DBでのみ実行可能。EXTERNAL_DB_VALIDATION_PENDING）:
-- select * from public.move_shared_event_and_attachments(
--   '<event-id>', '<source-calendar-uuid>', '<target-calendar-uuid>',
--   '<expected-updated-at-iso>', '<title>', '<date>', '<start-time>', null,
--   false, null, null, '[]'::jsonb, null, '{"enabled":false,"minutesBefore":0}'::jsonb,
--   '{"type":"none"}'::jsonb, null, false, null, null, '[]'::jsonb
-- );
