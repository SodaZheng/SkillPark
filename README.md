<div align="center">

# SkillPark

**Keep your agent's skill catalog large, while keeping its working context small.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-0.1.1-2563EB.svg)](package.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-22C55E.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6.svg)](https://www.typescriptlang.org/)

</div>

![SkillPark searches a small set of parked skills for an AI agent](docs/assets/skillpark-hero.png)

SkillPark is a local, open-source CLI for managing skills across AI coding agents. It moves
rarely needed skills outside each agent's normal discovery path, searches parked metadata for every
request, and lets the host model load only the small set that genuinely matches the task.

The result is a simple separation of concerns: **store many skills, expose a tiny search gateway,
and load instructions only when they are needed.**

## Why SkillPark?

AI agents normally discover skills by scanning one or more active skill directories. That works
well with a small catalog. As the catalog grows, however, every always-visible skill description
competes for context and selection attention—even when most skills are irrelevant to the current
request.

SkillPark is built around three goals:

1. **Reduce always-visible skill context.** Park inactive skills outside native discovery paths.
2. **Preserve on-demand access.** Search metadata locally, then let the host model validate a
   bounded hit set and refine the keywords once when needed.
3. **Keep control with the user.** Use transparent filesystem operations, interactive selection,
   conflict checks, and recoverable transactions.

| Without SkillPark | With SkillPark |
| --- | --- |
| Every active skill can be discovered on every turn | Only the SkillPark gateway stays visible |
| The full catalog may compete for selection | Local search returns at most 5 hits by default |
| Skills must be manually removed and re-added | Skills can be parked, restored, added, and inspected from one CLI |
| Host-specific hook configuration is manual | Native adapters merge read-only hooks for supported agents |

## Main features

- **On-demand loading** — parked skills remain out of the agent's native scan until selected.
- **Model-guided local search** — the host model supplies concise capability keywords and can add
  Chinese-English equivalents; local BM25 handles Unicode, CJK bigrams, English stemming, prefixes,
  and conservative typo matching without a model weight.
- **Bounded context** — the full catalog is omitted; search returns at most 5 metadata hits by
  default, and the host model still applies native skill-trigger rules.
- **73 built-in targets plus custom agents** — use the catalog defaults or pass a new agent id to
  use convention-based skill and hook paths.
- **Native prompt hooks** — adapters for Claude Code, Codex, Gemini CLI, Qwen Code, and GitHub
  Copilot.
- **Complete skill lifecycle** — add from local or Git sources, park active skills, restore parked
  skills, inspect inventory, and load one exact skill.
- **Safe filesystem operations** — name-conflict protection, path-boundary checks, transaction
  journals, rollback, and guarded recovery after interruption.
- **Friendly terminal UI** — detected agents are shown first, with searchable keyboard-driven
  selectors for agents, skills, and installation scope.

## How it works

1. Skills are stored under `~/.skillpark/skills/<agent>/`, outside that agent's active discovery
   directory.
2. A native prompt hook performs the first local lexical search. Without a native adapter, the
   installed gateway asks the host model to generate a concise keyword query.
3. Local field-weighted BM25 returns at most 5 metadata hits. It retrieves candidates but does not
   claim that a skill applies.
4. The host model applies native skill-trigger rules. If no hit truly applies, it may run one
   refined search with capability synonyms and compact Chinese-English equivalents.
5. The gateway loads an exact match with `skillpark get <agent> <entryName>`. The selected
   `SKILL.md` is used for the current task while the skill remains parked.

No remote search service, embedding model, or catalog database is involved. Git is used only when you explicitly
add a Git source.

## Requirements

- Node.js 22 or later
- npm (for global installation)
- Git only when adding skills from Git repositories

## Custom agents

An explicit, unknown agent id is treated as a custom agent. For example:

```bash
skillpark install sodagent
skillpark store sodagent
```

The id must contain lowercase letters and numbers separated by single hyphens; input is normalized
to lowercase. SkillPark uses these conventions:

