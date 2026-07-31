/*
 * 車窓絶景ナビ ── 画面を組み立てる処理
 *
 * この段階で作るのは「乗車前モード」の地図画面（設計書 4.1）。
 * 位置情報を使う車上モードはこのあと足す。
 *
 * 大きな流れ:
 *   1. データを読む（地形・路線・絶景スポット）
 *   2. 緯度経度を地図の座標に直す決まりを作る
 *   3. 地形 → 線路 → 駅 → 絶景スポット の順に SVG へ描く
 *   4. テーマの絞り込みと、天候のひとことを用意する
 */

'use strict';

// ------------------------------------------------------------------
// テーマの決まり（設計書 5.4 / CONTEXT.md）
//
// 色は css/style.css で決めている。ここでは名前を結びつけるだけ。
// 4 つ以外のテーマは作らない。
// ------------------------------------------------------------------

const THEMES = {
  '地形':       { color: 'var(--theme-terrain)',  short: '地形' },
  '気候と農業': { color: 'var(--theme-farm)',     short: '気候と農業' },
  '産業と水運': { color: 'var(--theme-industry)', short: '産業' },
  '海と空':     { color: 'var(--theme-sea)',      short: '海' },
};

/*
 * 絶景スポットのバッジの中に描く絵。
 * ひし形のバッジに収まるよう、中心を (0,0) とした 20×20 くらいの大きさで描く。
 */
const GLYPHS = {
  // 醤油樽
  barrel: `<path d="M-6,-7 Q-8,0 -6,7 L6,7 Q8,0 6,-7 Z M-7.2,-2.2 L7.2,-2.2 M-7.2,2.4 L7.2,2.4"/>`,
  // 波
  wave: `<path d="M-8,-2.5 q4,-4 8,0 t8,0 M-8,3.5 q4,-4 8,0 t8,0"/>`,
  // 切通しのトンネル
  tunnel: `<path d="M-7,7.5 L-7,0 A7,7 0 0 1 7,0 L7,7.5 M-2.5,7.5 L-2.5,3 M2.5,7.5 L2.5,3"/>`,
  // キャベツ
  cabbage: `<path d="M-7,0 A7,7 0 1 0 7,0 A7,7 0 1 0 -7,0 M-4.5,2.5 Q0,-4 4.5,2.5 M-2.4,5.5 Q0,0.5 2.4,5.5"/>`,
  // ひまわり
  sunflower: `<path d="M-3.4,0 A3.4,3.4 0 1 0 3.4,0 A3.4,3.4 0 1 0 -3.4,0
                       M5,0 L7.8,0 M2.5,4.33 L3.9,6.75 M-2.5,4.33 L-3.9,6.75
                       M-5,0 L-7.8,0 M-2.5,-4.33 L-3.9,-6.75 M2.5,-4.33 L3.9,-6.75"/>`,
  // 桜
  blossom: `<g>
      <circle cx="0" cy="-4.4" r="2.7"/><circle cx="4.2" cy="-1.4" r="2.7"/>
      <circle cx="2.6" cy="3.6" r="2.7"/><circle cx="-2.6" cy="3.6" r="2.7"/>
      <circle cx="-4.2" cy="-1.4" r="2.7"/>
    </g>`,
};

/** 絞り込みの設定をブラウザに覚えさせるときの名前 */
const STORAGE_KEY = 'choshi-navi/themes';

/** 絶景スポットのひし形バッジの大きさ（中心から角まで） */
const BADGE_SIZE = 17;

const SVG_NS = 'http://www.w3.org/2000/svg';

// ------------------------------------------------------------------
// 小さな道具
// ------------------------------------------------------------------

