/*
 * 写真を絶景掲示板へ送る（ADR-0004、docs/絶景掲示板_設計メモ.md）
 *
 * 送り口は二つある。どちらもここを通る。
 *   ・旅の記録の「絶景掲示板に出す」（js/journal.js、スマートフォン）
 *   ・掲示板の投稿モーダル（board.html、パソコン）
 * 二か所に同じ処理を書き写すと、EXIF を落とす手順が片方だけ古くなる。
 *
 * **ここが、写真が端末の外へ出る唯一の場所である**（設計書 7.1）。
 * 車上モードで撮った写真は IndexedDB に留まり、利用者が投稿を押したときだけ、
 * この関数を通って出ていく。他のどこからも送らないこと。
 *
 * 送る前に必ず次の二つをする。
 *   ・**EXIF を落とす。** canvas に描き直して書き出すので、撮影地点・端末・
 *     撮影時刻はいずれも残らない。どの絶景の近くで撮ったかは別に記録して
 *     あるので、落としても失われる情報はない（設計書 7.1）。
 *   ・**小さくする。** 長辺 1600px。掲示板は長辺 1200px で出すので、
 *     これ以上大きく預かっても使い道がない。預かるものは軽いほどよい。
 *
 * 宛先と鍵は js/popularity.js が持っている。読めていなければ送り口そのものを
 * 出さない（設計書 9.3 の「無いなら出さない」）ので、ここには来ない。
 */

(function (global) {
  'use strict';

  /** 長辺の上限。掲示板に出すのは 1200px なので、預かるのはその少し上まで */
  const MAX_EDGE = 1600;

  /** サーバー側の上限と揃える（supabase/schema/003_photos.sql の 3000000） */
  const MAX_BYTES = 3000000;

  /*
   * 写真は文字より重い。累積人気の 3 秒はもちろん、文の投稿の 8 秒でも
   * 足りないことがある。利用者が押して待っている操作なので、長めに待つ。
   */
  const TIMEOUT_MS = 30000;

  /** 1 回の乗車で送れる枚数（旅の記録の側の上限。サーバー側は 1 日 20 枚） */
  const TRIP_LIMIT = 5;

  function server() {
    if (typeof Popularity === 'undefined' || !Popularity.ENDPOINT) return null;
    return { endpoint: Popularity.ENDPOINT, key: Popularity.ANON_KEY };
  }

  /**
   * 画像を読み込む。
   *
   * createImageBitmap に imageOrientation: 'from-image' を渡すと、EXIF の
   * 向き（横に倒して撮った写真）を反映してから渡してくれる。canvas に
   * 描き直すと EXIF ごと消えるので、ここで反映しておかないと、落とした
   * とたんに写真が横倒しになる。
   */
  async function loadImage(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (error) {
        // 古い実装は第 2 引数を受け取らない。下の <img> に落とす
      }
    }
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('画像として読めない'));
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  /**
   * 送れる形にする。EXIF を落とし、長辺 1600px に縮める。
   *
   * WebP で書き出せない端末（古い Safari）では JPEG になる。どちらで来ても
   * 受け取れるようにしてあるので（003_photos.sql の mime）、ここでは
   * 出せたほうを使う。
   *
   * @returns {Promise<{blob: Blob, mime: string}>}
   */
  async function toUploadable(file) {
    const image = await loadImage(file);
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    if (!width || !height) throw new Error('大きさの分からない画像');

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    if (typeof image.close === 'function') image.close();

    let blob = await toBlob(canvas, 'image/webp', 0.82);
    let mime = 'image/webp';
    // toBlob は、その形式を書き出せないと黙って PNG を返す実装がある
    if (!blob || blob.type !== 'image/webp') {
      blob = await toBlob(canvas, 'image/jpeg', 0.82);
      mime = 'image/jpeg';
    }
    if (!blob) throw new Error('書き出せなかった');
    if (blob.size > MAX_BYTES) throw new Error('写真が大きすぎる');

    return { blob, mime };
  }

  /** Blob を base64 に。SQL 側は text で受け取り、decode(..., 'base64') で戻す */
  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma < 0 ? result : result.slice(comma + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /**
   * 1 枚送る。
   *
   * 送れたかどうかだけを返す。何が起きたかは画面に出さない——直せることは
   * 「電波の良いところでもう一度」しかないので、それだけを呼ぶ側が伝える。
   *
   * @param {object} where
   * @param {'navi'|'board'} where.source
   * @param {string} where.lineId
   * @param {string|null} where.spotId  navi のとき。撮ったときの絶景スポット
   * @param {number|null} where.lat     board のとき。地図で置いた座標
   * @param {number|null} where.lon
   * @param {Blob} where.blob
   * @param {string} where.mime
   * @returns {Promise<string|null>} 預かった投稿の id。届かなければ null
   */
  async function send(where) {
    const to = server();
    if (to === null) return null;

    const content = await toBase64(where.blob);

    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${to.endpoint}/rpc/submit_photo`, {
        method: 'POST',
        signal: giveUp.signal,
        headers: {
          'apikey': to.key,
          'Authorization': `Bearer ${to.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_line_id: where.lineId,
          p_source: where.source,
          p_spot_id: where.spotId || null,
          p_lat: typeof where.lat === 'number' ? where.lat : null,
          p_lon: typeof where.lon === 'number' ? where.lon : null,
          p_mime: where.mime,
          p_content: content,
        }),
      });
      if (!response.ok) return null;
      const id = await response.json();
      return typeof id === 'string' ? id : null;
    } catch (error) {
      // 時間切れ・電波なし・宛先が止まっている。写真は端末に残る
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  global.PhotoPost = { toUploadable, send, server, MAX_EDGE, MAX_BYTES, TRIP_LIMIT, TIMEOUT_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
