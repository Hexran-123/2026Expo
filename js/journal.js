/*
 * 旅の記録（設計書 7）
 *
 * 降車後に、その日の乗車をまとめて見せる。
 *   ① 通過した絶景スポットの並び
 *   ② 乗客が撮った写真
 *   ③ その日たどったつながりを、一文の感想として
 * 最後に 1 枚の縦長画像にまとめて保存できる。
 *
 * 保存先は二つに分けてある。
 *   通過の記録 → localStorage（小さい。文字だけ）
 *   写真       → IndexedDB（localStorage は 5MB ほどしかなく、写真 1 枚で埋まる）
 *
 * どちらも端末の中にとどまる。ここで撮った写真を送る先は、このファイルには無い。
 *
 * 作品はサーバーを持つようになったが（ADR-0004）、外へ出るのは利用者が
 * 投稿を押したときだけである。IndexedDB から外へ読み出してよいのは投稿の
 * 処理だけで、このファイルからは送らない。この境界を崩さないこと。
 */

(function (global) {
  'use strict';

  const TRIP_KEY = 'choshi-navi/trip';
  const PHOTO_DB = 'choshi-navi';
  const PHOTO_STORE = 'photos';

  /** 共有用画像の大きさ。SNS に上げやすい縦長 */
  const SHARE_WIDTH = 1080;

  // ------------------------------------------------------------------
  // 写真の置き場（IndexedDB）
  // ------------------------------------------------------------------

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(PHOTO_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PHOTO_STORE)) {
          request.result.createObjectStore(PHOTO_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withStore(mode, work) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(PHOTO_STORE, mode);
      const result = work(transaction.objectStore(PHOTO_STORE));
      transaction.oncomplete = () => resolve(result.result ?? result);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * 写真を 1 枚しまう。
   * どの絶景スポットのあたりで撮ったかも一緒に覚えておく（設計書 7.1）。
   */
  async function savePhoto(blob, near) {
    return withStore('readwrite', (store) =>
      store.add({ blob, near: near || null, at: new Date().toISOString() })
    );
  }

  async function allPhotos() {
    try {
      return await withStore('readonly', (store) => store.getAll());
    } catch {
      // 使えないブラウザ・容量が足りない。写真なしで記録は作れる。
      return [];
    }
  }

  /**
   * きょう撮ったぶんだけ。
   *
   * 写真は消さずに取っておく（設計書 7.1 の「あとから旅の記録を見返せるように」）。
   * ところが記録に出すほうも溜まったぶんを全部並べていたので、二度目に乗った日には
   * 先月の写真まで「きょうの旅」に並んでいた。しまう場所と、出すぶんは別の話。
   *
   * 日付は暦の上の同じ日で見る。乗車区間（js/main.js の today）と同じ見方。
   * 日をまたぐ乗車は銚子電鉄には無い（終電は 22 時台）。
   */
  function takenToday(photos) {
    const now = new Date();
    return photos.filter((photo) => {
      if (!photo.at) return false;
      const at = new Date(photo.at);
      return at.getFullYear() === now.getFullYear()
        && at.getMonth() === now.getMonth()
        && at.getDate() === now.getDate();
    });
  }

  // ------------------------------------------------------------------
  // 通過の記録（localStorage）
  // ------------------------------------------------------------------

  function loadTrip() {
    try {
      const saved = localStorage.getItem(TRIP_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  }

  function saveTrip(state) {
    try {
      localStorage.setItem(TRIP_KEY, JSON.stringify(state));
    } catch {
      // 保存できなくても、その日のうちは画面に出せる
    }
  }

  // ------------------------------------------------------------------
  // 結びの言葉（設計書 7③）
  // ------------------------------------------------------------------

  /**
   * その日いちばん多く通ったテーマを選ぶ。
   * 同数なら先に通ったほうを採る。あとから振り返ると、
   * 旅の前半のほうが記憶に残っていることが多い。
   */
  function dominantTheme(passed) {
    const counts = new Map();
    for (const entry of passed) {
      counts.set(entry.theme, (counts.get(entry.theme) || 0) + 1);
    }
    let best = null;
    for (const entry of passed) {
      const count = counts.get(entry.theme);
      if (best === null || count > counts.get(best)) best = entry.theme;
    }
    return best;
  }

  /**
   * テーマの色を、canvas が塗れる形にする。
   *
   * 画面に出すときの色は "var(--theme-farm)" のような CSS の変数で持っている
   * （色そのものは css/style.css が決める、という取り決め）。CSS はこれを
   * 読めるが canvas は読めず、渡しても黙って無視されて前の色のまま塗られる。
   * 共有画像のひし形がぜんぶ灰色になっていたのはこれが理由。
   */
  function paintable(color) {
    const variable = /^var\((--[\w-]+)\)$/.exec(String(color).trim());
    if (variable === null) return color;
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue(variable[1])
      .trim();
    return resolved || '#4A4640';
  }

  // ------------------------------------------------------------------
  // 画面
  // ------------------------------------------------------------------

  /**
   * @param {{from:string, to:string, line:string}} ends
   *   タイムラインの両端に書く駅名と、路線名。路線ごとに違うので受け取る。
   *   銚子・外川と書き込んでいたころは、実演用の有楽町線で旅を終えても
   *   「銚子 ─◆─ 外川」と出ていた。
   */
  function create(spots, themes, closings, ends) {
    const screen = document.getElementById('journal');
    const dateElement = document.getElementById('journal-date');
    const lineElement = document.getElementById('journal-line');
    const shotsElement = document.getElementById('journal-shots');
    const closingElement = document.getElementById('journal-closing');

    let passed = [];
    let photos = [];

    /** 画面に出している写真の一時 URL。次に出すとき返す（放っておくと溜まる） */
    const shownUrls = [];

    /*
     * 閉じたことを外へ知らせる。
     *
     * 途中の駅で降りたときに開いた記録を閉じるのは、「いや、まだ乗っている」
     * という合図でもある。呼び出し側（js/main.js）はそれを受けて、
     * 車上モードへ戻れる状態にする。
     */
    const closeHandlers = [];

    document.getElementById('journal-close')
      .addEventListener('click', () => {
        screen.hidden = true;
        for (const handler of closeHandlers) handler();
      });
    document.getElementById('journal-save')
      .addEventListener('click', () => saveAsImage());

    /** ① 路線のタイムライン。通過したスポットをテーマ色で並べる */
    function renderLine() {
      lineElement.replaceChildren();

      const start = document.createElement('span');
      start.className = 'journal-end';
      start.textContent = ends.from;
      lineElement.appendChild(start);

      for (const entry of passed) {
        const mark = document.createElement('span');
        mark.className = 'journal-mark';
        mark.style.setProperty('--mark-color', themes[entry.theme].color);
        mark.title = entry.name;
        // 検出できなかったぶんは、薄くして区別する（終点でまとめて拾ったもの）
        if (entry.detected === false) mark.classList.add('journal-mark--assumed');
        lineElement.appendChild(mark);
      }

      const end = document.createElement('span');
      end.className = 'journal-end';
      end.textContent = ends.to;
      lineElement.appendChild(end);
    }

    /** ② 撮った写真 */
    function renderShots() {
      // 前に出したぶんの後片付け。閉じて開くたびに増えていくため
      for (const url of shownUrls) URL.revokeObjectURL(url);
      shownUrls.length = 0;

      shotsElement.replaceChildren();
      if (photos.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'journal-empty';
        empty.textContent = '写真はありません。';
        shotsElement.appendChild(empty);
        return;
      }
      for (const photo of photos) {
        const image = document.createElement('img');
        image.className = 'journal-shot';
        image.src = URL.createObjectURL(photo.blob);
        shownUrls.push(image.src);
        image.alt = photo.near ? `${photo.near}のあたりで撮った写真` : '撮った写真';
        shotsElement.appendChild(image);
      }
    }

    /** ③ 結びの言葉 */
    function renderClosing() {
      const theme = dominantTheme(passed);
      closingElement.textContent = (theme && closings[theme]) || '';
      closingElement.hidden = closingElement.textContent === '';
    }

    async function show(state) {
      passed = state.passed || [];
      photos = takenToday(await allPhotos());

      const today = new Date();
      const weekday = '日月火水木金土'[today.getDay()];
      dateElement.textContent =
        `${today.getMonth() + 1}月${today.getDate()}日(${weekday})`;

      renderLine();
      renderShots();
      renderClosing();
      screen.hidden = false;
    }

    /**
     * ② 共有用の画像（設計書 7）。
     * タイムライン・写真・結びを 1 枚の縦長画像にまとめる。
     * 乗客が SNS に上げれば、そのまま銚子電鉄の宣伝になる。
     */
    async function saveAsImage() {
      const padding = 64;
      const shotSize = 300;
      const columns = 3;
      const rows = Math.ceil(photos.length / columns);
      const span = SHARE_WIDTH - padding * 2;

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');

      /*
       * 縦に積むものの高さを、描く前に決める。
       *
       * 高さを決め打ちにしていたころは、通過したスポットが 3 つを超えると
       * 名前の上に写真が重なって消えていた。積むものはどれも数が変わるので、
       * 上から順に足していく。
       */
      context.font = '34px sans-serif';
      const closingLines = wrapText(context, closingElement.textContent, span);

      const lineY = 250;                       // タイムラインの横線
      const namesY = lineY + 120;              // 通過したスポットの名前
      const shotsY = namesY + passed.length * 42 + (photos.length > 0 ? 24 : 0);
      const closingY = shotsY + rows * (shotSize + 16) + 70;
      const height = closingY + closingLines.length * 50 + 90;

      canvas.width = SHARE_WIDTH;
      canvas.height = height;                  // 大きさを変えると context は白紙に戻る

      context.fillStyle = '#F3EBD8'; // 低地の色。地図と地続きに見えるように
      context.fillRect(0, 0, canvas.width, height);

      context.fillStyle = '#2B2A28';
      context.font = 'bold 52px sans-serif';
      context.fillText('きょうの旅', padding, 110);

      context.fillStyle = '#6B6862';
      context.font = '30px sans-serif';
      context.fillText(dateElement.textContent + '　' + ends.line, padding, 160);

      // ---- タイムライン ----
      context.strokeStyle = '#4A4640';
      context.lineWidth = 4;
      context.beginPath();
      context.moveTo(padding, lineY);
      context.lineTo(canvas.width - padding, lineY);
      context.stroke();

      passed.forEach((entry, index) => {
        const x = padding + (span * (index + 1)) / (passed.length + 1);
        context.save();
        context.translate(x, lineY);
        context.rotate(Math.PI / 4);
        context.fillStyle = paintable(themes[entry.theme].color);
        context.fillRect(-13, -13, 26, 26);
        context.restore();
      });

      context.fillStyle = '#6B6862';
      context.font = '26px sans-serif';
      context.fillText(ends.from, padding, lineY + 56);
      const endLabel = ends.to;
      context.fillText(endLabel, canvas.width - padding - context.measureText(endLabel).width, lineY + 56);

      // 通過したスポットの名前
      context.font = '28px sans-serif';
      let nameY = namesY;
      for (const entry of passed) {
        context.fillStyle = paintable(themes[entry.theme].color);
        context.fillRect(padding, nameY - 18, 14, 14);
        context.fillStyle = '#2B2A28';
        context.fillText(entry.name, padding + 28, nameY);
        nameY += 42;
      }

      // ---- 写真 ----
      const shotY = shotsY;
      for (let i = 0; i < photos.length; i += 1) {
        const bitmap = await createImageBitmap(photos[i].blob).catch(() => null);
        if (!bitmap) continue;
        const x = padding + (i % columns) * (shotSize + 16);
        const y = shotY + Math.floor(i / columns) * (shotSize + 16);

        // 正方形に切り抜いて並べる
        const side = Math.min(bitmap.width, bitmap.height);
        context.drawImage(
          bitmap,
          (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
          x, y, shotSize, shotSize
        );
      }

      // ---- 結び ----
      context.fillStyle = '#2B2A28';
      context.font = '34px sans-serif';
      closingLines.forEach((part, index) => {
        context.fillText(part, padding, closingY + index * 50);
      });

      context.fillStyle = '#6B6862';
      context.font = '22px sans-serif';
      context.fillText('車窓絶景ナビ', padding, height - 48);

      canvas.toBlob((blob) => {
        if (!blob) return;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'きょうの旅.png';
        link.click();
        /*
         * 取り消しは次の回へ回す。押した直後にここで取り消すと、
         * 保存が始まる前に中身が消えて、何も落ちてこない端末がある。
         */
        setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      }, 'image/png');
    }

    /** 文を、はみ出さない幅で折り返す */
    function wrapText(context, text, maxWidth) {
      const lines = [];
      let line = '';
      for (const character of text) {
        if (context.measureText(line + character).width > maxWidth) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
      if (line) lines.push(line);
      return lines;
    }

    return {
      /** 車上モードから記録が届くたび */
      update(state) {
        saveTrip(state);
        if (state.mode === '降車後') show(state);
      },
      show,
      savePhoto,
      /** 記録を閉じたときに呼ばれる */
      onClose: (handler) => closeHandlers.push(handler),
      /** 前回の乗車の記録。降車後に開き直せるように */
      last: loadTrip,
    };
  }

  global.Journal = { create, savePhoto, allPhotos };
})(typeof globalThis !== 'undefined' ? globalThis : this);
