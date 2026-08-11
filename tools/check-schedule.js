/*
 * check-schedule.js
 *
 * data/schedule.json（手で書く時刻表）に書き間違いがないか確かめる。
 *
 * なぜ要るか: 時刻表を書き間違えても、画面はエラーを出さない。
 *             発車時刻がずれ、遅れの計算が狂うだけで、黙って間違い続ける。
 *             ダイヤ改正のたびに手で書き写す以上、目で見るだけでは足りない。
 *
 * 使い方:  node tools/check-schedule.js
 *          間違いがなければ「OK」とだけ出る。あれば何行目の何かを言う。
 */

const fs = require('fs');
const path = require('path');

const SCHEDULE_PATH = path.join(__dirname, '..', 'data', 'choshi', 'schedule.json');
const ROUTE_PATH = path.join(__dirname, '..', 'data', 'choshi', 'route.json');

/** 銚子から外川まで、実際には 19〜22 分。これを外れたら書き間違いを疑う */
const RIDE_MIN = 15;
const RIDE_MAX = 30;

/** "07:16" を、その日の 0 時からの分数に直す */
function toMinutes(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function main() {
  const schedule = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  const route = JSON.parse(fs.readFileSync(ROUTE_PATH, 'utf8'));
  const knownStations = new Set(route.stations.map((station) => station.name));

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

    // 全線の所要時間がありえる範囲か
    if (times[0] !== null && times[times.length - 1] !== null) {
      const ride = times[times.length - 1] - times[0];
      if (ride < RIDE_MIN || ride > RIDE_MAX) {
        report(train, `所要 ${ride} 分は変（${RIDE_MIN}〜${RIDE_MAX} 分のはず）`);
      }
    }

    // 途中の駅を抜かす列車はない。仲ノ町始発（車庫）だけが銚子駅を持たない
    const isDepotStart = train.方向 === '下り' && stations[0] === '仲ノ町';
    if (stations.length !== order.length && !(isDepotStart && stations.length === order.length - 1)) {
      report(train, `駅が ${stations.length} 個しかない`);
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
