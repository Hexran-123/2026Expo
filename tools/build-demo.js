/*
 * build-demo.js
 *
 * 作品をそのまま 1 枚の HTML に畳んで、サーバーなしで開けるようにする。
 *
 * 何のためか。この作品は data/*.json を fetch で読むので file:// では動かず、
 * 見てもらうたびに「ローカルサーバーを立ててください」と言う必要がある。
 * 審査員・共同制作者・展示の下見に渡すには、それでは重い。
 * ここが作る 1 枚は、開くだけで動く。
 *
 * 本体のコードには一切手を入れない。差し替えるのは 4 つだけ:
 *   fetch            → 埋め込んだ JSON を返す
 *   loadJson         → 同上（fetch を経由しない。下の注記を読むこと）
 *   <image href>     → 陰影の絵を data URI に
 *   URLSearchParams  → ?demo=1 相当にして走行シミュレーターを動かす
 *
 * 使い方:  node tools/build-demo.js [路線id] [出力先.html] [--gps]
 * 例:      node tools/build-demo.js choshi    demo/choshi.html
 *          node tools/build-demo.js yurakucho demo/yurakucho.html
 *          node tools/build-demo.js yurakucho demo/yurakucho-gps.html --gps
 *
 * 路線を 1 つだけ入れるので、路線選択画面は出ない（data/lines.json が
 * 1 件のときの振る舞いと同じ）。両方入れた 1 枚を作りたいときは
 * 路線id に all を渡す。
 *
 * --gps を付けると、走行シミュレーターではなく **実機の位置情報** で動く。
 * 現地で実際に乗って確かめるための版。位置情報は端末から出ず、どこへも送らない
 * （この 1 枚は通信そのものをしない）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2).filter((a) => a !== '--gps');
const USE_GPS = process.argv.includes('--gps');

const LINE_ID = args[0] || 'choshi';
const OUT_PATH = args[1]
  ? path.resolve(args[1])
  : path.join(ROOT, 'demo', `${LINE_ID}${USE_GPS ? '-gps' : ''}.html`);

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/**
 * 本体が読み込む順。この順に埋め込む。
 * 走行シミュレーターは ?demo=1 のときだけ本体が読むもので、
 * 実機の位置情報で動かす版（--gps）には要らない。
 */
const JS_FILES = [
  'js/schedule.js',
  'js/onboard.js',
  'js/journal.js',
  'js/popularity.js',
  ...(USE_GPS ? [] : ['js/simulate.js']),
  'js/main.js',
];

/** 路線ごとに読むデータ */
const PER_LINE = ['route', 'terrain', 'spots', 'schedule', 'preview'];

// ------------------------------------------------------------------
// 対象の路線を決める
// ------------------------------------------------------------------

const registry = JSON.parse(read('data', 'lines.json'));
const lines =
  LINE_ID === 'all'
    ? registry.lines
    : registry.lines.filter((line) => line.id === LINE_ID);

if (lines.length === 0) {
  console.error(`data/lines.json に「${LINE_ID}」が無い。`);
  console.error(`使えるのは: ${registry.lines.map((l) => l.id).join(', ')}, all`);
  process.exit(1);
}

// ------------------------------------------------------------------
// 埋め込むもの
// ------------------------------------------------------------------

const payload = {
  // 選んだ路線だけの一覧にする。1 件なら路線選択画面は出ない
  'data/lines.json': { ...registry, default: lines[0].id, lines },
};

for (const line of lines) {
  for (const name of PER_LINE) {
    const key = `${line.dir}/${name}.json`;
    payload[key] = JSON.parse(read(...key.split('/')));
  }
}

/*
 * 陰影の絵。
 *
 * 一度、大きさを惜しんで 1x1 の透明 PNG に差し替えたことがある。ところが
 * .hillshade は mix-blend-mode: overlay で重ねているので、透明な絵でも
 * 混色が働き、地図全体がピンクに転んだ。無いものを透明な絵で代用しない。
 * 陰影を持たない路線は data/lines.json に "hillshade": false と書くこと
 * （js/main.js が層そのものを作らなくなる）。
 */
