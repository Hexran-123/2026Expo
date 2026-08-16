/*
 * build-terrain.js
 *
 * 標高の格子データ（elevation-grid.json）を、
 * 地図に敷く「地形の色の濃淡」のかたちに変換する。
 *
 * やること: 標高がある高さ以上の場所を囲む線を引き、その内側を塗る。
 *           これを何段階か重ねると、台地が濃く、低地が淡い地図になる。
 *           等高線そのものは見せない（設計書 5.2）。
 *
 * 使い方:  node tools/build-terrain.js [elevation-grid.json] [route.json] [出力先.json]
 *
 * 引数は省略できる。省略したときは銚子電鉄のときの値になるので、
 * 今までの `node tools/build-terrain.js` はそのまま同じ結果になる。
 */

const fs = require('fs');
const path = require('path');

const GRID_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'data', 'source', 'elevation-grid.json');
const ROUTE_PATH = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(__dirname, '..', 'data', 'choshi', 'route.json');
const OUT_PATH = process.argv[4]
  ? path.resolve(process.argv[4])
  : path.join(__dirname, '..', 'data', 'choshi', 'terrain.json');

/**
 * 色を塗り分ける高さ（m）。低いほうから順に、上に重ねて塗っていく。
 * SEA_LEVEL より下は水域（陸ではない場所）を表す番人の値。
 *
 * 標高の分布（中央値 14.6m / 75%が 24.5m 以下）を見て、
 * 低地と台地の差がいちばんはっきり出るように選んだ。
 */
const SEA_LEVEL = -5;
const BANDS = [SEA_LEVEL, 8, 16, 24, 32, 45];

/** 水域を表す値。どの段階よりも低ければ何でもよい。 */
const SEA_VALUE = -10;

/** 地図を描く大きさ（SVG の座標）。実際の縦横比に合わせて高さは自動で決まる。 */
const MAP_WIDTH = 1000;

/*
 * 小さすぎる島や穴は消す（マスの数）。データのノイズを取るため。
 *
 * 実際の面積で判断したいので、1 マスの大きさ（メートル）から逆算する。
 * fetch-elevation.js の解像度を変えても、ここは自動でついてくる。
 */
const MIN_AREA_SQUARE_METERS = 6500;

// ---------------------------------------------------------------
// 1. 読み込み
// ---------------------------------------------------------------

const grid = JSON.parse(fs.readFileSync(GRID_PATH, 'utf8'));
const route = JSON.parse(fs.readFileSync(ROUTE_PATH, 'utf8'));

const { width, height, bounds } = grid;

/*
 * 線路沿いの標高（開始画面のカードに出す。路線ごとに違う値になる）。
 *
 * 格子全体の最高点・最低点は使わない。路線から離れた丘や谷まで拾ってしまい、
 * 「この路線の標高」としては誇張になる。線路の各点でいちばん近いマスの、
 * ならす前の生の値を拾う（ならすと山の高さが少しつぶれるため）。
 *
 * 海（値が null）は線路上には出ないはずだが、DEM の穴などで紛れても
 * 無視できるよう、拾えた値だけで min/max を取る。
 */
