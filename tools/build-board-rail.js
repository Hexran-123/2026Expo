/*
 * build-board-rail.js
 *
 * 絶景掲示板（docs/絶景掲示板_設計メモ.md）のプロトタイプで使う、線路の高さ表現データを作る。
 * 駅の実測標高を国土地理院DEMからサンプルし、5通りの立体表現（階段状／坂2種／
 * 駅を通る曲線／平坦＋支柱）を作り分ける。比較・決定の経緯は
 * docs/adr/0005-絶景掲示板だけは斜め視点の立体地図にする.md を参照。
 *
 * 前準備（data/source/board-elevation-grid.json がまだ無い場合）:
 *   node tools/fetch-elevation.js data/board/board-bounds.json data/source/board-elevation-grid.json
 *
 * 使い方: node tools/build-board-rail.js
 * 出力: data/board/rail-variants.json
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const grid = JSON.parse(fs.readFileSync(path.join(ROOT, "data/source/board-elevation-grid.json"), "utf8"));
const route = JSON.parse(fs.readFileSync(path.join(ROOT, "data/choshi/route.json"), "utf8"));
const { width, height, bounds } = grid;

// board-prototype の投影（data/board/board-bounds.json の範囲に合わせた、掲示板専用の投影）
const PROJ = { minLon: 140.77996730804443, maxLon: 140.88802814483643, maxLat: 35.77102915686017, minLat: 35.65896996652846 };
const MAP_W = 1000, MAP_H = 1268;
const Z_SCALE = 1.2;
const PYLON_EXAGGERATION = 3.2;

function elevationAt(lat, lon) {
  const col = Math.round(((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (width - 1));
  const row = Math.round(((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * (height - 1));
  if (col < 0 || col >= width || row < 0 || row >= height) return null;
  const v = grid.values[row * width + col];
  return v === null || v === undefined ? null : v;
}
function project(lat, lon) {
  return [
    ((lon - PROJ.minLon) / (PROJ.maxLon - PROJ.minLon)) * MAP_W,
    ((PROJ.maxLat - lat) / (PROJ.maxLat - PROJ.minLat)) * MAP_H,
  ];
}
function smooth(vals, passes) {
  let a = vals.slice();
  for (let p = 0; p < passes; p++) {
    const b = a.slice();
    for (let i = 1; i < a.length - 1; i++) {
      if (a[i - 1] == null || a[i] == null || a[i + 1] == null) continue;
      b[i] = (a[i - 1] + a[i] * 2 + a[i + 1]) / 4;
    }
    a = b;
  }
  return a;
}
function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

// ---- 松岸（JR、路線外の点線区間の終点） ----
const MATSU = { name: "松岸", lat: 35.7395583, lon: 140.7952579, offLine: true };

// ---- オンライン区間（銚子〜外川）の標高サンプリング ----
const trackPts = route.track.map(([lat, lon]) => {
  const [x, y] = project(lat, lon);
  return { lat, lon, x, y, elev: elevationAt(lat, lon) };
});
const smoothed1 = smooth(trackPts.map(p => p.elev), 2);
const smoothed2 = smooth(trackPts.map(p => p.elev), 10);
trackPts.forEach((p, i) => { p.elevSmooth = smoothed1[i] != null ? smoothed1[i] : p.elev; });

function nearestTrackIndex(lat, lon) {
  let best = 0, bestD = Infinity;
  trackPts.forEach((p, i) => {
    const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}
const stations = route.stations.map(s => {
  const [x, y] = project(s.lat, s.lon);
  const idx = nearestTrackIndex(s.lat, s.lon);
  return { name: s.name, lat: s.lat, lon: s.lon, x, y, trackIndex: idx, elev: Math.round(trackPts[idx].elevSmooth * 10) / 10 };
});

// ---- オフライン区間（銚子〜松岸、点線） ----
const chosi = route.stations[0];
const offlinePts = [];
for (let i = 0; i <= 10; i++) {
  const t = i / 10;
  const lat = chosi.lat + (MATSU.lat - chosi.lat) * t;
  const lon = chosi.lon + (MATSU.lon - chosi.lon) * t;
  const [x, y] = project(lat, lon);
  offlinePts.push({ x, y, elev: elevationAt(lat, lon) });
}
const offlineSmoothed = smooth(offlinePts.map(p => p.elev), 2);
offlinePts.forEach((p, i) => { p.elevSmooth = offlineSmoothed[i] != null ? offlineSmoothed[i] : p.elev; });
const offlineZ = Math.round(avg(offlinePts.map(p => p.elevSmooth)) * Z_SCALE * 10) / 10;

// ---- Variant A: 階段状（駅間ごとに1段） ----
const idxs = stations.map(s => s.trackIndex);
const stepped = [];
for (let i = 0; i < idxs.length - 1; i++) {
  const slice = trackPts.slice(idxs[i], idxs[i + 1] + 1);
  const z = avg(slice.map(p => p.elevSmooth)) * Z_SCALE;
  stepped.push({ pts: slice.map(p => [p.x, p.y]), z: Math.round(z * 10) / 10, fromStation: stations[i].name, toStation: stations[i + 1].name });
}

// ---- Variant B: なだらかな坂（隣接2点を3D空間で直接つなぐランプ） ----
function toRampPts(elevs) {
  return trackPts.map((p, i) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(elevs[i] * Z_SCALE * 10) / 10]);
}
const smoothPts1 = toRampPts(smoothed1);
const smoothPts2 = toRampPts(smoothed2);

// ---- Variant B-3: 駅の実測標高だけを通る曲線（Catmull-Rom） ----
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function splineThroughStations(key) {
  const ctrl = stations.map(s => s[key]);
  const pad = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
  const out = [];
  const STEPS = 14;
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = pad[i], p1 = pad[i + 1], p2 = pad[i + 2], p3 = pad[i + 3];
    const steps = i === ctrl.length - 2 ? STEPS + 1 : STEPS;
    for (let s = 0; s < steps; s++) out.push(catmullRom(p0, p1, p2, p3, s / STEPS));
  }
  return out;
}
const splineX = splineThroughStations("x");
const splineY = splineThroughStations("y");
const splineElev = splineThroughStations("elev");
const smoothPts3 = splineX.map((x, i) => [
  Math.round(x * 10) / 10, Math.round(splineY[i] * 10) / 10, Math.round(splineElev[i] * Z_SCALE * 10) / 10,
]);

// ---- Variant C: 平坦＋支柱（駅だけ高さを示す。誇張率は表現方式だけの調整） ----
const overallZ = avg(trackPts.map(p => p.elevSmooth)) * Z_SCALE;
const pylons = {
  railZ: Math.round(overallZ * 10) / 10,
  pts: trackPts.map(p => [p.x, p.y]),
  stations: stations.map(s => {
    const rawZ = s.elev * Z_SCALE;
    const exaggeratedZ = overallZ + (rawZ - overallZ) * PYLON_EXAGGERATION;
    return { name: s.name, x: s.x, y: s.y, elevZ: Math.round(exaggeratedZ * 10) / 10, elevM: s.elev };
  }),
};

// ---- 駅の点＋ラベル ----
const stationAnchors = stations.map(s => {
  const realZ = Math.round(s.elev * Z_SCALE * 10) / 10;
  const pylonStation = pylons.stations.find(p => p.name === s.name);
  return { name: s.name, x: s.x, y: s.y, offLine: false, z: { stepped: realZ, smooth1: realZ, smooth2: realZ, smooth3: realZ, pylons: pylonStation.elevZ } };
});
const [matsuX, matsuY] = project(MATSU.lat, MATSU.lon);
stationAnchors.push({ name: MATSU.name, x: matsuX, y: matsuY, offLine: true, z: { stepped: offlineZ, smooth1: offlineZ, smooth2: offlineZ, smooth3: offlineZ, pylons: offlineZ } });

const offline = { pts: offlinePts.map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]), z: offlineZ };

fs.writeFileSync(path.join(ROOT, "data/board/rail-variants.json"), JSON.stringify({
  stepped, smoothPts1, smoothPts2, smoothPts3, pylons, offline, stationAnchors, topZ: 45 * Z_SCALE,
}, null, 1));
console.log("stepped segments:", stepped.length);
console.log("smooth1/2/3 points:", smoothPts1.length, smoothPts2.length, smoothPts3.length);
console.log("stations:", stations.map(s => `${s.name}: ${s.elev}m`).join(", "));
console.log("saved: data/board/rail-variants.json");
