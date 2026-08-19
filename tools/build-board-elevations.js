/*
 * build-board-elevations.js
 *
 * 絶景掲示板の12スポットが立っている地面の高さ（国土地理院DEM）を1回だけ読み取り、
 * data/board/spot-elevations.json に焼き込む。
 *
 * なぜ焼き込むのか:
 *   もとになる格子 data/source/board-elevation-grid.json は 14.8MB あり、.gitignore
 *   してある（README「軽くするために入れてあるもの」と同じ理由）。そのため clone した
 *   ばかりの手元や GitHub Actions では格子が無く、tools/build-board-mockup.js が
 *   動かせない。必要なのは12点ぶんの数値だけなので、それだけを小さな JSON にして
 *   commit する。これで格子が無い環境でもプロトタイプを作り直せるようになり、
 *   tools/check-board-fresh.js（作り直し忘れの検査）が CI で走れる。
 *
 * 実行が要るのはこの2つのどちらかを直したときだけ:
 *   - data/choshi/board-spots.json の lat/lon（スポットの位置を直したとき）
 *   - data/source/board-elevation-grid.json（地図の範囲を変えて取り直したとき）
 *
 * 格子が無いときは取ってくること:
 *   node tools/fetch-elevation.js data/board/board-bounds.json data/source/board-elevation-grid.json
 *
 * 使い方: node tools/build-board-elevations.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const GRID_PATH = path.join(ROOT, "data/source/board-elevation-grid.json");
const SPOTS_PATH = path.join(ROOT, "data/choshi/board-spots.json");
const OUT_PATH = path.join(ROOT, "data/board/spot-elevations.json");

if (!fs.existsSync(GRID_PATH)) {
  console.error("標高の格子が無い: data/source/board-elevation-grid.json");
  console.error("");
  console.error("取ってくること:");
  console.error("  node tools/fetch-elevation.js data/board/board-bounds.json data/source/board-elevation-grid.json");
  process.exit(1);
}

const grid = JSON.parse(fs.readFileSync(GRID_PATH, "utf8"));
const boardSpots = JSON.parse(fs.readFileSync(SPOTS_PATH, "utf8"));

// tools/build-board-mockup.js が持っていたものと同じ読み取り方。格子の最寄りの1点を取る
function elevationAt(lat, lon) {
  const { width, height, bounds } = grid;
  const col = Math.round(((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (width - 1));
  const row = Math.round(((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * (height - 1));
  if (col < 0 || col >= width || row < 0 || row >= height) return 0;
  const v = grid.values[row * width + col];
  return v === null || v === undefined ? 0 : v;
}

const out = {
  _comment: [
    "絶景掲示板の12スポットの地面の高さ（メートル）。自動生成なので直接編集しない。",
    "作り直すとき: node tools/build-board-elevations.js",
    "",
    "lat/lon も一緒に持っているのは、data/choshi/board-spots.json の座標を直したのに",
    "この表を作り直し忘れたことを tools/build-board-mockup.js が気づけるようにするため。",
    "座標が食い違っていると、あちらが止まって作り直しを促す。",
    "",
    "地図に描く高さ（ピンのZ）はここでは決めない。段彩の頭打ち（45m）と誇張度（×1.2）と",
    "見やすさのための底上げ（+80）は build-board-mockup.js 側で足している。",
  ],
  source: grid.source || "国土地理院 DEM（data/source/board-elevation-grid.json）",
  gridGeneratedAt: grid.generatedAt || null,
  spots: boardSpots.spots.map(s => ({
    id: s.id,
    lat: s.lat,
    lon: s.lon,
    elevationM: elevationAt(s.lat, s.lon),
  })),
};

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
console.log("saved:", path.relative(ROOT, OUT_PATH));
for (const s of out.spots) console.log(`  ${s.id}: ${s.elevationM} m`);
