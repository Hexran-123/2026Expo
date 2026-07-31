# Productivity

通用工作流工具，不限于代码。

## User-invoked

只有在你显式输入名称时才能调用（Claude Code：`disable-model-invocation: true`；Codex：`agents/openai.yaml` 中的 `policy.allow_implicit_invocation: false`）。

- **[grill-me](./grill-me/SKILL.md)** - 围绕计划或设计进行持续追问，直到 decision tree 的每个分支都被解决。
- **[handoff](./handoff/SKILL.md)** - 把当前对话压缩成 handoff document，让另一个 agent 可以继续。
- **[teach](./teach/SKILL.md)** - 使用当前目录作为 stateful teaching workspace，在多个 sessions 中教用户一个新 skill 或概念。
- **[writing-great-skills](./writing-great-skills/SKILL.md)** - 编写和编辑优秀 skills 的 reference：让 skill 可预测的词汇和原则。

## Model-invoked

模型或用户都可以调用（description 包含足够丰富的触发措辞，方便模型自动找到它们）。

- **[grilling](./grilling/SKILL.md)** - 围绕计划、decision 或 idea 持续访谈用户，直到 decision tree 的每个分支都被解决。
