/*
 * build-timeline-geometry.js
 *
 * 絶景掲示板の時間軸で使う「昔の崖線」を計算して data/board/timeline-geometry.json に書く。
 *
 * **なぜスクリプトにするのか。**
 * 1923年の屏風ヶ浦の崖線を手で描いてしまうと、「なぜその形なのか」に誰も答えられなくなる。
 * 審査でも展示でも必ず聞かれるところなので、推定の作り方そのものをリポジトリに残す。
 * 出典と数値は docs/時間軸_裏取り記録.md 4章にある。
 *
 * ---------------------------------------------------------------
 * 推定の考え方（吉村ほか 2023・千葉県立中央博物館研究報告 16(2):73-87）
 * ---------------------------------------------------------------
 *
 *  - 消波堤が入る前、屏風ヶ浦の崖は**年間1m近い速さで後退**していた。
 *    しかも「凹凸の少ない崖は平行後退する」ので、崖の上端も崖脚と同じだけ下がる。
 *    → 崖線をまるごと沖へ戻す、という単純な計算でよい。
 *  - 消波堤は1960年代以降、両端から順に据えられた。論文が調べた三崎町のあたりは
 *    1979〜1989年である。据えたあとの崖端の後退は 0.1〜0.4 m/年（同論文 表2）。
 *
 * そこで次の2区切りで戻す。
 *
 *    1923年 → 1981年度（58年）  1.0 m/年   … 消波堤の前
 *    1981年度 → 現在（45年）    0.25 m/年  … 0.1〜0.4 の真ん中を採る
 *
 * 結果として 1923年の崖線は現在より **約69m 沖**、1981年度は **約11m 沖** になる。
 *
 * **この地図の縮尺では 9.8m がおよそ1px** なので、1923年でも7px ほどしか動かない。
 * それでよい。誇張して描けば嘘になる。**動かないこと自体が結論**でもある——
 * 1981年度と現在の差が1pxしかないのは、消波堤が後退を止めたからである。
 * 数字（何メートル動いたか）は右パネルの文章のほうで伝える。
 *
 * ---------------------------------------------------------------
 * どの線を「崖線」とするか
 * ---------------------------------------------------------------
 *
 * 地図に描くのは崖の**上端**（台地の縁）なので、標高32mの段彩の縁を使う。
 * この窓での各段彩の縁は数pxの中に重なっていて（0m/8m/16m/32mが x≈106 で
 * y=725/716.6/…/713.7）、崖がほぼ垂直に立っていることをそのまま示している。
 * 32mを選んだのは、上端にいちばん近くて、かつ切れ目なく続いているため。
 *
 * 使い方: node tools/build-timeline-geometry.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TERRAIN = path.join(ROOT, "data/board/terrain.json");
const OUT = path.join(ROOT, "data/board/timeline-geometry.json");

const terrain = JSON.parse(fs.readFileSync(TERRAIN, "utf8"));
const B = terrain.projection.bounds;
const W = terrain.projection.width;   // 1000
const H = terrain.projection.height;  // 1268

/** 崖線に使う段彩（メートル）。上の長いコメント参照 */
const CLIFF_BAND = 32;
const Z_SCALE = 1.2;   // build-board.js と同じ。変えたら両方直すこと

/**
 * 屏風ヶ浦の東端（名洗のあたり）より西だけを崖線とする。
 * 東側は外川・犬岩へ続く別の海岸なので、混ぜない。
 * x=340 は経度 140.8167 にあたる。
 */
const EAST_LIMIT_X = 340;

/**
 * 北の窓。これを入れないと、同じ「x が小さくて y が増える」条件に当てはまる
 * **利根川側の北岸**（y≈535 あたり）を拾ってしまう（実際に一度そうなった）。
 * y=620 は緯度 35.716 にあたり、屏風ヶ浦（35.704〜35.713）より少し北にとってある。
 */
const NORTH_LIMIT_Y = 620;

/** 1px が何メートルか。緯度35.7度での経度1度の長さから出す */
const M_PER_DEG_LON = 111320 * Math.cos(35.7 * Math.PI / 180);
const M_PER_PX = ((B.maxLon - B.minLon) * M_PER_DEG_LON) / W;

/** 現在からさかのぼる後退量（メートル）。上のコメントの2区切りをそのまま書く */
const RETREAT = [
  { from: "ynow", to: "y1981", years: 45, rate: 0.25, note: "消波堤の設置が進んだあと（0.1〜0.4m/年の中間）" },
  { from: "y1981", to: "y1923", years: 58, rate: 1.0, note: "消波堤の前。波が直接崖脚を叩いていた" },
];

// ------------------------------------------------------------------
// 段彩のパスから、屏風ヶ浦の海岸線だけを取り出す
// ------------------------------------------------------------------

function parseSubpaths(d) {
  return d.split("M").filter(Boolean).map(sub =>
    sub.replace(/Z\s*$/, "")
      .split("L")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.split(",").map(Number))
      .filter(p => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
  );
}

