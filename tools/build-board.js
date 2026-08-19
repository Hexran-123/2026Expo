/*
 * build-board.js
 *
 * 絶景掲示板の本体 board.html を作る。tools/board-template.html に、地形・線路・
 * 掲示スポット・乗客から届いた写真の実データを埋め込むだけのスクリプト。
 *
 * データを直したら（data/choshi/board-spots.json、data/choshi/board-posts.json、
 * data/board/*.json）、これを実行し直すこと。**board.html は生成物なので直接編集しない。**
 * 直すのは tools/board-template.html のほう。作り直し忘れは tools/check-board-fresh.js
 * （pre-commit フックと GitHub Actions からも走る）が拾う。
 *
 * 写真は data/ ではなく assets/choshi/board/ 配下をローカルパスで参照する
 * （銚子市観光協会フォトダウンロード利用規約により直リンク禁止・ローカル保存必須のため。
 * CLAUDE.md 参照）。乗客から届いた写真は assets/choshi/board/posts/ 配下に置く
 * （tools/publish-posts.js が置く）。
 *
 * ピンの高さはスポットごとの実測標高（国土地理院DEM）を使う。地形に浮いて見えないよう、
 * 地図に直接刺さっているように見せるための対応（2026-08-19、FBを受けて）。
 * 標高そのものは data/board/spot-elevations.json（掲示スポットのぶんだけを焼き込んだ
 * 小さな表）から読む。40MB の格子 data/source/board-elevation-grid.json はここでは
 * 要らない。clone したばかりの手元や GitHub Actions でも、このスクリプトだけで
 * 作り直せるようにするため（tools/build-board-elevations.js のコメント参照）。
 *
 * 公式写真を持たない掲示スポット（photo が null）は、**乗客から届いた写真が1枚も
 * 無いあいだは地図に出さない**。空のピンが並ぶより、まだ何も無いことが伝わるほうがよい。
 *
 * 使い方: node tools/build-board.js [出力先]
 *   出力先を省くと board.html に書く。tools/check-board-fresh.js は一時ファイルを
 *   指定して呼ぶ。写真への相対パスは、出力先の場所から計算する。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TEMPLATE_PATH = path.join(ROOT, "tools/board-template.html");
const OUT_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "board.html");

const terrain = JSON.parse(fs.readFileSync(path.join(ROOT, "data/board/terrain.json"), "utf8"));
const rail = JSON.parse(fs.readFileSync(path.join(ROOT, "data/board/rail-variants.json"), "utf8"));
const boardSpots = JSON.parse(fs.readFileSync(path.join(ROOT, "data/choshi/board-spots.json"), "utf8"));
const elevTable = JSON.parse(fs.readFileSync(path.join(ROOT, "data/board/spot-elevations.json"), "utf8"));
const boardPosts = JSON.parse(fs.readFileSync(path.join(ROOT, "data/choshi/board-posts.json"), "utf8"));

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
function toZ(elevM) {
  return Math.round(Math.min(elevM, maxBandElevation) * Z_SCALE * 10) / 10;
}

// ------------------------------------------------------------------
// 写真の置き場
//
// 出力先から見た相対パスにする。board.html（リポジトリ直下）と、
// check-board-fresh.js が使う一時ファイルとで、深さが違うため。
// ------------------------------------------------------------------
const ASSET_DIR = path.join(ROOT, "assets/choshi/board");
const relAssetDir = path
  .relative(path.dirname(OUT_PATH), ASSET_DIR)
  .split(path.sep).join("/") || ".";

/** id → 画像への相対パス。公式写真も乗客の写真もここに集める */
const photos = {};

for (const s of boardSpots.spots) {
  if (!s.photo) continue;   // 公式写真を持たない掲示スポット
  // 写真が無いまま組み上げると、画面には壊れた画像が並ぶだけで誰も気づかない
  const file = path.join(ASSET_DIR, `${s.id}.webp`);
  if (!fs.existsSync(file)) {
    console.error(`写真が無い: assets/choshi/board/${s.id}.webp`);
    console.error("元の画像を長辺1200px・品質82のWebPに変換して置くこと（設計メモ2章）。");
    process.exit(1);
  }
  photos[s.id] = `${relAssetDir}/${s.id}.webp`;
}

// ------------------------------------------------------------------
// 乗客から届いた写真（審査を通ったものだけがこの表に載る）
// ------------------------------------------------------------------
const postsBySpot = new Map();
const postsJs = [];

for (const post of boardPosts.posts) {
  const file = path.join(ROOT, "assets/choshi/board/posts", post.file);
  if (!fs.existsSync(file)) {
    console.error(`乗客の写真が無い: assets/choshi/board/posts/${post.file}`);
    console.error("tools/publish-posts.js が置くはずのファイル。表だけ先に足していないか確かめること。");
    process.exit(1);
  }
  photos[post.id] = `${relAssetDir}/posts/${post.file}`;

  const entry = { id: post.id, spotId: post.spotId || null, publishedAt: post.publishedAt };
  if (!post.spotId) {
    // 掲示スポットに紐づかない写真は、自分の座標で1本のピンになる
    const { u, v } = toUV(post.lat, post.lon);
    Object.assign(entry, { u, v, z: toZ(post.elevationM || 0) });
  }
  postsJs.push(entry);

  if (post.spotId) {
    if (!postsBySpot.has(post.spotId)) postsBySpot.set(post.spotId, []);
    postsBySpot.get(post.spotId).push(post.id);
  }
}

// 表に載っている掲示先が実在するか。id を打ち間違えると、写真が黙って消える
const spotIds = new Set(boardSpots.spots.map(s => s.id));
for (const spotId of postsBySpot.keys()) {
  if (spotIds.has(spotId)) continue;
  console.error(`board-posts.json の spotId「${spotId}」が board-spots.json に無い。`);
  process.exit(1);
}

const spotsJs = boardSpots.spots
  // 公式写真も乗客の写真も無いスポットは、地図に出さない
  .filter(s => s.photo || postsBySpot.has(s.id))
  .map(s => {
    const { u, v } = toUV(s.lat, s.lon);
    return {
      id: s.id, name: s.name, u, v,
      z: toZ(elevationAt(s)),
      photo: s.photo ? s.id : null,
      caption: s.caption,
      approximate: s.confidence === "approximate",
      posts: postsBySpot.get(s.id) || [],
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
    console.error("tools/board-template.html の目印を消していないか確かめること。");
    process.exit(1);
  }
  tpl = tpl.split(placeholder).join(value);
}

fill("__BAND_LAYERS__", bandLayers);
fill("__PHOTOS_JS__", JSON.stringify(photos));
fill("__SPOTS_JS__", JSON.stringify(spotsJs));
fill("__USER_POSTS_JS__", JSON.stringify(postsJs));
fill("__PROJ_JS__", JSON.stringify(PROJ));
fill("__RAIL_DATA__", JSON.stringify(rail));

fs.writeFileSync(OUT_PATH, tpl);
console.log("saved:", path.relative(ROOT, OUT_PATH), `(${fs.statSync(OUT_PATH).size} bytes)`);
console.log("posts:", postsJs.length, "/ spots on map:", spotsJs.length);
console.log("approximate confidence spots:", boardSpots.spots.filter(s => s.confidence === "approximate").map(s => s.id).join(", "));