const assets = {};
for (const line of lines) {
  if (line.hillshade === false) continue;
  const file = `${line.dir}/terrain-hillshade.webp`;
  const raw = fs.readFileSync(path.join(ROOT, ...file.split('/')));
  assets[file] = `data:image/webp;base64,${raw.toString('base64')}`;
}

const dataJson = JSON.stringify(payload);
const assetsJson = JSON.stringify(assets);

// 埋め込む JSON が </script> を含むと、そこで script が閉じてしまう
if (/<\/script/i.test(dataJson) || /<\/script/i.test(assetsJson)) {
  console.error('データに </script> が入っている。そのままでは埋め込めない。');
  process.exit(1);
}

// ------------------------------------------------------------------
// 本体の骨組み
// ------------------------------------------------------------------

const index = read('index.html');
const body = /<body>([\s\S]*)<\/body>/.exec(index)[1]
  .replace(/\s*<script src="[^"]+"><\/script>/g, '')
  .replace(/\s*<link[^>]*>/g, '');

const css = read('css', 'style.css');
const scripts = Object.fromEntries(JS_FILES.map((f) => [f, read(...f.split('/'))]));

const SHIM = `
/* ------------------------------------------------------------------
   デモの下ごしらえ。本体のコードには手を入れていない。
   外との通信を、埋め込んだデータに付け替えているだけ。
   ------------------------------------------------------------------ */
window.DEMO_JSON = ${dataJson};
window.DEMO_ASSETS = ${assetsJson};

/* fetch を、埋め込んだ JSON から返すものに差し替える */
window.fetch = function (input) {
  const key = String(input).replace(/^\\.?\\//, '');
  if (key in window.DEMO_JSON) {
    return Promise.resolve(new Response(JSON.stringify(window.DEMO_JSON[key]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  }
  // 気象庁・Supabase など、外に出るものはデモでは断る
  return Promise.reject(new Error('デモでは外部通信をしない: ' + key));
};

/* 陰影の絵は <image href> で貼られるので、属性を書く手前で data URI に差し替える */
const setAttr = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name, value) {
  if ((name === 'href' || name === 'xlink:href') && window.DEMO_ASSETS[value]) {
    value = window.DEMO_ASSETS[value];
  }
  return setAttr.call(this, name, value);
};
const setAttrNS = Element.prototype.setAttributeNS;
Element.prototype.setAttributeNS = function (ns, name, value) {
  if ((name === 'href' || name === 'xlink:href') && window.DEMO_ASSETS[value]) {
    value = window.DEMO_ASSETS[value];
  }
  return setAttrNS.call(this, ns, name, value);
};

${USE_GPS ? `
/*
 * この版は実機の位置情報で動かす。?demo=1 を立てないので、本体は
 * 走行シミュレーターではなく navigator.geolocation.watchPosition を使う。
 * 位置情報は端末から出ない（この 1 枚は通信そのものをしない）。
 */
` : `
/*
 * 本体は URL の ?demo=1 を見て走行シミュレーターに切り替える。
 * 1 枚の HTML を直接開く使い方では URL に引数を付けられないので、
 * 読み取り口のほうを差し替える。
 */
const RealParams = window.URLSearchParams;
window.URLSearchParams = function (init) {
  if (init === window.location.search || init === '' || init === undefined) init = 'demo=1';
  return new RealParams(init);
};
window.URLSearchParams.prototype = RealParams.prototype;
`}

/* 開くたびに最初の画面から始める */
try { localStorage.removeItem('choshi-navi/line'); } catch (e) {}
`;

