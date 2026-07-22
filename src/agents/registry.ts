import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AGENT_IDS,
  type AgentConfigDirs,
  type AgentDefinition,
  type AgentDetection,
  type AgentId,
  type AgentPaths,
  type AgentScope,
  type BuiltInAgentId,
  isAgentId,
} from "../domain/agents.js";
import { UsageError } from "../domain/errors.js";

type DefinitionInput = Omit<AgentDefinition, "aliases" | "id"> & {
  aliases?: readonly string[];
};

function defineAgents(
  inputs: Record<BuiltInAgentId, DefinitionInput>,
): Record<BuiltInAgentId, AgentDefinition> {
  return Object.fromEntries(
    AGENT_IDS.map((id) => {
      const input = inputs[id];
      return [
        id,
        {
          ...input,
          id,
          aliases: [...(input.aliases ?? []), id],
        },
      ];
    }),
  ) as unknown as Record<BuiltInAgentId, AgentDefinition>;
}

// Paths intentionally mirror skills@1.5.19. Keep host-specific behavior in
// adapters; this catalog only describes identity, discovery, and skill roots.
const definitions = defineAgents({
  "aider-desk": entry("AiderDesk", ".aider-desk/skills"),
  amp: entry("Amp", ".agents/skills", ".config/agents/skills", {
    global: [".config/amp"],
  }),
  antigravity: entry(
    "Antigravity",
    ".agents/skills",
    ".gemini/antigravity/skills",
  ),
  "antigravity-cli": entry(
    "Antigravity CLI",
    ".agents/skills",
    ".gemini/antigravity-cli/skills",
  ),
  astrbot: entry("AstrBot", "data/skills", ".astrbot/data/skills", {
    global: [".astrbot"],
    current: ["data/skills"],
  }),
  "autohand-code": entry("Autohand Code CLI", ".autohand/skills"),
  augment: entry("Augment", ".augment/skills"),
  bob: entry("IBM Bob", ".bob/skills"),
  claude: {
    ...entry("Claude Code", ".claude/skills"),
    aliases: ["claude-code"],
    hook: "claude",
    parkedKey: "claude",
  },
  openclaw: entry("OpenClaw", "skills", ".openclaw/skills", {
    global: [".openclaw", ".clawdbot", ".moltbot"],
  }),
  cline: entry("Cline", ".agents/skills", ".agents/skills", {
    global: [".cline"],
  }),
  "codearts-agent": entry("CodeArts Agent", ".codeartsdoer/skills"),
  codebuddy: entry("CodeBuddy", ".codebuddy/skills", undefined, {
    global: [".codebuddy"],
    current: [".codebuddy"],
  }),
  codemaker: entry("Codemaker", ".codemaker/skills"),
  codestudio: entry("Code Studio", ".codestudio/skills"),
  codex: {
    ...entry("Codex", ".agents/skills", ".codex/skills", {
      global: [".codex"],
    }),
    hook: "codex",
  },
  "command-code": entry("Command Code", ".commandcode/skills"),
  continue: entry("Continue", ".continue/skills", undefined, {
    global: [".continue"],
    current: [".continue"],
  }),
  cortex: entry("Cortex Code", ".cortex/skills", ".snowflake/cortex/skills"),
  crush: entry("Crush", ".crush/skills", ".config/crush/skills"),
  cursor: entry("Cursor", ".agents/skills", ".cursor/skills", {
    global: [".cursor"],
  }),
  deepagents: entry(
    "Deep Agents",
    ".agents/skills",
    ".deepagents/agent/skills",
    { global: [".deepagents"] },
  ),
  devin: entry("Devin for Terminal", ".devin/skills", ".config/devin/skills"),
  dexto: entry("Dexto", ".agents/skills", ".agents/skills", {
    global: [".dexto"],
  }),
  droid: entry("Droid", ".factory/skills"),
  eve: projectOnly("Eve", "agent/skills", {
    current: ["agent"],
  }),
  firebender: entry("Firebender", ".agents/skills", ".firebender/skills"),
  forgecode: entry("ForgeCode", ".forge/skills"),
  "gemini-cli": {
    ...entry("Gemini CLI", ".agents/skills", ".gemini/skills"),
    hook: "gemini",
  },
  "github-copilot": {
    ...entry("GitHub Copilot", ".agents/skills", ".copilot/skills"),
    hook: "copilot",
  },
  goose: entry("Goose", ".goose/skills", ".config/goose/skills"),
  "hermes-agent": entry("Hermes Agent", ".hermes/skills"),
  "inference-sh": entry("inference.sh", ".inferencesh/skills"),
  jazz: entry("Jazz", ".jazz/skills", undefined, {
    global: [".jazz"],
    current: [".jazz"],
  }),
  junie: entry("Junie", ".junie/skills"),
  "iflow-cli": entry("iFlow CLI", ".iflow/skills"),
  kilo: entry("Kilo Code", ".kilocode/skills"),
  "kimi-code-cli": entry("Kimi Code CLI", ".agents/skills", ".agents/skills", {
    global: [".kimi-code", ".kimi"],
  }),
  "kiro-cli": entry("Kiro CLI", ".kiro/skills"),
  kode: entry("Kode", ".kode/skills"),
  lingma: entry("Lingma", ".lingma/skills"),
  loaf: entry("Loaf", ".agents/skills", ".agents/skills", {
    global: [".loaf"],
  }),
  mcpjam: entry("MCPJam", ".mcpjam/skills"),
  "mistral-vibe": entry("Mistral Vibe", ".vibe/skills"),
  moxby: entry("Moxby", ".moxby/skills"),
  mux: entry("Mux", ".mux/skills"),
  opencode: entry("OpenCode", ".agents/skills", ".config/opencode/skills"),
  openhands: entry("OpenHands", ".openhands/skills"),
  ona: entry("Ona", ".ona/skills"),
  pi: entry("Pi", ".pi/skills", ".pi/agent/skills", {
    global: [".pi/agent"],
  }),
  qoder: entry("Qoder", ".qoder/skills"),
  "qoder-cn": entry("Qoder CN", ".qoder/skills", ".qoder-cn/skills"),
  "qwen-code": {
    ...entry("Qwen Code", ".qwen/skills"),
    hook: "qwen",
  },
  replit: entry("Replit", ".agents/skills", ".config/agents/skills", {
    current: [".replit"],
  }),
  reasonix: entry("Reasonix", ".reasonix/skills"),
  rovodev: entry("Rovo Dev", ".rovodev/skills"),
  roo: entry("Roo Code", ".roo/skills"),
  "tabnine-cli": entry("Tabnine CLI", ".tabnine/agent/skills"),
  terramind: entry("Terramind", ".terramind/skills"),
  tinycloud: entry("Tinycloud", ".tinycloud/skills"),
  trae: entry("Trae", ".trae/skills"),
  "trae-cn": entry("Trae CN", ".trae/skills", ".trae-cn/skills"),
  warp: entry("Warp", ".agents/skills", ".agents/skills", {
    global: [".warp"],
  }),
  windsurf: entry("Windsurf", ".windsurf/skills", ".codeium/windsurf/skills"),
  zed: entry("Zed", ".agents/skills", ".agents/skills", {
    global: [".config/zed"],
  }),
  zcode: entry("ZCode", ".zcode/skills"),
  zencoder: entry("Zencoder", ".zencoder/skills"),
  zenflow: entry("Zenflow", ".zencoder/skills"),
  neovate: entry("Neovate", ".neovate/skills"),
  pochi: entry("Pochi", ".pochi/skills"),
  promptscript: projectOnly("PromptScript", ".agents/skills", {
    current: [".promptscript", "promptscript.yaml"],
  }),
  adal: entry("AdaL", ".adal/skills"),
  universal: entry("Universal", ".agents/skills", ".config/agents/skills", {
    global: [],
    current: [],
  }),
});

