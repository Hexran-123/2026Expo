/*
 * check-schedule.js
 *
 * data/schedule.json（手で書く時刻表）に書き間違いがないか確かめる。
 *
 * なぜ要るか: 時刻表を書き間違えても、画面はエラーを出さない。
 *             発車時刻がずれ、遅れの計算が狂うだけで、黙って間違い続ける。
 *             ダイヤ改正のたびに手で書き写す以上、目で見るだけでは足りない。
 *
 * 使い方:  node tools/check-schedule.js [schedule.json] [route.json]
 *          間違いがなければ「OK」とだけ出る。あれば何号の何かを言う。
 *
 * 引数は省略できる。省略したときは銚子電鉄を見る。
 * 試験用の路線を確かめるときは渡すこと:
 *   node tools/check-schedule.js data/yurakucho/schedule.json data/yurakucho/route.json
 */

const fs = require('fs');
const path = require('path');

const SCHEDULE_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'data', 'choshi', 'schedule.json');
const ROUTE_PATH = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(__dirname, '..', 'data', 'choshi', 'route.json');

/*
 * 全区間の所要時間の目安は、路線の長さから出す。
 *
 * 直値で 15〜30 分としていたころは、銚子（6.5km）にしか通用しなかった。
 * 有楽町線（28.4km）に当てると、正しい時刻表でも全部「変」と言ってしまう。
 * 表定速度がこの範囲に収まっていれば妥当とみなす。停車時間も込みの平均で、
 * ローカル線からやや速い地下鉄までを含む幅にしてある。
 */
const SLOWEST_KMH = 12;
const FASTEST_KMH = 45;

/** "07:16" を、その日の 0 時からの分数に直す */
/*
 * "07:16" を、その日の 0 時からの分数に直す。
 *
 * 24 時以降も受ける。終電は日をまたぐので、鉄道の時刻表は 0:05 を
 * 「24:05」と書く。そう書いておくと、1 本の列車のなかで時刻が
 * 増えつづける（下の「時刻は必ず増えていく」がそのまま使える）。
 * 画面に出すときは js/schedule.js の toClock が 0:05 に直す。
 */
function toMinutes(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 27 || minute > 59) return null;
  return hour * 60 + minute;
}

function main() {
  const schedule = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  const route = JSON.parse(fs.readFileSync(ROUTE_PATH, 'utf8'));
  const knownStations = new Set(route.stations.map((station) => station.name));

  /*
   * 所要時間の目安は、**その列車が実際に走る区間の長さ**から出す。
   *
   * 路線の全長で決め打ちしていたころは、全線を通す列車しか通らなかった。
   * 有楽町線には小竹向原から西武線へ抜ける列車のような区間運転があり、
   * 正しい時刻表でも「所要 30 分は変」と言ってしまう。
   */
  const distanceOf = new Map(route.stations.map((s) => [s.name, s.distanceAlong]));
  const rideRange = (from, to) => {
    const meters = Math.abs((distanceOf.get(to) ?? 0) - (distanceOf.get(from) ?? 0));
    const km = meters / 1000;
    return {
      min: Math.floor((km / FASTEST_KMH) * 60),
      max: Math.ceil((km / SLOWEST_KMH) * 60),
    };
  };

  const problems = [];
  const report = (train, message) => problems.push(`${train.番号}号（${train.方向}）: ${message}`);

  // 列車番号は重複しない
  const numbers = schedule.列車.map((train) => train.番号);
  if (new Set(numbers).size !== numbers.length) {
    problems.push('列車番号が重複している');
  }

  for (const train of schedule.列車) {
    const order = schedule.駅順[train.方向];
    if (!order) {
      report(train, `方向が「下り」でも「上り」でもない`);
      continue;
    }

    const stations = Object.keys(train.時刻);

    // 駅名は route.json にあるものだけ（表記ゆれを防ぐ）
    for (const station of stations) {
      if (!knownStations.has(station)) report(train, `route.json に無い駅名「${station}」`);
    }

    // 駅順のとおりに、飛ばさず並んでいる
    const positions = stations.map((station) => order.indexOf(station));
    for (let i = 1; i < positions.length; i += 1) {
      if (positions[i] !== positions[i - 1] + 1) {
        report(train, `${stations[i - 1]} の次が ${stations[i]} になっている`);
      }
    }

    // 時刻は必ず増えていく
    const times = stations.map((station) => toMinutes(train.時刻[station]));
    for (let i = 0; i < times.length; i += 1) {
      if (times[i] === null) {
        report(train, `${stations[i]} の時刻「${train.時刻[stations[i]]}」が hh:mm ではない`);
      } else if (i > 0 && times[i - 1] !== null && times[i] <= times[i - 1]) {
        report(train, `${stations[i - 1]} から ${stations[i]} で時刻が戻っている`);
      }
    }

    // 走った区間の所要時間がありえる範囲か
    if (times[0] !== null && times[times.length - 1] !== null && stations.length >= 2) {
      const ride = times[times.length - 1] - times[0];
      const { min, max } = rideRange(stations[0], stations[stations.length - 1]);
      if (ride < min || ride > max) {
        report(train, `所要 ${ride} 分は変（${min}〜${max} 分のはず）`);
      }
    }

    /*
     * 途中の駅を抜かさないこと（上の「駅順のとおりに、飛ばさず並んでいる」）は
     * 確かめるが、**全駅に停まることは求めない。**
     *
     * 全駅ぶん揃っていることを条件にしていたころは、銚子電鉄しか通らなかった。
     * 通らない例が二つある。
     *   ・区間運転と直通。有楽町線には小竹向原から西武線へ抜ける列車があり、
     *     有楽町線内では小竹向原から先しか走らない。
     *   ・終点の到着時刻。駅別時刻表から起こした時刻表は、終点では発車が無いので
     *     その駅を持たない（data/yurakucho/schedule.json の _note）。
     * どちらも正しい時刻表なので、ここで弾かない。
     */
    if (stations.length < 2) {
      report(train, `駅が ${stations.length} 個しかない（2 駅以上要る）`);
    }
  }

  const down = schedule.列車.filter((train) => train.方向 === '下り').length;
  const up = schedule.列車.filter((train) => train.方向 === '上り').length;
  console.log(`改正日 ${schedule.改正日}　下り ${down} 本 / 上り ${up} 本`);

  if (problems.length === 0) {
    console.log('OK');
  } else {
    for (const problem of problems) console.log(`NG ${problem}`);
    process.exitCode = 1;
  }
}

main();
