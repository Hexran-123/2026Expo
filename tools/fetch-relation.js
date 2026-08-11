/*
 * fetch-relation.js
 *
 * OpenStreetMap の「route relation」を、メンバーの形ごと取り出して保存する。
 *
 * 銚子電鉄は tools/fetch-osm.js で「四角い範囲の中の線路をぜんぶ拾って、
 * あとから名前で選り分ける」やり方をしている。ローカル線ならそれで足りる。
 *
 * 地下鉄ではこの手が使えない。駅名が他社と重なるためで、たとえば「池袋」で
 * 引くと OSM には駅ノードが 6 件ある（JR・西武・東武・東京メトロ…）。
 * 「名前が一致する駅はちょうど 1 件」という前提が崩れる。
 *
 * そこで路線そのもの（route relation）を指定して、そこに属する線路と駅だけを
 * 取り出す。どの駅がこの路線の駅なのかは、OSM 側が既に決めてくれている。
 *
 * 使い方:  node tools/fetch-relation.js <relation id> <出力先.json>
 * 例:      node tools/fetch-relation.js 443269 data/source/yurakucho_raw.json
 *
 * relation id の調べ方: https://www.openstreetmap.org/ で路線を検索するか、
 * Overpass で relation["type"="route"]["name"~"<路線名>"]; out tags; を引く。
 *
 * 出典: © OpenStreetMap contributors（ODbL ライセンス）
 */

const fs = require('fs');
const path = require('path');

const relationId = process.argv[2];
const outPath = process.argv[3];

if (!relationId || !/^\d+$/.test(relationId) || !outPath) {
  console.error('使い方: node tools/fetch-relation.js <relation id> <出力先.json>');
  console.error('例:      node tools/fetch-relation.js 443269 data/source/yurakucho_raw.json');
  process.exit(1);
}

/*
 * 二つに分けて問い合わせる。
 *
 * 一度にまとめて投げると 504（窓口の時間切れ）になりやすい。線路の形は
 * 点の数が多く、Overpass 側の処理が重いため。分ければ一回あたりが軽くなる。
 *
 *   ① out geom;  … relation 本体。メンバーの way に座標の並びが付いてくる。
 *                  メンバーの「順番」もここで分かる。ただしタグは付いてこない。
 *   ② node(r);   … relation のメンバーのノードだけを、タグ付きで。
 *                  駅の名前はここから取る。
 */
const QUERY_GEOMETRY = `
[out:json][timeout:120];
rel(${relationId});
out geom;
`;

const QUERY_NODES = `
[out:json][timeout:120];
rel(${relationId});
node(r);
out;
`;

/*
 * 本家はしばしば混む。日本のデータなので大阪のミラーが速いことが多い。
 * 上から順に試し、全部だめなら間を空けて数回やり直す。
 */
const ENDPOINTS = [
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** 全部の窓口がだめだったときに、間を空けてやり直す回数 */
const MAX_ROUNDS = 3;

const USER_AGENT = 'ChoshiWindowNavi/0.1 (student contest project)';

function post(endpoint, query) {
  const https = require('https');
  const body = 'data=' + encodeURIComponent(query);

  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': USER_AGENT,
      },
      timeout: 190000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // 混雑時は HTML のエラーページが返る。中身をそのまま出しても読めないので短く。
          return reject(new Error(`HTTP ${res.statusCode}（混雑か問い合わせ過多。しばらく待つ）`));
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('JSON として読めない返事だった（混雑時によくある）'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('時間切れ')); });
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 窓口を順に試し、全部だめなら間を空けてやり直す */
async function fetchWithRetry(label, query) {
  let lastError = null;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const endpoint of ENDPOINTS) {
      try {
        process.stdout.write(`  ${label}: ${new URL(endpoint).host} … `);
        const result = await post(endpoint, query);
        console.log('取れた');
        return result;
      } catch (error) {
        console.log(error.message);
        lastError = error;
      }
    }
    if (round < MAX_ROUNDS) {
      const wait = round * 20;
      console.log(`  どこもだめだった。${wait} 秒待ってやり直す（${round}/${MAX_ROUNDS - 1}）`);
      await sleep(wait * 1000);
    }
  }

  throw new Error(`${label} を取れなかった: ${lastError && lastError.message}`);
}

async function main() {
  console.log(`relation ${relationId} を取りに行く\n`);

  const geometry = await fetchWithRetry('線路の形', QUERY_GEOMETRY);
  const nodeResult = await fetchWithRetry('駅ノード', QUERY_NODES);

  // 二回の返事を一つにまとめる。以降の道具は elements の配列だけを見る。
  const result = {
    ...geometry,
    elements: [
      ...geometry.elements,
      ...nodeResult.elements.filter((el) => el.type === 'node'),
    ],
  };

  const relation = result.elements.find((el) => el.type === 'relation');
  if (!relation) {
    console.error('relation が返ってこなかった。id を確認すること。');
    process.exit(1);
  }

  const nodes = result.elements.filter((el) => el.type === 'node');
  const wayMembers = (relation.members || []).filter((m) => m.type === 'way');

  console.log(`\n路線: ${relation.tags && relation.tags.name}`);
  console.log(`  メンバー: way ${wayMembers.length} 本 / node ${(relation.members || []).filter((m) => m.type === 'node').length} 個`);
  console.log(`  タグ付きで取れたノード: ${nodes.length} 個`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result), 'utf8');
  console.log(`\n書き出し: ${outPath}（${(fs.statSync(outPath).size / 1024).toFixed(0)} KB）`);
}

main();