function elevationAt(lat, lon) {
  const col = Math.round(((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (width - 1));
  const row = Math.round(((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * (height - 1));
  if (col < 0 || col >= width || row < 0 || row >= height) return null;
  return grid.values[row * width + col];
}

const routeElevations = route.track
  .map(([lat, lon]) => elevationAt(lat, lon))
  .filter((v) => v !== null && v !== undefined && !Number.isNaN(v));

const elevationAlongRoute = routeElevations.length === 0 ? null : {
  min: Math.floor(Math.min(...routeElevations)),
  max: Math.ceil(Math.max(...routeElevations)),
};

// ---------------------------------------------------------------
// 2. 地図の座標系を決める
//
// 緯度経度をそのまま縦横に引き伸ばすと、日本の緯度では横に間延びする。
// （経度 1 度の長さは緯度 1 度の約 0.81 倍しかない）
// そこで実際のメートルの比率に合わせて、地図の高さを決める。
// ---------------------------------------------------------------

const centerLatRad = (((bounds.minLat + bounds.maxLat) / 2) * Math.PI) / 180;
const spanLon = bounds.maxLon - bounds.minLon;
const spanLat = bounds.maxLat - bounds.minLat;

const spanEastWestMeters = spanLon * 111320 * Math.cos(centerLatRad);
const spanNorthSouthMeters = spanLat * 110540;

const MAP_HEIGHT = Math.round((MAP_WIDTH * spanNorthSouthMeters) / spanEastWestMeters);

/*
 * 1 マスの実際の大きさ（メートル）。
 *
 * fetch-elevation.js の解像度設定を変えると、この値も変わる。
 * ノイズ取りの強さや単純化の度合いは「実際の距離」で決めたいので、
 * マス数ではなくここから逆算する（解像度を変えても調整し直さずに済む）。
 */
const cellWidthMeters = spanEastWestMeters / width;
const cellHeightMeters = spanNorthSouthMeters / height;
const cellAreaSquareMeters = cellWidthMeters * cellHeightMeters;

/*
 * 解像度に応じた「ならし」の強さ。
 * マスが細かいほど、同じ実距離をならすのに多くの回数が要る。
 * 23m マス・2 回ならしを基準にして、そこからの比率で決める。
 */
const REFERENCE_CELL_METERS = 23;
const resolutionScale = REFERENCE_CELL_METERS / ((cellWidthMeters + cellHeightMeters) / 2);

/** 格子のマス目の位置 → 地図の座標 */
function cellToMap(col, row) {
  return [
    ((col + 0.5) / width) * MAP_WIDTH,
    ((row + 0.5) / height) * MAP_HEIGHT,
  ];
}

// ---------------------------------------------------------------
// 3. 標高をならす
//
// 生のデータは 1 マスごとに細かく上下していて、そのまま線を引くと
// ぎざぎざになる。周りのマスと平均をとって、なだらかにしておく。
// 海のマスは平均に混ぜない（海岸線が内陸に食い込むのを防ぐため）。
// ---------------------------------------------------------------

function smoothElevation(values, passes) {
  let current = values;

  for (let pass = 0; pass < passes; pass++) {
    const next = new Array(width * height);

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        if (current[row * width + col] === null) {
          next[row * width + col] = null; // 海は海のまま
          continue;
        }

        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const r = row + dy;
            const c = col + dx;
            if (r < 0 || r >= height || c < 0 || c >= width) continue;
            const v = current[r * width + c];
            if (v === null) continue;
            sum += v;
            count++;
          }
        }
        next[row * width + col] = sum / count;
      }
    }
    current = next;
  }

  return current;
}

const smoothPasses = Math.max(2, Math.round(2 * resolutionScale));
const smoothed = smoothElevation(grid.values, smoothPasses);
console.log(`マスの大きさ: 約 ${cellWidthMeters.toFixed(1)}m × ${cellHeightMeters.toFixed(1)}m / ならし ${smoothPasses} 回`);

/** 海を SEA_VALUE に置きかえた、線を引くための面 */
const surface = smoothed.map((v) => (v === null ? SEA_VALUE : v));

// ---------------------------------------------------------------
// 4. ある高さ以上の場所を囲む線を引く（マーチングスクエア法）
//
// 考え方: 隣り合う 4 マスを 1 組にして、そのうち何個が「その高さ以上」かを見る。
//         組み合わせは 16 通りしかないので、それぞれについて
//         「どこに境界線を引くか」をあらかじめ決めておける。
//         全部の組で線を引き、あとでつなげば輪ができる。
// ---------------------------------------------------------------

/* 辺の名前。T=上, R=右, B=下, L=左 */
const T = 0, R = 1, B = 2, L = 3;

/*
 * 16 通りの場合分け。
 * 番号は 4 隅（左上・右上・右下・左下）が「その高さ以上」かどうかを
 * 8・4・2・1 として足した数。
 * 5 と 10 は斜めに向かい合う形で、2 通りに解釈できる（あとで中央の値で決める）。
 */
const CASES = [
  [],                 // 0  どこも高くない
  [[L, B]],           // 1  左下だけ
  [[B, R]],           // 2  右下だけ
  [[L, R]],           // 3  下半分
  [[T, R]],           // 4  右上だけ
  null,               // 5  右上と左下（斜め）
  [[T, B]],           // 6  右半分
  [[L, T]],           // 7  左上以外
  [[T, L]],           // 8  左上だけ
  [[T, B]],           // 9  左半分
  null,               // 10 左上と右下（斜め）
  [[T, R]],           // 11 右上以外
  [[L, R]],           // 12 上半分
  [[B, R]],           // 13 右下以外
  [[L, B]],           // 14 左下以外
  [],                 // 15 全部高い
];

