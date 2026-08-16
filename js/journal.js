/*
 * 旅の記録（設計書 7）
 *
 * 降車後に、その日の乗車をまとめて見せる。
 *   ① 通過した絶景スポットの並び
 *   ② 乗客が撮った写真
 *   ③ その日たどったつながりを、一文の感想として
 * 最後に 1 枚の縦長画像にまとめて保存できる。
 *
 * ①②③ のどれにも、乗客自身の言葉を足せる（設計書 7.2）。絶景を見て
 * 写真ではなく文字で残したい人がいる、という指摘から加えた。書いたものは
 * この画面で何度でも直せる。
 *
 * 保存先は二つに分けてある。
 *   通過の記録・書いた文字 → localStorage（小さい。文字だけ）
 *   写真                   → IndexedDB（localStorage は 5MB ほどしかなく、写真 1 枚で埋まる）
 * 写真に添えた一言だけは、その写真と離れないよう IndexedDB 側に置く。
 *
 * **写真は端末の中にとどまる。** 作品はサーバーを持つようになったが
 * （ADR-0004）、外へ出るのは利用者が投稿を押したときだけで、そのときも
 * 送るのは**書いた文字だけ**である（submit を参照）。IndexedDB の blob を
 * 読み出して送る処理は、このファイルのどこにも無い。この境界を崩さないこと。
 */

