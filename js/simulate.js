/*
 * 走行シミュレーター（テスト専用）
 *
 * 銚子まで行かなくても、乗車前 → 発車待ち → 車上 → 降車後 のひと通りを
 * 机の上で確かめるための道具。位置情報のふりをして、data/schedule.json の
 * 時刻表どおりに電車を走らせる。
 *
 * URL に ?demo=1 を付けたときだけ読み込まれる（js/main.js の末尾）。
 * 本番の画面はこのファイルを一度も通らない。見た目もこの中に閉じてあるので
 * （css/style.css を触っていない）、要らなくなったらファイルごと消せる。
 *
 * 走らせ方は「時刻表に従い、間に合うぶんには普通の速さで走って駅で待つ」。
 * 区間の所要時間から巡航速度を割り出すと、6 分かかる区間（笠上黒生の
 * 行き違い待ち）で時速 10km になってしまい、電車らしくないため。
 */

(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // 走りかた
  // ------------------------------------------------------------------

  /** 加速・減速のはやさ（m/s²）。電車としてはおとなしめ */
  const ACCELERATION = 0.7;

  /** 巡航速度の下限・上限（m/s）。上限 11.1 は銚子電鉄の最高速度 40km/h */
  const MIN_CRUISE = 7;
  const MAX_CRUISE = 11.1;

  /** 駅での最低停車時間（秒）。時刻表より早く着いても、これだけは停まる */
  const MIN_DWELL_SECONDS = 20;

  /*
   * 画面を進める間隔（実時間のミリ秒）。ここで位置情報を 1 回渡す。
   * 500ms だと ×1 のとき現在位置の印が飛び飛びに見える（低速では実際の
   * 移動量も小さいので、まばらな更新がそのまま目立つ）。200ms にして
   * 実機のGPS更新よりむしろ細かくし、テスト走行での見た目を滑らかにする。
   */
  const TICK_MS = 200;

  /** 物理計算のきざみ（仮想秒）。速さを上げても飛び越さないように */
  const STEP_SECONDS = 0.5;

  /** 発車の何分前から始めるか */
  const PREBOARD_MINUTES = 3;

  /** 位置をばらつかせるときの大きさ（m）。実機の位置情報はこのくらいずれる */
  const JITTER_METERS = 8;

  /** 「次のスポットへ」で、スポットの何 m 手前に降ろすか */
  const JUMP_MARGIN_METERS = 320;

  const EARTH_RADIUS = 6371000;

  // ------------------------------------------------------------------
  // 軌道の上を歩く
  // ------------------------------------------------------------------

  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const toDegrees = (radians) => (radians * 180) / Math.PI;

  /** 起点からの距離（m）から、緯度経度と線路の向きを求める */
  function positionAt(track, along) {
    const last = track[track.length - 1];
    const clamped = Math.max(0, Math.min(last.along, along));

    let index = 1;
    while (index < track.length - 1 && track[index].along < clamped) index += 1;

    const from = track[index - 1];
    const to = track[index];
    const span = to.along - from.along || 1;
    const t = (clamped - from.along) / span;

    // 線路の向き（北を 0 とする度数）。Geolocation API の heading と同じ決まり
    const dLon = toRadians(to.lon - from.lon) * Math.cos(toRadians(from.lat));
    const dLat = toRadians(to.lat - from.lat);
    const bearing = (toDegrees(Math.atan2(dLon, dLat)) + 360) % 360;

    return {
      latitude: from.lat + (to.lat - from.lat) * t,
      longitude: from.lon + (to.lon - from.lon) * t,
      bearing,
    };
  }

  /** 位置を少しずらす。実機の位置情報のばらつきを真似る */
  function scatter(place, meters) {
    const latPerMeter = 1 / ((EARTH_RADIUS * Math.PI) / 180);
    const lonPerMeter = latPerMeter / Math.cos(toRadians(place.latitude));
    return {
      latitude: place.latitude + (Math.random() - 0.5) * 2 * meters * latPerMeter,
      longitude: place.longitude + (Math.random() - 0.5) * 2 * meters * lonPerMeter,
      bearing: place.bearing,
    };
  }

  // ------------------------------------------------------------------
  // どの列車に乗るか
  // ------------------------------------------------------------------

  /** その駅から、その向きへ、これから発車する列車。無ければその日の一番はじめの列車 */
  function pickTrain(schedule, stationName, direction, fromMinutes) {
    const order = schedule.駅順[direction];
    const here = order.indexOf(stationName);

    const candidates = schedule.列車
      .filter((train) => train.方向 === direction)
      .filter((train) => train.時刻[stationName] !== undefined)
      // その駅が終点の列車には乗れない
      .filter((train) => Object.keys(train.時刻).some((name) => order.indexOf(name) > here))
      .map((train) => ({ train, minute: Schedule.toMinutes(train.時刻[stationName]) }))
      .sort((a, b) => a.minute - b.minute);

    if (candidates.length === 0) return null;
    return candidates.find((entry) => entry.minute >= fromMinutes) || candidates[0];
  }

  /** その列車の停車駅を、通る順に。距離と時刻を添えて */
  function stopsOf(schedule, route, train, fromStation) {
    const order = schedule.駅順[train.方向];
    const distanceOf = new Map(route.stations.map((s) => [s.name, s.distanceAlong]));

    return Object.keys(train.時刻)
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .filter((name) => order.indexOf(name) >= order.indexOf(fromStation))
      .map((name) => ({
        name,
        along: distanceOf.get(name),
        minute: Schedule.toMinutes(train.時刻[name]),
      }));
  }

  /**
   * この区間の巡航速度。
   *
   * 所要時間 T のあいだに距離 d を進むなら、加速と減速のぶんを入れて
   * T = v/a + d/v。これを v について解く。時刻表がゆるい区間では
   * 答えが遅くなりすぎるので、下限で持ち上げて早着させる（駅で待つ）。
   */
  function cruiseFor(distance, runSeconds) {
    const discriminant = (ACCELERATION * runSeconds) ** 2 - 4 * ACCELERATION * distance;
    const solved = discriminant > 0
      ? (ACCELERATION * runSeconds - Math.sqrt(discriminant)) / 2
      : Math.sqrt(ACCELERATION * distance); // 間に合わない区間は目一杯で走る
    return Math.min(MAX_CRUISE, Math.max(MIN_CRUISE, solved));
  }

  // ------------------------------------------------------------------
  // 本体
  // ------------------------------------------------------------------

  function create({ route, spots, schedule, trip }) {
    const track = Onboard.prepareTrack(route);
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    const state = {
      playing: false,
      rate: 5,
      /** その列車の時計。ここが物理の時間そのもの（ミリ秒） */
      virtualMs: 0,
      /** アプリに見せる時計のずれ（分）。遅れを作るのに使う */
      delayMinutes: 0,
      offline: false,
      jitter: false,

      stops: [],
      /** いま向かっている停車駅（stops のうち何番目か） */
      target: 1,
      direction: '下り',
      along: 0,
      speed: 0,
      cruise: MIN_CRUISE,
      /** 'wait'（駅で待つ）/ 'run'（走る）/ 'done'（着いた） */
      phase: 'wait',
      trainNumber: null,
    };

    /** アプリに見せる時刻。遅れのぶんだけ先へずらす */
    function shownClock() {
      return new Date(state.virtualMs + state.delayMinutes * 60000);
    }
    Schedule.useClock(shownClock);

    // ---- 仕立てる ----

    function setUp(stationName, direction) {
      const wallMinutes = Schedule.minutesOfDay(new Date());
      const picked = pickTrain(schedule, stationName, direction, wallMinutes);
      if (picked === null) return false;

      state.direction = direction;
      state.trainNumber = picked.train.番号;
      state.stops = stopsOf(schedule, route, picked.train, stationName);
      state.target = 1;
      state.along = state.stops[0].along;
      state.speed = 0;
      state.phase = 'done';
      state.virtualMs = dayStart.getTime() + (picked.minute - PREBOARD_MINUTES) * 60000;

      if (state.stops.length > 1) {
        state.phase = 'wait';
        state.cruise = legCruise(0);
      }
      send();
      return true;
    }

    function legCruise(fromIndex) {
      const from = state.stops[fromIndex];
      const to = state.stops[fromIndex + 1];
      const distance = Math.abs(to.along - from.along);
      const runSeconds = Math.max(30, (to.minute - from.minute) * 60 - MIN_DWELL_SECONDS);
      return cruiseFor(distance, runSeconds);
    }

    // ---- 時間を進める ----

    function advance(seconds) {
      state.virtualMs += seconds * 1000;
      const minutes = Schedule.minutesOfDay(new Date(state.virtualMs));

      if (state.phase === 'wait') {
        state.speed = 0;
        // 時刻表の発車時刻になったら動きだす
        if (minutes >= state.stops[state.target - 1].minute) {
          state.phase = 'run';
          state.cruise = legCruise(state.target - 1);
        }
        return;
      }
      if (state.phase !== 'run') return;

      const to = state.stops[state.target];
      const sign = state.direction === '下り' ? 1 : -1;
      const remaining = Math.abs(to.along - state.along);

      // 止まりきれる距離まで来たら減速に入る
      const braking = (state.speed * state.speed) / (2 * ACCELERATION);
      state.speed = remaining <= braking + 1
        ? Math.max(0, state.speed - ACCELERATION * seconds)
        : Math.min(state.cruise, state.speed + ACCELERATION * seconds);

      state.along += sign * state.speed * seconds;

      const arrived = sign > 0 ? state.along >= to.along : state.along <= to.along;
      if (arrived || (remaining < 2 && state.speed < 0.5)) {
        state.along = to.along;
        state.speed = 0;
        state.target += 1;
        // 終点なら、そこで終わり。アプリはこれを見て降車後へ移る
        state.phase = state.target >= state.stops.length ? 'done' : 'wait';
      }
    }

    // ---- アプリへ渡す ----

    function send() {
      const raw = positionAt(track, state.along);
      const place = state.jitter ? scatter(raw, JITTER_METERS) : raw;

      trip.onPosition(
        {
          latitude: place.latitude,
          longitude: place.longitude,
          accuracy: state.jitter ? JITTER_METERS : 5,
          speed: state.speed,
          // 停まっているあいだ、実機は向きを返さないことが多い
          heading: state.speed > 0.5
            ? (state.direction === '下り' ? place.bearing : (place.bearing + 180) % 360)
            : null,
        },
        state.virtualMs
      );
    }

    let timer = null;

    function tick() {
      let remaining = (TICK_MS / 1000) * state.rate;
      while (remaining > 0) {
        const step = Math.min(STEP_SECONDS, remaining);
        advance(step);
        remaining -= step;
      }

      // 電波が無いあいだは位置を渡さない。アプリ側の推定（設計書 3.3）が働く
      if (state.offline) trip.onStale(state.virtualMs);
      else send();

      render();
    }

    function play(on) {
      state.playing = on;
      if (timer !== null) clearInterval(timer);
      timer = on ? setInterval(tick, TICK_MS) : null;
      render();
    }

    // ---- 飛ばす ----

    /** 次のまだ通過していないスポットの手前へ移る */
    function jumpToNextSpot() {
      if (state.phase === 'done') return;
      const ahead = Onboard.spotsAhead(spots, state.along, state.direction)
        .filter((spot) => !trip.isPassed(spot.id));
      if (ahead.length === 0) return;

      const sign = state.direction === '下り' ? 1 : -1;
      const wanted = ahead[0].distanceAlong - sign * JUMP_MARGIN_METERS;

      // 飛んだ先が、いま向かっている駅より先なら、目標の駅も繰り上げる
      state.along = Math.max(0, Math.min(route.totalLength, wanted));
      while (
        state.target < state.stops.length - 1 &&
        (sign > 0 ? state.stops[state.target].along < state.along
                  : state.stops[state.target].along > state.along)
      ) {
        state.target += 1;
      }
      state.phase = 'run';
      state.speed = state.cruise = legCruise(state.target - 1);
      send();
      render();
    }

    /** 終点の手前へ移る。降車後（旅の記録）を見にいくため */
    function jumpToEnd() {
      if (state.stops.length < 2) return;
      const last = state.stops[state.stops.length - 1];
      const sign = state.direction === '下り' ? 1 : -1;
      state.along = last.along - sign * 260;
      state.target = state.stops.length - 1;
      state.phase = 'run';
      state.speed = state.cruise = MIN_CRUISE;
      send();
      render();
    }

    async function clearRecords() {
      try { localStorage.removeItem('choshi-navi/trip'); } catch { /* 使えない設定 */ }
      try { indexedDB.deleteDatabase('choshi-navi'); } catch { /* 使えない設定 */ }
      location.reload();
    }

    let render = () => {};
    function onRender(fn) { render = fn; }

    return {
      state,
      setUp,
      play,
      tick,
      jumpToNextSpot,
      jumpToEnd,
      clearRecords,
      onRender,
      shownClock,
      /** アプリが今どのモードにいるか（操作盤の表示に使う） */
      mode: trip.mode,
      /** 次に通るスポットの名前。操作盤の表示に使う */
      nextSpot: () => {
        const ahead = Onboard.spotsAhead(spots, state.along, state.direction)
          .filter((spot) => !trip.isPassed(spot.id));
        return ahead.length > 0 ? ahead[0].name : null;
      },
    };
  }

  // ------------------------------------------------------------------
  // 操作盤
  //
  // テスト専用なので、見た目は css/style.css ではなくここに置く。
  // 本番の画面と混ざらないよう、名前は sim- で始める。
  // ------------------------------------------------------------------

  const STYLE = `
  .sim {
    position: fixed; left: 10px; bottom: 10px; z-index: 100;
    width: 232px; padding: 10px 12px 11px;
    box-sizing: border-box;
    background: rgba(24, 26, 24, 0.92);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border-radius: 12px;
    color: #F2F0EA;
    font: 12px/1.5 system-ui, sans-serif;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
    user-select: none;
  }
  .sim-head { display: flex; align-items: center; gap: 6px; }
  .sim-head b { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; }
  .sim-head span { flex: 1; color: #9A978F; font-size: 11px; }
  .sim-fold {
    width: 22px; height: 22px; padding: 0; flex: none;
    background: none; border: 0; color: #F2F0EA; font-size: 13px; cursor: pointer;
  }
  /* たたんだら題だけにする。アプリのボタンに重なったままにしないため */
  .sim--folded { width: auto; }
  .sim--folded .sim-body { display: none; }
  .sim-body { margin-top: 9px; display: grid; gap: 7px; }
  .sim-row { display: flex; gap: 5px; }
  .sim select, .sim button {
    font: inherit; color: inherit; cursor: pointer;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 7px; padding: 5px 7px;
  }
  .sim select { flex: 1; min-width: 0; }
  .sim select option { color: #1C1E1C; }
  .sim-row button { flex: 1; }
  .sim button:hover { background: rgba(255, 255, 255, 0.2); }
  .sim button[aria-pressed="true"] { background: #C9A227; border-color: #C9A227; color: #1C1E1C; }
  .sim-num { display: flex; align-items: center; gap: 6px; flex: 1; }
  .sim-num span { color: #9A978F; white-space: nowrap; }
  .sim input[type="number"] {
    font: inherit; color: inherit;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 7px; padding: 5px 7px;
    width: 100%; min-width: 0;
  }
  .sim-play { font-weight: 600; }
  .sim-note { color: #9A978F; font-size: 11px; }
  .sim-status {
    margin: 1px 0 0; padding-top: 7px;
    border-top: 1px solid rgba(255, 255, 255, 0.14);
    display: grid; gap: 2px;
  }
  .sim-mode { font-weight: 600; }
  .sim-status span { color: #C8C5BC; }
  .sim-clear { color: #E0A0A0; }
  `;

  function mount(sim, route, setWeather) {
    document.head.appendChild(document.createElement('style')).textContent = STYLE;

    const panel = document.createElement('div');
    panel.className = 'sim';
    panel.innerHTML = `
      <div class="sim-head">
        <b>テスト走行</b><span id="sim-train"></span>
        <button type="button" class="sim-fold" id="sim-fold" aria-label="たたむ">▾</button>
      </div>
      <div class="sim-body">
        <div class="sim-row">
          <select id="sim-station" aria-label="乗る駅"></select>
          <select id="sim-direction" aria-label="向き">
            <option value="下り">下り</option>
            <option value="上り">上り</option>
          </select>
        </div>
        <div class="sim-row">
          <select id="sim-weather" aria-label="今日の天気（気象庁への通信はしない）">
            <option value="晴">晴</option>
            <option value="曇">曇</option>
            <option value="雨">雨</option>
            <option value="雪">雪</option>
          </select>
        </div>
        <div class="sim-row">
          <button type="button" class="sim-play" id="sim-play">▶ 動かす</button>
          <button type="button" id="sim-spot">次のスポット</button>
          <button type="button" id="sim-end">終点</button>
        </div>
        <div class="sim-row">
          <label class="sim-num"><span>速さ ×</span>
            <input type="number" id="sim-rate" min="0.5" max="60" step="0.5" value="5" />
          </label>
          <label class="sim-num"><span>遅れ 分</span>
            <input type="number" id="sim-delay" min="0" max="60" step="1" value="0" />
          </label>
        </div>
        <div class="sim-row">
          <button type="button" id="sim-offline" aria-pressed="false">電波なし</button>
          <button type="button" id="sim-jitter" aria-pressed="false">ばらつき</button>
        </div>
        <div class="sim-status">
          <div class="sim-mode" id="sim-mode"></div>
          <span id="sim-where"></span>
          <span id="sim-next"></span>
        </div>
        <button type="button" class="sim-clear" id="sim-clear">きょうの記録を消す</button>
      </div>
    `;
    document.body.appendChild(panel);

    const $ = (id) => panel.querySelector(`#${id}`);
    const stationSelect = $('sim-station');
    const directionSelect = $('sim-direction');
    const weatherSelect = $('sim-weather');
    const playButton = $('sim-play');

    /*
     * 天気×地図の組み合わせ（地図バッジの強調・弱め、発車待ちの見どころリスト）を、
     * 実際の気象庁への通信なしで試すためのもの。選ぶとその場で反映される。
     */
    weatherSelect.addEventListener('change', () => setWeather(weatherSelect.value));
    setWeather(weatherSelect.value);

    for (const station of route.stations) {
      const option = document.createElement('option');
      option.value = option.textContent = station.name;
      stationSelect.appendChild(option);
    }

    // 速さ・遅れは自由な数値で指定する（0分に戻すのも同じ入力でできる）
    const rateInput = $('sim-rate');
    const delayInput = $('sim-delay');
    rateInput.addEventListener('change', () => {
      sim.state.rate = Math.max(0.5, Number(rateInput.value) || 1);
      if (sim.state.playing) sim.play(true); // 間隔を作り直す
      update();
    });
    delayInput.addEventListener('change', () => {
      sim.state.delayMinutes = Math.max(0, Number(delayInput.value) || 0);
      update();
    });

    function toggle(id, key) {
      $(id).addEventListener('click', () => {
        sim.state[key] = !sim.state[key];
        update();
      });
    }
    toggle('sim-offline', 'offline');
    toggle('sim-jitter', 'jitter');

    function reload() {
      sim.play(false);
      // 端の駅では向きが決まっている
      const station = stationSelect.value;
      if (station === '銚子') directionSelect.value = '下り';
      if (station === '外川') directionSelect.value = '上り';
      directionSelect.disabled = station === '銚子' || station === '外川';
      sim.setUp(station, directionSelect.value);
      update();
    }
    stationSelect.addEventListener('change', reload);
    directionSelect.addEventListener('change', reload);

    playButton.addEventListener('click', () => sim.play(!sim.state.playing));
    $('sim-spot').addEventListener('click', () => sim.jumpToNextSpot());
    $('sim-end').addEventListener('click', () => sim.jumpToEnd());
    $('sim-clear').addEventListener('click', () => sim.clearRecords());
    function fold(folded) {
      panel.classList.toggle('sim--folded', folded);
      $('sim-fold').textContent = folded ? '▴' : '▾';
    }
    $('sim-fold').addEventListener('click', () => {
      fold(!panel.classList.contains('sim--folded'));
    });

    /*
     * スマートフォンの幅で試すときは、たたんだ状態から始める。
     * 画面いっぱいにアプリが広がるので、開いたままだと旅の記録の
     * 「画像として保存」やテーマの絞り込みの上に乗ってしまう。
     * パソコンの幅では、アプリ（430px）の横が空くので開いたまま出す。
     */
    fold(window.innerWidth < 900);

    const PHASE_TEXT = { wait: '駅で待つ', run: '走行中', done: '到着' };

    function update() {
      const state = sim.state;
      playButton.textContent = state.playing ? '⏸ 止める' : '▶ 動かす';
      // 入力中に値を書き戻すとカーソル位置が飛ぶので、フォーカスが無いときだけ揃える
      if (document.activeElement !== rateInput) rateInput.value = state.rate;
      if (document.activeElement !== delayInput) delayInput.value = state.delayMinutes;
      $('sim-offline').setAttribute('aria-pressed', String(state.offline));
      $('sim-jitter').setAttribute('aria-pressed', String(state.jitter));
      $('sim-train').textContent = state.trainNumber ? `${state.trainNumber}号` : '';

      const clock = sim.shownClock();
      $('sim-mode').textContent =
        `${sim.mode()}　${PHASE_TEXT[state.phase]}　${Schedule.toClock(Schedule.minutesOfDay(clock))}`;
      $('sim-where').textContent =
        `銚子から ${(state.along / 1000).toFixed(2)}km ・ ${Math.round(state.speed * 3.6)}km/h`;
      const next = sim.nextSpot();
      $('sim-next').textContent = next ? `次は ${next}` : 'この先のスポットはありません';
    }

    sim.onRender(update);
    reload();
  }

  global.Simulator = {
    /** js/main.js から呼ばれる入口 */
    start(parts) {
      const sim = create(parts);
      mount(sim, parts.route, parts.setWeather);
      /*
       * 動かしているものを外から掴めるようにしておく。
       * 手で押さなくても、Playwright から sim.tick() を呼んで
       * 一気に走らせられる（tools/ の通し確認）。
       */
      Simulator.current = sim;
      return sim;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