const band = terrain.bands.find(b => b.minElevation === CLIFF_BAND);
if (!band) {
  console.error(`標高 ${CLIFF_BAND}m の段彩が data/board/terrain.json に無い。`);
  console.error("地形を作り直したときに段彩の刻みが変わった可能性がある（tools/build-terrain.js）。");
  process.exit(1);
}

const subpaths = parseSubpaths(band.path);
const main = subpaths.reduce((a, b) => (a.length > b.length ? a : b));

/*
 * 屏風ヶ浦は地図の南西の海岸で、東から西へ向かって y（南）が増えていく。
 * 窓（x <= EAST_LIMIT_X）に入っている点のうち、**y が増え続ける区間**を取る。
 * こうしないと、地図の西端で北へ折り返す枠の線（海岸ではない）まで拾ってしまう。
 */
function extractCoast(pts) {
  let best = [];
  let run = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const inWindow = p[0] <= EAST_LIMIT_X && p[1] >= NORTH_LIMIT_Y;
    const goingSW = run.length === 0 || p[1] > run[run.length - 1][1];
    if (inWindow && goingSW) {
      run.push(p);
    } else {
      if (run.length > best.length) best = run;
      run = inWindow ? [p] : [];
    }
  }
  if (run.length > best.length) best = run;
  return best;
}

const coast = extractCoast(main);
if (coast.length < 5) {
  console.error("屏風ヶ浦の海岸線を取り出せなかった（点が少なすぎる）。");
  console.error(`段彩 ${CLIFF_BAND}m・窓 x<=${EAST_LIMIT_X} で見つかったのは ${coast.length} 点。`);
  console.error("地形データか EAST_LIMIT_X を見直すこと。");
  process.exit(1);
}

// ------------------------------------------------------------------
// 沖へ押し出す
// ------------------------------------------------------------------

/*
 * 海はどちら側か。海岸は東から西（x が減る方向）へ辿っていて、陸は北（y が小さいほう）に
 * ある。進行方向 d=(dx,dy) に対し、(dy, -dx) が南東＝海を向く。
 * 端の点は隣の1本ぶんの向きをそのまま使う。
 */
function seawardNormals(pts) {
  const n = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    n.push([dy / len, -dx / len]);
  }
  return n;
}

const normals = seawardNormals(coast);

function offsetBy(metres) {
  const px = metres / M_PER_PX;
  return coast.map((p, i) => [
    +(p[0] + normals[i][0] * px).toFixed(2),
    +(p[1] + normals[i][1] * px).toFixed(2),
  ]);
}

function toPath(pts) {
  return "M" + pts.map(p => p[0] + "," + p[1]).join(" L");
}

// 現在を 0 として、さかのぼった量を積み上げる
let cumulative = 0;
const offsets = { ynow: 0 };
for (const step of RETREAT) {
  cumulative += step.years * step.rate;
  offsets[step.to] = Math.round(cumulative);
}

const cliff = {};
for (const [pointId, metres] of Object.entries(offsets)) {
  cliff[pointId] = {
    offsetMetres: metres,
    offsetPx: +(metres / M_PER_PX).toFixed(2),
    confidence: metres === 0 ? "exact" : "estimated",
    path: toPath(offsetBy(metres)),
  };
}

const out = {
  _comment: [
    "絶景掲示板の時間軸で使う、昔の屏風ヶ浦の崖線。**自動生成なので直接編集しない。**",
    "作り直すとき: node tools/build-timeline-geometry.js",
    "",
    "現在の崖線は data/board/terrain.json の標高32m段彩の縁をそのまま使い、",
    "過去の分はそれを沖へ押し出して求めている。押し出す量の根拠は",
    "docs/時間軸_裏取り記録.md 4章と tools/build-timeline-geometry.js の冒頭コメント。",
    "",
    "**現在（ynow）以外は推定である。** 画面では破線で描き、「推定」と名乗ること。",
  ],
  generatedAt: new Date().toISOString().slice(0, 10),
  source: {
    terrain: "data/board/terrain.json（標高32mの段彩の縁）",
    retreatRates: "吉村光敏・八木令子・小田島高之 (2023) 千葉県立中央博物館研究報告 16(2):73-87",
  },
  model: {
    cliffBandElevation: CLIFF_BAND,
    metresPerPixel: +M_PER_PX.toFixed(3),
    steps: RETREAT,
    note: "1923年の崖線は現在よりおよそ69m沖、1981年度はおよそ11m沖。この地図では9.8mが1pxなので、見た目には7pxと1pxしか違わない。誇張しないこと。",
  },
  cliffPointCount: coast.length,
  cliffZ: +(CLIFF_BAND * Z_SCALE + 0.6).toFixed(1),
  cliff,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log(`書き出し: ${path.relative(ROOT, OUT)}`);
console.log(`  崖線の点: ${coast.length}`);
console.log(`  1px = ${M_PER_PX.toFixed(2)} m`);
for (const [id, c] of Object.entries(cliff)) {
  console.log(`  ${id.padEnd(6)} 沖へ ${String(c.offsetMetres).padStart(3)} m (${c.offsetPx} px) ${c.confidence}`);
}
