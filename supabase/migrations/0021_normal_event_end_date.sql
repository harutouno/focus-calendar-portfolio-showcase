-- P0078 CORRECT-F016-001: 通常予定の終了時刻が日付をまたぐ場合の暦日を、
-- サーバー側でも正しく永続化するための列を追加する。
--
-- 背景: これまでevents.end_timeは"HH:mm"の時刻のみで、終了が開始日の翌日に
-- 繰り上がる場合（例: 23:40開始→翌日00:40終了）を表現できなかった。クライアント側は
-- 23:59へクランプすることで矛盾を隠していたが、これは誤った終了時刻を保存する実バグ
-- だった（正本の禁止事項）。クライアント側の修正（NormalEvent.endDate、
-- src/utils/time.tsのresolveEndDate）と対にして、共有カレンダーの予定でも
-- 同じ情報を失わず往復できるようにする。
--
-- 設計方針（最小表現）:
--   * end_dateはnullable。nullは「dateと同一日」を意味する（クライアント側の
--     NormalEvent.endDate===undefinedと対応）。日付をまたがない大多数の予定・
--     全日予定・focusの行は従来どおりnullのまま。
--   * 既存行はマイグレーション適用時点で自動的にnull（＝dateと同一日）になる。
--     これは移行前のend_timeが常に同日の時刻だった（クライアントが23:59へクランプ
--     していた）という既存の実際の制約と矛盾しない、安全な後方互換値。
--   * RLS（events_select_members / events_insert_editor / events_update_editor /
--     events_delete_editor）は行全体に対する既存ポリシーのままで、新しい列にも
--     そのまま適用される。列追加自体はポリシーの変更を必要としない。
--
-- 適用方法: Supabaseダッシュボード → SQL Editor に貼り付けて実行する
-- （SUPABASE_SETUP.md参照）。本batchでは未適用（コード上のレビューのみ）。

alter table public.events
  add column if not exists end_date date;

comment on column public.events.end_date is
  'P0078 CORRECT-F016-001: 終了時刻の暦日。nullはdateと同一日を意味する（最小表現）。通常予定(kind=normal)のみ使用し、日付をまたぐ終了時刻を持つ場合のみdateの翌日を設定する。';

