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

/** 乗車区間（乗る駅・降りる駅・方向）をブラウザに覚えさせるときの名前 */
const PLAN_KEY = 'choshi-navi/plan';

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

/*
 * 駅にいるとみなす半径（m）。設計書 3.2。
 *
 * 市販の端末の位置情報は 5〜15m ずれ、駅前の建物のあいだではさらに悪くなる。
 * 10m ほどの円にすると、駅に立っていても入れないことがある。
 * 駅どうしは数百 m 以上離れているので、広くしても取り違えはしない。
 */
const STATION_RADIUS_METERS = 80;

/*
 * 歩く程度の速さの上限（m/s）。3 m/s はおよそ時速 11km。
 * これより速く動いていれば、駅にいるのではなく駅を通り過ぎている。
 */
const WALKING_SPEED_LIMIT = 3;

/** 発車待ちで出す、次の発車の本数 */
const DEPARTURE_COUNT = 2;

/** 発車待ちで出す、見どころの数（最大3件、線路上で近い順） */
const LOOKOUT_COUNT = 3;

/** 発車待ちの表示を作り直す間隔（ミリ秒）。発車時刻をまたいだら次の列車に繰り上げる */
const DEPARTURE_REFRESH_MS = 20000;

const SVG_NS = 'http://www.w3.org/2000/svg';

// ------------------------------------------------------------------
// 小さな道具
// ------------------------------------------------------------------

/**
 * 出す・隠すを切り替える。
 *
 * `element.hidden = true` は HTML の要素にしか効かない。SVG の要素
 * （現在位置の印など）では何も起きないので、属性で付け外しする。
 */
function setHidden(element, value) {
  element.toggleAttribute('hidden', value);
}

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
 * 起点からの距離（along, m）から、地図の画面座標を求める。
 *
 * track（Onboard.prepareTrack の結果、緯度経度と累積距離）と、その各点を
 * あらかじめ project() した points を対で使う。区間の途中を線形補間するので、
 * 駅の印（distanceAlong）も現在位置の印（along）もこれで求めれば、
 * 同じ場所にいるときは画面上でも必ず重なる。
 */
