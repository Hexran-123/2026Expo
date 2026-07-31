/*
 * build-hillshade.js
 *
 * 標高データから「地形の陰影」の画像を作る。
 *
 * 考え方（陰影段彩・hillshade と呼ばれる、地図でよく使う技法）:
 *   各マスについて、まわりの標高との差から
 *   「その地面がどちらを向いて、どれだけ傾いているか」を求める。
 *   そこへ北西から太陽が当たっていると仮定すると、
 *   太陽に向いた斜面は明るく、逆を向いた斜面は暗く計算できる。
 *
 * これを白黒の画像として書き出し、地図の色の上に薄く重ねる。
 * 山は稜線で明暗が分かれ、色を塗り分けるだけよりずっと立体的に見える。
 *
 * 使い方:  node tools/build-hillshade.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GRID_PATH = path.join(__dirname, '..', 'data', 'source', 'elevation-grid.json');
// 書き出し先を指定できるようにしておく（比較用の参考画像を、本番のファイルを
// 上書きせずに別名で保存したいときのため）。省略時は本番の場所に書く。
const OUT_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'data', 'terrain-hillshade.png');

/** 太陽の方角。315° は北西（地図の陰影表現でいちばんよく使う角度）。 */
const SUN_AZIMUTH_DEG = 315;

/** 太陽の高さ。低いほど影が長く、地形がくっきり見える。 */
const SUN_ALTITUDE_DEG = 38;

/*
 * 標高差をどれだけ強調するか。
 *
 * 銚子の起伏は最大でも 72m しかなく、実際の高さのまま陰影をつけると
 * ほとんど平らに見えてしまう（物理的には正しいが、地図としては単調）。
 * ゲームの地図らしい誇張した立体感にするため、大きく強調する。
 */
const EXAGGERATION = 8;

/**
 * 明暗の差をさらにくっきりさせる仕上げ。
 *
 * 中間の灰色（128 = 「傾きなし」）から離れているぶんを、この倍率で押し広げる。
 * 1 なら計算そのまま。大きくするほど、尾根と谷の境目がはっきり分かれて見える。
 */
const CONTRAST = 1.6;

/** 標高をならす回数。少ないほど細かい地形のでこぼこが残り、輪郭がくっきりする。 */
const SMOOTH_PASSES = 1;

// ---------------------------------------------------------------
// 1. 読み込みと下ならし
// ---------------------------------------------------------------

const grid = JSON.parse(fs.readFileSync(GRID_PATH, 'utf8'));
const { width, height, bounds } = grid;

// セル 1 マスの実際の大きさ（メートル）。傾きの計算に使う。
const centerLatRad = (((bounds.minLat + bounds.maxLat) / 2) * Math.PI) / 180;
const cellWidthMeters = (((bounds.maxLon - bounds.minLon) * 111320 * Math.cos(centerLatRad)) / width);
const cellHeightMeters = ((bounds.maxLat - bounds.minLat) * 110540) / height;

/** 海（null）を隣の陸地の高さで埋める。境界のマスで傾きが暴れないようにするため。 */
function fillWater(values) {
  const filled = values.slice();
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const i = row * width + col;
        if (filled[i] !== null) continue;

        let sum = 0;
        let count = 0;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const r = row + dr, c = col + dc;
          if (r < 0 || r >= height || c < 0 || c >= width) continue;
          const v = filled[r * width + c];
          if (v !== null) { sum += v; count++; }
        }
        if (count > 0) { filled[i] = sum / count; changed = true; }
      }
    }
    if (!changed) break;
  }
  // 埋めきれなかった（まわり全部が海の）マスは 0m として扱う
  return filled.map((v) => (v === null ? 0 : v));
}

/** ノイズをならす軽いぼかし（3×3 の平均を数回）。DEM の細かいがたつきを抑える。 */
function smooth(values, passes) {
  let current = values;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const r = row + dy, c = col + dx;
            if (r < 0 || r >= height || c < 0 || c >= width) continue;
            sum += current[r * width + c];
            count++;
          }
        }
        next[row * width + col] = sum / count;
      }
    }
    current = next;
  }
  return current;
}

