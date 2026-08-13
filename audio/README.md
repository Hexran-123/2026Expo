# audio/

環境音（`js/ambient.js`、設計書 8.3「環境音」）で使う音源。すべて Freesound の CC0
（パブリックドメイン相当）。帰属表示は法的義務ではないが、出どころを追える
ようにここと `index.html` の出典パネル・`docs/設計書.md` 8.3 に書いてある。

## 使用中（テーマに割り当て済み）

| ファイル | テーマ | 出典 |
|---|---|---|
| `water-flow.mp3` | 産業と水運 | “River Flow Loop” by EminYILDIRIM https://freesound.org/people/EminYILDIRIM/sounds/608141/ |
| `ocean-waves.mp3` | 海と空 | “oceanwaves-10” by Rmutt https://freesound.org/people/Rmutt/sounds/156598/ |
| `wind-field.mp3` | 気候と農業 | “forest_ambience_steady_breeze…loop” by johanwestling https://freesound.org/people/johanwestling/sounds/460178/ |
| `wind-terrain.mp3` | 地形 | “wind_forest_08_strong_l_02” by teadrinker https://freesound.org/people/teadrinker/sounds/403050/（差し替え候補あり。下参照） |

## 候補（まだどのテーマにも割り当てていない）

`wind-terrain.mp3`（地形）は「ただの騒音に聞こえる」との指摘を受け、
差し替え候補として以下を用意した。まだ `js/ambient.js` の `THEME_SOUND` からは
参照していない。どれか選んだら `wind-terrain.mp3` を差し替え、この節から
「使用中」の表へ移すこと。

| ファイル | 出典 |
|---|---|
| `wind-chime.mp3` | “Wind chimes on a very windy day” by Hockinfinger https://freesound.org/people/Hockinfinger/sounds/387236/ |
| `wind-in-trees.mp3` | “Wind in the Trees” by willstepp https://freesound.org/people/willstepp/sounds/188288/ |
| `wind-through-trees-loop.mp3` | “Wind through trees (loop)” by NomadApe https://freesound.org/people/NomadApe/sounds/444921/ |