/** SVG の部品を作る。createElementNS は SVG 専用の書き方。 */
function svg(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

/** JSON ファイルを読む */
async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} を読めなかった（HTTP ${response.status}）`);
  return response.json();
}

/**
 * 2 つの四角が重なっているか。
 *
 * ぴったり接していても窮屈に見えるので、すきまのぶんだけ厳しめに見る。
 * 線路のように「触れなければよい」ものは gap: 0 を持たせておく。
 */
function overlaps(a, b) {
  const gap = Math.min(a.gap ?? 5, b.gap ?? 5);
  return !(
    a.right + gap < b.left ||
    b.right + gap < a.left ||
    a.bottom + gap < b.top ||
    b.bottom + gap < a.top
  );
}

// ------------------------------------------------------------------
// 地図の座標
// ------------------------------------------------------------------

/**
 * 緯度経度を地図の座標に直す関数を作る。
 *
 * 地形データを作ったときと同じ決まりを使う。
 * 路線も駅も絶景スポットも、すべてこの一つの決まりで置く。
 * ずれが起きるとしたら、ここが食い違ったときだけ。
 */
function makeProjection(projection) {
  const { bounds, width, height } = projection;
  const spanLon = bounds.maxLon - bounds.minLon;
  const spanLat = bounds.maxLat - bounds.minLat;

  return function project(lat, lon) {
    return {
      x: ((lon - bounds.minLon) / spanLon) * width,
      y: ((bounds.maxLat - lat) / spanLat) * height, // 北が上なので引き算
    };
  };
}

/**
 * その地点で線路がどちらを向いているかを調べる。
 * 名前やバッジをどこに置くかを決めるのに使う。
 */
function headingAt(route, points, distanceAlong) {
  const LOOK_AHEAD_METERS = 150;

  const index = Math.round((distanceAlong / route.totalLength) * (points.length - 1));
  const step = Math.max(1, Math.round((LOOK_AHEAD_METERS / route.totalLength) * points.length));

  const from = points[Math.max(0, index - step)];
  const to = points[Math.min(points.length - 1, index + step)];

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;

  return {
    dx, dy,
    // 線路と直角の向き。バッジを線路の脇にどかすのに使う。
    normalX: -dy / length,
    normalY: dx / length,
    isHorizontal: Math.abs(dx) > Math.abs(dy),
  };
}

// ------------------------------------------------------------------
// 描く
// ------------------------------------------------------------------

/** 地形の濃淡を敷く。低いほうから順に上へ重ねる。 */
function drawTerrain(container, terrain) {
  for (const band of terrain.bands) {
    container.appendChild(
      svg('path', {
        d: band.path,
        // 内側の輪（穴）を抜くための指定。これがないと谷や窪地が塗りつぶされる。
        'fill-rule': 'evenodd',
        class: `band band--${band.minElevation}`,
      })
    );
  }

  // 海と陸の境目を、いちばん低い段階の輪でなぞる
  container.appendChild(svg('path', { d: terrain.bands[0].path, class: 'coast' }));

  // 地形の陰影（国土地理院の陰影起伏図タイルを貼り合わせたもの。tools/fetch-hillshade.js）。
  // 色の帯の上に重ねて立体感を出す。海の部分は透明なので、下の水色がそのまま透ける。
  container.appendChild(
    svg('image', {
      href: 'data/terrain-hillshade.png',
      x: 0,
      y: 0,
      width: terrain.projection.width,
      height: terrain.projection.height,
      preserveAspectRatio: 'none',
      class: 'hillshade',
    })
  );
}

/** 線路を引く */
function drawRoute(container, points) {
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join('');

  // 白い縁取りを先に引き、その上に線路を重ねる。
  // 台地の濃い緑の上でも線路が沈まないようにするため。
  container.appendChild(svg('path', { d, class: 'rail rail--halo' }));
  container.appendChild(svg('path', { d, class: 'rail' }));
}

/**
 * 文字を、まだ何も置かれていない場所に置く。
 *
 * 候補を順に試して、先に置いたものと重ならない場所を選ぶ。
 * どれも重なるときは最後の候補に置く（隠れるよりはまし）。
 *
 * @returns {{left:number,right:number,top:number,bottom:number}} 置いた場所
 */
function placeLabel(textElement, origin, candidates, size, placed) {
  const width = textElement.getComputedTextLength() || textElement.textContent.length * size;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const x = origin.x + candidate.dx;
    const y = origin.y + candidate.dy;

    const left =
      candidate.anchor === 'middle' ? x - width / 2 :
      candidate.anchor === 'end' ? x - width : x;

    const box = { left, right: left + width, top: y - size * 0.85, bottom: y + size * 0.3 };

    const isLast = i === candidates.length - 1;
    if (isLast || !placed.some((other) => overlaps(box, other))) {
      textElement.setAttribute('x', x.toFixed(1));
      textElement.setAttribute('y', y.toFixed(1));
      textElement.setAttribute('text-anchor', candidate.anchor);
      placed.push(box);
      return box;
    }
  }
}

/** 駅を置く */
function drawStations(container, route, project, points, placed) {
  route.stations.forEach((station, i) => {
    const p = project(station.lat, station.lon);
    const isEnd = i === 0 || i === route.stations.length - 1;
    const radius = isEnd ? 8 : 6;
    const fontSize = isEnd ? 19 : 17;

    const group = svg('g');
    group.appendChild(svg('circle', { cx: p.x, cy: p.y, r: radius, class: 'station-dot' }));
    placed.push({ left: p.x - radius, right: p.x + radius, top: p.y - radius, bottom: p.y + radius });

    const label = svg('text', {
      class: isEnd ? 'station-label station-label--end' : 'station-label',
    });
    label.textContent = station.name;
    group.appendChild(label);
    container.appendChild(group);

    /*
     * 置き場所の候補。
     * 線路が横に走っているところでは名前を上下に、
     * 縦に走っているところでは名前を左右に置くほうが、線路に重なりにくい。
     */
    const heading = headingAt(route, points, station.distanceAlong);
    const above = { dx: 0, dy: -(radius + 10), anchor: 'middle' };
    const below = { dx: 0, dy: radius + 23, anchor: 'middle' };
    const toLeft = { dx: -(radius + 8), dy: 6, anchor: 'end' };
    const toRight = { dx: radius + 8, dy: 6, anchor: 'start' };

    const candidates = heading.isHorizontal
      ? [above, below, toLeft, toRight]
      : [toLeft, toRight, above, below];

    placeLabel(label, p, candidates, fontSize, placed);
  });
}

/**
 * 絶景スポットのひし形バッジを置く（設計書 5.3）。
 *
 * バッジは線路の真上ではなく、線路の脇へどかして置く。
 * 駅の名前や隣のバッジと重ならないようにするため。
 * どこの地点を指しているかは、細い引き出し線でつなぐ。
 */
function drawSpots(container, spots, route, project, points, placed) {
  const elements = [];

  for (const spot of spots) {
    const anchor = project(spot.lat, spot.lon);
    const heading = headingAt(route, points, spot.distanceAlong);
    const theme = THEMES[spot.theme];

    const group = svg('g', {
      class: 'spot',
      'data-theme': spot.theme,
      'data-id': spot.id,
      tabindex: '0',
      role: 'button',
      'aria-label': `${spot.name}（${spot.location}・${spot.theme}）`,
    });

    // 名前の幅を測りたいので、先に作って画面に入れておく
    const label = svg('text', { class: 'spot-label' });
    label.textContent = spot.name;
    group.appendChild(label);
    container.appendChild(group);

    const labelWidth = label.getComputedTextLength() || spot.name.length * 16;

    /*
     * 線路の左右へ、少しずつ遠ざけながら空いている場所を探す。
     * 近いほうが指している地点はわかりやすいので、近い順に試す。
     */
    let chosen = null;
    for (const distance of [40, 58, 78, 100, 124]) {
      for (const side of [1, -1]) {
        const cx = anchor.x + heading.normalX * side * distance;
        const cy = anchor.y + heading.normalY * side * distance;

        // 名前はバッジの外側（線路から遠いほう）に置く
        const goesRight = heading.normalX * side >= 0;
        const labelLeft = goesRight
          ? cx + BADGE_SIZE + 9
          : cx - BADGE_SIZE - 9 - labelWidth;

        const box = {
          left: Math.min(cx - BADGE_SIZE, labelLeft),
          right: Math.max(cx + BADGE_SIZE, labelLeft + labelWidth),
          top: cy - BADGE_SIZE,
          bottom: cy + BADGE_SIZE,
        };

        if (!placed.some((other) => overlaps(box, other))) {
          chosen = { cx, cy, goesRight, box };
          break;
        }
      }
      if (chosen) break;
    }

    // どこも空いていなければ、いちばん近い候補に置く
    if (!chosen) {
      const cx = anchor.x + heading.normalX * 40;
      const cy = anchor.y + heading.normalY * 40;
      chosen = {
        cx, cy,
        goesRight: heading.normalX >= 0,
        box: { left: cx - BADGE_SIZE, right: cx + BADGE_SIZE, top: cy - BADGE_SIZE, bottom: cy + BADGE_SIZE },
      };
    }

    placed.push(chosen.box);
    elements.push(chosen.box);

    // --- 引き出し線と、指している地点の印 ---
    group.insertBefore(
      svg('line', {
        x1: anchor.x.toFixed(1), y1: anchor.y.toFixed(1),
        x2: chosen.cx.toFixed(1), y2: chosen.cy.toFixed(1),
        class: 'spot-leader',
      }),
      label
    );
    group.insertBefore(
      svg('circle', { cx: anchor.x.toFixed(1), cy: anchor.y.toFixed(1), r: 3.5, class: 'spot-anchor' }),
      label
    );

    // --- ひし形のバッジ。正方形を 45 度まわして作る ---
    group.insertBefore(
      svg('rect', {
        x: chosen.cx - BADGE_SIZE,
        y: chosen.cy - BADGE_SIZE,
        width: BADGE_SIZE * 2,
        height: BADGE_SIZE * 2,
        rx: 4,
        transform: `rotate(45 ${chosen.cx.toFixed(1)} ${chosen.cy.toFixed(1)})`,
        fill: theme.color,
        class: 'spot-badge',
      }),
      label
    );

    // --- バッジの中の絵 ---
    const glyph = svg('g', {
      transform: `translate(${chosen.cx.toFixed(1)} ${chosen.cy.toFixed(1)}) scale(0.85)`,
      class: 'spot-glyph',
    });
    glyph.innerHTML = GLYPHS[spot.icon] || '';
    group.insertBefore(glyph, label);

    // --- 名前 ---
    label.setAttribute('x', (chosen.goesRight ? chosen.cx + BADGE_SIZE + 9 : chosen.cx - BADGE_SIZE - 9).toFixed(1));
    label.setAttribute('y', (chosen.cy + 6).toFixed(1));
    label.setAttribute('text-anchor', chosen.goesRight ? 'start' : 'end');
  }

  return elements;
}

// ------------------------------------------------------------------
// 地図の見える範囲を決める
// ------------------------------------------------------------------

/**
 * 路線と、その名前やバッジがぜんぶ入るように、地図の見える範囲を合わせる。
 *
 * 画面の形は端末によって違う（縦長のスマートフォン、横長のパソコン）。
 * そこで、収めたい四角を画面の形に合わせて広げてから当てはめる。
 */
function fitMap(mapElement, contents, projection) {
  const padding = 16;
  let left = Math.min(...contents.map((c) => c.left)) - padding;
  let right = Math.max(...contents.map((c) => c.right)) + padding;
  let top = Math.min(...contents.map((c) => c.top)) - padding;
  let bottom = Math.max(...contents.map((c) => c.bottom)) + padding;

  let width = right - left;
  let height = bottom - top;

  // 画面の縦横比に合わせて、足りないほうを広げる
  const box = mapElement.getBoundingClientRect();
  const screenRatio = box.height / box.width;

  if (height / width < screenRatio) {
    const wanted = width * screenRatio;
    const grow = (wanted - height) / 2;
    top -= grow;
    bottom += grow;
    height = wanted;
  } else {
    const wanted = height / screenRatio;
    const grow = (wanted - width) / 2;
    left -= grow;
    right += grow;
    width = wanted;
  }

  // 地形データのない外側まで映さないよう、できる範囲で内側に寄せる
  if (width <= projection.width) {
    if (left < 0) { right -= left; left = 0; }
    if (right > projection.width) { left -= right - projection.width; right = projection.width; }
  }
  if (height <= projection.height) {
    if (top < 0) { bottom -= top; top = 0; }
    if (bottom > projection.height) { top -= bottom - projection.height; bottom = projection.height; }
  }

  mapElement.setAttribute('viewBox', `${left.toFixed(1)} ${top.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}`);
}

// ------------------------------------------------------------------
// テーマの絞り込み（設計書 4.1）
// ------------------------------------------------------------------

function setUpThemeFilter(container, mapSpots) {
  // 前に選んだ設定があれば引き継ぐ。なければ全部表示。
  let hidden = new Set();
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) hidden = new Set(JSON.parse(saved));
  } catch {
    // 保存できない設定のブラウザでも、動きは変えない
  }

  function apply() {
    for (const spot of mapSpots) {
      spot.classList.toggle('spot--hidden', hidden.has(spot.getAttribute('data-theme')));
    }
    for (const chip of container.children) {
      chip.setAttribute('aria-pressed', String(!hidden.has(chip.dataset.theme)));
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden]));
    } catch {
      // 保存できなくても表示は正しいので、何もしない
    }
  }

  for (const [name, theme] of Object.entries(THEMES)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'theme-chip';
    chip.dataset.theme = name;
    chip.style.setProperty('--chip-color', theme.color);
    chip.innerHTML = `<span class="chip-diamond"></span>${theme.short}`;

    chip.addEventListener('click', () => {
      if (hidden.has(name)) hidden.delete(name);
      else hidden.add(name);
      apply();
    });

    container.appendChild(chip);
  }

  apply();
}

// ------------------------------------------------------------------
// 天候のひとこと（設計書 4.1）
//
// 予報は「千葉県北東部」のような広い区分でしか手に入らない。
// そのため「この地点はよく見える」とは書かず、その日の空模様だけを伝える。
// ------------------------------------------------------------------

const JMA_CHIBA = 'https://www.jma.go.jp/bosai/forecast/data/forecast/120000.json';

/** 天気の言葉から、車窓のひとことを選ぶ */
function windowHint(weather) {
  if (/晴/.test(weather)) return '海がよく見えます。';
  if (/雪/.test(weather)) return '畑が白くなっているかもしれません。';
  if (/雨/.test(weather)) return '窓の水滴ごしの景色も、この土地の顔です。';
  if (/曇|くもり/.test(weather)) return '色がやわらかく見える日です。';
  return '';
}

async function showWeather(element) {
  try {
    const forecast = await loadJson(JMA_CHIBA);

    // 銚子は「北東部」。見つからなければ最初の区分を使う。
    const areas = forecast[0].timeSeries[0].areas;
    const area = areas.find((a) => a.area.name.includes('北東部')) || areas[0];
    const weather = area.weathers[0].replace(/\s+/g, '');

    // 「くもり所により雨」のような長い言い方は、先頭のひと言だけにする。
    // ひとことも同じ短い言い方から選ぶ。
    // （「きょうはくもり」と言いながら雨の話をすると、ちぐはぐになるため）
    const short = weather.split(/のち|時々|一時|所により|後/)[0];

    element.textContent = `きょうは${short}。${windowHint(short)}`;
  } catch {
    // 通信できないときは黙って引っこめる。地図は天候がなくても使える。
    element.hidden = true;
  }
}

// ------------------------------------------------------------------
// 組み立て
// ------------------------------------------------------------------

async function main() {
  const mapElement = document.getElementById('map');

  const [terrain, route, spotsFile] = await Promise.all([
    loadJson('data/terrain.json'),
    loadJson('data/route.json'),
    loadJson('data/spots.json'),
  ]);

  const project = makeProjection(terrain.projection);
  const points = route.track.map(([lat, lon]) => project(lat, lon));

  drawTerrain(document.getElementById('map-terrain'), terrain);
  drawRoute(document.getElementById('map-route'), points);

  /*
   * 文字の幅は、実際に画面に置いてみないと測れない。
   * そこで先に路線だけで見える範囲を決めてから、駅と絶景スポットを置く。
   * こうすると測るときと出来上がりで縮尺が変わらない。
   */
  const railBox = {
    left: Math.min(...points.map((p) => p.x)),
    right: Math.max(...points.map((p) => p.x)),
    top: Math.min(...points.map((p) => p.y)),
    bottom: Math.max(...points.map((p) => p.y)),
  };
  fitMap(mapElement, [{ left: railBox.left - 80, right: railBox.right + 80, top: railBox.top - 80, bottom: railBox.bottom + 80 }], terrain.projection);

  /*
   * 置いたものの場所を覚えておき、あとから置くものが重ならないようにする。
   * 線路そのものも「よけるべきもの」として最初に入れておく。
   * こうしないと、駅名が線路の上に乗ってしまう。
   */
  const placed = points.map((p) => ({
    left: p.x - 3, right: p.x + 3, top: p.y - 3, bottom: p.y + 3,
    gap: 0, // 触れていなければよい。余白まで求めると名前の置き場所がなくなる。
  }));

  drawStations(document.getElementById('map-stations'), route, project, points, placed);

  const spotsLayer = document.getElementById('map-spots');
  drawSpots(spotsLayer, spotsFile.spots, route, project, points, placed);

  // 駅名やバッジまで含めて、あらためて見える範囲を合わせ直す
  const refit = () => fitMap(mapElement, [railBox, ...placed], terrain.projection);
  refit();
  window.addEventListener('resize', refit);

  setUpThemeFilter(document.getElementById('themes'), spotsLayer.querySelectorAll('.spot'));

  showWeather(document.getElementById('weather'));
}

main().catch((error) => {
  console.error(error);
  const weather = document.getElementById('weather');
  weather.textContent =
    'データを読み込めませんでした。ローカルサーバー経由で開いているか確かめてください。';
});
