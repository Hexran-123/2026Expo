/*
 * fetch-osm.js
 *
 * OpenStreetMap から銚子周辺の線路と駅を取り出して保存する。
 * Overpass API という、OSM に問い合わせるための公開サービスを使う。
 *
 * 使い方:  node tools/fetch-osm.js
 *
 * 出典: © OpenStreetMap contributors（ODbL ライセンス）
 *       応募作品に地図を載せる際は出典表記が必要。
 */

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, '..', 'data', 'source', 'overpass_raw.json');

/*
 * 問い合わせ文。銚子市を囲む四角（南緯,西経,北緯,東経）の中から
 *   - railway=rail    … 線路
 *   - railway=station … 駅
 * を取り出す。out geom; と書くと、線路の形（点の並び）も一緒に返ってくる。
 */
const QUERY = `
[out:json][timeout:90];
(
  way(35.68,140.78,35.80,140.92)["railway"="rail"];
  node(35.68,140.78,35.80,140.92)["railway"="station"];
  node(35.68,140.78,35.80,140.92)["railway"="halt"];
);
out geom;
`;

/** 本家が混んでいることがあるので、順に試す */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function main() {
  let lastError = null;

  for (const endpoint of ENDPOINTS) {
    try {
      process.stdout.write(`問い合わせ中: ${endpoint} … `);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass は名乗らない相手を断ることがある
          'User-Agent': 'ChoshiWindowNavi/0.1 (student contest project)',
        },
        body: new URLSearchParams({ data: QUERY }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      const parsed = JSON.parse(text); // 壊れていないか確認してから保存する

      fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
      fs.writeFileSync(OUT_PATH, text, 'utf8');

      console.log(`成功（${parsed.elements.length} 件）`);
      console.log(`保存先: ${OUT_PATH}`);
      return;
    } catch (error) {
      console.log(`失敗（${error.message}）`);
      lastError = error;
    }
  }

  console.error('すべての接続先で失敗した。');
  console.error(lastError);
  process.exit(1);
}

main();
