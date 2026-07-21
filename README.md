<div align="center">

# SkillPark

**Keep your agent's skill catalog large, while keeping its working context small.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-0.1.0-2563EB.svg)](package.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-22C55E.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6.svg)](https://www.typescriptlang.org/)

</div>

![SkillPark routes a small set of parked skills into an AI agent](docs/assets/skillpark-hero.png)

SkillPark is a local, open-source CLI for managing skills across AI coding agents. It moves
rarely needed skills outside each agent's normal discovery path, routes every request against
parked skill metadata, and loads only the small set that genuinely matches the task.

The result is a simple separation of concerns: **store many skills, expose a tiny router, and load
instructions only when they are needed.**

## Why SkillPark?

AI agents normally discover skills by scanning one or more active skill directories. That works
well with a small catalog. As the catalog grows, however, every always-visible skill description
competes for context and routing attention—even when most skills are irrelevant to the current
request.

SkillPark is built around three goals:

1. **Reduce always-visible skill context.** Park inactive skills outside native discovery paths.
2. **Preserve on-demand access.** Route requests locally and reveal only a confidence-gated
   candidate set.
3. **Keep control with the user.** Use transparent filesystem operations, interactive selection,
   conflict checks, and recoverable transactions.

| Without SkillPark | With SkillPark |
| --- | --- |
| Every active skill can be discovered on every turn | Only the SkillPark gateway stays visible |
| The full catalog may compete for selection | The local router returns at most 3 candidates by default |
| Skills must be manually removed and re-added | Skills can be parked, restored, added, and inspected from one CLI |
| Host-specific hook configuration is manual | Native adapters merge read-only hooks for supported agents |

## Main features

- **On-demand loading** — parked skills remain out of the agent's native scan until selected.
- **Deterministic local routing** — Unicode-aware matching for Chinese and English, exact
  invocation, aliases, word-form normalization, rarity weighting, and conservative typo matching.
- **Bounded context** — the full catalog is omitted; routing returns a small, confidence-gated set
  with a default maximum of 3 candidates.
- **73 agent targets** — paths and detection rules cover a broad set of coding agents and skill
  hosts.
- **Native prompt hooks** — adapters for Claude Code, Codex, Gemini CLI, Qwen Code, and GitHub
  Copilot.
- **Complete skill lifecycle** — add from local or Git sources, park active skills, restore parked
  skills, inspect inventory, and load one exact skill.
- **Safe filesystem operations** — name-conflict protection, path-boundary checks, transaction
  journals, rollback, and guarded recovery after interruption.
- **Friendly terminal UI** — detected agents are shown first, with searchable keyboard-driven
  selectors for agents, skills, and installation scope.

## How it works

![SkillPark local routing and loading flow](docs/assets/skillpark-routing-flow.png)

1. Skills are stored under `~/.skillpark/skills/<agent>/`, outside that agent's active discovery
   directory.
2. A native prompt hook—or the installed gateway skill when no native adapter exists—passes the
   request to the local router.
3. The router reads only parked skill metadata and returns the best confidence-gated matches. The
   normal hook path uses the precision-oriented default limit of 3.
4. The gateway applies the host agent's normal skill-trigger rules to those candidates and loads an
   exact match with `skillpark get <agent> <entryName>`.
5. The selected `SKILL.md` is used for the current task. The skill itself remains parked.

No remote routing service or catalog database is involved. Git is used only when you explicitly
add a Git source.

## Requirements

- Node.js 22 or later
- npm (for global installation)
- Git only when adding skills from Git repositories

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

With a hook installed, ordinary prompts are routed automatically. You can also inspect the route:

```bash
skillpark route codex "create an Excel workbook"
skillpark route codex --limit 1 "write a contract"
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
| `skillpark agents` | List all supported agents, detection state, paths, and hook support |
| `skillpark add <source>` | Discover skills in a local or Git source and copy selected skills into selected agents' parked inventories |
| `skillpark store [agent]` | Move selected active skills into the agent's parked inventory |
| `skillpark restore [agent]` | Move selected parked skills back to the agent's active directory |
| `skillpark list [agent]` | List active and parked skills, conflicts, and metadata warnings |
| `skillpark list [agent] --parked` | Show only parked skills |
| `skillpark list [agent] -q <query>` | Filter the visible inventory |
| `skillpark install [agent]` | Install the gateway skill and a supported native hook |
| `skillpark install [agent] --force` | Atomically replace only a conflicting gateway skill; hook settings are still merged |
| `skillpark route <agent> "<query>"` | Inspect the bounded local routing result without loading a skill |
| `skillpark route <agent> --limit <1-10> "<query>"` | Override the maximum number of diagnostic candidates |
| `skillpark get [agent] <skill>` | Print one parked skill's root, instruction path, and complete `SKILL.md` |

When an agent argument is omitted from an interactive command, SkillPark asks you to choose one.
Explicit ids remain available for scripts and automation.

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

SkillPark currently defines 73 agent targets. `claude-code` is accepted as an alias for `claude`.
Eve and PromptScript are project-only; all other targets expose the roots described by their agent
definition.

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

For every other supported agent, `install` installs the gateway skill and skips hook configuration.
SkillPark never writes one host's hook schema as a fallback for another host.

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

There is no `--current` flag. Installation scope is intentionally selected in the interactive
prompt. `--force` applies only to the gateway skill directory, never to unrelated hook settings.

## Routing behavior

The router is deterministic, offline, and designed for precision. It combines:

- explicit entry-name invocation;
- Unicode-aware tokenization;
- skill name and description weighting;
- common Chinese and English capability concepts;
- English word-form normalization;
- per-catalog rarity;
- conservative typo similarity;
- confidence thresholds and distance from the top score.

A no-match hook returns only a short marker and never emits the catalog. Candidate metadata is
treated as untrusted, and the gateway still applies the host agent's native skill-trigger rules
before loading anything.

Skill authors can add routing-only aliases without changing the displayed description:

```yaml
---
name: documents
description: Create and edit Word documents.
routing:
  aliases:
    - 写合同
    - contract drafting
---
```

## Safety and privacy

- **Local by design:** inventory scanning and routing happen on the local machine.
- **Read-only hook boundary:** installed hooks route metadata and print loading instructions; they
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
