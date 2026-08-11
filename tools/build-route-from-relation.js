/*
 * build-route-from-relation.js
 *
 * fetch-relation.js が取ってきた route relation を、サイトが読む route.json に変換する。
 * 出力の形は tools/build-route.js（銚子電鉄用）とまったく同じにしてある。
 * サイト側はどちらで作られたかを気にしない。
 *
 * 銚子用との違いは、線路と駅の選び方だけ。
 *   銚子用 … 四角い範囲の線路を全部拾い、名前で選り分け、ダイクストラでつなぐ。
 *   こちら … relation のメンバーをそのまま使う。どれがこの路線かは OSM が決めている。
 *
 * 地下鉄でこちらが要る理由は fetch-relation.js の冒頭に書いた（駅名が他社と重なる）。
 *
 * 使い方:  node tools/build-route-from-relation.js <raw.json> <出力先.json>
 * 例:      node tools/build-route-from-relation.js data/source/yurakucho_raw.json data/yurakucho/route.json
 */

const fs = require('fs');
const path = require('path');

const rawPath = process.argv[2];
const outPath = process.argv[3];

if (!rawPath || !outPath) {
  console.error('使い方: node tools/build-route-from-relation.js <raw.json> <出力先.json>');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8').replace(/^﻿/, ''));

// ---------------------------------------------------------------
// 緯度経度 → メートル（build-route.js と同じ式）
//
// 30km 程度の範囲なら、地球を平面とみなす単純な式で十分。
// ---------------------------------------------------------------

let origin = null;

function toMeters({ lat, lon }) {
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    x: (lon - origin.lon) * 111320 * Math.cos(latRad),
    y: (lat - origin.lat) * 110540,
  };
}

