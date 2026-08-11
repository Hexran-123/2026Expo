/*
 * fetch-elevation.js
 *
 * 国土地理院の標高タイルをダウンロードし、
 * 地図に敷く地形の濃淡・陰影のもとになる標高の格子データを作る。
 *
 * 使い方:  node tools/fetch-elevation.js
 *
 * 出典: 国土地理院 標高タイル（DEM5A / DEM10B）
 *       https://maps.gsi.go.jp/development/ichiran.html
 *
 * --- 2 種類のタイルを組み合わせる理由 ---
 *
 * 標準の標高タイル（DEM10B、約8m格子）は縮尺14までしか無いが、全域そろっている。
 * 5m メッシュ（DEM5A、航空写真から作成、約4m格子）は縮尺15まであるが、
 * この路線のあたりだと南側（外川・犬吠埼寄り）が欠けている。
 *
 * そこで DEM5A を優先して使い、無い場所だけ DEM10B で埋める。
 * 縮尺15は縮尺14のちょうど2倍の細かさなので、DEM10B 側のマスを
 * そのまま2倍に引き伸ばす（バイリニア補間）だけで、同じ格子に重ねられる。
 */

const fs = require('fs');
const path = require('path');

/*
 * 使い方:  node tools/fetch-elevation.js [route.json] [出力先.json]
 *
 * 引数は省略できる。省略したときは銚子電鉄のときの値になるので、
 * 今までの `node tools/fetch-elevation.js` はそのまま同じ結果になる。
 */
const ROUTE_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'data', 'choshi', 'route.json');
const OUT_PATH = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(__dirname, '..', 'data', 'source', 'elevation-grid.json');

const FINE_ZOOM = 15;   // DEM5A（5m メッシュ）
const COARSE_ZOOM = 14; // DEM10B（標準）。FINE_ZOOM のちょうど半分の細かさ。

/*
 * 路線の範囲の外側にどれだけ地図を広げるか（度）。
 *
 * 縦長のスマートフォンに横長でない路線を収めると、上下に余白ができる。
 * そこを海の色で埋めるより、実際の地形を出したほうが位置がわかりやすい。
 * 南北を広めにとると、北に利根川、南に太平洋と犬吠埼が入る。
 */
const MARGIN_LAT = 0.020;
const MARGIN_LON = 0.012;

const USER_AGENT = { 'User-Agent': 'ChoshiWindowNavi/0.1 (student contest project)' };

// ---------------------------------------------------------------
// 緯度経度 ↔ タイルの座標
// ---------------------------------------------------------------

