/*
 * onboard.js の計算を確かめる。
 *
 * 使い方:  node js/onboard.test.js
 *
 * 車上モードは実際に電車に乗らないと試せないが、計算だけは机の上で確かめられる。
 * 通知が出ない・左右が逆・遅れが狂う、といった間違いは画面にエラーを出さないので、
 * 実際の駅とスポットの座標を使って、目で確かめられる例を並べておく。
 */

const fs = require('fs');
const path = require('path');

require('./schedule.js');
require('./onboard.js');
const Schedule = globalThis.Schedule;
const {
  prepareTrack, projectOntoTrack, looksLikeRiding, isOnRoute,
  directionOf, trackDirection, spotsAhead, noticeFor, delayMinutes, nextStopEta, distanceMeters,
} = globalThis.Onboard;

const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'choshi', name), 'utf8'));
const route = read('route.json');
const spots = read('spots.json').spots;
const schedule = read('schedule.json');
const track = prepareTrack(route);

const station = (name) => route.stations.find((s) => s.name === name);
const spot = (id) => spots.find((s) => s.id === id);
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
function near(label, actual, expected, tolerance) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    console.log(`  ok   ${label}（${Math.round(actual)}）`);
  } else {
    failures += 1;
    console.log(`  NG   ${label}\n         期待 ${expected} ±${tolerance}\n         実際 ${actual}`);
  }
}

// ------------------------------------------------------------------
console.log('軌道の上へ落とす');
// 駅の座標を落とすと、その駅の distanceAlong になるはず。
// route.json の distanceAlong は同じ軌道から計算されているので、突き合わせになる。
for (const name of ['仲ノ町', '本銚子', '笠上黒生', '犬吠']) {
  const s = station(name);
  const place = projectOntoTrack(track, s.lat, s.lon);
  near(`${name}駅の位置`, place.along, s.distanceAlong, 30);
}
// 銚子駅は駅舎が線路から 53m 離れている（route.json の offsetFromTrack）
near('銚子駅の軌道からの隔たり', projectOntoTrack(track, station('銚子').lat, station('銚子').lon).offset,
  station('銚子').offsetFromTrack, 10);

// 線路から大きく離れた場所
const away = projectOntoTrack(track, 35.70, 140.80);
check('離れた場所は線路上ではない', away.offset > 30, true);

// ------------------------------------------------------------------
console.log('\n乗っているかどうか');
const onTrack = { latitude: station('観音').lat, longitude: station('観音').lon };
check('線路上・電車の速さ → 乗っている',
  looksLikeRiding(track, { ...onTrack, speed: 8, heading: null }), true);
check('線路上・歩く速さ → 乗っていない',
  looksLikeRiding(track, { ...onTrack, speed: 1.2, heading: null }), false);
check('線路上・速さ不明 → 乗っていない',
  looksLikeRiding(track, { ...onTrack, speed: null, heading: null }), false);
check('線路から離れて速い → 乗っていない',
  looksLikeRiding(track, { latitude: 35.70, longitude: 140.80, speed: 20, heading: null }), false);
// 線路と直角に走る車は除く。観音のあたりの線路はほぼ東西を向いている。
check('線路と直角の向き → 乗っていない',
  looksLikeRiding(track, { ...onTrack, speed: 8, heading: 0 }), false);
check('線路に沿った向き → 乗っている',
  looksLikeRiding(track, { ...onTrack, speed: 8, heading: 90 }), true);
// 抜けるときの判定は速さを見ない（停車で抜けないため。設計書 3.2）
check('停車中でも線路の上ではある', isOnRoute(track, onTrack), true);

// ------------------------------------------------------------------
console.log('\n進行方向');
check('距離が増えたら下り', directionOf(1000, 1200, null), '下り');
check('距離が減ったら上り', directionOf(1200, 1000, null), '上り');
check('動いていなければ前の判定を保つ', directionOf(1000, 1002, '下り'), '下り');
check('停車中に向きを見失わない', directionOf(1000, 1000, '上り'), '上り');
// 位置情報は停車中でも揺れる。数十 m の後戻りで案内する車窓を裏返さない。
check('停車中の揺れ（20m 戻る）では裏返らない', directionOf(1000, 980, '下り'), '下り');
check('電波が戻ったときの引き戻し（50m）でも裏返らない', directionOf(1000, 950, '下り'), '下り');
check('本当に折り返したら（120m）裏返る', directionOf(1000, 880, '下り'), '上り');
check('上りでも同じ（30m 進んでも裏返らない）', directionOf(1000, 1030, '上り'), '上り');
check('上りが本当に折り返したら裏返る', directionOf(1000, 1100, '上り'), '下り');