/*
 * 位置情報の受け取り具合を出す小さな窓（--gps のときだけ）。
 *
 * 現地で確かめるとき、何も起きないのが「断られた」のか「電波が無い」のか
 * 「線路から離れすぎ」なのかが画面から分からないと、直しようがない。
 * 本体には手を入れず、ここで別に watchPosition を張って表示だけする。
 * 有楽町線はほぼ全線が地下なので、取れなくなる様子そのものが見どころ。
 */
const GPS_PANEL = String.raw`
(function () {
  if (!navigator.geolocation) return;

  const panel = document.createElement('div');
  panel.className = 'gps-panel';
  panel.innerHTML =
    '<div class="gps-head">' +
      '<b>位置情報</b><span id="gps-state">許可を待っています…</span>' +
      '<button type="button" id="gps-fold" aria-label="たたむ">▾</button>' +
    '</div><dl class="gps-body" id="gps-body"></dl>';
  document.body.appendChild(panel);

  document.getElementById('gps-fold').addEventListener('click', function () {
    panel.classList.toggle('gps-panel--folded');
    this.textContent = panel.classList.contains('gps-panel--folded') ? '▴' : '▾';
  });

  /* 線路までの最短距離。「アプリが自分を線の上と見なせるか」がこれで分かる */
  const routeKey = Object.keys(window.DEMO_JSON).find(function (k) {
    return k.endsWith('/route.json');
  });
  const track = routeKey ? window.DEMO_JSON[routeKey].track : [];

  function metersBetween(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function toTrack(lat, lon) {
    let best = Infinity;
    for (let i = 0; i < track.length; i++) {
      const d = metersBetween(lat, lon, track[i][0], track[i][1]);
      if (d < best) best = d;
    }
    return best;
  }

  const state = document.getElementById('gps-state');
  const body = document.getElementById('gps-body');
  let count = 0;

  function row(label, value) {
    return '<dt>' + label + '</dt><dd>' + value + '</dd>';
  }

  navigator.geolocation.watchPosition(
    function (position) {
      count += 1;
      const c = position.coords;
      const near = track.length ? toTrack(c.latitude, c.longitude) : null;
      state.textContent = '受信中（' + count + ' 回目）';
      panel.classList.remove('gps-panel--bad');
      body.innerHTML =
        row('緯度経度', c.latitude.toFixed(5) + ', ' + c.longitude.toFixed(5)) +
        row('精度', Math.round(c.accuracy) + ' m') +
        row('速さ', c.speed === null ? '—' : (c.speed * 3.6).toFixed(1) + ' km/h') +
        row('向き', c.heading === null ? '—' : Math.round(c.heading) + '°') +
        (near === null ? '' : row('線路まで', near < 1000
          ? Math.round(near) + ' m'
          : (near / 1000).toFixed(1) + ' km')) +
        row('最終', new Date(position.timestamp).toLocaleTimeString('ja-JP'));
    },
    function (error) {
      const why = error.code === 1 ? '断られました（端末の設定で許可してください）'
                : error.code === 2 ? '取れません（地下・屋内では起きます）'
                : error.code === 3 ? '時間切れ'
                : '不明';
      state.textContent = why;
      panel.classList.add('gps-panel--bad');
      if (count > 0) {
        body.insertAdjacentHTML('afterbegin',
          row('直前まで', count + ' 回受信していました'));
      }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
})();
`;

