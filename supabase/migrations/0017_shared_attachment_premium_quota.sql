-- 単独修正(2026-08): FP-004「共有予定の画像制限へ所有者のプレミアム資格を反映する」。
--
-- 背景: 0008のresolve_owner_plan(p_user_id)は`select 'free'::text;`に固定されており、
-- 共有カレンダーの所有者が実際にプレミアムでも、画像添付の枚数・容量上限は常に無料枠
-- （1枚/1MB/合計50MB）しか適用されなかった。本migrationは「どのプランを適用するか」の
-- 判定だけを実データ(user_entitlements)基準へ差し替える。上限の数値そのもの
-- （1/5枚、1MB/3MB、50MB/1GB）、圧縮アルゴリズム、RLSポリシー、Storage構成は一切変更しない。
--
-- 0012〜0016は無編集。適用順は 0012 → 0013 → 0014 → 0015 → 0016 → 0017。0017は
-- ai_usage_*テーブル/RPCへ一切触れないため、この0017単体の適用にai-support Edge
-- Functionの再デプロイは不要。
--
-- 単独修正(2026-08、FP-009): 上記の「50MB/1GB」は、その後の正式決定でマイカレンダー
-- （端末内）予定専用の値であることが確定した。共有カレンダー（クラウド）予定の総容量は
-- 本ファイル内のenforce_attachment_quota()・get_attachment_quota_status()の両方で
-- 20MB/200MBへ縮小済み（詳細は各関数内のコメントを参照）。1/5枚・1MB/3MBは
-- FP-004時点から変更していない。