function entry(
  label: string,
  projectSkillsDir: string,
  globalSkillsDir: string | undefined = projectSkillsDir,
  detection?: AgentDefinition["detection"],
): DefinitionInput {
  return {
    label,
    projectSkillsDir,
    ...(globalSkillsDir === undefined ? {} : { globalSkillsDir }),
    ...(detection === undefined ? {} : { detection }),
  };
}

function projectOnly(
  label: string,
  projectSkillsDir: string,
  detection: NonNullable<AgentDefinition["detection"]>,
): DefinitionInput {
  return { label, projectSkillsDir, detection };
}

export function getAgentDefinition(agent: AgentId): AgentDefinition {
  const builtIn = definitions[agent as BuiltInAgentId];
  if (builtIn !== undefined) return builtIn;
  if (!isAgentId(agent)) throw invalidAgentId(agent);
  return customAgentDefinition(agent);
}

export function listAgentDefinitions(): readonly AgentDefinition[] {
  return AGENT_IDS.map((id) => definitions[id]);
}

export function parseAgentId(value: string): AgentId {
  const normalized = value.trim().toLowerCase();
  for (const definition of listAgentDefinitions()) {
    if (definition.aliases.includes(normalized)) return definition.id;
  }
  if (isAgentId(normalized)) return normalized;
  throw invalidAgentId(value);
}

