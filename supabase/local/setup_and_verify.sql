-- 手元の PostgreSQL で、アクセス制御が本当に効いているかを確かめる。
--
-- ADR-0004 は「公開前に、匿名キーだけで『未審査の投稿が読めないか』
-- 『行を消せないか』を実際に試す」ことを求めている。Supabase で試すと
-- 失敗しても跡が残るので、まず手元で通す。
--
--   psql -U postgres -f supabase/local/setup_and_verify.sql
--
-- 期待する出力は OK が 13 行。FAIL が 1 行でも出たら、そのまま公開しない。
--
-- 日本語版 Windows では、この一手も要る（コマンドプロンプトの表示を UTF-8 にする）:
--
--   chcp 65001
--
-- 忘れると OK / FAIL の行が文字化けして読めない。

\set ON_ERROR_STOP on

-- このファイルも schema も UTF-8 で書いてある。日本語版 Windows の psql は
-- 既定で SJIS を使うため、宣言しないと日本語のコメントで
-- 「invalid byte sequence for encoding "SJIS"」に落ちる。
-- Supabase の SQL Editor は最初から UTF-8 なので、あちらでは要らない。
\encoding UTF8

-- ---------------------------------------------------------------
-- Supabase にあって素の PostgreSQL に無いものを用意する
-- ---------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

grant usage on schema public to anon, authenticated;

-- 秘密の文字列。本番では別の値を入れること。
set app.visitor_salt = 'local-test-salt';

\echo '--- schema を流す ---'
-- \ir はこのファイルからの相対。どのディレクトリで psql を起動しても通る。
\ir ../schema/001_spot_opens.sql

-- 前回の試行を消しておく
delete from spot_open_log;
delete from spot_open_count;

\echo ''
\echo '--- ここから検査 ---'

-- 1. 匿名は集計を読める
do $$
declare n integer;
begin
  set role anon;
  select count(*) into n from spot_open_count;
  raise notice 'OK  : 匿名は spot_open_count を読める';
  reset role;
exception when others then
  reset role;
  raise warning 'FAIL: 匿名が spot_open_count を読めない（%）', sqlerrm;
end $$;

-- 2. 匿名は集計に書けない
do $$
begin
  set role anon;
  begin
    insert into spot_open_count (spot_id, opens) values ('S99', 999);
    raise warning 'FAIL: 匿名が spot_open_count に insert できてしまう';
  exception when others then
    raise notice 'OK  : 匿名は spot_open_count に insert できない';
  end;
  reset role;
end $$;

-- 3. 匿名は集計を書き換えられない
do $$
begin
  set role anon;
  begin
    update spot_open_count set opens = 99999;
    raise warning 'FAIL: 匿名が spot_open_count を update できてしまう';
  exception when others then
    raise notice 'OK  : 匿名は spot_open_count を update できない';
  end;
  reset role;
end $$;

-- 4. 匿名は行を消せない
do $$
begin
  set role anon;
  begin
    delete from spot_open_count;
    raise warning 'FAIL: 匿名が spot_open_count を delete できてしまう';
  exception when others then
    raise notice 'OK  : 匿名は spot_open_count を delete できない';
  end;
  reset role;
end $$;

-- 5. 匿名は重複排除の記録を覗けない（ここに IP のハッシュが入っている）
do $$
declare n integer;
begin
  set role anon;
  begin
    select count(*) into n from spot_open_log;
    raise warning 'FAIL: 匿名が spot_open_log を読めてしまう';
  exception when others then
    raise notice 'OK  : 匿名は spot_open_log を読めない';
  end;
  reset role;
end $$;

-- 6. 匿名は関数を呼べて、数が 1 増える
do $$
declare v bigint;
begin
  set role anon;
  select record_spot_open('S04') into v;
  reset role;
  if v = 1 then
    raise notice 'OK  : 匿名が record_spot_open を呼べて、1 になった';
  else
    raise warning 'FAIL: 1 になるはずが % だった', v;
  end if;
exception when others then
  reset role;
  raise warning 'FAIL: 匿名が record_spot_open を呼べない（%）', sqlerrm;
end $$;

-- 7. 同じ日に同じ人が二度開いても増えない
do $$
declare v bigint;
begin
  set role anon;
  select record_spot_open('S04') into v;
  reset role;
  if v = 1 then
    raise notice 'OK  : 同じ日の二度目は数えない（1 のまま）';
  else
    raise warning 'FAIL: 二度目で % に増えてしまった', v;
  end if;