const TAIL = String.raw`
/*
 * 本体は ?demo=1 のとき js/simulate.js を読みに行く。もう入っているので止める。
 */
window.loadScript = function () { return Promise.resolve(); };

/*
 * データの読み込みを fetch から切り離す。
 *
 * fetch を差し替えるだけだと、この頁を載せている側（アーティファクトの
 * 枠など）があとから fetch を自前のものへ戻した場合に、素通しで外へ出て
 * 失敗する。実際にそれで「地図を読み込めませんでした」が出た。
 * 本体の loadJson ごと差し替えれば、通信の仕組みが何であっても影響を受けない。
 * いちばん最初の lines.json だけは main() が同期で呼ぶのでここに間に合わず、
 * そちらは上の fetch 差し替えが受け持つ。
 */
window.loadJson = function (path) {
  const key = String(path).replace(/^\.?\//, '');
  if (key in window.DEMO_JSON) return Promise.resolve(window.DEMO_JSON[key]);
  return Promise.reject(new Error('デモに入っていないデータ: ' + key));
};

/*
 * 累積人気は本番の Supabase に書きに行く。デモの操作を実際の数に
 * 混ぜてはいけないので、通信そのものをさせない。本体は null を
 * 「まだ数が無い」として扱うので、印が出ないだけで他は変わらない。
 */
if (window.Popularity) {
  window.Popularity = Object.assign({}, window.Popularity, {
    record: function () { return Promise.resolve(null); },
  });
}

/*
 * 失敗したときに、本当の理由を画面に出す。
 * 本体は「電波の良い場所で」としか言わないので、それでは直せない。
 */
(function () {
  let reason = '';
  const realError = console.error;
  console.error = function () {
    const first = arguments[0];
    if (!reason && first) reason = first.message ? first.message : String(first);
    return realError.apply(console, arguments);
  };
  window.addEventListener('error', function (e) { if (!reason) reason = e.message; });
  window.addEventListener('unhandledrejection', function (e) {
    if (!reason) reason = (e.reason && e.reason.message) || String(e.reason);
  });

  const text = document.getElementById('loading-text');
  if (!text) return;
  new MutationObserver(function () {
    if (!text.textContent.includes('読み込めませんでした')) return;
    if (document.getElementById('demo-reason')) return;
    const p = document.createElement('p');
    p.id = 'demo-reason';
    p.style.cssText = 'margin:10px 24px 0;font-size:12px;line-height:1.6;color:#6B6862;'
                    + 'max-width:340px;text-align:center;word-break:break-word';
    p.textContent = 'デモの詳細: ' + (reason || '（理由を取れませんでした）');
    text.after(p);
  }).observe(text, { childList: true, characterData: true, subtree: true });
})();

${USE_GPS ? GPS_PANEL : ''}

/*
 * 注記は、路線選択画面が出ているあいだだけ残す。
 * そのあとは走行シミュレーターの操作盤と同じ場所に来てしまう。
 * 路線が 1 つで選択画面が出ないときは、数秒で引っこめる。
 */
(function () {
  const note = document.getElementById('demo-note');
  if (!note) return;
  const picker = document.getElementById('line-picker');
  if (picker && !picker.hidden) {
    new MutationObserver(function (records, observer) {
      if (picker.hidden) { note.remove(); observer.disconnect(); }
    }).observe(picker, { attributes: true, attributeFilter: ['hidden'] });
  } else {
    setTimeout(function () { note.remove(); }, 6000);
  }
})();
`;

const NOTE_CSS = `
.demo-note {
  position: fixed; left: 12px; bottom: 12px; z-index: 60;
  display: flex; align-items: center; gap: 10px;
  max-width: calc(100vw - 24px);
  padding: 9px 12px 9px 14px;
  border-radius: 999px;
  background: rgba(20, 22, 20, 0.82);
  color: #F3EBD8;
  font-size: 12px; line-height: 1.5;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
}
.demo-note b { font-weight: 700; }
.demo-note button {
  flex: none; width: 22px; height: 22px; padding: 0;
  border: none; border-radius: 50%;
  background: rgba(243, 235, 216, 0.16); color: inherit;
  font: inherit; line-height: 1; cursor: pointer;
}
.demo-note button:hover { background: rgba(243, 235, 216, 0.3); }
.demo-note button:focus-visible { outline: 2px solid #F3EBD8; outline-offset: 2px; }
`;

