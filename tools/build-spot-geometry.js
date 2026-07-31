/*
 * build-spot-geometry.js
 *
 * 絶景スポットの「位置」と「車窓側（左右）」を、実際の地物から計算する。
 *
 * 車窓側の求め方:
 *   進行方向を向いた矢印と、そこから見える地物への矢印。
 *   この 2 本の外積（がいせき）の符号を見ると、
 *   地物が進行方向の左にあるか右にあるかがわかる。
 *   上りと下りでは進行方向が逆なので、左右も必ず反転する。
 *
 * 結果は data/source/spot-geometry.json に書き出す。
 * data/spots.json はこの数値を見ながら人が書く（設計書 8 章）。
 *
 * 使い方:  node tools/build-spot-geometry.js
 */

const fs = require('fs');
const path = require('path');

const ROUTE_PATH = path.join(__dirname, '..', 'data', 'route.json');
const FEATURES_PATH = path.join(__dirname, '..', 'data', 'source', 'features_raw.json');
const OUT_PATH = path.join(__dirname, '..', 'data', 'source', 'spot-geometry.json');

const route = JSON.parse(fs.readFileSync(ROUTE_PATH, 'utf8'));
const features = JSON.parse(fs.readFileSync(FEATURES_PATH, 'utf8'));

// ---------------------------------------------------------------
// 緯度経度 → メートル（build-route.js と同じ決まり）
// ---------------------------------------------------------------

const origin = route.origin;
const originLatRad = (origin.lat * Math.PI) / 180;

function toMeters(lat, lon) {
  return {
    x: (lon - origin.lon) * 111320 * Math.cos(originLatRad), // 東が +
    y: (lat - origin.lat) * 110540,                           // 北が +
  };
}

// ---------------------------------------------------------------
// 路線を扱いやすい形にしておく
// ---------------------------------------------------------------

const track = route.track.map(([lat, lon]) => ({ lat, lon, ...toMeters(lat, lon) }));

const cumulative = [0];
for (let i = 1; i < track.length; i++) {
  cumulative.push(cumulative[i - 1] + Math.hypot(track[i].x - track[i - 1].x, track[i].y - track[i - 1].y));
}

const stationDistance = {};
route.stations.forEach((s) => { stationDistance[s.name] = s.distanceAlong; });

/** 起点から distance メートルの地点の座標と、そこでの進行方向（下り＝外川ゆき） */
function pointAt(distance) {
  let i = cumulative.findIndex((c) => c >= distance);
  if (i <= 0) i = 1;

  const segmentLength = cumulative[i] - cumulative[i - 1];
  const t = segmentLength === 0 ? 0 : (distance - cumulative[i - 1]) / segmentLength;

  const a = track[i - 1];
  const b = track[i];

  // 進行方向は前後に少し幅をとって平均する（1 区間だけだと向きが暴れるため）
  const from = track[Math.max(0, i - 3)];
  const to = track[Math.min(track.length - 1, i + 2)];
  const headingLength = Math.hypot(to.x - from.x, to.y - from.y) || 1;

  return {
    lat: a.lat + t * (b.lat - a.lat),
    lon: a.lon + t * (b.lon - a.lon),
    x: a.x + t * (b.x - a.x),
    y: a.y + t * (b.y - a.y),
    heading: { x: (to.x - from.x) / headingLength, y: (to.y - from.y) / headingLength },
  };
}

/** 点を路線に落として、起点からの距離を返す */
function distanceAlongFor(lat, lon) {
  const p = toMeters(lat, lon);
  let best = { distance: 0, offset: Infinity };

  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lengthSquared = abx * abx + aby * aby;
    if (lengthSquared === 0) continue;

    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared;
    t = Math.max(0, Math.min(1, t));

    const offset = Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
    if (offset < best.offset) {
      best = { distance: cumulative[i] + t * Math.sqrt(lengthSquared), offset };
    }
  }
  return best;
}

/**
 * 地物が、下り（外川ゆき）の進行方向から見て左右どちらにあるか。
 *
 * 外積 heading.x * v.y - heading.y * v.x が
 *   正 … 左   負 … 右
 * （東を x、北を y にとった座標での話）
 */
function sideOf(distance, targetLat, targetLon) {
  const p = pointAt(distance);
  const target = toMeters(targetLat, targetLon);
  const vx = target.x - p.x;
  const vy = target.y - p.y;
  const cross = p.heading.x * vy - p.heading.y * vx;
  return {
    down: cross > 0 ? '左' : '右',   // 外川ゆき
    up: cross > 0 ? '右' : '左',     // 銚子ゆき（必ず逆になる）
    confidence: Math.abs(cross) / (Math.hypot(vx, vy) || 1), // 1 に近いほど真横
  };
}

// ---------------------------------------------------------------
// 地物を種類ごとに整理する
// ---------------------------------------------------------------

function centroidOf(element) {
  if (element.type === 'node') return { lat: element.lat, lon: element.lon };
  if (!element.geometry) return null;
  const points = element.geometry.filter((g) => g);
  if (points.length === 0) return null;
  return {
    lat: points.reduce((s, g) => s + g.lat, 0) / points.length,
    lon: points.reduce((s, g) => s + g.lon, 0) / points.length,
  };
}

