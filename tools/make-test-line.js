/*
 * make-test-line.js
 *
 * 試験用の路線に、作り物の絶景スポットと時刻表を用意する。
 *
 * 何のためか。GPS まわりの振る舞い（モードの切替、上り下りの判定、車窓側、
 * 通知の先行時間）は、実際に電車に乗ってみないと確かめられない。銚子まで
 * 行くのは遠いので、近くの路線で先に確かめたい。そのとき要るのは
 * route.json（線路と駅）と spots.json（通知を出す的）だけで、成因カードの
 * 中身は要らない。
 *
 * 絶景スポットは **線路からの向きと距離を指定して置く**。
 * 実在の景色から座標を起こすのではなく、こちらが答えを知っている位置に置く。
 * そうすると「下りで右と出るはず」が事前に分かるので、画面の出力が
 * 合っているかを現地で判定できる。実在の絶景を並べても、正解を知らない
 * のだから試験にならない。
 *
 * 使い方:  node tools/make-test-line.js <route.json> <出力先ディレクトリ>
 * 例:      node tools/make-test-line.js data/yurakucho/route.json data/yurakucho
 *
 * ここが書き出す spots.json は **作品の内容ではない**。
 * 人が手で書く data/<路線>/spots.json（設計書 8 章）とは別物なので、
 * 試験用の路線以外に対して走らせないこと。
 */

const fs = require('fs');
const path = require('path');

const routePath = process.argv[2];
const outDir = process.argv[3];

if (!routePath || !outDir) {
  console.error('使い方: node tools/make-test-line.js <route.json> <出力先ディレクトリ>');
  process.exit(1);
}

const route = JSON.parse(fs.readFileSync(routePath, 'utf8').replace(/^﻿/, ''));

// ---------------------------------------------------------------
// 設定
// ---------------------------------------------------------------

/** 置く絶景スポットの数。駅の数より少なくして、駅ごとには鳴らないようにする */
const SPOT_COUNT = 6;

/** 線路からどれだけ横にずらすか（m）。近すぎると左右の判定が誤差に埋もれる */
const SPOT_OFFSET_M = 60;

/** テーマは 4 つを順に使う（設計書 5.4） */
const THEMES = ['地形', '気候と農業', '産業と水運', '海と空'];

/*
 * バッジの中の絵。js/main.js の GLYPHS にある名前しか使えない。
 * ここに無い名前を書くと、バッジの中身が空になる。
 */
const ICONS = ['barrel', 'wave', 'tunnel', 'cabbage', 'sunflower', 'blossom'];

/** 何分おきに走らせるか */
const HEADWAY_MINUTES = 10;
const FIRST_DEPARTURE = '05:00';
const LAST_DEPARTURE = '23:30';

/** 表定速度（km/h）。停車時間も込みの平均 */
const AVERAGE_SPEED_KMH = 35;

// ---------------------------------------------------------------
// 緯度経度 ↔ メートル（build-route.js と同じ式）
// ---------------------------------------------------------------

const origin = route.origin;

function toMeters({ lat, lon }) {
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    x: (lon - origin.lon) * 111320 * Math.cos(latRad),
    y: (lat - origin.lat) * 110540,
  };
}

function toLatLon({ x, y }) {
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    lat: origin.lat + y / 110540,
    lon: origin.lon + x / (111320 * Math.cos(latRad)),
  };
}

const track = route.track.map(([lat, lon]) => ({ lat, lon }));
const trackMeters = track.map(toMeters);

/** 起点からの累積距離 */
const cumulative = [0];
for (let i = 1; i < trackMeters.length; i++) {
  cumulative.push(
    cumulative[i - 1] + Math.hypot(
      trackMeters[i].x - trackMeters[i - 1].x,
      trackMeters[i].y - trackMeters[i - 1].y
    )
  );
}
const totalLength = cumulative[cumulative.length - 1];

/**
 * 起点から distance メートルの地点と、そこでの進行方向を返す。
 * 進行方向は route.json の track の並び順＝「下り」とする。
 */
function pointAt(distance) {
  let i = 1;
  while (i < cumulative.length - 1 && cumulative[i] < distance) i++;

  const segmentLength = cumulative[i] - cumulative[i - 1];
  const t = segmentLength === 0 ? 0 : (distance - cumulative[i - 1]) / segmentLength;

  const a = trackMeters[i - 1];
  const b = trackMeters[i];

  return {
    point: { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) },
    // 進行方向の単位ベクトル
    heading: (() => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      return { x: dx / length, y: dy / length };
    })(),
  };
}

// ---------------------------------------------------------------
// 絶景スポットを置く
//
// 進行方向のベクトルを左に 90 度回すと (-y, x)。
// 下り（track の並び順）で左に見えるのはその向き。
// 上りは同じ場所が必ず反対側になる。
// ---------------------------------------------------------------

const spots = [];