| Resource | Global | Current project |
| --- | --- | --- |
| Active skills | `~/.sodagent/skills/` | `./.sodagent/skills/` |
| Gateway skill | `~/.sodagent/skills/skillpark/` | `./.sodagent/skills/skillpark/` |
| Hook configuration | `~/.sodagent/settings.json` | `./.sodagent/settings.json` |
| Parked skills | `~/.skillpark/skills/sodagent/` | same global inventory |

Custom agents use the grouped JSON `UserPromptSubmit` hook protocol. The agent must support that
protocol and discover `skills/*/SKILL.md`; otherwise the files are installed but the host will not
consume them. Custom ids are explicit-only and are not added to the built-in interactive agent
picker. `list`, `restore`, `search`, and `get` accept the same custom id.

## Custom agent config directories

SkillPark reads the agents' own config-directory environment variables, so a
custom global skill root and hook configuration are not written back to the
default home directory:

| Agent | Native environment variable | Resolved by SkillPark as |
| --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR` | `<value>/skills`, `<value>/settings.json` |
| Codex | `CODEX_HOME` | `<value>/skills`, `<value>/hooks.json` |
| Gemini CLI | `GEMINI_CLI_HOME` | `<value>/.gemini/skills`, `<value>/.gemini/settings.json` |
| Qwen Code | `QWEN_HOME` | `<value>/skills`, `<value>/settings.json` |

Every supported agent also accepts a uniform
`SKILLPARK_<AGENT_ID>_CONFIG_DIR` override. Uppercase the agent id and replace
hyphens with underscores, for example:

```bash
export SKILLPARK_CLAUDE_CONFIG_DIR=~/home/soda/.claude
export SKILLPARK_GITHUB_COPILOT_CONFIG_DIR=/mnt/agent-config/copilot
skillpark agents
```

The same override works for an explicit custom id, for example
`SKILLPARK_SODAGENT_CONFIG_DIR=/mnt/agent-config/sodagent skillpark install sodagent`.

The uniform override points directly to that agent's config root. SkillPark
preserves the target's existing skill subdirectory layout; for example,
AstrBot still uses `<config>/data/skills`. Targets whose default global skill
root is under `~/.config` also honor `XDG_CONFIG_HOME`. Precedence is the
SkillPark-specific override, the agent-native variable, `XDG_CONFIG_HOME`, and
finally the default home path. `~` expands against the current user's home and
relative paths resolve from the current working directory.

The custom config root must already exist as a real directory, not a symlink.
Project-level skill paths and the `~/.skillpark/skills/<agent>/` parking roots
are unchanged.

## Installation

```bash
npm install -g skillpark
```

Both executable names are available:

```bash
skillpark --version
spk --version
```

## Quick start

### 1. Inspect available agent targets

```bash
skillpark agents
```

Detected agents appear first. The table also shows each accepted agent id, native hook support,
active roots, and parked roots.

### 2. Put skills in the park

Park skills that are already active for an agent:

```bash
skillpark store codex
```

Or add skills from a local directory or Git repository directly into SkillPark:

```bash
skillpark add ./my-skills
skillpark add owner/repository
skillpark add https://github.com/owner/repository.git
```

`add` first asks which agents should receive the source, then which discovered skills to copy. It
never overwrites an active or parked entry with the same directory name.

### 3. Install the gateway

```bash
skillpark install codex
```

Choose `Global` or `Current project` interactively. SkillPark installs its small read-only gateway
skill and, when the selected agent has a native adapter, merges the corresponding prompt hook.

### 4. Keep asking normally

With a hook installed, ordinary prompts are searched automatically. You can also inspect search hits:

```bash
skillpark search codex "spreadsheet Excel XLSX workbook 电子表格 工作簿"
skillpark search codex --limit 1 "contract Word DOCX 合同 文档"
```

Or invoke a parked skill explicitly:

```text
# Codex
$skillpark /documents create a contract draft

