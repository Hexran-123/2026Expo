-- 乗客が書いた文の投稿（ADR-0004、設計書 7.2）
--
-- 旅の記録で書いたひとこと（絶景ごと・写真ごと・その日の結び）を、
-- 利用者が「送る」を選んだときだけ預かる。
--
-- **写真は受け取らない。** 送られてくるのは文字だけである。顔が写るもの、
-- 撮影地点が埋まっているものを預からずに済むので、安全管理の範囲が
-- 「人が書いた短い文」だけに収まる。写真の投稿を足すときは、EXIF を
-- 落とす処理と保管場所の設計を、こことは別に立てること。
--
-- 預かるものと、その約束（ADR-0004「どこまでを持つか」）:
--   ・匿名で受ける。名前もメールアドレスも預からない。
--   ・**審査を通るまで公開しない。** approved_at が入るまで誰にも読めない。
--   ・2027年4月30日にすべて消す（purge_expired_notes）。
--   ・投稿者の IP はハッシュにして 90 日だけ持つ（purge_note_visitor）。
-- この約束は index.html の投稿画面にも書いてある。片方だけ直さないこと。
--
-- このファイルは素の PostgreSQL でも Supabase でもそのまま動く。
-- 手元の PostgreSQL で試してから Supabase の SQL Editor に貼ること。
-- 手元で試すときは supabase/local/setup_and_verify.sql を先に流す
-- （visitor_key() は 001_spot_opens.sql が定義している。あちらが先）。

-- ---------------------------------------------------------------
-- 表
-- ---------------------------------------------------------------

create table if not exists note_submission (
  id           bigserial primary key,

  -- data/lines.json の id。どの路線で書かれたものかを分ける
  line_id      text not null check (line_id ~ '^[a-z][a-z0-9_-]{0,31}$'),

  -- spots.json の id。形だけを縛るのは 001 の spot_open_count と同じ理由
  -- （絶景スポットの一覧をデータベースに置くと二重管理になる）。
  -- その日の結び（kind = 'trip'）は、どの絶景にも属さないので null。
  spot_id      text check (spot_id is null or spot_id ~ '^[SY][0-9]{2}$'),

  --   spot  … 絶景ごとのひとこと（成因カードの記章から書いたもの）
  --   photo … 写真に添えた一言（写真そのものは送られてこない）
  --   trip  … その日の結び。テーマから選ばれた文をそのまま送ることはない
  kind         text not null check (kind in ('spot', 'photo', 'trip')),

  -- 上限 2000 字は、結びの一文が画面では字数制限を持たないため
  -- （設計書 7.2）。画面で切らずに、送るところだけで切る。
  body         text not null check (char_length(btrim(body)) between 1 and 2000),

  -- IP アドレスに日付と秘密の文字列を混ぜたハッシュ（001 の visitor_key）。
  -- 日をまたぐと値が変わるので、同じ人を追い続けることはできない。
  -- 90 日を過ぎたら null にする（purge_note_visitor）。
  visitor      text,

  submitted_at timestamptz not null default now(),
  submitted_on date        not null default current_date,

  -- 制作者が目で見て通した時刻。ここが null のあいだは誰にも読めない
  approved_at  timestamptz
);

comment on table note_submission is
  '乗客が書いた文の投稿。審査を通ったものだけが読める。書き込みは submit_notes() 経由のみ。';

-- 同じ文を二度送っても増やさない。
--
-- 画面の側でも「送りました」のあとはボタンを引っこめるが、読み込み直せば
-- 押し直せる。同じ旅の同じ文が二重に並ぶのは、掲示板として見たときに
-- ただの雑音なので、こちら側でも弾く。visitor は日ごとに変わるので、
-- これは実質「同じ人が同じ日に同じ文を二度送らない」になる。
create unique index if not exists note_submission_once
  on note_submission (visitor, line_id, kind, coalesce(spot_id, ''), md5(body))
  where visitor is not null;