-- ============================================================
-- 1. resolve_owner_plan(p_user_id): 固定'free'を実データ判定へ差し替え
-- ============================================================
-- 0016で追加済みのis_premium_active_for(uuid)（呼び出し本人ではなく指定user_idを判定する
-- 内部専用関数）をそのまま再利用する。0016のenforce_owned_shared_calendar_limit()が
-- 既に同じ関数をSECURITY DEFINERトリガーから直接呼び出す前例があるため、同様の呼び出しは
-- 安全（is_premium_active_for自体はrevoke all from publicのみでauthenticatedにも
-- grantしていないが、SECURITY DEFINER関数同士の内部呼び出しには影響しない）。
-- 対象ユーザーが存在しない・資格レコードが無い・期限切れ等はis_premium_active_forが
-- falseを返すため、常に安全側(free)へフォールバックする。
create or replace function public.resolve_owner_plan(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.is_premium_active_for(p_user_id) then 'premium' else 'free' end;
$$;

revoke all on function public.resolve_owner_plan(uuid) from public;
grant execute on function public.resolve_owner_plan(uuid) to authenticated;

-- ============================================================
-- 2. enforce_attachment_quota(): 所有者単位のadvisory lockで同時INSERTを直列化
--    ＋Storage実サイズをサイズ判定の正本にする（単独追加修正）
-- ============================================================
-- 0008にはロックが無く、「枚数を数える→INSERTする」の間に別トランザクションが割り込む
-- TOCTOUレースが存在した（同一所有者・同一/別イベントへの同時アップロードが両方とも
-- 上限チェックを通過しうる）。0016と同じ方式で、対象所有者(v_owner_id)へトランザクション
-- スコープのadvisory lockを取ってから枚数・総容量の両方を数え直す。ロックは
-- プラン判定より前・両チェックより前で1回だけ取るため、ロック順序は常に単一
-- （owner_id一本）でありデッドロックの心配はない。エラーコード・チェック順序・
-- 総容量の集計範囲（所有者が持つ全カレンダー横断）は既存のまま変更しない。
--
-- 単独追加修正1: 従来はNEW.byte_size（クライアントがINSERT時に指定した申告値）を
-- そのまま1枚上限・総容量の判定に使っていた。remoteAttachmentRepository.insertAttachmentRow
-- はクライアントが計算したbyteSizeをそのままevent_attachments.byte_sizeへ渡すだけであり、
-- INSERT自体にStorage側の実サイズとの照合は一切無かった。cloudAttachmentRepository.create()は
-- 必ず「Storageへのアップロード成功 → event_attachmentsへのINSERT」の順で呼ぶため
-- （uploadAttachmentBytes→insertAttachmentRow）、このトリガーが実行される時点で対象の
-- Storage object（bucket: event-attachments）は既に存在し、storage.objects.metadata
-- （jsonb、Supabase Storageがアップロード時に書き込む実サイズ・mimetype等。
-- @supabase/storage-jsのFileMetadata型が定義する'size'キーと同じ実体）から実サイズを
-- 読み取れる。よって、NEW.byte_sizeを信用せず、storage.objectsから取得した実サイズで
-- 上書きしてから判定・登録する。
--
-- 単独追加修正2（本節）: cloudAttachmentRepository.buildStoragePath()が生成する正式
-- Storageパスは`{calendarId}/{eventId}/{attachmentId}/original.jpg`の4要素constである。
-- 修正1の時点では第1階層(calendar_id)しか照合しておらず、第2階層(event_id)・
-- 第3階層(attachment_id)・ファイル名までは未照合だった。そのため、同じ共有カレンダー内の
-- 別イベント用object・別attachment用objectを対象イベント/対象添付行へ関連付けられる
-- 余地が残っていた。本修正では、v_calendar_id・NEW.event_id・NEW.idからサーバー側で
-- 正式パスを組み立て、NEW.storage_pathとの完全一致を要求する（一致しなければ
-- attachment_storage_path_mismatchで拒否）。これにより第1〜3階層とファイル名の
-- すべてが暗黙に照合される（構築した文字列と1文字でも違えば不一致になるため）。
--
-- 単独追加修正3（本節）: 正式な添付移動機能が存在しないため、event_attachments作成後の
-- event_id・storage_pathは不変とする。UPDATE時（TG_OP='UPDATE'）にOLD.event_idまたは
-- OLD.storage_pathがNEW側と異なる場合は、後続の一切の処理より前に拒否する
-- （attachment_event_change_not_allowed / attachment_storage_path_change_not_allowed）。
-- 同じ値の再送（upsertの冪等リトライ）はIS DISTINCT FROMがfalseになるため妨げない。
-- byte_sizeだけの変更（Storage再アップロード後の再送等）は許可し、後段で必ず
-- Storage実サイズへ再上書きする。
--
-- 併せて（既存): 同一idでの再送（remoteAttachmentRepository.insertAttachmentRowのupsert、
-- onConflict:"id"）がBEFORE INSERTトリガーを経由しないままevent_id/storage_path/byte_size
-- を書き換えられる経路を塞ぐため、本関数をBEFORE UPDATE OF event_id, storage_path, byte_size
-- にもバインドする（本節末尾のトリガー参照）。deleted_at・upload_status等それ以外の列だけの
-- 更新（softDeleteAttachment等）ではこのUPDATE版トリガー自体が発火しないため、既存の
-- 削除・状態更新フローに影響はない。
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
  -- 正式な添付移動機能は存在しないため、既存行のevent_id・storage_pathの変更を
  -- 一律禁止する（UPDATE時のみ意味を持つ。INSERT時はOLDが存在しないため対象外）。
  if TG_OP = 'UPDATE' then
    if new.event_id is distinct from old.event_id then
      raise exception 'attachment_event_change_not_allowed';
    end if;
    if new.storage_path is distinct from old.storage_path then
      raise exception 'attachment_storage_path_change_not_allowed';
    end if;
  end if;

  select e.calendar_id, c.owner_id
    into v_calendar_id, v_owner_id
    from public.events e
    join public.calendars c on c.id = e.calendar_id
    where e.id = new.event_id;

  if v_owner_id is null then
    raise exception 'event_not_found';
  end if;

  -- NEW.storage_pathが、対象イベントのカレンダーID・NEW.event_id・NEW.idから
  -- 決まる正式パスと完全一致することを要求する（第1〜3階層とファイル名すべてを
  -- 一度の文字列比較で照合する）。一致しなければ、同じカレンダー内の別イベント用
  -- object・別attachment用object・別カレンダーのobject・任意の不正なパスのいずれも
  -- ここで一律に拒否される。
  v_expected_storage_path := v_calendar_id::text || '/' || new.event_id || '/' || new.id::text || '/original.jpg';
  if new.storage_path <> v_expected_storage_path then
    raise exception 'attachment_storage_path_mismatch';
  end if;

  -- NEW.byte_size（クライアント申告値）は信用しない。上記で正式パスと完全一致することを
  -- 確認したstorage_pathのStorage object実サイズだけを正本にする。該当objectが
  -- 存在しない（未アップロード等）場合は登録を拒否する。
  select (o.metadata->>'size')::bigint
    into v_object_size
    from storage.objects o
    where o.bucket_id = 'event-attachments'
      and o.name = new.storage_path;

  if v_object_size is null then
    raise exception 'attachment_storage_object_not_found';
  end if;

  new.byte_size := v_object_size;

  -- 同一所有者への同時INSERTを直列化する（枚数・総容量の両チェックを単一ロックの下で
  -- 行うことで、ロック順序の不一致によるデッドロックを避ける。0016と同じ方式）。
  perform pg_advisory_xact_lock(hashtext(v_owner_id::text));

  v_plan := public.resolve_owner_plan(v_owner_id);

  -- FP-009(2026-08): 共有カレンダー(クラウド)予定の画像総容量を20MB/200MBへ正式縮小した
  -- （旧50MB/1GBは端末内(マイカレンダー)予定専用の値として存置、src/constants/
  -- attachmentLimits.tsのLOCAL_ATTACHMENT_TOTAL_BYTES/CLOUD_ATTACHMENT_TOTAL_BYTESを参照）。
  -- 1予定あたりの枚数(1/5枚)・1枚あたりの上限(1MB/3MB)は変更しない。
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

