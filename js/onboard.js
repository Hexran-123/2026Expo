/*
 * 車上モードの計算
 *
 * 「いま線路のどこにいて、どちらへ向かっていて、次のスポットまで何秒か」を求める。
 * 画面には触らない。node で確かめられる（js/onboard.test.js）。
 *
 * 設計書 3.2（モードの判定）・3.3（通知が出るまで）・4.3（通知帯）に対応する。
 */

(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // 決めた値（設計書 3.2 / 4.3）
  // ------------------------------------------------------------------

  /** 線路上とみなす、軌道からの距離（m） */
  const ON_ROUTE_METERS = 30;

  /** 電車の速さの下限（m/s）。時速 15km。歩く速さ（時速 10.8km）と分けるため */
  const TRAIN_SPEED_MPS = 15000 / 3600;

  /** 進行方向が線路の向きと合っているとみなす、内積のしきい値（およそ 60 度以内） */
  const HEADING_AGREEMENT = 0.5;

  /** この秒数を切ったら接近を知らせる */
  const NOTICE_SECONDS = 45;

  /** 秒数はこの刻みで見せる。1 秒ずつ減る数字は気が散る */
  const NOTICE_STEP_SECONDS = 5;

  /** ここまで近づいたら「○○側の車窓を見てください」に変える（m） */
  const LOOK_NOW_METERS = 100;

  /**
   * 停まっているあいだに知らせてよい、残りの距離（m）。
   *
   * 停車中は速度が 0 なので「残り距離 ÷ 速度」が使えない。かといって
   * 距離を見ずに知らせると、西海鹿島に停まっているだけで 1,954m 先の
   * ひまわり畑に「まもなく」が出た。しかも振動は 1 スポットに一度きりなので、
   * **本当に近づいたときには鳴らない**。見逃さないための作品で、
   * いちばんしてはいけない外し方だった。
   *
   * 300m にしてあるのは、この線の走りで NOTICE_SECONDS（45 秒）に
   * だいたい相当するため。停まっていても、発車すればすぐ見える距離。
   */
  const STOPPED_NOTICE_METERS = 300;

  /** 位置情報が途切れてから、推定を続ける上限（ミリ秒） */
  const DEAD_RECKON_LIMIT_MS = 60000;

  /** 路線から外れた状態がこれだけ続いたら、降りたとみなす（ミリ秒） */
  const OFF_ROUTE_LIMIT_MS = 15000;

  /** 遅れを出しはじめる大きさ（分）。これ未満は「予定どおり」 */
  const DELAY_MINUTES_FLOOR = 1;

  /** 進行方向を決めるのに要る移動（m）。これ未満は「停まっている」とみなす */
  const DIRECTION_METERS = 5;

  /** いちど決まった進行方向を、逆に決め直すのに要る移動（m） */
  const DIRECTION_REVERSE_METERS = 60;

  const EARTH_RADIUS = 6371000;

  // ------------------------------------------------------------------
  // 距離と射影
  // ------------------------------------------------------------------

  const toRadians = (degrees) => (degrees * Math.PI) / 180;

  /** 2 地点の距離（m）。全長 6.4km の範囲なので、地球を球とみなせば十分。 */
  function distanceMeters(lat1, lon1, lat2, lon2) {
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
  }

  /**
   * 軌道の折れ線に、各点までの累積距離を持たせる。
   *
   * route.json は座標の並びしか持っていないので、一度だけここで計算しておく。
   * 以降の射影はこの表を引くだけで済む。
   */
  function prepareTrack(route) {
    const points = route.track.map(([lat, lon]) => ({ lat, lon, along: 0 }));
    for (let i = 1; i < points.length; i += 1) {
      const step = distanceMeters(
        points[i - 1].lat, points[i - 1].lon,
        points[i].lat, points[i].lon
      );
      points[i].along = points[i - 1].along + step;
    }
    return points;
  }

  /**
   * 現在地を軌道の上へ落とす。
   *
   * 折れ線の各区間へ垂線を下ろし、いちばん近い区間を選ぶ。
   * 緯度経度のままでは角度なので、いったんメートルの平面に直してから解く。
   * 全長 6.4km では、この近似で誤差は無視できる。
   *
   * @returns {{along:number, offset:number}} along=起点からの距離、offset=軌道からの隔たり
   */
  function projectOntoTrack(track, lat, lon) {
    // 経度 1 度あたりの距離は緯度で縮む。その補正だけ入れる。
    const latScale = EARTH_RADIUS * Math.PI / 180;
    const lonScale = latScale * Math.cos(toRadians(lat));

    const x = lon * lonScale;
    const y = lat * latScale;

    let best = { along: 0, offset: Infinity };

    for (let i = 1; i < track.length; i += 1) {
      const ax = track[i - 1].lon * lonScale;
      const ay = track[i - 1].lat * latScale;
      const bx = track[i].lon * lonScale;
      const by = track[i].lat * latScale;

      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared === 0) continue;

      // 区間のどのあたりに落ちるか。0 が手前の端、1 が先の端。
      let t = ((x - ax) * dx + (y - ay) * dy) / lengthSquared;
      t = Math.max(0, Math.min(1, t));

      const offset = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
      if (offset < best.offset) {
        const segment = track[i].along - track[i - 1].along;
        best = { along: track[i - 1].along + segment * t, offset };
      }
    }
    return best;
  }

  /**
   * 進行方向が、その地点の線路の向きとそろっているか。
   *
   * 線路と並んで走る車を除くために見る（設計書 3.2）。
   * heading は北を 0 として時計回りの度数（Geolocation API が返すもの）。
   */
  function agreesWithTrack(track, along, heading) {
    if (heading === null || heading === undefined || Number.isNaN(heading)) {
      // 向きが取れない端末もある。そのときは邪魔をしない。
      return true;
    }

    // その地点の前後を見て、線路の向きを求める
    let index = 1;
    while (index < track.length - 1 && track[index].along < along) index += 1;

    const from = track[index - 1];
    const to = track[index];
    const latScale = EARTH_RADIUS * Math.PI / 180;
    const lonScale = latScale * Math.cos(toRadians(from.lat));

    const trackX = (to.lon - from.lon) * lonScale;
    const trackY = (to.lat - from.lat) * latScale;
    const trackLength = Math.hypot(trackX, trackY) || 1;

    const moveX = Math.sin(toRadians(heading));
    const moveY = Math.cos(toRadians(heading));

    // 線路には向きが二つある（上りと下り）ので、絶対値で見る
    const alignment = Math.abs((trackX * moveX + trackY * moveY) / trackLength);
    return alignment >= HEADING_AGREEMENT;
  }

  // ------------------------------------------------------------------
  // 乗っているかどうか
  // ------------------------------------------------------------------

  /**
   * 車上モードに入る条件を満たしているか（設計書 3.2）。
   * 線路の上にいて、線路の向きに、電車の速さで動いている。
   */
  function looksLikeRiding(track, coords) {
    if (coords.speed === null || coords.speed === undefined) return false;
    if (coords.speed < TRAIN_SPEED_MPS) return false;

    const place = projectOntoTrack(track, coords.latitude, coords.longitude);
    if (place.offset > ON_ROUTE_METERS) return false;

    return agreesWithTrack(track, place.along, coords.heading);
  }

  /** 線路の上にいるか（速さは見ない）。抜けるかどうかの判定に使う。 */
  function isOnRoute(track, coords) {
    return projectOntoTrack(track, coords.latitude, coords.longitude).offset <= ON_ROUTE_METERS;
  }

  /**
   * 進行方向。距離が増えていれば外川ゆき（下り）。
   * 動いていなければ前の判定を保つ。停車のたびに向きを見失わないため。
   *
   * いちど決まった向きを裏返すには、もっと大きく動いていないといけない。
   * 位置情報は停車中でも 10m ほど揺れるし、電波が戻ったときには推定との
   * ずれがまとめて入る。5m で裏返してしまうと、そのたびに案内する車窓が
   * 左右入れかわる。銚子電鉄は途中で引き返さないので、こちらを信じてよい。
   */
  function directionOf(previousAlong, currentAlong, previousDirection) {
    const moved = currentAlong - previousAlong;
    const seen = moved > 0 ? '下り' : '上り';

    if (previousDirection === null || previousDirection === undefined || seen === previousDirection) {
      return Math.abs(moved) < DIRECTION_METERS ? previousDirection : seen;
    }
    return Math.abs(moved) >= DIRECTION_REVERSE_METERS ? seen : previousDirection;
  }

  /**
 * 向きを決めながら、次に比べる元の位置も返す。
 *
 * directionOf は「2 点の差」で決めるが、その 2 点をどう選ぶかで結果が変わる。
 * 位置情報が来るたびに比べ元を進めてしまうと、1 回あたりの差が判定に要る
 * DIRECTION_METERS に届かない場面で、いつまでも向きが決まらない。
 * 位置情報の間隔は端末まかせで決められないうえ、時速 15km（車上モードに入る
 * 速さ）で 1 秒ごとなら 1 回 4.2m しかなく、まさにその状況にあたる。
 *
 * そこで、決められるだけ動いたときにだけ比べ元を進める。
 * 届かなかったぶんは次へ持ちこして足し合わせる。
 *
 * @returns {{direction:string|null, anchorAlong:number}} 向きと、次の比べ元
 */