function distanceMeters(a, b) {
  const pa = toMeters(a);
  const pb = toMeters(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

// ---------------------------------------------------------------
// 1. relation と駅を拾う
// ---------------------------------------------------------------

const relation = raw.elements.find((el) => el.type === 'relation');
if (!relation) {
  console.error('relation が入っていない。fetch-relation.js からやり直すこと。');
  process.exit(1);
}

const nodeById = new Map(
  raw.elements.filter((el) => el.type === 'node').map((n) => [n.id, n])
);

/*
 * role が stop のメンバーが駅。relation のメンバーは進行方向の順に並んでいるので、
 * この順番がそのまま駅の順番になる。
 * platform は駅のホーム（形だけ）なので使わない。線路でも駅の位置でもない。
 */
const stops = relation.members
  .filter((m) => m.type === 'node' && /^stop/.test(m.role || ''))
  .map((m) => nodeById.get(m.ref))
  .filter(Boolean);

if (stops.length === 0) {
  console.error('role が stop のノードが無い。relation の作りを確認すること。');
  process.exit(1);
}

const nameless = stops.filter((n) => !(n.tags && n.tags.name));
if (nameless.length > 0) {
  console.error(`名前の無い駅ノードが ${nameless.length} 個ある。`);
  process.exit(1);
}

origin = { lat: stops[0].lat, lon: stops[0].lon };

console.log(`路線: ${relation.tags.name}`);
console.log(`  駅: ${stops.length} 駅（${stops[0].tags.name} → ${stops[stops.length - 1].tags.name}）`);

// ---------------------------------------------------------------
// 2. 線路の断片を拾ってつなぐ
//
// role が空のメンバーが線路。relation の並び順にほぼ沿っているが、
// 一本ずつの向きは揃っていない（逆さまに登録されているものがある）。
// つなぎ目が合うほうへ向きを直しながら、一本の線にしていく。
// ---------------------------------------------------------------

const segments = relation.members
  .filter((m) => m.type === 'way' && !m.role)
  .map((m) => (m.geometry || []).map((g) => ({ lat: g.lat, lon: g.lon })))
  .filter((points) => points.length >= 2);

console.log(`  線路の断片: ${segments.length} 本`);

/** つなぎ目とみなす距離。OSM の点は完全一致しないことがある */
const JOIN_TOLERANCE_M = 5;

const chain = [];
const gaps = [];

for (const points of segments) {
  if (chain.length === 0) {
    chain.push(...points);
    continue;
  }

  const tail = chain[chain.length - 1];
  const toHead = distanceMeters(tail, points[0]);
  const toTail = distanceMeters(tail, points[points.length - 1]);

  // 後ろの端に近いほうが頭に来るよう、必要なら向きを反転する
  const ordered = toTail < toHead ? points.slice().reverse() : points;
  const gap = Math.min(toHead, toTail);

  if (gap > JOIN_TOLERANCE_M) {
    gaps.push({ at: chain.length, gap: Math.round(gap) });
  }

  // つなぎ目の点は重複するので 1 点目を飛ばす。離れている場合は飛ばさない。
  chain.push(...(gap <= JOIN_TOLERANCE_M ? ordered.slice(1) : ordered));
}

if (gaps.length > 0) {
  console.warn(`  ⚠ つながっていない箇所が ${gaps.length} 個ある:`);
  gaps.slice(0, 10).forEach((g) => console.warn(`      ${g.at} 点目のあと ${g.gap} m`));
  console.warn('    大きい値が出ていたら、線路の順番が狂っている可能性がある。');
}

console.log(`  つないだ結果: ${chain.length} 点`);

// ---------------------------------------------------------------
// 3. 起点からの累積距離
// ---------------------------------------------------------------

const cumulative = [0];
for (let i = 1; i < chain.length; i++) {
  cumulative.push(cumulative[i - 1] + distanceMeters(chain[i - 1], chain[i]));
}
const totalLength = cumulative[cumulative.length - 1];

// ---------------------------------------------------------------
// 4. 駅を路線上に投影する（build-route.js と同じ計算）
// ---------------------------------------------------------------

function projectOntoRoute(point) {
  const p = toMeters(point);
  let best = { distanceAlong: 0, offset: Infinity };

  for (let i = 0; i < chain.length - 1; i++) {
    const a = toMeters(chain[i]);
    const b = toMeters(chain[i + 1]);

    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lengthSquared = abx * abx + aby * aby;
    if (lengthSquared === 0) continue;

    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared;
    t = Math.max(0, Math.min(1, t));

    const offset = Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));

    if (offset < best.offset) {
      best = {
        distanceAlong: cumulative[i] + t * Math.sqrt(lengthSquared),
        offset,
      };
    }
  }

  return best;
}

const expectedOrder = stops.map((n) => n.tags.name);

const stations = stops
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
// 5. 確認
// ---------------------------------------------------------------

console.log(`\n全長: ${(totalLength / 1000).toFixed(2)} km`);
console.log('\n駅の並び（起点からの距離 / 線路とのずれ）:');

let outOfOrder = 0;
stations.forEach((s, i) => {
  const ok = s.name === expectedOrder[i];
  if (!ok) outOfOrder++;
  console.log(
    `  ${String(i + 1).padStart(2)}. ${s.name.padEnd(7, '　')} ` +
    `${String(s.distanceAlong).padStart(6)} m   ずれ ${String(s.offsetFromTrack).padStart(6)} m` +
    (ok ? '' : `  ← relation の順番では ${expectedOrder[i]}`)
  );
});

if (outOfOrder > 0) {
  console.warn(`\n⚠ ${outOfOrder} 駅が relation の順番と食い違っている。線路のつなぎ方を疑うこと。`);
}

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
// 6. 書き出し
// ---------------------------------------------------------------

const output = {
  _comment: 'tools/build-route-from-relation.js が OpenStreetMap のデータから自動生成。手で編集しないこと。',
  source: 'OpenStreetMap contributors (ODbL)',
  osmRelation: relation.id,
  lineName: relation.tags.name,
  generatedAt: new Date().toISOString().slice(0, 10),
  origin,
  totalLength: Math.round(totalLength),
  bounds,
  stations,
  track: chain.map((p) => [
    Math.round(p.lat * 1e6) / 1e6,
    Math.round(p.lon * 1e6) / 1e6,
  ]),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
console.log(`\n書き出し: ${outPath}`);