-- [P0080 CORRECT-F016-002] end_dateのhardening: クライアント側の唯一の投影権限
-- （src/utils/eventDaySlice.ts）・resolveEndDate（src/utils/time.ts）が保証する不変条件
-- 「本アプリの通常予定は複数日にまたがらない。end_dateはnull（=dateと同一日）か、
-- dateの厳密に翌日のいずれかしかあり得ない」を、DB側でも制約として強制する。
-- 既存行は移行前のend_timeが常に同日の時刻だった（クライアントが23:59へクランプしていた）
-- ため、マイグレーション適用時点で全行end_date is nullであり、この制約に違反しない
-- （0021の元コメント参照——安全な後方互換backfill）。end_date is nullを常に許可する
-- ことで、通常予定以外（kind=focus・全日予定）の行や、将来のバックフィル漏れに対しても
-- fail-closedではなく既存動作互換のまま制約を追加できる。
--
-- [P0082 MIG-F016-001] PostgreSQLは`ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS`を
-- サポートしない（`IF NOT EXISTS`が有効なのは`ADD COLUMN`・`CREATE INDEX`等の一部の句のみ）。
-- 以前のこのファイルはこの無効な構文をそのまま含んでいた（実DBには未適用のため実害はまだ
-- 発生していないが、将来この行を実際に実行すれば構文エラーで失敗する）。`pg_constraint`を
-- 事前に確認してから`ALTER TABLE ... ADD CONSTRAINT`（IF NOT EXISTS節なし）を実行する
-- `DO`ブロックに置き換える。`conrelid = 'public.events'::regclass`と`conname`の両方で
-- 絞り込むことで、たまたま同名だが意味の異なる制約（他テーブルの同名制約等）を誤って
-- 「既に存在する」と判定してスキップしない。
--
-- [P0084 MIG-F016-002] P0082の時点ではconname・conrelidの一致だけを見て「既に存在する」と
-- 判定していたが、これは同名（events_end_date_valid_check）だが実際の条件式が異なる
-- 制約（例: 過去の手動変更・将来の別マイグレーションとの衝突等）が既に存在していても
-- 気づかず無条件にスキップしてしまう——結果としてDBには「意図しない条件のCHECK制約」が
-- 適用済みのまま放置される。`pg_get_constraintdef(oid)`で実際の定義文字列を取得し、
-- 空白・括弧・大文字小文字の違いを無視して正規化した上で期待する条件式と比較する
-- （PostgreSQLのdeparse時の括弧付与・大文字化はバージョン間で細部が変わりうるため、
-- 本質的なトークン列だけを見る——完全な文字列一致は求めない）。一致すれば何もしない
-- （冪等）。一致しなければ、サイレントにスキップせず例外を投げてfail-closedにする
-- （呼び出し元が意図しない制約を「適用済み」と誤認しないようにするため）。
--
-- [P0086 MIG-F016-003] P0084までのCHECKは`end_date is null or end_date = date + 1`
-- だけで、end_date単体の値しか見ておらず、kind（normal/focus）・all_day・
-- start_time/end_timeとend_dateの整合性は一切検証していなかった。これでは例えば
-- kind='focus'の行やall_day=trueの行にend_date=date+1が付いていても、あるいは
-- 同日で完結するはずのkind='normal'かつend_time>start_timeの行にend_date=date+1が
-- 付いていても素通りしてしまう。クライアント側の唯一の正本（isValidAppEvent、
-- src/storage/eventsRepository.ts、[P0086 SPEC-F016-001]で拡張済み）が要求する
-- 表現と同じ不変条件をDB側のCHECKでも強制する:
--   * kind<>'normal'の行（focus）はend_date is nullのみ許可（normal予定のendDate
--     意味論を使わない）。
--   * kind='normal' かつ all_day=trueの行はend_date is nullのみ許可（全日予定は
--     日をまたぐend_dateを持たない）。
--   * kind='normal' かつ all_day=false（時刻指定）の行:
--     - end_timeが必須（nullは不可）。
--     - end_time > start_time（同日で完結）ならend_date is nullのみ許可。
--     - end_time < start_time（日をまたぐ）ならend_date = date + 1のみ許可。
--     - end_time = start_time（完全な同時刻）は、end_dateの値に関わらず常に拒否する
--       （「同時刻＝24時間予定」という新しい製品仕様を作らないため。
--       [P0086 SPEC-F016-001]のクライアント側ルールと同じ）。
-- start_time/end_timeはtext列だが、クライアント側isValidTimeStringが常に
-- ゼロ埋め2桁"HH:mm"形式のみを許可するため、通常のtext比較（`<` `>`）が
-- そのまま数値的な時刻順序と一致する（他の時刻列比較と同じ前提、このファイル内でも
-- 既存のend_date=date+1比較と同様に単純な演算子のみを用いる）。
--
-- [P0088 MIG-F016-004] P0086までの冪等性ガードは、既存定義の比較前に空白だけでなく
-- 括弧`()`も正規化で完全に除去していた。これは異なる意味論的グルーピング（例:
-- "(A and B) or (C and D)"と"A and (B or C) and D"）が、たまたま同じトークン列に
-- 潰れてしまえば「一致」と誤判定しうる、という欠陥だった（false positive——本来
-- 拒否すべき異なる不変条件のCHECKを、意味を確認せず「既に正しく適用済み」として
-- 素通ししてしまう）。この誤判定は、false negative（本来問題ない再実行が誤って
-- 例外で止まる）よりも危険であるため、括弧は正規化で一切除去しない。
--
-- 一方、このファイル自身が書いた期待するCHECK式の文字列を手書きで用意し、
-- pg_get_constraintdefが実際に返す括弧付け・キャスト表記と単純比較する方式は、
-- PostgreSQLのバージョン間でdeparse時の括弧付与規則が変わりうるため脆い
-- （手書きの期待文字列が実際の出力と食い違うだけで、正しい制約なのに再実行のたびに
-- 例外になりかねない）。この脆さを避けるため、期待する条件式そのものを
-- 同一セッション内の一時テーブルへ同じCHECK制約として実際に作成し、
-- pg_get_constraintdefにそれ自身をdeparseさせた結果を「期待値」として使う。
-- 既存制約の定義・期待する定義のどちらも同じPostgreSQLの同じdeparserを通るため、
-- 意味的に同一な式は常に完全に一致する文字列になり（バージョン依存の括弧付与規則を
-- 個別に把握する必要がない）、意味的に異なるグルーピングの式は（トークン列が同じでも）
-- ほぼ確実に異なる文字列になる。一時テーブルは`on commit drop`によりこの
-- トランザクション終了時に自動的に破棄され、他のセッション・トランザクションとは
-- 一切共有されない。
--
-- [P0090 MIG-F016-005] P0088時点の比較は、この「両辺とも同じdeparserを通る」という
-- 前提を正しく活かしきれておらず、比較前に定義文字列**全体**を`lower()`で小文字化し、
-- さらに`::[a-z_]+`という広すぎるパターンで任意のキャスト表記を取り除いていた。
-- これは新たなfalse positive経路を生んでいた:
--   * 文字列リテラルの中身（例: `kind = 'normal'`のクォート内テキスト）も意味を持つ
--     データであり、大文字小文字を区別する必要がある。全体を小文字化すると、
--     既存制約が実際には`kind = 'NORMAL'`（意味的に異なる、常に偽になる比較）を
--     含んでいても`kind = 'normal'`と見分けが付かなくなってしまう。
--   * `::[a-z_]+`は「型キャストらしきもの」を無差別に取り除くパターンで、キャストが
--     述語の意味そのものを変えうる（例: 意図しない暗黙変換）ケースまで無害と決めつけて
--     しまっていた。
-- 両辺が同一セッション内で同一のPostgreSQL関数（`pg_get_constraintdef(oid, false)`）を
-- 通して得られる以上、意味的に同一な式は正規化なしでも常に完全に一致する文字列になる
-- （空白・キーワードの大文字小文字等のdeparse時の書式は、同じサーバー・同じ呼び出しである
-- 限り両辺に対して常に同一に決定される——正規化して「歩み寄る」必要が無い）。したがって
-- 比較の前処理は一切行わず、`pg_get_constraintdef`の戻り値同士を厳密な文字列一致
-- （`<>`）で比較する。一致しなければ、その差異が空白なのか文字列リテラルの中身なのか
-- キャストなのかを問わず、無条件にfail-closedする（false negativeを許容し、
-- false positiveを一切許さない——正本§3の不変条件）。
do $$
declare
  v_oid oid;
  v_def text;
  v_expected_oid oid;
  v_expected_def text;