// ------------------------------------------------------------------
console.log('\n向きを決めるときの比べ元');
/*
 * 位置情報がどれだけ細かく来るかは、端末まかせで決められない。
 * 1 回の差だけを見て、そのつど比べ元を進めてしまうと、
 * 「1 回の差 < 判定に要る 5m」の状況でいつまでも向きが決まらない。
 * 時速 15km（車上モードに入る速さ）で 1 秒ごとなら 1 回 4.2m しかない。
 * 届かなかったぶんは次へ持ちこして足し合わせる。
 */
{
  let anchor = 0;
  let dir = null;
  // 1.4m ずつ進む（×1 倍速のテスト走行や、駅を出た直後の低速がこれにあたる）
  for (const position of [1.4, 2.8, 4.2]) {
    const tracked = trackDirection(anchor, position, dir);
    dir = tracked.direction;
    anchor = tracked.anchorAlong;
  }
  check('まだ 5m 動いていなければ決まらない', dir, null);
  check('  比べ元は動かさず、次に持ちこす', anchor, 0);

  const tracked = trackDirection(anchor, 5.6, dir);
  check('積み重なって 5m を越えたら決まる', tracked.direction, '下り');
  check('  決まったら比べ元を進める', tracked.anchorAlong, 5.6);
}
{
  // 上りも同じ
  let anchor = 3000;
  let dir = null;
  for (const position of [2998.6, 2997.2, 2995.8, 2994.4]) {
    const tracked = trackDirection(anchor, position, dir);
    dir = tracked.direction;
    anchor = tracked.anchorAlong;
  }
  check('細かく戻っても、積み重なれば上りと決まる', dir, '上り');
}
{
  // 停車中の揺れは、行ったり来たりなので積み重ならない
  let anchor = 1000;
  let dir = null;
  for (const position of [1002, 999, 1001.5, 998.5, 1000.5]) {
    const tracked = trackDirection(anchor, position, dir);
    dir = tracked.direction;
    anchor = tracked.anchorAlong;
  }
  check('停車中の揺れでは決まらない', dir, null);
}

// ------------------------------------------------------------------
console.log('\n前方のスポット');
const aheadDown = spotsAhead(spots, 1000, '下り').map((s) => s.id);
check('銚子から1000m地点・下り', aheadDown, ['S02', 'S03', 'S04', 'S05', 'S06']);
const aheadUp = spotsAhead(spots, 1000, '上り').map((s) => s.id);
check('銚子から1000m地点・上り', aheadUp, ['S01']);
check('外川に着いたら下りの前方は無い', spotsAhead(spots, 6440, '下り').map((s) => s.id), []);

// ------------------------------------------------------------------
console.log('\n通知');
const tunnel = spot('S03'); // 森のトンネル 1863m、本銚子駅と同じ地点
const cabbage = spot('S04'); // キャベツ畑 2995m

// 時速40km = 11.1m/s。45秒 = 約500m。まだ遠い
check('600m手前・40km/h → まだ出ない',
  noticeFor(tunnel, 1863 - 600, '下り', 11.1), null);
// 400m手前なら36秒。出る
let notice = noticeFor(tunnel, 1863 - 400, '下り', 11.1);
check('400m手前・40km/h → 出る', notice !== null, true);
check('  段階', notice.phase, 'まもなく');
check('  秒数は5秒刻み', notice.seconds % 5, 0);
near('  秒数', notice.seconds, 36, 3);
// 森のトンネルは上り下りとも「両」
check('  車窓側', notice.side, '両');

// キャベツ畑は下りで左、上りで右
check('キャベツ畑・下りは左',
  noticeFor(cabbage, 2995 - 300, '下り', 11.1).side, '左');
check('キャベツ畑・上りは右',
  noticeFor(cabbage, 2995 + 300, '上り', 11.1).side, '右');

// 100m を切ったら「いま」に変わる
check('80m手前 → いま見る段階',
  noticeFor(tunnel, 1863 - 80, '下り', 11.1).phase, 'いま');
// ここが肝心。駅に停まっていても「いま」に変わる（距離で判定しているため）
check('80m手前・停車中でも いま見る段階',
  noticeFor(tunnel, 1863 - 80, '下り', 0).phase, 'いま');
// 停車中で 100m より遠ければ、秒数を出さずに「まもなく」
const stopped = noticeFor(tunnel, 1863 - 300, '下り', 0);
check('300m手前・停車中 → まもなく', stopped.phase, 'まもなく');
check('300m手前・停車中 → 秒数は出さない', stopped.seconds, null);

/*
 * 停まっているだけで、遠くのスポットを知らせない。
 *
 * 速度が 0 だと「残り距離 ÷ 速度」が使えないので、距離を見ずに知らせていた。
 * そのころは西海鹿島に停まっているだけで 1,954m 先のひまわり畑に
 * 「まもなく」が出ていた。振動は 1 スポットに一度きりなので、
 * 本当に近づいたときには鳴らないことになる。
 */
