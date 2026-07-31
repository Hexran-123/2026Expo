/*
 * fetch-elevation.js
 *
 * 国土地理院の標高タイルをダウンロードし、
 * 地図に敷く地形の濃淡のもとになる標高の格子データを作る。
 *
 * 使い方:  node tools/fetch-elevation.js
 *
 * 出典: 国土地理院 標高タイル（DEM10B）
 *       https://maps.gsi.go.jp/development/ichiran.html
 */

const fs = require('fs');
const path = require('path');

const ROUTE_PATH = path.join(__dirname, '..', 'data', 'route.json');
const OUT_PATH = path.join(__dirname, '..', 'data', 'source', 'elevation-grid.json');

/** 標高タイルの縮尺。14 なら 1 マス約 8m。地形の濃淡にはこれで十分。 */
const ZOOM = 14;

/*
 * 路線の範囲の外側にどれだけ地図を広げるか（度）。
 *
 * 縦長のスマートフォンに横長でない路線を収めると、上下に余白ができる。
 * そこを海の色で埋めるより、実際の地形を出したほうが位置がわかりやすい。
 * 南北を広めにとると、北に利根川、南に太平洋と犬吠埼が入る。
 *
 * 0.020 度 ≒ 南北 2.2km / 0.012 度 ≒ 東西 1.1km
 */
const MARGIN_LAT = 0.020;
const MARGIN_LON = 0.012;

/** 何マスを 1 つにまとめるか。3 なら 1 マス約 24m になり、データが 1/9 に減る。 */
const DOWNSAMPLE = 3;

// ---------------------------------------------------------------
// 緯度経度 ↔ タイルの座標
//
// 地図タイルは「メルカトル図法で世界地図を 2^zoom × 2^zoom 枚に切ったもの」。
// 1 枚が 256×256 マスなので、世界全体は 256 × 2^zoom マスの格子になる。
// ---------------------------------------------------------------

const WORLD_PIXELS = 256 * Math.pow(2, ZOOM);

function lonToPixelX(lon) {
  return ((lon + 180) / 360) * WORLD_PIXELS;
}

function latToPixelY(lat) {
  const rad = (lat * Math.PI) / 180;
  const mercator = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
  return ((1 - mercator / Math.PI) / 2) * WORLD_PIXELS;
}

function pixelXToLon(x) {
  return (x / WORLD_PIXELS) * 360 - 180;
}