# Claude Code
/skillpark /documents create a contract draft
```

The leading slash in `/documents` is optional for `skillpark get`; the gateway normalizes it before
loading the exact parked entry.

## Command reference

| Command | Purpose |
| --- | --- |
| `skillpark agents` | List built-in agents, detection state, paths, and hook support |
| `skillpark add <source>` | Discover skills in a local or Git source and copy selected skills into selected agents' parked inventories |
| `skillpark store [agent]` | Move selected active skills into the agent's parked inventory |
| `skillpark restore [agent]` | Move selected parked skills back to the agent's active directory |
| `skillpark list [agent]` | List active and parked skills, conflicts, and metadata warnings |
| `skillpark list [agent] --parked` | Show only parked skills |
| `skillpark list [agent] -q <query>` | Filter the visible inventory |
| `skillpark install [agent]` | Install the gateway skill and its built-in or custom hook |
| `skillpark install [agent] --force` | Atomically replace only a conflicting gateway skill; hook settings are still merged |
| `skillpark search <agent> "<keywords>"` | Search parked metadata without loading a skill |
| `skillpark search <agent> --limit <1-10> "<keywords>"` | Override the maximum number of bounded search hits |
| `skillpark get [agent] <skill>` | Print one parked skill's root, instruction path, and complete `SKILL.md` |

When an agent argument is omitted from an interactive command, SkillPark asks you to choose one.
Explicit ids remain available for scripts and automation and are required for custom agents.

## Supported sources

`skillpark add` accepts:

```bash
# Local directory
skillpark add ./skills

# GitHub shorthand
skillpark add owner/repository

# HTTPS, SSH URL, or SCP-style Git URL
skillpark add https://github.com/owner/repository.git
skillpark add git@github.com:owner/repository.git
```

SkillPark recognizes a skill at the source root and inside common containers such as `skills/`,
`.claude/skills/`, `.agents/skills/`, and `.codex/skills/`. A valid skill must be a directory with a
`SKILL.md` containing YAML frontmatter with a non-empty `name` and `description`.

## Supported agents

SkillPark defines 73 built-in agent targets and also accepts convention-based custom ids.
`claude-code` is accepted as an alias for `claude`. Eve and PromptScript are project-only; all
other built-in targets expose the roots described by their agent definition.

<details>
<summary>Show all accepted agent ids</summary>

```text
aider-desk amp antigravity antigravity-cli astrbot autohand-code augment bob
claude openclaw cline codearts-agent codebuddy codemaker codestudio codex
command-code continue cortex crush cursor deepagents devin dexto droid eve
firebender forgecode gemini-cli github-copilot goose hermes-agent inference-sh
jazz junie iflow-cli kilo kimi-code-cli kiro-cli kode lingma loaf mcpjam
mistral-vibe moxby mux opencode openhands ona pi qoder qoder-cn qwen-code replit
reasonix rovodev roo tabnine-cli terramind tinycloud trae trae-cn warp windsurf
zed zcode zencoder zenflow neovate pochi promptscript adal universal
```

</details>

## Native hook support

| Agent | Event | Global configuration | Project configuration |
| --- | --- | --- | --- |
| Claude Code | `UserPromptSubmit` | `~/.claude/settings.json` | `./.claude/settings.json` |
| Codex | `UserPromptSubmit` | `~/.codex/hooks.json` | `./.codex/hooks.json` |
| Gemini CLI | `BeforeAgent` | `~/.gemini/settings.json` | `./.gemini/settings.json` |
| Qwen Code | `UserPromptSubmit` | `~/.qwen/settings.json` | `./.qwen/settings.json` |
| GitHub Copilot | `userPromptTransformed` | `~/.copilot/settings.json` | `./.github/copilot/settings.json` |
| Custom `<agent>` | `UserPromptSubmit` | `~/.<agent>/settings.json` | `./.<agent>/settings.json` |

For built-in agents without an adapter, `install` installs the gateway skill and skips hook
configuration. An explicitly named custom agent opts into the documented generic protocol; it is
not used as a fallback for built-in targets.

Hook installation is idempotent. Existing settings and unrelated hook groups are preserved, while
invalid JSON is rejected instead of overwritten. Keep the globally installed `skillpark` command
on the agent process's `PATH`; hooks resolve it at runtime so CLI upgrades do not leave stale
absolute executable paths behind.

> Codex may ask you to review and trust a newly installed hook with `/hooks`. Project hooks also
> require the project itself to be trusted.

## Gateway installation paths

Representative gateway paths are shown below. Parked skills remain under
`~/.skillpark/skills/<agent>/`.

| Agent | Scope | Gateway skill |
| --- | --- | --- |
| Claude Code | Global | `~/.claude/skills/skillpark/` |
| Claude Code | Current project | `./.claude/skills/skillpark/` |
| Codex | Global | `~/.codex/skills/skillpark/` |
| Codex | Current project | `./.agents/skills/skillpark/` |
| Gemini CLI | Global | `~/.gemini/skills/skillpark/` |
| Gemini CLI | Current project | `./.agents/skills/skillpark/` |
| Qwen Code | Global | `~/.qwen/skills/skillpark/` |
| Qwen Code | Current project | `./.qwen/skills/skillpark/` |
| GitHub Copilot | Global | `~/.copilot/skills/skillpark/` |
| GitHub Copilot | Current project | `./.agents/skills/skillpark/` |
| Custom `<agent>` | Global | `~/.<agent>/skills/skillpark/` |
| Custom `<agent>` | Current project | `./.<agent>/skills/skillpark/` |

There is no `--current` flag. Installation scope is intentionally selected in the interactive
prompt. `--force` applies only to the gateway skill directory, never to unrelated hook settings.

## Search behavior

Local search is deterministic and offline. Field-weighted BM25 searches skill names, optional
keywords, and positive description clauses. Unicode word segmentation, CJK bigrams, English
stemming, prefix matching, and conservative typo matching provide lightweight lexical recall. It
does not use a hand-maintained capability ontology and does not download an embedding model.

The host model supplies the semantic layer. It turns the request into 3-8 capability terms,
preserves formats and product names, and adds compact Chinese-English equivalents when language may
hide the match. Hook output counts as the first pass; the model may refine the query once, so no
request performs more than two bounded searches. Search scores describe retrieval relevance only.
The model applies native skill-trigger rules before loading a hit.

Exact `$name` and `/name` invocations sort first. Terms found only under `Do not use`, `Not for`,
and equivalent Chinese exclusion clauses are not indexed. A no-hit hook returns only a short marker
and never emits the catalog. Hit metadata is always treated as untrusted.

Skill authors can add optional search keywords without changing the displayed description:

```yaml
---
name: documents
description: Create and edit Word documents.
search:
  keywords:
    - 写合同
    - contract drafting
