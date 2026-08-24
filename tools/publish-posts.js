/*
 * publish-posts.js
 *
 * 審査を通った写真を、絶景掲示板に掲示するところまで運ぶ当番の道具（ADR-0004）。
 *
 *   1. サーバーから「通ったが、まだ掲示していない」写真を受け取る
 *   2. assets/choshi/board/posts/<id>.webp（または .jpg）として置く
 *   3. data/choshi/board-posts.json に1行足す
 *   4. サーバーに「掲示した」と伝える（サーバー側の写真の中身はここで消える）
 *   5. board.html を作り直す
 *
 * このあと git add / commit / push まで済ませて、はじめて公開される。
 * **公開されるのはリポジトリに置いたファイルのほうで、サーバーではない。**
 * サーバーは受け口と審査のためだけに使い、掲示が済んだら中身を持たない。
 *
 * 使い方:
 *   REVIEW_PASS='（パスポート）' node tools/publish-posts.js
 *   node tools/publish-posts.js '（パスポート）'      ← 手元だけで使うとき
 *
 * パスポートは審査の頁（review.html）と同じもの。履歴に残したくなければ環境変数で渡す。
 *
 * 保存期限: 掲示した写真は 2027年4月30日にすべて消す。ファイルを消すだけでは
 * git の履歴に残るので、そのときは履歴ごと書き換える。手順は
 * docs/投稿写真の手放し方.md にある。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const POSTS_PATH = path.join(ROOT, "data/choshi/board-posts.json");
const SPOTS_PATH = path.join(ROOT, "data/choshi/board-spots.json");
const GRID_PATH = path.join(ROOT, "data/source/board-elevation-grid.json");
const OUT_DIR = path.join(ROOT, "assets/choshi/board/posts");

const pass = process.env.REVIEW_PASS || process.argv[2];
if (!pass) {
  console.error("パスポートが要る。");
  console.error("  REVIEW_PASS='...' node tools/publish-posts.js");
  process.exit(1);
}

// 宛先と鍵は js/popularity.js が持っている。二か所に書き写さない
const popularity = fs.readFileSync(path.join(ROOT, "js/popularity.js"), "utf8");
function pick(name) {
  // 鍵は行をまたいで + でつないである。文字列の中身だけを拾って戻す
  const found = popularity.match(new RegExp(`const ${name} =([\\s\\S]*?);`));
  if (!found) {
    console.error(`js/popularity.js から ${name} を読めなかった。`);
    process.exit(1);
  }
  return (found[1].match(/'([^']*)'/g) || []).map(s => s.slice(1, -1)).join("");
}
const ENDPOINT = pick("ENDPOINT");
const ANON_KEY = pick("ANON_KEY");

async function call(name, body) {
  const response = await fetch(`${ENDPOINT}/rpc/${name}`, {
    method: "POST",
    headers: {
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${name}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/*
 * 掲示先を決める。
 *
 * 車窓絶景ナビから来たものは、撮ったときの絶景スポット（S01〜S06）を持っている。
 * board-spots.json の naviSpotId がその対応で、片方を直したらもう片方も
 * 確かめること（ADR-0005）。対応が無い id が来たら、黙って地図から消える
 * より止まったほうがよい。
 */
function boardSpotFor(spotId, spots) {
  const found = spots.find(s => s.naviSpotId === spotId);
  if (!found) {
    // ここで process.exit() すると、直前の fetch が握っている接続が
    // 開いたままの状態で強制終了することになり、Windows では
    // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" という
    // Node 側のクラッシュ表示が出ることがある（実害はないが分かりにくい）。
    // throw して一番下の catch に運び、そちらで穏やかに終える。
    throw new Error(
      `掲示先が分からない絶景スポット: ${spotId}
`
      + "data/choshi/board-spots.json に naviSpotId を足すこと。"
    );
  }
  return found.id;
}

/** 地面の高さ（tools/build-board-elevations.js と同じ読み取り方） */
function elevationAt(lat, lon) {
  if (!fs.existsSync(GRID_PATH)) return 0;
  const grid = JSON.parse(fs.readFileSync(GRID_PATH, "utf8"));
  const { width, height, bounds } = grid;
  const col = Math.round(((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (width - 1));
  const row = Math.round(((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * (height - 1));
  if (col < 0 || col >= width || row < 0 || row >= height) return 0;
  const value = grid.values[row * width + col];
  return value === null || value === undefined ? 0 : value;
}

(async () => {
  const queue = await call("review_publish_queue", { p_pass: pass });
  if (queue.length === 0) {
    console.log("掲示するものはありません。");
    return;
  }
  console.log(`掲示待ち: ${queue.length} 件`);

  const spots = JSON.parse(fs.readFileSync(SPOTS_PATH, "utf8")).spots;
  const posts = JSON.parse(fs.readFileSync(POSTS_PATH, "utf8"));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  let published = 0;

  for (const row of queue) {
    if (posts.posts.some(p => p.id === row.id)) {
      console.log(`  すでに表にある: ${row.id}`);
      continue;
    }

    const extension = row.mime === "image/webp" ? "webp" : "jpg";
    const file = `${row.id}.${extension}`;
    fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(row.content, "base64"));

    const entry = { id: row.id, file, publishedAt: today };
    let boardSpotId = null;

    if (row.source === "navi") {
      boardSpotId = boardSpotFor(row.spot_id, spots);
      entry.spotId = boardSpotId;
    } else {
      entry.lat = row.lat;
      entry.lon = row.lon;
      entry.elevationM = elevationAt(row.lat, row.lon);
    }

    posts.posts.push(entry);

    // サーバー側の写真の中身は、ここで消える
    await call("review_mark_published", {
      p_pass: pass, p_id: row.id, p_board_spot_id: boardSpotId,
    });

    published += 1;
    console.log(`  置いた: assets/choshi/board/posts/${file}`
      + (boardSpotId ? ` → ${boardSpotId}` : ` → 北緯 ${row.lat.toFixed(5)} 東経 ${row.lon.toFixed(5)}`));
  }

  fs.writeFileSync(POSTS_PATH, JSON.stringify(posts, null, 2) + "\n");
  console.log(`data/choshi/board-posts.json を更新（掲示 ${published} 件）`);

  execFileSync(process.execPath, [path.join(ROOT, "tools/build-board.js")], {
    cwd: ROOT, stdio: "inherit",
  });

  console.log("");
  console.log("できあがり。あとは commit して push すれば掲示されます:");
  console.log("  git add assets/choshi/board/posts data/choshi/board-posts.json board.html");
  console.log("  git commit -m '乗客から届いた写真を掲示する'");
})().catch((error) => {
  console.error(String(error.message || error));
  /*
   * process.exit() ではなく exitCode を立てるだけにする。
   * fetch（undici）がまだ握っている接続がある状態で強制終了すると、
   * Windows では "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
   * という Node 側の内部クラッシュ表示が出ることがある。実害は無いが、
   * 「パスポートを直しただけなのに新しいエラーが出た」と誤解させてしまう。
   * exitCode だけ立てて自然に終わらせれば、この表示は出ない。
   */
  process.exitCode = 1;
});
