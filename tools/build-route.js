/*
 * build-route.js
 *
 * OpenStreetMap から取得した生データ（overpass_raw.json）を、
 * サイトが読む route.json に変換する。
 *
 * OSM の線路は「8 本のバラバラな線分」として登録されている。
 * これを銚子駅 → 外川駅の順につなぎ直し、
 * 各駅が路線の何メートル地点にあるかを計算する。
 *
 * 使い方:  node tools/build-route.js <overpass_raw.json> <出力先.json>
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------
// 設定
// ---------------------------------------------------------------

/** 銚子電鉄の 10 駅。銚子駅から外川駅への順で書く。 */
const STATION_ORDER = [
  '銚子', '仲ノ町', '観音', '本銚子', '笠上黒生',
  '西海鹿島', '海鹿島', '君ヶ浜', '犬吠', '外川',
];

/** 拾う線路の名前。これ以外（JR 線、車庫の側線など）は捨てる。 */
const LINE_NAME = '銚子電気鉄道線';

// ---------------------------------------------------------------
// 緯度経度 → メートル
//
// 全長 6.4km の範囲なら、地球を平面とみなす単純な式で十分。
// 誤差は 0.1% 未満（6.4km に対して数メートル）。
// ---------------------------------------------------------------

/** 基準点。ここを原点 (0, 0) としてメートルを測る。 */
let origin = null;

function toMeters({ lat, lon }) {
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    x: (lon - origin.lon) * 111320 * Math.cos(latRad), // 東が +
    y: (lat - origin.lat) * 110540,                     // 北が +
  };
}