function worldPixels(zoom) {
  return 256 * Math.pow(2, zoom);
}
function lonToPixelX(lon, zoom) {
  return ((lon + 180) / 360) * worldPixels(zoom);
}
function latToPixelY(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  const mercator = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
  return ((1 - mercator / Math.PI) / 2) * worldPixels(zoom);
}
function pixelXToLon(x, zoom) {
  return (x / worldPixels(zoom)) * 360 - 180;
}
function pixelYToLat(y, zoom) {
  const mercator = (1 - (2 * y) / worldPixels(zoom)) * Math.PI;
  return (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
}

/** 指定した緯度経度の範囲を覆う、あるズームでのマス目の範囲を求める */
function pixelBoundsFor(area, zoom) {
  const left = Math.floor(lonToPixelX(area.minLon, zoom));
  const right = Math.ceil(lonToPixelX(area.maxLon, zoom));
  const top = Math.floor(latToPixelY(area.maxLat, zoom));
  const bottom = Math.ceil(latToPixelY(area.minLat, zoom));
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

// ---------------------------------------------------------------
// タイルのダウンロードと格子への書き込み
// ---------------------------------------------------------------

async function fetchTileText(kind, zoom, tileX, tileY) {
  const url = `https://cyberjapandata.gsi.go.jp/xyz/${kind}/${zoom}/${tileX}/${tileY}.txt`;
  const response = await fetch(url, { headers: USER_AGENT });

  // タイルが存在しない（海だけ、またはこのデータ種別の対象外）場合は 404 が返る
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status} : ${url}`);
  return response.text();
}

/**
 * ある範囲を覆う、あるタイル種別・ズームのデータを 1 枚の格子にまとめる。
 * @returns {{ values: Array<number|null>, width: number, height: number }}
 */
async function fetchGrid(kind, zoom, pixelBounds, onProgress) {
  const { left, top, width, height } = pixelBounds;
  const tileLeft = Math.floor(left / 256);
  const tileRight = Math.floor((pixelBounds.right - 1) / 256);
  const tileTop = Math.floor(top / 256);
  const tileBottom = Math.floor((pixelBounds.bottom - 1) / 256);

  const values = new Array(width * height).fill(null);
  const tileCount = (tileRight - tileLeft + 1) * (tileBottom - tileTop + 1);
  let done = 0;
  let hits = 0;

  for (let tileY = tileTop; tileY <= tileBottom; tileY++) {
    for (let tileX = tileLeft; tileX <= tileRight; tileX++) {
      const text = await fetchTileText(kind, zoom, tileX, tileY);
      done++;
      onProgress(done, tileCount);
      if (text === null) continue;
      hits++;

      const rows = text.trim().split('\n');
      for (let row = 0; row < rows.length; row++) {
        const cols = rows[row].split(',');
        for (let col = 0; col < cols.length; col++) {
          if (cols[col] === 'e') continue; // 'e' = データなし（主に海）

          const globalX = tileX * 256 + col;
          const globalY = tileY * 256 + row;
          if (globalX < left || globalX >= pixelBounds.right) continue;
          if (globalY < top || globalY >= pixelBounds.bottom) continue;

          values[(globalY - top) * width + (globalX - left)] = parseFloat(cols[col]);
        }
      }
    }
  }
  return { values, width, height, tileCount, hits };
}

// ---------------------------------------------------------------
// 粗いほう（COARSE_ZOOM）の値を、細かいほう（FINE_ZOOM）の格子に合わせて
// 2 倍に引き伸ばす（バイリニア補間）。
// FINE_ZOOM は COARSE_ZOOM のちょうど 2 倍の細かさなので、
// 「細かい側のマス目 (fx, fy)」に対応する「粗い側の位置」は (fx/2, fy/2) になる。
// ---------------------------------------------------------------

function sampleBilinear(coarse, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;

  const get = (cx, cy) => {
    const clampedX = Math.max(0, Math.min(coarse.width - 1, cx));
    const clampedY = Math.max(0, Math.min(coarse.height - 1, cy));
    return coarse.values[clampedY * coarse.width + clampedX];
  };

  const corners = [
    { v: get(x0, y0), w: (1 - tx) * (1 - ty) },
    { v: get(x0 + 1, y0), w: tx * (1 - ty) },
    { v: get(x0, y0 + 1), w: (1 - tx) * ty },
    { v: get(x0 + 1, y0 + 1), w: tx * ty },
  ].filter((c) => c.v !== null);

  if (corners.length === 0) return null;
  const totalWeight = corners.reduce((s, c) => s + c.w, 0);
  if (totalWeight === 0) return corners[0].v; // 端の角ぴったりなど
  return corners.reduce((s, c) => s + c.v * c.w, 0) / totalWeight;
}

// ---------------------------------------------------------------
// メイン
// ---------------------------------------------------------------

async function main() {
  const route = JSON.parse(fs.readFileSync(ROUTE_PATH, 'utf8'));
  const area = {
    minLat: route.bounds.minLat - MARGIN_LAT,
    maxLat: route.bounds.maxLat + MARGIN_LAT,
    minLon: route.bounds.minLon - MARGIN_LON,
    maxLon: route.bounds.maxLon + MARGIN_LON,
  };

  const finePixels = pixelBoundsFor(area, FINE_ZOOM);
  const coarsePixels = pixelBoundsFor(area, COARSE_ZOOM);

  console.log(`DEM5A（縮尺${FINE_ZOOM}・約4m格子）を取得中…`);
  const fine = await fetchGrid('dem5a', FINE_ZOOM, finePixels, (done, total) =>
    process.stdout.write(`\r  ${done}/${total} タイル`)
  );
  console.log(`\n  ヒット: ${fine.hits}/${fine.tileCount} タイル`);

  console.log(`DEM10B（縮尺${COARSE_ZOOM}・約8m格子、穴埋め用）を取得中…`);
  const coarse = await fetchGrid('dem', COARSE_ZOOM, coarsePixels, (done, total) =>
    process.stdout.write(`\r  ${done}/${total} タイル`)
  );
  console.log(`\n  ヒット: ${coarse.hits}/${coarse.tileCount} タイル`);

  // fine 格子の原点が、coarse 格子の何マス目にあたるか（coarse の物差しで）
  const originOffsetX = finePixels.left / 2 - coarsePixels.left;
  const originOffsetY = finePixels.top / 2 - coarsePixels.top;

  const values = new Array(fine.width * fine.height);
  let filledByFine = 0, filledByCoarse = 0, stillEmpty = 0;

  for (let row = 0; row < fine.height; row++) {
    for (let col = 0; col < fine.width; col++) {
      const index = row * fine.width + col;
      const fineValue = fine.values[index];

      if (fineValue !== null) {
        values[index] = fineValue;
        filledByFine++;
        continue;
      }

      const coarseValue = sampleBilinear(coarse, originOffsetX + col / 2, originOffsetY + row / 2);
      if (coarseValue !== null) {
        values[index] = Math.round(coarseValue * 10) / 10;
        filledByCoarse++;
      } else {
        values[index] = null;
        stillEmpty++;
      }
    }
  }

  const total = fine.width * fine.height;
  console.log(
    `\n内訳: DEM5A ${((filledByFine / total) * 100).toFixed(0)}% ／ ` +
    `DEM10Bで穴埋め ${((filledByCoarse / total) * 100).toFixed(0)}% ／ ` +
    `海 ${((stillEmpty / total) * 100).toFixed(0)}%`
  );

  // マス数が多いと Math.min(...land) はスタックが溢れるので、ループで求める
  let minElevation = Infinity, maxElevation = -Infinity, landCount = 0;
  for (const v of values) {
    if (v === null) continue;
    landCount++;
    if (v < minElevation) minElevation = v;
    if (v > maxElevation) maxElevation = v;
  }
  console.log(`格子: ${fine.width} × ${fine.height} マス`);
  console.log(`標高: ${minElevation}m 〜 ${maxElevation}m`);

  const bounds = {
    minLon: pixelXToLon(finePixels.left, FINE_ZOOM),
    maxLon: pixelXToLon(finePixels.right, FINE_ZOOM),
    maxLat: pixelYToLat(finePixels.top, FINE_ZOOM),
    minLat: pixelYToLat(finePixels.bottom, FINE_ZOOM),
  };

  const output = {
    _comment: 'tools/fetch-elevation.js が自動生成。手で編集しないこと。',
    source: '国土地理院 標高タイル DEM5A（穴はDEM10Bで補完）',
    generatedAt: new Date().toISOString().slice(0, 10),
    bounds,
    width: fine.width,
    height: fine.height,
    // 北西の角から、西→東・北→南の順に並べる。null は水域。
    values,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output), 'utf8');
  console.log(`書き出し: ${OUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
