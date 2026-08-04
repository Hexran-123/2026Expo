/*
 * 時刻表を読むための決まりごと
 *
 * data/schedule.json（人が手で書く時刻表）から、
 *   ・この駅から次に出る列車はどれか（発車待ち／設計書 4.2）
 *   ・いまこの列車は時刻表のうえでどこに居るはずか（遅れ／設計書 4.3）
 * を求める。
 *
 * 画面には触らない。ここにあるのは計算だけなので、
 * ブラウザを開かなくても node で確かめられる（tools/check-schedule.js とは別に、
 * 計算そのものの確かめは js/schedule.test.js にある）。
 */

(function (global) {
  'use strict';

  /** 1 日は 1440 分 */
  const DAY = 24 * 60;

  /** "07:16" を、その日の 0 時からの分数に直す */
  function toMinutes(text) {
    const [hour, minute] = text.split(':').map(Number);
    return hour * 60 + minute;
  }

  /**
   * 分数を "7:16" に戻す。時のほうは 0 を詰めない（時刻表の見た目に合わせる）。
   * 秒の端数を持つ分数（minutesOfDay の返り値）を渡されても、分どまりで出す。
   */
  function toClock(minutes) {
    const wrapped = ((Math.floor(minutes) % DAY) + DAY) % DAY;
    const hour = Math.floor(wrapped / 60);
    const minute = wrapped % 60;
    return `${hour}:${String(minute).padStart(2, '0')}`;
  }

  /** Date を、その日の 0 時からの分数に直す */
  function minutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  }

  /*
   * いまの時刻。
   *
   * 発車待ちも遅れも「いま何時か」を起点に決まる。端末の時計を直に読むと、
   * 銚子電鉄が走っていない時間帯には何も確かめられなくなるので、
   * ここだけ差し替えられるようにしてある。差し替えるのは走行シミュレーター
   * （js/simulate.js）だけで、ふだんは端末の時計をそのまま返す。
   */
  let clock = () => new Date();

  function now() {
    return clock();
  }

  /** @param {(() => Date)|null} fn 省略・null で端末の時計に戻す */
  function useClock(fn) {
    clock = typeof fn === 'function' ? fn : () => new Date();
  }

  /**
   * この駅から次に出る列車を、早い順に返す。
   *
   * 銚子電鉄は毎日同じダイヤなので、曜日を見る必要がない。
   * その駅を通らない列車（仲ノ町始発は銚子駅を通らない）は自然に外れる。
   *
   * 終電を過ぎたら空の配列を返す。翌日の始発は出さない。
   * 夜 11 時に「次は 5:37」と言われても、それは待てる列車ではない。
   *
   * @param {object} schedule data/schedule.json
   * @param {string} stationName 駅名（route.json の表記）
   * @param {Date} now いまの時刻
   * @param {number} limit いくつまで返すか
   * @param {string} [direction] 指定すれば、その方向（上り/下り）だけに絞る。
   *        乗車区間を設定したときに使う（feature-spec「乗車区間の設定」US3）。
   *        省略すれば今まで通り両方向から出す。
   */
  function nextDepartures(schedule, stationName, now, limit = 2, direction) {
    const currentMinutes = minutesOfDay(now);

    return schedule.列車
      .filter((train) => train.時刻[stationName] !== undefined)
      .filter((train) => direction === undefined || train.方向 === direction)
      .map((train) => ({
        train,
        方向: train.方向,
        // 終点に着くだけの列車は「発車」しない
        終点: isTerminusFor(schedule, train, stationName),
        時刻: train.時刻[stationName],
        分: toMinutes(train.時刻[stationName]),
      }))
      .filter((entry) => !entry.終点 && entry.分 >= currentMinutes)
      .sort((a, b) => a.分 - b.分)
      .slice(0, limit);
  }

  /** その駅が、この列車にとって終点かどうか */
  function isTerminusFor(schedule, train, stationName) {
    const order = schedule.駅順[train.方向];
    const stations = Object.keys(train.時刻);
    const last = stations.reduce((a, b) => (order.indexOf(a) > order.indexOf(b) ? a : b));
    return last === stationName;
  }

  /** その方向で、終点にあたる駅の名前 */
  function terminusOf(schedule, direction) {
    const order = schedule.駅順[direction];
    return order[order.length - 1];
  }

  /**
   * いまその列車は、時刻表のうえで路線のどこに居るはずか。
   *
   * 前後の駅の時刻から按分する。駅の間でも位置が出せるので、
   * 実際の位置と引き算すれば遅れが求まる（設計書 4.3）。
   *
   * @param {object} route data/route.json（駅の distanceAlong を使う）
   * @returns {number|null} 起点からの距離（m）。走っていない時間帯なら null
   */
  function scheduledDistance(schedule, route, train, now) {
    const distanceOf = new Map(route.stations.map((s) => [s.name, s.distanceAlong]));
    const order = schedule.駅順[train.方向];

    const stops = Object.keys(train.時刻)
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .map((name) => ({
        distance: distanceOf.get(name),
        minute: toMinutes(train.時刻[name]),
      }));

    const currentMinutes = minutesOfDay(now);
    if (currentMinutes < stops[0].minute) return null;
    if (currentMinutes > stops[stops.length - 1].minute) return null;

    for (let i = 1; i < stops.length; i += 1) {
      const from = stops[i - 1];
      const to = stops[i];
      if (currentMinutes > to.minute) continue;

      const span = to.minute - from.minute;
      const ratio = span === 0 ? 0 : (currentMinutes - from.minute) / span;
      return from.distance + (to.distance - from.distance) * ratio;
    }
    return stops[stops.length - 1].distance;
  }

  /**
   * いま走っているはずの列車のうち、進行方向が合うものを返す。
   *
   * どの列車に乗っているかを利用者に選ばせないため（設計書 3.2）。
   * 見つからなければ null。時刻表から離れすぎているときは、
   * 無理に当てはめるより「わからない」としたほうがよい。
   */
  function runningTrains(schedule, direction, now) {
    const currentMinutes = minutesOfDay(now);
    return schedule.列車.filter((train) => {
      if (train.方向 !== direction) return false;
      const times = Object.values(train.時刻).map(toMinutes);
      return currentMinutes >= Math.min(...times) && currentMinutes <= Math.max(...times);
    });
  }

  global.Schedule = {
    toMinutes,
    toClock,
    minutesOfDay,
    now,
    useClock,
    nextDepartures,
    terminusOf,
    scheduledDistance,
    runningTrains,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
