/*
 * schedule.js の計算を確かめる。
 *
 * 使い方:  node js/schedule.test.js
 *
 * ブラウザを開かずに確かめられるようにしてある。
 * 発車待ちの表示も遅れの計算も、間違っていても画面はエラーを出さない。
 * 「9 時に銚子で待っていたら次は 9:03」のような、目で確かめられる例を並べておく。
 */

const fs = require('fs');
const path = require('path');

require('./schedule.js');
const {
  nextDepartures, scheduledDistance, runningTrains, toClock, timetableForStation,
} = globalThis.Schedule;

const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'choshi', name), 'utf8'));
const schedule = read('schedule.json');
const route = read('route.json');

/** その日の hh:mm の Date を作る（日付は何でもよい。曜日で変わらないダイヤなので） */
const at = (text) => {
  const [hour, minute] = text.split(':').map(Number);
  return new Date(2026, 7, 2, hour, minute, 0);
};

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  NG   ${label}\n         期待 ${e}\n         実際 ${a}`);
  }
}

// 画面に出す形（toClock を通したもの）で確かめる。時刻表の見た目に合わせて 0 を詰めない。
const departures = (station, time, limit) =>
  nextDepartures(schedule, station, at(time), limit).map((d) => `${toClock(d.分)} ${d.方向}`);

console.log('次の発車');
// 銚子 9:03 発（15号・下り）。上りは銚子が終点なので出てこない。
check('銚子で 9:00', departures('銚子', '9:00', 2), ['9:03 下り', '10:00 下り']);
// 発車時刻ちょうどは、まだ出ていないものとして残す
check('銚子で 9:03 ちょうど', departures('銚子', '9:03', 1), ['9:03 下り']);
check('銚子で 9:04', departures('銚子', '9:04', 1), ['10:00 下り']);
// 外川は下りの終点。上りだけが出る
check('外川で 9:00', departures('外川', '9:00', 2), ['9:30 上り', '10:39 上り']);
// 途中駅は両方向が混ざる
check('本銚子で 9:00', departures('本銚子', '9:00', 3), ['9:09 下り', '9:43 上り', '10:06 下り']);
// 終電のあと。翌日の始発は出さない
check('銚子で 21:00（終電後）', departures('銚子', '21:00', 2), []);
check('外川で 21:20', departures('外川', '21:20', 2), []);
// 仲ノ町始発の 1 号は銚子駅を持たない。銚子で待つ人には出ない
check('銚子で 5:00', departures('銚子', '5:00', 1), ['6:26 下り']);
check('仲ノ町で 5:00', departures('仲ノ町', '5:00', 1), ['5:37 下り']);

// 乗車区間を設定したときの絞り込み（feature-spec「乗車区間の設定」US3）
const departuresDirected = (station, time, limit, direction) =>
  nextDepartures(schedule, station, at(time), limit, direction).map((d) => `${toClock(d.分)} ${d.方向}`);
check('本銚子で 9:00・下りだけ', departuresDirected('本銚子', '9:00', 3, '下り'), ['9:09 下り', '10:06 下り', '11:21 下り']);
check('本銚子で 9:00・上りだけ', departuresDirected('本銚子', '9:00', 3, '上り'), ['9:43 上り', '10:52 上り', '11:57 上り']);

console.log('\n駅の時刻表（画面で駅を押すと出るもの）');
const timetableCount = (station, direction) =>
  timetableForStation(schedule, station).filter((t) => t.方向 === direction).length;
// 終点では、そこへ着くだけの列車（終電・下り）を数に入れない
check('銚子は下りだけ（39本発車、上りは0）', [timetableCount('銚子', '下り'), timetableCount('銚子', '上り')], [17, 0]);
check('外川は上りだけ', [timetableCount('外川', '下り'), timetableCount('外川', '上り')], [0, 19]);
// 途中駅は両方向とも通る列車がすべて乗る
check('本銚子は両方向', [timetableCount('本銚子', '下り'), timetableCount('本銚子', '上り')], [19, 19]);
// 早い順に並んでいること
const timesOf = (station, direction) =>
  timetableForStation(schedule, station).filter((t) => t.方向 === direction).map((t) => t.分);
{
  const times = timesOf('本銚子', '下り');
  const sorted = [...times].sort((a, b) => a - b);
  check('本銚子・下りは時刻順', times, sorted);
}
// 仲ノ町始発の1号は銚子を持たない列車なので、銚子の時刻表には出ない
check('銚子の時刻表に1号は無い', timetableForStation(schedule, '銚子').some((t) => t.番号 === 1), false);

console.log('\n走っている列車');
const runningAt = (direction, time) =>
  runningTrains(schedule, direction, at(time)).map((t) => t.番号);
// 15号は 9:03 銚子発 → 9:25 外川着
check('9:10 の下り', runningAt('下り', '9:10'), [15]);
// 下りが 1 本も走っていない時間帯
check('9:40 の下り', runningAt('下り', '9:40'), []);
check('9:40 の上り', runningAt('上り', '9:40'), [14]);

console.log('\n時刻表のうえでの位置');
const train15 = schedule.列車.find((t) => t.番号 === 15);
const distanceAt = (time) => {
  const d = scheduledDistance(schedule, route, train15, at(time));
  return d === null ? null : Math.round(d);
};
// 9:03 に銚子（0m）を出て、9:25 に外川へ着く。
// 外川駅は 6440m。線路はその先 6498m まで続くが、駅はそこではない。
check('15号 9:03（銚子）', distanceAt('9:03'), 0);
check('15号 9:25（外川）', distanceAt('9:25'), 6440);
// 9:05 は仲ノ町（516m）ちょうど
check('15号 9:05（仲ノ町）', distanceAt('9:05'), 516);
// 駅の間も按分される。9:04 は銚子と仲ノ町のまんなか
check('15号 9:04（駅間）', distanceAt('9:04'), 258);
// 走っていない時間は null
check('15号 9:00（発車前）', distanceAt('9:00'), null);
check('15号 9:30（到着後）', distanceAt('9:30'), null);

console.log('\n時刻の書き方');
check('0 時台', toClock(5 * 60 + 7), '5:07');
check('日をまたいでも壊れない', toClock(-1), '23:59');

console.log('');
if (failures === 0) {
  console.log('OK すべて通った');
} else {
  console.log(`NG ${failures} 件`);
  process.exitCode = 1;
}