begin
  select oid into v_oid
  from pg_constraint
  where conname = 'events_end_date_valid_check'
    and conrelid = 'public.events'::regclass;

  if v_oid is null then
    alter table public.events
      add constraint events_end_date_valid_check
      check (
        (kind <> 'normal' and end_date is null)
        or (kind = 'normal' and all_day and end_date is null)
        or (
          kind = 'normal' and not all_day and end_time is not null
          and end_time > start_time and end_date is null
        )
        or (
          kind = 'normal' and not all_day and end_time is not null
          and end_time < start_time and end_date = date + 1
        )
      );
    return;
  end if;

  -- [P0088 MIG-F016-004] 同名だがCHECK制約ですらない別種の制約（unique/foreign key等、
  -- 制約名はテーブル内で種別を問わず一意のためあり得る）を、定義文字列のdeparse結果が
  -- たまたま比較に通ってしまう可能性に賭けず、明示的にcontype='c'を要求する。
  if not exists (select 1 from pg_constraint where oid = v_oid and contype = 'c') then
    raise exception
      'events_end_date_valid_check already exists but is not a CHECK constraint (found contype=%): refusing to treat it as the expected constraint',
      (select contype from pg_constraint where oid = v_oid);
  end if;

  create temporary table if not exists __p0088_end_date_check_expected (
    kind text,
    date date,
    start_time text,
    end_time text,
    all_day boolean,
    end_date date
  ) on commit drop;

  -- 同一トランザクション内でこのDOブロックが複数回実行された場合に備え、
  -- 既存の同名制約があれば作り直す（この一時テーブルは今回のトランザクション専用）。
  alter table __p0088_end_date_check_expected
    drop constraint if exists __p0088_expected_check;
  alter table __p0088_end_date_check_expected
    add constraint __p0088_expected_check
    check (
      (kind <> 'normal' and end_date is null)
      or (kind = 'normal' and all_day and end_date is null)
      or (
        kind = 'normal' and not all_day and end_time is not null
        and end_time > start_time and end_date is null
      )
      or (
        kind = 'normal' and not all_day and end_time is not null
        and end_time < start_time and end_date = date + 1
      )
    );

  select oid into v_expected_oid
  from pg_constraint
  where conname = '__p0088_expected_check'
    and conrelid = '__p0088_end_date_check_expected'::regclass;

  -- [P0090 MIG-F016-005] pretty_bool=falseを明示し、両辺が完全に同じ関数シグネチャで
  -- deparseされることを保証する（1引数版のpg_get_constraintdef(oid)は内部的に
  -- pretty_bool=falseへ委譲するため実質的には同じだが、この比較にとって重要な
  -- 前提を暗黙のデフォルトに頼らせず明示する）。
  v_def := pg_get_constraintdef(v_oid, false);
  v_expected_def := pg_get_constraintdef(v_expected_oid, false);

  -- [P0090 MIG-F016-005] 正規化は一切行わない（大文字小文字の統一・空白除去・
  -- キャスト表記の除去のいずれも行わない）。両辺とも同一セッション内で同一の
  -- PostgreSQL関数を通して得られるため、意味的に同一な式は常に完全に一致する
  -- 文字列になる（上記コメント参照）。差異が生じた場合、それが書式上の些細な
  -- 違いか意味的な違いかを問わず区別せず、無条件にfail-closedする。
  if v_def <> v_expected_def then
    raise exception
      'events_end_date_valid_check already exists with an unexpected definition: % (expected exactly: %)',
      v_def, v_expected_def;
  end if;
  -- else: 既存の定義が期待する定義と完全に一致するので何もしない（冪等）。
