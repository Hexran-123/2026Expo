-- 乗客が撮った写真の投稿（ADR-0004、設計書 7.1、docs/絶景掲示板_設計メモ.md）
--
-- 旅の記録から「絶景掲示板に出す」を押したとき、または掲示板の投稿モーダルから
-- 送られたときだけ、写真を預かる。押されるまで写真は端末（IndexedDB）の中にある。
--
-- 預かるものと、その約束（ADR-0004「どこまでを持つか」）:
--   ・匿名で受ける。名前もメールアドレスも預からない。
--   ・**審査を通るまで公開しない。** 未審査のものは匿名キーからは一切読めない。
--   ・2027年4月30日にすべて消す（purge_expired_photos）。
--   ・投稿者の IP はハッシュにして 90 日だけ持つ（purge_photo_visitor）。
--   ・EXIF は端末側で落としてから送る（js/journal.js の toUploadable）。
-- この約束は index.html と board.html の投稿画面にも書いてある。片方だけ直さないこと。
--
-- ■ なぜ写真の中身をこの表に持つのか（Storage を使わない理由）
--
-- 当初は Supabase Storage の非公開バケットに置く形で決めていた。しかし審査を
-- 「パスポートで開く頁」で行うと決めたため（2026-08-19）、その形では審査ができない。
-- Storage の非公開バケットを読むには service_role の鍵かログイン済みの利用者が要り、
-- どちらも「service_role を前端に置かない」「ログインは持たない」という ADR-0004 の
-- 決定と衝突する。パスポートは PostgREST の関数の中でしか確かめられないので、
-- **写真の中身も関数から返せる場所**、すなわちデータベースの中に置く。
--
-- 代わりに、重さの問題は次の二つで抑える。
--   ・中身（bytea）は photo_pending という別の表に分け、一覧や集計が
--     重い列を触らずに済むようにする。
--   ・**掲示したら中身を捨てる。** 公開用の写真はリポジトリの
--     assets/choshi/board/posts/ に置くので（tools/publish-posts.js）、
--     ここに残す理由がない。落としたものも即座に消す。
--   したがって、この表に溜まるのは「まだ審査していない写真」だけになる。
--
-- このファイルは素の PostgreSQL でも Supabase でもそのまま動く。
-- 手元の PostgreSQL で試してから Supabase の SQL Editor に貼ること。
-- visitor_key() は 001_spot_opens.sql が定義している（あちらが先）。

-- ---------------------------------------------------------------
-- 表
-- ---------------------------------------------------------------

create table if not exists photo_submission (
  id            uuid primary key default gen_random_uuid(),

  -- data/lines.json の id。掲示板は銚子エリアのものなので実際には 'choshi' だけだが、
  -- 形の検査は 002 と揃えておく
  line_id       text not null check (line_id ~ '^[a-z][a-z0-9_-]{0,31}$'),

  --   navi  … 旅の記録から。撮ったときの絶景スポットが分かっている
  --   board … 掲示板の地図をタップして置いたもの。座標を自分で決めている
  source        text not null check (source in ('navi', 'board')),

  -- spots.json の絶景スポット id（navi のとき）。掲示先はここから決まる
  spot_id       text check (spot_id is null or spot_id ~ '^[SY][0-9]{2}$'),

  -- 掲示板の地図で置いた座標（board のとき）。銚子エリアの外は受け取らない。
  -- 端末の自己申告なので、これを根拠に何かを制限することはしない（ADR-0004 の追記）。
  -- 見ているのは「地図の外を指していないか」という形の検査だけである。
  lat           double precision check (lat is null or (lat between 35.60 and 35.82)),
  lon           double precision check (lon is null or (lon between 140.72 and 140.94)),

  mime          text not null check (mime in ('image/webp', 'image/jpeg')),
  bytes         integer not null check (bytes between 1 and 3000000),

  -- IP アドレスに日付と秘密の文字列を混ぜたハッシュ（001 の visitor_key）。
  -- 90 日を過ぎたら null にする（purge_photo_visitor）。
  visitor       text,

  submitted_at  timestamptz not null default now(),
  submitted_on  date        not null default current_date,

  -- 制作者が目で見て通した時刻。ここが null のあいだは誰にも読めない
  approved_at   timestamptz,
  -- 落としたもの。中身はこの時点で消える（photo_pending から削除）
  rejected_at   timestamptz,
  -- リポジトリへ置いて board.html に載せた時刻（tools/publish-posts.js）
  published_at  timestamptz,

  -- 掲示先の掲示スポット（data/choshi/board-spots.json の id）。
  -- navi から来たものは spot_id から当番の道具が決め、掲示のときに書き込む
  board_spot_id text,

  constraint photo_submission_place
    check ((source = 'navi'  and spot_id is not null and lat is null and lon is null)
        or (source = 'board' and spot_id is null     and lat is not null and lon is not null))
);