check('1000m手前・停車中 → 出さない',
  noticeFor(cabbage, 2995 - 1000, '下り', 0), null);
check('  実際に起きていた例（西海鹿島に停車中、1954m 先のひまわり畑）',
  noticeFor(spot('S05'), station('西海鹿島').distanceAlong, '下り', 0), null);
check('  発車して 40km/h まで上がれば、500m 手前から出る',
  noticeFor(cabbage, 2995 - 480, '下り', 11.1) !== null, true);

// 減速しても秒数が伸び続けないこと（速度が落ちれば残り距離も減っているはず）
console.log('  ── 駅に近づきながら減速していく流れ');
for (const [remaining, kmh] of [[400, 40], [250, 30], [150, 20], [90, 10], [30, 0]]) {
  const n = noticeFor(tunnel, 1863 - remaining, '下り', kmh / 3.6);
  const shown = n === null ? '出ない' : n.phase === 'いま' ? '見てください' : `あと${n.seconds}秒`;
  console.log(`     残り${String(remaining).padStart(3)}m ${String(kmh).padStart(2)}km/h → ${shown}`);
}

// ------------------------------------------------------------------
console.log('\n遅れ');
// 15号は 9:03 銚子発 → 9:25 外川着。9:13 の予定位置は約 2839m
const scheduled = Schedule.scheduledDistance(
  schedule, route, schedule.列車.find((t) => t.番号 === 15), at('9:13'));
console.log(`     9:13 の予定位置: ${Math.round(scheduled)}m`);

check('予定どおりなら何も出さない',
  delayMinutes(Schedule, schedule, route, '下り', scheduled, at('9:13')), null);
check('予定より進んでいても出さない',
  delayMinutes(Schedule, schedule, route, '下り', scheduled + 300, at('9:13')), null);
// 全線 6440m を 22 分なので、1 分はおよそ 293m
const perMinute = 6440 / 22;
near('約2分遅れ',
  delayMinutes(Schedule, schedule, route, '下り', scheduled - perMinute * 2, at('9:13')), 2, 0);
check('1分未満は出さない',
  delayMinutes(Schedule, schedule, route, '下り', scheduled - perMinute * 0.5, at('9:13')), null);
// 走っている列車が無い時間帯
check('走っていない時間は出さない',
  delayMinutes(Schedule, schedule, route, '下り', 3000, at('9:40')), null);

/*
 * 時刻表の書き方に左右されないこと。
 *
 * schedule.json は人が手で書くファイルなので、上りの列車の時刻を
 * （下りと同じ）銚子→外川の順に書くこともできる。駅順に並べ直さずに
 * 書いてある順の両端を取っていたころは、その書き方をすると
 * 終わりの時刻が始まりより早くなり、遅れが二度と出なくなっていた。
 */
console.log('  ── 上りの列車で、時刻の書き順を変えても同じになるか');
const upTrain = schedule.列車.find((t) => t.方向 === '上り' && t.時刻['外川'] && t.時刻['銚子']);
const upTime = at(upTrain.時刻['笠上黒生']);
const upScheduled = Schedule.scheduledDistance(schedule, route, upTrain, upTime);
const flipped = { ...upTrain, 時刻: {} };
for (const name of Object.keys(upTrain.時刻).slice().reverse()) flipped.時刻[name] = upTrain.時刻[name];

const asWritten = delayMinutes(
  Schedule, { ...schedule, 列車: [upTrain] }, route, '上り', upScheduled + perMinute * 2, upTime);
const asFlipped = delayMinutes(
  Schedule, { ...schedule, 列車: [flipped] }, route, '上り', upScheduled + perMinute * 2, upTime);
near('上りの2分遅れ（進行順に書いてある）', asWritten, 2, 0);
check('上りの2分遅れ（逆順に書いても同じ）', asFlipped, asWritten);

// ------------------------------------------------------------------
console.log('\n次に停まる駅（遅れとあわせて「何時にどこへ着く予定か」を出すのに使う）');
// 9:13 の予定位置（2479m）から見て、次は 9:15 の笠上黒生
check('9:13の予定位置から見た次の停車駅',
  nextStopEta(Schedule, schedule, route, '下り', scheduled, at('9:13')),
  { station: '笠上黒生', scheduledMinute: 555 });
// 終点（外川）に着いたら、もう次は無い
check('終点に着いたら次の停車駅は無い',
  nextStopEta(Schedule, schedule, route, '下り', 6440, at('9:25')), null);
// 走っている列車が無ければ求まらない
check('走っていない時間は次の停車駅も出さない',
  nextStopEta(Schedule, schedule, route, '下り', 3000, at('9:40')), null);

// ------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('OK すべて通った');
} else {
  console.log(`NG ${failures} 件`);
  process.exitCode = 1;
}
