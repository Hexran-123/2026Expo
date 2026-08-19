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
 * data/source/board-elevation-grid.json が要る。無い場合は
 * node tools/fetch-elevation.js data/board/board-bounds.json data/source/board-elevation-grid.json
 * で取得すること。
 *
 * 使い方: node tools/build-board-mockup.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MOCKUP_DIR = path.join(ROOT, "ai/artifacts/絶景掲示板/mockups");
const TEMPLATE_PATH = path.join(MOCKUP_DIR, "board-map-variant-v4-template.html");
const OUT_PATH = path.join(MOCKUP_DIR, "board-map-variant-v4.html");

const terrain = JSON.parse(fs.readFileSync(path.join(ROOT, "data/board/terrain.json"), "utf8"));
const rail = JSON.parse(fs.readFileSync(path.join(ROOT, "data/board/rail-variants.json"), "utf8"));
const boardSpots = JSON.parse(fs.readFileSync(path.join(ROOT, "data/choshi/board-spots.json"), "utf8"));
const grid = JSON.parse(fs.readFileSync(path.join(ROOT, "data/source/board-elevation-grid.json"), "utf8"));

function elevationAt(lat, lon) {
  const { width, height, bounds } = grid;
  const col = Math.round(((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (width - 1));
  const row = Math.round(((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * (height - 1));
  if (col < 0 || col >= width || row < 0 || row >= height) return 0;
  const v = grid.values[row * width + col];
  return v === null || v === undefined ? 0 : v;
}

const { projection, bands } = terrain;
const Z_SCALE = 1.2;

// data/board/board-bounds.json と同じ投影範囲（tools/build-board-rail.js と共通）
const PROJ = { minLon: 140.77996730804443, maxLon: 140.88802814483643, maxLat: 35.77102915686017, minLat: 35.65896996652846 };
const MAP_W = 1000, MAP_H = 1268;

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
  const elevM = Math.min(elevationAt(s.lat, s.lon), maxBandElevation);
  return {
    id: s.id, name: s.name, u, v,
    z: Math.round(elevM * Z_SCALE * 10) / 10,
    photo: s.id, caption: s.caption,
    approximate: s.confidence === "approximate",
  };
});
console.log("spot elevations(m):", spotsJs.map(s => `${s.id}:${Math.round(s.z / Z_SCALE)}`).join(" "));

let tpl = fs.readFileSync(TEMPLATE_PATH, "utf8");
tpl = tpl.replace("__BAND_LAYERS__", bandLayers);
tpl = tpl.replace("__SPOTS_JS__", JSON.stringify(spotsJs));
tpl = tpl.replace("__RAIL_DATA__", JSON.stringify(rail));

// assets/choshi/board/<id>.webp を、mockups/ からの相対パスで参照する
const REL_ASSET_DIR = "../../../../assets/choshi/board";
for (const s of boardSpots.spots) {
  const placeholder = `"data:image/jpeg;base64,__B64_${s.id}__"`;
  tpl = tpl.split(placeholder).join(`"${REL_ASSET_DIR}/${s.id}.webp"`);
}

fs.writeFileSync(OUT_PATH, tpl);
console.log("saved:", path.relative(ROOT, OUT_PATH), `(${fs.statSync(OUT_PATH).size} bytes)`);
console.log("approximate confidence spots:", boardSpots.spots.filter(s => s.confidence === "approximate").map(s => s.id).join(", "));