comment on table photo_submission is
  '乗客が撮った写真の投稿。審査を通るまで誰にも読めない。書き込みは submit_photo() 経由のみ。';

-- 写真そのもの。審査が済んで掲示（または却下）したら消える。
create table if not exists photo_pending (
  id      uuid primary key references photo_submission(id) on delete cascade,
  content bytea not null
);

comment on table photo_pending is
  '未掲示の写真の中身。掲示したら捨てる（公開用の実体はリポジトリ側にある）。';

-- 一日の投稿数を数えるため（submit_photo）と、90 日での手放しのため
create index if not exists photo_submission_visitor_day_idx
  on photo_submission (visitor, submitted_on);

create index if not exists photo_submission_pending_idx
  on photo_submission (approved_at, rejected_at, submitted_at);

-- ---------------------------------------------------------------
-- 送る
-- ---------------------------------------------------------------

-- 写真を 1 枚預かる。
--
-- security definer にしてあるのは、匿名の利用者に表への直接の書き込みを
-- 許さないため。書き込めるのはこの関数の中だけになる。
--
-- **端末が名乗る値は信じない**（ADR-0004 の追記）。投稿者が誰か、いつ撮ったかは
-- 端末の自己申告でしかない。数を制限する根拠に使うのは visitor_key()（端末から
-- 偽れない）と now()（サーバーの時計）だけである。
--
-- 同意（本人が撮影／他人の顔が写っていない／16歳未満は保護者の同意／保存期限の理解）は
-- 画面で取る。ここに列を作って持たないのは、それも端末の自己申告でしかなく、
-- 「同意した」という記録があること自体が安全を増やさないためである。守りは
-- **人が目で見て通すこと**（審査）のほうに置く。
create or replace function submit_photo(
  p_line_id text,
  p_source  text,
  p_spot_id text,
  p_lat     double precision,
  p_lon     double precision,
  p_mime    text,
  p_content text            -- base64
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visitor text;
  v_today   integer;
  v_bytes   bytea;
  v_id      uuid;
begin
  if p_line_id is null or p_line_id !~ '^[a-z][a-z0-9_-]{0,31}$' then
    raise exception 'unknown line_id';
  end if;

  if p_content is null or length(p_content) > 4200000 then
    raise exception 'photo missing or too large';
  end if;

  begin
    v_bytes := decode(p_content, 'base64');
  exception when others then
    raise exception 'photo is not base64';
  end;

  if octet_length(v_bytes) < 1 or octet_length(v_bytes) > 3000000 then
    raise exception 'photo size out of range';
  end if;

  v_visitor := visitor_key();

  -- 同じ相手からは一日 20 枚まで。旅の記録の側でも 1 回の乗車 5 枚に絞っているが、
  -- 画面の制限は読み込み直せば外れるので、ここでも数える。
  select count(*) into v_today
    from photo_submission
   where visitor = v_visitor
     and submitted_on = current_date;

  if v_today >= 20 then
    raise exception 'too many photos today';
  end if;

  insert into photo_submission
    (line_id, source, spot_id, lat, lon, mime, bytes, visitor)
  values
    (p_line_id, p_source, p_spot_id, p_lat, p_lon, p_mime, octet_length(v_bytes), v_visitor)
  returning id into v_id;

  insert into photo_pending (id, content) values (v_id, v_bytes);

  return v_id;
end;
$$;

-- ---------------------------------------------------------------
-- 審査（パスポート）
--
-- 審査の頁（review.html）は公開の URL に置かれるが、パスポートが無ければ何も返さない。
-- パスポートは service_role の鍵ではないので、万一漏れても**できるのは審査だけ**である。
-- 行を消すことも、他の表を読むことも、投稿者の IP のハッシュを読むこともできない。
-- 漏れたと思ったら set_review_secret() で入れ替える。
-- ---------------------------------------------------------------

create table if not exists review_secret (
  only_one boolean primary key default true check (only_one),
  hash     text not null,
  set_at   timestamptz not null default now()
);

comment on table review_secret is
  '審査のパスポートのハッシュ。匿名からは読めない。set_review_secret() で入れ替える。';

-- パスポートを決める／入れ替える。運用側が SQL Editor から呼ぶ。
create or replace function set_review_secret(p_pass text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 短いパスポートは総当たりで破れる。この関数の中でしか確かめられない以上、
  -- 長さだけは機械が保証する。
  if p_pass is null or length(p_pass) < 24 then
    raise exception 'review secret must be at least 24 characters';
  end if;

  insert into review_secret (only_one, hash, set_at)
  values (true, encode(sha256(convert_to(p_pass, 'utf8')), 'hex'), now())
  on conflict (only_one) do update
    set hash = excluded.hash, set_at = now();
end;
$$;

-- パスポートが合っているか。合っていなければ必ず例外で止める。
create or replace function review_ok(p_pass text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hash text;
begin
  select hash into v_hash from review_secret where only_one;

  -- パスポートがまだ決まっていないなら、審査は誰にもできない（開いた状態にしない）
  if v_hash is null or p_pass is null
     or encode(sha256(convert_to(p_pass, 'utf8')), 'hex') <> v_hash then
    raise exception 'review: wrong pass';
  end if;
end;
$$;

-- 未審査の一覧。中身（写真）は返さない——一覧は軽くしておき、
-- 見るときに 1 枚ずつ取りにいく（review_photo）。
create or replace function review_pending(p_pass text)
returns table (
  id uuid, source text, spot_id text,
  lat double precision, lon double precision,
  mime text, bytes integer, submitted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform review_ok(p_pass);
  return query
    select s.id, s.source, s.spot_id, s.lat, s.lon, s.mime, s.bytes, s.submitted_at
      from photo_submission s
     where s.approved_at is null
       and s.rejected_at is null
     order by s.submitted_at
     limit 200;
end;
$$;

-- 写真 1 枚の中身（base64）。審査の頁が目で見るために使う。
create or replace function review_photo(p_pass text, p_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_content bytea;
begin
  perform review_ok(p_pass);
  select content into v_content from photo_pending where id = p_id;
  if v_content is null then
    return null;
  end if;
  return encode(v_content, 'base64');
end;
$$;

-- 通す／落とす。
--
-- 落としたものは**その場で中身を消す**。理由を尋ねる欄も作らない。
-- 通らなかった写真を持ち続ける理由がないためである（ADR-0004 の
-- 「預かるものを増やさない」に沿う）。
create or replace function review_decide(p_pass text, p_id uuid, p_approve boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform review_ok(p_pass);

  if p_approve then
    update photo_submission
       set approved_at = now(), rejected_at = null
     where id = p_id and approved_at is null and rejected_at is null;
  else
    update photo_submission
       set rejected_at = now(), approved_at = null
     where id = p_id and approved_at is null and rejected_at is null;
    delete from photo_pending where id = p_id;
  end if;

  return found;
end;
$$;

-- 掲示待ちの一覧（審査を通り、まだリポジトリへ置いていないもの）。
-- tools/publish-posts.js が中身ごと受け取り、assets/ に書き出す。
create or replace function review_publish_queue(p_pass text)
returns table (
  id uuid, source text, spot_id text,
  lat double precision, lon double precision,
  mime text, content text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform review_ok(p_pass);
  return query
    select s.id, s.source, s.spot_id, s.lat, s.lon, s.mime,
           encode(p.content, 'base64')
      from photo_submission s
      join photo_pending p on p.id = s.id
     where s.approved_at is not null
       and s.published_at is null
     order by s.approved_at
     limit 50;
end;
$$;

-- リポジトリへ置き終えた。中身はもう要らないので捨てる。
create or replace function review_mark_published(p_pass text, p_id uuid, p_board_spot_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform review_ok(p_pass);

  update photo_submission
     set published_at = now(), board_spot_id = p_board_spot_id
   where id = p_id and approved_at is not null;

  if not found then
    return false;
  end if;

  delete from photo_pending where id = p_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------
-- いいね
--
-- 掲示板の写真ごとの「いいね」。数え方は累積人気（001）と同じで、
-- 端末が名乗る id ではなく visitor_key() で見分ける。
-- visitor_key() は日ごとに変わるので、これは実質「一人一日一票」になる。
-- ---------------------------------------------------------------

create table if not exists board_like (
  -- 公式写真なら掲示スポットの id、乗客の写真なら投稿の id（uuid）
  target_id text not null check (target_id ~ '^[a-zA-Z0-9_-]{1,64}$'),
  visitor   text not null,
  liked_on  date not null default current_date,
  primary key (target_id, visitor)
);

create table if not exists board_like_count (
  target_id  text primary key,
  likes      integer not null default 0 check (likes >= 0),
  updated_at timestamptz not null default now()
);

-- 押す／取り消す。戻り値はその写真のいまの数。
create or replace function record_board_like(p_target_id text, p_on boolean)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visitor text;
  v_likes   integer;
begin
  if p_target_id is null or p_target_id !~ '^[a-zA-Z0-9_-]{1,64}$' then
    raise exception 'bad target';
  end if;

  v_visitor := visitor_key();

  if coalesce(p_on, true) then
    insert into board_like (target_id, visitor) values (p_target_id, v_visitor)
    on conflict do nothing;
    if not found then
      select likes into v_likes from board_like_count where target_id = p_target_id;
      return coalesce(v_likes, 0);
    end if;
    insert into board_like_count (target_id, likes) values (p_target_id, 1)
    on conflict (target_id) do update
      set likes = board_like_count.likes + 1, updated_at = now()
    returning likes into v_likes;
  else
    delete from board_like where target_id = p_target_id and visitor = v_visitor;
    if not found then
      select likes into v_likes from board_like_count where target_id = p_target_id;
      return coalesce(v_likes, 0);
    end if;
    update board_like_count
       set likes = greatest(likes - 1, 0), updated_at = now()
     where target_id = p_target_id
    returning likes into v_likes;
  end if;

  return coalesce(v_likes, 0);
end;
$$;

-- ---------------------------------------------------------------
-- 手放す
-- ---------------------------------------------------------------

-- 90 日を過ぎた投稿から、IP のハッシュを外す（ADR-0004）
create or replace function purge_photo_visitor()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cleared integer;
begin
  update photo_submission
     set visitor = null
   where submitted_on < current_date - 90
     and visitor is not null;
  get diagnostics v_cleared = row_count;

  delete from board_like where liked_on < current_date - 90;
  return v_cleared;
end;
$$;

-- 2027年4月30日をもって、預かった写真をすべて消す（ADR-0004）。
--
-- **これはサーバー側だけの話である。** 掲示した写真の実体はリポジトリにあるので、
-- 同じ日に docs/投稿写真の手放し方.md の手順（git の履歴ごと書き換える）も
-- 行わないと、約束の半分しか果たせない。
create or replace function purge_expired_photos()
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
  delete from photo_submission;   -- photo_pending は cascade で消える
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------
-- アクセス制御
--
-- Supabase の匿名キーは前端の JavaScript に必ず現れる。
-- 安全を担保しているのはここだけなので、緩めないこと（ADR-0004）。
-- ---------------------------------------------------------------

alter table photo_submission enable row level security;
alter table photo_pending    enable row level security;
alter table review_secret    enable row level security;
alter table board_like       enable row level security;
alter table board_like_count enable row level security;

-- 写真は、審査を通ったものであっても匿名からは読ませない。
-- 公開する形はリポジトリに置いた写真のほうであり、この表を読ませる必要が
-- どこにもないため（読ませないものは漏れない）。
-- select のポリシーを一つも作らない＝どの行も見えない。
revoke all on photo_submission from anon, authenticated;
revoke all on photo_pending    from anon, authenticated;
revoke all on review_secret    from anon, authenticated;
revoke all on board_like       from anon, authenticated;

-- いいねの数だけは誰でも読める（画面に出す数字そのもの）
revoke all on board_like_count from anon, authenticated;
grant select (target_id, likes) on board_like_count to anon, authenticated;

drop policy if exists board_like_count_select on board_like_count;
create policy board_like_count_select on board_like_count for select using (true);

-- 匿名に開けるのは、送る関数といいねの関数、そして審査の関数だけ。
-- 審査の関数はパスポートを知らないかぎり必ず例外で止まる（review_ok）。
revoke all on function submit_photo(text, text, text, double precision, double precision, text, text) from public, anon, authenticated;
revoke all on function record_board_like(text, boolean)   from public, anon, authenticated;
revoke all on function review_ok(text)                    from public, anon, authenticated;
revoke all on function review_pending(text)               from public, anon, authenticated;
revoke all on function review_photo(text, uuid)           from public, anon, authenticated;
revoke all on function review_decide(text, uuid, boolean) from public, anon, authenticated;
revoke all on function review_publish_queue(text)         from public, anon, authenticated;
revoke all on function review_mark_published(text, uuid, text) from public, anon, authenticated;
revoke all on function set_review_secret(text)            from public, anon, authenticated;
revoke all on function purge_photo_visitor()              from public, anon, authenticated;
revoke all on function purge_expired_photos()             from public, anon, authenticated;

grant execute on function submit_photo(text, text, text, double precision, double precision, text, text) to anon, authenticated;
grant execute on function record_board_like(text, boolean)   to anon, authenticated;
grant execute on function review_pending(text)               to anon, authenticated;
grant execute on function review_photo(text, uuid)           to anon, authenticated;
grant execute on function review_decide(text, uuid, boolean) to anon, authenticated;
grant execute on function review_publish_queue(text)         to anon, authenticated;
grant execute on function review_mark_published(text, uuid, text) to anon, authenticated;

-- Supabase なら pg_cron で一日一度：
--   select cron.schedule('purge-photo-visitor',  '30 4 * * *', 'select purge_photo_visitor()');
--   select cron.schedule('purge-expired-photos', '40 4 * * *', 'select purge_expired_photos()');
--
-- パスポートは SQL Editor から一度だけ決める（24文字以上。控えは手元に）：
--   select set_review_secret('（長い乱数）');
