/*
 * sw.js ─ 一度読んだものを、ブラウザに蓄えておく係
 *
 * 何のためか。
 *
 * ひとつは速さ。この作品は開くたびに css・js・地形・線路・スポット・時刻表・
 * 陰影を取りに行く。携帯電話の回線では、それだけで 2 秒前後かかる。
 * 二度目からは蓄えたものを使えば、電波の状態にかかわらずすぐ出る。
 * 展示では 1 日に何度も同じ画面を開くので、ここが効く。
 *
 * もうひとつは圏外。設計書 9.3 が「絶景スポットの情報、時刻表、地図、
 * アイコンは乗車前にまとめてブラウザへ保存する。通信が切れても通知と
 * 遅れの表示は動く」と決めている。その保存にあたるのがこれ。
 * トンネルでも、一度開いた路線なら地図と通知は動く。
 *
 * 何を蓄え、何を蓄えないか。
 *
 *   同じところから来るもの（css・js・data・陰影）… 蓄える
 *   よそから来るもの（気象庁の予報・Supabase）    … 触らない
 *
 * よそのものに手を出さないのは、天気や投稿数のような「そのときの値」を
 * 古いまま出さないため。取れなければ本体が黙って引っこめる作りになっている。
 *
 * 蓄えたものをいつ新しくするか。
 *
 *   HTML          … 毎回取りに行き、取れなければ蓄えたものを出す
 *   それ以外      … まず蓄えたものを出し、裏で新しいものを取って次に備える
 *
 * この作りだと、直したものが画面に出るのは**次に開いたとき**になる。
 * すぐ確かめたい場面で困らないよう、**localhost では動かさない**
 * （登録しているのは index.html の末尾。https のときだけ登録する）。
 *
 * 全部を消したいとき（何かおかしいとき）は、ブラウザの開発者ツールの
 * Application → Service Workers → Unregister、または下の VERSION を上げる。
 */

/** 蓄えの世代。ここを上げると、古い蓄えを全部捨てて入れ直す */
const VERSION = 'v2';

const CACHE = `choshi-navi-${VERSION}`;

self.addEventListener('install', () => {
  /*
   * 先に一式を集めることはしない。集める一覧を手で持つと、
   * ファイルを 1 つ増やすたびに書き足す必要があり、書き忘れると
   * そのファイルだけ圏外で動かない、という分かりにくい壊れ方をする。
   * 実際に読んだものをそのつど蓄えるほうが、手入れが要らない。
   */
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

/** まず取りに行く。取れなければ蓄えたもの（HTML 用） */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  } catch (error) {
    const saved = await caches.match(request);
    if (saved) return saved;
    throw error;
  }
}

/** まず蓄えたものを出し、裏で新しくしておく（css・js・data・画像 用） */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(request);

  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (saved) return saved;

  const response = await fresh;
  if (response) return response;
  throw new Error(`${request.url} を取れなかった`);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 書き込み（投稿など）には触らない
  if (request.method !== 'GET') return;

  // 気象庁・Supabase などは、そのつど取りに行かせる
  if (new URL(request.url).origin !== self.location.origin) return;

  /*
   * demo/*.html（1 枚デモ）には触らない。
   *
   * あちらは通信を一切しない前提の別物（README「サーバーなしで見せる
   * 1 枚を作る」）で、蓄える意味が無いどころか害になる。scope はこの
   * sw.js が index.html から登録されている都合で /demo/ も覆ってしまうが、
   * ここで一斉に見逃せば scope 自体を狭める必要はない。
   *
   * 見逃さないと何が起きるか。1 枚デモを一度開くと networkFirst が
   * そのときの HTML を蓄える。次に電波が悪い場所で開くと、フェッチが
   * 失敗して「そのとき蓄えた古い HTML」に落ちる。中身が直っていない
   * バージョンだったら、直したはずの不具合がそのまま再現する
   * （実際に js/simulate.js の 404 でこれが起きた）。
   */
  if (new URL(request.url).pathname.includes('/demo/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
