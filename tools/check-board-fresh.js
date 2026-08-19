/*
 * check-board-fresh.js
 *
 * 絶景掲示板の本体 board.html が、いまのテンプレートとデータの中身と
 * 合っているか確かめる。tools/build-board.js をもう一度走らせ、
 * 出てきた HTML を commit されているものと突き合わせるだけ。
 *
 * このファイルは生成物なのに、これまで作り直し忘れの検査が無かった。
 * demo/*.html では実際に作り直し忘れが起きている（CLAUDE.md「並行セッションでの
 * 作り直し忘れが過去に実際に起きている」）ので、同じ守りを掲示板側にも入れる。
 *
 * 使い方:  node tools/check-board-fresh.js
 * 終了コード: 0 = 最新、1 = 古い
 *
 * .githooks/pre-commit と GitHub Actions の両方から呼ぶ。
 * 14.8MB の標高格子は要らない（data/board/spot-elevations.json に焼いてあるため）ので、
 * clone したばかりの CI でもそのまま走る。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD_SCRIPT = path.join(ROOT, 'tools', 'build-board.js');
const TARGET = 'board.html';

/*
 * 突き合わせ用の一時ファイルは、**リポジトリ直下に、board.html と同じ深さで**作る。
 *
 * tools/build-board.js は写真への相対パスを出力先の場所から計算するので、
 * 一段でも深いところに書くと ../assets/... になり、直してもいないのに
 * 「古い」と言われつづける（2026-08-19 に実際にそうなった）。
 * 名前は .gitignore で外してある（.board-fresh-*.html）。
 */
const tmpOut = path.join(ROOT, `.board-fresh-${process.pid}.html`);
let fresh;

try {
  try {
    execFileSync(process.execPath, [BUILD_SCRIPT, tmpOut], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    // build-board.js は、標高の表とスポットの座標が食い違うときにも止まる。
    // その理由をそのまま見せる（握りつぶすと原因が分からなくなる）。
    console.error('絶景掲示板（board.html）を作り直せなかった:');
    console.error(String(e.stderr || e.stdout || e.message).trim());
    process.exit(1);
  }
  fresh = fs.readFileSync(tmpOut, 'utf8');
} finally {
  fs.rmSync(tmpOut, { force: true });
}

const currentPath = path.join(ROOT, TARGET);
const current = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : null;

if (current !== fresh) {
  console.error('board.html が、テンプレート・データの今の中身と合っていない（作り直し忘れ）:');
  console.error(`  - ${TARGET}`);
  console.error('');
  console.error('作り直すこと:');
  console.error('  node tools/build-board.js');
  process.exit(1);
}

console.log('絶景掲示板（board.html）は最新。');