function pixelYToLat(y) {
  const mercator = (1 - (2 * y) / WORLD_PIXELS) * Math.PI;
  return (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
}

// ---------------------------------------------------------------
// 1. 必要な範囲を決める
// ---------------------------------------------------------------

const route = JSON.parse(fs.readFileSync(ROUTE_PATH, 'utf8'));
const area = {
  minLat: route.bounds.minLat - MARGIN_LAT,
  maxLat: route.bounds.maxLat + MARGIN_LAT,
  minLon: route.bounds.minLon - MARGIN_LON,
  maxLon: route.bounds.maxLon + MARGIN_LON,
};

// 範囲を覆うマスの番号（世界全体の格子での通し番号）
const pixelLeft = Math.floor(lonToPixelX(area.minLon));
const pixelRight = Math.ceil(lonToPixelX(area.maxLon));
const pixelTop = Math.floor(latToPixelY(area.maxLat)); // 緯度が高いほど上＝番号が小さい
const pixelBottom = Math.ceil(latToPixelY(area.minLat));

const tileLeft = Math.floor(pixelLeft / 256);
const tileRight = Math.floor((pixelRight - 1) / 256);
const tileTop = Math.floor(pixelTop / 256);
const tileBottom = Math.floor((pixelBottom - 1) / 256);

const tileCount = (tileRight - tileLeft + 1) * (tileBottom - tileTop + 1);
console.log(`必要なタイル: ${tileCount} 枚（x ${tileLeft}〜${tileRight}, y ${tileTop}〜${tileBottom}）`);

// ---------------------------------------------------------------
// 2. タイルをダウンロードして 1 枚の大きな格子にまとめる
// ---------------------------------------------------------------

const gridWidth = pixelRight - pixelLeft;
const gridHeight = pixelBottom - pixelTop;

/** 標高を入れる箱。海など値のない場所は null のままにする。 */
const raw = new Array(gridWidth * gridHeight).fill(null);

async function fetchTile(tileX, tileY) {
  const url = `https://cyberjapandata.gsi.go.jp/xyz/dem/${ZOOM}/${tileX}/${tileY}.txt`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ChoshiWindowNavi/0.1 (student contest project)' },
  });

  // 海だけのタイルは 404 が返る。それは「全部海」として扱ってよい。
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status} : ${url}`);

  return response.text();
}

async function main() {
  let done = 0;

  for (let tileY = tileTop; tileY <= tileBottom; tileY++) {
    for (let tileX = tileLeft; tileX <= tileRight; tileX++) {
      const text = await fetchTile(tileX, tileY);
      done++;
      process.stdout.write(`\rダウンロード: ${done}/${tileCount}`);
      if (text === null) continue;

      const rows = text.trim().split('\n');
      for (let row = 0; row < rows.length; row++) {
        const values = rows[row].split(',');
        for (let col = 0; col < values.length; col++) {
          // 'e' は「データなし」（多くは海）
          if (values[col] === 'e') continue;

          const globalX = tileX * 256 + col;
          const globalY = tileY * 256 + row;
          if (globalX < pixelLeft || globalX >= pixelRight) continue;
          if (globalY < pixelTop || globalY >= pixelBottom) continue;

          raw[(globalY - pixelTop) * gridWidth + (globalX - pixelLeft)] = parseFloat(values[col]);
        }
      }
    }
  }
  console.log('');

  // -------------------------------------------------------------
  // 3. 間引いて軽くする
  //
  // DOWNSAMPLE マス四方の平均を 1 マスにまとめる。
  // 地形の濃淡を塗るだけなので、細かすぎても意味がない。
  // -------------------------------------------------------------

  const outWidth = Math.floor(gridWidth / DOWNSAMPLE);
  const outHeight = Math.floor(gridHeight / DOWNSAMPLE);
  const values = new Array(outWidth * outHeight);

  for (let row = 0; row < outHeight; row++) {
    for (let col = 0; col < outWidth; col++) {
      let sum = 0;
      let count = 0;
      for (let dy = 0; dy < DOWNSAMPLE; dy++) {
        for (let dx = 0; dx < DOWNSAMPLE; dx++) {
          const v = raw[(row * DOWNSAMPLE + dy) * gridWidth + (col * DOWNSAMPLE + dx)];
          if (v !== null) {
            sum += v;
            count++;
          }
        }
      }
      // まとめた範囲がすべて海なら null（＝水域）
      values[row * outWidth + col] = count === 0 ? null : Math.round((sum / count) * 10) / 10;
    }
  }

  // -------------------------------------------------------------
  // 4. 確認と書き出し
  // -------------------------------------------------------------

  const land = values.filter((v) => v !== null);
  const seaRatio = ((values.length - land.length) / values.length) * 100;
  console.log(
    `格子: ${outWidth} × ${outHeight} マス` +
    `（1 マス約 ${Math.round((111320 * (area.maxLon - area.minLon) * Math.cos((area.minLat * Math.PI) / 180)) / outWidth)}m）`
  );
  console.log(`標高: ${Math.min(...land)}m 〜 ${Math.max(...land)}m / 水域 ${seaRatio.toFixed(1)}%`);

  // 実際に覆えた範囲（マスの境界にそろえた、ぴったりの緯度経度）
  const bounds = {
    minLon: pixelXToLon(pixelLeft),
    maxLon: pixelXToLon(pixelLeft + outWidth * DOWNSAMPLE),
    maxLat: pixelYToLat(pixelTop),
    minLat: pixelYToLat(pixelTop + outHeight * DOWNSAMPLE),
  };

  const output = {
    _comment: 'tools/fetch-elevation.js が自動生成。手で編集しないこと。',
    source: '国土地理院 標高タイル DEM10B',
    generatedAt: new Date().toISOString().slice(0, 10),
    bounds,
    width: outWidth,
    height: outHeight,
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