end;
$$;

comment on constraint events_end_date_valid_check on public.events is
  'P0080 CORRECT-F016-002 / P0082 MIG-F016-001 / P0084 MIG-F016-002 / P0086 MIG-F016-003 / P0088 MIG-F016-004 / P0090 MIG-F016-005: kind<>normalの行はend_date is nullのみ、kind=normalかつall_dayの行もend_date is nullのみ、kind=normalかつ時刻指定の行はend_time>start_time(同日)ならend_date is null・end_time<start_time(翌日)ならend_date=date+1のみを許可し、end_time=start_time（完全な同時刻）は常に拒否する。冪等な適用はpg_get_constraintdefによる実定義の比較を伴うDOブロックで行う（ADD CONSTRAINT IF NOT EXISTSは無効なため使わない。同名だが異なる定義の既存制約は無視せず例外で止める。期待する定義自身も一時テーブルでpg_get_constraintdef(oid,false)にdeparseさせ、両辺とも一切の正規化（大文字小文字統一・キャスト除去等）を行わない完全一致比較で判定することで、文字列リテラルの中身の違いやキャストの違いを誤って一致と判定しない）。';

-- verify: select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'events' and column_name = 'end_date';
-- verify: select id, kind, date, start_time, end_time, all_day, end_date from public.events limit 5;
-- verify (制約違反が拒否されることの確認、実DBには適用しない):
--   update public.events set end_date = date + 2 where id = '<any-id>'; -- 期待: 例外
--   update public.events set end_date = date - 1 where id = '<any-id>'; -- 期待: 例外
--   update public.events set kind = 'normal', all_day = false, start_time = '10:00',
--     end_time = '11:00', end_date = date + 1 where id = '<any-id>'; -- 期待: 例外（同日なのにend_date設定）
--   update public.events set kind = 'normal', all_day = false, start_time = '23:40',
--     end_time = '00:40', end_date = null where id = '<any-id>'; -- 期待: 例外（日またぎなのにend_date未設定）
--   update public.events set kind = 'normal', all_day = false, start_time = '10:00',
--     end_time = '10:00' where id = '<any-id>'; -- 期待: 例外（同時刻、end_dateの値に関わらず拒否）
--   update public.events set kind = 'normal', all_day = true, end_date = date + 1
--     where id = '<any-id>'; -- 期待: 例外（全日予定はend_date is nullのみ）
