# 專案地圖

狀態：已依現有設計書・ADR・README 填寫（2026-08-01 project-kickoff 時點）。

## 產品

- 名稱：車窓絶景ナビ（銚子電鉄）
- 使用者：銚子電鉄（銚子駅〜外川駅）に乗車する観光客・地元利用者。審査員・展示来場者も閲覧対象（PC/大画面）。
- 核心工作流程：乗車前（地図で絶景スポットを予習）→ 車上（GPS で接近を通知、進行方向の窓側を案内）→ 降車後（成因カードと旅の記録を読む）。詳細は [docs/設計書.md](../../docs/設計書.md) 3章。

## 技術棧

- 前端：素の HTML / CSS / JavaScript（フレームワークなし、ビルド工程なし。[ADR-0002](../../docs/adr/0002-フレームワークとサーバーを持たない.md)）
- 後端：なし（サーバーを持たない。データは静的 JSON、天候のみ気象庁 JSON API を直接叩く）
- データベース：なし。永続化は `localStorage`（テーマ絞り込みの状態のみ、個人情報は持たない）
- 身分驗證：なし
- 測試：現状なし（自動テストの仕組み未整備。プロトタイプ段階のため目視確認中心）
- 部署：GitHub Pages または Netlify を想定（設計書 9.1）。**現時点で未設定**（`.github/workflows` も `netlify.toml` もリポジトリに存在しない）── Epic 0 の既知ギャップ。

## 重要目錄

| 路徑 | 用途 | 備註 |
|---|---|---|
| `index.html` / `css/style.css` / `js/main.js` | 画面の骨組み・見た目・動き | ビルド不要、直接配信 |
| `data/spots.json` | 絶景スポットの情報 | **人が手で書く唯一のファイル**。他の `data/` は自動生成 |
| `data/route.json` / `data/terrain.json` / `data/terrain-hillshade.png` | 路線形状・地形濃淡・陰影 | `tools/` で自動生成、直接編集しない |
| `tools/*.js` | データ生成スクリプト（Node.js、依存なし） | 実行手順は README 参照 |
| `docs/設計書.md` | 唯一の真実の源（機能・画面・データ・技術構成） | 変更提案前に必読 |
| `docs/将来構想.md` | 今回作らないものの一覧 | ここに書かれた機能を実装対象と誤認しないこと |
| `docs/adr/` | 設計判断の記録 | 設計を変える提案の前に必読 |
| `ai/` | AI協働ワークフロー（Epic/Story/Task看板の運用規約とテンプレート） | 本セッションで `tools/kanban/` の実データを作成中 |

## 常用指令

| 指令 | 用途 | 備註 |
|---|---|---|
| `python -m http.server 8080` | ローカルでサイトを開く | `file://` では `fetch` が失敗するため必須 |
| `node tools/fetch-osm.js` → `build-route.js` → `fetch-elevation.js` → `build-terrain.js` → `fetch-hillshade.js` → `fetch-features.js` → `build-spot-geometry.js` | データの作り直し（順序厳守） | ふだんは実行不要。README 参照 |
