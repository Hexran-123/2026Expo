---
name: skill-docx-usage
description: 把本项目 .claude/skills 里的一批技能（通常是刚用 git-dl 装的一整个仓库）整理成"技能全览" Word 文档，按网站开发流程（设计→编程→展示）分类介绍。适用于用户要求把技能/skill库总结、整理成Word文档，或说"做成技能全览"时。
disable-model-invocation: true
---

# skill-docx-usage

把一批已经装进 `.claude/skills` 的技能，整理成一份跟历史上几份"技能全览"格式完全一致的 Word 文档：标题页 → 阶段0-3（预备/设计/编程实现/展示协作）→ 每阶段一张四列表格 → 结尾使用建议。

不要重新发明排版逻辑——`templates/word_engine.ps1` 里的 `Build-SkillOverviewDoc` 函数已经踩过所有坑（A4页边距换算、列宽比例、锁字体样式常量），直接复用。

本项目本地根目录固定是 `C:\LZH\NU\2026Expo`，生成的 `.docx` 都存在这个目录正下方，不要存到别处。

## Process

1. **确认这次要总结的技能范围。** 通常是最近一次 `git-dl` 装的一整个仓库；找出这批技能各自的文件夹名和 `SKILL.md` frontmatter（`name`、`description`、有没有 `disable-model-invocation: true`）。

2. **把每个技能归到四个阶段之一。** 按它在"做网站"这件事里最贴近的角色归类，不是按仓库原本的分类：
   - **阶段0 预备** — 安装配置类、"该用哪个技能"的路由器、"怎么写技能/插件"的元技能。
   - **阶段1 设计** — 想清楚做什么、视觉方向、品牌、UX、原型验证。
   - **阶段2 编程实现** — 真正写代码、测试、调试、代码审查、开发环境配置。
   - **阶段3 展示协作** — 写文档、做演示材料、团队交接、持续优化。

   某个阶段一个技能都没有就整节跳过（`Build-SkillOverviewDoc` 会自动跳过 `Skills.Count -eq 0` 的阶段），不要留空表格硬凑。

3. **给每个技能写四栏内容：**
   - 技能名（跟文件夹名一致）
   - 调用方式：frontmatter 有 `disable-model-invocation: true` → "用户手动调用"；没有 → "模型可自动调用"
   - 这是做什么的：基于 frontmatter `description` 改写成通顺的一两句话，不要照抄英文原文
   - 在这个网站项目中怎么用：结合当前项目（銚子電鉄车窓絶景导航网站）的实际场景写一句具体建议。**如果这个技能跟项目关系不大，老实写"跟项目关系不大，可以先不管"，不要为了凑内容编一个牵强的用法。**

4. **写一个小"数据脚本"，dot-source 引擎后调用 `Build-SkillOverviewDoc`。** 不要在数据脚本里重复排版代码。传入：`-OutPath`、`-TitleMain`（固定用 `'Claude Code Skills 全览'`）、`-Subtitle`（固定用 `'以"网站从设计到编程再到展示"为主线 —— 銚子電鉄车窓絶景导航网站项目版'`）、`-SourceLine`（写明来源 GitHub 仓库和技能总数）、`-DateLine`、`-WhatIsThisText`、`-InvokeNoteText`、`-Phases`（四个阶段的数组）、`-EndingTitle`（固定用 `'典型使用顺序建议'`）、`-EndingLines`、`-NoteLine`。

5. **文件命名规则：** `Claude_Skills技能全览_<来源标识>.docx`，存到 `C:\LZH\NU\2026Expo\` 根目录，和已有的几份放一起。**不要覆盖已有文件**——同一个来源要重新生成时，先确认旧文件当前没被 Word 占用（试着直接 `SaveAs2` 到原路径，如果报"文件已被使用"，改存成新文件名，告诉用户关掉旧文件后再合并）。

6. **运行数据脚本前，给它和引擎脚本都加 UTF-8 BOM。** 用 `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($true))`。这一步不能省，见 Failure modes。

7. **验证。** 生成后用 COM 重新打开文档，逐项检查：
   - `doc.Tables.Count` 等于非空阶段数
   - 每张表的行数（减去表头一行）等于该阶段的技能数
   - 每张表所有列宽之和 ≤ `doc.PageSetup.PageWidth - LeftMargin - RightMargin`（即没有超出A4页面）

   三项都通过才算完成，不要只凭"脚本跑完没报错"就判定成功。

## Failure modes

- **忘记加 UTF-8 BOM** — 脚本里的中文在 Windows PowerShell 5.1 里被按系统默认代码页解析成乱码，严重时直接报 `Unexpected token` 语法错误，看起来像逻辑 bug，其实是编码问题。
- **表格列宽写死固定点数**（比如直接写 `95`、`175`）而不是按当前文档实际可用宽度（`PageWidth - 左右页边距`）等比例换算 — 表格右边框会冲出 A4 页面，用户会反馈"表格框框不在纸里"。
- **目标文件正被 Word 打开时直接 `SaveAs2`** — COM 会报"该文件已被使用"错误；不要不管三七二十一强行覆盖，先探测冲突，冲突就换新文件名。
- **为了凑内容硬把关系不大的技能塞进某个阶段编"应用建议"** — 宁可老实说"跟项目关系不大"，不要写空洞的场景假设。
- **Style 用字符串名称**（如 `"Heading 1"`）**而不是 `WdBuiltinStyle` 数字常量**（Title=-63, Heading1=-2, Normal=-1）— 这台机器 Word 的语言包不确定，字符串名称在非英文语言包上可能匹配不到样式，数字常量不受语言影响，恒定可用。

## 已有产出（可作为参照样例）

`C:\LZH\NU\2026Expo\` 下已有四份用同一套引擎生成的文档，格式互相一致：
- `Claude_Skills技能全览_mattpocock-skills-zh-CN.docx`
- `Claude_Skills技能全览_stop-slop.docx`
- `Claude_Skills技能全览_ui-ux-pro-max-skill.docx`
- `Claude_Skills技能全览_anthropics-claude-code.docx`
- `Claude_Skills技能全览_anthropics-skills.docx`
