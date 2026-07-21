export const AGENT_IDS = [
  "aider-desk",
  "amp",
  "antigravity",
  "antigravity-cli",
  "astrbot",
  "autohand-code",
  "augment",
  "bob",
  "claude",
  "openclaw",
  "cline",
  "codearts-agent",
  "codebuddy",
  "codemaker",
  "codestudio",
  "codex",
  "command-code",
  "continue",
  "cortex",
  "crush",
  "cursor",
  "deepagents",
  "devin",
  "dexto",
  "droid",
  "eve",
  "firebender",
  "forgecode",
  "gemini-cli",
  "github-copilot",
  "goose",
  "hermes-agent",
  "inference-sh",
  "jazz",
  "junie",
  "iflow-cli",
  "kilo",
  "kimi-code-cli",
  "kiro-cli",
  "kode",
  "lingma",
  "loaf",
  "mcpjam",
  "mistral-vibe",
  "moxby",
  "mux",
  "opencode",
  "openhands",
  "ona",
  "pi",
  "qoder",
  "qoder-cn",
  "qwen-code",
  "replit",
  "reasonix",
  "rovodev",
  "roo",
  "tabnine-cli",
  "terramind",
  "tinycloud",
  "trae",
  "trae-cn",
  "warp",
  "windsurf",
  "zed",
  "zcode",
  "zencoder",
  "zenflow",
  "neovate",
  "pochi",
  "promptscript",
  "adal",
  "universal",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];
export type AgentScope = "global" | "current";
export type HookAdapterId = "claude" | "codex" | "gemini" | "copilot" | "qwen";
export type AgentConfigDirs = Partial<Record<AgentId, string>>;

export interface AgentPaths {
  active: string;
  parked: string;
}

export interface AgentDetection {
  id: AgentId;
  label: string;
  detected: boolean;
  paths: AgentPaths;
}

export interface AgentDefinition {
  id: AgentId;
  label: string;
  aliases: readonly string[];
  projectSkillsDir: string;
  globalSkillsDir?: string;
  detection?: {
    global?: readonly string[];
    current?: readonly string[];
  };
  hook?: HookAdapterId;
  parkedKey?: string;
}
