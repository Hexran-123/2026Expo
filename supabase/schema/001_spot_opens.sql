-- 累積人気（設計書 ADR-0004）
--
-- 成因カードが開かれた回数を、絶景スポットごとに数える。
-- 数えるのは「開いた回数」だけで、滞在時間は端末から出さない。
-- 「この絶景は 120 回開かれた」は誰にでも意味が読み取れるが、
-- 「平均 43 秒」は読み取れる意味がないため（ADR-0004）。
--
-- このファイルは素の PostgreSQL でも Supabase でもそのまま動く。
-- 手元の PostgreSQL で試してから Supabase の SQL Editor に貼ること。
-- 手元で試すときは supabase/local/setup_and_verify.sql を先に流す。

-- ---------------------------------------------------------------
-- 表
-- ---------------------------------------------------------------

-- 公開する集計。画面に出るのはこの表だけ。
create table if not exists spot_open_count (
  -- spots.json の id と同じ形。実データを持ってくるのではなく、
  -- 形だけを縛る。データベースに絶景スポットの一覧を置くと
  -- spots.json と二重管理になり、ADR-0004 の「data/ 以下は
  -- 一つもサーバーへ移さない」とも衝突するため。
  -- この形は最大 100 行までしか作れないので、荒らされても被害が有限。
  spot_id    text primary key check (spot_id ~ '^S[0-9]{2}$'),
  opens      bigint      not null default 0 check (opens >= 0),
  updated_at timestamptz not null default now()
);

comment on table spot_open_count is
  '成因カードが開かれた累積回数。誰でも読める。書き込みは record_spot_open() 経由のみ。';

-- 重複を弾くためだけの記録。公開しない。
--
-- 同じ人が同じ絶景スポットを一日に何度開いても 1 回として数える。
-- そうしないと、カードを開いて閉じてを繰り返すだけで数字が動く。
create table if not exists spot_open_log (
  spot_id   text not null check (spot_id ~ '^S[0-9]{2}$'),
  -- IP アドレスそのものではなく、日付を混ぜたハッシュ。
  -- 日付が変われば値も変わるので、日をまたいで同じ人を追えない。
  visitor   text not null,
  opened_on date not null default current_date,
  primary key (spot_id, visitor, opened_on)
);

comment on table spot_open_log is
  '重複排除のためだけの記録。90 日で消す。匿名キーからは一切見えない。';

create index if not exists spot_open_log_opened_on_idx
  on spot_open_log (opened_on);

-- ---------------------------------------------------------------
-- 訪問者のキー
-- ---------------------------------------------------------------

-- IP アドレスに日付と秘密の文字列を混ぜて、ハッシュにして返す。
--
-- 端末側が作った ID を信じない理由：毎回作り直せば同じ人が何度でも
-- 数を増やせてしまう。IP なら端末の自己申告ではない——ただし、
-- **どのヘッダから取るかを間違えると偽れる**。2026-08-11 に実測した:
--
--   ヘッダを付けずに呼ぶ    x-forwarded-for = 「本物」
--   X-Forwarded-For を詐称  x-forwarded-for = 「詐称値,本物」
--   CF-Connecting-IP を詐称 Cloudflare が門前払い（error code 1000）
--
-- x-forwarded-for を丸ごと使うと、詐称部分を変えるだけで毎回ちがう
-- 訪問者になり、回数をいくらでも増やせた（実際に 1 → 4 まで増やせた）。
-- 代理は本物を**末尾に足す**ので、最後の 1 つだけを採れば偽れない。
--
-- cf-connecting-ip を先に見るのは、こちらが Cloudflare の独占で、
-- 連鎖の解釈が要らないぶん確かなため。Supabase が Cloudflare を
-- 経由しなくなったときは x-forwarded-for 側へ静かに落ちる。
--
-- 素の PostgreSQL にはリクエストヘッダが無いので 'local' に落ちる。
-- 手元で試すときは全員が同じ訪問者になるが、重複排除の動きは確認できる。
create or replace function visitor_key()
returns text
language plpgsql
stable
as $$
declare
  v_headers json;
  v_ip      text;
  v_xff     text;
  v_salt    text;