for (let i = 0; i < SPOT_COUNT; i++) {
  // 端に寄りすぎないよう、両端を少し空けて等間隔に置く
  const distance = totalLength * ((i + 1) / (SPOT_COUNT + 1));
  const { point, heading } = pointAt(distance);

  // 交互に左右へ振る。片側だけだと左右の取り違えに気づけない
  const putOnLeftGoingDown = i % 2 === 0;
  const sign = putOnLeftGoingDown ? 1 : -1;

  const offset = {
    x: point.x + sign * -heading.y * SPOT_OFFSET_M,
    y: point.y + sign * heading.x * SPOT_OFFSET_M,
  };
  const { lat, lon } = toLatLon(offset);

  // 近くの駅の名前を借りて、どのあたりか分かるようにする
  const nearest = route.stations.reduce((best, s) =>
    Math.abs(s.distanceAlong - distance) < Math.abs(best.distanceAlong - distance) ? s : best
  );

  spots.push({
    id: `T${String(i + 1).padStart(2, '0')}`,
    name: `試験用スポット ${i + 1}`,
    location: `${nearest.name}駅 付近`,
    theme: THEMES[i % THEMES.length],
    icon: ICONS[i % ICONS.length],
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    // これが無いと、バッジの置き場所を決める headingAt が NaN になって描画が落ちる。
    // 人が書く spots.json では tools/build-spot-geometry.js が出す値を写す（設計書 8 章）。
    distanceAlong: Math.round(distance),
    sideDown: putOnLeftGoingDown ? '左' : '右',
    sideUp: putOnLeftGoingDown ? '右' : '左',
    duration: ['長', '中', '短'][i % 3],
    season: '通年',
    summary: `${Math.round(distance)}m 地点・線路の${putOnLeftGoingDown ? '左' : '右'}（下り）に置いた試験用の的。`,
    panels: [
      { text: 'これは試験用のデータです。作品の内容ではありません。' },
      { text: `起点から ${Math.round(distance)}m、線路から ${SPOT_OFFSET_M}m 離れた位置に置いてあります。` },
      { text: '下りで左に出るはずのものが右に出たら、車窓側の判定が誤っています。' },
    ],
  });
}

/*
 * 人が書く spots.json と項目が食い違っていないか確かめる。
 *
 * 最初に書いたとき distanceAlong と icon を落としていて、バッジの置き場所を
 * 決める headingAt が NaN になり、地図が描けずに読み込みが終わらなかった。
 * 落としても JSON としては正しいので、読めるかどうかでは気づけない。
 * 参照になる spots.json が無ければ黙って飛ばす。
 */
const referencePath = path.join(__dirname, '..', 'data', 'choshi', 'spots.json');
if (fs.existsSync(referencePath) && spots.length > 0) {
  const reference = JSON.parse(fs.readFileSync(referencePath, 'utf8')).spots[0];
  const missing = Object.keys(reference).filter((key) => !(key in spots[0]));
  if (missing.length > 0) {
    console.warn(`\n⚠ 本物の spots.json にあって、こちらに無い項目: ${missing.join(', ')}`);
    console.warn('  画面が落ちる原因になる。この道具に足すこと。\n');
  }
}

// ---------------------------------------------------------------
// 時刻表を作る
//
// 駅ごとの時刻は distanceAlong から按分する。実際のダイヤではないので、
// 遅れの表示（設計書 4.3）を試すのには使えるが、正しさの検証には使えない。
// ---------------------------------------------------------------

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toClock(minutes) {
  const total = Math.round(minutes);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** 全区間の所要時間（分） */
const runMinutes = (totalLength / 1000) / AVERAGE_SPEED_KMH * 60;

const trains = [];
let number = 1;

for (let depart = toMinutes(FIRST_DEPARTURE); depart <= toMinutes(LAST_DEPARTURE); depart += HEADWAY_MINUTES) {
  for (const direction of ['下り', '上り']) {
    const times = {};
    for (const station of route.stations) {
      const ratio = station.distanceAlong / totalLength;
      const elapsed = (direction === '下り' ? ratio : 1 - ratio) * runMinutes;
      times[station.name] = toClock(depart + elapsed);
    }
    trains.push({ 番号: number++, 方向: direction, 時刻: times });
  }
}

// ---------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------

fs.mkdirSync(outDir, { recursive: true });

const spotsOut = {
  _comment: 'tools/make-test-line.js が作った試験用のデータ。作品の内容ではない。手で直す価値はない（作り直せる）。',
  spots,
};
fs.writeFileSync(path.join(outDir, 'spots.json'), JSON.stringify(spotsOut, null, 2), 'utf8');

const scheduleOut = {
  _comment: 'tools/make-test-line.js が作った試験用の時刻表。実際のダイヤではない。',
  改正日: new Date().toISOString().slice(0, 10),
  列車: trains,
};
fs.writeFileSync(path.join(outDir, 'schedule.json'), JSON.stringify(scheduleOut, null, 2), 'utf8');

console.log(`路線: ${route.lineName || '(名前なし)'}  全長 ${(totalLength / 1000).toFixed(2)} km  ${route.stations.length} 駅`);
console.log(`\n絶景スポット ${spots.length} 個（答えを知っている位置に置いた）:`);
spots.forEach((s) => {
  console.log(`  ${s.id}  ${s.location.padEnd(16, '　')} 下り=${s.sideDown}  上り=${s.sideUp}   ${s.summary}`);
});
console.log(`\n時刻表: ${trains.length} 本（${HEADWAY_MINUTES} 分おき・全区間 ${runMinutes.toFixed(0)} 分）`);
console.log(`\n書き出し: ${path.join(outDir, 'spots.json')}`);
console.log(`          ${path.join(outDir, 'schedule.json')}`);
