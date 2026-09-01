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
 * 車窓側が「地下」のスポット（CONTEXT.md「足もとの地理」）。
 *
 * 地下鉄では、窓の外は壁である。それでも「いま自分がどんな土地の上を
 * 走っているか」は伝える値打ちがあるので、絶景スポットの一種として扱い、
 * 左右のかわりに「足もと」と言う。**見えないものを「見てください」と
 * 案内しない**ことがここの目的なので、左右で書き分けないこと。
 *
 * sideUp / sideDown の両方が '地下' のときにこの扱いになる。
 */
const UNDERGROUND = '地下';
const UNDERGROUND_SHORT = '足もとの地下';
const UNDERGROUND_LONG = '足もと（車窓には出ません）';

function isUnderground(spot) {
  return spot.sideUp === UNDERGROUND && spot.sideDown === UNDERGROUND;
}

/*
 * ロック中も届く通知（設計書 9.1）。
 *
 * 画面内の帯（showNotice）と振動は、乗車中は画面を開いている前提で
 * 足りるとして見送っていたが、求められて足した。対応する端末にしか
 * 出さない。iPhone は「ホーム画面に追加」を経ないと Notification API
 * 自体が無いので、その場合は何もしない（動かないなら黙って隠す、9.3）。
 * 蓄える係（sw.js）に registration.showNotification を頼むので、
 * 蓄える係が居ない（https でない・登録に失敗した）ときも黙って何もしない。
 */
const NOTIFY_SUPPORTED = 'Notification' in window && 'serviceWorker' in navigator;

/** 通知帯（showNotice）と同じ文面で、ロック中も届く通知を出す。1 スポットに一度だけ呼ぶ想定 */
function notifyOS(notice) {
  if (!NOTIFY_SUPPORTED || Notification.permission !== 'granted') return;
  if (!navigator.serviceWorker.controller) return;

  const side =
    notice.side === UNDERGROUND ? UNDERGROUND_SHORT
    : notice.side === '両' ? 'どちらの窓でも'
    : `${notice.side}の窓`;

  navigator.serviceWorker.ready
    .then((registration) => registration.showNotification(`まもなく ${notice.spot.name}`, {
      body: side,
      tag: `spot-${notice.spot.id}`,
      vibrate: [200],
    }))
    .catch(() => { /* 出せなくても、画面内の帯と振動は別に動いている */ });
}

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

  /* --- ここから下は有楽町線（実演用）で使うもの --- */

  // 並走する線路（枕木を渡した 2 本のレール）
  rails: `<path d="M-5.5,-8 L-5.5,8 M5.5,-8 L5.5,8
                   M-8,-4.5 L8,-4.5 M-8,0 L8,0 M-8,4.5 L8,4.5"/>`,
  // 台地の縁（段丘。上から下へ一段落ちる）
  terrace: `<path d="M-8,-5 L-1,-5 L-1,1.5 L8,1.5 M-1,1.5 L-1,7 M4,1.5 L4,7"/>`,
  // 谷を刻む川（両側の斜面と、底を流れる水）
  valley: `<path d="M-8,-6.5 L-2,2.5 L2,2.5 L8,-6.5 M-4.5,6 q2.2,-2.4 4.5,0 t4.5,0"/>`,
  // 外堀（石垣と水面）
  moat: `<path d="M-8,-6 L-8,0 L8,0 L8,-6 M-3.5,-6 L-3.5,0 M3.5,-6 L3.5,0
                  M-8,-3 L8,-3 M-7,4.5 q3.5,-3 7,0 t7,0"/>`,
  // 埋立地（もとの海の上に、あとから土を積んだ層）
  landfill: `<path d="M-8,-1 L8,-1 M-8,3 L8,3 M-6,-5.5 L-1,-5.5 M1.5,-5.5 L6.5,-5.5
                      M-8,6.5 L8,6.5"/>`,
  // 防潮扉（門と、外側に迫る水位）
  floodgate: `<path d="M-6,7.5 L-6,-4 A6,6 0 0 1 6,-4 L6,7.5 Z M0,-6 L0,7.5
                       M-8.5,3 q2.2,-2.2 4.3,0 M4.2,3 q2.2,-2.2 4.3,0"/>`,
  // 貯木場（水に浮かべた丸太の木口）
  timber: `<g>
      <circle cx="-4" cy="-3.4" r="3.1"/><circle cx="3" cy="-3.4" r="3.1"/>
      <circle cx="-0.5" cy="2.4" r="3.1"/>
      <path d="M-8,7.5 q3.5,-2.6 7,0 t7,0" />
    </g>`,
};

/*
 * テーマそのものを表す絵。4 つのテーマに 1 つずつ。
 *
 * 絞り込みボタンから文字を外すために作った。「地形」「気候と農業」
 * 「産業と水運」「海と空」と並べると、押すためのボタンではなく
 * 読みものに見えてしまい、地図より先に目が行ってしまう。
 *
 * 一つ一つのスポットの絵（GLYPHS）とは役割が違う。あちらは
 * 「その景色が何か」、こちらは「どの括りか」を指す。だから山・波のように、
 * 説明を読まなくても括りが察せる形だけを使う。
 * GLYPHS と同じく、中心を (0,0) とした 20×20 くらいの大きさで描く。
 */
const THEME_GLYPHS = {
  // 山なみ。土地の起伏そのもの
  '地形': `<path class="solid" d="M-8.6,5.4 L-3.4,-5.8 L0.4,1.2 L3.8,-3.8 L8.6,5.4 Z"/>`,
  // 双葉。畑と、そこで育つもの
  '気候と農業': `<path d="M0,7.6 L0,-1.4"/>
                 <path class="solid" d="M0,1.2 q-7,0 -7,-6 q7,0 7,6 Z"/>
                 <path class="solid" d="M0,-1.6 q7,0 7,-6 q-7,0 -7,6 Z"/>`,
  // 煙突のある建物と、その足もとの水。醤油蔵と、それを支えた水運
  '産業と水運': `<path class="solid"
                   d="M-8.4,3 L-8.4,-4 L-2.6,-1.2 L-2.6,-4 L3.2,-1.2 L3.2,3 Z
                      M4.9,3 L4.9,-7.6 L8.4,-7.6 L8.4,3 Z"/>
                 <path class="solid" d="M-7.8,5 q3.9,-3.2 7.8,0 t7.8,0 L7.8,8 L-7.8,8 Z"/>`,
  /*
   * 雲と、その下の海。
   *
   * 空を日（丸）で表すと、下の海の帯と合わせて「泳ぐ人」に見えてしまった
   * （丸の下に横帯があると、頭と肩に読める）。横に広い雲にすると、
   * その読みが起きない。海は細い線 2 本だと小さいうちにくっつくので面で塗る。
   */
  '海と空': `<circle class="solid" cx="-3.4" cy="-3.4" r="2.6"/>
             <circle class="solid" cx="0.6" cy="-5" r="3.4"/>
             <circle class="solid" cx="4.4" cy="-3.2" r="2.6"/>
             <rect class="solid" x="-6" y="-3.6" width="10.4" height="3.4" rx="1.7"/>
             <path class="solid"
               d="M-8.4,2.6 q2.8,-2 5.6,0 t5.6,0 t5.6,0 L8.4,7.6 L-8.4,7.6 Z"/>`,
};

/** 絞り込みの設定をブラウザに覚えさせるときの名前 */
const STORAGE_KEY = 'choshi-navi/themes';

/** 乗車区間（乗る駅・降りる駅・方向）をブラウザに覚えさせるときの名前 */
const PLAN_KEY = 'choshi-navi/plan';

/** 環境音を使うかどうかをブラウザに覚えさせるときの名前。既定はオフ */
const SOUND_KEY = 'choshi-navi/sound';

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
 * 右下のボタンで現在位置へ寄るときの倍率。
 *
 * 「近くの駅が出てくるくらい」を狙う。銚子電鉄なら約 1.6km、有楽町線なら
 * 約 7km ぶんが画面に入り、どちらも隣の駅が数個みえる。駅名が出はじめる
 * LABEL_ZOOM(1.6) より十分に寄っているので、名前も読める。
 * 車上モードに入るときに寄せる倍率とそろえてある。
 */
const HERE_ZOOM = 4;

/*
 * 現在位置の印を、位置情報の合間もなめらかに動かすための値（設計書 4.3）。
 *
 * 実機の位置情報は 1 秒に 1 回しか届かない。届いた地点をそのまま描くと、
 * 1 秒止まっては飛ぶ、を繰り返す（実機での試乗で判明。走行シミュレーターは
 * 0.2 秒ごとに渡すので、手元では気づけなかった。js/simulate.js の TICK_MS）。
 *
 * そこで「描く位置」を実測とは別に持ち、直前の速さから割り出した
 * 「いまごろここだろう」へ向けて、毎コマ少しずつ寄せる。合間が埋まって
 * 動きがつながり、同時に位置情報のばらつき（停まっていても 10m ほど揺れる）も
 * ならされる。
 */

/**
 * 寄せ方の時定数（ミリ秒）。
 *
 * 大きいほどなめらかになり、そのぶん遅れる。380ms は、時速 60km で
 * 約 6m の遅れにあたる。位置情報そのものの誤差（5〜10m）より小さいので、
 * 実際の位置より遅れて見えることはない。
 */
const HERE_SMOOTH_MS = 380;

/**
 * これ以上離れていたら、寄せずに飛ばす（m）。
 * トンネルを抜けて電波が戻ったときなど、何百 m もずれていることがある。
 * そこを寄せてしまうと、線路の上を延々と滑っていく絵になる。
 */
const HERE_SNAP_METERS = 120;

/** 寄せ終わったとみなす差（m）。これを下回ったら、毎コマの描き直しをやめる */
const HERE_SETTLED_METERS = 0.05;

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

/*
 * 発車待ちで出す見どころは、いちばん近い 1 件だけ。
 *
 * 3 件並べていたころは、どれを待てばいいのかが読み取れなかった。
 * ホームで見ている数分のあいだに要るのは「次に来るのはどれで、
 * どちらの窓か」だけで、その先は乗ってから接近通知が順に教えてくれる。
 *
 * 一時は「600m 以内に続くときだけ 2 行」という例外を置いていたが、
 * やめた。行が増えたり減ったりすると下の帯の高さが変わり、その上に
 * 置いてある丸ボタンと方位縮尺まで動く。画面が変わるたびにボタンの
 * 位置が変わるほうが、1 行で足りない不便より重い。
 */
const LOOKOUT_COUNT = 1;

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

/*
 * 位置にまつわる「いまの時刻」。
 *
 * 現在地の推し量り（predictAlong）・実測が絶えたかの判定（onStale）は、
 * どれも「位置情報が届いた時刻」との引き算で成り立っている。だから、
 * 引き算する二つの値は必ず同じ時計から出ていなければならない。
 *
 * ふだんは実時計（端末の位置情報も Date.now で受ける）。テスト走行のときだけ
 * 走行シミュレーターが自分の時計を差しこむ（js/simulate.js の positionClock）。
 * あちらは発車時刻を起点に「速さ×」倍の速さで進む時計なので、実時計と混ぜると
 * 経過時間が桁ちがいに狂い、現在地の印が毎コマ飛ぶ。
 *
 * 時刻表の見た目に使う時計（Schedule.useClock）とは役目が別なので、分けてある。
 * あちらは「何時何分か」を見せるためのもの、こちらは「何秒経ったか」を測るもの。
 */
let positionNow = () => Date.now();

function usePositionClock(clock) {
  positionNow = clock;
}