/**
 * 指定した高さ以上の場所を囲む輪をすべて求める。
 * @returns {Array<Array<[number, number]>>} 輪の配列（各輪はマス目座標の点の並び）
 */
function traceContours(threshold) {
  // 外周を 1 マス分「低い場所」で囲む。こうすると地図の端で線が切れず、必ず輪が閉じる。
  const padded = (col, row) => {
    if (col < 0 || col >= width || row < 0 || row >= height) return SEA_VALUE - 1;
    return surface[row * width + col];
  };

  /** 2 点の間で、ちょうど threshold になる位置を求める */
  const cut = (v1, v2) => {
    const span = v2 - v1;
    if (span === 0) return 0.5;
    return Math.max(0, Math.min(1, (threshold - v1) / span));
  };

  const segments = [];

  for (let row = -1; row < height; row++) {
    for (let col = -1; col < width; col++) {
      const topLeft = padded(col, row);
      const topRight = padded(col + 1, row);
      const bottomRight = padded(col + 1, row + 1);
      const bottomLeft = padded(col, row + 1);

      let caseIndex = 0;
      if (topLeft >= threshold) caseIndex += 8;
      if (topRight >= threshold) caseIndex += 4;
      if (bottomRight >= threshold) caseIndex += 2;
      if (bottomLeft >= threshold) caseIndex += 1;

      let pairs = CASES[caseIndex];

      // 斜めの場合は、4 隅の平均で「真ん中が高いか低いか」を決める
      if (pairs === null) {
        const center = (topLeft + topRight + bottomRight + bottomLeft) / 4;
        const centerIsHigh = center >= threshold;
        if (caseIndex === 5) {
          pairs = centerIsHigh ? [[L, T], [B, R]] : [[T, R], [L, B]];
        } else {
          pairs = centerIsHigh ? [[T, R], [L, B]] : [[L, T], [B, R]];
        }
      }
      if (pairs.length === 0) continue;

      // それぞれの辺の上で、線が横切る点の座標
      const edgePoint = {
        [T]: [col + cut(topLeft, topRight), row],
        [R]: [col + 1, row + cut(topRight, bottomRight)],
        [B]: [col + cut(bottomLeft, bottomRight), row + 1],
        [L]: [col, row + cut(topLeft, bottomLeft)],
      };

      for (const [from, to] of pairs) {
        segments.push([edgePoint[from], edgePoint[to]]);
      }
    }
  }

  return joinIntoLoops(segments);
}

/**
 * バラバラの線分を、端どうしをつないで輪にする。
 */
function joinIntoLoops(segments) {
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

  // 各点から出ている線分を集めた表
  const linksFrom = new Map();
  const addLink = (point, other) => {
    const k = key(point);
    if (!linksFrom.has(k)) linksFrom.set(k, []);
    linksFrom.get(k).push(other);
  };

  for (const [a, b] of segments) {
    addLink(a, b);
    addLink(b, a);
  }

  const visited = new Set();
  const loops = [];

  for (const [a, b] of segments) {
    const startKey = key(a);
    const edgeKey = `${startKey}|${key(b)}`;
    if (visited.has(edgeKey)) continue;

    // a から b の向きに、行き止まりか出発点に戻るまでたどる
    const loop = [a];
    let previousKey = startKey;
    let current = b;

    for (let guard = 0; guard < segments.length * 2; guard++) {
      const currentKey = key(current);
      visited.add(`${previousKey}|${currentKey}`);
      visited.add(`${currentKey}|${previousKey}`);
      loop.push(current);

      if (currentKey === startKey) break; // 一周した

      const candidates = linksFrom.get(currentKey) || [];
      const next = candidates.find((p) => key(p) !== previousKey);
      if (!next) break; // 行き止まり（ふつうは起きない）

      previousKey = currentKey;
      current = next;
    }

    if (loop.length > 3) loops.push(loop);
  }

  return loops;
}

// ---------------------------------------------------------------
// 5. 輪を整える
// ---------------------------------------------------------------

/** 輪が囲む面積（マスの数）。小さすぎる輪を捨てるのに使う。 */
function loopArea(loop) {
  let twiceArea = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea) / 2;
}

/**
 * ほぼ一直線に並んだ点を間引く（ダグラス・ポイカー法）。
 * 見た目を変えずにデータを軽くする。
 */