/* 位置情報の窓（--gps のときだけ）。走行シミュレーターの操作盤と同じ場所・同じ見た目にそろえる */
const GPS_CSS = `
.gps-panel {
  position: fixed; left: 10px; bottom: 10px; z-index: 55;
  width: 232px; max-width: calc(100vw - 20px);
  padding: 10px 12px 11px;
  border-radius: 14px;
  background: rgba(20, 22, 20, 0.88);
  color: #F3EBD8;
  font-size: 12px; line-height: 1.5;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
}
.gps-head { display: flex; align-items: center; gap: 8px; }
.gps-head b { font-weight: 700; flex: none; }
.gps-head span { flex: 1; color: #C9C2AE; font-size: 11px; }
.gps-head button {
  flex: none; width: 22px; height: 22px; padding: 0;
  border: none; border-radius: 50%;
  background: rgba(243, 235, 216, 0.16); color: inherit;
  font: inherit; line-height: 1; cursor: pointer;
}
.gps-head button:hover { background: rgba(243, 235, 216, 0.3); }
.gps-head button:focus-visible { outline: 2px solid #F3EBD8; outline-offset: 2px; }

/* 取れていないあいだは縁で分かるようにする。文字だけだと見落とす */
.gps-panel--bad { box-shadow: 0 0 0 2px #C0704A, 0 6px 22px rgba(0, 0, 0, 0.35); }

.gps-body {
  display: grid; grid-template-columns: auto 1fr; gap: 2px 10px;
  margin: 8px 0 0;
}
.gps-body:empty { display: none; }
.gps-body dt { color: #A9A292; font-size: 11px; }
.gps-body dd { margin: 0; font-variant-numeric: tabular-nums; }
.gps-panel--folded .gps-body { display: none; }
`;

const title =
  LINE_ID === 'all'
    ? '車窓絶景ナビ ─ 動くデモ'
    : `車窓絶景ナビ ─ ${lines[0].name}${USE_GPS ? '（実機の位置情報で動かす版）' : ' の動くデモ'}`;

const NOTE_TEXT = USE_GPS
  ? '<b>実機の位置情報で動きます。</b>電車に乗って確かめる用。位置情報は端末から出ず、どこへも送りません。'
  : '<b>デモ</b> ─ 実物がそのまま動きます。走行は本体付属のシミュレーターで、実機の位置情報は使いません。';

const NOTE_HTML = `
<div class="demo-note" id="demo-note">
  <span>${NOTE_TEXT}</span>
  <button type="button" aria-label="この注記を閉じる"
          onclick="document.getElementById('demo-note').remove()">×</button>
</div>
`;

// ------------------------------------------------------------------
// 書き出し
// ------------------------------------------------------------------

const parts = [
  '<!doctype html>',
  '<html lang="ja">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  `<title>${title}</title>`,
  `<style>\n${css}\n${NOTE_CSS}${USE_GPS ? GPS_CSS : ''}</style>`,
  '</head>',
  '<body>',
  body,
  NOTE_HTML,
  `<script>${SHIM}</script>`,
  ...JS_FILES.map((f) => `<script>/* === ${f} === */\n${scripts[f]}\n</script>`),
  `<script>${TAIL}</script>`,
  '</body>',
  '</html>',
];

const html = parts.join('\n');
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, html, 'utf8');

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const kb = (n) => `${Math.round(n / 1024)} KB`;

console.log(`書き出し: ${path.relative(ROOT, OUT_PATH)}  ${mb(Buffer.byteLength(html))}`);
console.log(`  路線  : ${lines.map((l) => l.name).join('・')}`);
console.log(`  動かし方: ${USE_GPS ? '実機の位置情報（watchPosition）' : '走行シミュレーター（?demo=1 相当）'}`);
console.log(`  陰影  : ${kb(assetsJson.length)}`);
console.log(`  データ: ${kb(dataJson.length)}`);
console.log(`  CSS+JS: ${kb(css.length + Object.values(scripts).reduce((n, s) => n + s.length, 0))}`);