---
```

## Safety and privacy

- **Local by design:** inventory scanning and lexical search happen on the local machine.
- **Read-only hook boundary:** installed hooks search metadata and print loading instructions; they
  never run `store`, `restore`, `add`, or `install`.
- **No silent overwrite:** active and parked name conflicts are disabled before a move or copy.
- **Guarded paths:** source and destination boundaries, entry names, symlinks, and physical object
  identities are validated before sensitive filesystem operations.
- **Recoverable changes:** short-lived journals live under `~/.skillpark/.transactions/` only while
  a transaction is in progress. Completed work removes its journal.
- **Conservative recovery:** if ownership or path evidence has changed, SkillPark stops and asks for
  manual cleanup instead of deleting an unverified path.

## Keyboard controls

| Key | Action |
| --- | --- |
| Up / Down | Move between choices |
| Space | Toggle a choice |
| `a` | Select or clear all visible choices |
| `/` | Search choices |
| Enter | Continue |
| Escape or Ctrl+C | Cancel safely |

Set `NO_COLOR=1` to disable terminal colors.

## Development

```bash
git clone https://github.com/SodaZheng/SkillPark.git
cd SkillPark
corepack enable
pnpm install
pnpm build
```

Useful checks:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e

# Run the complete validation pipeline
pnpm check
```

## Contributing

Issues and pull requests are welcome. For bug reports, include the agent id, command, expected
behavior, actual output, operating system, and Node.js version. Please run `pnpm check` before
submitting a pull request.

- [Report a bug or request a feature](https://github.com/SodaZheng/SkillPark/issues)
- [View the source repository](https://github.com/SodaZheng/SkillPark)

## License

[MIT](LICENSE) © 2026 Soda