function distanceMeters(a, b) {
  const pa = toMeters(a);
  const pb = toMeters(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

// ---------------------------------------------------------------
// 1. 生データの読み込み
// ---------------------------------------------------------------

const rawPath = process.argv[2];
const outPath = process.argv[3];

if (!rawPath || !outPath) {
  console.error('使い方: node tools/build-route.js <overpass_raw.json> <出力先.json>');
  process.exit(1);
}

// replace(/^﻿/, '') … ファイル先頭に紛れ込む見えない印（BOM）を取り除く
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8').replace(/^﻿/, ''));

// ---------------------------------------------------------------
// 2. 駅を拾う
// ---------------------------------------------------------------

const stationNodes = raw.elements.filter(
  (el) => el.type === 'node' && STATION_ORDER.includes(el.tags?.name)
);

// 同名の駅が複数あったら困るので確認する
for (const name of STATION_ORDER) {
  const hits = stationNodes.filter((n) => n.tags.name === name);
  if (hits.length !== 1) {
    console.error(`駅「${name}」が ${hits.length} 件見つかった（1 件であるべき）`);
    process.exit(1);
  }
}

// 基準点は銚子駅にする
const choshi = stationNodes.find((n) => n.tags.name === '銚子');
origin = { lat: choshi.lat, lon: choshi.lon };

// ---------------------------------------------------------------
// 3. 線路の断片を拾う
//
// OSM には車庫の側線（仲ノ町駅の車両基地）も同じ路線名で登録されている。
// service タグが付いているものは営業路線ではないので捨てる。
// ---------------------------------------------------------------

const segments = raw.elements
  .filter((el) => el.type === 'way' && el.tags?.name === LINE_NAME && !el.tags.service)
  .map((way) => ({
    id: way.id,
    points: way.geometry.map((g) => ({ lat: g.lat, lon: g.lon })),
  }));

console.log(`線路の断片: ${segments.length} 本 / 合計 ${segments.reduce((s, w) => s + w.points.length, 0)} 点`);

// ---------------------------------------------------------------
// 4. 断片をつないで銚子駅 → 外川駅の一本道にする
//
// 断片は一列に並んでいない。笠上黒生駅には行き違い用の線が並行して 2 本あり、
// 銚子駅にもホームの線が 2 本ある。つまり途中で枝分かれしている。
//
// そこで「銚子駅から外川駅までの最短経路」を探す。
// こうすれば、枝分かれのどちらを通るかを自動で決められる。
// ---------------------------------------------------------------

/** 断片の端どうしが 1m 以内なら同じ地点とみなし、通し番号を振る */
const junctions = [];
function junctionIndexOf(point) {
  for (let i = 0; i < junctions.length; i++) {
    if (distanceMeters(junctions[i], point) < 1) return i;
  }
  junctions.push(point);
  return junctions.length - 1;
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
  return total;
}

// 分岐点を「地点」、線路の断片を「地点どうしを結ぶ道」とみなす
const edges = segments.map((seg) => ({
  from: junctionIndexOf(seg.points[0]),
  to: junctionIndexOf(seg.points[seg.points.length - 1]),
  points: seg.points,
  length: polylineLength(seg.points),
}));

/** 指定した駅にいちばん近い分岐点の番号を返す */
function nearestJunction(station) {
  let best = -1;
  let bestDistance = Infinity;
  junctions.forEach((junction, i) => {
    const d = distanceMeters(junction, station);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

const tokawa = stationNodes.find((n) => n.tags.name === '外川');
const startJunction = nearestJunction(choshi);
const goalJunction = nearestJunction(tokawa);

// ダイクストラ法で最短経路を探す。
// 「まだ調べていない地点のうち、いちばん近いもの」から順に確定させていく。
const costToReach = junctions.map(() => Infinity);
const cameFrom = junctions.map(() => null);
const settled = junctions.map(() => false);
costToReach[startJunction] = 0;

for (;;) {
  let current = -1;
  let currentCost = Infinity;
  costToReach.forEach((cost, i) => {
    if (!settled[i] && cost < currentCost) {
      currentCost = cost;
      current = i;
    }
  });
  if (current === -1) break; // 行けるところは全部調べ終えた
  settled[current] = true;

  for (const edge of edges) {
    // この道が current につながっているなら、反対側の地点が next
    let next = -1;
    if (edge.from === current) next = edge.to;
    else if (edge.to === current) next = edge.from;
    else continue;

    const cost = currentCost + edge.length;
    if (cost < costToReach[next]) {
      costToReach[next] = cost;
      cameFrom[next] = { junction: current, edge };
    }
  }
}

if (cameFrom[goalJunction] === null) {
  console.error('銚子駅から外川駅までつながっていない。データを確認すること。');
  process.exit(1);
}

// 外川駅から逆にたどって、通った道を並べ直す
const usedEdges = [];
for (let at = goalJunction; cameFrom[at]; at = cameFrom[at].junction) {
  usedEdges.unshift(cameFrom[at]);
}

const chain = [];
for (const { junction, edge } of usedEdges) {
  // 断片の向きを進行方向（銚子 → 外川）に揃える
  const points = edge.from === junction ? edge.points : edge.points.slice().reverse();
  // つなぎ目の点は重複するので、2 本目以降は 1 点目を飛ばす
  chain.push(...(chain.length === 0 ? points : points.slice(1)));
}

console.log(`採用した断片: ${usedEdges.length} 本（残りは側線・行き違い線）→ ${chain.length} 点`);

// ---------------------------------------------------------------
// 5. 路線に沿った距離（起点からの累積メートル）を計算
// ---------------------------------------------------------------

const cumulative = [0];
for (let i = 1; i < chain.length; i++) {
  cumulative.push(cumulative[i - 1] + distanceMeters(chain[i - 1], chain[i]));
}
const totalLength = cumulative[cumulative.length - 1];

// ---------------------------------------------------------------
// 6. 各駅を路線上に投影する
//
// GPS の点を線路に貼りつけるのと同じ計算。
// 駅の座標（線路から少しずれている）を線路上の一点に落とし、
// それが起点から何メートルかを求める。
// ---------------------------------------------------------------

/**
 * 点を路線に投影する。
 * @returns {{ distanceAlong: number, offset: number, lat: number, lon: number }}
 *   distanceAlong … 起点からの距離（m）
 *   offset        … 路線からどれだけ離れていたか（m）
 */
function projectOntoRoute(point) {
  const p = toMeters(point);
  let best = { distanceAlong: 0, offset: Infinity, lat: 0, lon: 0 };

  for (let i = 0; i < chain.length - 1; i++) {
    const a = toMeters(chain[i]);
    const b = toMeters(chain[i + 1]);

    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lengthSquared = abx * abx + aby * aby;
    if (lengthSquared === 0) continue;

    // 線分 ab 上で点 p にいちばん近い位置を 0〜1 の比率で求める
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared;
    t = Math.max(0, Math.min(1, t)); // 線分からはみ出さないよう挟む

    const projX = a.x + t * abx;
    const projY = a.y + t * aby;
    const offset = Math.hypot(p.x - projX, p.y - projY);

    if (offset < best.offset) {
      const segmentLength = Math.sqrt(lengthSquared);
      best = {
        distanceAlong: cumulative[i] + t * segmentLength,
        offset,
        // 投影点を緯度経度に戻す
        lat: chain[i].lat + t * (chain[i + 1].lat - chain[i].lat),
        lon: chain[i].lon + t * (chain[i + 1].lon - chain[i].lon),
      };
    }
  }

  return best;
}

const stations = stationNodes
  .map((node) => {
    const projection = projectOntoRoute({ lat: node.lat, lon: node.lon });
    return {
      name: node.tags.name,
      lat: node.lat,
      lon: node.lon,
      distanceAlong: Math.round(projection.distanceAlong),
      offsetFromTrack: Math.round(projection.offset * 10) / 10,
    };
  })
  .sort((a, b) => a.distanceAlong - b.distanceAlong);

// ---------------------------------------------------------------
// 7. 結果の確認
// ---------------------------------------------------------------

console.log(`\n全長: ${(totalLength / 1000).toFixed(2)} km`);
console.log('\n駅の並び（起点からの距離 / 線路とのずれ）:');
stations.forEach((s, i) => {
  const expected = STATION_ORDER[i];
  const mark = s.name === expected ? ' ' : ' ← 順番が想定と違う';
  console.log(
    `  ${String(i + 1).padStart(2)}. ${s.name.padEnd(6, '　')} ` +
    `${String(s.distanceAlong).padStart(5)} m   ずれ ${String(s.offsetFromTrack).padStart(5)} m${mark}`
  );
});

// 経緯度の範囲（SVG の描画範囲を決めるのに使う）
const lats = chain.map((p) => p.lat);
const lons = chain.map((p) => p.lon);
const bounds = {
  minLat: Math.min(...lats), maxLat: Math.max(...lats),
  minLon: Math.min(...lons), maxLon: Math.max(...lons),
};
const widthMeters = distanceMeters(
  { lat: bounds.minLat, lon: bounds.minLon },
  { lat: bounds.minLat, lon: bounds.maxLon }
);
const heightMeters = distanceMeters(
  { lat: bounds.minLat, lon: bounds.minLon },
  { lat: bounds.maxLat, lon: bounds.minLon }
);
console.log(
  `\n範囲: 東西 ${(widthMeters / 1000).toFixed(2)} km × 南北 ${(heightMeters / 1000).toFixed(2)} km ` +
  `（縦横比 ${(heightMeters / widthMeters).toFixed(2)} : 1）`
);

// ---------------------------------------------------------------
// 8. 書き出し
// ---------------------------------------------------------------

const output = {
  _comment: 'tools/build-route.js が OpenStreetMap のデータから自動生成。手で編集しないこと。',
  source: 'OpenStreetMap contributors (ODbL)',
  generatedAt: new Date().toISOString().slice(0, 10),
  origin,
  totalLength: Math.round(totalLength),
  bounds,
  stations,
  // 座標は小数 6 桁（約 10cm）まで。それ以上は無駄に重くなるだけ。
  track: chain.map((p) => [
    Math.round(p.lat * 1e6) / 1e6,
    Math.round(p.lon * 1e6) / 1e6,
  ]),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
console.log(`\n書き出し: ${outPath}`);
