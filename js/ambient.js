/*
 * 環境音（テーマ別のホワイトノイズ）
 *
 * 通知帯に出ているスポットのテーマに合わせて、風・波・水音などの
 * 自然音をループでうっすら流す。音楽ではなく背景の空気で、視覚の
 * 通知（js/main.js の showNotice）を邪魔しない音量にとどめる。
 *
 * 既定はオフ（乗車計画パネルでの明示的なオンのみ）。実車内で音を
 * 鳴らすことになるため、周りの乗客への配慮を利用者にゆだねる形にした。
 * 出典は index.html の出典パネルと docs/設計書.md 8.3 を参照。
 *
 * ここは作品の本体ではない。ファイルが取れなくても、音が鳴らないだけで
 * 地図も通知も成因カードもこれまでどおり動く（設計書 9.3「動かないなら黙って隠す」）。
 */

(function (global) {
  'use strict';

  /**
   * テーマごとの音源。キーは spots.json の theme とそのまま合わせてある。
   * ファイルの出典・ライセンスは index.html の出典パネルを参照。
   */
  const THEME_SOUND = {
    '地形': 'audio/wind-terrain.mp3',
    '気候と農業': 'audio/wind-field.mp3',
    '産業と水運': 'audio/water-flow.mp3',
    '海と空': 'audio/ocean-waves.mp3',
  };

  /** 通知の下に敷く音量。視覚の通知より前へ出さない */
  const TARGET_VOLUME = 0.35;

  /** 切り替え・消えるときのフェード時間（ミリ秒） */
  const FADE_MS = 1200;

  let enabled = false;
  let currentTheme = null;

  /** テーマごとに 1 つずつ持つ。実際に鳴らすまでは作らない（要らない通信をしない） */
  const players = new Map();

  /** テーマの再生要素を作る。音源が無いテーマ（trivia 用など）は null */
  function playerFor(theme) {
    const src = THEME_SOUND[theme];
    if (!src) return null;
    let audio = players.get(theme);
    if (audio) return audio;
    audio = new Audio();
    audio.loop = true;
    audio.preload = 'none';
    audio.volume = 0;
    /*
     * .src ではなく setAttribute('src', …) にしてあるのは、
     * tools/build-demo.js が陰影の絵と同じやり方（Element.prototype.setAttribute
     * の差し替え）で、1 枚デモに埋め込んだ音声へ付け替えられるようにするため。
     */
    audio.setAttribute('src', src);
    players.set(theme, audio);
    return audio;
  }

  /** 進行中のフェードを追える場所 */
  const fades = new WeakMap();

  function fadeTo(audio, target) {
    const previous = fades.get(audio);
    if (previous) cancelAnimationFrame(previous);

    const start = audio.volume;
    const startedAt = performance.now();
    if (target > 0 && audio.paused) {
      // 再生の許可は乗車計画パネルの「決定」（ユーザー操作）の中で取ってある（unlock）
      audio.play().catch(() => {});
    }

    function step(now) {
      /*
       * 下限もクランプすること。requestAnimationFrame に渡る timestamp は
       * 「そのフレームの開始時刻」であって、直前に同期で取った performance.now()
       * より前になることがある（最初のフレームでまれに起きる）。t が負のまま
       * だと、フェードアウト（target=0）で音量がわずかに負になり、
       * HTMLMediaElement.volume の setter が例外を投げてフェードごと止まる。
       */
      const t = Math.max(0, Math.min(1, (now - startedAt) / FADE_MS));
      audio.volume = Math.max(0, Math.min(1, start + (target - start) * t));
      if (t < 1) {
        fades.set(audio, requestAnimationFrame(step));
        return;
      }
      fades.delete(audio);
      if (target === 0) audio.pause();
    }
    fades.set(audio, requestAnimationFrame(step));
  }

  function stopAll(exceptTheme) {
    for (const [theme, audio] of players) {
      if (theme === exceptTheme) continue;
      if (!audio.paused || audio.volume > 0) fadeTo(audio, 0);
    }
  }

  /**
   * 通知の中身に合わせて、鳴らす音を決める。
   * @param {{spot: {theme: string}}|null} notice js/main.js の showNotice と同じ引数
   */
  function update(notice) {
    if (!enabled) return;
    const theme = notice ? notice.spot.theme : null;
    if (theme === currentTheme) return;
    currentTheme = theme;

    if (!theme) {
      stopAll(null);
      return;
    }
    const audio = playerFor(theme);
    if (!audio) {
      stopAll(null);
      return;
    }
    stopAll(theme);
    fadeTo(audio, TARGET_VOLUME);
  }

  /** オン・オフを切り替える。オフにした瞬間、鳴っていた音はフェードで消える */
  function setEnabled(value) {
    enabled = value;
    if (!enabled) {
      currentTheme = null;
      stopAll(null);
    }
  }

  /**
   * ブラウザの自動再生の制限をあらかじめ外す。
   *
   * iOS Safari などは、ユーザー操作の中で同期的に呼ばれた play() でないと
   * 音を許さない。GPS で近づいたときに初めて play() を呼んでも、その時点は
   * 操作の外なので鳴らないことがある。乗車計画パネルの「決定」ボタンの
   * クリック処理（ユーザー操作そのもの）から、この関数を呼んでおくこと。
   */
  function unlock() {
    for (const theme of Object.keys(THEME_SOUND)) {
      const audio = playerFor(theme);
      if (!audio) continue;
      const played = audio.play();
      if (played && played.catch) played.catch(() => {});
      audio.pause();
    }
  }

  global.Ambient = { THEME_SOUND, update, setEnabled, unlock };
})(window);
