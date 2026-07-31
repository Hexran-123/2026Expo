/*
 * fetch-features.js
 *
 * 絶景スポットの位置と車窓側を決めるために、
 * その「見えるもの」の実物（工場・農地・海岸・灯台）を OSM から取り出す。
 *
 * 位置を勘で置かないための下ごしらえ。
 *
 * 使い方:  node tools/fetch-features.js
 *
 * 出典: © OpenStreetMap contributors（ODbL ライセンス）
 */

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, '..', 'data', 'source', 'features_raw.json');

const QUERY = `
[out:json][timeout:120];
(
  // ヤマサ醤油の工場（S01）
  nwr(35.71,140.81,35.75,140.88)["name"~"ヤマサ"];
  nwr(35.71,140.81,35.75,140.88)["landuse"="industrial"];

  // 畑（S04 キャベツ畑・S05 ひまわり畑）
  way(35.69,140.83,35.75,140.88)["landuse"="farmland"];
  way(35.69,140.83,35.75,140.88)["landuse"="orchard"];

  // 海岸線（S02 海が見える区間）
  way(35.68,140.80,35.76,140.89)["natural"="coastline"];
  way(35.68,140.80,35.76,140.89)["natural"="beach"];

  // 目印になるもの
  nwr(35.68,140.80,35.76,140.89)["man_made"="lighthouse"];
);
out geom;
`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function main() {
  for (const endpoint of ENDPOINTS) {
    try {
      process.stdout.write(`問い合わせ中: ${endpoint} … `);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'ChoshiWindowNavi/0.1 (student contest project)',
        },
        body: new URLSearchParams({ data: QUERY }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      const parsed = JSON.parse(text);

      fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
      fs.writeFileSync(OUT_PATH, text, 'utf8');

      console.log(`成功（${parsed.elements.length} 件）`);

      // 何が取れたかの内訳
      const kinds = {};
      for (const el of parsed.elements) {
        const t = el.tags || {};
        const kind =
          t.landuse ? `landuse=${t.landuse}` :
          t.natural ? `natural=${t.natural}` :
          t.man_made ? `man_made=${t.man_made}` :
          'その他';
        kinds[kind] = (kinds[kind] || 0) + 1;
      }
      Object.entries(kinds).forEach(([k, n]) => console.log(`  ${k}: ${n}`));

      console.log(`保存先: ${OUT_PATH}`);
      return;
    } catch (error) {
      console.log(`失敗（${error.message}）`);
    }
  }
  process.exit(1);
}

main();
