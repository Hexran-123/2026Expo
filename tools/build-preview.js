/*
 * build-preview.js
 *
 * 開始画面（路線選択）に出す小さな地図のためのデータを作る。
 *
 * なぜ要るか: 開始画面は「まだ何も選んでいない人」が最初に見る画面で、
 *             そこで両方の路線の地図を出すには、両方ぶんのデータが要る。
 *             地図画面用の terrain.json をそのまま使うと二路線で 267 KB
 *             （gzip で 105 KB）あり、選ぶ前の待ち時間としては重い。
 *
 * やること:   terrain.json の輪郭を、開始画面に必要なぶんだけ粗くする。
 *             プレビューは幅 350px ほどで出るのに、輪郭は幅 1000 の座標で
 *             小数第 1 位まで持っている。30 倍ほど細かすぎる。
 *             - 輪郭を間引く（Douglas-Peucker、許容ずれ EPSILON）
 *             - 小さすぎる島を捨てる（MIN_AREA より小さいもの）
 *             - 座標を整数に丸める
 *             線路と駅も同じ考えで間引き、1 つのファイルにまとめる。
 *             こうすると開始画面が読むのは路線あたり 1 ファイルだけになる。
 *
 * 使い方:  node tools/build-preview.js [terrain.json] [route.json] [出力先.json]
 *
 * 引数は省略できる。省略したときは銚子電鉄のときの値になる。
 * 有楽町線は
 *   node tools/build-preview.js data/yurakucho/terrain.json data/yurakucho/route.json data/yurakucho/preview.json
 *
 * terrain.json か route.json を作り直したら、これも作り直すこと。
 */

const fs = require('fs');
const path = require('path');

const TERRAIN_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'data', 'choshi', 'terrain.json');
const ROUTE_PATH = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(__dirname, '..', 'data', 'choshi', 'route.json');
const OUT_PATH = process.argv[4]
  ? path.resolve(process.argv[4])
  : path.join(__dirname, '..', 'data', 'choshi', 'preview.json');

/*
 * 輪郭をどれだけずらしてよいか（地図の座標。幅が 1000）。
 *
 * 開始画面のプレビューは幅 350px ほど。いちばん寄ったときで
 * 1px あたり約 1.5 座標なので、2 座標のずれは 1.3px ほど。
 * 実際に並べて見比べて、違いが分からないことを確かめた値。
 */
const EPSILON = 2;

/** これより小さい島は捨てる（外接する四角の面積。地図の座標） */
const MIN_AREA = 12;

/** 線路の緯度経度を何桁で持つか。4 桁で約 11m。プレビューには十分 */
const COORD_DIGITS = 4;

/* ------------------------------------------------------------------
   SVG のパスを点の並びに戻す・組み立て直す
   ------------------------------------------------------------------ */

function parsePath(d) {
  const subPaths = [];
  for (const chunk of d.split('M').slice(1)) {
    const closed = /Z\s*$/i.test(chunk);
    const points = chunk
      .replace(/Z\s*$/i, '')
      .split('L')
      .map((pair) => pair.split(',').map(Number));
    subPaths.push({ points, closed });
  }
  return subPaths;
}

function buildPath(subPaths) {
  return subPaths
    .map(({ points, closed }) =>
      'M' + points.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join('L') + (closed ? 'Z' : '')
    )
    .join('');
}

/* ------------------------------------------------------------------
   間引き（Douglas-Peucker）

   両端を結んだ線から、いちばん離れている点を探す。
   その離れ方が許容ずれより小さければ、あいだの点は全部捨ててよい。
   大きければその点で二つに分け、それぞれで同じことを繰り返す。
   ------------------------------------------------------------------ */

/** 点 p から線分 ab までの距離の 2 乗 */
function squaredDistanceToSegment(p, a, b) {
  let x = a[0];
  let y = a[1];
  const dx = b[0] - x;
  const dy = b[1] - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  return (p[0] - x) ** 2 + (p[1] - y) ** 2;
}

