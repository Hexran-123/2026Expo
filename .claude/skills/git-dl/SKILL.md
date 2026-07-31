---
name: git-dl
description: 从 GitHub 仓库下载 Claude Code skill（或 skill 合集），正确安装到本项目 .claude/skills 目录下并让它真正可用。适用于用户给出一个 GitHub 仓库链接，要求下载、安装、接入某个 skill 或 skills 仓库时。
disable-model-invocation: true
---

# git-dl

把 GitHub 上的一个 Claude Code skill（或 skill 合集仓库）下载下来，正确安装进当前项目，让它真正能被调用——而不只是把文件堆在某个地方。

本机没有 git、没有 node/npm，不能用 `git clone` 或 `npx skills add`。全程只用 GitHub REST API + `raw.githubusercontent.com` 抓文件，PowerShell 落盘。

本项目的本地根目录固定是 `C:\LZH\NU\2026Expo`，所有下载下来的内容都要落到这个目录下面（`.claude/skills/`、`.claude/<repo名>-plugin/` 等都是相对它的子路径），不要落到别的临时目录或用户目录里。

## Process

1. **拿到仓库信息。** 请求 `https://api.github.com/repos/<owner>/<repo>`，读出 `default_branch`。不要假设分支叫 `main`。

2. **拿到完整文件树。** 请求 `https://api.github.com/repos/<owner>/<repo>/git/trees/<branch>?recursive=1`，筛出 `type == "blob"` 的 `path` 列表。完成标准：拿到的是精确路径清单，不是靠 WebFetch 让小模型总结出来的近似列表——总结会漏文件、改名字。

3. **判断这是单个 skill 还是 skill 合集。**
   - 仓库根目录直接有 `SKILL.md` → 单个 skill，把整个仓库内容原样装进 `.claude/skills/<name>/`（`<name>` 取 `SKILL.md` frontmatter 里的 `name:` 字段，没有就用仓库名）。
   - 仓库里有 `skills/` 之类的目录，下面按分类分了好几层子文件夹，每个子文件夹里才是 `SKILL.md` → skill 合集，进入下一步。

4. **合集要拍平，不能保留分类文件夹。** 找出所有包含 `SKILL.md` 的目录，把每一个整体放到 `.claude/skills/<该目录名>/`，**丢掉它原来的分类父目录**（比如 `skills/engineering/tdd/` 要变成 `.claude/skills/tdd/`，不是 `.claude/skills/engineering/tdd/`）。这是踩过的坑：Claude Code 只认 `.claude/skills/` 正下方一层的文件夹，多一层分类目录会导致技能完全不出现、也不报错。

5. **用 PowerShell 逐文件下载**，不要用 WebFetch 抓正文再转述——那是给小模型总结用的，会丢内容、改格式。对清单里每个 `path`，从 `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>` 下载，写到第 3-4 步算出的目标路径，目录不存在就先 `New-Item -ItemType Directory -Force` 建好。完成标准：下载循环报告"成功数 = 目标文件数，失败数 = 0"。

6. **同名 skill 文件夹已存在时不要静默覆盖。** 报告冲突，问用户要覆盖、改名还是跳过。

7. **验证。** 抽查 1-2 个装好的 `SKILL.md`：frontmatter 里的 `name:` 是否和它所在的文件夹名一致；`.claude/skills/` 下有没有残留的多层嵌套（找"文件夹里有 SKILL.md 但不是 `.claude/skills/` 的直接子层"的情况）。

8. **（可选）留一份仓库原始说明文档备查。** 如果仓库还有 README / LICENSE / CHANGELOG / 插件配置这类不影响技能运行、但有参考价值的文件，可以额外拷贝一份到 `.claude/<repo 名>-plugin/`，和功能性的 `.claude/skills/<name>/` 分开放，并说明清楚"这份是备查资料，真正生效的是 skills 目录下那份"。

9. **告诉用户接下来会发生什么，别让他们自己猜。** 新装的 skill 在**当前这一轮对话里就能通过 Skill 工具直接调用**（现场用 Skill 工具试跑一次即可验证）。但 Claude Code 输入框里"/"弹出的命令自动补全列表是另一套缓存，只有**重新加载/重启一次 Claude Code 窗口**之后才会刷新出现新技能——这是两件独立的事，讲清楚，别让用户以为装完立刻就能在"/"列表里看到。

## Failure modes

- **分类目录没拍平** — 技能装完毫无动静，"/"里也搜不到，还不报错，最容易被误判成"没装成功"，其实是文件夹多套了一层。
- **用 WebFetch 代替直接下载源码类文件**（`SKILL.md`、`references/*.md`、脚本）— 内容被小模型转述过，可能丢步骤、改措辞，尤其是长文件。WebFetch 只用来"先了解这个仓库是干嘛的"，正式落盘一律走 raw.githubusercontent.com。
- **把"重启后才出现在 / 列表"和"没装成功"搞混** — 先用 Skill 工具现场验证一次能不能调用，能调用就是装成功了，"/"列表滞后是正常现象，不是 bug。
- **同名覆盖** — 同一个 skill 换新版本再下载一次时，容易不声不响覆盖用户可能手动改过的本地版本，务必先检测冲突。