-- 一日の投稿数を数えるため（submit_notes）と、90 日での手放しのため
create index if not exists note_submission_visitor_day_idx
  on note_submission (visitor, submitted_on);

create index if not exists note_submission_approved_idx
  on note_submission (approved_at, line_id);

-- ---------------------------------------------------------------
-- 送る
-- ---------------------------------------------------------------

-- 旅の記録で書いた文を、まとめて預かる。
--
-- 戻り値は、実際に預かった件数。形が壊れているものは黙って落とし、
-- 残りを預かる。全部を拒むと、1 件の書き損じで旅ぶんの言葉が失われる。
--
-- security definer にしてあるのは、匿名の利用者に表への直接の書き込みを
-- 許さないため。書き込めるのはこの関数の中だけになる。
--
-- **端末が名乗る値は信じない**（ADR-0004 の追記）。投稿者が誰か、いつ
-- 書いたか、どこで書いたかは、どれも端末の自己申告でしかない。ここで
-- 使うのは visitor_key()（端末から偽れない）と now()（サーバーの時計）だけ。
create or replace function submit_notes(p_line_id text, p_notes jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visitor text;
  v_today   integer;
  v_saved   integer := 0;
  v_note    jsonb;
  v_kind    text;
  v_spot    text;
  v_body    text;
begin
  if p_line_id is null or p_line_id !~ '^[a-z][a-z0-9_-]{0,31}$' then
    raise exception 'unknown line_id';
  end if;

  if p_notes is null or jsonb_typeof(p_notes) <> 'array' then
    raise exception 'notes must be an array';
  end if;

  -- 一度に送れる数。旅の記録が集める文の数（絶景・写真・結び）を
  -- 超えることはないので、これを超えるものは投稿画面を経ていない。
  if jsonb_array_length(p_notes) > 20 then
    raise exception 'too many notes';
  end if;

  v_visitor := visitor_key();

  -- 一日の上限。ログインを持たない以上、数で歯止めをかけるほかない
  select count(*) into v_today
  from note_submission
  where visitor = v_visitor and submitted_on = current_date;

  if v_today >= 60 then
    raise exception 'too many notes today';
  end if;

  for v_note in select * from jsonb_array_elements(p_notes)
  loop
    v_kind := v_note ->> 'kind';
    v_spot := nullif(btrim(coalesce(v_note ->> 'spot_id', '')), '');
    v_body := btrim(coalesce(v_note ->> 'body', ''));

    -- 形が違うものは落とす。表側の check と同じ条件をここでも見るのは、
    -- 1 件の取りこぼしで残り全部が失われないようにするため
    continue when v_kind is null or v_kind not in ('spot', 'photo', 'trip');
    continue when v_body = '' or char_length(v_body) > 2000;

    -- 知らない形の spot_id は、無かったことにして本文だけ預かる
    if v_spot is not null and v_spot !~ '^[SY][0-9]{2}$' then
      v_spot := null;
    end if;

    insert into note_submission (line_id, spot_id, kind, body, visitor)
    values (p_line_id, v_spot, v_kind, v_body, v_visitor)
    on conflict do nothing;

    if found then
      v_saved := v_saved + 1;
    end if;
  end loop;

  return v_saved;
end;
$$;

-- ---------------------------------------------------------------
-- 手放す
-- ---------------------------------------------------------------

-- 90 日を過ぎた投稿から、IP のハッシュを外す（ADR-0004）。
-- 本文は残る。残すのは公開するためで、誰が書いたかを追うためではない。
create or replace function purge_note_visitor()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cleared integer;
begin
  update note_submission
     set visitor = null
   where submitted_on < current_date - 90
     and visitor is not null;
  get diagnostics v_cleared = row_count;
  return v_cleared;
end;
$$;

-- 2027年4月30日をもって、預かったものをすべて消す（ADR-0004）。
--
-- 現地展示（2027年3月17〜19日）の終了から約 6 週間後にあたる。
-- 他人の文を預かる以上、いつ手放すかを先に決めて投稿画面に書いておかないと、
-- 送る人は自分の書いたものがどうなるか分からないまま押すことになる。
--
-- 日が来るまでは何もしない。pg_cron に毎日呼ばせておけば、
-- その日に自動で空になる（人が覚えていなくても約束が守られる）。
create or replace function purge_expired_notes()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if current_date <= date '2027-04-30' then
    return 0;
  end if;
  delete from note_submission;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------
-- 審査を通ったものだけを見せる口
--
-- 前端はまだこれを読まない（掲示板として見せる画面は作っていない）。
-- 先に置いてあるのは、投稿を受け取りはじめる時点で「誰に何が見えるか」を
-- 決めておかないと、あとから緩める方向にしか動かないためである。
-- ---------------------------------------------------------------

create or replace view public_note as
  select id, line_id, spot_id, kind, body, submitted_at
    from note_submission
   where approved_at is not null;

comment on view public_note is
  '審査を通った投稿だけ。誰が書いたか（visitor）は含まない。';

-- 呼んだ人の権限で動かす（PostgreSQL 15 から）。下の行単位の制限が
-- そのまま効くようになる。15 より前では view の持ち主の権限で動くが、
-- そのときも where 句が未審査のものを外すので、見えるものは変わらない。
do $$
begin
  if current_setting('server_version_num')::int >= 150000 then
    execute 'alter view public_note set (security_invoker = on)';
  end if;
end $$;

-- ---------------------------------------------------------------
-- アクセス制御
--
-- Supabase の匿名キーは前端の JavaScript に必ず現れる。
-- 安全を担保しているのはここだけなので、緩めないこと（ADR-0004）。
-- ---------------------------------------------------------------

alter table note_submission enable row level security;

-- 読めるのは、審査を通ったものだけ。
-- 書き込みのポリシーは一つも作らない＝匿名からは書けない（関数経由のみ）。
drop policy if exists note_submission_select_approved on note_submission;
create policy note_submission_select_approved
  on note_submission for select
  using (approved_at is not null);

revoke all on note_submission from anon, authenticated;
revoke all on sequence note_submission_id_seq from anon, authenticated;

-- 列まで絞る。**渡さないのは visitor（IP のハッシュ）だけ**にする。
-- 行を絞るだけだと、審査を通った投稿の visitor が読めてしまう。
--
-- approved_at をここに含めているのは、public_note が
-- 「where approved_at is not null」でこの列を読むためである。
-- security_invoker = on の view は、**呼んだ人が触れる列しか触れない**。
-- 最初 approved_at を外していたところ、行は読めるのに絞り込みに使う列が
-- 読めず、view ごと permission denied で弾かれた（2026-08-16、
-- setup_and_verify.sql の 19 番が FAIL して判明）。
--
-- 渡しても漏れるものはない。行のほうは下の RLS が「審査を通ったもの」に
-- 限っているので、見えるのは公開してよい投稿の承認時刻だけになる。
grant select (id, line_id, spot_id, kind, body, submitted_at, approved_at)
  on note_submission to anon, authenticated;

grant select on public_note to anon, authenticated;

-- 送る関数だけを匿名に開ける。手放す二つは運用側だけが呼ぶ。
revoke all on function submit_notes(text, jsonb) from public, anon, authenticated;
revoke all on function purge_note_visitor()      from public, anon, authenticated;
revoke all on function purge_expired_notes()     from public, anon, authenticated;
grant execute on function submit_notes(text, jsonb) to anon, authenticated;

-- Supabase なら pg_cron で一日一度：
--   select cron.schedule('purge-note-visitor',  '10 4 * * *', 'select purge_note_visitor()');
--   select cron.schedule('purge-expired-notes', '20 4 * * *', 'select purge_expired_notes()');
--
-- 審査は SQL Editor から手で通す（一日一度、目で見て）：
--   select id, line_id, spot_id, kind, body from note_submission where approved_at is null order by id;
--   update note_submission set approved_at = now() where id in (...);