function invalidAgentId(value: string): UsageError {
  return new UsageError(
    `Invalid agent id: ${value}. Use lowercase letters and numbers separated by single hyphens (maximum 64 characters).`,
  );
}

export function supportsGlobalSkills(agent: AgentId): boolean {
  return getAgentDefinition(agent).globalSkillsDir !== undefined;
}

function customAgentDefinition(agent: AgentId): AgentDefinition {
  const configRoot = `.${agent}`;
  return {
    id: agent,
    label: agent,
    aliases: [agent],
    projectSkillsDir: `${configRoot}/skills`,
    globalSkillsDir: `${configRoot}/skills`,
    detection: { global: [configRoot], current: [configRoot] },
    hook: "custom",
  };
}

const nativeConfigEnvironments: Partial<
  Record<AgentId, { name: string; suffix?: string }>
> = {
  claude: { name: "CLAUDE_CONFIG_DIR" },
  codex: { name: "CODEX_HOME" },
  "gemini-cli": { name: "GEMINI_CLI_HOME", suffix: ".gemini" },
  "qwen-code": { name: "QWEN_HOME" },
};

function customConfigEnvironment(agent: AgentId): string {
  return `SKILLPARK_${agent.toUpperCase().replaceAll("-", "_")}_CONFIG_DIR`;
}

