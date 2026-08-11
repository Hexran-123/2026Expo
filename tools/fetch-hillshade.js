/*
 * fetch-hillshade.js
 *
 * 地形の陰影（hillshade）を、自前で計算するのではなく
 * 国土地理院が公開している完成品のタイル「陰影起伏図」からそのまま作る。
 *
 * 背景:
 *   以前は tools/build-hillshade.js が標高タイルから自分で陰影を計算していたが、
 *   実測点がまばらな場所で三角網の継ぎ目が縞模様になって見えたり、
 *   ズームを上げるほど元データの粗さ（約4m格子）が目立ってぼやけたりする問題があった。
 *   国土地理院はこの計算を最初から済ませた「陰影起伏図」タイルを
 *   縮尺16（標高タイルの縮尺15よりさらに1段細かい）まで、この路線の範囲では
 *   欠けなく公開しているので、それをそのまま貼り合わせて使うほうが
 *   より精細で、継ぎ目の問題も起きない。
 *
 * 使い方:  node tools/fetch-hillshade.js
 *
 * 書き出し先は data/source/ で、これは配信するファイルではない。
 * 配信するのは data/terrain-hillshade.webp のほう。
 *
 *   PNG  1,447KB  ←  この道具が書き出すもの（data/source/）
 *   WebP   241KB  ←  実際に配信するもの（data/）
 *
 * これ 1 枚が初回読み込みの 84% を占めていて、駅でモバイル回線で開く作品に
 * とっては重すぎた。不透明度 0.85 で重ねる背景の陰影なので、WebP の劣化は
 * 目に見えない。この道具は依存パッケージなしの Node で書いてあり
 * （ADR-0002）、WebP を書き出せないので、変換は別の一手にしてある。
 * 手順は README.md を参照。
 *
 * 出典: 国土地理院 陰影起伏図タイル
 *       https://maps.gsi.go.jp/development/ichiran.html#hillshademap
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/*
 * 使い方:  node tools/fetch-hillshade.js [出力先.png] [route.json] [縮尺]
 *
 * 引数はどれも省略できる。省略したときは銚子電鉄のときの値になるので、
 * 今までの `node tools/fetch-hillshade.js` はそのまま同じ結果になる。
 *
 * 縮尺を変えられるようにしてあるのは、路線の長さで必要な枚数が変わるため。
 * 銚子電鉄（6.4km）は縮尺16で 216 枚。有楽町線（28.4km）だと 1890 枚になり、
 * 貼り合わせた絵が 1.15 億画素まで膨らんで現実的でない。長い路線では
 * 縮尺を落とす。画面に映る細かさは、路線が長いぶん引いて見るので大きく変わらない。
 */
const OUT_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'data', 'source', 'terrain-hillshade.png');
const ROUTE_PATH = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(__dirname, '..', 'data', 'choshi', 'route.json');

const ZOOM = process.argv[4] ? Number(process.argv[4]) : 16;

if (!Number.isInteger(ZOOM) || ZOOM < 8 || ZOOM > 18) {
  console.error(`縮尺が変（${process.argv[4]}）。8〜18 の整数で指定すること。`);
  process.exit(1);
}

// data/source/elevation-grid.json（地形の色分けに使う標高データ）と
// 同じ範囲になるよう、同じ余白を使う。
const MARGIN_LAT = 0.020;
const MARGIN_LON = 0.012;

/*
 * 縮尺16のタイルをそのまま貼り合わせると数MB級になり、
 * モバイル回線での読み込みが重くなりすぎる。
 * 2×2マスを1マスに平均してから書き出す（画質の劣化は軽い、単純な間引きより滑らか）。
 * 1 なら間引きなし。
 */
const DOWNSAMPLE = 2;

const USER_AGENT = { 'User-Agent': 'ChoshiWindowNavi/0.1 (student contest project)' };

// ---------------------------------------------------------------
// 緯度経度 ↔ タイルの座標（fetch-elevation.js と同じ考え方）
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