begin
  begin
    v_headers := current_setting('request.headers', true)::json;
  exception when others then
    v_headers := null;
  end;

  -- Cloudflare が付ける。端末からは送れない（送ると弾かれる）。
  v_ip := nullif(btrim(coalesce(v_headers ->> 'cf-connecting-ip', '')), '');

  -- 備え。「詐称値, 詐称値, 本物」と連なるので、最後の 1 つだけを採る。
  if v_ip is null then
    v_xff := v_headers ->> 'x-forwarded-for';
    if v_xff is not null then
      -- '^.*,' は最長一致なので、最後のカンマまでを丸ごと捨てる。
      -- カンマが無ければ（代理が 1 段だけなら）そのまま全体が残る。
      v_ip := nullif(btrim(regexp_replace(v_xff, '^.*,', '')), '');
    end if;
  end if;

  -- 本番では ALTER DATABASE ... SET app.visitor_salt = '...' で必ず入れ替える。
  -- 入れ替えないと、IP を総当たりしてハッシュを逆引きできてしまう。
  v_salt := coalesce(current_setting('app.visitor_salt', true), 'CHANGE-ME-BEFORE-DEPLOY');

  return encode(
    sha256(convert_to(coalesce(v_ip, 'local') || '|' || current_date::text || '|' || v_salt, 'UTF8')),
    'hex'
  );
end;
$$;

-- ---------------------------------------------------------------
-- 数える
-- ---------------------------------------------------------------

-- 成因カードが開かれたときに呼ぶ。今日すでに数えていれば何もしない。
-- 戻り値はその絶景スポットの現在の回数。
--
-- security definer にしてあるのは、匿名の利用者に表への直接の書き込みを
-- 許さないため。書き込めるのはこの関数の中だけになる。
create or replace function record_spot_open(p_spot_id text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visitor text;
  v_opens   bigint;
begin
  if p_spot_id is null or p_spot_id !~ '^S[0-9]{2}$' then
    raise exception 'unknown spot_id';
  end if;

  v_visitor := visitor_key();

  insert into spot_open_log (spot_id, visitor, opened_on)
  values (p_spot_id, v_visitor, current_date)
  on conflict do nothing;

  -- 今日すでに数えていた。集計は動かさず、今の値だけ返す。
  if not found then
    select opens into v_opens from spot_open_count where spot_id = p_spot_id;
    return coalesce(v_opens, 0);
  end if;

  insert into spot_open_count (spot_id, opens)
  values (p_spot_id, 1)
  on conflict (spot_id) do update
    set opens = spot_open_count.opens + 1,
        updated_at = now()
  returning opens into v_opens;

  return v_opens;
end;
$$;

-- 90 日より古い記録を消す。
-- 重複排除に要るのは「今日ぶん」だけなので、本来は 1 日で足りる。
-- 90 日残すのは、荒らしの申し立てがあったときに突き合わせるため（ADR-0004）。
create or replace function purge_spot_open_log()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from spot_open_log where opened_on < current_date - 90;
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

alter table spot_open_count enable row level security;
alter table spot_open_log   enable row level security;

-- 集計は誰でも読める。書き込みのポリシーは作らない＝拒否される。
drop policy if exists spot_open_count_select on spot_open_count;
create policy spot_open_count_select
  on spot_open_count for select
  using (true);

-- spot_open_log にはポリシーを一つも作らない＝匿名からは読めも書けもしない。
-- security definer の関数だけが触れる。

-- 表への直接の権限を落とす。読むのは select だけ、書き込みは関数経由。
revoke all on spot_open_count from anon, authenticated;
revoke all on spot_open_log   from anon, authenticated;
grant select on spot_open_count to anon, authenticated;

-- 数える関数だけを匿名に開ける。
revoke all on function record_spot_open(text)   from public, anon, authenticated;
revoke all on function purge_spot_open_log()    from public, anon, authenticated;
revoke all on function visitor_key()            from public, anon, authenticated;
grant execute on function record_spot_open(text) to anon, authenticated;

-- purge は運用側だけが呼ぶ。Supabase なら pg_cron で一日一度：
--   select cron.schedule('purge-spot-open-log', '0 4 * * *', 'select purge_spot_open_log()');