-- 関数名・シグネチャは不変のため、既存トリガーevent_attachments_enforce_quota
-- (0008で作成済み、BEFORE INSERT)は再作成不要。CREATE OR REPLACEした本体をそのまま使い続ける。
--
-- 単独追加修正: 同一idでの再送（upsert）や直接UPDATEによるevent_id/storage_path/byte_size
-- の書き換えがINSERT用トリガーを経由しない問題に対応するため、UPDATE OF event_id,
-- storage_path, byte_sizeにも同じ関数をバインドする（event_idを追加した理由:
-- storage_pathを変えずにevent_idだけを書き換えると、枚数上限を別イベントへ実質的に
-- 移し替えられてしまうため、この列単体の変更も検知する必要がある）。関数内のTG_OP='UPDATE'
-- 分岐がevent_id・storage_pathの変更そのものを拒否し、byte_sizeだけの変更は許可した上で
-- 常にStorage実サイズへ上書きする。upload_status・deleted_at等それ以外の列だけを
-- 更新するsoftDeleteAttachment等の既存フローはこのトリガー自体が発火しないため、影響しない。
drop trigger if exists event_attachments_enforce_quota_on_update on public.event_attachments;
create trigger event_attachments_enforce_quota_on_update
  before update of event_id, storage_path, byte_size on public.event_attachments
  for each row execute function public.enforce_attachment_quota();