function trackDirection(anchorAlong, currentAlong, previousDirection) {
  const direction = directionOf(anchorAlong, currentAlong, previousDirection);
  const decided = Math.abs(currentAlong - anchorAlong) >= DIRECTION_METERS;
  return { direction, anchorAlong: decided ? currentAlong : anchorAlong };
}

/** その進行方向で、まだ前方にある絶景スポットを近い順に返す */
  function spotsAhead(spots, along, direction) {
    return spots
      .filter((spot) => (direction === '下り' ? spot.distanceAlong > along : spot.distanceAlong < along))
      .sort((a, b) =>
        direction === '下り'
          ? a.distanceAlong - b.distanceAlong
          : b.distanceAlong - a.distanceAlong
      );
  }

  // ------------------------------------------------------------------
  // 通知（設計書 4.3）
  // ------------------------------------------------------------------

  /** 「右」→「右の窓」。両側から見えるスポットもあるので、そこだけ書き分ける。 */
  function windowSideOf(spot, direction) {
    return direction === '下り' ? spot.sideDown : spot.sideUp;
  }

  /**
   * このスポットは、そもそも事前の予告を出す相手か（設計書 8.2）。
   *
   * kind: 'trivia'（車窓に出ない雑学。地下区間など）は出さない。
   * kind が無いスポットは景色ものとして扱う（既存路線を壊さないため）。
   *
   * noticeFor が同じことを内側でも見ているのに別に出してあるのは、
   * 呼ぶ側が「次に予告する相手」を選ぶのに要るため。前方のいちばん近い
   * ものが雑学だと、そこで打ち止めになって、その先の景色ものが
   * 近づいても何も出なくなる（js/main.js の updateRiding）。
   */
  function announces(spot) {
    return Boolean(spot) && spot.kind !== 'trivia';
  }

  /**
   * いま出すべき通知。出すものが無ければ null。
   *
   * 秒数は「残り距離 ÷ 速度」で求める。固定の距離にしないのは、
   * 銚子電鉄が駅ごとに加減速するため（設計書 3.3）。
   *
   * ただし 100m を切ったら秒数を使うのをやめ、「見てください」に変える。
   * 駅と同じ地点にあるスポット（森のトンネル・河津桜）では、
   * 距離と速度が同時に小さくなって割り算の答えが減らなくなるため。
   */
  function noticeFor(spot, along, direction, speedMps) {
    if (spot === undefined || spot === null) return null;

    /*
     * 雑学メイン（車窓に出ない）のスポットは、通知そのものを出さない。
     *
     * spot.kind === 'trivia' は、見えない・見せられないものを
     * 「まもなく」「見てください」と急かさないための印（設計書 8.2）。
     * 通過の記録や成因カードは、これとは別の場所（js/main.js の
     * markPassed）で判定しているので、雑学スポットも通り過ぎれば
     * ふつうに記録される。ここで止めるのは、事前の予告と振動・
     * ロック中通知（notifyOS）だけ。kind が無いスポット（未設定）は
     * 景色ものとして扱う（既存路線を壊さないため）。
     */
    if (!announces(spot)) return null;

    const remaining = Math.abs(spot.distanceAlong - along);
    const side = windowSideOf(spot, direction);

    if (remaining <= LOOK_NOW_METERS) {
      return { spot, side, phase: 'いま', remaining };
    }

    // 停まっているあいだは秒数を出さない（0 で割れないし、出しても嘘になる）。
    // 出すかどうかは距離で決める（STOPPED_NOTICE_METERS）。
    if (speedMps === null || speedMps === undefined || speedMps <= 0) {
      if (remaining > STOPPED_NOTICE_METERS) return null;
      return { spot, side, phase: 'まもなく', remaining, seconds: null };
    }

    const seconds = remaining / speedMps;
    if (seconds > NOTICE_SECONDS) return null;

    // 5 秒刻みに丸める。1 秒ずつ減る数字は気が散る。
    const shown = Math.max(
      NOTICE_STEP_SECONDS,
      Math.round(seconds / NOTICE_STEP_SECONDS) * NOTICE_STEP_SECONDS
    );
    return { spot, side, phase: 'まもなく', remaining, seconds: shown };
  }

  // ------------------------------------------------------------------
  // 遅れ（設計書 4.3）
  // ------------------------------------------------------------------

  /**
   * いま乗っている列車が、時刻表からどれだけ遅れているか（分）。
   *
   * 時刻表のうえでの位置と実際の位置を、時間に直して引く。
   * 求まらないとき・1 分未満のときは null（何も出さない）。
   *
   * @param {object} scheduleTools js/schedule.js が出す道具
   */
  function delayMinutes(scheduleTools, schedule, route, direction, along, now) {
    const running = scheduleTools.runningTrains(schedule, direction, now);
    if (running.length !== 1) return null; // どの列車か決められないなら黙る

    const train = running[0];
    const scheduled = scheduleTools.scheduledDistance(schedule, route, train, now);
    if (scheduled === null) return null;

    // 予定より手前にいれば遅れ。進行方向で符号が入れかわる。
    const behind = direction === '下り' ? scheduled - along : along - scheduled;
    if (behind <= 0) return null;

    /*
     * 距離のずれを時間に直す。その列車の平均の速さを使う。
     *
     * 駅は必ず駅順に並べ直してから両端を取る。時刻表は人が手で書くファイルで、
     * 上りの列車の時刻を（下りと同じ）銚子→外川の順に書くこともできる。
     * 並べ直さずに書いてある順の両端を取っていたころは、その書き方をすると
     * 終わりの時刻が始まりより早くなり、平均の速さが負になって、
     * **その列車の遅れが二度と出なくなっていた**（画面にはエラーも出ない）。
     */
    const order = schedule.駅順[train.方向];
    const stops = Object.keys(train.時刻).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const first = scheduleTools.toMinutes(train.時刻[stops[0]]);
    const last = scheduleTools.toMinutes(train.時刻[stops[stops.length - 1]]);
    const distanceOf = new Map(route.stations.map((s) => [s.name, s.distanceAlong]));
    const span = Math.abs(distanceOf.get(stops[stops.length - 1]) - distanceOf.get(stops[0]));
    if (span === 0 || last === first) return null;

    const minutes = behind / (span / (last - first));
    return minutes >= DELAY_MINUTES_FLOOR ? Math.round(minutes) : null;
  }

  /**
   * 次に停まる駅と、その時刻表上の到着予定時刻（分）。
   *
   * 遅れ（delayMinutes）が分かっているときに足し合わせれば、
   * 「実際は何時に着きそうか」が求まる（設計書4.3、乗り継ぎのための表示）。
   * どの列車か決められない・もう次の停車駅が無い（終点を過ぎた）ときは null。
   *
   * @param {object} scheduleTools js/schedule.js が出す道具
   */
  function nextStopEta(scheduleTools, schedule, route, direction, along, now) {
    const running = scheduleTools.runningTrains(schedule, direction, now);
    if (running.length !== 1) return null;

    const train = running[0];
    const order = schedule.駅順[direction];
    const distanceOf = new Map(route.stations.map((s) => [s.name, s.distanceAlong]));
    const stops = Object.keys(train.時刻)
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .map((name) => ({ name, distance: distanceOf.get(name), minute: scheduleTools.toMinutes(train.時刻[name]) }));

    const ahead = direction === '下り'
      ? stops.find((s) => s.distance > along)
      : [...stops].reverse().find((s) => s.distance < along);
    if (!ahead) return null;

    return { station: ahead.name, scheduledMinute: ahead.minute };
  }

  global.Onboard = {
    ON_ROUTE_METERS,
    TRAIN_SPEED_MPS,
    NOTICE_SECONDS,
    LOOK_NOW_METERS,
    DEAD_RECKON_LIMIT_MS,
    OFF_ROUTE_LIMIT_MS,

    distanceMeters,
    prepareTrack,
    projectOntoTrack,
    agreesWithTrack,
    looksLikeRiding,
    isOnRoute,
    directionOf,
    trackDirection,
    spotsAhead,
    windowSideOf,
    announces,
    noticeFor,
    delayMinutes,
    nextStopEta,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
