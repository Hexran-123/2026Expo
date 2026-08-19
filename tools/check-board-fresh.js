/*
 * check-board-fresh.js
 *
 * 絶景掲示板のプロトタイプ
 * ai/artifacts/絶景掲示板/mockups/board-map-variant-v4.html が、いまのテンプレートと
 * データの中身と合っているか確かめる。tools/build-board-mockup.js をもう一度走らせ、
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
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD_SCRIPT = path.join(ROOT, 'tools', 'build-board-mockup.js');
const TARGET = 'ai/artifacts/絶景掲示板/mockups/board-map-variant-v4.html';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-fresh-'));
let fresh;

try {
  const tmpOut = path.join(tmpDir, 'board-map-variant-v4.html');
  try {
    execFileSync(process.execPath, [BUILD_SCRIPT, tmpOut], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    // build-board-mockup.js は、標高の表とスポットの座標が食い違うときにも止まる。
    // その理由をそのまま見せる（握りつぶすと原因が分からなくなる）。
    console.error('絶景掲示板のプロトタイプを作り直せなかった:');
    console.error(String(e.stderr || e.stdout || e.message).trim());
    process.exit(1);
  }
  fresh = fs.readFileSync(tmpOut, 'utf8');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const currentPath = path.join(ROOT, TARGET);
const current = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : null;

if (current !== fresh) {
  console.error('絶景掲示板のプロトタイプが、テンプレート・データの今の中身と合っていない（作り直し忘れ）:');
  console.error(`  - ${TARGET}`);
  console.error('');
  console.error('作り直すこと:');
  console.error('  node tools/build-board-mockup.js');
  process.exit(1);
}

console.log('絶景掲示板のプロトタイプは最新。');
