# AI看板（実装）

`ai/process/kanban.md` が定める欄位規則の、実際に動くビューア。ビルド不要、素の HTML/CSS/JS（サイト本体と同じ方針）。

## 開く

サイト本体と同じローカルサーバーから開く（`fetch` を使うため `file://` 直接開きは不可）。

```
python -m http.server 8080
```

ブラウザで <http://localhost:8080/tools/kanban/board.html> を開く。

## 中身

- `epics.json` — Epic → User Story の一覧（`project-kickoff` スキルが生成・更新）。
- `cards/*.json` — 個別のタスクカード（1カード1ファイル）。`implementation-plan` スキルが生成する。
- `cards/index.json` — `cards/` 配下のファイル名一覧。ブラウザの `fetch` はディレクトリ一覧を取得できないため、**新しいカードJSONを追加したら、そのファイル名をここにも足すこと。**

## タスクカードのJSON形式

`ai/templates/task-card.md` の項目を素直にJSONへ写したもの。最低限これらのキーを想定：

```json
{
  "id": "E1-S1-T1",
  "title": "モード自動判定のロジック実装",
  "epic": "E1",
  "userStory": "E1-S1",
  "stage": "backlog",
  "dependsOn": [],
  "order": 10,
  "track": "前端",
  "owner": "",
  "risk": "低"
}
```

`stage` は `ai/process/kanban.md` の12段階（`inbox` 〜 `done`）のいずれか。`board.html` はこの値でカードを列に振り分ける。

## board.html は選用ツール

`ai/process/kanban.md` にあるとおり、この看板の運用（欄位規則・WIP上限）は必須だが、`board.html` というビューア自体は選用。中身のJSONさえ規則どおりなら、他のツールで見てもよい。