exception when others then
  reset role;
  raise warning 'FAIL: 二度目の呼び出しで落ちた（%）', sqlerrm;
end $$;

-- 8. でたらめな spot_id は弾く
do $$
begin
  set role anon;
  begin
    perform record_spot_open('<script>alert(1)</script>');
    raise warning 'FAIL: でたらめな spot_id が通ってしまう';
  exception when others then
    raise notice 'OK  : でたらめな spot_id は弾かれる';
  end;
  reset role;
end $$;

-- 9. 有楽町線（Y）も数えられる
--
-- 2026-08-13、有楽町線の dataSource が "real" になったのに、
-- id が Y01〜Y10 で S 専用の check に弾かれ、記章が一切出ない
-- 不具合があった。無いなら出さない設計のせいで、直すまで気づけなかった。
do $$
declare v bigint;
begin
  set role anon;
  select record_spot_open('Y01') into v;
  reset role;
  if v = 1 then
    raise notice 'OK  : 有楽町線（Y01）も record_spot_open を呼べて、1 になった';
  else
    raise warning 'FAIL: 1 になるはずが % だった', v;
  end if;
exception when others then
  reset role;
  raise warning 'FAIL: 有楽町線の spot_id が呼べない（%）', sqlerrm;
end $$;

-- 10. S・Y 以外の頭文字は、有楽町線を通した後も引き続き弾く
do $$
begin
  set role anon;
  begin
    perform record_spot_open('T01');
    raise warning 'FAIL: S・Y 以外の頭文字が通ってしまう';
  exception when others then
    raise notice 'OK  : S・Y 以外の頭文字は弾かれる';
  end;
  reset role;
end $$;

-- ---------------------------------------------------------------
-- 訪問者のキーが詐称できないか
--
-- 2026-08-11、線上の Supabase に匿名キーで実際に投げて見つけた穴の回帰試験。
-- x-forwarded-for を丸ごと訪問者キーにしていたころは、ヘッダを
-- 付け替えるだけで別人になれ、S01 の回数を 1 → 4 まで増やせた。
--
-- 素の PostgreSQL には HTTP 要求が無いが、request.headers は
-- ただの設定値なので、手で置けば解釈の部分は確かめられる。
-- ---------------------------------------------------------------

-- 11. 先頭を詐称しても、同じ人と見なされる
do $$
declare k_plain text; k_spoof text;
begin
  perform set_config('request.headers', '{"x-forwarded-for":"198.51.100.9"}', false);
  k_plain := visitor_key();

  perform set_config('request.headers', '{"x-forwarded-for":"203.0.113.7, 192.0.2.1,198.51.100.9"}', false);
  k_spoof := visitor_key();

  if k_plain = k_spoof then
    raise notice 'OK  : x-forwarded-for の先頭を詐称しても同じ訪問者';
  else
    raise warning 'FAIL: 先頭を詐称するだけで別人になれてしまう';
  end if;
end $$;

-- 12. cf-connecting-ip があればそちらを採る
do $$
declare k_plain text; k_cf text;
begin
  perform set_config('request.headers', '{"x-forwarded-for":"198.51.100.9"}', false);
  k_plain := visitor_key();

  perform set_config('request.headers',
    '{"x-forwarded-for":"203.0.113.7,198.51.100.9","cf-connecting-ip":"198.51.100.9"}', false);
  k_cf := visitor_key();

  if k_plain = k_cf then
    raise notice 'OK  : cf-connecting-ip を優先して同じ訪問者になる';
  else
    raise warning 'FAIL: cf-connecting-ip が効いていない';
  end if;
end $$;

-- 13. 本当に別の IP なら、別の人として数える
--     （11・12 を「常に同じ値を返す」で通してしまわないための対照）
do $$
declare k_a text; k_b text;
begin
  perform set_config('request.headers', '{"x-forwarded-for":"198.51.100.9"}', false);
  k_a := visitor_key();

  perform set_config('request.headers', '{"x-forwarded-for":"198.51.100.10"}', false);
  k_b := visitor_key();

  perform set_config('request.headers', '', false);

  if k_a <> k_b then
    raise notice 'OK  : 別の IP は別の訪問者になる';
  else
    raise warning 'FAIL: どの IP でも同じ訪問者になってしまう';
  end if;
end $$;

\echo ''
\echo '--- 集計の中身 ---'
select spot_id, opens, updated_at from spot_open_count order by spot_id;