function simplify(points, tolerance) {
  if (points.length < 3) return points;

  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;

    const [x1, y1] = points[first];
    const [x2, y2] = points[last];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lineLength = Math.hypot(dx, dy);

    let farthest = -1;
    let farthestDistance = 0;

    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      // 点から直線までの距離
      const distance = lineLength === 0
        ? Math.hypot(px - x1, py - y1)
        : Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / lineLength;

      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = i;
      }
    }

    if (farthestDistance > tolerance) {
      keep[farthest] = true;
      stack.push([first, farthest], [farthest, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * 角を丸める（チェイキン法）。
 * 各辺を 1/4 と 3/4 の点で置きかえると、折れ線がなめらかな曲線に近づく。
 * 地形を「描いた絵」らしく見せるために使う。
 */
function smoothLoop(loop, passes) {
  let points = loop;

  for (let pass = 0; pass < passes; pass++) {
    const next = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      next.push([x1 * 0.75 + x2 * 0.25, y1 * 0.75 + y2 * 0.25]);
      next.push([x1 * 0.25 + x2 * 0.75, y1 * 0.25 + y2 * 0.75]);
    }
    points = next;
  }

  return points;
}

// ---------------------------------------------------------------
// 6. 各段階の輪を求めて、SVG の道筋（path）にする
// ---------------------------------------------------------------

const bands = BANDS.map((threshold) => {
  const minAreaCells = MIN_AREA_SQUARE_METERS / cellAreaSquareMeters;
  const loops = traceContours(threshold)
    .filter((loop) => loopArea(loop) >= minAreaCells)
    .map((loop) => {
      // 閉じた輪なので、重複している最後の点を落としてから処理する
      const closed = loop.slice(0, -1);
      const thinned = simplify(closed, 0.4 * resolutionScale);
      const rounded = smoothLoop(thinned, 2);
      return simplify(rounded, 0.15 * resolutionScale);
    });

  // 輪をすべて 1 本の path にまとめる。
  // 内側の輪（穴）は fill-rule="evenodd" で自動的に抜ける。
  const commands = loops.map((loop) => {
    const points = loop.map(([col, row]) => {
      const [x, y] = cellToMap(col, row);
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    });
    return `M${points.join('L')}Z`;
  });

  return {
    minElevation: threshold === SEA_LEVEL ? 0 : threshold,
    isLand: true,
    loops: loops.length,
    path: commands.join(''),
  };
});

bands.forEach((band, i) => {
  console.log(
    `${String(BANDS[i] === SEA_LEVEL ? '陸地' : BANDS[i] + 'm以上').padStart(8, '　')}: ` +
    `${String(band.loops).padStart(3)} 個の輪 / ${(band.path.length / 1024).toFixed(1)} KB`
  );
});

// ---------------------------------------------------------------
// 7. 書き出し
// ---------------------------------------------------------------

const output = {
  _comment: 'tools/build-terrain.js が自動生成。手で編集しないこと。',
  source: '国土地理院 標高タイル DEM10B',
  generatedAt: new Date().toISOString().slice(0, 10),

  /*
   * この地図の座標系。緯度経度をこの範囲で 0〜width / 0〜height に写す。
   * 路線も駅も絶景スポットも、すべてこの同じ決まりで地図に置く。
   */
  projection: {
    bounds,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
  },

  bands,
  elevationAlongRoute,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(output), 'utf8');

const sizeKb = fs.statSync(OUT_PATH).size / 1024;
console.log(`\n線路沿いの標高: ${elevationAlongRoute ? `${elevationAlongRoute.min}〜${elevationAlongRoute.max}m` : '（取れなかった）'}`);
console.log(`地図の大きさ: ${MAP_WIDTH} × ${MAP_HEIGHT}`);
console.log(`実際の範囲  : 東西 ${(spanEastWestMeters / 1000).toFixed(2)} km × 南北 ${(spanNorthSouthMeters / 1000).toFixed(2)} km`);
console.log(`書き出し    : ${OUT_PATH}（${sizeKb.toFixed(0)} KB）`);

// 路線が地図の中にきちんと収まっているかの確認
const inside = route.track.every(
  ([lat, lon]) =>
    lat >= bounds.minLat && lat <= bounds.maxLat &&
    lon >= bounds.minLon && lon <= bounds.maxLon
);
console.log(`路線は地図の中に収まっているか: ${inside ? 'はい' : 'いいえ（範囲を広げること）'}`);