function pixelBoundsFor(area, zoom) {
  const left = Math.floor(lonToPixelX(area.minLon, zoom));
  const right = Math.ceil(lonToPixelX(area.maxLon, zoom));
  const top = Math.floor(latToPixelY(area.maxLat, zoom));
  const bottom = Math.ceil(latToPixelY(area.minLat, zoom));
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

// ---------------------------------------------------------------
// PNG の最小限のデコーダー（RGBA・8bit・非インターレースのみ対応）
//
// GSI の陰影起伏図タイルはこの形式で来る。画像ライブラリを使わず、
// Node 標準の zlib（伸長）とスキャンライン単位のフィルター解除だけで読む。
// ---------------------------------------------------------------

function decodePngRgba(buffer) {
  let offset = 8; // シグネチャの次から
  let width, height, bitDepth, colorType;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.slice(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 8 + length + 4;
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`想定外のPNG形式（bitDepth=${bitDepth}, colorType=${colorType}）`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const channels = 4;
  const rowBytes = width * channels;
  const out = Buffer.alloc(height * rowBytes);
  let rawOffset = 0;

  for (let row = 0; row < height; row++) {
    const filterType = raw[rawOffset];
    rawOffset++;
    const rowStart = row * rowBytes;
    const prevRowStart = (row - 1) * rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const rawByte = raw[rawOffset + x];
      const a = x >= channels ? out[rowStart + x - channels] : 0;
      const b = row > 0 ? out[prevRowStart + x] : 0;
      const c = row > 0 && x >= channels ? out[prevRowStart + x - channels] : 0;

      let value;
      if (filterType === 0) value = rawByte;
      else if (filterType === 1) value = rawByte + a;
      else if (filterType === 2) value = rawByte + b;
      else if (filterType === 3) value = rawByte + Math.floor((a + b) / 2);
      else if (filterType === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else {
        throw new Error(`未対応のフィルター種別: ${filterType}`);
      }
      out[rowStart + x] = value & 0xff;
    }
    rawOffset += rowBytes;
  }

  return { width, height, data: out };
}

// ---------------------------------------------------------------
// PNG の書き出し（グレースケール＋透明度、8bit）
//
// GSI のタイルは陸地が白黒濃淡・海が透明（alpha=0）で来るので、
// そのままグレースケール＋アルファで書き出せば、海の部分は
// 地図側の水色をそのまま透かして見せられる（陰影が海ににじまない）。
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

/** grayAlpha: Uint8Array, 1マスにつき [gray, alpha] の並び */
function encodePngGrayAlpha(grayAlpha, w, h) {
  const raw = Buffer.alloc(h * (w * 2 + 1));
  for (let row = 0; row < h; row++) {
    const rowStart = row * (w * 2 + 1);
    raw[rowStart] = 0; // フィルターなし
    for (let col = 0; col < w; col++) {
      const src = (row * w + col) * 2;
      raw[rowStart + 1 + col * 2] = grayAlpha[src];
      raw[rowStart + 1 + col * 2 + 1] = grayAlpha[src + 1];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // ビット深度
  ihdr[9] = 4;  // 色の種類: 4 = グレースケール＋アルファ
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

  const pixelBounds = pixelBoundsFor(area, ZOOM);
  const { left, top, width, height } = pixelBounds;
  const tileLeft = Math.floor(left / 256);
  const tileRight = Math.floor((pixelBounds.right - 1) / 256);
  const tileTop = Math.floor(top / 256);
  const tileBottom = Math.floor((pixelBounds.bottom - 1) / 256);
  const tileCount = (tileRight - tileLeft + 1) * (tileBottom - tileTop + 1);

  console.log(`陰影起伏図（縮尺${ZOOM}）を取得中… ${width}×${height}px 相当`);

  // グレースケール＋アルファで直接持つ（RGBAのまま持つより半分で済む）
  const grayAlpha = new Uint8Array(width * height * 2);

  let done = 0;
  let hits = 0;
  for (let tileY = tileTop; tileY <= tileBottom; tileY++) {
    for (let tileX = tileLeft; tileX <= tileRight; tileX++) {
      const url = `https://cyberjapandata.gsi.go.jp/xyz/hillshademap/${ZOOM}/${tileX}/${tileY}.png`;
      const response = await fetch(url, { headers: USER_AGENT });
      done++;
      process.stdout.write(`\r  ${done}/${tileCount} タイル`);

      if (response.status === 404) continue; // 提供範囲外（海の沖側など）。透明のまま
      if (!response.ok) throw new Error(`HTTP ${response.status} : ${url}`);
      hits++;

      const buffer = Buffer.from(await response.arrayBuffer());
      const tile = decodePngRgba(buffer);

      const originX = tileX * 256 - left;
      const originY = tileY * 256 - top;
      for (let row = 0; row < tile.height; row++) {
        const globalY = originY + row;
        if (globalY < 0 || globalY >= height) continue;
        for (let col = 0; col < tile.width; col++) {
          const globalX = originX + col;
          if (globalX < 0 || globalX >= width) continue;

          const src = (row * tile.width + col) * 4;
          const dst = (globalY * width + globalX) * 2;
          grayAlpha[dst] = tile.data[src];       // R（R=G=Bのグレースケール）
          grayAlpha[dst + 1] = tile.data[src + 3]; // alpha
        }
      }
    }
  }
  console.log(`\n  ヒット: ${hits}/${tileCount} タイル`);

  let outGrayAlpha = grayAlpha;
  let outWidth = width;
  let outHeight = height;

  if (DOWNSAMPLE > 1) {
    outWidth = Math.floor(width / DOWNSAMPLE);
    outHeight = Math.floor(height / DOWNSAMPLE);
    outGrayAlpha = new Uint8Array(outWidth * outHeight * 2);

    for (let row = 0; row < outHeight; row++) {
      for (let col = 0; col < outWidth; col++) {
        let graySum = 0, weightSum = 0, alphaSum = 0, count = 0;
        for (let dy = 0; dy < DOWNSAMPLE; dy++) {
          for (let dx = 0; dx < DOWNSAMPLE; dx++) {
            const srcIndex = ((row * DOWNSAMPLE + dy) * width + (col * DOWNSAMPLE + dx)) * 2;
            const gray = grayAlpha[srcIndex];
            const alpha = grayAlpha[srcIndex + 1];
            // 透明（海）なマスは明暗の平均に混ぜない。にじみ防止。
            graySum += gray * alpha;
            weightSum += alpha;
            alphaSum += alpha;
            count++;
          }
        }
        const dst = (row * outWidth + col) * 2;
        outGrayAlpha[dst] = weightSum > 0 ? Math.round(graySum / weightSum) : 128;
        outGrayAlpha[dst + 1] = Math.round(alphaSum / count);
      }
    }
    console.log(`縮小: ${width}×${height} → ${outWidth}×${outHeight}（${DOWNSAMPLE}×${DOWNSAMPLE}平均）`);
  }

  const png = encodePngGrayAlpha(outGrayAlpha, outWidth, outHeight);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, png);

  console.log(`画像: ${outWidth} × ${outHeight}px`);
  console.log(`書き出し: ${OUT_PATH}（${(png.length / 1024 / 1024).toFixed(2)} MB）`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
