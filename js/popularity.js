/*
 * 累積人気（ADR-0004）
 *
 * 成因カードが開かれた回数を絶景スポットごとに数え、その多寡を
 * カードの一コマ目の記章で見せる。数えるのは開いた回数だけで、
 * どのくらい読んでいたかは端末から出さない。
 *
 * ここは作品の本体ではない。届かなければ記章が出ないだけで、
 * 地図も通知も成因カードも旅の記録もこれまでどおり動く（設計書 9.3）。
 * そのため、失敗は一切画面に出さない。3 秒で打ち切って黙って諦める。
 *
 * 匿名キーがこの通り前端に現れるのは、それが公開される前提の鍵だから
 * である。安全を担保しているのはこの鍵ではなく、データベース側の
 * Row Level Security のほう（supabase/schema/001_spot_opens.sql）。
 * 読めるのは集計表だけ、書き込めるのは record_spot_open() の中だけで、
 * 誰が開いたかの記録はこの鍵からは一切見えない。
 */

(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // 宛先
  //
  // ここを空文字にすれば、この機能はまるごと止まる。作品は動きつづける。
  // ------------------------------------------------------------------

  const ENDPOINT = 'https://psnsdqcsixztzodmnesa.supabase.co/rest/v1';
  const ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
    '.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzbnNkcWNzaXh6dHpvZG1uZXNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNzQwMzksImV4cCI6MjEwMTg1MDAzOX0' +
    '._FoDgX5UA83wwNnvM8lnaq7vdpjJvcNRvE0Ok8ug6-Y';

  /** これを過ぎたら諦める。電波の弱い区間で画面を待たせないため */
  const TIMEOUT_MS = 3000;

  /*
   * 絶景スポットの id の形。データベース側の check と同じ。
   * 頭文字は路線ごと（銚子電鉄は S、有楽町線は Y）。dataSource が
   * "real" の路線だけがここまで来る（呼び出し側の gating）ので、
   * ここは「id の形が壊れていないか」だけを見る。
   */
  const SPOT_ID = /^[SY][0-9]{2}$/;

  // ------------------------------------------------------------------
  // 記章の段
  //
  // 5 / 8 / 10 の三段。5 に届くまでは何も出さない。
  //
  // 段を三つに切ってあるのは、生の数字だけを出すと、公開直後や現地展示の
  // ように数がほとんど無い時期に「0 人」「1 人」が並ぶためである。段なら
  // 届いていないあいだは何も出ないだけで済む（ADR-0004 の「無いなら出さない」）。
  // ------------------------------------------------------------------

  const STEPS = [
    { at: 10, level: 3 },
    { at: 8,  level: 2 },
    { at: 5,  level: 1 },
  ];

  /**
   * 回数から記章の段を求める。
   * @returns {number} 0 なら記章を出さない
   */
  function levelFor(opens) {
    if (typeof opens !== 'number' || !Number.isFinite(opens)) return 0;
    for (const step of STEPS) {
      if (opens >= step.at) return step.level;
    }
    return 0;
  }

  // ------------------------------------------------------------------
  // 数える
  // ------------------------------------------------------------------

  /**
   * 成因カードが開かれたことを伝え、その絶景スポットの現在の回数を返す。
   *
   * 同じ人が同じ絶景スポットを一日に何度開いても 1 回にまとめられる。
   * まとめる判断はサーバー側で行う。端末が名乗る id を信じると、名乗り
   * 直すだけで何度でも数を増やせてしまうため（ADR-0004 の追記）。
   *
   * @returns {Promise<number|null>} 届かなければ null。呼ぶ側は何も出さない。
   */
  async function record(spotId) {
    if (!ENDPOINT || !SPOT_ID.test(spotId || '')) return null;

    // 打ち切るための仕掛け。fetch 自体には時間切れが無い
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${ENDPOINT}/rpc/record_spot_open`, {
        method: 'POST',
        signal: giveUp.signal,
        headers: {
          'apikey': ANON_KEY,
          'Authorization': `Bearer ${ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_spot_id: spotId }),
      });

      if (!response.ok) return null;

      const opens = await response.json();
      return typeof opens === 'number' ? opens : null;
    } catch (error) {
      // 時間切れ・電波なし・宛先が止まっている。どれも画面には出さない
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /*
   * 宛先と鍵は、投稿（js/journal.js の submit）でも使う。
   *
   * 二か所に書き写さないのは、上の「ここを空文字にすれば、この機能は
   * まるごと止まる」を保つため。書き写すと、片方だけ残って通信が続く。
   * js/journal.js は Popularity が読めていないときは投稿の口そのものを
   * 出さない（設計書 9.3 の「無いなら出さない」）。
   */
  global.Popularity = { record, levelFor, STEPS, SPOT_ID, ENDPOINT, ANON_KEY, TIMEOUT_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