/** SVG の部品を作る。createElementNS は SVG 専用の書き方。 */
function svg(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

/**
 * 地図のバッジと同じ「ひし形＋白い絵」の小さな印を作る。
 *
 * 地図の上のバッジ・発車待ちの見どころ・絞り込みボタン・下敷きの見出しで、
 * 同じ形と同じ色を使いまわすためのもの。文字で「地形」と書くかわりに
 * これを置く。色だけだと 4 つの区別が付かないが、形が入れば付く。
 *
 * @param {string} glyph  中に描く絵（GLYPHS か THEME_GLYPHS の値）
 * @param {string} color  ひし形の色（THEMES[...].color）
 */
function diamondMark(glyph, color, className) {
  const mark = svg('svg', {
    class: className,
    viewBox: '-14 -14 28 28',
    'aria-hidden': 'true',
  });
  mark.style.setProperty('--mark-color', color);

  // ひし形は ±12。まわりの 2 は、天気の合図でふちを付けるときの余白
  mark.appendChild(svg('path', { class: 'mark-badge', d: 'M0,-12 L12,0 L0,12 L-12,0 Z' }));

  /*
   * 絵は ±8.5 で描いてあり、そのままではひし形の角からはみ出す。
   * 0.68 倍に縮めると、いちばん角に近い絵（切通しのトンネルの足)でも
   * 線の太さを足して収まる。
   * 線の太さは縮めたぶんだけ CSS 側で太くしてある（.mark-glyph）。
   */
  const inner = svg('g', { class: 'mark-glyph', transform: 'scale(0.68)' });
  inner.innerHTML = glyph || '';
  mark.appendChild(inner);

  return mark;
}

/** JSON ファイルを読む */
async function loadJson(path) {
  /*
   * index.html の <head> が、この JS の到着を待たずに頼んでおいたぶん。
   *
   * 携帯電話の回線では、この main.js が届くまでに数百ミリ秒かかる。
   * そのあいだ回線が空いているのに、データの取得はここまで始まらなかった。
   * 先に頼んでおいたものがあれば、それを受け取る。
   * 失敗していたら、下でふつうに取り直す（先読みは速さのためのものであって、
   * 頼りにするものではない）。
   */
  const early = window.EARLY && window.EARLY[path];
  if (early) {
    delete window.EARLY[path];
    try {
      return await early;
    } catch {
      // 取り直す
    }
  }

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
 * 地図の 1 単位が実際の何メートルにあたるか。
 *
 * makeProjection は経度と緯度をそれぞれ別に引き伸ばしている（正距円筒）。
 * 銚子の緯度（約 35.7 度）で作った data/terrain.json では、
 * 縦横どちらで測っても 1 単位 ≒ 5.47m と一致するので、縮尺の帯は 1 本でよい。
 * 縦横がずれる緯度・範囲へ路線を広げるときは、ここを見直すこと。
 */
function metersPerUnit(projection) {
  const { bounds, width } = projection;
  const midLatitude = ((bounds.minLat + bounds.maxLat) / 2) * (Math.PI / 180);
  const metersPerDegreeLon = 111320 * Math.cos(midLatitude);
  return ((bounds.maxLon - bounds.minLon) / width) * metersPerDegreeLon;
}

/**
 * 縮尺の帯を、拡大に合わせて書き換える。
 *
 * 帯の長さを固定して数字を変えるのではなく、数字のほうを
 * 10m・20m・50m…と切りのよい値から選び、帯の長さで合わせる。
 * 「103m」のような端数は読むのに手間がかかるだけで、目分量の役に立たない。
 */
function createScaleBar(projection) {
  const bar = document.getElementById('scale-bar');
  const label = document.getElementById('scale-label');
  const perUnit = metersPerUnit(projection);

  /** 帯の長さの上限（画素）。地図を隠さない大きさ */
  const MAX_WIDTH = 96;
  const STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000];

  return function update(unitsPerPixel) {
    const metersPerPixel = unitsPerPixel * perUnit;

    let meters = STEPS[0];
    for (const step of STEPS) {
      if (step / metersPerPixel <= MAX_WIDTH) meters = step;
    }

    bar.style.width = `${(meters / metersPerPixel).toFixed(1)}px`;
    label.textContent = meters >= 1000 ? `${meters / 1000}km` : `${meters}m`;
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
   * まず、標高を調べた範囲だけを水色で塗る。
   *
   * 海は「帯が無いところ」として、下地の色が透けることで描いている。
   * その下地を画面いっぱいに敷いてしまうと、標高を調べていない範囲まで
   * 海になる。銚子は路線が南北に長く画面とかたちが合うので目立たなかったが、
   * 有楽町線は東西に長いため、縦長の画面では上下に大きく余る。そこが
   * 一面の水色になり、内陸の東京が海に見えていた。
   *
   * この四角の外は「調べていない」であって「海」ではない。
   * 外側は .screen の地の色（紙の色）がそのまま出る。
   */
  container.appendChild(
    svg('rect', {
      x: 0,
      y: 0,
      width: terrain.projection.width,
      height: terrain.projection.height,
      class: 'map-sea',
    })
  );

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

  /*
   * 地形の陰影（国土地理院の陰影起伏図タイルを貼り合わせたもの。tools/fetch-hillshade.js）。
   * 色の帯の上に重ねて立体感を出す。
   *
   * WebP なのは大きさのため。同じ絵が PNG では 1,447KB、いまの WebP では 130KB。
   * これ 1 枚が初回読み込みの大半を占めるので、駅でモバイル回線で開く作品としては
   * ここがいちばん効く。作り方と、そこまで小さくできる理由は
   * tools/shrink-hillshade.py に書いてある。
   */
  /*
   * 陰影の絵を持たない路線では、この層そのものを作らない。
   *
   * 透明な絵を代わりに置いてはいけない。mix-blend-mode: overlay は
   * 透明な絵に対しても働き、地形の色に色被りが出る（実際に、地図全体が
   * ピンクがかった）。無いものは置かない。
   */
  if (currentLine.hillshade !== false) {
    const shade = svg('image', {
      x: 0,
      y: 0,
      width: terrain.projection.width,
      height: terrain.projection.height,
      preserveAspectRatio: 'none',
      class: 'hillshade',
    });
    container.appendChild(shade);

    /*
     * 絵そのものは、地図が出てから取りに行く。
     *
     * 場所だけ先に作って href をあとから入れるのは、この層を探している側
     * （拡大したときに薄くする処理）が、あるはずの層を見失わないため。
     *
     * 携帯電話の回線では、この 130KB が地形・線路・スポットの JSON と
     * 帯域を取り合う。陰影は「地図が読める」ためには要らないので、
     * 譲る。手の空いたところで入れれば、見え方は変わらない。
     */
    const load = () => shade.setAttribute('href', `${currentLine.dir}/terrain-hillshade.webp`);
    if (typeof requestIdleCallback === 'function') requestIdleCallback(load, { timeout: 2000 });
    else setTimeout(load, 200);
  }
}

/** 線路を引く */
function drawRoute(container, points) {
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join('');

  /*
   * 通ってきた側の尾（設計書 4.3）。線路と同じ形をそのまま使い、
   * stroke-dasharray で「現在地の手前の一部」だけを切り出す。
   * 線路以外の新しい線を地図に増やさないための作り。
   *
   * 線路の「下」に敷く。線路そのものの色にも太さにも触らないので、
   * 「線路の見た目＝路線の別」という既存の読み方を壊さない。
   *
   * 白と墨を二枚重ねるのは、地形の色が --land-0（#E2EACB）から
   * --land-45（#C29A5A）まで振れるため。白だけだと濃い区間で、
   * 墨だけだと淡い区間で読めなくなる。二枚あれば、淡いところでは
   * 外側の墨が、濃いところでは内側の白が効く。
   *
   * 白を先に（いちばん下に）、墨をその上に。順番が逆だと白が墨を覆う。
   */
  container.appendChild(svg('path', {
    d, class: 'here-tail here-tail--paper', id: 'here-tail-paper-path',
    stroke: 'url(#here-tail-paper)', hidden: '',
  }));
  container.appendChild(svg('path', {
    d, class: 'here-tail here-tail--ink', id: 'here-tail-ink-path',
    stroke: 'url(#here-tail-ink)', hidden: '',
  }));

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
    const group = svg('g', {
      class: 'scalable station',
      'data-ax': p.x,
      'data-ay': p.y,
      'data-name': station.name,
      tabindex: '0',
      role: 'button',
      'aria-label': `${station.name}駅の時刻表`,
    });
    group.appendChild(svg('circle', { cx: p.x, cy: p.y, r: radius, class: 'station-dot' }));
    placed.push({ left: p.x - radius, right: p.x + radius, top: p.y - radius, bottom: p.y + radius });

    const label = svg('text', {
      class: isEnd ? 'station-label station-label--end' : 'station-label',
    });
    label.textContent = station.name;
    group.appendChild(label);

    /*
     * 押すためだけの、見えない丸。駅の印は小さいので、押しやすくする
     * （.spot-hit と同じ考え方。設計書 4 章「揺れる車内で押し間違えない」）。
     */
    group.appendChild(svg('circle', { cx: p.x, cy: p.y, r: radius * 2.2, class: 'station-hit' }));

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
  /*
   * getBoundingClientRect() を毎回呼び直さない。
   *
   * apply()・zoomAt() は指を動かすたびに何度も呼ばれるが、mapElement の
   * 画面上の大きさ・位置はリサイズ（またはリサイズと同じ意味を持つ操作）
   * でしか変わらない。直前の apply() が viewBox 等を書き換えた直後に
   * ここで測ると、ブラウザはまだ反映していないレイアウトをその場で
   * 確定させてから返す（forced synchronous layout）。ピンチでは 1 回の
   * 指の動きで 17 個の要素の transform と --k を書き換えるため、この
   * 測り直しが積み重なって重くなる（実測: ピンチ中の getBoundingClientRect
   * だけで 170ms 近く）。値をキャッシュし、リサイズのときだけ捨てる。
   */
  let cachedScreen = null;
  const screen = () => cachedScreen || (cachedScreen = mapElement.getBoundingClientRect());
  const invalidateScreen = () => { cachedScreen = null; };

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
    onChange(unitsPerPixel / basisPerPixel, zoom(), unitsPerPixel);
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

    /*
     * 0ms（アニメーションさせず、即座に飛ばす）ときは、下のrAFを経ずに
     * ここで値を確定させる。経由すると (now - start) / duration が
     * 0/0 になりうる（同じフレーム内で start と now が等しく丸まることが
     * ある。実機の位置情報がまだ来ていない間、乗る駅の近くへ即座に
     * 寄せる frameOnBoardStation で発生した）。NaN が cx/cy/unitsPerPixel
     * に入ると、以降の apply() が viewBox に Infinity を書き、地図全体が壊れる。
     */
    if (duration <= 0) {
      cx = targetX;
      cy = targetY;
      unitsPerPixel = targetPerPixel;
      apply();
      return;
    }

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

  return { apply, zoomAt, panBy, centerOn, goTo, reset, zoom, stopAnimation, invalidateScreen };
}

/**
 * 指・マウス・ホイールでの拡大縮小と移動をつなぐ。
 *
 * 指 1 本ならずらす、2 本ならその間隔の変化で拡大縮小する。
 * ホイールは、指が使えないパソコン向け。
 */
function setUpGestures(mapElement, view, onTap, motion) {
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
    motion.begin();
    active.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (active.size === 1) {
      movedDistance = 0;
      // 指を離した場所が同じなら「押した」とみなすため、覚えておく
      tapTarget = event.target.closest('.spot, .station');
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
    if (active.size === 0) motion.end();
    tapTarget = null;
  }
  mapElement.addEventListener('pointerup', release);
  mapElement.addEventListener('pointercancel', release);

  mapElement.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      motion.begin();
      // 1 回まわすぶんの変化量は端末差が大きいので、ゆるやかに効かせる
      view.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.002));
      // ホイールには「離した」がないので、止まったら自分で戻す
      motion.endSoon();
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

    /*
     * 絵だけにして、テーマ名は出さない。
     *
     * 名前が読めなくなるぶんは、押さえたときの説明（title）と、
     * 読み上げ用の名前（aria-label）で補う。スポットの下敷きには
     * 同じ印と一緒にテーマ名が出るので、そこで絵と名前が結びつく。
     */
    chip.appendChild(diamondMark(THEME_GLYPHS[name], theme.color, 'chip-mark'));
    chip.title = name;
    chip.setAttribute('aria-label', name);

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
// 作品名の帯の出し入れ
//
// 題・路線名・乗車区間・出典は、乗っているあいだずっと要る情報ではない。
// 画面の上を占めつづけると、地図と接近の通知が使える高さを削る。
//
// そこで、自動では一切出さない。開いたときも、区間を決めた直後も畳んだまま。
// 出るのは下の帯の ⓘ を押したときだけで、5 秒たてばまた畳む。
// 「押したときだけ」の一つの決まりにしてあるので、いつ出るのか迷わない。
// ------------------------------------------------------------------

/** 出したあと、ひとりでに畳むまでの時間（ミリ秒） */
const CHROME_VISIBLE_MS = 5000;

/** 畳む動きにかける時間（ミリ秒）。css/style.css の .bar--top と合わせる */
const CHROME_FADE_MS = 260;

// ------------------------------------------------------------------
// 指で地図を触っているあいだの、軽いモード
// ------------------------------------------------------------------

/** ホイールを回し終えたと判断するまでの時間（ミリ秒） */
const MOTION_SETTLE_MS = 220;

/**
 * 指で地図を動かしているあいだだけ、重い装飾を止める札。
 *
 * この作品でいちばん描くのに費用がかかるのは、次の 3 つ。
 *
 * - 枠組みのすりガラス（backdrop-filter: blur(14px)）。10 か所ある。
 *   後ろの地図が動くたびに、その 10 か所ぜんぶをぼかし直す。
 * - 陸が海に落とす影（SVG の feGaussianBlur）。海岸線という
 *   長い figure をまるごとぼかし直す。
 * - 陰影起伏図（1000×1461 の絵）のなめらかな拡大縮小。
 *
 * どれも「止まっているときの見え方」のためのもので、指を動かしている
 * 最中に読んでいる人はいない。触っているあいだだけ落として、
 * 指を離したら戻す。止まっている画面の見た目は 1 ミリも変わらない。
 */
function createMotionFlag(screenElement) {
  let timer = null;

  function clear() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  return {
    begin() {
      clear();
      screenElement.classList.add('screen--moving');
    },
    end() {
      clear();
      screenElement.classList.remove('screen--moving');
    },
    /** 「離した」が来ない操作（ホイール）用。少し待ってから戻す */
    endSoon() {
      clear();
      timer = setTimeout(() => {
        timer = null;
        screenElement.classList.remove('screen--moving');
      }, MOTION_SETTLE_MS);
    },
  };
}

/**
 * 下の帯の高さを測って、その上に置くものの位置へ渡す。
 *
 * ふだんは使われない。丸ボタンと方位縮尺は画面の下端からの決まった距離に
 * 置いてあり（css の max() の左側）、帯の高さでは動かさない。
 *
 * ここで測った値が効くのは、端末の文字設定を大きくするなどして
 * 帯が想定より高くなったときだけ。そのときだけ、帯にもぐって
 * 見えなくならないよう押し上げる。
 */
function trackBottomBar(screenElement) {
  const bar = screenElement.querySelector('.bar--bottom');

  function apply() {
    const height = Math.round(bar.getBoundingClientRect().height);
    screenElement.style.setProperty('--bottom-bar', `${height}px`);
  }

  apply();
  if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(bar);
  else window.addEventListener('resize', apply);
}

function createChrome() {
  const bar = document.getElementById('chrome-bar');
  const toggle = document.getElementById('chrome-toggle');
  let timer = null;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function show() {
    clearTimer();
    bar.hidden = false;
    // hidden を外した直後だと、動きの始まりの状態が飛ばされる
    requestAnimationFrame(() => bar.classList.remove('bar--away'));
    /*
     * 呼び出すボタンは消さない。下の帯の中に居るので、消すと
     * テーマの絞り込みが横に伸びて、帯そのものが動いて見える。
     */
    toggle.setAttribute('aria-expanded', 'true');
  }

  function hide() {
    clearTimer();
    if (bar.hidden) return;
    bar.classList.add('bar--away');
    toggle.setAttribute('aria-expanded', 'false');
    /*
     * 消えきってから場所を空ける。先に hidden にすると、下に積んである
     * 発車待ちの帯が動きの途中で跳ね上がる。
     */
    timer = setTimeout(() => {
      if (bar.classList.contains('bar--away')) bar.hidden = true;
      timer = null;
    }, CHROME_FADE_MS);
  }

  /** 出したまま、しばらくしたら畳む */
  function showBriefly() {
    show();
    timer = setTimeout(hide, CHROME_VISIBLE_MS);
  }

  toggle.addEventListener('click', () => {
    if (bar.hidden) showBriefly();
    else hide();
  });

  /*
   * 出典を読んでいるあいだ、帯をひとりでに畳ませないための一時停止と、
   * 読み終えたところでの数え直し。帯を新たに出すものではない
   * （出ているときにしか呼ばれない）。
   */
  function hold() {
    clearTimer();
  }

  function foldLater() {
    clearTimer();
    if (!bar.hidden) timer = setTimeout(hide, CHROME_VISIBLE_MS);
  }

  // 帯そのものを押しても畳む（中のボタンを押したときは、そちらを優先する）
  bar.addEventListener('click', (event) => {
    if (event.target === bar) hide();
  });

  return { hide, hold, foldLater };
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

/**
 * 2 地点の距離（m）。
 *
 * 中身は js/onboard.js が持っている（あちらは線路への射影でも同じ式を使う）。
 * ここに同じ式をもう一本置いていたが、二本あると片方だけ直したときに
 * 黙って食い違う。onboard.js は main.js より先に読み込まれる決まりなので
 * （index.html の script の並び・tools/build-demo.js の JS_FILES）、
 * 呼ばれる時点では必ずある。
 */
const distanceMeters = (lat1, lon1, lat2, lon2) =>
  Onboard.distanceMeters(lat1, lon1, lat2, lon2);

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

/** きょうの日付（YYYY-MM-DD）。区間がその日のものかを見るのに使う */
function today() {
  const now = new Date();
  const two = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/**
 * 前に決めた区間を、日付ごと読む。
 *
 * 区間は「その日の乗車」の設定であって、恒久の設定ではない。
 * 日付を見ずに残していたころは、翌日ちがう区間に乗るのにアプリを開いても
 * 黙って前回の範囲で絞り込んでいた（時刻表は前回の向きだけ、見どころも
 * 通知も前回の範囲だけ）。しかも区間は上の帯の中にしか出ていないので、
 * 気づく手がかりが無かった。
 */
function loadSavedPlan() {
  try {
    const saved = localStorage.getItem(PLAN_KEY);
    const plan = saved ? JSON.parse(saved) : null;
    /*
     * 別の路線で決めた区間は、この路線には無い駅でできている。
     * 路線を切り替えたあと、これを持ち越していたころは、銚子電鉄の地図に
     * 「和光市→平和台」の区間が出たまま、区間の設定も聞かれなかった。
     * 路線名を書いていない古い記録は、路線が 1 つだったころのものなので通す。
     */
    if (plan && plan.line && currentLine && plan.line !== currentLine.id) return null;
    return plan;
  } catch {
    return null;
  }
}

/**
 * きょう決めた区間。日をまたいでいれば null（＝もう一度聞く）。
 *
 * 同じ日のうちは今まで通り聞かない。往復で開き直すときや、トンネルや
 * 圏外でページが読み込み直されたときに、そのつど聞かれては使えない。
 */
function loadPlan() {
  const saved = loadSavedPlan();
  return saved && saved.date === today() ? saved : null;
}

function savePlan(plan) {
  try {
    // 日付と路線を添える。翌日に開いたときは日付を見て聞き直し（loadPlan）、
    // 別の路線に切り替えたときは路線を見て捨てる（loadSavedPlan）
    localStorage.setItem(
      PLAN_KEY,
      JSON.stringify({ ...plan, date: today(), line: currentLine ? currentLine.id : undefined })
    );
  } catch {
    // 保存できない設定のブラウザでも、その場での動きは変えない
  }
}

/** 環境音を使うかどうか。日をまたいでも覚える（乗車区間と違い、恒久の好みのため） */
function loadSoundPref() {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}

function saveSoundPref(value) {
  try {
    localStorage.setItem(SOUND_KEY, value ? '1' : '0');
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
 *
 * 終点は「外川」「銚子」と決め打ちしていたころは、有楽町線で食い違い確認の
 * 「直す」を押すと、有楽町線に無い駅名（外川・銚子）が降車駅に入り、
 * その先 stationDistance が null を返して区間の絞り込みが黙って外れていた
 * （設計書の見どころ・通知の絞り込みが効かなくなる）。Schedule.terminusOf は
 * この食い違い確認の見出し（showMismatch）でもう使っている、路線を問わない
 * 終点の求め方なので、ここも同じものに揃える。
 */
function correctedAlight(route, schedule, board, direction, oldAlight) {
  if (oldAlight) {
    const boardDist = stationDistance(route, board);
    const oldDist = stationDistance(route, oldAlight);
    const consistent = direction === '下り' ? oldDist > boardDist : oldDist < boardDist;
    if (consistent) return oldAlight;
  }
  return Schedule.terminusOf(schedule, direction);
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

/**
 * 発車待ちに出す見どころを選ぶ。
 *
 * 乗る向きが決まっていれば、その先にあるものだけを近い順に見る。
 * うしろに置いてきたものは「この先の見どころ」ではないため。
 * 区間が未設定で向きがわからないときだけ、この駅の前後から近い順に見る。
 */
function pickLookouts(route, plan, spots, station) {
  const inRange = withinPlan(route, plan, spots);

  const ahead = plan
    ? inRange.filter((spot) => (plan.direction === '下り'
      ? spot.distanceAlong > station.distanceAlong
      : spot.distanceAlong < station.distanceAlong))
    : inRange;

  return ahead
    .slice()
    .sort(
      (a, b) =>
        Math.abs(a.distanceAlong - station.distanceAlong) -
        Math.abs(b.distanceAlong - station.distanceAlong)
    )
    .slice(0, LOOKOUT_COUNT);
}

/** 「上り 左／下り 右」。どちらの向きでも見えるスポットは、そう書く。 */
function sidesText(spot) {
  if (isUnderground(spot)) return UNDERGROUND_SHORT;
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

    const nearby = pickLookouts(
      route, plan, spots.filter((spot) => !themeFilter.isHidden(spot.theme)), station
    );

    lookoutList.replaceChildren();
    for (const spot of nearby) {
      const item = document.createElement('li');
      item.className = 'lookout-item';

      /*
       * 地図のバッジとまったく同じ印を置く。ホームで覚えた形が、
       * そのまま地図の上で探す手がかりになる。テーマは色が指す。
       */
      item.appendChild(diamondMark(GLYPHS[spot.icon], THEMES[spot.theme].color, 'lookout-mark'));

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

      item.append(name, sides);

      /*
       * 天気に合うスポットは、印のふちを暖色にするだけにとどめる。
       * 以前は「今日はよく見えそう」と 2 行目に書いていたが、
       * ここは 1 行で読み切れることに意味がある欄なので、
       * 言葉ではなく地図バッジと同じ見た目の合図に寄せる。
       * 合わない（bad）側はここでは何も言わない（前向きな案内の趣旨とずれる）。
       */
      if (weatherMatch(spot, getWeather()) === 'good') {
        item.classList.add('lookout-item--weather-good');
        item.title = '今日はよく見えそう';
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

/*
 * 駅の時刻表。地図で駅を押すと開く。
 *
 * 発車待ちの帯（renderDepartures）が出す「次の発車」DEPARTURE_COUNT本だけとは別で、
 * その駅を通る一日ぶんの全列車を、上り・下りに分けて一覧する。
 * どの駅を押しても同じ画面が開く（乗車前・車上どちらのモードでも押せる）。
 */
function createTimetable(schedule) {
  const screen = document.getElementById('timetable');
  const titleElement = document.getElementById('timetable-title');
  const bodyElement = document.getElementById('timetable-body');

  function buildGroup(direction, entries) {
    const nowMinutes = Schedule.minutesOfDay(Schedule.now());
    // まだ発車していない最初の1本。無ければ今日はもう無い（-1）
    const nextIndex = entries.findIndex((entry) => entry.分 >= nowMinutes);

    const group = document.createElement('div');
    group.className = 'timetable-group';

    const heading = document.createElement('h3');
    heading.className = 'timetable-group-title';
    heading.textContent = `${Schedule.terminusOf(schedule, direction)}方面（${direction}）`;
    group.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'timetable-rows';
    entries.forEach((entry, index) => {
      const item = document.createElement('li');
      // 過ぎた時刻は控えめに、次の1本（発車待ちの帯と同じ列車）だけ太く
      if (nextIndex !== -1 && index < nextIndex) item.classList.add('timetable-row--past');
      if (index === nextIndex) item.classList.add('timetable-row--next');

      const time = document.createElement('span');
      time.className = 'timetable-time';
      time.textContent = Schedule.toClock(entry.分);
      item.appendChild(time);

      list.appendChild(item);
    });
    group.appendChild(list);
    return group;
  }

  return {
    /** @param {{name: string}} station route.json の駅（distanceAlong等は使わない） */
    open(station) {
      titleElement.textContent = `${station.name}駅の時刻表`;
      bodyElement.replaceChildren();

      for (const direction of ['下り', '上り']) {
        const entries = Schedule.timetableForStation(schedule, station.name)
          .filter((entry) => entry.方向 === direction);
        // 終点では片方向しか発車しない（銚子は下りだけ・外川は上りだけ）
        if (entries.length === 0) continue;
        bodyElement.appendChild(buildGroup(direction, entries));
      }
      screen.hidden = false;
    },
    close() {
      screen.hidden = true;
    },
  };
}

// ------------------------------------------------------------------
// 成因カード（設計書 6）
//
// 絶景スポットを通過したあとに出る。予習用の下敷き（4.1）とは別もの。
// 1 スポット 400 字ほどを 5〜6 コマに分け、めくって読む。
// ------------------------------------------------------------------

/**
 * ひとことに書ける字数（設計書 7.2）。
 *
 * 持ち主は js/journal.js。書いたものをしまうのがあちらなので、
 * 上限もあちらが決める。読めなかったときは書いたものを残す先そのものが
 * 無いのでここへは来ないが、それでも落ちないように控えを置いてある。
 */
function noteLimit(kind) {
  if (typeof Journal === 'undefined') return kind === 'photo' ? 15 : 60;
  return kind === 'photo' ? Journal.PHOTO_NOTE_LIMIT : Journal.SPOT_NOTE_LIMIT;
}

/**
 * @param {{
 *   noteFor?: (spotId: string) => string,
 *   onNote?: (spotId: string, text: string) => void,
 *   askText?: (ask: object) => Promise<string|null>,
 * }} hooks
 *   記章を押したときに、その絶景へのひとことを書いてもらうための口
 *   （設計書 7.2）。無くても成因カードは読める。
 */
function createOriginCard(screenElement, hooks = {}) {
  const card = document.getElementById('origin');
  const headElement = document.getElementById('origin-head');
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

  /*
   * カードの右上に、読まれている度合いのスタンプを出す（ADR-0004）。
   *
   * 文字は持たない。段（1〜3）が上がるほど情景そのものが進む絵
   * （popularityBadgeScene 参照）を大きく見せることで人気度を伝える。
   * 数を出さないのは、しきい値が 5〜8〜10 回（js/popularity.js の
   * STEPS）と小さく、「12人が読んだ」のように出すとかえって
   * 人気が無いように映るため。
   *
   * コマをめくっても消えないよう、パネルの中ではなく card 直下に置く。
   * そのぶん、次のスポットを開いたときに前のスポットのスタンプが
   * 残らないよう、open() の先頭で毎回はがしてから貼り直す。
   *
   * 待たせない。カードはもう出ていて、スタンプは届いたら貼る。
   * 届かなければ何も起きない——エラーも、空の枠も出さない（設計書 9.3）。
   */
  function showPopularity(spot) {
    if (!global_Popularity()) return;

    /*
     * 中身が作り物の路線では数えない。有楽町線の絶景スポットも時刻表も
     * いまは tools/make-test-line.js が作ったもので、これを数に混ぜると
     * 公開する数字が作品の実態を表さなくなる。
     * （id の形が違うのでサーバー側でも弾かれるが、無駄に投げない）
     *
     * 見るのは role ではなく dataSource。実演用（role: 'demo'）でも、
     * 実在の見どころと実際のダイヤに差し替えたなら数えてよい。
     * 「展示での位置づけ」と「中身が本物か」は別の話なので、混ぜない。
     */
    if (!currentLine || currentLine.dataSource !== 'real') return;

    /*
     * 成因カードを一本化したスポットどうしは、人気も一つの数として
     * 共有する（FB 2026-08-18）。`popularityId` を持つ側だけ、数える
     * 先をそちらへ差し替える。データベース側の id はそのまま
     * （spots.json の `_comment` を参照）、front-end で読み替えるだけ
     * なので、Supabase のスキーマは変えていない。
     */
    Popularity.record(spot.popularityId || spot.id).then((opens) => {
      // 待っているあいだに閉じられた・別のカードへ移った
      if (openedId !== spot.id) return;

      const level = Popularity.levelFor(opens);
      // まだ 5 に届いていない。数が乏しいうちは何も言わない
      if (level === 0) return;

      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'origin-badge';
      attachMemo(badge, spot);

      // 段が上がるほど情景が進む三段。路線ごとに物語が違う
      // （popularityBadgeScene 参照）。灯りの強さではなく情景そのものを
      // 変えているので、3 段目だけが「一番美しい」。
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 32 32');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = popularityBadgeScene(currentLine.id, level, `pop${popularityBadgeUid++}`);

      badge.appendChild(icon);

      card.appendChild(badge);
      // 貼ってから浮かせる。いきなり足すと唐突に見える
      requestAnimationFrame(() => badge.classList.add('origin-badge--in'));
    });
  }

  /*
   * 記章を押すと、その絶景へのひとことを書ける（設計書 7.2）。
   *
   * 記章そのものを入口にしたのは、通り過ぎた絶景の「スタンプを押す」
   * という感覚に合わせたいという指摘による（2026-08-16）。
   *
   * **ここだけを入口にしないこと。** 記章はサーバーに届いて、かつ 5 回
   * 以上読まれている絶景にしか出ない（showPopularity）。電波の弱い区間や
   * 公開直後・現地展示では出ないほうが普通なので、ここで書けなかったぶんは
   * 旅の記録の側から書き足せるようにしてある（js/journal.js の renderNotes）。
   */
  function attachMemo(badge, spot) {
    if (typeof hooks.askText !== 'function' || typeof hooks.onNote !== 'function') {
      // 書く先が無い。記章は今までどおり、読まれている度合いを見せるだけ
      badge.disabled = true;
      return;
    }

    /** 書いたものがあるかどうかを、記章の見た目と読み上げに映す */
    function reflect() {
      const written = hooks.noteFor ? hooks.noteFor(spot.id) : '';
      badge.classList.toggle('origin-badge--noted', written !== '');
      badge.setAttribute(
        'aria-label',
        written ? `書いたひとことを直す（${written}）` : 'この絶景にひとことを残す'
      );
    }
    reflect();

    badge.addEventListener('click', async () => {
      const written = await hooks.askText({
        title: spot.name,
        hint: 'この絶景に、ひとこと',
        value: hooks.noteFor ? hooks.noteFor(spot.id) : '',
        limit: noteLimit('spot'),
      });
      if (written === null) return;
      hooks.onNote(spot.id, written);
      reflect();
    });
  }

  /** js/popularity.js が読み込まれているか。消しても作品は動く */
  function global_Popularity() {
    return typeof Popularity !== 'undefined';
  }

  /*
   * 累積人気の記章の中身（<svg> の innerHTML）。1〜3 段の三情景。
   *
   * 路線ごとに絵を分けている。犬吠埼の灯台は銚子電鉄の実在の場所で、
   * 有楽町線（地下鉄）にそのまま出すと土地が合わないため
   * （2026-08-13、「銚子電鉄はよくできているが有楽町線ができていない」
   * という指摘を受けて追加）。縁の色（1段目：灰／2段目：墨／3段目：金）
   * だけは路線をまたいで共通の文法にしてあり、地の絵は路線ごとの
   * 実データに基づく物語にしてある。
   *
   * id は呼ぶたびに変える（uid）。同時に複数枚が DOM に残ることは
   * 通常無いが（open() のたびに panelsElement を作り直す）、
   * グラデーション・クリップパスの id が万一ぶつからないための備え。
   */
  let popularityBadgeUid = 0;

  function popularityBadgeScene(lineId, level, uid) {
    return lineId === 'yurakucho'
      ? yurakuchoBadgeScene(level, uid)
      : choshiBadgeScene(level, uid);
  }

  /*
   * 銚子電鉄の三段。もとは犬吠埼という同じ一点を、夜／夜明け前／初日の出と
   * 時刻だけ進めて見せていた。有楽町層の三段（太古の海／江戸の埋め立て／
   * 東京湾岸の夜景）が場所そのものを変えているのに合わせ、こちらも
   * spots.json に実在する三つの地点を、銚子駅からの距離（distanceAlong）の
   * 順に並べる形に描き直した（2026-08-14）。「乗って終点まで着く」という
   * 体験そのものが記章になる。
   *
   * 1段目 S01 ヤマサ醤油工場（仲ノ町、482m）── 出発してすぐの街
   * 2段目 S02 遠くに見える海（観音〜本銚子、1,496m）── 屋根の隙間に覗く海
   * 3段目 犬吠埼の初日の出（終点そば）── 3段目と2段目で同じ「海と空」に
   *   なるが、2段目は屋根ごしに覗くだけ、3段目で岬に着いて全部が見える、
   *   という伏線と回収にしてある。3段目は変えていない
   *   ── 本州最東端に近く、初日の出の名所として知られる場所であることから。
   */
  function choshiBadgeScene(level, uid) {
    if (level === 1) {
      // 仲ノ町の醤油蔵。本銚子へ向かう手前、高くそびえる煙突からにおいが流れてくる
      return `
        <defs>
          <clipPath id="${uid}-frame"><circle cx="16" cy="16" r="15"/></clipPath>
          <linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#CFE0E8"/>
            <stop offset="100%" stop-color="#EDE2C8"/>
          </linearGradient>
        </defs>
        <g clip-path="url(#${uid}-frame)">
          <rect x="0" y="0" width="32" height="20" fill="url(#${uid}-sky)"/>
          <rect x="0" y="20" width="32" height="12" fill="#C9B08A"/>
          <polygon points="2,20 7,13.5 12,20" fill="#5B4632"/>
          <polygon points="11,20 17.5,11.5 24,20" fill="#4A3A28"/>
          <polygon points="21,20 26,15 31,20" fill="#5B4632"/>
          <rect x="18.6" y="4" width="2.6" height="16" fill="#7A3A2E"/>
          <rect x="18.2" y="3" width="3.4" height="1.6" rx="0.4" fill="#63301F"/>
          <path d="M20,4 q1.6,-1.6 0.4,-3.4 q-1.6,-1.4 0,-3" fill="none" stroke="#EFE7D8" stroke-width="0.9" stroke-linecap="round" opacity="0.55"/>
          <path d="M21.4,5.4 q1.8,-1 1,-3" fill="none" stroke="#EFE7D8" stroke-width="0.7" stroke-linecap="round" opacity="0.4"/>
        </g>
        <circle cx="16" cy="16" r="15" fill="none" stroke="#8B8578" stroke-width="1"/>
      `;
    }

    if (level === 2) {
      // 屋根ごしの海。並んだ屋根の連なりが途切れたすきまに、海がきらりと覗く
      return `
        <defs>
          <clipPath id="${uid}-frame"><circle cx="16" cy="16" r="15"/></clipPath>
          <linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#CFE6EC"/>
            <stop offset="100%" stop-color="#EAF1DE"/>
          </linearGradient>
        </defs>
        <g clip-path="url(#${uid}-frame)">
          <rect x="0" y="0" width="32" height="32" fill="url(#${uid}-sky)"/>
          <rect x="0" y="17" width="32" height="3.4" fill="#2A6E8F"/>
          <rect x="0" y="17" width="32" height="1.1" fill="#BFE6EE" opacity="0.8"/>
          <polygon points="0,32 0,10 13,10 13,32" fill="#4A3A28"/>
          <polygon points="0,10 6.5,3 13,10" fill="#4A3A28"/>
          <polygon points="19,32 19,13 32,13 32,32" fill="#5B4632"/>
          <polygon points="19,13 25.5,6 32,13" fill="#5B4632"/>
        </g>
        <circle cx="16" cy="16" r="15" fill="none" stroke="#4B4843" stroke-width="1"/>
      `;
    }

    // level === 3。初日の出。水平線から朝日が上がり、灯台の縁が朝日で染まる。
    // 犬吠埼は本州最東端に近く、初日の出の名所として知られる（この段だけ縁を金にする）
    return `
      <defs>
        <clipPath id="${uid}-frame"><circle cx="16" cy="16" r="15"/></clipPath>
        <linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#7C93B0"/>
          <stop offset="45%" stop-color="#E8A26B"/>
          <stop offset="100%" stop-color="#F6D28A"/>
        </linearGradient>
        <linearGradient id="${uid}-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#E8A26B"/>
          <stop offset="100%" stop-color="#C97A4A"/>
        </linearGradient>
        <radialGradient id="${uid}-sun" gradientUnits="userSpaceOnUse" cx="11" cy="22" r="8">
          <stop offset="0%" stop-color="#FFF3D0" stop-opacity="0.95"/>
          <stop offset="45%" stop-color="#F6D28A" stop-opacity="0.55"/>
          <stop offset="100%" stop-color="#F6D28A" stop-opacity="0"/>
        </radialGradient>
        <filter id="${uid}-sunblur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1"/></filter>
        <linearGradient id="${uid}-reflect" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#FFF3D0" stop-opacity="0.85"/>
          <stop offset="100%" stop-color="#FFF3D0" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <g clip-path="url(#${uid}-frame)">
        <rect x="0" y="0" width="32" height="22" fill="url(#${uid}-sky)"/>
        <circle cx="11" cy="22" r="6.5" fill="url(#${uid}-sun)" filter="url(#${uid}-sunblur)"/>
        <circle cx="11" cy="22" r="4.3" fill="#FFF3D0"/>
        <path d="M22,6 q1,-0.9 2,0 q1,-0.9 2,0" fill="none" stroke="#3A2E38" stroke-width="0.5" stroke-linecap="round"/>
        <path d="M25,9 q0.8,-0.7 1.6,0 q0.8,-0.7 1.6,0" fill="none" stroke="#3A2E38" stroke-width="0.45" stroke-linecap="round" opacity="0.8"/>
        <rect x="0" y="22" width="32" height="10" fill="url(#${uid}-sea)"/>
        <polygon points="6,22 11,32 16,22" fill="url(#${uid}-reflect)" opacity="0.7"/>
        <polygon points="18.3,24 24.7,24 23.6,25.6 19.4,25.6" fill="#4A2E22"/>
        <polygon points="20,24 23,24 22.1,13.6 20.9,13.6" fill="#4A2E22" stroke="#F6D28A" stroke-width="0.35"/>
        <rect x="20.6" y="12.1" width="1.8" height="1.6" rx="0.3" fill="#4A2E22" stroke="#F6D28A" stroke-width="0.3"/>
        <circle cx="21.5" cy="12" r="0.55" fill="#FFF3D0"/>
      </g>
      <circle cx="16" cy="16" r="15" fill="none" stroke="#D99A2B" stroke-width="1.3"/>
    `;
  }

  /*
   * 有楽町層の三段（太古の海／江戸の埋め立て／東京湾岸の夜景）。
   *
   * 有楽町線は地下鉄なので、犬吠埼の灯台と海は土地が合わない。
   * かわりに、この路線の実データにある時間の物語を使った。
   * 縄文海進のころ、いまの地下区間は海の底で、その記憶は
   * 「有楽町層」という地層名にいまも残っている（Y07「日比谷入江の
   * 埋立地」）。海はやがて外堀・木場の水路として人の手で
   * 埋め立てられ（Y06「江戸城の外堀」・Y10「海へ逃げた木場」）、
   * 電車は地下を走り抜けて新木場・東京湾岸の夜景へ出る。
   * 犬吠埼と同じく、3 段目だけが「一番美しい」。
   */
  function yurakuchoBadgeScene(level, uid) {
    if (level === 1) {
      // 太古の海。縄文海進のころの海の底。漂う堆積物と、眠るアンモナイト
      return `
        <defs>
          <clipPath id="${uid}-frame"><circle cx="16" cy="16" r="15"/></clipPath>
          <linearGradient id="${uid}-water" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#2F4A44"/>
            <stop offset="100%" stop-color="#0A1614"/>
          </linearGradient>
          <radialGradient id="${uid}-glow" gradientUnits="userSpaceOnUse" cx="16" cy="9" r="6">
            <stop offset="0%" stop-color="#7FC9B8" stop-opacity="0.2"/>
            <stop offset="100%" stop-color="#7FC9B8" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <g clip-path="url(#${uid}-frame)">
          <rect x="0" y="0" width="32" height="32" fill="url(#${uid}-water)"/>
          <circle cx="16" cy="9" r="6" fill="url(#${uid}-glow)"/>
          <circle cx="7" cy="6" r="0.4" fill="#CFE7DD" opacity="0.6"/>
          <circle cx="11" cy="4" r="0.3" fill="#CFE7DD" opacity="0.5"/>
          <circle cx="22" cy="7" r="0.35" fill="#CFE7DD" opacity="0.55"/>
          <circle cx="25" cy="12" r="0.3" fill="#CFE7DD" opacity="0.45"/>
          <circle cx="9" cy="14" r="0.3" fill="#CFE7DD" opacity="0.4"/>
          <circle cx="19" cy="17" r="0.35" fill="#CFE7DD" opacity="0.4"/>
          <path d="M12.5,25.7 a3.2,3.2 0 1,1 6.4,0.3 a2.1,2.1 0 1,1 -4.2,-0.25 a1.1,1.1 0 1,1 2.1,0.2"
                fill="none" stroke="#D9C9A3" stroke-width="0.6" stroke-linecap="round" opacity="0.85"/>
        </g>
        <circle cx="16" cy="16" r="15" fill="none" stroke="#8B8578" stroke-width="1"/>
      `;
    }

    if (level === 2) {
      // 江戸の埋め立て。外堀の護岸と、木場へ運ばれる筏。水と土地が入り混じる
      return `
        <defs>
          <clipPath id="${uid}-frame"><circle cx="16" cy="16" r="15"/></clipPath>
          <linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3A3A46"/>
            <stop offset="55%" stop-color="#8A7550"/>
            <stop offset="100%" stop-color="#C98B4A"/>
          </linearGradient>
          <linearGradient id="${uid}-water" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#6B5A3E"/>
            <stop offset="100%" stop-color="#42351F"/>
          </linearGradient>
        </defs>
        <g clip-path="url(#${uid}-frame)">
          <rect x="0" y="0" width="32" height="22" fill="url(#${uid}-sky)"/>
          <path d="M6,7 q1.1,-1 2.2,0 q1.1,-1 2.2,0" fill="none" stroke="#332A22" stroke-width="0.5" stroke-linecap="round" opacity="0.7"/>
          <rect x="0" y="22" width="32" height="10" fill="url(#${uid}-water)"/>
          <rect x="24.3" y="18" width="1" height="7" fill="#2E2419"/>
          <rect x="26.6" y="19" width="1" height="6" fill="#2E2419"/>
          <rect x="8" y="24.4" width="4.8" height="1.3" rx="0.6" fill="#8C6A3E"/>
          <rect x="8" y="26" width="4.8" height="1.3" rx="0.6" fill="#7A5A34"/>
          <rect x="9.6" y="22.9" width="1.6" height="1.6" fill="#4A3C28"/>
        </g>
        <circle cx="16" cy="16" r="15" fill="none" stroke="#4B4843" stroke-width="1"/>
      `;
    }

    // level === 3。東京湾岸の夜景。地下を抜けた先、新木場・豊洲の灯りが水面に映る
    // （この段だけ縁を金にする。犬吠埼の初日の出と対になる「一番美しい到達点」）
    return `
      <defs>
        <clipPath id="${uid}-frame"><circle cx="16" cy="16" r="15"/></clipPath>
        <linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#161C33"/>
          <stop offset="70%" stop-color="#33314A"/>
          <stop offset="100%" stop-color="#5B4A3E"/>
        </linearGradient>
        <linearGradient id="${uid}-water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4A3F35"/>
          <stop offset="100%" stop-color="#221D1A"/>
        </linearGradient>
        <radialGradient id="${uid}-glow" gradientUnits="userSpaceOnUse" cx="21" cy="21" r="10">
          <stop offset="0%" stop-color="#F6D28A" stop-opacity="0.5"/>
          <stop offset="100%" stop-color="#F6D28A" stop-opacity="0"/>
        </radialGradient>
        <filter id="${uid}-soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="0.8"/></filter>
      </defs>
      <g clip-path="url(#${uid}-frame)">
        <rect x="0" y="0" width="32" height="22" fill="url(#${uid}-sky)"/>
        <circle cx="21" cy="21" r="10" fill="url(#${uid}-glow)" filter="url(#${uid}-soft)"/>
        <rect x="9" y="12" width="2.4" height="10" fill="#161318"/>
        <rect x="12" y="8" width="2.6" height="14" fill="#1D1A1F"/>
        <rect x="15.2" y="14" width="2.2" height="8" fill="#161318"/>
        <rect x="18" y="5" width="2.8" height="17" fill="#221E22"/>
        <rect x="21.4" y="10" width="2.3" height="12" fill="#1A171B"/>
        <circle cx="12.6" cy="10.5" r="0.28" fill="#F6D28A" opacity="0.9"/>
        <circle cx="12.6" cy="13" r="0.28" fill="#F6D28A" opacity="0.7"/>
        <circle cx="18.9" cy="8" r="0.28" fill="#F6D28A" opacity="0.9"/>
        <circle cx="18.9" cy="11" r="0.28" fill="#F6D28A" opacity="0.6"/>
        <circle cx="18.9" cy="14.5" r="0.28" fill="#F6D28A" opacity="0.8"/>
        <circle cx="22.2" cy="13" r="0.28" fill="#F6D28A" opacity="0.7"/>
        <circle cx="9.8" cy="16" r="0.28" fill="#F6D28A" opacity="0.6"/>
        <circle cx="19.4" cy="5" r="0.35" fill="#E0654A"/>
        <rect x="0" y="22" width="32" height="10" fill="url(#${uid}-water)"/>
        <rect x="12.4" y="22" width="0.6" height="9" fill="#F6D28A" opacity="0.35"/>
        <rect x="18.7" y="22" width="0.7" height="9" fill="#F6D28A" opacity="0.4"/>
        <rect x="21.8" y="22" width="0.6" height="9" fill="#F6D28A" opacity="0.3"/>
      </g>
      <circle cx="16" cy="16" r="15" fill="none" stroke="#D99A2B" stroke-width="1.3"/>
    `;
  }

  function open(spot) {
    // 中身がまだ書かれていないスポットでは、空のカードを出さない
    if (!Array.isArray(spot.panels) || spot.panels.length === 0) return false;

    openedId = spot.id;
    count = spot.panels.length;
    // コマの絵の縁取りは、いま開いたスポット自身のテーマ色を使う
    const theme = THEMES[spot.theme];

    // 前のスポットのスタンプが残らないよう、貼り直す前にはがす
    const staleBadge = card.querySelector('.origin-badge');
    if (staleBadge) staleBadge.remove();

    /*
     * ふつうは自分だけの札と名前。成因カードを一本化したスポットどうし
     * （FB 2026-08-18、`spot.mergedWith`）は、二組を並べる。順序は
     * どちらを開いても同じになるよう、銚子駅からの距離（distanceAlong）
     * の順にそろえる ── 「森のトンネル」を先に通過して開いても、
     * 見出しは「遠くに見える海」が先という一つの並びで安定させるため。
     */
    const paired = spot.mergedWith && hooks.spotById ? hooks.spotById.get(spot.mergedWith) : null;
    const headSpots = paired
      ? [spot, paired].sort((a, b) => a.distanceAlong - b.distanceAlong)
      : [spot];

    headElement.replaceChildren();
    headSpots.forEach((headSpot, index) => {
      const headTheme = THEMES[headSpot.theme];
      // 予習用の下敷きと同じ札。絵とテーマ名がここでも結びつく
      const themeElement = document.createElement('p');
      themeElement.className = 'card-theme';
      themeElement.style.setProperty('--card-color', headTheme.color);
      themeElement.append(
        diamondMark(THEME_GLYPHS[headSpot.theme], headTheme.color, 'card-theme-mark'),
        document.createTextNode(headSpot.theme)
      );

      const nameElement = document.createElement('h2');
      nameElement.className = 'card-name';
      nameElement.textContent = headSpot.name;
      // aria-labelledby（#origin）が指す先。組が二つあっても一つに保つ
      if (index === 0) nameElement.id = 'origin-name';

      const group = document.createElement('div');
      group.className = 'origin-head-group';
      group.append(themeElement, nameElement);
      headElement.appendChild(group);
    });

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
        image.alt = '';
        image.loading = 'eager';
        image.style.setProperty('--panel-tint', theme.color + '22');
        // 読めなかった絵は、枠だけ残さず消す
        image.addEventListener('error', () => image.remove());
        /*
         * .src ではなく setAttribute('src', …) にしてあるのは、js/ambient.js の
         * 音声と同じ理由（tools/build-demo.js が Element.prototype.setAttribute の
         * 差し替えで、1 枚デモに埋め込んだコマの絵へ付け替えられるようにするため）。
         */
        image.setAttribute('src', panel.image);
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
    showPopularity(spot);

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
     *
     * 記章（.origin-badge）も同じ理由で外す。あれはカードの直下に
     * 置いてあるので、外し忘れると押しても何も起きない
     * ── ひとことを書く入口がそこなので、黙って効かなくなる（設計書 7.2）。
     */
    if (event.target.closest('.origin-panels, .origin-foot, .origin-badge')) return;
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
      // setAttribute にする理由は createOriginCard の同様の箇所を参照
      image.setAttribute('src', panel.image);
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
  const { stationPanel, spotCard, originCard, view, project, points, spotElements, onRecord, getPlan, setPlan, getK, motion } = parts;
  const track = Onboard.prepareTrack(route);
  const wakeLock = createWakeLock();

  const noticeBar = document.getElementById('notice-bar');
  const noticeLead = document.getElementById('notice-lead');
  const noticeDetail = document.getElementById('notice-detail');
  // 二つ目の通知帯（FB 2026-08-18）。成因カードを一本化した相方の分だけ使う
  const noticeBar2 = document.getElementById('notice-bar-2');
  const noticeLead2 = document.getElementById('notice-lead-2');
  const noticeDetail2 = document.getElementById('notice-detail-2');
  const riding = document.getElementById('riding');
  const ridingTowards = document.getElementById('riding-towards');
  const ridingDelay = document.getElementById('riding-delay');
  const ridingCount = document.getElementById('riding-count');
  const hereMarker = document.getElementById('map-here');
  const hereArrow = document.getElementById('here-arrow-wrap');

  /*
   * 通ってきた側の尾。乗っているあいだだけ出す。
   *
   * 乗る前に出さないのは、そこまで歩いてきた人が線路の上を通ってきた
   * わけではないからで、出すと嘘になる。線路から離れているとき
   * （.here--off）に出さないのも同じ理由。
   *
   * 長さは現在地から 110m。銚子電鉄の駅間はおおむね 700m なので、
   * 6 分の 1 駅ぶんほど。400m → 180m → 110m と短くしてきた。
   * 線路の脇を灰色の帯が長く並走すると、地図が重く見える。
   * 短いと「いま来た方向」だけを言う印になる。
   */
  const TAIL_METERS = 110;
  const tailPaths = [
    document.getElementById('here-tail-paper-path'),
    document.getElementById('here-tail-ink-path'),
  ].filter(Boolean);
  const tailGradients = [
    document.getElementById('here-tail-paper'),
    document.getElementById('here-tail-ink'),
  ].filter(Boolean);
  /*
   * 軌道上の距離（m）と、SVG のパス長との比。この縮尺では路線の端から端まで
   * 比がほぼ変わらないので、全長どうしの比を一度だけ測って使い回す。
   * getTotalLength は安くはないので、測位のたびには呼ばない。
   */
  let tailScale = null;
  let tailPathLength = 0;

  function hideTail() {
    for (const tail of tailPaths) setHidden(tail, true);
  }

  function showTail(along) {
    if (tailPaths.length === 0) return;

    if (tailScale === null) {
      const meters = track[track.length - 1].along;
      tailPathLength = tailPaths[0].getTotalLength();
      tailScale = meters > 0 ? tailPathLength / meters : 0;
    }
    if (!tailScale) return;

    const backMeters = Math.max(0, along - TAIL_METERS);
    const at = along * tailScale;
    const from = backMeters * tailScale;
    const length = at - from;
    if (length <= 0) {
      hideTail();
      return;
    }

    /*
     * 濃さの向きを決める2点。駅の印や現在地の印と同じ pointAtDistance で
     * 求めるので、尾の先端は必ず現在地の印の真下に来る。
     */
    const nose = pointAtDistance(track, points, along);
    const back = pointAtDistance(track, points, backMeters);
    for (const gradient of tailGradients) {
      gradient.setAttribute('x1', back.x.toFixed(1));
      gradient.setAttribute('y1', back.y.toFixed(1));
      gradient.setAttribute('x2', nose.x.toFixed(1));
      gradient.setAttribute('y2', nose.y.toFixed(1));
    }

    for (const tail of tailPaths) {
      // 隙間を全長ぶん取って、切り出した一区間のほかは描かせない
      tail.style.strokeDasharray = `${length.toFixed(1)} ${tailPathLength.toFixed(1)}`;
      tail.style.strokeDashoffset = `${(-from).toFixed(1)}`;
      setHidden(tail, false);
    }
  }
  const shootButton = document.getElementById('shoot');

  const mismatchBar = document.getElementById('mismatch-bar');
  const mismatchText = document.getElementById('mismatch-text');
  const alightBar = document.getElementById('alight-bar');
  const alightText = document.getElementById('alight-text');

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
  /**
   * 画面に描いている地点。実測の along とは別に持つ（設計書 4.3）。
   *
   * along は「位置情報が言っている地点」で、1 秒に 1 回しか動かない。
   * こちらは毎コマ動かす。along をそのまま描くと 1 秒ごとに飛ぶので、
   * その合間を埋めるためのもの。null なら、まだ一度も描いていない。
   */
  let shownAlong = null;
  /**
   * 推し量りの起点。実測が届くたびに置き直す。
   *
   * along・fixedAt を使わないのは、あちらが onStale の推定でも書き換わるため。
   * 推定を起点にして更に推定すると、ずれが積み重なる。
   */
  let anchorAlong = null;
  let anchorAt = 0;
  /** 起点での速さ（m/s、符号なし）。進む向きは direction が持つ */
  let anchorSpeed = 0;
  /** 前回この関数を通ったときの地点。スポットを跨いだかどうかを見るのに使う */
  let lastUpdateAlong = null;
  /** 車上モードに入ったときの地点。降りる駅でまとめて拾う範囲を決めるのに使う */
  let boardedAlong = null;
  /**
   * 降りる駅に着いて、旅を終えたか。
   *
   * 途中の駅で降りると、乗ってきた電車は目の前を走り去っていく。その動きを
   * 「また乗った」と読ませないための札。旅の記録を閉じるか、区間を選び直すまで
   * 立てたままにする（resume で下ろす）。
   */
  let finished = false;
  /** 乗車区間の食い違いを、このトリップですでに確認したか（1トリップにつき最大1回） */
  let mismatchChecked = false;
  /**
   * 途中下車の確認で「まだ乗っている」と答えた駅の名前。
   *
   * 線路上に戻るまでは、同じ駅について聞き直さない。GPSが線路外と線路上を
   * 行き来しながらぶれても、そのたびに確認を出しては煩わしいだけになる。
   */
  let declinedAlightStation = null;
  /** いま確認バーで聞いている駅（押されたときにこれを見る） */
  let pendingAlightStation = null;
  /** いま通知を出しているスポット。通過するまで次に移らない */
  let noticedId = null;
  /*
   * 振動・ロック中通知をもう出したスポットの id。1 スポットに一度だけ
   * （設計書 4.3）。Set にしてあるのは、成因カードを一本化した相方どうし
   * （FB 2026-08-18）で二つの通知が同時に出ているとき、それぞれ独立に
   * 一度だけ鳴らす必要があるため。
   */
  const vibratedIds = new Set();
  let delayShown = null;
  /** 遅れを最後に引き直した時刻。null なら「まだこの乗車で引いていない」 */
  let delayCheckedAt = null;
  /** 次に停まる駅（遅れとあわせて「何時にどこへ着く予定か」を出す） */
  let nextStopShown = null;
  /** 追いかけているか。指で地図を動かすとやめる */
  let following = true;

  /**
   * 最後に印を置いた地図上の点。右下のボタンで寄る先に使う。
   * 線路の上にいるときは線路上の点、離れているときは受け取った位置そのもの。
   * まだ一度も位置が来ていなければ null。
   */
  let lastHerePoint = null;

  /**
   * 「現在位置へ戻す」ボタンの濃さを、追いかけているかどうかに合わせる。
   *
   * 車上モードでは、地図を指で動かすまで現在位置を追いかけている
   * （設計書 4.3）。追っているあいだは押しても何も起きないので薄くし、
   * 地図を動かして外れたらはっきり出す。押せば戻る、という合図になる。
   *
   * 引っこめてしまわないのは、置き場所を動かさないため。このボタンは
   * 右端の下の段に居つづける約束なので、消すと上のカメラだけが残って
   * 下に穴が空く。濃さだけで伝える。
   */
  const followButton = document.getElementById('reset-view');

  /*
   * ボタンが何をするかは、位置が分かっているかで変わる。
   * 分かっていれば「現在位置へ」、まだなら「路線全体に戻す」。
   * 位置は乗車中でなくても後から届くので、届いた時点でも呼び直す。
   */
  function refreshFollowButtonLabel() {
    followButton.setAttribute(
      'aria-label',
      mode === '車上' || lastHerePoint ? '現在位置へ' : '路線全体に戻す'
    );
  }

  function setFollowing(value) {
    following = value;
    followButton.classList.toggle('reset-view--following', value && mode === '車上');
    refreshFollowButtonLabel();
  }
  /**
   * 入るときに寄せたい倍率。届くまでは追従のたびにこれを渡す。
   * 渡さないと、追従が「いまの倍率のまま」を目標にしてしまい、
   * 寄せる動きが毎回打ち消される。
   */
  let wantedZoom = undefined;

  const passed = new Set();
  const passedLog = [];

  // ---- 見た目を書き換える ----

  /** 通知帯 1 枚ぶんの中身を書く。showNotice が 1 枚目・2 枚目の両方でこれを使う */
  function paintNotice(bar, leadElement, detailElement, notice) {
    const theme = THEMES[notice.spot.theme];
    bar.style.setProperty('--notice-color', theme.color);
    bar.dataset.phase = notice.phase;

    if (notice.phase === 'いま') {
      /*
       * 地下のスポットは窓の外が壁なので、「見てください」と言わない
       * （UNDERGROUND の注記）。かわりに、いま足もとにあるものを告げる。
       */
      leadElement.textContent =
        notice.side === UNDERGROUND ? 'いま、足もとを通っています'
        : notice.side === '両' ? 'どちらの車窓を見てください'
        : `${notice.side}側の車窓を見てください`;
      detailElement.textContent = notice.spot.name;
    } else {
      leadElement.textContent = `まもなく ${notice.spot.name}`;
      const side =
        notice.side === UNDERGROUND ? UNDERGROUND_SHORT
        : notice.side === '両' ? 'どちらの窓でも'
        : `${notice.side}の窓`;
      detailElement.textContent =
        notice.seconds === null ? side : `${side} ・ あと ${notice.seconds} 秒`;
    }
    bar.hidden = false;
  }

  /*
   * @param {object|null} notice 1 枚目（ふつうはこれだけ）
   * @param {object|null} [second] 2 枚目。成因カードを一本化したスポットどうし
   *   （spot.mergedWith）で、相方も予告の範囲に入っているときだけ渡される
   *   （FB 2026-08-18）。ふつうのスポットでは同時に二つ出さない方針
   *   （設計書 4.3）を変えていない ── ここに来る組み合わせ自体が無い。
   */
  function showNotice(notice, second = null) {
    // 環境音はテーマ別なので、通知の中身が変わるたびに合わせる（js/ambient.js。消えていてもよい）
    if (typeof Ambient !== 'undefined') Ambient.update(notice);

    if (notice === null) {
      noticeBar.hidden = true;
      noticeBar2.hidden = true;
      return;
    }
    paintNotice(noticeBar, noticeLead, noticeDetail, notice);

    if (second === null) {
      noticeBar2.hidden = true;
    } else {
      paintNotice(noticeBar2, noticeLead2, noticeDetail2, second);
    }
  }

  /* ---- 現在位置の印を、位置情報の合間もなめらかに動かす（設計書 4.3）----
   *
   * 位置情報が届くのは 1 秒に 1 回。その 1 回をそのまま描くと、印は
   * 1 秒止まってから飛ぶ。ここでやるのは次の 3 つ。
   *
   * 1. 直前の速さから「いまごろここだろう」を割り出す（predictAlong）
   * 2. そこへ向けて、描く位置を毎コマ少しずつ寄せる（stepShown）
   * 3. 動かしているあいだは地図を軽いモードにする（.screen--moving）
   *
   * 2 の「少しずつ寄せる」が、位置情報のばらつきをならす役目も兼ねる。
   * 揺れた 1 回にすぐ飛びつかず、何コマかかけて寄るため。
   */

  const trackLength = track.length ? track[track.length - 1].along : 0;

  /** 実測が届いたときに、推し量りの起点を置き直す */
  function setAnchor(nextAlong, now) {
    /*
     * 速さは、端末が言う値をまず信じる。持っていない端末もあるので
     * （coords.speed は null になりうる）、そのときは実測どうしの
     * 差から見積もる。起点を書き換える前に計算する。
     */
    let mps = typeof speed === 'number' && Number.isFinite(speed) && speed >= 0 ? speed : null;
    if (mps === null && anchorAlong !== null) {
      const seconds = (now - anchorAt) / 1000;
      // 短すぎる間隔で割ると、わずかな揺れが大きな速さに化ける
      if (seconds >= 0.4) mps = Math.abs(nextAlong - anchorAlong) / seconds;
    }

    anchorAlong = nextAlong;
    anchorAt = now;
    anchorSpeed = mps === null ? 0 : mps;
  }

  /** いまごろ電車はどこか。起点から、その速さで進んだものとして推し量る */
  function predictAlong(now) {
    if (anchorAlong === null) return null;
    // 乗っていない・向きが決まっていない・止まっているなら、推し量らない
    if (mode !== '車上' || direction === null || anchorSpeed <= 0) return anchorAlong;

    // 実測が絶えて久しければ、それ以上は進めない（onStale と同じ上限）
    const elapsed = Math.min(now - anchorAt, Onboard.DEAD_RECKON_LIMIT_MS);
    const ahead = anchorSpeed * (elapsed / 1000);
    const next = anchorAlong + (direction === '下り' ? ahead : -ahead);
    return Math.max(0, Math.min(trackLength, next));
  }

  /**
   * 描く位置を、推し量った位置へ一コマぶん寄せる。
   *
   * @param {number} sinceLast 前のコマからの経過（**位置の時計**でのミリ秒）。
   *   実時間ではないことに注意。寄せる相手（predictAlong）が位置の時計で
   *   動く以上、追いかける側も同じ時計で測らないと、時計の進み方が変わった
   *   とたんに追いつけなくなる。
   * @returns {boolean} まだ動いているか（false なら寄せ終わっている）
   */
  function stepShown(now, sinceLast) {
    const target = predictAlong(now);
    if (target === null) return false;

    if (shownAlong === null) {
      shownAlong = target;
      return false;
    }

    /*
     * 離れすぎていたら、寄せずに飛ばす（トンネルを抜けて電波が戻ったときなど）。
     *
     * ここへ来るのは、実測そのものが飛んだときだけにしたい。追いかけ方が
     * 遅れているだけで飛ばすと、遅れが溜まるたびに飛ぶ、を繰り返す。
     * 遅れは位置の時計で測った HERE_SMOOTH_MS ぶん（時速 40km で約 4m）に
     * とどまるので、120m はもっぱら実測の飛びだけを拾う。
     */
    const gap = target - shownAlong;
    if (Math.abs(gap) > HERE_SNAP_METERS) {
      shownAlong = target;
      return false;
    }
    if (Math.abs(gap) < HERE_SETTLED_METERS) {
      shownAlong = target;
      return false;
    }

    /*
     * 寄せ方を時間で決める（コマ数に依らせない）。コマ落ちしても
     * 進み方が変わらないので、重い端末でも動きの速さは同じになる。
     */
    shownAlong += gap * (1 - Math.exp(-sinceLast / HERE_SMOOTH_MS));
    return true;
  }

  /** 毎コマの寄せを回しているか。回っていないあいだは電池を使わない */
  let hereFrame = null;
  /** 前のコマを描いたときの「位置の時計」。コマの間隔を測るのに使う */
  let hereClockAt = 0;
  /** いま地図を軽いモードにしているか（.screen--moving） */
  let mapLightened = false;

  function setMapLightened(on) {
    if (on) {
      /*
       * 毎コマ呼ぶ。指で地図を触ったあとの motion.end() に消されても、
       * 次のコマで戻る。追従で地図が動いているあいだは軽いままにしたい。
       */
      motion.begin();
      mapLightened = true;
      return;
    }
    if (!mapLightened) return;
    motion.end();
    mapLightened = false;
  }

  /**
   * 毎コマ、描く位置を寄せて描き直す。
   *
   * 時刻はすべて positionNow()（実測が入っているのと同じ時計）で測る。
   * requestAnimationFrame が渡す時刻は使わない。コマの間隔もこちらで測る
   * ——寄せる相手（predictAlong）が位置の時計で動くので、追いかける側だけ
   * 実時間で測ると、時計の進み方が変わったとたんに追いつけなくなる。
   * テスト走行を ×30 にすると相手は 30 倍の速さで動くのに、寄せる速さは
   * そのままなので、遅れが 120m（HERE_SNAP_METERS）を越えて「離れすぎ」と
   * 見なされ、巡航のたびに印が飛んでいた（銚子電鉄の全線で 2 回）。
   *
   * ふだん（実機の位置情報）は positionNow() が Date.now() そのものなので、
   * これまでと同じ実時間で測ることになる。
   */
  function hereTick() {
    // 位置にまつわる時刻は、すべてこちら（実測が入っているのと同じ時計）で見る
    const now = positionNow();

    /*
     * 上限は時定数の 5 倍。裏に回っていたタブが戻ったときは、そこまでの
     * ぶんを一度に寄せきってしまってよい（そのために上限を置いている）。
     */
    const sinceLast = Math.max(1, Math.min(now - hereClockAt, HERE_SMOOTH_MS * 5));
    hereClockAt = now;

    /*
     * 実測が絶えて久しければ、onStale が印を消している。ここで描き直すと
     * 消したものが戻ってしまうので、何もしない。
     */
    const tooOld = mode === '車上' && now - lastRealFixAt > Onboard.DEAD_RECKON_LIMIT_MS;
    const moving = !tooOld && stepShown(now, sinceLast);

    if (moving) {
      // 追従で地図が動いているあいだだけ軽くする。駅に停まれば元の絵に戻る
      setMapLightened(mode === '車上' && following);
      showHere(mode === '車上');
      hereFrame = requestAnimationFrame(hereTick);
      return;
    }

    // 寄せ終わった。最後に一度きっちり描いて、回すのをやめる
    setMapLightened(false);
    if (!tooOld) showHere(mode === '車上');
    hereFrame = null;
  }

  /** 寄せを回しはじめる。すでに回っていれば何もしない */
  function startHereLoop() {
    if (hereFrame !== null) return;
    hereClockAt = positionNow();
    hereFrame = requestAnimationFrame(hereTick);
  }

  function stopHereLoop() {
    if (hereFrame !== null) cancelAnimationFrame(hereFrame);
    hereFrame = null;
    setMapLightened(false);
  }

  /**
   * 現在位置の印を出す。
   *
   * @param {boolean} [follow] 地図をそこへ寄せるか。
   *   車上モードでだけ true。乗る前は、地図を見ている人の見え方を横取りしない。
   */
  function showHere(follow = true) {
    if (along === null) {
      setHidden(hereMarker, true);
      hideTail();
      return;
    }

    /*
     * 乗る前は控えめな印にする（進行方向の矢印を出さない）。
     * ホームを歩いているあいだの「向き」は乗る向きとは関係がないので、
     * 矢印を出すと、まだ決まっていないことを決まったように見せてしまう。
     */
    hereMarker.classList.toggle('here--still', mode !== '車上');

    /*
     * 描くのは along ではなく shownAlong（毎コマ寄せている位置）。
     * along は 1 秒に 1 回しか動かないので、そのまま描くと印が飛ぶ。
     * まだ一度も寄せていなければ along をそのまま使う。
     *
     * 通知・通過の判定・遅れの計算は along のまま（updateRiding）。
     * 見せ方をなめらかにするだけで、判断は実測でやる。
     */
    const drawAlong = shownAlong === null ? along : shownAlong;

    /*
     * 軌道上の距離から、地図の座標へ戻す。区間の途中を線形補間する
     * （pointAtDistance）。駅の印も同じ関数で置いているので、駅に
     * 停まっているときは駅の印とぴったり重なる。
     */
    const spot = pointAtDistance(track, points, drawAlong);
    lastHerePoint = spot;
    refreshFollowButtonLabel();
    hereMarker.classList.remove('here--off');

    // 乗っているあいだだけ、通ってきた側に尾を敷く
    if (mode === '車上') showTail(drawAlong);
    else hideTail();

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
      while (segIndex < track.length - 1 && track[segIndex].along < drawAlong) segIndex += 1;
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

    if (!follow || !following) return;

    /*
     * 印そのものが毎コマなめらかに動くようになったので、地図は
     * 「かけて追いかける」のではなく、その場で同じ点に合わせる。
     *
     * 以前は 0.9 秒かけて追わせていた。印は位置情報が届いた瞬間に飛び、
     * 地図はそのあと 0.9 秒かけて追いつくので、画面の上では印が
     * 前へ飛び出してから中央へ戻る——つまり前後に揺れて見えていた。
     * いま印は毎コマ少しずつしか動かないので、地図も毎コマ合わせれば
     * 追いかける必要がない。
     *
     * 入るときの寄せ（wantedZoom がある間）だけは、今までどおり
     * 時間をかける。倍率が変わる動きは、飛ぶと何が起きたか分からない。
     */
    view.goTo(spot.x, spot.y, wantedZoom, wantedZoom === undefined ? 0 : 900);
    // 目当ての倍率まで届いたら、あとは利用者の見え方を尊重する
    if (wantedZoom !== undefined && Math.abs(view.zoom() - wantedZoom) < 0.3) {
      wantedZoom = undefined;
    }
  }

  /**
   * 線路から離れているときの現在位置。
   *
   * 以前はここで印を消していた。線路から 30m（Onboard.ON_ROUTE_METERS）を
   * 超えると、何も出なくなる。ところが駅へ歩いているあいだ・改札の中・
   * 市街地で測位がぶれているときは、たいてい 30m を超える。つまり
   * 「いちばん自分の位置を知りたいとき」に限って画面から消えていた。
   *
   * 線路の上の点ではなく、受け取った緯度経度そのものに置く。
   * 線路に吸い付けてよいのは、線路の上にいると言えるときだけ。
   * 見た目も変えて（.here--off）、これは吸い付けていない位置だと分かるようにする。
   */
  function showHereOffRoute(coords) {
    const point = project(coords.latitude, coords.longitude);
    lastHerePoint = point;
    refreshFollowButtonLabel();

    hereMarker.classList.add('here--off');
    hereMarker.classList.toggle('here--still', true);
    // 線路の上に落とせていないので、通ってきた道も言えない
    hideTail();
    hereMarker.setAttribute('data-ax', point.x);
    hereMarker.setAttribute('data-ay', point.y);
    hereMarker.querySelectorAll('circle').forEach((circle) => {
      circle.setAttribute('cx', point.x.toFixed(1));
      circle.setAttribute('cy', point.y.toFixed(1));
    });
    setHidden(hereMarker, false);
    setScaleTransform(hereMarker, getK());
  }

  /**
   * 右下のボタンで現在位置へ寄る。
   *
   * @returns {boolean} 寄れたか。位置がまだ分からなければ false（呼び出し側で
   *   路線全体に戻す）。
   */
  function goToHere() {
    if (!lastHerePoint) return false;

    /*
     * いま見えている倍率より下げない。押したのに引いてしまうと、
     * 「近くを見たい」という意図と逆になる。まだ寄っていないときだけ寄せる。
     */
    view.goTo(lastHerePoint.x, lastHerePoint.y, Math.max(view.zoom(), HERE_ZOOM), 600);
    return true;
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
      route, schedule, pendingMismatch.boardStation, pendingMismatch.direction, plan && plan.alight
    );
    setPlan({ board: pendingMismatch.boardStation, alight, direction: pendingMismatch.direction });
    mismatchBar.hidden = true;
    pendingMismatch = null;
  });

  document.getElementById('mismatch-keep').addEventListener('click', () => {
    mismatchBar.hidden = true;
    pendingMismatch = null;
  });

  /**
   * 途中下車の確認バーを出す（設計書 3.2）。
   *
   * GPSが線路から離れた地点を検出しても、それだけでは本当に降りたのか
   * GPSがぶれただけなのか区別できない。駅の近くにいるときだけ、
   * 利用者に聞いて確かめる。
   */
  function showAlightConfirm(station) {
    pendingAlightStation = station;
    alightText.textContent = `${station.name}で降りましたか？`;
    alightBar.hidden = false;
  }

  document.getElementById('alight-yes').addEventListener('click', () => {
    if (!pendingAlightStation) return;
    const station = pendingAlightStation;
    alightBar.hidden = true;
    pendingAlightStation = null;
    arrive(station);
  });

  document.getElementById('alight-no').addEventListener('click', () => {
    if (pendingAlightStation) declinedAlightStation = pendingAlightStation.name;
    alightBar.hidden = true;
    pendingAlightStation = null;
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
    setFollowing(true);
    // 前の乗車の名残りを持ちこさない
    delayShown = null;
    delayCheckedAt = null;
    nextStopShown = null;
    lastUpdateAlong = null;
    boardedAlong = null;
    mismatchChecked = false;
    mismatchBar.hidden = true;
    declinedAlightStation = null;
    pendingAlightStation = null;
    alightBar.hidden = true;
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
    setFollowing(false);
    riding.hidden = true;
    shootButton.hidden = true;
    // 印を消すので、毎コマの寄せも止める（止めないと消した印を描き戻す）
    stopHereLoop();
    shownAlong = null;
    setHidden(hereMarker, true);
    hideTail();
    showNotice(null);
    wakeLock.off();
    noticedId = null;
    wantedZoom = undefined;
    // 乗車前に戻るなら、天候のひとことも戻す
    if (next === '乗車前') document.getElementById('weather').hidden = false;
  }

  /**
   * 旅を終える駅の名前。
   *
   * 乗車区間を決めてあれば、その降りる駅（feature-spec「乗車区間の設定」）。
   * 銚子→笠上黒生のように途中で降りる人にとっては、そこが旅の終わりであって、
   * 線路の終点ではない。区間が無いときだけ、進んでいる向きの終点を使う。
   */
  function destinationName() {
    const plan = getPlan();
    if (plan) return plan.alight;
    // 区間が無ければ、進んでいる向きの終点（路線ごとに違うので route から取る）
    const ends = route.stations;
    return direction === '下り' ? ends[ends.length - 1].name : ends[0].name;
  }

  /**
   * この駅で旅を終えてよいか。
   *
   * 「降りる駅と名前が同じ」だけを見ていたころは、予定の駅を通り過ぎると
   * 旅がいつまでも終わらなかった。**終点まで乗っても記録が出ない。**
   * 気が変わって先まで乗ることも、その駅での位置情報を取りそこねることもある。
   * 予定の駅か、それより先の駅で停まったなら、そこが旅の終わり。
   *
   * 向きがまだ決まっていないときだけ、名前で見る（前後を比べようがないため）。
   */
  function isJourneyEnd(station) {
    const goal = route.stations.find((s) => s.name === destinationName());
    if (!goal || direction === null) return station.name === destinationName();

    const reached = direction === '下り'
      ? station.distanceAlong >= goal.distanceAlong
      : station.distanceAlong <= goal.distanceAlong;
    if (reached) return true;

    /*
     * 路線の終点まで行かずに、途中の駅で運転を終える列車がある
     * （有楽町線の辰巳どまり）。乗っている列車がそこで終わるなら、
     * 降ろされるのだから、そこが旅の終わり（Onboard.trainTerminatesAt）。
     * これを見ていなかったころは、辰巳で降ろされたあとも車上モードが
     * 続いたまま、旅の記録が出なかった。
     */
    return Onboard.trainTerminatesAt(Schedule, schedule, direction, station.name, Schedule.now());
  }

  /** 降りる駅に着いた。まだ通過扱いでないスポットを拾ってから降車後へ（設計書 3.2）*/
  function arrive(station) {
    /*
     * 電波が届かない区間で拾いそこねたぶんを、ここで記録に足す。
     *
     * 足すのは、乗った地点から降りる駅までのあいだにあるものだけ。乗る前や、
     * 降りたあとの区間のものまで足すと、見ていない景色が記録に並ぶ。
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

      const afterAlighting = direction === '下り'
        ? spot.distanceAlong > station.distanceAlong
        : spot.distanceAlong < station.distanceAlong;
      if (afterAlighting) continue;

      markPassed(spot, { detected: false, silent: true });
    }
    finished = true;
    /*
     * 開いたままの成因カード・下敷きを畳んでから記録を出す。
     * 残しておくと、記録を閉じたときに、降りる直前に読んでいたカードが
     * そのまま出てきて、いつのものか分からなくなる。
     */
    spotCard.close();
    originCard.close();
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
     * 成因カードを一本化したスポットどうし（spot.mergedWith、FB 2026-08-18）は、
     * 中身が同じカードを二度せり出させない。相方がまだ通過していなければ、
     * ここでは自動で出さず、相方を通過したときに一度だけ出す。バッジは
     * それぞれ押した時点で通過扱いの見た目になる（上の spot--passed）ので、
     * 待っているあいだも自分から開いて読むことはできる。
     */
    const partnerId = spot.mergedWith;
    const waitingForPartner = partnerId !== undefined && !passed.has(partnerId);

    /*
     * 予習用の下敷き（4.1）が開いたままだと、成因カードと二重に重なる。
     * 車上モードでバッジを押して下敷きを見ているあいだに通過することは
     * 普通に起こりうるので、自動で出すときも必ず先に下敷きを閉じる。
     */
    if (options.silent !== true && !waitingForPartner) {
      spotCard.close();
      originCard.open(spot);
    }
    onRecord({ mode, passed: passedLog, direction });
  }

  /*
   * 通過した絶景への、乗客のひとこと（設計書 7.2）。
   *
   * 通過の記録と同じ行に持つ。別の置き場にすると、「どの日のどの絶景に
   * 書いたのか」を突き合わせる仕掛けが要る。ここに混ぜておけば、
   * 旅の記録へも保存へも（js/journal.js の persist）そのまま流れていく。
   */
  function noteFor(spotId) {
    const entry = passedLog.find((item) => item.id === spotId);
    return entry && entry.note ? entry.note : '';
  }

  function setNote(spotId, text) {
    const entry = passedLog.find((item) => item.id === spotId);
    // 通過していない絶景には書けない（記章はそもそも通過後にしか出ない）
    if (!entry) return;
    if (text) entry.note = text;
    else delete entry.note;
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
     * 描く位置の推し量りの起点を置き直し、毎コマの寄せを回しはじめる
     * （設計書 4.3）。速さを見てから置くので、speed の代入より後に呼ぶ。
     */
    setAnchor(place.along, timestamp);
    startHereLoop();

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
      // その駅の 80m 以内で、かつ停まっているか（降りる駅の判定にも、下の確認にも使う）
      const station = stationAt(route, coords);

      /*
       * 停車では抜けない。線路から離れても、それだけでは抜けない（設計書 3.2）。
       *
       * 以前は「30m の外に 15 秒」で自動的に降りたとみなしていたが、カーブや
       * トンネルの出口でGPSがしばらく大きくぶれることがあり、まだ乗っている
       * のに旅の記録が閉じてしまうことがあった（乗客からのFB、2026-08-24）。
       * 線路の上へ戻ってきたかどうかは見た目のぶれでしかないので、
       * 「旅の途中」という判定そのものは崩さない。
       *
       * 本当に降りたかどうかは、駅の近くにいるかどうかで見分ける。電車を
       * 降りられるのは走っている途中ではなく駅に停まっているときだけなので、
       * 降りる予定ではない駅の近くで線路から離れているなら、利用者に聞いて
       * 確かめる（showAlightConfirm）。「まだ乗っている」と答えるまでは
       * 何度も聞き直さない。線路上に戻れば、その答えも聞きかけの確認も忘れる。
       */
      if (onRoute) {
        declinedAlightStation = null;
        if (pendingAlightStation) {
          alightBar.hidden = true;
          pendingAlightStation = null;
        }
      } else if (
        station
        && station.name !== destinationName()
        && declinedAlightStation !== station.name
      ) {
        showAlightConfirm(station);
      }

      // 降りる駅に着いたか
      if (station && isJourneyEnd(station)) {
        arrive(station);
        return;
      }

      updateRiding(timestamp);
      return;
    }

    /*
     * 乗る前・降りたあとでも、線路の上にいるなら現在位置の印は出しておく。
     *
     * 出していなかったころは、地図を動かすと自分がどこにいるのか
     * 分からなくなった。ホームで見どころを予習しているときこそ、
     * 「いま自分はここ」と「絶景はあそこ」の距離を掴みたい。
     *
     * 地図を寄せはしない（follow = false）。乗る前は、見ている人が
     * 決めた見え方を横取りしないため（設計書 4.1）。
     */
    if (onRoute) {
      showHere(false);
    } else {
      /*
       * 線路から離れているあいだは、受け取った緯度経度そのものに置く。
       * 線路の上を寄せていく毎コマの処理とは置き場所が違うので、
       * 二重に動かさないよう、寄せは止めて置きどころも忘れる。
       * 線路へ戻ってきたら、そこから改めて寄せはじめる。
       */
      stopHereLoop();
      shownAlong = null;
      showHereOffRoute(coords);
    }

    /*
     * 降りたあとは、電車が走り去る動きにつられて乗り直さない。
     * 発車待ちの帯だけは出しておく（記録を閉じたとき、次の電車が見える）。
     */
    if (finished) {
      stationPanel.update(stationAt(route, coords) || null);
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
     *
     * 相手に選ぶのは「前方でいちばん近い、予告を出す種類のもの」
     * （Onboard.announces）。ahead[0] をそのまま採っていたころは、
     * いちばん近いものが雑学（kind: 'trivia'、車窓に出ない）だと、その先に
     * ある景色ものへ近づいても通知が出なかった ── 雑学を通り過ぎるまで
     * 打ち止めになる。有楽町線は 10 件中 8 件が雑学なので、ここは実際に効く。
     */
    const ahead = withinPlan(route, getPlan(), Onboard.spotsAhead(spots, along, direction));
    const target = noticedId
      ? spots.find((spot) => spot.id === noticedId && !passed.has(spot.id))
      : ahead.find(Onboard.announces);

    const notice = target && !passed.has(target.id)
      ? Onboard.noticeFor(target, along, direction, speed)
      : null;

    /*
     * 二つ目の通知（FB 2026-08-18）。成因カードを一本化したスポットどうし
     * （spot.mergedWith）だけの特例。相方がまだ通過しておらず、相方も
     * それ自身の予告の範囲に入っていれば、重ねて出す。相方が遠ければ
     * null のままで、いつもどおり一つだけになる。
     */
    const partner = notice && target.mergedWith
      ? spots.find((spot) => spot.id === target.mergedWith)
      : null;
    const secondNotice = partner && !passed.has(partner.id)
      ? Onboard.noticeFor(partner, along, direction, speed)
      : null;

    showNotice(notice, secondNotice);
    noticedId = notice ? notice.spot.id : null;

    // 振動は 1 スポットにつき一度だけ。短く 1 回（設計書 4.3）
    // ロック中も届く通知（設計書 9.1）も、対応する端末・許可済みならここで一緒に出す
    for (const one of [notice, secondNotice]) {
      if (one && !vibratedIds.has(one.spot.id)) {
        vibratedIds.add(one.spot.id);
        if (navigator.vibrate) navigator.vibrate(200);
        notifyOS(one);
      }
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
      hideTail();
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
    setFollowing(false);
  }

  return {
    onPosition,
    onStale,
    stopFollowing,
    resumeFollowing() { setFollowing(true); startHereLoop(); showHere(); },
    goToHere,
    /** 現在位置が一度でも分かっているか。ボタンの意味を決めるのに使う */
    hasHere: () => lastHerePoint !== null,
    mode: () => mode,
    passedLog: () => passedLog,
    isPassed: (id) => passed.has(id),
    /** 記章から書くひとこと（設計書 7.2）。成因カードがここへ渡してくる */
    noteFor,
    setNote,
    /**
     * 旅を終えた扱いを解く。
     *
     * 旅の記録を閉じたとき（＝まだ乗っていると本人が言ったとき）と、
     * 区間を選び直したときに呼ぶ。
     */
    resume() { finished = false; },
  };
}

/**
 * 文を書いてもらう小さな下敷き（設計書 7.2）。
 *
 * 出る場所は三つある。写真を撮った直後の一言、成因カードの記章を押した
 * とき、旅の記録で書き直すとき。どれも同じ形にそろえてあるので、
 * 一度おぼえれば同じ操作で書ける。
 *
 * **書くことは、どこでも「したければする」ことにしてある。**「やめる」で
 * 閉じても、写真も通過の記録も何も失われない。絶景を見た直後に文字を
 * 書かせる作りにすると、車窓を見るほうが留守になる。
 *
 * @returns {(ask: {title:string, hint:string, value:string, limit:number|null})
 *            => Promise<string|null>}
 *   「残す」で書かれた文（空文字なら消したということ）、「やめる」で null。
 */
function createTextSheet() {
  const screen = document.getElementById('memo');
  const titleElement = document.getElementById('memo-title');
  const hintElement = document.getElementById('memo-hint');
  const input = document.getElementById('memo-input');
  const countElement = document.getElementById('memo-count');
  const keepButton = document.getElementById('memo-keep');

  /** いま待っている約束の返し口。開いていなければ null */
  let settle = null;
  let limit = null;

  function finish(value) {
    if (settle === null) return;
    const done = settle;
    settle = null;
    screen.hidden = true;
    done(value);
  }

  /*
   * 字数は「文字の数」で数える（Array.from）。
   *
   * textarea の maxlength は UTF-16 の単位で数えるので、絵文字や一部の
   * 漢字が 2 字ぶんとして弾かれる。15 字しか書けない欄でそれが起きると、
   * 見えている字数と残りが食い違う。
   */
  function fit(text) {
    if (limit === null) return text;
    const characters = Array.from(text);
    return characters.length <= limit ? text : characters.slice(0, limit).join('');
  }

  function updateCount() {
    if (limit === null) {
      // 上限を持たない欄（結びの一文）。数えるものが無い
      countElement.textContent = '';
      return;
    }
    countElement.textContent = `あと ${limit - Array.from(input.value).length} 字`;
  }

  input.addEventListener('input', () => {
    const fitted = fit(input.value);
    if (fitted !== input.value) input.value = fitted;
    updateCount();
  });

  keepButton.addEventListener('click', () => finish(fit(input.value).trim()));
  document.getElementById('memo-cancel').addEventListener('click', () => finish(null));
  document.getElementById('memo-veil').addEventListener('click', () => finish(null));

  return function ask({ title, hint, value, limit: max }) {
    // 前のものが開いたままなら、書かなかったことにして閉じる
    finish(null);

    limit = typeof max === 'number' ? max : null;
    titleElement.textContent = title;
    hintElement.textContent = hint || '';
    hintElement.hidden = !hint;
    input.value = fit(value || '');
    // 上限のない欄は、はじめから広く見せる（結びの一文はここに書く）
    input.rows = limit === null ? 6 : 3;
    updateCount();

    screen.hidden = false;
    // hidden を外した直後だと、端末によっては入力欄に入れない
    requestAnimationFrame(() => input.focus());

    return new Promise((resolve) => { settle = resolve; });
  };
}

/** 旅の記録を組み立てる（中身は js/journal.js） */
function createJournal(spots, closings, route, askText) {
  return Journal.create(spots, THEMES, closings || {}, {
    from: route.stations[0].name,
    to: route.stations[route.stations.length - 1].name,
    line: currentLine.name,
    lineId: currentLine.id,
    /*
     * 中身が本物かどうか。投稿の口を出すかの判断に使う（js/journal.js）。
     * 作り物の絶景に寄せられた言葉を本物と混ぜないため、累積人気を
     * 数えないのと同じ条件にそろえてある（CLAUDE.md）。
     */
    dataSource: currentLine.dataSource,
  }, askText);
}

/**
 * 旅の記録を読めなかったときの控え。
 *
 * 記録は降りたあとの読み物で、乗っているあいだの通知には要らない。
 * 手に入らなかったからといって地図ごと止めるのは、失うものが釣り合わない。
 * 呼ばれても何もしない同じ形のものを渡し、地図・発車待ち・通知は動かし続ける
 * （設計書 9.3 の「無いなら出さない」）。
 */
function silentJournal() {
  return {
    update() {},
    show() {},
    savePhoto: () => Promise.resolve(),
    setPhotoNote: () => Promise.resolve(),
    onClose() {},
    last: () => null,
  };
}

/**
 * 撮影ボタン（設計書 7.1）。
 *
 * capture を付けた file input なので、押すと端末のカメラがそのまま開く。
 * 撮った写真は、そのとき直近だった絶景スポットと一緒にしまう。
 *
 * しまったあと、一言を添えるかどうかを聞く（設計書 7.2）。聞くのは
 * カメラから戻ってきたこの瞬間だけで、書かずに閉じても写真は残る。
 * あとから旅の記録でも書けるので、揺れる車内で書けなければ後回しにできる。
 */
function setUpPhotoButton(journal, passedLog, askText) {
  const input = document.getElementById('shoot-input');

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    // 直近に通過したスポットを「そのあたりで撮ったもの」として覚えておく
    const log = passedLog();
    const near = log.length > 0 ? log[log.length - 1].name : null;

    const id = await journal.savePhoto(file, near).catch(() => null);
    input.value = '';

    // しまえなかった。写真は端末のカメラロールに残っているが、添える先が無い
    if (id === null || id === undefined) return;

    const note = await askText({
      title: '写真に一言',
      hint: near ? `${near}のあたりで撮りました` : '',
      value: '',
      // 直に Journal を見ない。読めていないときの控えは noteLimit が持っている
      limit: noteLimit('photo'),
    });
    if (note) journal.setPhotoNote(id, note);
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

/**
 * 追加のスクリプトを、一度だけ読む。
 *
 * isReady が「もう居る」と答えるなら読みに行かない。1 枚デモ（demo/*.html）は
 * 全部を 1 つの HTML に埋め込んであり、読みに行く先が無いため。
 *
 * 失敗したら覚えない。次に必要になったときに、もう一度試せるようにする
 * （トンネルで転んでも、明るいところで開き直せば手に入る）。
 */
const scriptsLoaded = new Map();

function ensureScript(source, isReady) {
  if (isReady && isReady()) return Promise.resolve();

  if (!scriptsLoaded.has(source)) {
    scriptsLoaded.set(
      source,
      loadScript(source).catch((error) => {
        scriptsLoaded.delete(source);
        throw error;
      })
    );
  }
  return scriptsLoaded.get(source);
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

  // 時刻は positionNow() で取る。実機では Date.now そのものだが、
  // 経過時間を測る側（predictAlong・onStale）と出どころをそろえておく。
  navigator.geolocation.watchPosition(
    (position) => trip.onPosition(position.coords, positionNow()),
    () => {
      // 断られた・取れなかった。乗車前モードのままでよい。
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
  );

  // 位置情報が来ないあいだも時間は進む。推定はこちらで回す。
  setInterval(() => trip.onStale(positionNow()), 2000);
}

// ------------------------------------------------------------------
// 天候のひとこと（設計書 4.1）
//
// 予報は「千葉県北東部」のような広い区分でしか手に入らない。
// そのため「この地点はよく見える」とは書かず、その日の空模様だけを伝える。
// ------------------------------------------------------------------

/*
 * 予報の区分は路線ごとに違う（銚子電鉄なら千葉県、有楽町線なら東京都）。
 * どの区分を引くかは data/lines.json の weatherArea に書いてある。
 */
function forecastUrl() {
  return `https://www.jma.go.jp/bosai/forecast/data/forecast/${currentLine.weatherArea}.json`;
}

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
  const forecast = await loadJson(forecastUrl());

  /*
   * どの区分を読むかは data/lines.json の weatherLabel で決める
   * （銚子電鉄なら「千葉県北東部」、有楽町線なら「東京地方」）。
   *
   * ここに「北東部」と書き込んでいたころは、weatherLabel は書いてあるのに
   * 誰も読んでおらず、銚子以外の路線ではいつも先頭の区分に落ちていた。
   * 手で書くファイルに、効かない設定を置いたままにしない。
   */
  const areas = forecast[0].timeSeries[0].areas;
  const wanted = (currentLine.weatherLabel || '').replace(/^.*?[都道府県]/, '');
  const area = (wanted && areas.find((a) => a.area.name.includes(wanted))) || areas[0];
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
  if (side === UNDERGROUND) return UNDERGROUND_LONG;
  return side === '両' ? '両側の窓' : `${side}の窓`;
}

const DURATION_TEXT = {
  '短': 'みじかい（すぐ過ぎる）',
  '中': 'ふつう',
  '長': 'ながい（ゆっくり見られる）',
};

/**
 * @param {{下り: string, 上り: string}} terminus
 *   上り・下りそれぞれの終点の駅名。「外川ゆき（下り）」の見出しに使う。
 *   路線ごとに違うので受け取る。銚子・外川と書き込んでいたころは、
 *   有楽町線のカードにも「外川ゆき」と出ていた（js/journal.js の ends と同じ話）。
 */
function createSpotCard(screenElement, view, getWeather, terminus) {
  const card = document.getElementById('spot-card');
  const themeElement = document.getElementById('spot-card-theme');
  const nameElement = document.getElementById('spot-card-name');
  const placeElement = document.getElementById('spot-card-place');
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

    /*
     * テーマの札には、絞り込みボタンと同じ絵を添える。
     * ボタンから文字を外したので、絵とテーマ名が結びつく場所がここになる。
     */
    themeElement.replaceChildren(
      diamondMark(THEME_GLYPHS[spot.theme], THEMES[spot.theme].color, 'card-theme-mark'),
      document.createTextNode(spot.theme)
    );
    themeElement.style.setProperty('--card-color', THEMES[spot.theme].color);
    nameElement.textContent = spot.name;
    placeElement.textContent = spot.location;

    factsElement.replaceChildren();
    /*
     * 乗車前は、その人が上りに乗るのか下りに乗るのかわからない。
     * 選ばせるより、両方書いてしまうほうが予習には向いている。
     */
    /*
     * 地下のスポットは上りも下りも同じ（どちらでも見えない）ので、
     * 行き先ごとに 2 行並べない。同じ答えが 2 つ並ぶと、
     * 左右のどちらかを選べるように読めてしまう。
     */
    if (isUnderground(spot)) {
      addFact('見え方', UNDERGROUND_LONG);
    } else {
      addFact(`${terminus['下り']}ゆき（下り）`, windowSideText(spot.sideDown));
      addFact(`${terminus['上り']}ゆき（上り）`, windowSideText(spot.sideUp));
    }
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
// どの路線を出すか（data/lines.json）
//
// 作品そのものが対象にしているのは銚子電鉄だけである（設計書 1 章）。
// それでも路線を選べるようにしてあるのは、二つの理由による。
//   ・GPS まわりの振る舞い（モードの切替、上り下りの判定、車窓側、
//     通知の先行時間）を、銚子まで行かずに近くの路線で確かめるため。
//   ・展示で「この仕組みは銚子電鉄だけのものではない」ことを見せるため。
//     有楽町線はほぼ全線が地下なので、位置情報が取れないときの振る舞い
//     （設計書 3.3）そのものが見どころになる。
//
// role が "demo" の路線は、この実演用。**作品の対象路線ではない**ので、
// 設計書 1 章（対象路線は銚子電鉄に限定）と取り違えないこと。
//
// dataSource が "synthetic" のあいだ、その路線の絶景スポットと時刻表は
// tools/make-test-line.js が作った作り物である。実在の見どころでも
// 実際のダイヤでもない。role とは別の軸なので、まとめて判定しないこと。
//
// 選んだ路線は localStorage に覚える。URL に ?line=... を付けると
// そちらが優先される。現地で切り替えるときに使う。
// ------------------------------------------------------------------

const LINE_KEY = 'choshi-navi/line';

/** いま出している路線。data/lines.json の 1 件がそのまま入る */
let currentLine = null;

function rememberLine(line) {
  try {
    localStorage.setItem(LINE_KEY, line.id);
  } catch {
    // 覚えられなくても、今回の表示には困らない
  }
}

/*
 * どの路線を出すかを決める。
 *
 * URL の ?line= か、前に選んだものがあればそれを使う。
 * どちらも無く、路線が 2 つ以上あるときだけ line を null で返す。
 * 呼び出し側はそのとき開始画面（路線選択）を出して、人に選んでもらう。
 *
 * 路線が 1 つしかないなら選ぶ余地が無いので、黙って決める。
 * data/lines.json を 1 件に減らせばこの状態になり、開始画面は出なくなる
 * （いまは応募時も有楽町線を載せたまま出すので、2 件のまま）。
 */
async function resolveLine() {
  const registry = await loadJson('data/lines.json');
  const byId = new Map(registry.lines.map((line) => [line.id, line]));

  const asked = new URLSearchParams(location.search).get('line');

  let saved = null;
  try {
    saved = localStorage.getItem(LINE_KEY);
  } catch {
    // 覚えられないブラウザでも、既定の路線で動く
  }

  const decided = byId.get(asked) || byId.get(saved);
  if (decided) {
    rememberLine(decided);
    return { registry, line: decided };
  }

  if (registry.lines.length >= 2) {
    return { registry, line: null };
  }

  const line = byId.get(registry.default) || registry.lines[0];
  rememberLine(line);
  return { registry, line };
}

// ------------------------------------------------------------------
// 路線選択（開始画面）
//
// 決定の経緯は ai/artifacts/路線の切り替え/mockup-decision-路線選択.md。
//
// 読むのは data/<路線>/preview.json だけ。地図画面が使う terrain.json と
// route.json をそのまま読むと二路線で 302 KB（gzip 112 KB）あり、
// まだ何も選んでいない画面としては重い。preview.json は輪郭を
// 開始画面に要るぶんまで粗くしたもので、二路線あわせて gzip 21 KB。
// 作るのは tools/build-preview.js。陰影起伏図はここでは読まない。
// ------------------------------------------------------------------

/** 開いた直後に、路線全体からどれだけ寄るか */
const PICKER_ZOOM = 1.9;
const PICKER_ZOOM_MS = 1500;

/** 「この路線のそば」と言ってよい距離（m） */
const PICKER_NEAR_METERS = 1000;

function readableDistance(meters) {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

/** 線路までの最短距離。駅間のどこに居ても「線からどれだけ離れているか」が出る */
function metersToTrack(track, lat, lon) {
  let best = Infinity;
  for (const [pointLat, pointLon] of track) {
    const d = distanceMeters(lat, lon, pointLat, pointLon);
    if (d < best) best = d;
  }
  return best;
}

/*
 * 1 路線ぶんの小さな地図を作る。
 *
 * preserveAspectRatio="…slice" にしてあるので、路線の縦横比と枠の縦横比が
 * 違っても余白は出ず、はみ出したぶんが切れる。
 */
function buildLinePreview(preview) {
  const { width, height, bounds } = preview.projection;
  const toX = (lon) => ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * width;
  const toY = (lat) => ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * height;
  const inside = (lat, lon) =>
    lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat;

  // 変数名を root にしてあるのは、部品を作る svg() を覆い隠さないため
  const root = svg('svg', {
    class: 'line-preview',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid slice',
    role: 'img',
  });

  for (const band of preview.bands) {
    root.appendChild(svg('path', { class: `band band--${band.minElevation}`, d: band.path }));
  }

  const d = preview.track
    .map(([lat, lon], i) => `${i === 0 ? 'M' : 'L'}${toX(lon).toFixed(1)} ${toY(lat).toFixed(1)}`)
    .join('');
  root.appendChild(svg('path', { class: 'line-preview-halo', d }));
  root.appendChild(svg('path', { class: 'line-preview-rail', d }));

  preview.stations.forEach(([lat, lon], i) => {
    const isEnd = i === 0 || i === preview.stations.length - 1;
    root.appendChild(svg('circle', {
      class: `line-preview-stop${isEnd ? ' line-preview-end' : ''}`,
      cx: toX(lon).toFixed(1),
      cy: toY(lat).toFixed(1),
      r: isEnd ? 7 : 4.5,
    }));
  });

  return { svg: root, width, height, toX, toY, inside, track: preview.track, herePoint: null };
}

/*
 * 現在地の点を、すでに出来ている地図に足す。
 *
 * 位置情報は地図より遅れて届く。そのたびに地図を作り直すと、
 * 有楽町線なら 4000 点あまりの輪郭を組み直すことになるので、
 * 点だけを足す。枠の中に居ないときは何も足さない。
 */
function setPreviewHere(view, here) {
  const old = view.svg.querySelector('.line-here-group');
  if (old) old.remove();
  view.herePoint = null;

  if (!here || !view.inside(here.lat, here.lon)) return;

  view.herePoint = { cx: view.toX(here.lon), cy: view.toY(here.lat) };
  const group = svg('g', { class: 'line-here-group' });
  for (const [cls, r] of [['line-here-wave', 6], ['line-here-ring', 8], ['line-here-dot', 6.5]]) {
    group.appendChild(svg('circle', {
      class: cls,
      cx: view.herePoint.cx.toFixed(1),
      cy: view.herePoint.cy.toFixed(1),
      r,
    }));
  }
  view.svg.appendChild(group);
}

/*
 * 路線全体から寄り先へ動かす。
 * 動きを減らす設定の人には動かさず、寄った先だけ出す。
 */
function playPreviewZoom(view, here) {
  const { svg, width, height, herePoint } = view;

  /*
   * 寄り先。
   *
   * 現在地そのものへ寄せてはいけない。現在地が線路から 1.4 km 離れている
   * だけで路線が枠の外へ出た（実測）。寄せるのは「現在地にいちばん近い
   * 線路の上の点」で、こうすると線が中ほどを通り、現在地はその脇に乗る。
   * 現在地が無ければ路線の真ん中。どちらにしても寄り先は必ず線路の上。
   */
  let focus = view.track[Math.floor(view.track.length / 2)];
  if (herePoint && here) {
    let best = Infinity;
    for (const point of view.track) {
      const d = distanceMeters(here.lat, here.lon, point[0], point[1]);
      if (d < best) {
        best = d;
        focus = point;
      }
    }
  }
  const target = { cx: view.toX(focus[1]), cy: view.toY(focus[0]) };

  // 現在地が寄り先の枠からはみ出すと点が縁で切れるので、そのぶん枠を広げる
  let zoom = PICKER_ZOOM;
  if (herePoint) {
    const needX = (Math.abs(herePoint.cx - target.cx) + width * 0.06) * 2 / width;
    const needY = (Math.abs(herePoint.cy - target.cy) + height * 0.06) * 2 / height;
    const needed = Math.max(needX, needY);
    if (needed > 1 / zoom) zoom = Math.max(1, 1 / Math.min(1, needed));
  }

  const wide = { x: 0, y: 0, w: width, h: height };
  const near = {
    w: width / zoom,
    h: height / zoom,
    x: target.cx - width / zoom / 2,
    y: target.cy - height / zoom / 2,
  };
  // 地図の外を映さない
  near.x = Math.max(0, Math.min(near.x, width - near.w));
  near.y = Math.max(0, Math.min(near.y, height - near.h));

  const apply = (b) =>
    svg.setAttribute('viewBox', `${b.x.toFixed(1)} ${b.y.toFixed(1)} ${b.w.toFixed(1)} ${b.h.toFixed(1)}`);

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    apply(near);
    return;
  }

  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / PICKER_ZOOM_MS);
    const e = 1 - (1 - t) ** 3;
    apply({
      x: wide.x + (near.x - wide.x) * e,
      y: wide.y + (near.y - wide.y) * e,
      w: wide.w + (near.w - wide.w) * e,
      h: wide.h + (near.h - wide.h) * e,
    });
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/*
 * 開始画面を出し、選ばれた路線が決まるまで待つ。
 *
 * カードの枠と路線名は preview.json を待たずに先に出す。地図は届いた順に
 * 差し込む。位置情報も別で待ち、取れたら距離の行と現在地の点を足す。
 * 取れなくても画面には何も出さない（ADR-0004 の切り離しの約束）。
 */
function pickLine(registry) {
  const section = document.getElementById('line-picker');
  const cards = document.getElementById('line-picker-cards');
  const legend = document.getElementById('line-legend-bar');

  for (const meters of [0, 8, 16, 24, 32, 45]) {
    const cell = document.createElement('span');
    cell.className = 'line-legend-cell';
    cell.style.background = `var(--land-${meters})`;
    legend.appendChild(cell);
  }

  const slots = registry.lines.map((line) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'line-card' + (line.role === 'product' ? '' : ' line-card--demo');

    const placeholder = document.createElement('div');
    placeholder.className = 'line-preview line-preview--empty';
    card.appendChild(placeholder);

    const body = document.createElement('div');
    body.className = 'line-card-body';
    body.innerHTML =
      `<div class="line-card-head">
         <span class="line-card-name"></span>
         ${line.role === 'product' ? '' : '<span class="line-card-badge">実演用</span>'}
       </div>
       <p class="line-card-meta"></p>`;
    body.querySelector('.line-card-name').textContent = line.name;
    card.appendChild(body);

    cards.appendChild(card);
    return { line, card, preview: null, view: null };
  });

  section.hidden = false;

  // 位置情報。届いたら、そのとき出ている地図に足す
  let here = null;

  /** その路線から現在地までの距離を、カードに一行で足す */
  const updateHereRow = (slot) => {
    if (!slot.preview || !here) return;

    let row = slot.card.querySelector('.line-card-here');
    if (!row) {
      row = document.createElement('p');
      row.className = 'line-card-here';
      slot.card.querySelector('.line-card-body').appendChild(row);
    }
    const d = metersToTrack(slot.preview.track, here.lat, here.lon);
    const near = d <= PICKER_NEAR_METERS;
    row.classList.toggle('line-card-here--near', near);
    row.textContent = near
      ? `いま この路線のそば（${readableDistance(d)}）`
      : `現在地から ${readableDistance(d)}`;
  };

  /*
   * 位置情報が地図より後に届いたとき。
   * 地図は作り直さず、現在地の点を足して寄り直すだけにする。
   */
  const applyHere = () => {
    for (const slot of slots) {
      if (!slot.preview || !slot.view) continue;
      updateHereRow(slot);
      setPreviewHere(slot.view, here);
      playPreviewZoom(slot.view, here);
    }
  };

  /** 1 路線ぶんの小さな地図を読んで、カードに差し込む */
  function showPreview(slot) {
    return loadJson(`${slot.line.dir}/preview.json`)
      .then((preview) => {
        slot.preview = preview;

        const km = (preview.summary.lengthMeters / 1000).toFixed(1);
        /*
         * 標高は路線ごとに違う（銚子電鉄 4〜28m、有楽町線 -3〜37m）。
         * 地図の色の濃淡（下の凡例）は両路線で共通の絶対値にそろえてあるが、
         * それだけでは「この路線は実際どこまで高いか」が数字として読めない。
         * tools/build-terrain.js が線路沿いの生の標高から求めた値
         * （preview.json の summary.elevation）をそのままここに出す。
         */
        const elevation = preview.summary.elevation;
        slot.card.querySelector('.line-card-meta').textContent =
          `${km} km ・ ${preview.summary.stationCount} 駅 ・ ${preview.summary.from} 〜 ${preview.summary.to}` +
          (elevation ? ` ・ 標高 ${elevation.min}〜${elevation.max}m` : '');

        const view = buildLinePreview(preview);
        view.svg.setAttribute('aria-label', `${slot.line.name}の地形と路線`);
        setPreviewHere(view, here);          // 位置情報が地図より先に届いていた場合
        slot.card.replaceChild(view.svg, slot.card.firstChild);
        slot.view = view;
        playPreviewZoom(view, here);
        updateHereRow(slot);
      })
      .catch(() => {
        /*
         * 地図が出せなくても、カードは残して選べるようにする。
         * ここで画面を止めると、路線を選ぶことすらできなくなる。
         */
        slot.card.querySelector('.line-card-meta').textContent = '（地図を読み込めませんでした）';
      });
  }

  /*
   * 地図は路線ごとに、届いた順から差し込む。
   * ただし**作品の路線（role: 'product'）を先に出し、実演用はそのあと**にする。
   *
   * 順番を付けるのは、有楽町線の輪郭が実機テスト用に間引かず作ってある
   * ためで、preview.json は gzip 15KB と作品側（銚子電鉄・6KB）の
   * 2 倍以上ある（tools/build-preview.js）。この画面はまだ何も選んでいない
   * 全員が最初に見るので、作品の地図を後ろに待たせない。
   *
   * 一度は実演用を出すこと自体をやめていたが、それだと有楽町線のカードだけ
   * 灰色の空欄になり、「読み込みに失敗した」ようにしか見えなかった。
   * 展示で見せる路線なので、それでは困る。
   * 待たせないことと、出すことは両立する。あとから出せばよい。
   */
  const productSlots = slots.filter((slot) => slot.line.role === 'product');
  const otherSlots = slots.filter((slot) => slot.line.role !== 'product');

  Promise.all(productSlots.map(showPreview)).then(() => {
    for (const slot of otherSlots) showPreview(slot);
  });

  /*
   * 位置情報は地図の読み込みを頼んだあとで訊く。
   * 先に訊くと、許可を出すまでのあいだ地図の取得が始まらないことがある。
   */
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        here = { lat: position.coords.latitude, lon: position.coords.longitude };
        applyHere();
      },
      () => {
        // 取れなくてもこの画面には何も出さない。カードはそのまま選べる
      },
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 300000 }
    );
  }

  return new Promise((resolve) => {
    for (const slot of slots) {
      slot.card.addEventListener('click', () => {
        rememberLine(slot.line);
        section.hidden = true;
        resolve(slot.line);
      });
    }
  });
}

/*
 * 路線名を出す。路線が 2 つ以上あるときだけ、押して切り替えられるようにする。
 *
 * 切り替えは読み込み直しで行う。地形・線路・駅・絶景スポット・時刻表・
 * 陰影の絵まで全部が入れ替わるうえ、地図の縮尺も路線の大きさから決めている。
 * 部分的に差し替えるより、読み直すほうが確かで、書く量も少ない。
 * 路線を切り替える仕掛けに、作品側の複雑さを持ち込まない。
 */
function setUpLineSwitch(registry, line) {
  const label = document.getElementById('line-name');
  if (!label) return;

  label.textContent = line.name;

  // 路線が 1 つしかないなら、ただの文字のままにする。
  // 押せないものを押せるように見せない。
  if (registry.lines.length < 2) return;

  const index = registry.lines.findIndex((l) => l.id === line.id);
  const next = registry.lines[(index + 1) % registry.lines.length];

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'line-name';
  button.id = 'line-name';
  button.textContent = line.name;
  button.setAttribute('aria-label', `路線を切り替える。いまは ${line.name}、押すと ${next.name}`);

  button.addEventListener('click', () => {
    try {
      localStorage.setItem(LINE_KEY, next.id);
    } catch {
      // 覚えられないブラウザでも、下の ?line= で伝わる
    }
    // ?line= が残っていると保存した値より優先されるので、こちらも書き換える
    const url = new URL(location.href);
    url.searchParams.set('line', next.id);
    location.href = url.toString();
  });

  label.replaceWith(button);
}

// ------------------------------------------------------------------
// 組み立て
// ------------------------------------------------------------------

async function main() {
  const mapElement = document.getElementById('map');

  // 路線が決まらないとデータの置き場所も決まらないので、これだけ先に読む
  const { registry, line: resolved } = await resolveLine();

  // 決まっていなければ、開始画面を出して選んでもらう。選ぶまでここで待つ
  const line = resolved || (await pickLine(registry));
  currentLine = line;

  const [terrain, route, spotsFile, schedule] = await Promise.all([
    loadJson(`${line.dir}/terrain.json`),
    loadJson(`${line.dir}/route.json`),
    loadJson(`${line.dir}/spots.json`),
    loadJson(`${line.dir}/schedule.json`),
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
  // index.html は「銚子電鉄の…」で決め打ちしてある。読み上げでは
  // 有楽町線に切り替えても銚子電鉄のままと言われていた
  mapElement.setAttribute('aria-label', `${line.name}の路線と絶景スポットの地図`);

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
  const updateScaleBar = createScaleBar(terrain.projection);

  /** 前回この処理をやりきったときの倍率。同じなら、やり直す必要がない */
  let appliedK = null;

  function onViewChange(k, zoom, unitsPerPixel) {
    currentK = k;

    /*
     * 倍率が変わっていない ── つまり、ただ地図を動かしただけなら、
     * ここから下はぜんぶ要らない。
     *
     * 下でやっているのは「画面上の大きさを変えないための作り直し」で、
     * どれも倍率だけで決まる。指で動かしているあいだ毎フレームやると、
     * 17 個の要素の transform 書き換え・--k の書き換え（これは地図の中で
     * calc(var(--k)) を使っているすべての線と文字の再計算を呼ぶ）・
     * 陸の影のぼかし幅の書き換えが、動かすたびに走る。
     * パンは指で触るいちばん多い操作なので、ここが効く。
     */
    if (k === appliedK) return;
    appliedK = k;

    updateScaleBar(unitsPerPixel);
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
  window.addEventListener('resize', () => {
    view.invalidateScreen();
    view.apply();
  });

  // 地図が動かせる状態になったので、読み込み中の表示を退ける
  document.getElementById('loading').hidden = true;

  /*
   * 旅の記録（js/journal.js）と累積人気（js/popularity.js）を、ここから読む。
   *
   * どちらも降りたあと・カードを開いたあとにしか使わないのに、これまでは
   * 最初から読んでいた。合わせて gzip 7KB あり、携帯回線ではその 7KB が
   * 地図のデータと回線を取り合っていた。地図が出たこの時点なら、回線は空く。
   *
   * 「使うときに読む」ではなく「地図が出たら読む」なのは、設計書 9.3 の
   * 「乗車前にまとめてブラウザへ保存する」に沿うため。降りたあとや
   * トンネルの中で読みに行くと、そこは電波が無いかもしれない。
   */
  const journalReady = ensureScript('js/journal.js', () => typeof Journal !== 'undefined');
  ensureScript('js/popularity.js', () => typeof Popularity !== 'undefined').catch(() => {
    // 読めなければ、のべ人数の記章が出ないだけ（設計書 9.3）
  });
  /*
   * 絶景掲示板へ写真を送る口（ADR-0004）。読めなければ、旅の記録の
   * 「絶景掲示板に出す」が出ないだけで、記録も共有画像もこれまでどおり動く。
   * 降りたあとに読みに行かないのは journal.js と同じ理由（上のコメント）。
   */
  ensureScript('js/photo-post.js', () => typeof PhotoPost !== 'undefined').catch(() => {});
  /*
   * 環境音（設計書 8.3）は、前回「流す」を選んだ人にだけ読む。
   *
   * 既定はオフなので、初めて開いた人・音は要らないと決めた人は、この 1 本も
   * 音源（4 本で 9MB）も取りに行かない。オフのまま乗る人に、鳴らさない音の
   * ぶんの通信をさせない。オフの人があとでチェックを入れたときは、
   * 乗車計画パネル側（planSoundCheck の change）でそこから読みはじめる。
   */
  if (loadSoundPref()) {
    ensureScript('js/ambient.js', () => typeof Ambient !== 'undefined')
      .then(() => Ambient.setEnabled(true))
      .catch(() => {
        // 読めなければ、環境音の機能そのものが出ないだけ（設計書 9.3）
      });
  }

  // 題・路線名・区間・出典の帯。ふだんは畳んでおく
  const chrome = createChrome();

  // 路線名。2 路線以上あれば、ここが切り替えのボタンになる
  setUpLineSwitch(registry, line);

  // 右下のボタンと方位・縮尺を、下の帯の高さに合わせて置く
  trackBottomBar(document.querySelector('.screen'));

  // 指で地図を触っているあいだ、重い装飾を落とす
  const motion = createMotionFlag(document.querySelector('.screen'));

  // --- 絶景スポットを押すと出る下敷き ---

  const spotById = new Map(spotsFile.spots.map((spot) => [spot.id, spot]));

  // 今日の天候区分（晴/曇/雨/雪）。わかるまでは null（= neutral 扱い）
  let currentWeather = null;
  const getWeather = () => currentWeather;

  const card = createSpotCard(document.querySelector('.screen'), view, getWeather, {
    '下り': Schedule.terminusOf(schedule, '下り'),
    '上り': Schedule.terminusOf(schedule, '上り'),
  });

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
  /*
   * 書いてもらう下敷き（設計書 7.2）。成因カードの記章・撮影の直後・
   * 旅の記録の三か所から、同じものを出す。
   */
  const askText = createTextSheet();

  const originCard = createOriginCard(document.querySelector('.screen'), {
    askText,
    /*
     * ひとことの持ち主は車上モード（通過の記録と同じ行に入る）。
     * trip はこの少しあとで組み立てるので、そのつど見に行く。
     * 記章が出るのは絶景を通過したあとなので、押せる時点では必ずある。
     */
    noteFor: (spotId) => (trip ? trip.noteFor(spotId) : ''),
    onNote: (spotId, text) => { if (trip) trip.setNote(spotId, text); },
    // 成因カードを一本化したスポット（`spot.mergedWith`）の相方を引くため
    spotById,
  });
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

  // --- 駅を押すと出る時刻表 ---

  const stationByName = new Map(route.stations.map((station) => [station.name, station]));
  const timetable = createTimetable(schedule);

  function openForStation(stationElement) {
    const station = stationByName.get(stationElement.getAttribute('data-name'));
    if (!station) return;
    card.close();
    originCard.close();
    timetable.open(station);
  }

  document.getElementById('timetable-close').addEventListener('click', () => timetable.close());

  setUpGestures(mapElement, view, (tapped) => {
    if (tapped && tapped.classList.contains('spot')) openForSpot(tapped);
    else if (tapped && tapped.classList.contains('station')) openForStation(tapped);
    else {
      // 何もないところを押したら閉じる
      card.close();
      originCard.close();
      chrome.hide();
    }
  }, motion);

  // キーボードでも開けるようにする（バッジ・駅は role="button" にしてある）
  for (const spotElement of spotsLayer.querySelectorAll('.spot')) {
    spotElement.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openForSpot(spotElement);
    });
  }
  for (const stationElement of document.querySelectorAll('.station')) {
    stationElement.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openForStation(stationElement);
    });
  }

  /*
   * 右下のボタン。乗車前は「路線全体へ」、車上モードでは「現在位置へ」戻る
   * （設計書 4.1）。どちらも「見失ったら押す」という同じ意味になる。
   */
  document.getElementById('reset-view').addEventListener('click', () => {
    if (trip && trip.mode() === '車上') {
      trip.resumeFollowing();
      return;
    }
    /*
     * 乗る前でも、現在位置が分かっているならそこへ寄る。
     *
     * 以前はいつでも路線全体へ戻していた。押した人は「自分がどこにいるか
     * 見たい」のに、いちばん引いた見え方になって現在位置の印が点にしか
     * ならなかった。位置がまだ来ていないときだけ、これまで通り全体へ戻す。
     */
    if (trip && trip.goToHere()) return;
    view.reset();
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

  /*
   * 実機の位置情報は、最初の1本が来るまで数秒〜十数秒かかることがある
   * （屋内・電波が弱いところなど）。それまでのあいだ、路線全体を映した
   * 遠いズームのままだと「自分がどこにいるか」の手がかりが無い。
   *
   * 乗車区間の設定で選んだ乗る駅の近くを、最初の見え方として出す。
   * 実際の位置が来たら（trip.hasHere()）、それ以降はそちらがすべてを
   * 決める。ここでは実際のGPS判定を上書きしない（乗車区間の設定
   * feature-spec の非目標と同じ考え方 ── 設定は初期表示の手がかりにする
   * だけで、実際の検出結果に介入しない）。
   *
   * デモ走行（?demo=1）はシミュレーターがすぐ位置を動かし出すので、
   * ここでは実機の位置情報のときだけ働かせる。
   */
  function frameOnBoardStation(plan) {
    if (demoRequested()) return;
    if (trip && trip.hasHere()) return;
    const station = plan && route.stations.find((s) => s.name === plan.board);
    if (!station) return;
    const p = pointAtDistance(track, points, station.distanceAlong);
    view.goTo(p.x, p.y, HERE_ZOOM, 0);
  }
  frameOnBoardStation(currentPlan);

  const planSetup = document.getElementById('plan-setup');
  const planClose = document.getElementById('plan-close');
  const planBoard = document.getElementById('plan-board');
  const planAlight = document.getElementById('plan-alight');
  const planError = document.getElementById('plan-error');
  const planSubmit = document.getElementById('plan-submit');
  const planChip = document.getElementById('plan-chip');
  const planNotify = document.getElementById('plan-notify');
  const planNotifyCheck = document.getElementById('plan-notify-check');
  const planSoundCheck = document.getElementById('plan-sound-check');

  /*
   * オフで開いた人が、ここでチェックを入れた瞬間に js/ambient.js を読みはじめる。
   *
   * 「決定」を押してから読んだのでは間に合わない。iOS Safari は、ユーザー操作の
   * 中で同期的に呼ばれた play() でないと音を許さない（ambient.js の unlock）。
   * 読み込みを待ってから unlock() を呼ぶと、その時点はもうクリックの外になる。
   * チェックと「決定」のあいだの数百ミリ秒で 5KB を読み終える見込みで、
   * 間に合わなければこの旅は鳴らないだけ（次に開くと既定で読む）。
   */
  if (planSoundCheck) {
    planSoundCheck.addEventListener('change', () => {
      if (!planSoundCheck.checked) return;
      ensureScript('js/ambient.js', () => typeof Ambient !== 'undefined').catch(() => {
        // 読めなければ、環境音が鳴らないだけ（設計書 9.3）
      });
    });
  }

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

  /*
   * ロック中も届く通知のチェック欄を、いまの許可状況に合わせる。
   *
   * 対応しない端末（iPhone の Safari など）や、一度「許可しない」を
   * 選んだあとは行ごと隠す。ねだり直しても Notification.requestPermission
   * は同じ答えを黙って返すだけで、行が残っていると押せない飾りになる。
   * すでに許可済みなら、チェックだけ入れて押せなくする（もう選ぶことがない）。
   */
  function refreshNotifyRow() {
    if (!NOTIFY_SUPPORTED || Notification.permission === 'denied') {
      planNotify.hidden = true;
      return;
    }
    planNotify.hidden = false;
    const granted = Notification.permission === 'granted';
    planNotifyCheck.checked = granted;
    planNotifyCheck.disabled = granted;
  }

  /** 選び直すときに開く。初回（未設定）は閉じるボタンを出さない（スキップさせないため） */
  function openPlanSetup() {
    /*
     * 日をまたいで聞き直すときも、前回の区間を入れておく。
     * 毎日おなじ区間で通う人に、同じ駅を選び直させないため。
     * 同じでよければ「決定」を押すだけで済む。
     */
    const filled = currentPlan || loadSavedPlan();
    if (filled) {
      planBoard.value = filled.board;
      planAlight.value = filled.alight;
    }
    planClose.hidden = !currentPlan;
    updatePlanValidity();
    refreshNotifyRow();
    /*
     * 環境音の切り替えは、index.html に無いことがある。こちらの JS だけが
     * 先に入った状態や、環境音を外した版を作った場合がありうるため。
     *
     * 無いまま代入すると、ここで main() ごと落ちる。地図も位置情報も
     * 発車待ちも出なくなる——環境音は無くても成り立つ飾りなのに、
     * 作品の本体を道連れにしてしまう。見つからなければ黙って飛ばす
     * （設計書 9.3「無いなら出さない」。js/popularity.js と同じ構え）。
     */
    if (planSoundCheck) planSoundCheck.checked = loadSoundPref();
    planSetup.hidden = false;
  }

  function setPlan(plan) {
    currentPlan = plan;
    savePlan(plan);
    updatePlanChip();
    frameOnBoardStation(plan);
    /*
     * デモ走行の操作盤にも映す。
     *
     * main() は区間設定画面が閉じるのを待たずに走行シミュレーターを
     * 起動する（初回起動では、Simulator.start の時点で乗車区間はまだ
     * 決まっていない）ので、決まった・選び直されたタイミングでここから
     * 追いかけて反映する。demoRequested() でないときは Simulator 自体が
     * 読み込まれていない。
     */
    if (demoRequested() && typeof Simulator !== 'undefined' && Simulator.current) {
      Simulator.current.applyPlan(plan);
    }
    if (stationPanel) stationPanel.refresh();
    // 区間を選び直したら、それは次の旅。前の旅の「終わった」札を下ろす
    if (trip) trip.resume();
  }

  planBoard.addEventListener('change', updatePlanValidity);
  planAlight.addEventListener('change', updatePlanValidity);

  planSubmit.addEventListener('click', () => {
    if (planBoard.value === planAlight.value) return;
    /*
     * requestPermission はユーザー操作（クリック）の中でしか呼べない
     * ブラウザが多い。「決定」のクリックそのものがその操作にあたる。
     * すでに許可済み・拒否済みなら、ここに来たときは行ごと隠れているので
     * 呼ばれない（disabled のチェックは checked のまま届く）。
     */
    if (NOTIFY_SUPPORTED && !planNotify.hidden && planNotifyCheck.checked && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    /*
     * 環境音の自動再生の許可も、このクリックの中で取っておく（unlock の注記）。
     * Ambient がまだ読み込めていなければ、この旅では鳴らないだけ（設計書 9.3）。
     */
    // 切り替えそのものが無ければ、環境音は使わない（openPlanSetup の注記）
    if (planSoundCheck) {
      saveSoundPref(planSoundCheck.checked);
      if (typeof Ambient !== 'undefined') {
        Ambient.setEnabled(planSoundCheck.checked);
        if (planSoundCheck.checked) Ambient.unlock();
      }
    }
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

  /*
   * 標高の色分け（開始画面の路線選択と同じ 6 段。js/main.js の pickLine）。
   * 乗車中は「ⓘ→出典」からしか地図の凡例に戻れないので、ここにも出す。
   * 数字はこの路線だけの実測値（terrain.json の elevationAlongRoute、
   * tools/build-terrain.js が線路沿いの生の標高から求めた min/max）。
   */
  /*
   * この凡例の置き場所が index.html にまだ無いことがある（作りかけの
   * 状態で JS だけが先に入ったとき）。無ければ凡例を出さないだけにする。
   * ここで落とすと、出典の凡例のために地図と位置情報まで道連れになる
   * （設計書 9.3「無いなら出さない」）。
   */
  const creditsElevationBar = document.getElementById('credits-elevation-bar');
  if (creditsElevationBar) {
    for (const meters of [0, 8, 16, 24, 32, 45]) {
      const cell = document.createElement('span');
      cell.className = 'line-legend-cell';
      cell.style.background = `var(--land-${meters})`;
      creditsElevationBar.appendChild(cell);
    }
  }
  const creditsElevationRange = document.getElementById('credits-elevation-range');
  if (creditsElevationRange && terrain.elevationAlongRoute) {
    creditsElevationRange.textContent =
      `${terrain.elevationAlongRoute.min}〜${terrain.elevationAlongRoute.max}m`;
  }

  /*
   * 時刻表と絶景スポットの解説の出どころは、路線ごとに違う。
   * data/lines.json の credits から入れる。静的に書いておくと、有楽町線を
   * 見ているのに「銚子電気鉄道 公式サイト」と出たままになる（実際そうなっていた）。
   *
   * spots は無い路線があるので、そのときは dt ごと隠す。
   * 「無いなら出さない」（設計書 9.3）で、空の見出しを残さない。
   */
  const lineCredits = (currentLine && currentLine.credits) || {};
  const creditsTimetable = document.getElementById('credits-timetable');
  if (creditsTimetable) {
    creditsTimetable.textContent = lineCredits.timetable || '―';
  }
  const creditsSpots = document.getElementById('credits-spots');
  const creditsSpotsTerm = document.getElementById('credits-spots-term');
  if (creditsSpots && creditsSpotsTerm) {
    const hasSpotCredits = Boolean(lineCredits.spots);
    if (hasSpotCredits) creditsSpots.textContent = lineCredits.spots;
    creditsSpots.hidden = !hasSpotCredits;
    creditsSpotsTerm.hidden = !hasSpotCredits;
  }

  /*
   * 出典を開けるのは、上の帯の中の「出典」からだけ。つまりここへ来るときは
   * 帯が出ている。読んでいるあいだに帯がひとりでに畳まれないよう時計を止め、
   * 閉じたところで数え直す。帯を新たに出しているわけではない。
   */
  document.getElementById('credits-open')
    .addEventListener('click', () => { credits.hidden = false; chrome.hold(); });

  function closeCredits() {
    credits.hidden = true;
    chrome.foldLater();
  }

  document.getElementById('credits-close').addEventListener('click', closeCredits);
  // 外側を押しても閉じる。読み終えたらすぐ地図へ戻れるように
  credits.addEventListener('click', (event) => {
    if (event.target === credits) closeCredits();
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

  // 地図が出た時点で読み始めてある。ここまでに届いていれば待ち時間は無い
  const journal = await journalReady
    .then(() => createJournal(spotsFile.spots, spotsFile.closings, route, askText))
    .catch(() => silentJournal());

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
    // 追従で地図が動いているあいだ、指で触っているときと同じ軽いモードにする
    motion,
  });

  // 記録を閉じたら、まだ乗っているとみなして車上モードへ戻れるようにする
  journal.onClose(() => trip.resume());

  // 地図を指で動かしたら、現在位置を追うのをやめる（設計書 4.3）
  mapElement.addEventListener('pointerdown', () => trip.stopFollowing());
  mapElement.addEventListener('wheel', () => trip.stopFollowing(), { passive: true });

  // 発車待ちのあいだに、成因カードの絵を先読みしておく（設計書 6.2）
  stationPanel.onArrive(() => preloadPanelImages(spotsFile.spots));

  setUpPhotoButton(journal, () => trip.passedLog(), askText);

  /*
   * ふだんは端末の位置情報を見張る。?demo=1 のときだけ、
   * そのかわりに走行シミュレーターへ運転をまかせる（両方は動かさない）。
   */
  if (demoRequested()) {
    await loadScript('js/simulate.js');
    Simulator.start({
      route, spots: spotsFile.spots, schedule, trip, setWeather: applyWeather, getPlan,
      // 位置まわりの経過時間を、実時計ではなくこの列車の時計で測らせる
      usePositionClock,
    });
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
