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

/*
 * 拡大の上限。初期表示（路線全体）の何倍まで寄れるか。
 * 16 倍で、駅ひとつとその周り 300m ほどが画面いっぱいになる。
 */
const MAX_ZOOM = 16;

/*
 * 地形の陰影を薄れさせはじめる倍率と、消えきる倍率。
 *
 * 陰影の画像は 1 画素が約 3.9m。6 倍を超えたあたりから 1 画素が
 * 画面の数画素まで引き伸ばされ、輪郭がにじみはじめる。
 * にじんだ絵を見せるより、消して色だけにしたほうが気持ちがよい。
 * 線路や駅は SVG なので、消えたあとも輪郭は鋭いまま残る。
 */
const HILLSHADE_FADE_FROM = 6;
const HILLSHADE_FADE_TO = 10;

/** 絶景スポットの名前を出しはじめる倍率（設計書 4.1「最初はアイコンだけ」） */
const LABEL_ZOOM = 1.6;

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
  /*
   * いちばん下に、陸のかたちが海へ落とす影を敷く。
   * このあと帯を不透明で塗るので、陸の内側に入った影は隠れ、
   * 海側にはみ出したぶんだけが縁として残り、陸が一段高く見える。
   */
  container.appendChild(
    svg('path', { d: terrain.bands[0].path, 'fill-rule': 'evenodd', class: 'coast-shadow' })
  );

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

    /*
     * data-ax / data-ay は「この印がどこを指しているか」。
     * 拡大したときに、印そのものは画面上の大きさを変えず、
     * この点を動かさないように縮める（scalable / applyScale を参照）。
     */
    const group = svg('g', { class: 'scalable', 'data-ax': p.x, 'data-ay': p.y });
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

    // data-ax / data-ay は線路上の指している地点。拡大してもここは動かない。
    const group = svg('g', {
      class: 'spot scalable',
      'data-theme': spot.theme,
      'data-id': spot.id,
      'data-ax': anchor.x,
      'data-ay': anchor.y,
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
 * 路線と、その名前やバッジがぜんぶ入る四角を求める。
 *
 * 画面の形は端末によって違う（縦長のスマートフォン、横長のパソコン）。
 * そこで、収めたい四角を画面の形に合わせて広げてから当てはめる。
 */
function fittedBox(mapElement, contents) {
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

  return { left, top, width, height };
}

/**
 * 地図の見える範囲を持ちまわる入れもの。
 *
 * 「左上がどこか」ではなく「まんなかがどこか（cx, cy）」と
 * 「地図の 1 単位が画面の何画素にあたるか（unitsPerPixel）」で覚えておく。
 * 拡大・縮小はまんなかを軸に考えるほうが素直に書けるため。
 *
 * unitsPerPixel が小さいほど拡大されている。初期表示のときの値を
 * basisPerPixel として覚えておき、その比を「今の倍率」として使う。
 */
function createView(mapElement, projection, initialBox, onChange) {
  const screen = () => mapElement.getBoundingClientRect();

  const basisPerPixel = initialBox.width / screen().width;
  let unitsPerPixel = basisPerPixel;
  let cx = initialBox.left + initialBox.width / 2;
  let cy = initialBox.top + initialBox.height / 2;

  /** 今、初期表示の何倍まで寄っているか */
  const zoom = () => basisPerPixel / unitsPerPixel;

  function apply() {
    const box = screen();
    const width = unitsPerPixel * box.width;
    const height = unitsPerPixel * box.height;

    /*
     * 地形データのない外側を映さない。
     * 画面より地図のほうが小さいときは寄せようがないので、まんなかに置く。
     */
    let left = cx - width / 2;
    let top = cy - height / 2;
    left = width <= projection.width
      ? Math.max(0, Math.min(projection.width - width, left))
      : (projection.width - width) / 2;
    top = height <= projection.height
      ? Math.max(0, Math.min(projection.height - height, top))
      : (projection.height - height) / 2;

    cx = left + width / 2;
    cy = top + height / 2;

    mapElement.setAttribute(
      'viewBox',
      `${left.toFixed(1)} ${top.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}`
    );
    onChange(unitsPerPixel / basisPerPixel, zoom());
  }

  /** 画面上の一点を動かさないまま、倍率を変える */
  function zoomAt(screenX, screenY, factor) {
    const box = screen();
    const before = unitsPerPixel;
    const after = Math.min(basisPerPixel, Math.max(basisPerPixel / MAX_ZOOM, before / factor));
    if (after === before) return;

    // その画面位置が指している地図上の点。拡大の前後でここを動かさない。
    const offsetX = screenX - box.left;
    const offsetY = screenY - box.top;
    const mapX = cx - before * box.width / 2 + offsetX * before;
    const mapY = cy - before * box.height / 2 + offsetY * before;

    cx = mapX - offsetX * after + after * box.width / 2;
    cy = mapY - offsetY * after + after * box.height / 2;
    unitsPerPixel = after;
    apply();
  }

  /** 指やマウスの動きぶんだけ、地図をずらす */
  function panBy(deltaScreenX, deltaScreenY) {
    cx -= deltaScreenX * unitsPerPixel;
    cy -= deltaScreenY * unitsPerPixel;
    apply();
  }

  /** ある地点を、画面の見えている部分のまんなかへ寄せる（倍率は変えない） */
  function centerOn(mapX, mapY, visibleTopRatio = 0.5) {
    const box = screen();
    // 下半分がカードで隠れるときは、その上の見えている範囲のまんなかへ
    const wantedY = box.height * visibleTopRatio;
    cx = mapX;
    cy = mapY - (wantedY - box.height / 2) * unitsPerPixel;
    apply();
  }

  function reset() {
    unitsPerPixel = basisPerPixel;
    cx = initialBox.left + initialBox.width / 2;
    cy = initialBox.top + initialBox.height / 2;
    apply();
  }

  return { apply, zoomAt, panBy, centerOn, reset, zoom };
}

/**
 * 指・マウス・ホイールでの拡大縮小と移動をつなぐ。
 *
 * 指 1 本ならずらす、2 本ならその間隔の変化で拡大縮小する。
 * ホイールは、指が使えないパソコン向け。
 */
function setUpGestures(mapElement, view, onTap) {
  const active = new Map();
  let previousSpread = 0;
  let movedDistance = 0;
  let tapTarget = null;

  const spread = () => {
    const [a, b] = [...active.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const middle = () => {
    const [a, b] = [...active.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  mapElement.addEventListener('pointerdown', (event) => {
    mapElement.setPointerCapture(event.pointerId);
    active.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (active.size === 1) {
      movedDistance = 0;
      // 指を離した場所が同じなら「押した」とみなすため、覚えておく
      tapTarget = event.target.closest('.spot');
    } else {
      tapTarget = null;
      if (active.size === 2) previousSpread = spread();
    }
  });

  mapElement.addEventListener('pointermove', (event) => {
    const previous = active.get(event.pointerId);
    if (!previous) return;

    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    active.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (active.size === 1) {
      movedDistance += Math.hypot(dx, dy);
      view.panBy(dx, dy);
    } else if (active.size === 2) {
      const now = spread();
      if (previousSpread > 0 && now > 0) {
        const center = middle();
        view.zoomAt(center.x, center.y, now / previousSpread);
      }
      previousSpread = now;
    }
  });

  function release(event) {
    if (!active.has(event.pointerId)) return;
    active.delete(event.pointerId);

    // ほとんど動いていなければ、ずらしたのではなく押したのだと判断する
    if (active.size === 0 && movedDistance < 6 && tapTarget) onTap(tapTarget);
    if (active.size < 2) previousSpread = 0;
    tapTarget = null;
  }
  mapElement.addEventListener('pointerup', release);
  mapElement.addEventListener('pointercancel', release);

  mapElement.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      // 1 回まわすぶんの変化量は端末差が大きいので、ゆるやかに効かせる
      view.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.002));
    },
    { passive: false }
  );
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
  const provisional = fittedBox(mapElement, [
    { left: railBox.left - 80, right: railBox.right + 80, top: railBox.top - 80, bottom: railBox.bottom + 80 },
  ]);
  mapElement.setAttribute(
    'viewBox',
    `${provisional.left} ${provisional.top} ${provisional.width} ${provisional.height}`
  );

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

  // --- ここから、拡大・縮小できるようにする ---

  // 駅名やバッジまで含めた、初期表示の範囲
  const initialBox = fittedBox(mapElement, [railBox, ...placed]);
  const scalables = [...mapElement.querySelectorAll('.scalable')];
  const hillshade = mapElement.querySelector('.hillshade');
  const embossBlur = document.getElementById('coast-emboss-blur');
  const embossOffset = document.getElementById('coast-emboss-offset');

  /*
   * 拡大したときに、文字・印・線の太さが画面上で大きくならないようにする。
   *
   * k は「初期表示に対して、地図の単位でどれだけ縮めるか」。
   * 4 倍に拡大すると k = 1/4 になり、地図の単位では 1/4 の大きさになるが、
   * 画面は 4 倍に引き伸ばされているので、見た目の大きさは変わらない。
   * 初期表示では k = 1 なので、拡大縮小を足す前とまったく同じ見た目になる。
   */
  function onViewChange(k, zoom) {
    for (const element of scalables) {
      const x = element.getAttribute('data-ax');
      const y = element.getAttribute('data-ay');
      // 指している点を動かさないまま、その場で縮める
      element.setAttribute('transform', `translate(${x} ${y}) scale(${k}) translate(${-x} ${-y})`);
    }

    // 線の太さと文字の大きさは CSS 側で calc() を使って合わせる
    mapElement.style.setProperty('--k', k);

    // 陰影の絵は元データの細かさに限りがあるので、寄りすぎたら消す
    if (hillshade) {
      const fade = (zoom - HILLSHADE_FADE_FROM) / (HILLSHADE_FADE_TO - HILLSHADE_FADE_FROM);
      hillshade.style.opacity = 0.85 * (1 - Math.min(1, Math.max(0, fade)));
    }

    // 陸が落とす影も、画面上の厚みが変わらないようにする
    if (embossBlur) embossBlur.setAttribute('stdDeviation', (2.6 * k).toFixed(3));
    if (embossOffset) embossOffset.setAttribute('dy', (2.6 * k).toFixed(3));

    // 絶景スポットの名前は、寄ってから出す（設計書 4.1）
    mapElement.classList.toggle('map--named', zoom >= LABEL_ZOOM);
  }

  const view = createView(mapElement, terrain.projection, initialBox, onViewChange);
  view.apply();
  window.addEventListener('resize', () => view.apply());

  setUpGestures(mapElement, view, (spotElement) => {
    // カードはこのあとの手順で足す
    void spotElement;
  });

  document.getElementById('reset-view').addEventListener('click', () => view.reset());

  setUpThemeFilter(document.getElementById('themes'), spotsLayer.querySelectorAll('.spot'));

  showWeather(document.getElementById('weather'));
}

main().catch((error) => {
  console.error(error);
  const weather = document.getElementById('weather');
  weather.textContent =
    'データを読み込めませんでした。ローカルサーバー経由で開いているか確かめてください。';
});