function simplify(points, epsilon) {
  if (points.length < 3) return points;

  // 残す点の番号。両端は必ず残す
  const keep = new Set([0, points.length - 1]);

  // 再帰だと点が多いときに積みきれないので、自分で積む
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let worst = 0;
    let worstIndex = -1;

    for (let i = first + 1; i < last; i += 1) {
      const d = squaredDistanceToSegment(points[i], points[first], points[last]);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }

    if (worstIndex !== -1 && worst > epsilon * epsilon) {
      keep.add(worstIndex);
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }

  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

/** 外接する四角の面積。小さい島を見つけるのに使う */
function boundingArea(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return (maxX - minX) * (maxY - minY);
}

/* ------------------------------------------------------------------
   組み立て
   ------------------------------------------------------------------ */

const terrain = JSON.parse(fs.readFileSync(TERRAIN_PATH, 'utf8'));
const route = JSON.parse(fs.readFileSync(ROUTE_PATH, 'utf8'));

let pointsBefore = 0;
let pointsAfter = 0;

const bands = terrain.bands.map((band) => {
  const subPaths = parsePath(band.path);
  pointsBefore += subPaths.reduce((n, s) => n + s.points.length, 0);

  const thinned = subPaths
    .filter((sub) => boundingArea(sub.points) >= MIN_AREA)
    .map((sub) => ({ ...sub, points: simplify(sub.points, EPSILON) }));

  pointsAfter += thinned.reduce((n, s) => n + s.points.length, 0);

  return { minElevation: band.minElevation, path: buildPath(thinned) };
});

/*
 * 線路。緯度経度のままにしておく。
 * 描くときは投影するが、「現在地からこの路線まで何 m か」を測るのにも使うので、
 * 画面の座標ではなく地球の座標で持っておく必要がある。
 *
 * 間引きは投影後の座標で判断して、残った点の緯度経度を採る。
 * 緯度経度のままだと、経度 1 度と緯度 1 度で長さが違って歪む。
 */
const bounds = terrain.projection.bounds;
const toMapX = (lon) =>
  ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * terrain.projection.width;
const toMapY = (lat) =>
  ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * terrain.projection.height;

const projected = route.track.map(([lat, lon]) => [toMapX(lon), toMapY(lat)]);
const keptIndexes = new Set();
{
  // simplify は点そのものを返すので、番号を引けるように印を付けて通す
  const tagged = projected.map(([x, y], i) => [x, y, i]);
  for (const point of simplify(tagged, EPSILON / 2)) keptIndexes.add(point[2]);
}

const round = (v) => Number(v.toFixed(COORD_DIGITS));
const track = route.track
  .filter((_, i) => keptIndexes.has(i))
  .map(([lat, lon]) => [round(lat), round(lon)]);

const stations = route.stations.map((station) => [round(station.lat), round(station.lon)]);

const preview = {
  _comment:
    'tools/build-preview.js が自動生成。手で編集しないこと。' +
    '開始画面（路線選択）の小さな地図だけに使う。地図画面は terrain.json と route.json を使う。',
  source: path.basename(TERRAIN_PATH) + ' + ' + path.basename(ROUTE_PATH),
  generatedAt: new Date().toISOString(),
  projection: terrain.projection,
  bands,
  track,
  stations,
  summary: {
    lengthMeters: Math.round(route.totalLength),
    stationCount: route.stations.length,
    from: route.stations[0].name,
    to: route.stations[route.stations.length - 1].name,
    // terrain.json の elevationAlongRoute をそのまま運ぶ（js/main.js の pickLine が開始画面のカードに出す）
    elevation: terrain.elevationAlongRoute || null,
  },
};

fs.writeFileSync(OUT_PATH, JSON.stringify(preview));

/* ------------------------------------------------------------------
   結果を出す
   ------------------------------------------------------------------ */

const zlib = require('zlib');
const sizeOf = (file) => fs.statSync(file).size;
const gzipOf = (file) => zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(0).padStart(4) + ' KB';

const beforeBytes = sizeOf(TERRAIN_PATH) + sizeOf(ROUTE_PATH);
const beforeGzip = gzipOf(TERRAIN_PATH) + gzipOf(ROUTE_PATH);

console.log(`書き出し: ${path.relative(path.join(__dirname, '..'), OUT_PATH)}`);
console.log(`  輪郭の点   : ${pointsBefore} → ${pointsAfter} (${((pointsAfter / pointsBefore) * 100).toFixed(0)}%)`);
console.log(`  線路の点   : ${route.track.length} → ${track.length} (${((track.length / route.track.length) * 100).toFixed(0)}%)`);
console.log(`  もとの合計 : ${kb(beforeBytes)}  gzip ${kb(beforeGzip)}   (terrain.json + route.json)`);
console.log(`  この 1 枚  : ${kb(sizeOf(OUT_PATH))}  gzip ${kb(gzipOf(OUT_PATH))}`);