/** 多角形のおおよその面積（平方メートル）。靴ひも公式。 */
function areaOf(element) {
  if (!element.geometry || element.geometry.length < 3) return 0;
  const points = element.geometry.map((g) => toMeters(g.lat, g.lon));
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

const farmland = features.elements
  .filter((el) => el.tags?.landuse === 'farmland' || el.tags?.landuse === 'orchard')
  .map((el) => ({ ...centroidOf(el), area: areaOf(el) }))
  .filter((f) => f.lat && f.area > 0);

const coastPoints = features.elements
  .filter((el) => el.tags?.natural === 'coastline')
  .flatMap((el) => el.geometry || []);

const industrial = features.elements
  .filter((el) => el.tags?.landuse === 'industrial' || /ヤマサ/.test(el.tags?.name || ''))
  .map((el) => ({ name: el.tags?.name || '(名前なし)', ...centroidOf(el), area: areaOf(el) }))
  .filter((f) => f.lat);

console.log(`農地 ${farmland.length} 区画 / 海岸線 ${coastPoints.length} 点 / 工業用地 ${industrial.length} 件\n`);

// ---------------------------------------------------------------
// 判定に使う道具
// ---------------------------------------------------------------

/**
 * 区間のあいだで、農地が左右どちらに多いかを面積で比べる。
 *
 * 台地の上では畑が線路の両側に広がっていることが多い。
 * そういう場所で無理に「左」と言い切ると、かえって外れる。
 * 偏りが小さければ「両」（どちらの窓からも見える）と答える。
 */
function farmlandSide(fromDistance, toDistance, maxOffset = 500) {
  const totals = { 左: 0, 右: 0 };
  const counts = { 左: 0, 右: 0 };

  for (const field of farmland) {
    const { distance, offset } = distanceAlongFor(field.lat, field.lon);
    if (distance < fromDistance || distance > toDistance) continue;
    if (offset > maxOffset) continue;

    // 近いほど車窓での存在感が大きいので、距離で重みをつける
    const weight = field.area / (offset + 50);
    const side = sideOf(distance, field.lat, field.lon).down;
    totals[side] += weight;
    counts[side]++;
  }

  const total = totals.左 + totals.右;
  if (total === 0) {
    return { down: null, up: null, leftShare: null, basis: 'この区間に農地のデータがない' };
  }

  const leftShare = totals.左 / total;
  const basis =
    `農地の見えかた 左 ${Math.round(leftShare * 100)}% : 右 ${Math.round((1 - leftShare) * 100)}%` +
    `（左 ${counts.左} 区画 / 右 ${counts.右} 区画）`;

  // 偏りが 1 割未満なら、どちらの窓からも見えるとみなす
  if (Math.abs(leftShare - 0.5) < 0.1) {
    return { down: '両', up: '両', leftShare, basis };
  }

  const down = leftShare > 0.5 ? '左' : '右';
  return { down, up: down === '左' ? '右' : '左', leftShare, basis };
}

/** その地点から見ていちばん近い海岸線の点 */
function nearestCoast(distance) {
  const p = pointAt(distance);
  let best = null;
  let bestDistance = Infinity;

  for (const c of coastPoints) {
    const m = toMeters(c.lat, c.lon);
    const d = Math.hypot(m.x - p.x, m.y - p.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return { ...best, distance: bestDistance };
}

// ---------------------------------------------------------------
// 6 つの絶景スポットを計算する（設計書 8.2）
// ---------------------------------------------------------------

const results = [];

// --- S01 ヤマサ醤油工場（仲ノ町駅付近）-------------------------
{
  // 名前で見つからなければ、仲ノ町駅にいちばん近い工業用地を使う
  const nakanocho = pointAt(stationDistance['仲ノ町']);
  const yamasa = industrial
    .map((f) => {
      const m = toMeters(f.lat, f.lon);
      return { ...f, toStation: Math.hypot(m.x - nakanocho.x, m.y - nakanocho.y) };
    })
    .filter((f) => f.toStation < 900)
    .sort((a, b) => b.area / (b.toStation + 100) - a.area / (a.toStation + 100))[0];

  const at = distanceAlongFor(yamasa.lat, yamasa.lon);
  const side = sideOf(at.distance, yamasa.lat, yamasa.lon);
  const p = pointAt(at.distance);

  results.push({
    id: 'S01',
    name: 'ヤマサ醤油工場',
    location: '仲ノ町駅付近',
    theme: '産業と水運',
    lat: Math.round(p.lat * 1e6) / 1e6,
    lon: Math.round(p.lon * 1e6) / 1e6,
    distanceAlong: Math.round(at.distance),
    sideDown: side.down,
    sideUp: side.up,
    method: `工業用地「${yamasa.name}」の重心（線路から ${Math.round(at.offset)}m）から計算`,
    certainty: at.offset > 80 ? '高' : '中（線路のすぐ脇のため左右が出にくい）',
  });
}

// --- S02 遠くに見える海（観音駅〜本銚子駅）---------------------
{
  const from = stationDistance['観音'];
  const to = stationDistance['本銚子'];
  const middle = (from + to) / 2;
  const coast = nearestCoast(middle);
  const side = sideOf(middle, coast.lat, coast.lon);
  const p = pointAt(middle);

  results.push({
    id: 'S02',
    name: '遠くに見える海',
    location: '観音駅〜本銚子駅',
    theme: '海と空',
    lat: Math.round(p.lat * 1e6) / 1e6,
    lon: Math.round(p.lon * 1e6) / 1e6,
    distanceAlong: Math.round(middle),
    sideDown: side.down,
    sideUp: side.up,
    method: `いちばん近い海岸線（${Math.round(coast.distance)}m 先）の向きから計算`,
    certainty: '高',
  });
}

// --- S03 森のトンネル（本銚子駅）-------------------------------
{
  const at = stationDistance['本銚子'];
  const p = pointAt(at);

  results.push({
    id: 'S03',
    name: '森のトンネル',
    location: '本銚子駅',
    theme: '地形',
    lat: Math.round(p.lat * 1e6) / 1e6,
    lon: Math.round(p.lon * 1e6) / 1e6,
    distanceAlong: at,
    sideDown: '両',
    sideUp: '両',
    method: '切通しで線路の両側が樹木に覆われるため、左右の区別なし',
    certainty: '高',
  });
}

// --- S04 キャベツ畑（笠上黒生駅〜西海鹿島駅）-------------------
{
  const from = stationDistance['笠上黒生'];
  const to = stationDistance['西海鹿島'];
  const middle = (from + to) / 2;
  const side = farmlandSide(from, to);
  const p = pointAt(middle);

  results.push({
    id: 'S04',
    name: 'キャベツ畑',
    location: '笠上黒生駅〜西海鹿島駅',
    theme: '気候と農業',
    lat: Math.round(p.lat * 1e6) / 1e6,
    lon: Math.round(p.lon * 1e6) / 1e6,
    distanceAlong: Math.round(middle),
    sideDown: side.down,
    sideUp: side.up,
    method: side.basis,
    certainty:
      side.down === '両' ? '中（線路の両側に畑が広がっている）' :
      Math.abs(side.leftShare - 0.5) > 0.2 ? '中' : '低（左右の差が小さい）',
  });
}

// --- S05 ひまわり畑（君ヶ浜駅〜犬吠駅）-------------------------
{
  const from = stationDistance['君ヶ浜'];
  const to = stationDistance['犬吠'];
  const middle = (from + to) / 2;
  const side = farmlandSide(from, to);
  const p = pointAt(middle);

  results.push({
    id: 'S05',
    name: 'ひまわり畑',
    location: '君ヶ浜駅〜犬吠駅',
    theme: '気候と農業',
    lat: Math.round(p.lat * 1e6) / 1e6,
    lon: Math.round(p.lon * 1e6) / 1e6,
    distanceAlong: Math.round(middle),
    sideDown: side.down,
    sideUp: side.up,
    method: side.basis,
    certainty:
      side.down === '両' ? '中（線路の両側に畑が広がっている）' :
      Math.abs(side.leftShare - 0.5) > 0.2 ? '中' : '低（左右の差が小さい）',
  });
}

// --- S06 河津桜・菜の花（外川駅）-------------------------------
{
  const at = stationDistance['外川'];
  const p = pointAt(at);

  results.push({
    id: 'S06',
    name: '河津桜・菜の花',
    location: '外川駅',
    theme: '気候と農業',
    lat: Math.round(p.lat * 1e6) / 1e6,
    lon: Math.round(p.lon * 1e6) / 1e6,
    distanceAlong: at,
    sideDown: '両',
    sideUp: '両',
    method: '2019 年に線路沿いへ植えられた並木のため、左右の区別なし',
    certainty: '低（植えられた範囲が地図データにないため、現地写真での確認が必要）',
  });
}

// ---------------------------------------------------------------
// 結果
// ---------------------------------------------------------------

console.log('絶景スポットの位置と車窓側');
console.log('─'.repeat(78));
for (const r of results) {
  console.log(
    `${r.id} ${r.name.padEnd(10, '　')} ${String(r.distanceAlong).padStart(4)}m  ` +
    `下り:${r.sideDown}  上り:${r.sideUp}   確からしさ ${r.certainty}`
  );
  console.log(`    根拠: ${r.method}`);
}
console.log('─'.repeat(78));
console.log('※「下り」は外川ゆき、「上り」は銚子ゆき。');

fs.writeFileSync(
  OUT_PATH,
  JSON.stringify(
    {
      _comment: 'tools/build-spot-geometry.js が計算した参考値。data/spots.json はこれを見て人が書く。',
      generatedAt: new Date().toISOString().slice(0, 10),
      spots: results,
    },
    null,
    2
  ),
  'utf8'
);
console.log(`\n書き出し: ${OUT_PATH}`);