-- ============================================================
-- 3. get_attachment_quota_status(): クライアント表示用の安全な状態取得RPC
-- ============================================================
-- クライアント(NormalEventForm/useEventAttachments)が「このカレンダーの予定に
-- 画像を追加してよいか・あと何枚/何バイトか」を、所有者の資格詳細を一切見せずに
-- 取得するためのRPC。所有者のuser_entitlements行・billingステータス・source・
-- starts_at/expires_atは返さない。呼び出し本人がそのカレンダーのメンバーで
-- ない場合はcalendar_not_found例外にする（メンバー外であることと存在しないことを
-- 区別しない＝アクセス可否の情報を漏らさない）。
-- p_event_idはnull許容: 新規作成ドラフト段階（実eventsレコードがまだ無い）でも
-- calendar_idだけで枚数上限・総容量の判定ができるようにするため。
create or replace function public.get_attachment_quota_status(
  p_calendar_id uuid,
  p_event_id text default null
)
returns table (
  max_files_per_event int,
  max_file_size_bytes bigint,
  total_storage_limit_bytes bigint,
  current_event_file_count int,
  current_used_bytes bigint,
  remaining_bytes bigint,
  can_upload boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_event_calendar_id uuid;
  v_plan text;
  v_max_images int;
  v_max_bytes_per_image bigint;
  v_max_total_bytes bigint;
  v_event_count int;
  v_total_bytes bigint;
  v_can_edit boolean;
begin
  if not public.is_calendar_member(p_calendar_id, 'viewer') then
    raise exception 'calendar_not_found';
  end if;

  select c.owner_id into v_owner_id
    from public.calendars c
    where c.id = p_calendar_id;

  if v_owner_id is null then
    raise exception 'calendar_not_found';
  end if;

  v_can_edit := public.is_calendar_member(p_calendar_id, 'editor');
  v_plan := public.resolve_owner_plan(v_owner_id);

  -- FP-009(2026-08): enforce_attachment_quota()と同じく20MB/200MBへ正式縮小
  -- （このRPCが返すtotal_storage_limit_bytesをクライアントの正本にするため、
  -- 実際の強制ロジックと必ず同じ数値を使う）。
  if v_plan = 'premium' then
    v_max_images := 5;
    v_max_bytes_per_image := 3 * 1024 * 1024;
    v_max_total_bytes := 200 * 1024 * 1024;
  else
    v_max_images := 1;
    v_max_bytes_per_image := 1 * 1024 * 1024;
    v_max_total_bytes := 20 * 1024 * 1024;
  end if;

  if p_event_id is not null then
    -- p_event_idがp_calendar_idに実際に属することをここで検証する。検証しないと、
    -- アクセス可能な自分のカレンダーIDと、無関係な別カレンダーのevent_idを
    -- 組み合わせて渡すことで、そのイベントの枚数情報だけを不正に取得できてしまう
    -- （例: 他人の共有カレンダーのevent_idを、自分がメンバーのcalendar_idと
    -- 一緒に渡すケース）。一致しない/存在しない場合はevent_not_found
    -- （0008のenforce_attachment_quotaと同じ既存エラーコードを流用する）。
    select e.calendar_id into v_event_calendar_id
      from public.events e
      where e.id = p_event_id;

    if v_event_calendar_id is null or v_event_calendar_id <> p_calendar_id then
      raise exception 'event_not_found';
    end if;

    select count(*) into v_event_count
      from public.event_attachments a
      where a.event_id = p_event_id
        and a.upload_status = 'ready'
        and a.deleted_at is null;
  else
    v_event_count := 0;
  end if;

  select coalesce(sum(a.byte_size), 0) into v_total_bytes
    from public.event_attachments a
    join public.events e2 on e2.id = a.event_id
    join public.calendars c2 on c2.id = e2.calendar_id
    where c2.owner_id = v_owner_id
      and a.upload_status = 'ready'
      and a.deleted_at is null;

  return query select
    v_max_images,
    v_max_bytes_per_image,
    v_max_total_bytes,
    v_event_count,
    v_total_bytes,
    greatest(v_max_total_bytes - v_total_bytes, 0),
    (v_can_edit and v_event_count < v_max_images and v_total_bytes < v_max_total_bytes);
end;
$$;

revoke all on function public.get_attachment_quota_status(uuid, text) from public;
grant execute on function public.get_attachment_quota_status(uuid, text) to authenticated;

-- verify (プレミアム所有者のカレンダーで5枚/3MB/200MB[クラウド用、FP-009で1GBから縮小]が
-- 適用されることの確認):
-- select public.resolve_owner_plan('<premium-owner-uuid>'); -- 'premium'を期待
-- select public.resolve_owner_plan('<free-owner-uuid>');    -- 'free'を期待
-- verify (get_attachment_quota_statusが無料20MB/プレミアム200MBを返すことの確認。
-- 1GB/50MBが返らないこと＝端末内専用の値と混同していないことを確認する):
-- select total_storage_limit_bytes from public.get_attachment_quota_status('<free-owner-calendar-id>', null); -- 20971520 (20MB)を期待
-- select total_storage_limit_bytes from public.get_attachment_quota_status('<premium-owner-calendar-id>', null); -- 209715200 (200MB)を期待
-- verify (無料所有者のイベントで2枚目のINSERTがattachment_event_limitで拒否されることの確認。
-- 単独追加修正により、正式パス（{calendar-id}/{event-id}/{attachment-id}/original.jpg、
-- id=<unique-attachment-id>と完全一致すること）でStorage APIへ実アップロード済みのobjectが
-- 無いと登録できないため、事前に実アップロードしてから同じパスでINSERTすること):
-- insert into public.event_attachments (id, event_id, storage_path, mime_type, byte_size, created_by)
--   values ('<unique-attachment-id>', '<event-id>', '<calendar-id>/<event-id>/<unique-attachment-id>/original.jpg', 'image/jpeg', 100000, '<uploader-uuid>');
-- verify (byte_sizeにクライアント申告値ではなくStorage実サイズが登録されることの確認。
-- 上のINSERT直後、実際にアップロードした実サイズと一致し、100000ではないことを確認する):
-- select byte_size from public.event_attachments where id = '<unique-attachment-id>';
-- verify (存在しないstorage_pathを指定するとattachment_storage_object_not_foundで拒否されることの確認。
-- パス自体は正式形式に一致させ、objectだけを未アップロードのままにする):
-- insert into public.event_attachments (id, event_id, storage_path, mime_type, byte_size, created_by)
--   values ('<unique-attachment-id-2>', '<event-id>', '<calendar-id>/<event-id>/<unique-attachment-id-2>/original.jpg', 'image/jpeg', 100000, '<uploader-uuid>');
-- verify (同じカレンダー内の別イベント用パス・別attachment用パス・別カレンダーのパスの
-- いずれを指定してもattachment_storage_path_mismatchで拒否されることの確認。
-- <other-event-id>は同じカレンダーの別イベント、<other-attachment-id>は既存の別添付、
-- <other-calendar-id>は無関係な別カレンダー):
-- insert into public.event_attachments (id, event_id, storage_path, mime_type, byte_size, created_by)
--   values ('<unique-attachment-id-3>', '<event-id>', '<calendar-id>/<other-event-id>/<unique-attachment-id-3>/original.jpg', 'image/jpeg', 100000, '<uploader-uuid>');
-- insert into public.event_attachments (id, event_id, storage_path, mime_type, byte_size, created_by)
--   values ('<unique-attachment-id-4>', '<event-id>', '<calendar-id>/<event-id>/<other-attachment-id>/original.jpg', 'image/jpeg', 100000, '<uploader-uuid>');
-- insert into public.event_attachments (id, event_id, storage_path, mime_type, byte_size, created_by)
--   values ('<unique-attachment-id-5>', '<event-id>', '<other-calendar-id>/<event-id>/<unique-attachment-id-5>/original.jpg', 'image/jpeg', 100000, '<uploader-uuid>');
-- verify (event_idだけをUPDATEするとattachment_event_change_not_allowedで拒否されることの確認。
-- storage_pathだけをUPDATEするとattachment_storage_path_change_not_allowedで拒否されることの確認。
-- 両方を同時に別イベントへ変更しようとしても、event_id側の変更検知が先に働き拒否される):
-- update public.event_attachments set event_id = '<other-event-id>' where id = '<unique-attachment-id>';
-- update public.event_attachments set storage_path = '<calendar-id>/<event-id>/<other-attachment-id>/original.jpg' where id = '<unique-attachment-id>';
-- verify (同じevent_id・同じstorage_pathを値ごと再送するupsertは拒否されず、byte_sizeだけが
-- Storage実サイズへ再上書きされることの確認。deleted_at・upload_statusだけの更新（論理削除・
-- 状態遷移）はこのUPDATE版トリガー自体を発火させないことも合わせて確認する):
-- update public.event_attachments set event_id = event_id, storage_path = storage_path, byte_size = 1 where id = '<unique-attachment-id>'; -- 実サイズへ再上書きされ、event_id/storage_pathは拒否されないことを期待
-- update public.event_attachments set deleted_at = now() where id = '<unique-attachment-id>'; -- トリガー非発火・成功することを期待
-- verify (新しいRPCが所有者の資格詳細を一切含まず、必要な7列だけを返すことの確認):
-- select * from public.get_attachment_quota_status('<calendar-id>', '<event-id-or-null>');
-- verify (viewerロールのメンバーはcan_upload=falseになることの確認。viewerセッションで実行):
-- select can_upload from public.get_attachment_quota_status('<calendar-id>', null);
-- verify (一般ロールが内部関数を直接実行できないことの確認):
-- select grantee, privilege_type from information_schema.routine_privileges
--   where routine_name in ('resolve_owner_plan', 'get_attachment_quota_status');
-- verify (無関係な別カレンダーのevent_idを組み合わせて渡すとevent_not_foundになることの確認。
-- <calendar-id>は自分がメンバーのカレンダー、<other-calendar-event-id>は別カレンダーの予定):
-- select * from public.get_attachment_quota_status('<calendar-id>', '<other-calendar-event-id>');