const landMask = grid.values.map((v) => v !== null);
const elevation = smooth(fillWater(grid.values), SMOOTH_PASSES);

// ---------------------------------------------------------------
// 2. 各マスの陰影を計算する（Horn 法による傾き計算 + 標準的な hillshade 式）
// ---------------------------------------------------------------

const azimuthRad = (SUN_AZIMUTH_DEG * Math.PI) / 180;
const zenithRad = ((90 - SUN_ALTITUDE_DEG) * Math.PI) / 180;

function at(col, row) {
  const c = Math.max(0, Math.min(width - 1, col));
  const r = Math.max(0, Math.min(height - 1, row));
  return elevation[r * width + c] * EXAGGERATION;
}

const shade = new Uint8ClampedArray(width * height);

for (let row = 0; row < height; row++) {
  for (let col = 0; col < width; col++) {
    // まわり 8 マス（Horn 法の並び）
    const a = at(col - 1, row - 1), b = at(col, row - 1), c = at(col + 1, row - 1);
    const d = at(col - 1, row),                            f = at(col + 1, row);
    const g = at(col - 1, row + 1), h = at(col, row + 1), i = at(col + 1, row + 1);

    const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cellWidthMeters);
    const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cellHeightMeters);

    const slopeRad = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
    let aspectRad = Math.atan2(dzdy, -dzdx);
    if (aspectRad < 0) aspectRad += 2 * Math.PI;

    const illumination =
      Math.cos(zenithRad) * Math.cos(slopeRad) +
      Math.sin(zenithRad) * Math.sin(slopeRad) * Math.cos(azimuthRad - aspectRad);

    // 128（変化なし）を中心に、そこからの離れぐあいを押し広げてくっきりさせる
    const contrasted = 128 + (illumination * 255 - 128) * CONTRAST;

    const index = row * width + col;
    // 海は陰影をつけない（水面は既に色で表現しているため）。128 = 「変化なし」の中間値。
    shade[index] = landMask[index] ? Math.round(contrasted) : 128;
  }
}

// ---------------------------------------------------------------
// 3. PNG として書き出す
//
// 外部の画像ライブラリを使わず、Node 標準の zlib だけで PNG を組み立てる。
// PNG は「決まった見出し」＋「圧縮した画素データ」の集まりでしかないので、
// 仕組みさえわかれば自分で作れる。
// ---------------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput));

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(grayscale, w, h) {
  // 各行の先頭に「フィルターなし」の印（0）を置いてから画素を並べる
  const raw = Buffer.alloc(h * (w + 1));
  for (let row = 0; row < h; row++) {
    raw[row * (w + 1)] = 0;
    for (let col = 0; col < w; col++) {
      raw[row * (w + 1) + 1 + col] = grayscale[row * w + col];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // ビット深度
  ihdr[9] = 0;   // 色の種類: 0 = グレースケール
  ihdr[10] = 0;  // 圧縮方式
  ihdr[11] = 0;  // フィルター方式
  ihdr[12] = 0;  // インターレースなし

  const idat = zlib.deflateSync(raw, { level: 9 });

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 陸地だけを見て、実際にどれくらいの明暗の幅が出ているかを確認する
const landValues = [...shade].filter((_, i) => landMask[i]);
const min = Math.min(...landValues);
const max = Math.max(...landValues);
const mean = landValues.reduce((s, v) => s + v, 0) / landValues.length;

const png = encodePng(shade, width, height);
fs.writeFileSync(OUT_PATH, png);

console.log(`太陽: 方位 ${SUN_AZIMUTH_DEG}°（北西） / 高さ ${SUN_ALTITUDE_DEG}° / 誇張 ${EXAGGERATION}倍`);
console.log(`明暗の幅（陸地）: ${min} 〜 ${max}（平均 ${mean.toFixed(0)}）／ 128 が「変化なし」`);
console.log(`画像: ${width} × ${height}px`);
console.log(`書き出し: ${OUT_PATH}（${(png.length / 1024).toFixed(0)} KB）`);
