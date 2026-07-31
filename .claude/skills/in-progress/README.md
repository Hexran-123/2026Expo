# In Progress

仍在开发中的 skills。它们还没准备好发布——预期会有粗糙之处、破坏性变更和被放弃的实验。在它们毕业进入稳定 bucket 之前，它们被排除在 plugin 和顶层 README 之外。

## User-invoked

- **[loop-me](./loop-me/SKILL.md)** — 通过多个 sessions 把自己 grilling 成可实现的 workflow specs，使用当前目录作为 stateful workspace。User-invoked。
- **[wizard](./wizard/SKILL.md)** — 生成一个交互式 bash wizard，引导人完成一项手动流程（setup、一次性 migration、状态迁移）——打开 URL、捕获值、写入 `.env` 和 GitHub Actions secrets。User-invoked。
- **[writing-beats](./writing-beats/SKILL.md)** — 以自选路径（choose-your-own-adventure）风格，把文章塑造成一段节拍旅程。选一个 starting beat，只写那个 beat，然后 pivot 到下一个，直到文章自然结束。
- **[writing-fragments](./writing-fragments/SKILL.md)** — Grilling session，从你身上挖掘 fragments——异质的写作素材——并把它们追加到单一文档中，作为未来文章的 raw material。
- **[writing-shape](./writing-shape/SKILL.md)** — 拿一份 raw material markdown 文件，一段一段地把它塑造成文章，并在每一步论证格式选择。
- **[claude-handoff](./claude-handoff/SKILL.md)** — 把当前对话交接给一个全新的 background agent，让它立即接手工作，通过 `claude --bg` 以 handoff summary 作为种子。User-invoked。
- **[setup-ts-deep-modules](./setup-ts-deep-modules/SKILL.md)** — 在 TypeScript repo 中接入 dependency-cruiser，让每个 package 成为 deep module——implementation 隐藏在 subfolders 中，只能通过其 entry-point files 访问，tests 则通过这些 entry points 来验证它。User-invoked。
- **[to-questionnaire](./to-questionnaire/SKILL.md)** — 把你无法完全回答的 decision 转成一份交给他人异步填写、或在会议中填写的 Markdown questionnaire。它围绕 send（交给谁、需要返回什么）访谈你，而不是围绕 subject。User-invoked。
- **[batch-grill-me](./batch-grill-me/SKILL.md)** — 持续访谈，按 rounds 遍历 design tree，而不是一次一个问题——每一轮询问整个 frontier（prerequisites 已确定的所有 decisions），然后根据你的回答重新计算。User-invoked。

## Model-invoked

- 当前没有 model-invoked 草稿。
