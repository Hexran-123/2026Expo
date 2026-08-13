/*
 * check-demo-fresh.js
 *
 * demo/*.html が css/・js/・data/ の今の中身と合っているか確かめる。
 * build-demo.js を同じ引数でもう一度走らせ、出てきた HTML を今 commit
 * されている demo/*.html と突き合わせるだけ。ずれていれば、直したのに
 * 1 枚デモへの作り直しを忘れているということ（README「作り直し忘れ」参照）。
 *
 * 使い方:  node tools/check-demo-fresh.js
 * 終了コード: 0 = 4 枚とも最新、1 = 古いものがある
 *
 * pre-commit フックと GitHub Actions の両方からこれを呼ぶ。
 * 手元での取りこぼしは pre-commit が、フックを入れ忘れた環境や
 * 別セッションでの取りこぼしは GitHub Actions が拾う。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD_SCRIPT = path.join(ROOT, 'tools', 'build-demo.js');

// README「作り直すとき」の 4 コマンドと同じ組み合わせ
const TARGETS = [
  { lineId: 'all', flags: ['--switch'], out: 'demo/all.html' },
  { lineId: 'choshi', flags: ['--switch'], out: 'demo/choshi.html' },
  { lineId: 'yurakucho', flags: ['--switch'], out: 'demo/yurakucho.html' },
  { lineId: 'yurakucho', flags: ['--gps', '--switch'], out: 'demo/yurakucho-gps.html' },
];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-fresh-'));
const stale = [];

try {
  for (const t of TARGETS) {
    const tmpOut = path.join(tmpDir, path.basename(t.out));
    execFileSync(
      process.execPath,
      [BUILD_SCRIPT, t.lineId, tmpOut, ...t.flags],
      { cwd: ROOT, stdio: 'pipe' }
    );

    const fresh = fs.readFileSync(tmpOut, 'utf8');
    const currentPath = path.join(ROOT, t.out);
    const current = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : null;

    if (current !== fresh) {
      stale.push(t.out);
    }
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (stale.length > 0) {
  console.error('demo/ が css・js・data の今の中身と合っていない（作り直し忘れ）:');
  for (const f of stale) console.error(`  - ${f}`);
  console.error('');
  console.error('直すには（README「作り直すとき」と同じ）:');
  console.error('  node tools/build-demo.js all       demo/all.html            --switch');
  console.error('  node tools/build-demo.js choshi    demo/choshi.html         --switch');
  console.error('  node tools/build-demo.js yurakucho demo/yurakucho.html      --switch');
  console.error('  node tools/build-demo.js yurakucho demo/yurakucho-gps.html  --gps --switch');
  process.exit(1);
}

console.log('demo/ は 4 枚とも最新。');
