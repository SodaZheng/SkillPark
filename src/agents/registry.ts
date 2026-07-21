import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AGENT_IDS,
  type AgentDefinition,
  type AgentDetection,
  type AgentId,
  type AgentPaths,
  type AgentScope,
} from "../domain/agents.js";
import { UsageError } from "../domain/errors.js";

type DefinitionInput = Omit<AgentDefinition, "aliases" | "id"> & {
  aliases?: readonly string[];
};

function defineAgents(
  inputs: Record<AgentId, DefinitionInput>,
): Record<AgentId, AgentDefinition> {
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
  ) as unknown as Record<AgentId, AgentDefinition>;
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
  return definitions[agent];
}

export function listAgentDefinitions(): readonly AgentDefinition[] {
  return AGENT_IDS.map((id) => definitions[id]);
}

export function parseAgentId(value: string): AgentId {
  const normalized = value.trim().toLowerCase();
  for (const definition of listAgentDefinitions()) {
    if (definition.aliases.includes(normalized)) return definition.id;
  }
  throw new UsageError(`Unsupported agent: ${value}`);
}

export function supportsGlobalSkills(agent: AgentId): boolean {
  return definitions[agent].globalSkillsDir !== undefined;
}

export function getAgentSkillRoot(
  agent: AgentId,
  scope: AgentScope,
  homeDir: string,
  cwd: string,
): string {
  const definition = definitions[agent];
  if (scope === "current") return join(cwd, definition.projectSkillsDir);
  if (definition.globalSkillsDir === undefined) {
    throw new UsageError(
      `${definition.label} does not support global skill installation; use the current project scope.`,
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
): AgentPaths {
  const definition = definitions[agent];
  return {
    active: getAgentSkillRoot(
      agent,
      definition.globalSkillsDir === undefined ? "current" : "global",
      homeDir,
      cwd,
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
): Promise<AgentDetection[]> {
  return Promise.all(
    listAgentDefinitions().map(async (definition) => {
      const globalMarkers =
        definition.detection?.global ??
        (defaultDetectionRoot(definition) === undefined
          ? []
          : [defaultDetectionRoot(definition) as string]);
      const currentMarkers = definition.detection?.current ?? [];
      const detected = (
        await Promise.all([
          ...globalMarkers.map((marker) => pathExists(join(homeDir, marker))),
          ...currentMarkers.map((marker) => pathExists(join(cwd, marker))),
        ])
      ).some(Boolean);
      return {
        id: definition.id,
        label: definition.label,
        detected,
        paths: getAgentPaths(definition.id, homeDir, cwd),
      };
    }),
  );
}