function pointAtDistance(track, points, along) {
  const last = track[track.length - 1];
  const clamped = Math.max(0, Math.min(last.along, along));

  let index = 1;
  while (index < track.length - 1 && track[index].along < clamped) index += 1;

  const from = track[index - 1];
  const span = track[index].along - from.along || 1;
  const t = (clamped - from.along) / span;

  const p0 = points[index - 1];
  const p1 = points[index];
  return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
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
function drawStations(container, route, project, points, placed, track) {
  route.stations.forEach((station, i) => {
    /*
     * 駅の印は station.lat/lon ではなく、distanceAlong で線路の上に置く。
     * 駅舎の実際の座標は線路の折れ線から数十m離れていることがあり
     * （route.json の offsetFromTrack）、lat/lon をそのまま使うと、
     * 電車がその駅に停まっているときでも現在位置の印とずれて見える。
     */
    const p = pointAtDistance(track, points, station.distanceAlong);
    const isEnd = i === 0 || i === route.stations.length - 1;
    const radius = isEnd ? 9 : 7;
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

    /*
     * 押すためだけの、見えない丸。いちばん上に置く。
     *
     * ひし形は角が細く、指で押すには小さい。名前を出していないあいだは
     * なおさら的が小さくなるので、バッジのまわりに余裕をもたせる。
     * （揺れる車内で押し間違えないため ── 設計書 4 章）
     */
    group.appendChild(
      svg('circle', {
        cx: chosen.cx.toFixed(1),
        cy: chosen.cy.toFixed(1),
        r: BADGE_SIZE * 1.8,
        class: 'spot-hit',
      })
    );
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

  /*
   * ゆっくり動かす。
   *
   * 毎回「始まりの値」から測り直しているのは、apply() が地図の外へ
   * はみ出さないように値を丸めることがあるため。丸められた値をもとに
   * 次の一歩を決めると、途中で動きが引っかかる。
   */
  let animation = null;
  function animateTo(targetX, targetY, targetPerPixel, duration = 340) {
    stopAnimation();
    const fromX = cx;
    const fromY = cy;
    const fromPerPixel = unitsPerPixel;
    const start = performance.now();

    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // 終わりぎわでゆるやかに止まる
      cx = fromX + (targetX - fromX) * eased;
      cy = fromY + (targetY - fromY) * eased;
      // 倍率は掛け算で変わるものなので、比を掛けて進める
      unitsPerPixel = fromPerPixel * Math.pow(targetPerPixel / fromPerPixel, eased);
      apply();
      animation = t < 1 ? requestAnimationFrame(step) : null;
    }
    animation = requestAnimationFrame(step);
  }

  function stopAnimation() {
    if (animation !== null) cancelAnimationFrame(animation);
    animation = null;
  }

  /**
   * ある地点を、画面の「見えている部分」のまんなかへ寄せる（倍率は変えない）。
   * @param {number} visibleHeight カードなどで隠れていない、上からの高さ（画素）
   */
  function centerOn(mapX, mapY, visibleHeight) {
    const box = screen();
    const wantedY = (visibleHeight ?? box.height) / 2;
    animateTo(mapX, mapY - (wantedY - box.height / 2) * unitsPerPixel, unitsPerPixel);
  }

  function reset() {
    animateTo(
      initialBox.left + initialBox.width / 2,
      initialBox.top + initialBox.height / 2,
      basisPerPixel
    );
  }

  /**
   * ある地点へ寄る。倍率も指定できる（省略すれば今のまま）。
   * 車上モードで現在位置を追いかけるのに使う（設計書 4.3）。
   *
   * @param {number} [zoomLevel] 初期表示の何倍か
   * @param {number} [duration] かける時間（ミリ秒）。追従では短くする
   */
  function goTo(mapX, mapY, zoomLevel, duration = 340) {
    animateTo(
      mapX,
      mapY,
      zoomLevel === undefined ? unitsPerPixel : basisPerPixel / zoomLevel,
      duration
    );
  }

  return { apply, zoomAt, panBy, centerOn, goTo, reset, zoom, stopAnimation };
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
    view.stopAnimation(); // 動いている途中でも、指の操作を優先する
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

    // ほとんど動いていなければ、ずらしたのではなく押したのだと判断する。
    // 何もないところを押したときは null を渡す（カードを閉じるため）。
    if (active.size === 0 && movedDistance < 6) onTap(tapTarget);
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

/**
 * @returns {{isHidden: (theme: string) => boolean}}
 *          消されているテーマを、あとから他の表示（発車待ちの見どころ）でも使うため
 */
function setUpThemeFilter(container, mapSpots, onApply) {
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

    if (onApply) onApply();
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

  return { isHidden: (theme) => hidden.has(theme) };
}

// ------------------------------------------------------------------
// 発車待ち（設計書 4.2）
//
// 駅に着いてから乗るまでの数分は、乗客がいちばん自由に画面を見られる時間。
// ここで「どちら側に座るか」を決められるようにする。
//
// 出す時刻は時刻表の予定であって、実際の運行ではない。
// 分単位のカウントダウンは出さない（設計書 4.2 の理由を参照）。
// ------------------------------------------------------------------

/** 2 地点の距離（m）。全長 6.4km の範囲なので、地球を球とみなせば十分。 */
function distanceMeters(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

/**
 * いまいる場所が、どの駅の構内とみなせるか。
 * どの駅からも離れているか、電車の速さで動いていれば null。
 */
function stationAt(route, coords) {
  // 速さがわかっていて、それが歩く速さを超えていれば、通り過ぎているところ
  if (coords.speed !== null && coords.speed !== undefined && coords.speed > WALKING_SPEED_LIMIT) {
    return null;
  }

  let nearest = null;
  for (const station of route.stations) {
    const distance = distanceMeters(coords.latitude, coords.longitude, station.lat, station.lon);
    if (distance <= STATION_RADIUS_METERS && (nearest === null || distance < nearest.distance)) {
      nearest = { station, distance };
    }
  }
  return nearest && nearest.station;
}

// ------------------------------------------------------------------
// 乗車区間の設定（feature-spec「乗車区間の設定」）
//
// 乗る駅・降りる駅を初回起動時に選ばせ、区間・方向をブラウザに覚えさせる。
// モード自動判定（設計書3.2）は変えない。ここで持つのはあくまで
// 「発車待ち・接近通知をどこまで絞るか」の下書きで、実際の位置情報が
// いつでも優先される（食い違えば一度だけ気づかせるだけ）。
// ------------------------------------------------------------------

function loadPlan() {
  try {
    const saved = localStorage.getItem(PLAN_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

function savePlan(plan) {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
  } catch {
    // 保存できない設定のブラウザでも、その場での動きは変えない
  }
}

function stationDistance(route, name) {
  const station = route.stations.find((s) => s.name === name);
  return station ? station.distanceAlong : null;
}

/** 2駅の並び順から方向を決める。route.stations は銚子→外川の順（distanceAlong昇順）。 */
function directionFor(route, board, alight) {
  return stationDistance(route, board) < stationDistance(route, alight) ? '下り' : '上り';
}

/** 区間の範囲（distanceAlongのmin/max）。planが無ければnull（絞り込まない）。 */
function planRange(route, plan) {
  if (!plan) return null;
  const a = stationDistance(route, plan.board);
  const b = stationDistance(route, plan.alight);
  if (a === null || b === null) return null;
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** 区間の中にあるスポットだけを残す。planが無ければ全部残す。 */
function withinPlan(route, plan, spots) {
  const range = planRange(route, plan);
  if (!range) return spots;
  return spots.filter((spot) => spot.distanceAlong >= range.lo && spot.distanceAlong <= range.hi);
}

/**
 * 食い違い確認で「直す」を選んだときの降車駅。
 * 既存の設定が新しい方向・乗車駅と整合すればそのまま使い、整合しなければ
 * （例: 方向そのものが変わった）その方向の終点をひとまずの降車駅とする。
 */
function correctedAlight(route, board, direction, oldAlight) {
  if (oldAlight) {
    const boardDist = stationDistance(route, board);
    const oldDist = stationDistance(route, oldAlight);
    const consistent = direction === '下り' ? oldDist > boardDist : oldDist < boardDist;
    if (consistent) return oldAlight;
  }
  return direction === '下り' ? '外川' : '銚子';
}

/** 起点からの距離に、いちばん近い駅の名前 */
function nearestStationName(route, along) {
  let nearest = route.stations[0];
  let best = Infinity;
  for (const station of route.stations) {
    const diff = Math.abs(station.distanceAlong - along);
    if (diff < best) {
      best = diff;
      nearest = station;
    }
  }
  return nearest.name;
}

/**
 * その要素の data-ax/data-ay（指している地図上の点）を動かさないまま、
 * 倍率 k でその場を縮める transform を計算して設定する。
 *
 * 拡大・パンのたびに onViewChange が scalables 全部に対してこれをやり直す。
 * 現在位置マーカーだけは、位置そのものが動くたびに（追従の有無に関係なく）
 * 自分で呼び直す必要がある。さもないと、位置が動いた分と transform の基準点が
 * ずれたまま合成され、地図を操作するまで見た目が追いつかない
 * （かつ、ずれた基準点との合成は線路の曲がり角で線路から外れて見える）。
 */
function setScaleTransform(element, k) {
  const x = element.getAttribute('data-ax');
  const y = element.getAttribute('data-ay');
  element.setAttribute('transform', `translate(${x} ${y}) scale(${k}) translate(${-x} ${-y})`);
}

/** 「上り 左／下り 右」。どちらの向きでも見えるスポットは、そう書く。 */
function sidesText(spot) {
  if (spot.sideUp === '両' && spot.sideDown === '両') return 'どちらの窓でも';
  return `上り ${spot.sideUp}／下り ${spot.sideDown}`;
}

function createStationPanel(route, schedule, spots, themeFilter, getWeather, getPlan) {
  const bar = document.getElementById('station-bar');
  const here = document.getElementById('station-here');
  const departureList = document.getElementById('departures');
  const note = bar.querySelector('.departures-note');
  const weather = document.getElementById('weather');
  const lookout = document.getElementById('lookout');
  const lookoutList = document.getElementById('lookout-list');

  /** いま出している駅。null なら発車待ちではない */
  let current = null;

  function renderDepartures(station) {
    const plan = getPlan();
    const departures = Schedule.nextDepartures(
      schedule, station.name, Schedule.now(), DEPARTURE_COUNT, plan ? plan.direction : undefined
    );
    departureList.replaceChildren();

    if (departures.length === 0) {
      // 終電のあと。翌日の始発は出さない（夜に「次は5:37」と言っても待てない）
      const item = document.createElement('li');
      item.className = 'departures-none';
      item.textContent = 'きょうの運行は終わりました。';
      departureList.appendChild(item);
      note.hidden = true;
      return;
    }

    for (const departure of departures) {
      const time = document.createElement('span');
      time.className = 'departure-time';
      time.textContent = Schedule.toClock(departure.分);

      const towards = document.createElement('span');
      towards.className = 'departure-for';
      towards.textContent =
        `${Schedule.terminusOf(schedule, departure.方向)}方面（${departure.方向}）`;

      const item = document.createElement('li');
      item.append(time, towards);
      departureList.appendChild(item);
    }
    note.hidden = false;
  }

  function renderLookout(station) {
    const plan = getPlan();

    /*
     * 近い順に並べる。乗車区間が設定されていれば、その区間内のスポットだけに絞る
     * （feature-spec「乗車区間の設定」US4）。区間が無ければ今まで通り、
     * 乗る向きが決まっていない前提でこの駅の前後から近いものを出す。
     */
    const nearby = withinPlan(route, plan, spots.filter((spot) => !themeFilter.isHidden(spot.theme)))
      .sort(
        (a, b) =>
          Math.abs(a.distanceAlong - station.distanceAlong) -
          Math.abs(b.distanceAlong - station.distanceAlong)
      )
      .slice(0, LOOKOUT_COUNT);

    lookoutList.replaceChildren();
    for (const spot of nearby) {
      const diamond = document.createElement('span');
      diamond.className = 'lookout-diamond';
      diamond.style.setProperty('--spot-color', THEMES[spot.theme].color);

      const name = document.createElement('span');
      name.className = 'lookout-name';
      name.textContent = spot.name;

      const sides = document.createElement('span');
      sides.className = 'lookout-sides';
      /*
       * 区間から方向が決まっていれば、見るべき片側だけを言う
       * （「上り左／下り右」の併記をやめる。項目3・US4）。
       * 決まっていなければ、乗る向きがわからない前提で今まで通り両方書く。
       */
      sides.textContent = plan
        ? windowSideText(plan.direction === '下り' ? spot.sideDown : spot.sideUp)
        : sidesText(spot);

      const item = document.createElement('li');
      item.append(diamond, name, sides);

      /*
       * 天気に合うスポットだけ、一言添える。
       * 合わない（bad）側はここでは何も言わない。悪い予告は地図バッジの
       * 弱め表現だけで十分で、リストにまで否定的な言葉を並べると
       * 「これから乗る区間の見どころ」という前向きな案内の趣旨とずれる。
       */
      if (weatherMatch(spot, getWeather()) === 'good') {
        item.classList.add('lookout-item--weather-good');
        const hint = document.createElement('span');
        hint.className = 'lookout-weather';
        hint.textContent = '今日はよく見えそう';
        item.appendChild(hint);
      }

      lookoutList.appendChild(item);
    }

    // 全部のテーマを消したときは、見出しだけが残らないようにする
    lookout.hidden = nearby.length === 0;
    weather.hidden = nearby.length > 0;
  }

  /** 駅に着いたときに一度だけ呼ぶもの（成因カードの絵の先読みに使う） */
  const arriveHandlers = [];

  /** 発車待ちに入る・出る・中身を作り直す。すべてここを通る。 */
  function update(station) {
    const wasAway = current === null;
    current = station;

    if (station === null) {
      bar.hidden = true;
      lookout.hidden = true;
      weather.hidden = false;
      return;
    }

    here.textContent = `${station.name}駅`;
    renderDepartures(station);
    renderLookout(station);
    bar.hidden = false;

    if (wasAway) for (const handler of arriveHandlers) handler(station);
  }

  // 発車時刻をまたいだら、次の列車へ繰り上げる
  setInterval(() => {
    if (current !== null) renderDepartures(current);
  }, DEPARTURE_REFRESH_MS);

  return {
    update,
    /** テーマの絞り込みが変わったとき */
    refresh: () => {
      if (current !== null) renderLookout(current);
    },
    /** 駅に着いたときに呼ばれる。発車まで数分あるので、重いことはここでやる。 */
    onArrive: (handler) => arriveHandlers.push(handler),
  };
}

// ------------------------------------------------------------------
// 成因カード（設計書 6）
//
// 絶景スポットを通過したあとに出る。予習用の下敷き（4.1）とは別もの。
// 1 スポット 400 字ほどを 5〜6 コマに分け、めくって読む。
// ------------------------------------------------------------------

function createOriginCard(screenElement) {
  const card = document.getElementById('origin');
  const themeElement = document.getElementById('origin-theme');
  const nameElement = document.getElementById('origin-name');
  const panelsElement = document.getElementById('origin-panels');
  const pagerElement = document.getElementById('origin-pager');
  const backButton = document.getElementById('origin-back');
  const nextButton = document.getElementById('origin-next');

  let openedId = null;
  let count = 0;

  /** いま何コマ目が見えているか。横スクロールの位置から求める */
  function currentIndex() {
    const width = panelsElement.clientWidth || 1;
    return Math.round(panelsElement.scrollLeft / width);
  }

  function updatePager() {
    if (count === 0) return;
    const index = currentIndex();
    pagerElement.textContent = `${index + 1} / ${count}`;
    backButton.disabled = index === 0;
    nextButton.disabled = index >= count - 1;
  }

  function scrollToPanel(index) {
    panelsElement.scrollTo({
      left: index * panelsElement.clientWidth,
      behavior: 'smooth',
    });
  }

  panelsElement.addEventListener('scroll', updatePager, { passive: true });
  backButton.addEventListener('click', () => scrollToPanel(currentIndex() - 1));
  nextButton.addEventListener('click', () => scrollToPanel(currentIndex() + 1));

  function open(spot) {
    // 中身がまだ書かれていないスポットでは、空のカードを出さない
    if (!Array.isArray(spot.panels) || spot.panels.length === 0) return false;

    openedId = spot.id;
    count = spot.panels.length;

    const theme = THEMES[spot.theme];
    themeElement.textContent = spot.theme;
    themeElement.style.setProperty('--card-color', theme.color);
    nameElement.textContent = spot.name;

    panelsElement.replaceChildren();
    for (const panel of spot.panels) {
      const item = document.createElement('div');
      item.className = 'origin-panel';

      /*
       * 絵は任意（設計書 6.1）。先読みが間に合わなかったコマ、
       * 通信が無いときのコマは、文だけが残る。
       */
      if (panel.image) {
        const image = document.createElement('img');
        image.className = 'origin-image';
        image.src = panel.image;
        image.alt = '';
        image.loading = 'eager';
        image.style.setProperty('--panel-tint', theme.color + '22');
        // 読めなかった絵は、枠だけ残さず消す
        image.addEventListener('error', () => image.remove());
        item.appendChild(image);
      }

      const text = document.createElement('p');
      text.className = 'origin-text';
      text.textContent = panel.text;
      item.appendChild(text);

      panelsElement.appendChild(item);
    }

    panelsElement.scrollLeft = 0;
    updatePager();

    screenElement.classList.add('screen--carded');
    card.hidden = false;
    // hidden を外した直後だと、せり出す動きが飛ばされる
    requestAnimationFrame(() => card.classList.add('origin--open'));
    return true;
  }

  function close() {
    openedId = null;
    screenElement.classList.remove('screen--carded');
    card.classList.remove('origin--open');
  }

  // 下へはらうと閉じる。予習用の下敷きと同じ操作にそろえる。
  let grabbedAt = null;
  let pulled = 0;

  card.addEventListener('pointerdown', (event) => {
    /*
     * コマを横にめくっている最中と、めくるボタンを押したときは、
     * 閉じる操作を拾わない。ここで setPointerCapture すると、以降の
     * pointerup がボタンではなくこの card 自身に向くようになり、
     * ボタンの click が発火しなくなる（実機確認で見つかった不具合）。
     */
    if (event.target.closest('.origin-panels, .origin-foot')) return;
    grabbedAt = event.clientY;
    pulled = 0;
    card.style.transition = 'none';
    card.setPointerCapture(event.pointerId);
  });

  card.addEventListener('pointermove', (event) => {
    if (grabbedAt === null) return;
    pulled = Math.max(0, event.clientY - grabbedAt);
    card.style.transform = `translateY(${pulled}px)`;
  });

  function letGo() {
    if (grabbedAt === null) return;
    grabbedAt = null;
    card.style.transition = '';
    card.style.transform = '';
    if (pulled > 50) close();
  }
  card.addEventListener('pointerup', letGo);
  card.addEventListener('pointercancel', letGo);

  return { open, close, openedId: () => openedId };
}

/**
 * コマの画像を先に読んでおく（設計書 6.2）。
 *
 * 発車待ちのあいだに呼ぶ。駅にいるあいだは電波がある見込みが高く、
 * 発車まで数分ある。通過するそのときに読みはじめたのでは間に合わない。
 * 失敗しても何もしない。文だけで読めるようにしてある。
 */
function preloadPanelImages(spots) {
  for (const spot of spots) {
    for (const panel of spot.panels || []) {
      if (!panel.image) continue;
      const image = new Image();
      image.src = panel.image;
    }
  }
}

// ------------------------------------------------------------------
// 車上モード（設計書 3.2 / 3.3 / 4.3）
//
// 位置情報を見張り、乗車前・発車待ち・車上・降車後を行き来する。
// 通知・遅れ・現在位置・通過の記録は、すべてここから出る。
// ------------------------------------------------------------------

/** 画面を眠らせない（設計書 4.3）。対応していないブラウザでは何も起きない。 */
function createWakeLock() {
  let sentinel = null;

  async function acquire() {
    if (!('wakeLock' in navigator) || sentinel !== null) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch {
      // 断られた・電池が少ない。通知の帯は出るので、致命的ではない。
    }
  }

  function release() {
    if (sentinel === null) return;
    sentinel.release().catch(() => {});
    sentinel = null;
  }

  /*
   * 写真を撮るとカメラへ移り、このページは隠れる。
   * 仕様では隠れた時点で解除されるので、戻ってきたら取り直す。
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sentinel === null && wanted) acquire();
  });

  let wanted = false;
  return {
    on() { wanted = true; acquire(); },
    off() { wanted = false; release(); },
  };
}

function createTrip(route, spots, schedule, parts) {
  const { stationPanel, spotCard, originCard, view, project, points, spotElements, onRecord, getPlan, setPlan, getK } = parts;
  const track = Onboard.prepareTrack(route);
  const wakeLock = createWakeLock();

  const noticeBar = document.getElementById('notice-bar');
  const noticeLead = document.getElementById('notice-lead');
  const noticeDetail = document.getElementById('notice-detail');
  const riding = document.getElementById('riding');
  const ridingTowards = document.getElementById('riding-towards');
  const ridingDelay = document.getElementById('riding-delay');
  const ridingCount = document.getElementById('riding-count');
  const hereMarker = document.getElementById('map-here');
  const hereArrow = document.getElementById('here-arrow-wrap');
  const shootButton = document.getElementById('shoot');

  const mismatchBar = document.getElementById('mismatch-bar');
  const mismatchText = document.getElementById('mismatch-text');

  /** 乗車前 / 発車待ち / 車上 / 降車後 */
  let mode = '乗車前';
  let along = null;
  let direction = null;
  let speed = null;
  /**
   * 推定の起点となる時刻。onStale が推定するたびに進める（推定のあいだの
   * 経過時間を測るため）。
   */
  let fixedAt = 0;
  /**
   * 最後に「実測」できた時刻。fixedAt とは別に持つ。
   *
   * fixedAt は推定のたびに書き換わるので、これと 60 秒を比べると
   * 「前回の推定から 60 秒」を測ってしまい、実測が戻らないかぎり
   * 打ち切りが永遠に来ない（実機で見つかった不具合）。
   * 「最後に実測できてから 60 秒」を測るには、書き換わらないこの値がいる。
   */
  let lastRealFixAt = 0;
  /**
   * 最後に「実測」できた地点。進行方向はここと次の実測から決める。
   *
   * along のほうは推定でも書き換わる。推定と実測を突き合わせて向きを出すと、
   * 電波が戻ったときの引き戻し（推定が進みすぎていた分）を「後ろへ動いた」と
   * 読んで、下りが上りに裏返る。
   */
  let lastRealAlong = null;
  /** 前回この関数を通ったときの地点。スポットを跨いだかどうかを見るのに使う */
  let lastUpdateAlong = null;
  /** 車上モードに入ったときの地点。終点でまとめて拾う範囲を決めるのに使う */
  let boardedAlong = null;
  /** 乗車区間の食い違いを、このトリップですでに確認したか（1トリップにつき最大1回） */
  let mismatchChecked = false;
  /** 路線から外れはじめた時刻。15 秒続いたら降りたとみなす */
  let offRouteSince = null;
  /** いま通知を出しているスポット。通過するまで次に移らない */
  let noticedId = null;
  let vibratedId = null;
  let delayShown = null;
  /** 遅れを最後に引き直した時刻。null なら「まだこの乗車で引いていない」 */
  let delayCheckedAt = null;
  /** 次に停まる駅（遅れとあわせて「何時にどこへ着く予定か」を出す） */
  let nextStopShown = null;
  /** 追いかけているか。指で地図を動かすとやめる */
  let following = true;
  /**
   * 入るときに寄せたい倍率。届くまでは追従のたびにこれを渡す。
   * 渡さないと、追従が「いまの倍率のまま」を目標にしてしまい、
   * 寄せる動きが毎回打ち消される。
   */
  let wantedZoom = undefined;

  const passed = new Set();
  const passedLog = [];

  // ---- 見た目を書き換える ----

  function showNotice(notice) {
    if (notice === null) {
      noticeBar.hidden = true;
      return;
    }
    const theme = THEMES[notice.spot.theme];
    noticeBar.style.setProperty('--notice-color', theme.color);
    noticeBar.dataset.phase = notice.phase;

    if (notice.phase === 'いま') {
      noticeLead.textContent =
        notice.side === '両' ? 'どちらの車窓を見てください' : `${notice.side}側の車窓を見てください`;
      noticeDetail.textContent = notice.spot.name;
    } else {
      noticeLead.textContent = `まもなく ${notice.spot.name}`;
      const side = notice.side === '両' ? 'どちらの窓でも' : `${notice.side}の窓`;
      noticeDetail.textContent =
        notice.seconds === null ? side : `${side} ・ あと ${notice.seconds} 秒`;
    }
    noticeBar.hidden = false;
  }

  function showHere() {
    if (along === null) {
      setHidden(hereMarker, true);
      return;
    }
    /*
     * 軌道上の距離から、地図の座標へ戻す。区間の途中を線形補間する
     * （pointAtDistance）。駅の印も同じ関数で置いているので、駅に
     * 停まっているときは駅の印とぴったり重なる。
     */
    const spot = pointAtDistance(track, points, along);

    hereMarker.setAttribute('data-ax', spot.x);
    hereMarker.setAttribute('data-ay', spot.y);
    hereMarker.querySelectorAll('circle').forEach((circle) => {
      circle.setAttribute('cx', spot.x.toFixed(1));
      circle.setAttribute('cy', spot.y.toFixed(1));
    });
    setHidden(hereMarker, false);

    /*
     * 矢印を進行方向へ向ける。いま居る区間（track の前後2点）そのものの
     * 向きを使う。固定距離だけ先の点を探すやり方だと、路線データの点が
     * 疎らな区間（笠上黒生付近など、隣の点まで200m近く空くところがある）で
     * 「先の点」が現在地と同じ点に落ちてしまい、向きが求まらなくなる
     * （atan2(0,0) で 90° 固定になり、線路の曲がりを無視した矢印になる）。
     * 区間そのものの向きなら、区間の長さに関係なく必ず求まる。
     */
    if (direction !== null) {
      let segIndex = 1;
      while (segIndex < track.length - 1 && track[segIndex].along < along) segIndex += 1;
      const from = project(track[segIndex - 1].lat, track[segIndex - 1].lon);
      const to = project(track[segIndex].lat, track[segIndex].lon);
      let angle = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI + 90;
      if (direction === '上り') angle += 180;
      hereArrow.setAttribute('transform', `translate(${spot.x.toFixed(1)} ${spot.y.toFixed(1)}) rotate(${angle.toFixed(1)})`);
    }

    /*
     * 自分の transform は自分で計算し直す。onViewChange（拡大・パンのたびに
     * scalables 全部をやり直す処理）だけに任せると、following が false の
     * あいだ（地図を指で動かした後）は view.goTo が呼ばれず onViewChange も
     * 走らないため、この位置が動いた分だけ transform の基準点とずれる。
     * 「拡大・縮小しないと現在位置が更新されない」「線路から位置がずれる」
     * という2つの不具合は、どちらもこのずれが原因だった。
     */
    setScaleTransform(hereMarker, getK());

    if (!following) return;
    view.goTo(spot.x, spot.y, wantedZoom, 900);
    // 目当ての倍率まで届いたら、あとは利用者の見え方を尊重する
    if (wantedZoom !== undefined && Math.abs(view.zoom() - wantedZoom) < 0.3) {
      wantedZoom = undefined;
    }
  }

  /** 乗車区間の食い違いを、いま伝えている内容（確認バーの「直す」が使う） */
  let pendingMismatch = null;

  function showMismatch(boardStation, dir) {
    pendingMismatch = { boardStation, direction: dir };
    mismatchText.textContent =
      `${boardStation}から${Schedule.terminusOf(schedule, dir)}方面（${dir}）へお乗りのようです。設定を直しますか？`;
    mismatchBar.hidden = false;
  }

  document.getElementById('mismatch-fix').addEventListener('click', () => {
    if (!pendingMismatch) return;
    const plan = getPlan();
    const alight = correctedAlight(
      route, pendingMismatch.boardStation, pendingMismatch.direction, plan && plan.alight
    );
    setPlan({ board: pendingMismatch.boardStation, alight, direction: pendingMismatch.direction });
    mismatchBar.hidden = true;
    pendingMismatch = null;
  });

  document.getElementById('mismatch-keep').addEventListener('click', () => {
    mismatchBar.hidden = true;
    pendingMismatch = null;
  });

  function showRiding() {
    ridingTowards.textContent =
      direction === null ? '' : `${Schedule.terminusOf(schedule, direction)}方面（${direction}）`;
    ridingCount.textContent = `${passed.size}/${spots.length} 通過`;

    if (delayShown === null) {
      ridingDelay.hidden = true;
    } else {
      /*
       * 遅れているときだけ、次に停まる駅への到着予定時刻も添える
       * （例:「約3分遅れ・笠上黒生 9:18着」）。乗り継ぎの間に合うかどうかは、
       * 遅れの分数だけでなく実際の時刻で判断したいという声を踏まえた。
       * 遅れていないときにまで出すと、この表示自体の「遅れている」という
       * 意味が薄まるので、条件は今まで通り delayShown が出ているときだけにする。
       */
      const eta = nextStopShown
        ? `・${nextStopShown.station} ${Schedule.toClock(nextStopShown.scheduledMinute + delayShown)}着`
        : '';
      ridingDelay.textContent = `約${delayShown}分遅れ${eta}`;
      ridingDelay.hidden = false;
    }
  }

  // ---- モードの出入り（設計書 3.2）----

  function enterRiding() {
    if (mode === '車上') return;
    mode = '車上';
    stationPanel.update(null);
    riding.hidden = false;
    shootButton.hidden = false;
    // 天候のひとことは乗車前のもの。車上では足もとの表示に場所を譲る
    document.getElementById('weather').hidden = true;
    wakeLock.on();
    following = true;
    // 前の乗車の名残りを持ちこさない
    offRouteSince = null;
    delayShown = null;
    delayCheckedAt = null;
    nextStopShown = null;
    lastUpdateAlong = null;
    boardedAlong = null;
    mismatchChecked = false;
    mismatchBar.hidden = true;
    /*
     * 向きは、乗ってからの動きで決め直す。
     *
     * ホームを歩いているあいだにも向きは付いてしまうが、それは乗る向きとは
     * 関係がない。いちど決まった向きは簡単には裏返らない（directionOf）ので、
     * 歩いて付いた向きを持ちこむと、車窓の左右が逆のまま直らないことがある。
     */
    direction = null;

    /*
     * 入るときに一度だけ寄せる。1 倍のままだと 6.4km 全体が画面に入っていて、
     * 現在位置の印が動くだけで、次のスポットがどちら側かが読み取れない。
     * そのあとは利用者の操作を優先する（設計書 4.3）。
     */
    if (view.zoom() < 3) wantedZoom = 4;
    showRiding();
  }

  function leaveRiding(next) {
    if (mode !== '車上') return;
    mode = next;
    riding.hidden = true;
    shootButton.hidden = true;
    setHidden(hereMarker, true);
    showNotice(null);
    wakeLock.off();
    noticedId = null;
    wantedZoom = undefined;
    // 乗車前に戻るなら、天候のひとことも戻す
    if (next === '乗車前') document.getElementById('weather').hidden = false;
  }

  /** 終点に着いた。まだ通過扱いでないスポットを拾ってから降車後へ（設計書 3.2）*/
  function arrive() {
    /*
     * 電波が届かない区間で拾いそこねたぶんを、ここで記録に足す。
     *
     * 足すのは、乗った地点から終点までのあいだにあるものだけ。乗る前に
     * 通り過ぎている区間のものまで足すと、見ていない景色が記録に並ぶ。
     *
     * 成因カードは出さない（silent）。出すと、着いた瞬間に残りのぶんだけ
     * カードが立て続けに開き、そのうえへ旅の記録がかぶさる。
     */
    for (const spot of spots) {
      if (passed.has(spot.id)) continue;
      const beforeBoarding = boardedAlong !== null && (direction === '下り'
        ? spot.distanceAlong < boardedAlong
        : spot.distanceAlong > boardedAlong);
      if (beforeBoarding) continue;
      markPassed(spot, { detected: false, silent: true });
    }
    leaveRiding('降車後');
    onRecord({ mode: '降車後', passed: passedLog, direction });
  }

  function markPassed(spot, options = {}) {
    if (passed.has(spot.id)) return;
    passed.add(spot.id);
    passedLog.push({
      id: spot.id,
      name: spot.name,
      theme: spot.theme,
      at: new Date().toISOString(),
      detected: options.detected !== false,
    });

    // 地図のバッジを、押せば成因カードが読めるものに変える（設計書 6.2）
    const element = spotElements.get(spot.id);
    if (element) element.classList.add('spot--passed');

    /*
     * 予習用の下敷き（4.1）が開いたままだと、成因カードと二重に重なる。
     * 車上モードでバッジを押して下敷きを見ているあいだに通過することは
     * 普通に起こりうるので、自動で出すときも必ず先に下敷きを閉じる。
     */
    if (options.silent !== true) {
      spotCard.close();
      originCard.open(spot);
    }
    onRecord({ mode, passed: passedLog, direction });
  }

  // ---- 位置情報が来るたび ----

  function onPosition(coords, timestamp) {
    const place = Onboard.projectOntoTrack(track, coords.latitude, coords.longitude);
    const onRoute = place.offset <= Onboard.ON_ROUTE_METERS;

    along = place.along;
    speed = coords.speed;
    fixedAt = timestamp;
    lastRealFixAt = timestamp;

    /*
     * 向きは実測どうしで見る（推定を混ぜない。lastRealAlong の説明を参照）。
     *
     * 比べ元は、決められるだけ動いたときにだけ進める（trackDirection）。
     * 位置情報が細かく来ると 1 回の差が判定に要る距離に届かず、毎回進めていると
     * いつまでも向きが決まらない。向きが決まらないあいだは通知も通過の記録も
     * 止まる（updateRiding）ので、車窓の案内そのものが出なくなる。
     */
    if (lastRealAlong === null) {
      lastRealAlong = along;
    } else {
      const tracked = Onboard.trackDirection(lastRealAlong, along, direction);
      direction = tracked.direction;
      lastRealAlong = tracked.anchorAlong;
    }

    if (mode === '車上') {
      // 停車では抜けない。抜けるのは路線から離れたときだけ（設計書 3.2）
      if (onRoute) {
        offRouteSince = null;
      } else {
        if (offRouteSince === null) offRouteSince = timestamp;
        if (timestamp - offRouteSince >= Onboard.OFF_ROUTE_LIMIT_MS) {
          leaveRiding('乗車前');
          return;
        }
      }

      // 終点に着いたか。終点駅の 80m 以内で、かつ停まっている
      const station = stationAt(route, coords);
      if (station && (station.name === '銚子' || station.name === '外川')) {
        const isEndOfLine =
          (direction === '下り' && station.name === '外川') ||
          (direction === '上り' && station.name === '銚子');
        if (isEndOfLine) {
          arrive();
          return;
        }
      }

      updateRiding(timestamp);
      return;
    }

    // まだ乗っていない
    if (Onboard.looksLikeRiding(track, coords)) {
      enterRiding();
      updateRiding(timestamp);
      return;
    }

    stationPanel.update(stationAt(route, coords) || null);
  }

  /** 車上モードのあいだ、毎回やること */
  function updateRiding(timestamp) {
    showHere();

    /*
     * 進行方向が決まるまでは、通知も通過の記録もしない。
     *
     * 向きは位置が 2 回そろってはじめて決まる（directionOf）。それまでを
     * 「上り」と決めうちすると、前方のスポットが全部「もう通り過ぎた」側に
     * 入ってしまい、乗ってからアプリを開いた人には、開いた瞬間に 6 件とも
     * 通過済みになる。1 回ぶん黙って待てば済む。
     */
    if (direction === null) {
      showNotice(null);
      showRiding();
      return;
    }
    if (boardedAlong === null) boardedAlong = along;

    /*
     * 乗車区間の食い違い確認（feature-spec「乗車区間の設定」US7）。
     * 方向が決まった、このトリップで最初の瞬間に一度だけ見る。
     * 実際の乗車駅は、乗った地点にいちばん近い駅で代用する
     * （乗った瞬間はもう電車の速さで動いているので、駅の中にいるとは判定できない）。
     */
    if (!mismatchChecked) {
      mismatchChecked = true;
      const plan = getPlan();
      const boardStation = nearestStationName(route, boardedAlong);
      if (plan && (plan.board !== boardStation || plan.direction !== direction)) {
        showMismatch(boardStation, direction);
      }
    }

    /*
     * 通過したスポットを拾う。
     *
     * 見るのは「前回いた地点と今いる地点のあいだを跨いだか」。
     * 「もう後ろにあるか」で見ると、途中の駅から乗った人には、乗った
     * その瞬間に手前のスポットが全部通過済みになる。見ていないものが
     * 旅の記録に並び、成因カードまで開いてしまう。
     *
     * 進んだ向きが進行方向と合っているときだけ数える。電波が戻ったときの
     * 引き戻しでスポットを「通過」させないため。
     */
    if (lastUpdateAlong !== null) {
      const wentForward = direction === '下り' ? along > lastUpdateAlong : along < lastUpdateAlong;
      if (wentForward) {
        const low = Math.min(lastUpdateAlong, along);
        const high = Math.max(lastUpdateAlong, along);
        for (const spot of spots) {
          if (passed.has(spot.id)) continue;
          if (spot.distanceAlong >= low && spot.distanceAlong <= high) markPassed(spot);
        }
      }
    }
    lastUpdateAlong = along;

    /*
     * 通知。前のスポットを通過するまで、次には移らない（設計書 4.3）。
     * 乗車区間が設定されていれば、区間外のスポットには接近通知を出さない
     * （通過判定・成因カード・旅の記録は区間の内外にかかわらず今まで通り。US5）。
     */
    const ahead = withinPlan(route, getPlan(), Onboard.spotsAhead(spots, along, direction));
    const target = noticedId
      ? spots.find((spot) => spot.id === noticedId && !passed.has(spot.id))
      : ahead[0];

    const notice = target && !passed.has(target.id)
      ? Onboard.noticeFor(target, along, direction, speed)
      : null;

    showNotice(notice);
    noticedId = notice ? notice.spot.id : null;

    // 振動は 1 スポットにつき一度だけ。短く 1 回（設計書 4.3）
    if (notice && vibratedId !== notice.spot.id) {
      vibratedId = notice.spot.id;
      if (navigator.vibrate) navigator.vibrate(200);
    }

    /*
     * 遅れは 30 秒ごと。毎秒引き直すと、誤差でちらつく（設計書 4.3）。
     *
     * ただし乗るたびに測り直す（delayCheckedAt は enterRiding で null に戻す）。
     * 前の乗車の時刻を持ちこすと、次に乗ったときの一発目が 30 秒待たされる。
     * さらに時計が巻き戻った場合も引き直す。テスト走行で乗り直すと、次の列車が
     * 前の列車より早い時刻の便になり、引き算が負になって以後ずっと
     * 引き直されなくなる（遅れ表示がその乗車のあいだ出ないままになる）。
     */
    if (delayCheckedAt === null ||
        timestamp < delayCheckedAt ||
        timestamp - delayCheckedAt >= 30000) {
      delayCheckedAt = timestamp;
      delayShown = Onboard.delayMinutes(Schedule, schedule, route, direction, along, Schedule.now());
      nextStopShown = Onboard.nextStopEta(Schedule, schedule, route, direction, along, Schedule.now());
    }
    showRiding();
  }

  /**
   * 位置情報が来ないまま時間が経ったとき（設計書 3.3）。
   * 直前の速度で進んだものとして推定する。ただし 60 秒まで。
   */
  function onStale(now) {
    if (mode !== '車上' || along === null) return;

    // 「最後に実測できてから」何秒か。fixedAt ではなく lastRealFixAt で測る。
    if (now - lastRealFixAt > Onboard.DEAD_RECKON_LIMIT_MS) {
      // これ以上は当てにならない。黙る。
      showNotice(null);
      setHidden(hereMarker, true);
      return;
    }
    // 向きが定まっていなければ、進む方向を当てずっぽうにするより止まっていたほうがよい
    // （2 点そろう前に電波が途切れると、まだ direction が決まっていない）。
    if (speed === null || speed <= 0 || direction === null) return;

    const silence = now - fixedAt;
    const moved = speed * (silence / 1000);
    along += direction === '下り' ? moved : -moved;
    fixedAt = now;
    updateRiding(now);
  }

  // ---- 地図を指で動かしたら追うのをやめる（設計書 4.3）----

  function stopFollowing() {
    following = false;
  }

  return {
    onPosition,
    onStale,
    stopFollowing,
    resumeFollowing() { following = true; showHere(); },
    mode: () => mode,
    passedLog: () => passedLog,
    isPassed: (id) => passed.has(id),
  };
}

/** 旅の記録を組み立てる（中身は js/journal.js） */
function createJournal(spots, closings) {
  return Journal.create(spots, THEMES, closings || {});
}

/**
 * 撮影ボタン（設計書 7.1）。
 *
 * capture を付けた file input なので、押すと端末のカメラがそのまま開く。
 * 撮った写真は、そのとき直近だった絶景スポットと一緒にしまう。
 */
function setUpPhotoButton(journal, passedLog) {
  const input = document.getElementById('shoot-input');

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    // 直近に通過したスポットを「そのあたりで撮ったもの」として覚えておく
    const log = passedLog();
    const near = log.length > 0 ? log[log.length - 1].name : null;

    await journal.savePhoto(file, near).catch(() => {
      // しまえなくても、写真は端末のカメラロールに残っている
    });
    input.value = '';
  });
}

/**
 * テスト用の走行シミュレーターを持ち出すか（URL に ?demo=1）。
 *
 * 銚子まで行かないと車上モードを確かめられない、では手が足りない。
 * 付いていないときは js/simulate.js を読みにも行かないので、
 * 本番の画面はこの仕掛けをまったく通らない。
 */
function demoRequested() {
  return new URLSearchParams(location.search).has('demo');
}

/** 追加のスクリプトを 1 本読む（ビルド工程がないので、その場で足す）*/
function loadScript(source) {
  return new Promise((resolve, reject) => {
    const element = document.createElement('script');
    element.src = source;
    element.onload = resolve;
    element.onerror = () => reject(new Error(`${source} を読めなかった`));
    document.head.appendChild(element);
  });
}

/**
 * 位置情報を見張る。
 *
 * 断られたら何もしない。位置情報がなくても地図は使えるので、
 * 発車待ちと車上モードが出なくなるだけで、他は変わらない。
 */
function watchPosition(trip) {
  if (!navigator.geolocation) return;

  navigator.geolocation.watchPosition(
    (position) => trip.onPosition(position.coords, Date.now()),
    () => {
      // 断られた・取れなかった。乗車前モードのままでよい。
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
  );

  // 位置情報が来ないあいだも時間は進む。推定はこちらで回す。
  setInterval(() => trip.onStale(Date.now()), 2000);
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

/**
 * 天気予報から、今日の天候区分（晴・曇・雨・雪のいずれか）だけを取り出す。
 * 取れなければ例外を投げる（呼び出し側で「わからない」として扱う）。
 */
async function fetchTodayWeather() {
  const forecast = await loadJson(JMA_CHIBA);

  // 銚子は「北東部」。見つからなければ最初の区分を使う。
  const areas = forecast[0].timeSeries[0].areas;
  const area = areas.find((a) => a.area.name.includes('北東部')) || areas[0];
  const weather = area.weathers[0].replace(/\s+/g, '');

  // 「くもり所により雨」のような長い言い方は、先頭のひと言だけにする。
  // ひとことも同じ短い言い方から選ぶ。
  // （「きょうはくもり」と言いながら雨の話をすると、ちぐはぐになるため）
  return weather.split(/のち|時々|一時|所により|後/)[0];
}

/**
 * スポットが今日の天気とどう合うか。
 *
 * good … 今日の天気なら特によく見える（地図バッジのフチを暖色にする）
 * bad  … 見えにくいかもしれない（地図バッジの彩度・不透明度を落とす）
 * neutral … 天気の影響なし（`weather` を持たないスポットは常にこれ）
 *
 * 天気がわからない（通信できない）ときも neutral として扱う。
 * 断定できない情報で強調・弱めをするのは、予報の粒度（広域・区分のみ）に合わないため。
 */
function weatherMatch(spot, short) {
  if (!short || !spot.weather) return 'neutral';
  if (spot.weather.good && spot.weather.good.includes(short)) return 'good';
  if (spot.weather.bad && spot.weather.bad.includes(short)) return 'bad';
  return 'neutral';
}

// ------------------------------------------------------------------
// 絶景スポットの下敷き（乗車前の予習用）
//
// これは成因カード（設計書 6）ではない。
// 成因カードは車上モードで、そのスポットを通り過ぎたあとに出すもの。
// ここで答えるのは「どこで、どちら側の窓を見ればいいか」だけにする。
// ------------------------------------------------------------------

/** 「右」→「右の窓」。両側から見えるスポットもあるので、そこだけ書き分ける。 */
function windowSideText(side) {
  return side === '両' ? '両側の窓' : `${side}の窓`;
}

const DURATION_TEXT = {
  '短': 'みじかい（すぐ過ぎる）',
  '中': 'ふつう',
  '長': 'ながい（ゆっくり見られる）',
};

function createSpotCard(screenElement, view, getWeather) {
  const card = document.getElementById('spot-card');
  const themeElement = document.getElementById('spot-card-theme');
  const nameElement = document.getElementById('spot-card-name');
  const placeElement = document.getElementById('spot-card-place');
  const summaryElement = document.getElementById('spot-card-summary');
  const factsElement = document.getElementById('spot-card-facts');

  let openedId = null;

  function addFact(term, description) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = description;
    factsElement.append(dt, dd);
  }

  function open(spot, anchor) {
    openedId = spot.id;

    themeElement.textContent = spot.theme;
    themeElement.style.setProperty('--card-color', THEMES[spot.theme].color);
    nameElement.textContent = spot.name;
    placeElement.textContent = spot.location;
    summaryElement.textContent = spot.summary;

    factsElement.replaceChildren();
    /*
     * 乗車前は、その人が上りに乗るのか下りに乗るのかわからない。
     * 選ばせるより、両方書いてしまうほうが予習には向いている。
     */
    addFact('外川ゆき（下り）', windowSideText(spot.sideDown));
    addFact('銚子ゆき（上り）', windowSideText(spot.sideUp));
    addFact('見ごろ', spot.season);
    addFact('見える時間', DURATION_TEXT[spot.duration] || spot.duration);

    /*
     * 「その天気でないと実質見えない」種類のスポットだけ、控えめに注意を添える。
     * 気象庁の予報は広域（千葉県北東部）でしかないので、断定はせず「ことがある」に留める。
     */
    if (spot.weather?.critical && weatherMatch(spot, getWeather()) === 'bad') {
      addFact('きょうの空模様', 'かすんで見えないことがあります');
    }

    screenElement.classList.add('screen--carded');
    card.classList.add('card--open');

    /*
     * カードに隠れていない範囲のまんなかへ、その地点を寄せる。
     * カードの高さは中身によって変わるので、出したあとに測る。
     */
    requestAnimationFrame(() => {
      const covered = card.getBoundingClientRect().height + 20;
      view.centerOn(anchor.x, anchor.y, screenElement.clientHeight - covered);
    });
  }

  function close() {
    openedId = null;
    screenElement.classList.remove('screen--carded');
    card.classList.remove('card--open');
  }

  // 下へはらうと閉じる
  let grabbedAt = null;
  let pulled = 0;

  card.addEventListener('pointerdown', (event) => {
    grabbedAt = event.clientY;
    pulled = 0;
    card.style.transition = 'none';
    card.setPointerCapture(event.pointerId);
  });

  card.addEventListener('pointermove', (event) => {
    if (grabbedAt === null) return;
    // 上へは動かさない。カードは下からせり出しているものなので。
    pulled = Math.max(0, event.clientY - grabbedAt);
    card.style.transform = `translateY(${pulled}px)`;
  });

  function letGo() {
    if (grabbedAt === null) return;
    grabbedAt = null;
    card.style.transition = '';
    card.style.transform = '';
    if (pulled > 50) close();
  }
  card.addEventListener('pointerup', letGo);
  card.addEventListener('pointercancel', letGo);

  return { open, close, openedId: () => openedId };
}

// ------------------------------------------------------------------
// 組み立て
// ------------------------------------------------------------------

async function main() {
  const mapElement = document.getElementById('map');

  const [terrain, route, spotsFile, schedule] = await Promise.all([
    loadJson('data/terrain.json'),
    loadJson('data/route.json'),
    loadJson('data/spots.json'),
    loadJson('data/schedule.json'),
  ]);

  const project = makeProjection(terrain.projection);
  const points = route.track.map(([lat, lon]) => project(lat, lon));
  const track = Onboard.prepareTrack(route);

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

  drawStations(document.getElementById('map-stations'), route, project, points, placed, track);

  const spotsLayer = document.getElementById('map-spots');
  drawSpots(spotsLayer, spotsFile.spots, route, project, points, placed);

  // --- ここから、拡大・縮小できるようにする ---

  // 駅名やバッジまで含めた、初期表示の範囲
  const initialBox = fittedBox(mapElement, [railBox, ...placed]);
  const scalables = [...mapElement.querySelectorAll('.scalable')];
  const hillshade = mapElement.querySelector('.hillshade');
  // 現在位置マーカーが、追従の有無に関係なく自分の transform を計算し直すのに使う
  let currentK = 1;
  const getK = () => currentK;
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
    currentK = k;
    for (const element of scalables) setScaleTransform(element, k);

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

  // 地図が動かせる状態になったので、読み込み中の表示を退ける
  document.getElementById('loading').hidden = true;

  // --- 絶景スポットを押すと出る下敷き ---

  const spotById = new Map(spotsFile.spots.map((spot) => [spot.id, spot]));

  // 今日の天候区分（晴/曇/雨/雪）。わかるまでは null（= neutral 扱い）
  let currentWeather = null;
  const getWeather = () => currentWeather;

  const card = createSpotCard(document.querySelector('.screen'), view, getWeather);

  function openCardFor(spotElement) {
    const spot = spotById.get(spotElement.getAttribute('data-id'));
    if (!spot) return;
    card.open(spot, {
      x: Number(spotElement.getAttribute('data-ax')),
      y: Number(spotElement.getAttribute('data-ay')),
    });
  }

  /*
   * バッジを押したときに出るものは、通過したかどうかで変わる（設計書 6.2）。
   * まだなら予習用の下敷き、通過したあとなら成因カード。
   */
  const originCard = createOriginCard(document.querySelector('.screen'));
  let trip = null;

  function openForSpot(spotElement) {
    const spot = spotById.get(spotElement.getAttribute('data-id'));
    if (!spot) return;

    if (trip && trip.isPassed(spot.id) && originCard.open(spot)) {
      card.close();
      return;
    }
    openCardFor(spotElement);
  }

  setUpGestures(mapElement, view, (spotElement) => {
    if (spotElement) openForSpot(spotElement);
    else {
      // 何もないところを押したら閉じる
      card.close();
      originCard.close();
    }
  });

  // キーボードでも開けるようにする（バッジは role="button" にしてある）
  for (const spotElement of spotsLayer.querySelectorAll('.spot')) {
    spotElement.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openForSpot(spotElement);
    });
  }

  /*
   * 右下のボタン。乗車前は「路線全体へ」、車上モードでは「現在位置へ」戻る
   * （設計書 4.1）。どちらも「見失ったら押す」という同じ意味になる。
   */
  document.getElementById('reset-view').addEventListener('click', () => {
    if (trip && trip.mode() === '車上') trip.resumeFollowing();
    else view.reset();
  });

  /*
   * 発車待ちの見どころもテーマの絞り込みに従う。
   * 絞り込みを先に作り、そのあとで発車待ちに渡す。
   */
  let stationPanel = null;

  const themeFilter = setUpThemeFilter(
    document.getElementById('themes'),
    spotsLayer.querySelectorAll('.spot'),
    () => {
      // 絞り込みで消えたスポットのカードが開いたままにならないようにする
      const opened = card.openedId();
      if (opened) {
        const element = spotsLayer.querySelector(`.spot[data-id="${opened}"]`);
        if (element && element.classList.contains('spot--hidden')) card.close();
      }
      if (stationPanel) stationPanel.refresh();
    }
  );

  // --- 乗車区間の設定（feature-spec「乗車区間の設定」）---

  let currentPlan = loadPlan();
  const getPlan = () => currentPlan;

  const planSetup = document.getElementById('plan-setup');
  const planClose = document.getElementById('plan-close');
  const planBoard = document.getElementById('plan-board');
  const planAlight = document.getElementById('plan-alight');
  const planError = document.getElementById('plan-error');
  const planSubmit = document.getElementById('plan-submit');
  const planChip = document.getElementById('plan-chip');

  for (const station of route.stations) {
    for (const select of [planBoard, planAlight]) {
      const option = document.createElement('option');
      option.value = option.textContent = station.name;
      select.appendChild(option);
    }
  }

  function updatePlanChip() {
    planChip.hidden = !currentPlan;
    if (currentPlan) planChip.textContent = `${currentPlan.board}→${currentPlan.alight}`;
  }

  function updatePlanValidity() {
    const same = planBoard.value === planAlight.value;
    planSubmit.disabled = same;
    planError.hidden = !same;
  }

  /** 選び直すときに開く。初回（未設定）は閉じるボタンを出さない（スキップさせないため） */
  function openPlanSetup() {
    if (currentPlan) {
      planBoard.value = currentPlan.board;
      planAlight.value = currentPlan.alight;
    }
    planClose.hidden = !currentPlan;
    updatePlanValidity();
    planSetup.hidden = false;
  }

  function setPlan(plan) {
    currentPlan = plan;
    savePlan(plan);
    updatePlanChip();
    if (stationPanel) stationPanel.refresh();
  }

  planBoard.addEventListener('change', updatePlanValidity);
  planAlight.addEventListener('change', updatePlanValidity);

  planSubmit.addEventListener('click', () => {
    if (planBoard.value === planAlight.value) return;
    setPlan({
      board: planBoard.value,
      alight: planAlight.value,
      direction: directionFor(route, planBoard.value, planAlight.value),
    });
    planSetup.hidden = true;
  });

  planClose.addEventListener('click', () => { planSetup.hidden = true; });
  planChip.addEventListener('click', () => openPlanSetup());

  updatePlanChip();
  if (!currentPlan) openPlanSetup();

  // --- 出典（設計書 8.3）---

  const credits = document.getElementById('credits');
  document.getElementById('credits-open')
    .addEventListener('click', () => { credits.hidden = false; });
  document.getElementById('credits-close')
    .addEventListener('click', () => { credits.hidden = true; });
  // 外側を押しても閉じる。読み終えたらすぐ地図へ戻れるように
  credits.addEventListener('click', (event) => {
    if (event.target === credits) credits.hidden = true;
  });

  // --- 発車待ち（設計書 4.2）と車上モード（設計書 4.3）---

  stationPanel = createStationPanel(route, schedule, spotsFile.spots, themeFilter, getWeather, getPlan);

  const spotElements = new Map(
    [...spotsLayer.querySelectorAll('.spot')].map((element) => [
      element.getAttribute('data-id'),
      element,
    ])
  );

  /*
   * 天気が決まった（わかった／わからなかった）ときに一度に反映する。
   * 「天候のひとこと」の文言、地図バッジの強調・弱め、発車待ちの見どころリストの
   * 3か所がこれ1つにぶら下がる。テスト走行（?demo=1）では実際の気象庁通信の
   * かわりに、操作盤で選んだ区分をそのままここへ渡す。
   */
  function applyWeather(short) {
    currentWeather = short;

    for (const spot of spotsFile.spots) {
      const element = spotElements.get(spot.id);
      if (!element) continue;
      const match = weatherMatch(spot, short);
      element.classList.toggle('spot--weather-good', match === 'good');
      element.classList.toggle('spot--weather-bad', match === 'bad');
    }

    const weatherElement = document.getElementById('weather');
    if (short) {
      weatherElement.hidden = false;
      weatherElement.textContent = `きょうは${short}。${windowHint(short)}`;
    } else {
      // わからないときは黙って引っこめる。地図は天候がなくても使える。
      weatherElement.hidden = true;
    }

    if (stationPanel) stationPanel.refresh();
  }

  // テスト走行では実際の気象庁通信をせず、操作盤の選択を待つ（Simulator.start 側で呼ぶ）
  if (!demoRequested()) {
    fetchTodayWeather().then(applyWeather).catch(() => applyWeather(null));
  }

  const journal = createJournal(spotsFile.spots, spotsFile.closings);

  trip = createTrip(route, spotsFile.spots, schedule, {
    stationPanel,
    spotCard: card,
    originCard,
    view,
    project,
    points,
    spotElements,
    onRecord: (state) => journal.update(state),
    getPlan,
    setPlan,
    getK,
  });

  // 地図を指で動かしたら、現在位置を追うのをやめる（設計書 4.3）
  mapElement.addEventListener('pointerdown', () => trip.stopFollowing());
  mapElement.addEventListener('wheel', () => trip.stopFollowing(), { passive: true });

  // 発車待ちのあいだに、成因カードの絵を先読みしておく（設計書 6.2）
  stationPanel.onArrive(() => preloadPanelImages(spotsFile.spots));

  setUpPhotoButton(journal, () => trip.passedLog());

  /*
   * ふだんは端末の位置情報を見張る。?demo=1 のときだけ、
   * そのかわりに走行シミュレーターへ運転をまかせる（両方は動かさない）。
   */
  if (demoRequested()) {
    await loadScript('js/simulate.js');
    Simulator.start({ route, spots: spotsFile.spots, schedule, trip, setWeather: applyWeather });
  } else {
    watchPosition(trip);
  }
}

main().catch((error) => {
  console.error(error);

  // 地図そのものが組み上がっていないので、天気欄ではなく読み込み中の表示を差し替える
  const loading = document.getElementById('loading');
  const text = document.getElementById('loading-text');
  const retry = document.getElementById('loading-retry');
  loading.hidden = false;
  loading.classList.add('loading--error');
  text.textContent = '地図を読み込めませんでした。電波の良い場所でやり直してください。';
  retry.hidden = false;
  retry.addEventListener('click', () => location.reload());
});
