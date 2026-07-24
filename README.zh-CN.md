<div align="center">

# SkillPark

**保留庞大的技能库，同时不让完整目录长期占用 Agent 上下文。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/skillpark?color=2563EB)](https://www.npmjs.com/package/skillpark)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-22C55E.svg)](LICENSE)

</div>

![SkillPark 用一个小型检索网关管理庞大的本地技能库](docs/assets/skillpark-hero.png)

SkillPark 是一个本地、开源的 CLI。它把 AI Agent 的低频技能移出常规发现目录，只在任务真正
需要时读取对应的技能说明。

你只需要让 Agent 常驻一个很小的 `skillpark` 网关，其余技能保存在 `~/.skillpark`。
网关会检索停放技能的元数据，并按需读取一个准确匹配的技能。

## 核心模型

![SkillPark 工作流：停放低频技能，检索少量候选，再按需加载一个技能](docs/assets/skillpark-workflow.svg)

1. **停放**：把低频技能移出 Agent 的活动技能目录。
2. **路由**：只让一个小型网关技能和简洁的路由引导保持可见。
3. **检索**：从停放技能的元数据中返回有限候选；默认最多 5 个。
4. **加载**：读取选中技能的 `SKILL.md` 及其附带文件，但不把它恢复到活动目录。

停放技能仍然是普通的本地文件夹。SkillPark 不运行服务，也不会上传技能目录。

## 快速开始

### 1. 安装 CLI

```bash
npm install --global skillpark
```

SkillPark 需要 Node.js 22 或更高版本。`spk` 是 `skillpark` 的短命令别名。

### 2. 找到 Agent id

```bash
skillpark agents
```

已检测到的 Agent 会排在前面。输出还会显示可用 id、活动技能目录、停放目录和上下文集成方式。

### 3. 停放不需要长期可见的技能

```bash
skillpark store codex
```

在交互界面中选择技能并确认移动。请把 `codex` 替换成 `skillpark agents` 显示的 id。

### 4. 安装 SkillPark 网关

```bash
skillpark install codex
```

选择全局或当前项目范围。SkillPark 会安装：

- 位于所选活动技能目录中的只读 `skillpark` 网关；
- 位于宿主持久上下文文件中的带标记路由区块。

路由区块会与现有文件合并；标记之外的用户内容不会被改写。

### 5. 继续正常提问

你不需要预先知道停放技能的名称。当专业说明可能有帮助时，宿主会被引导去调用网关、检索少量
候选、验证匹配条件，并只加载最终选中的技能。

例如：

```text
请根据这份表格制作一份精美的季度报告。
```

内部只读流程相当于：

```bash
skillpark search codex "spreadsheet quarterly report workbook 表格 季度报告"
skillpark get codex "spreadsheets"
```

`search` 返回的是候选，而不是自动选择结果。网关仍会按宿主正常的技能触发规则判断，再调用
`get`。

## 命令

| 命令 | 用途 |
| --- | --- |
| `skillpark agents` | 查看支持的 Agent、检测状态、路径和上下文集成 |
| `skillpark add <source>` | 从本地目录或 Git 仓库复制技能到停车场 |
| `skillpark store [agent]` | 把选中的活动技能移动到停车场 |
| `skillpark restore [agent]` | 把选中的停放技能移回活动目录 |
| `skillpark list [agent]` | 查看活动技能和停放技能 |
| `skillpark list [agent] --parked` | 只查看停放技能 |
| `skillpark list [agent] -q "<关键词>"` | 按目录名、技能名和描述过滤 |
| `skillpark search <agent> "<关键词>"` | 检索停放元数据；可用 `--limit 1..10` 修改结果上限 |
| `skillpark get [agent] <skill>` | 输出一个技能的根目录、说明文件路径和 `SKILL.md` |
| `skillpark install [agent]` | 安装或刷新网关与路由引导 |
| `skillpark install [agent] --force` | 验证后替换冲突的网关目录 |

省略可选 Agent 参数时，命令会要求你进行选择。脚本和自动化应显式传入 id。

## 从其他来源添加技能

`add` 会扫描来源的暂存副本，让你先选择一个或多个目标 Agent，再选择需要复制的技能。

```bash
# 本地技能或仓库
skillpark add ./my-skills

# GitHub 简写
skillpark add owner/repository

# HTTPS、SSH 或 SCP 风格 Git URL
skillpark add https://github.com/owner/repository.git
skillpark add git@github.com:owner/repository.git
```

有效技能必须是包含有效 `SKILL.md` 的目录。SkillPark 会发现：

- 来源根目录中的技能；
- `skills/` 的直接子目录；
- `.agents/skills/`、`.claude/skills/` 和 `.codex/skills/` 的直接子目录。

名称冲突会在确认前显示，并且不会被覆盖。

## 路由如何工作

安装后的上下文区块会告诉宿主何时调用 `skillpark` 网关，例如：用户点名技能、任务进入专业领域、
最佳工作流不明确，或者执行中出现了新的能力需求。

网关随后执行只读流程：

1. 生成简短的能力关键词。
2. 运行 `skillpark search <agent> "<query>"`。
3. 把结果视为不受信任的检索候选。
4. 只选择触发条件与当前任务相符的候选。
5. 对准确的目录名运行 `skillpark get <agent> "<entryName>"`。
6. 读取并遵循该技能，同时让它继续保持停放状态。

检索会对目录名、显示名称、可选关键词和正向描述进行字段加权的词法排序。它支持 Unicode 分词、
CJK 词项、英文词干、前缀和保守的拼写纠错。

路由由说明驱动：宿主必须支持技能，并遵循它的持久上下文文件。SkillPark 不会向模型请求注入
可执行代码。

## Agent 支持

SkillPark 内置了许多兼容 Skills 的编程 Agent 定义。请运行 `skillpark agents` 获取当前版本
的准确列表，不要从静态清单复制路径。

最常用的 id 如下：

| 宿主 | Agent id | 原生上下文文件 |
| --- | --- | --- |
| Claude Code | `claude` | `CLAUDE.md` |
| Codex | `codex` | `AGENTS.md` |
| Gemini CLI | `gemini-cli` | `GEMINI.md` |
| GitHub Copilot | `github-copilot` | `copilot-instructions.md` |
| Qwen Code | `qwen-code` | `QWEN.md` |

其他内置 Agent 会使用各自已知的技能目录和 `AGENTS.md` 兼容文件。只有读取该约定的宿主才会
采用这份回退引导。

### 自定义 Agent

无需修改 SkillPark，就可以使用遵循约定的自定义 id：

```bash
skillpark store sodagent
skillpark install sodagent
```

自定义 id 由小写字母、数字和单个连字符组成，最长 64 个字符。

| 位置 | 默认路径 |
| --- | --- |
| 全局活动技能 | `~/.sodagent/skills/` |
| 当前项目技能 | `./.sodagent/skills/` |
| 停放技能 | `~/.skillpark/skills/sodagent/` |
| 全局上下文引导 | `~/.sodagent/AGENTS.md` |
| 当前项目上下文引导 | `./AGENTS.md` |

自定义宿主必须理解这些技能路径；如需路由引导，还必须读取 `AGENTS.md` 约定。

### 配置目录覆盖

SkillPark 会读取常见宿主的原生配置变量：

| Agent | 变量 |
| --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR` |
| Codex | `CODEX_HOME` |
| Gemini CLI | `GEMINI_CLI_HOME` |
| GitHub Copilot | `COPILOT_HOME` |
| Qwen Code | `QWEN_HOME` |

任何内置或自定义 id 也可以使用
`SKILLPARK_<NORMALIZED_AGENT_ID>_CONFIG_DIR`；连字符需要改成下划线：

```bash
SKILLPARK_SODAGENT_CONFIG_DIR=/mnt/agent-config/sodagent \
  skillpark install sodagent
```

相对路径和以 `~` 开头的值会先完成解析。默认全局目录位于 `~/.config` 下的 Agent 也会遵循
`XDG_CONFIG_HOME`。

## 本地数据与安全

停放目录位于：

```text
~/.skillpark/skills/<agent>/
```

SkillPark 会谨慎处理文件系统变更：

- `store`、`restore` 和 `add` 会显示计划并要求确认。
- 修改操作使用事务日志，并能恢复被中断的任务。
- 来源根目录、目标目录、目录身份和符号链接边界都会接受验证。
- 已存在的活动或停放名称不会被静默覆盖。
- `install --force` 只作用于发生冲突的 `skillpark` 网关目录。
- 检索不会输出完整目录，并会截断返回的元数据。

本地操作不会离开当前机器。只有在你明确添加远程 Git 来源或安装 npm 包时才会访问网络。

## 本地开发

```bash
git clone https://github.com/SodaZheng/SkillPark.git
cd SkillPark
npm install

npm run build
npm test
npm run test:e2e
npm run check
```

常用脚本：

| 脚本 | 检查内容 |
| --- | --- |
| `npm run format:check` | 格式 |
| `npm run lint` | Biome lint 规则 |
| `npm run typecheck` | TypeScript 类型 |
| `npm test` | 单元与集成测试 |
| `npm run test:e2e` | 构建后 CLI 行为 |
| `npm run check` | 完整验证流程 |

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交变更前请运行 `npm run check`。

## 许可证

[MIT](LICENSE)