function expandConfigPath(value: string, homeDir: string, cwd: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return resolve(homeDir);
  if (trimmed.startsWith(`~${sep}`)) {
    return resolve(homeDir, trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

function xdgConfigDir(
  definition: AgentDefinition,
  xdgRoot: string,
): string | undefined {
  const globalSkillsDir = definition.globalSkillsDir;
  if (globalSkillsDir === undefined) return undefined;
  const configDir = defaultConfigDir(definition);
  const prefix = `.config${sep}`;
  if (!configDir.startsWith(prefix)) return undefined;
  return join(xdgRoot, configDir.slice(prefix.length));
}

function defaultConfigDir(definition: AgentDefinition): string {
  const globalSkillsDir = definition.globalSkillsDir;
  if (globalSkillsDir === undefined) {
    throw new Error(
      `${definition.label} has no global configuration directory`,
    );
  }
  const marker = definition.detection?.global?.find((candidate) => {
    const difference = relative(candidate, globalSkillsDir);
    return (
      difference !== "" &&
      difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference)
    );
  });
  return marker ?? dirname(globalSkillsDir);
}

export function resolveAgentConfigDirs(
  homeDir: string,
  cwd: string = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): AgentConfigDirs {
  const resolved: AgentConfigDirs = {};
  const xdgValue = environment.XDG_CONFIG_HOME?.trim();
  const xdgRoot =
    xdgValue === undefined || xdgValue === ""
      ? undefined
      : expandConfigPath(xdgValue, homeDir, cwd);

  for (const definition of listAgentDefinitions()) {
    const explicit =
      environment[customConfigEnvironment(definition.id)]?.trim();
    if (explicit !== undefined && explicit !== "") {
      resolved[definition.id] = expandConfigPath(explicit, homeDir, cwd);
      continue;
    }

    const native = nativeConfigEnvironments[definition.id];
    const nativeValue =
      native === undefined ? undefined : environment[native.name]?.trim();
    if (nativeValue !== undefined && nativeValue !== "") {
      const base = expandConfigPath(nativeValue, homeDir, cwd);
      resolved[definition.id] =
        native?.suffix === undefined ? base : join(base, native.suffix);
      continue;
    }

    if (xdgRoot !== undefined) {
      const configDir = xdgConfigDir(definition, xdgRoot);
      if (configDir !== undefined) resolved[definition.id] = configDir;
    }
  }

  for (const [name, value] of Object.entries(environment)) {
    const match = /^SKILLPARK_([A-Z0-9_]+)_CONFIG_DIR$/u.exec(name);
    const explicit = value?.trim();
    if (match === null || explicit === undefined || explicit === "") continue;
    const candidate = match[1]?.toLowerCase().replaceAll("_", "-");
    if (candidate === undefined || !isAgentId(candidate)) continue;
    const agent = parseAgentId(candidate);
    if (resolved[agent] === undefined) {
      resolved[agent] = expandConfigPath(explicit, homeDir, cwd);
    }
  }
  return resolved;
}

export function getAgentConfigDir(
  agent: AgentId,
  homeDir: string,
  configDirs: AgentConfigDirs = {},
): string | undefined {
  const definition = getAgentDefinition(agent);
  if (definition.globalSkillsDir === undefined) return undefined;
  return configDirs[agent] ?? join(homeDir, defaultConfigDir(definition));
}

export function getAgentSkillRoot(
  agent: AgentId,
  scope: AgentScope,
  homeDir: string,
  cwd: string,
  configDirs: AgentConfigDirs = {},
): string {
  const definition = getAgentDefinition(agent);
  if (scope === "current") return join(cwd, definition.projectSkillsDir);
  if (definition.globalSkillsDir === undefined) {
    throw new UsageError(
      `${definition.label} does not support global skill installation; use the current project scope.`,
    );
  }
  const customConfigDir = configDirs[agent];
  if (customConfigDir !== undefined) {
    return join(
      customConfigDir,
      relative(defaultConfigDir(definition), definition.globalSkillsDir),
    );
  }
  if (agent === "openclaw") {
    for (const root of [".openclaw", ".clawdbot", ".moltbot"] as const) {
      if (existsSync(join(homeDir, root))) return join(homeDir, root, "skills");
    }
  }
  return join(homeDir, definition.globalSkillsDir);
}

export function getAgentPaths(
  agent: AgentId,
  homeDir: string,
  cwd: string = process.cwd(),
  configDirs: AgentConfigDirs = {},
): AgentPaths {
  const definition = getAgentDefinition(agent);
  return {
    active: getAgentSkillRoot(
      agent,
      definition.globalSkillsDir === undefined ? "current" : "global",
      homeDir,
      cwd,
      configDirs,
    ),
    parked: join(
      homeDir,
      ".skillpark",
      "skills",
      definition.parkedKey ?? agent,
    ),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function defaultDetectionRoot(definition: AgentDefinition): string | undefined {
  const global = definition.globalSkillsDir;
  if (global === undefined) return undefined;
  return dirname(global);
}

export async function detectAgents(
  homeDir: string,
  cwd: string = process.cwd(),
  configDirs: AgentConfigDirs = {},
): Promise<AgentDetection[]> {
  return Promise.all(
    listAgentDefinitions().map(async (definition) => {
      const customConfigDir = configDirs[definition.id];
      const globalMarkers =
        customConfigDir === undefined
          ? (definition.detection?.global ??
            (defaultDetectionRoot(definition) === undefined
              ? []
              : [defaultDetectionRoot(definition) as string]))
          : [];
      const currentMarkers = definition.detection?.current ?? [];
      const detected = (
        await Promise.all([
          ...(customConfigDir === undefined
            ? []
            : [pathExists(customConfigDir)]),
          ...globalMarkers.map((marker) => pathExists(join(homeDir, marker))),
          ...currentMarkers.map((marker) => pathExists(join(cwd, marker))),
        ])
      ).some(Boolean);
      return {
        id: definition.id,
        label: definition.label,
        detected,
        paths: getAgentPaths(definition.id, homeDir, cwd, configDirs),
      };
    }),
  );
}
