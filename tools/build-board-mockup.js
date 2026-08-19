/*
 * build-board-mockup.js
 *
 * 絶景掲示板のプロトタイプ（ai/artifacts/絶景掲示板/mockups/board-map-variant-v4-template.html）
 * に、地形・線路・スポットの実データを埋め込んで、ブラウザでそのまま開ける
 * board-map-variant-v4.html を作る。
 *
 * データを直したら（data/choshi/board-spots.json、data/board/*.json）、このスクリプトを
 * 実行し直すこと。写真は data/ ではなく assets/choshi/board/<id>.webp をローカルパスで
 * 参照する（銚子市観光協会フォトダウンロード利用規約により直リンク禁止・ローカル保存必須のため。
 * CLAUDE.md 参照）。
 *
 * ピンの高さはスポットごとの実測標高（国土地理院DEM）を使う。地形に浮いて見えないよう、
 * 地図に直接刺さっているように見せるための対応（2026-08-19、FBを受けて）。
 * 標高そのものは data/board/spot-elevations.json（12点ぶんだけを焼き込んだ小さな表）から読む。
 * 14.8MB の格子 data/source/board-elevation-grid.json はここでは要らない。clone したばかりの
 * 手元や GitHub Actions でも、このスクリプトだけで作り直せるようにするため
 * （tools/build-board-elevations.js のコメント参照）。
 *
 * 使い方: node tools/build-board-mockup.js [出力先]
 *   出力先を省くと ai/artifacts/絶景掲示板/mockups/board-map-variant-v4.html に書く。
 *   tools/check-board-fresh.js は一時ファイルを指定して呼ぶ。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MOCKUP_DIR = path.join(ROOT, "ai/artifacts/絶景掲示板/mockups");
const TEMPLATE_PATH = path.join(MOCKUP_DIR, "board-map-variant-v4-template.html");
const OUT_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(MOCKUP_DIR, "board-map-variant-v4.html");

const terrain = JSON.parse(fs.readFileSync(path.join(ROOT, "data/board/terrain.json"), "utf8"));
const rail = JSON.parse(fs.readFileSync(path.join(ROOT, "data/board/rail-variants.json"), "utf8"));
const boardSpots = JSON.parse(fs.readFileSync(path.join(ROOT, "data/choshi/board-spots.json"), "utf8"));
const elevTable = JSON.parse(fs.readFileSync(path.join(ROOT, "data/board/spot-elevations.json"), "utf8"));

// board-spots.json の座標を直したのに標高の表を作り直し忘れると、ピンが前の場所の
// 地面の高さのまま描かれてしまう。黙って通さず、ここで止めて作り直しを促す。
const byId = new Map(elevTable.spots.map(e => [e.id, e]));
function elevationAt(spot) {
  const e = byId.get(spot.id);
  const stale =
    !e ||
    Math.abs(e.lat - spot.lat) > 1e-7 ||
    Math.abs(e.lon - spot.lon) > 1e-7;
  if (stale) {
    console.error(`data/board/spot-elevations.json が data/choshi/board-spots.json と合っていない（${spot.id}）。`);
    console.error("");
    console.error("作り直すこと:");
    console.error("  node tools/build-board-elevations.js");
    process.exit(1);
  }
  return e.elevationM;
}

const { projection, bands } = terrain;
const Z_SCALE = 1.2;

// data/board/board-bounds.json と同じ投影範囲（tools/build-board-rail.js と共通）
const PROJ = { minLon: 140.77996730804443, maxLon: 140.88802814483643, maxLat: 35.77102915686017, minLat: 35.65896996652846 };

function toUV(lat, lon) {
  return {
    u: (lon - PROJ.minLon) / (PROJ.maxLon - PROJ.minLon),
    v: (PROJ.maxLat - lat) / (PROJ.maxLat - PROJ.minLat),
  };
}

const bandLayers = bands.map(b => {
  const z = (b.minElevation * Z_SCALE).toFixed(1);
  return `<div class="band-layer" style="transform: translateZ(${z}px)">
    <svg viewBox="0 0 ${projection.width} ${projection.height}">
      <path d="${b.path}" fill-rule="evenodd" class="band--${b.minElevation}"></path>
      <path d="${b.path}" fill-rule="evenodd" class="rim"></path>
    </svg>
  </div>`;
}).join("\n");

// 地形の段彩は45m以上をひとまとめの最上段として描いている（bands参照）。実測標高が
// それを超える場所（chikyuの愛宕山など）でピンをそのまま置くと、描かれている地面より
// 高い位置に浮いて見えるため、最上段の高さで頭打ちにする。
const maxBandElevation = Math.max(...bands.map(b => b.minElevation));

const spotsJs = boardSpots.spots.map(s => {
  const { u, v } = toUV(s.lat, s.lon);
  const elevM = Math.min(elevationAt(s), maxBandElevation);
  return {
    id: s.id, name: s.name, u, v,
    z: Math.round(elevM * Z_SCALE * 10) / 10,
    photo: s.id, caption: s.caption,
    approximate: s.confidence === "approximate",
    // 実際に集まった数ではなく見本の数。board-spots.json の _comment 参照
    likes: s.sampleLikes,
  };
});
console.log("spot elevations(m):", spotsJs.map(s => `${s.id}:${Math.round(s.z / Z_SCALE)}`).join(" "));

let tpl = fs.readFileSync(TEMPLATE_PATH, "utf8");

/*
 * 差し込みは split/join で行う。String.replace に文字列を渡すと、置換する側の
 * "$&" や "$`" が特別な意味を持ってしまい、説明文にたまたま $ が入った日に
 * 静かに壊れた HTML が出る。
 * 目印が見つからなかったときも止める——見つからなくても replace は何も言わずに
 * 通してしまい、出来上がるのは中身の入っていない壊れた頁になる。それが
 * commit されると check-board-fresh.js も「同じ壊れ方」を最新と判定してしまう。
 */
function fill(placeholder, value) {
  if (!tpl.includes(placeholder)) {
    console.error(`テンプレートに ${placeholder} が見つからない。`);
    console.error("board-map-variant-v4-template.html の目印を消していないか確かめること。");
    process.exit(1);
  }
  tpl = tpl.split(placeholder).join(value);
}

fill("__BAND_LAYERS__", bandLayers);
fill("__SPOTS_JS__", JSON.stringify(spotsJs));
fill("__RAIL_DATA__", JSON.stringify(rail));

// assets/choshi/board/<id>.webp を、mockups/ からの相対パスで参照する
const REL_ASSET_DIR = "../../../../assets/choshi/board";
const ASSET_DIR = path.join(ROOT, "assets/choshi/board");
for (const s of boardSpots.spots) {
  // 写真が無いまま組み上げると、画面には壊れた画像が並ぶだけで誰も気づかない
  const file = path.join(ASSET_DIR, `${s.id}.webp`);
  if (!fs.existsSync(file)) {
    console.error(`写真が無い: assets/choshi/board/${s.id}.webp`);
    console.error("元の画像を長辺1200px・品質82のWebPに変換して置くこと（設計メモ2章）。");
    process.exit(1);
  }
  fill(`"data:image/jpeg;base64,__B64_${s.id}__"`, `"${REL_ASSET_DIR}/${s.id}.webp"`);
}

fs.writeFileSync(OUT_PATH, tpl);
console.log("saved:", path.relative(ROOT, OUT_PATH), `(${fs.statSync(OUT_PATH).size} bytes)`);
console.log("approximate confidence spots:", boardSpots.spots.filter(s => s.confidence === "approximate").map(s => s.id).join(", "));