(function (global) {
  'use strict';

  const TRIP_KEY = 'choshi-navi/trip';
  const PHOTO_DB = 'choshi-navi';
  const PHOTO_STORE = 'photos';

  /** 共有用画像の大きさ。SNS に上げやすい縦長 */
  const SHARE_WIDTH = 1080;

  /*
   * 書ける字数（設計書 7.2）。
   *
   * 写真の一言が短いのは、共有画像で写真 1 枚の下（300px）に 1 行で
   * 収めるため。絶景ごとのひとことは、旅の記録に並べても読み通せる長さ。
   * 結びの一文だけは上限を持たない ── そこは「その日の感想」を書く場所で、
   * 字数で切ると書きたいことのほうが削られる。長くなったぶんは
   * 入力欄と旅の記録の両方でスクロールする。
   */
  const PHOTO_NOTE_LIMIT = 15;
  const SPOT_NOTE_LIMIT = 60;

  /*
   * 投稿（ADR-0004）。
   *
   * 上限が二つあるのは、結びの一文に上限を持たせていないため。
   * 画面では好きなだけ書けるが、送るときだけは切りどころが要る。
   * 送れなかったぶんは端末に残り、画像にも載る。
   */
  const POST_BODY_LIMIT = 2000;
  const POST_COUNT_LIMIT = 20;
  /** 投稿は利用者が押して待つ操作なので、累積人気の 3 秒より長く待つ */
  const POST_TIMEOUT_MS = 8000;

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
   * どの絶景スポットのあたりで撮ったかと、どの路線で撮ったかも一緒に覚えておく
   * （設計書 7.1）。路線を覚えるのは、同じ日に路線を乗り換えたとき
   * （銚子電鉄→有楽町線、展示ではありうる）に、旅の記録へ他方の路線の
   * 写真まで混ざって出ないようにするため。
   */
  async function savePhoto(blob, near, line) {
    return withStore('readwrite', (store) =>
      store.add({ blob, near: near || null, line: line || null, at: new Date().toISOString() })
    );
  }

  /**
   * 写真に添えた一言を書き換える（設計書 7.2）。
   *
   * 写真そのものと同じ行に置く。別の置き場にすると、写真を消したときに
   * 言葉だけが残る。読んでから書き戻すのは、blob を持ち回らずに済ませるため。
   *
   * @param {number} id savePhoto が返した番号
   * @param {string} note 空文字なら、添えた言葉を取り消す
   */
  async function setPhotoNote(id, note) {
    try {
      return await withStore('readwrite', (store) => {
        const request = store.get(id);
        request.onsuccess = () => {
          const record = request.result;
          if (!record) return;
          if (note) record.note = note.slice(0, PHOTO_NOTE_LIMIT);
          else delete record.note;
          store.put(record);
        };
        return request;
      });
    } catch {
      // 書けなくても、写真は残っている。画面の側はもう書き換わっている。
      return null;
    }
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
   *
   * 路線でも絞る。同じ日のうちに銚子電鉄→有楽町線と乗り継ぐと
   * （多路線対応の実演で普通に起こりうる）、路線を見ずに日付だけで
   * 絞っていたころは、さっき別の路線で撮った写真が「きょうの旅」に
   * 混ざって出ていた。路線を記録する前に撮った古い写真（line が無い）は
   * 区別のしようが無いので、これまでどおり出す。
   */
  function takenToday(photos, lineId) {
    const now = new Date();
    return photos.filter((photo) => {
      if (!photo.at) return false;
      const at = new Date(photo.at);
      const sameDay = at.getFullYear() === now.getFullYear()
        && at.getMonth() === now.getMonth()
        && at.getDate() === now.getDate();
      if (!sameDay) return false;
      return !photo.line || photo.line === lineId;
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
   * @param {{from:string, to:string, line:string, lineId:string}} ends
   *   タイムラインの両端に書く駅名と、路線名（表示用）・路線id（区別用、
   *   data/lines.json の id）。路線ごとに違うので受け取る。
   *   銚子・外川と書き込んでいたころは、実演用の有楽町線で旅を終えても
   *   「銚子 ─◆─ 外川」と出ていた。lineId は、撮った写真をその日のうちの
   *   路線ごとに分けるのに使う（takenToday 参照）。
   * @param {(ask: {title:string, hint:string, value:string, limit:number|null})
   *          => Promise<string|null>} askText
   *   文を書いてもらう下敷きを出す（中身は js/main.js の createTextSheet）。
   *   やめたときは null を返す。空文字は「消した」で、null とは別。
   *   画面の部品をここで作らないのは、同じ下敷きを成因カードの記章からも
   *   撮影の直後からも出すため（三か所で同じ形にそろえる、設計書 7.2）。
   */
  function create(spots, themes, closings, ends, askText) {
    const screen = document.getElementById('journal');
    const dateElement = document.getElementById('journal-date');
    const lineElement = document.getElementById('journal-line');
    const notesElement = document.getElementById('journal-notes');
    const shotsElement = document.getElementById('journal-shots');
    const closingElement = document.getElementById('journal-closing');
    const postButton = document.getElementById('journal-post');

    let passed = [];
    let photos = [];

    /*
     * 結びの一文を、乗客が書き換えたもの（設計書 7.2）。
     *
     * null は「まだ書き換えていない」で、テーマから選ばれた一文がそのまま出る。
     * 空文字は「書き換えて、空にした」なので、null とは別に扱う。
     */
    let closingText = null;

    /** いま画面に出している乗車。書いたものを保存するときに使う */
    let current = null;

    /** 絶景スポットの名前 → id。写真に添えた言葉を、投稿でスポットに結びつける */
    const spotIdByName = new Map((spots || []).map((spot) => [spot.name, spot.id]));

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

    /*
     * 書いたものを端末に残す。
     *
     * 通過の記録は車上モード（js/main.js の passedLog）が持っていて、
     * ここへは update() で届く。書いたひとことはその記録の中に混ぜて
     * 一緒に保存する ── 別の置き場にすると、乗車と言葉が離れて、
     * 「どの日のどの絶景に書いたのか」を突き合わせる仕掛けが要る。
     *
     * 結びだけは通過の記録に属さないので、乗車と並べて持つ。
     */
    function persist() {
      if (current === null) return;
      saveTrip({ ...current, line: ends.lineId, closing: closingText });
    }

    /**
     * 書いてもらって、書けたら保存して描き直す。やめたときは何もしない。
     *
     * 描き直しを呼ぶ側から渡すのは、写真の側を無駄に組み立て直さないため
     * （renderShots は一時 URL を作り直すので、そのたびに絵が一瞬消える）。
     */
    async function edit(ask, apply, redraw) {
      if (typeof askText !== 'function') return;
      const written = await askText(ask);
      if (written === null) return;
      await apply(written);
      persist();
      redraw();
      updatePostButton();
    }

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

    /*
     * 通過した絶景ごとの、乗客のひとこと（設計書 7.2）。
     *
     * 写真を撮らなかった人にも、旅の記録に残るものができる。
     * 何も書いていない絶景も、書ける場所として並べておく ── 空の行を
     * 隠すと、書けること自体が伝わらない。
     */
    function renderNotes() {
      notesElement.replaceChildren();
      for (const entry of passed) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'journal-note';

        const mark = document.createElement('span');
        mark.className = 'journal-note-mark';
        mark.style.setProperty('--mark-color', themes[entry.theme].color);
        row.appendChild(mark);

        const body = document.createElement('span');
        body.className = 'journal-note-body';

        const name = document.createElement('span');
        name.className = 'journal-note-name';
        name.textContent = entry.name;
        body.appendChild(name);

        const text = document.createElement('span');
        text.className = 'journal-note-text';
        if (entry.note) {
          text.textContent = entry.note;
        } else {
          text.textContent = 'ひとことを書く';
          text.classList.add('journal-note-text--empty');
        }
        body.appendChild(text);

        row.appendChild(body);
        row.addEventListener('click', () => edit(
          {
            title: entry.name,
            hint: 'この絶景に、ひとこと',
            value: entry.note || '',
            limit: SPOT_NOTE_LIMIT,
          },
          (written) => {
            if (written) entry.note = written;
            else delete entry.note;
          },
          renderNotes
        ));

        notesElement.appendChild(row);
      }
    }

    /** ② 撮った写真。1 枚ずつに一言を添えられる */
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
        const figure = document.createElement('figure');
        figure.className = 'journal-figure';

        const image = document.createElement('img');
        image.className = 'journal-shot';
        image.src = URL.createObjectURL(photo.blob);
        shownUrls.push(image.src);
        image.alt = photo.near ? `${photo.near}のあたりで撮った写真` : '撮った写真';
        figure.appendChild(image);

        const caption = document.createElement('figcaption');
        caption.className = 'journal-caption';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'journal-caption-edit';
        if (photo.note) {
          button.textContent = photo.note;
        } else {
          button.textContent = '一言そえる';
          button.classList.add('journal-caption-edit--empty');
        }
        button.addEventListener('click', () => edit(
          {
            title: '写真に一言',
            hint: photo.near ? `${photo.near}のあたり` : '',
            value: photo.note || '',
            limit: PHOTO_NOTE_LIMIT,
          },
          async (written) => {
            if (written) photo.note = written;
            else delete photo.note;
            // 画面はもう書き換わっている。しまえなくても止めない
            await setPhotoNote(photo.id, written);
          },
          renderShots
        ));

        caption.appendChild(button);
        figure.appendChild(caption);
        shotsElement.appendChild(figure);
      }
    }

    /** テーマから選ばれる、もとの一文。書き換えられていなければこれが出る */
    function autoClosing() {
      const theme = dominantTheme(passed);
      return (theme && closings[theme]) || '';
    }

    /** いま結びとして出ている文。共有画像にも投稿にもこれを使う */
    function closingNow() {
      return closingText !== null ? closingText : autoClosing();
    }

    /*
     * ③ 結びの言葉。
     *
     * 最初はテーマから選ばれた一文が入っている。押すと、その文が入った
     * まま書き換えられる（設計書 7.2）── 白紙から書かせない。旅のあとで
     * 「何を書けばいいか」を考えるのは、それだけで手が止まる。
     */
    function renderClosing() {
      const shown = closingNow();
      closingElement.textContent = shown || 'この旅のことを書く';
      closingElement.classList.toggle('journal-closing--empty', shown === '');
    }

    closingElement.addEventListener('click', () => edit(
      {
        title: 'きょうの旅',
        hint: 'この旅のことを、自由に',
        value: closingNow(),
        // 上限を持たない。長くなったぶんは入力欄がスクロールする
        limit: null,
      },
      (written) => { closingText = written; },
      renderClosing
    ));

    async function show(state) {
      current = state;
      passed = state.passed || [];
      photos = takenToday(await allPhotos(), ends.lineId);

      /*
       * 保存してあった結びを戻す。
       *
       * 車上モードから届く state には closing が無い（あちらは通過だけを
       * 持つ）ので、そのときは書き換えを消さずにそのまま残す。
       */
      if (typeof state.closing === 'string') closingText = state.closing;

      const today = new Date();
      const weekday = '日月火水木金土'[today.getDay()];
      dateElement.textContent =
        `${today.getMonth() + 1}月${today.getDate()}日(${weekday})`;

      renderLine();
      renderNotes();
      renderShots();
      renderClosing();
      updatePostButton();
      screen.hidden = false;
    }

    // ----------------------------------------------------------------
    // 投稿（ADR-0004）
    //
    // ここがこのファイルで唯一、端末の外へ出す処理である。
    // 送るのは利用者が書いた文字だけで、写真（IndexedDB の blob）は読まない。
    // ----------------------------------------------------------------

    /** サーバーの宛先。js/popularity.js が読めていないときは投稿の口を出さない */
    function server() {
      if (typeof Popularity === 'undefined' || !Popularity.ENDPOINT) return null;
      return { endpoint: Popularity.ENDPOINT, key: Popularity.ANON_KEY };
    }

    /**
     * 送る中身を集める。
     *
     * 写真に添えた一言も送るが、写真そのものは送らない。どの絶景のあたりで
     * 撮ったかは名前で覚えてあるので、id に直して結びつける（名前は
     * spots.json 側で変わりうるので、送るのは id のほう）。
     */
    function writtenNotes() {
      const notes = [];

      for (const entry of passed) {
        if (entry.note) notes.push({ kind: 'spot', spot_id: entry.id, body: entry.note });
      }
      for (const photo of photos) {
        if (!photo.note) continue;
        notes.push({
          kind: 'photo',
          spot_id: spotIdByName.get(photo.near) || null,
          body: photo.note,
        });
      }
      const closing = closingNow();
      // もとのまま（テーマから選ばれた一文）は、その人が書いたものではない
      if (closingText !== null && closing) {
        notes.push({ kind: 'trip', spot_id: null, body: closing });
      }

      return notes
        .map((note) => ({ ...note, body: note.body.slice(0, POST_BODY_LIMIT) }))
        .slice(0, POST_COUNT_LIMIT);
    }

    /*
     * 投稿の口は、送るものがあるときだけ出す。
     *
     * 中身が作り物の路線では出さない。累積人気を数えないのと同じ理由で、
     * 作り物の絶景に寄せられた言葉を本物と混ぜないため（CLAUDE.md）。
     */
    function updatePostButton() {
      const ready = server() !== null
        && ends.dataSource === 'real'
        && current !== null
        && current.posted !== true
        && writtenNotes().length > 0;
      postButton.hidden = !ready;
    }

    const postScreen = document.getElementById('post');
    const postLead = document.getElementById('post-lead');
    const postState = document.getElementById('post-state');
    const postSend = document.getElementById('post-send');

    function closePost() {
      postScreen.hidden = true;
    }

    postButton.addEventListener('click', () => {
      const count = writtenNotes().length;
      postLead.textContent = `この旅で書いた ${count} 件の文を送ります。`;
      postState.textContent = '';
      postSend.disabled = false;
      postSend.textContent = '送る';
      postScreen.hidden = false;
    });

    document.getElementById('post-cancel').addEventListener('click', closePost);
    document.getElementById('post-veil').addEventListener('click', closePost);

    postSend.addEventListener('click', async () => {
      const notes = writtenNotes();
      const where = server();
      if (where === null || notes.length === 0) return;

      postSend.disabled = true;
      postSend.textContent = '送っています…';
      postState.textContent = '';

      const saved = await send(where, notes);

      if (saved === null) {
        postSend.disabled = false;
        postSend.textContent = 'もう一度送る';
        // 何が起きたかは分からない。直せる形でだけ伝える
        postState.textContent = '送れませんでした。電波の良いところで、もう一度ためしてください。';
        return;
      }

      /*
       * 送れた。二度押しても増えないようにする（サーバー側でも同じ文は
       * 弾いているが、押せるままにしておくと送れたかどうかが伝わらない）。
       */
      if (current !== null) current.posted = true;
      persist();
      updatePostButton();
      postState.textContent = 'ありがとうございます。送りました。';
      postSend.hidden = true;
      setTimeout(() => {
        closePost();
        postSend.hidden = false;
      }, 1800);
    });

    /**
     * 実際に送る。
     * @returns {Promise<number|null>} 受け取られた件数。届かなければ null
     */
    async function send(where, notes) {
      const giveUp = new AbortController();
      const timer = setTimeout(() => giveUp.abort(), POST_TIMEOUT_MS);
      try {
        const response = await fetch(`${where.endpoint}/rpc/submit_notes`, {
          method: 'POST',
          signal: giveUp.signal,
          headers: {
            'apikey': where.key,
            'Authorization': `Bearer ${where.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p_line_id: ends.lineId, p_notes: notes }),
        });
        if (!response.ok) return null;
        const saved = await response.json();
        return typeof saved === 'number' ? saved : null;
      } catch {
        // 時間切れ・電波なし・宛先が止まっている。書いたものは端末に残る
        return null;
      } finally {
        clearTimeout(timer);
      }
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
      const closingLines = wrapText(context, closingNow(), span);

      /*
       * 通過した絶景の名前と、その下に書いたひとこと（設計書 7.2）。
       * ひとことは折り返すので、行数を先に数えてから高さを決める。
       */
      context.font = '26px sans-serif';
      const nameBlocks = passed.map((entry) => ({
        entry,
        lines: entry.note ? wrapText(context, entry.note, span - 28) : [],
      }));
      // ひとことを書いた絶景のあとは、少し空ける。詰めると次の名前とくっつく
      const namesHeight = nameBlocks.reduce(
        (total, block) => total + 42 + block.lines.length * 34 + (block.lines.length > 0 ? 10 : 0),
        0
      );

      // 写真に添えた一言のぶん。1 枚も無ければ、写真の並びは今までどおり
      const captionHeight = photos.some((photo) => photo.note) ? 32 : 0;

      const lineY = 250;                       // タイムラインの横線
      const namesY = lineY + 120;              // 通過したスポットの名前
      const shotsY = namesY + namesHeight + (photos.length > 0 ? 24 : 0);
      const closingY = shotsY + rows * (shotSize + 16 + captionHeight) + 70;
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

      // 通過したスポットの名前と、書いたひとこと
      let nameY = namesY;
      for (const block of nameBlocks) {
        context.font = '28px sans-serif';
        context.fillStyle = paintable(themes[block.entry.theme].color);
        context.fillRect(padding, nameY - 18, 14, 14);
        context.fillStyle = '#2B2A28';
        context.fillText(block.entry.name, padding + 28, nameY);
        nameY += 42;

        // 乗客の言葉。名前より少し小さく、薄く置いて、地の文と見分ける
        context.font = '26px sans-serif';
        context.fillStyle = '#6B6862';
        for (const part of block.lines) {
          context.fillText(part, padding + 28, nameY);
          nameY += 34;
        }
        if (block.lines.length > 0) nameY += 10;
      }

      // ---- 写真 ----
      for (let i = 0; i < photos.length; i += 1) {
        const x = padding + (i % columns) * (shotSize + 16);
        const y = shotsY + Math.floor(i / columns) * (shotSize + 16 + captionHeight);

        const bitmap = await createImageBitmap(photos[i].blob).catch(() => null);
        if (bitmap) {
          // 正方形に切り抜いて並べる
          const side = Math.min(bitmap.width, bitmap.height);
          context.drawImage(
            bitmap,
            (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
            x, y, shotSize, shotSize
          );
        }

        // 添えた一言は写真の下に。読めなかった写真でも、言葉だけは残す
        if (photos[i].note) {
          context.font = '20px sans-serif';
          context.fillStyle = '#6B6862';
          context.fillText(photos[i].note, x, y + shotSize + 24);
        }
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
        // 路線を添えて保存する。plan（js/main.js の savePlan）と同じ考え方
        current = state;
        persist();
        if (state.mode === '降車後') show(state);
      },
      show,
      savePhoto: (blob, near) => savePhoto(blob, near, ends.lineId),
      /** 撮った直後に添える一言（設計書 7.2）。id は savePhoto が返した番号 */
      setPhotoNote,
      /** 記録を閉じたときに呼ばれる */
      onClose: (handler) => closeHandlers.push(handler),
      /** 前回の乗車の記録。降車後に開き直せるように */
      last: loadTrip,
    };
  }

  global.Journal = {
    create,
    savePhoto,
    setPhotoNote,
    allPhotos,
    PHOTO_NOTE_LIMIT,
    SPOT_NOTE_LIMIT,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
