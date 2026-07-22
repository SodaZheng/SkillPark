import {
  getAgentDefinition,
  listAgentDefinitions,
} from "../agents/registry.js";
import type { AgentId, HookAdapterId } from "../domain/agents.js";
import { claudeHookAdapter } from "./adapters/claude.js";
import { codexHookAdapter } from "./adapters/codex.js";
import { copilotHookAdapter } from "./adapters/copilot.js";
import { createCustomHookAdapter } from "./adapters/custom.js";
import { geminiHookAdapter } from "./adapters/gemini.js";
import { qwenHookAdapter } from "./adapters/qwen.js";
import type { GatewayHookAdapter } from "./types.js";

const adapters: Record<Exclude<HookAdapterId, "custom">, GatewayHookAdapter> = {
  claude: claudeHookAdapter,
  codex: codexHookAdapter,
  copilot: copilotHookAdapter,
  gemini: geminiHookAdapter,
  qwen: qwenHookAdapter,
};

export function getGatewayHookAdapter(
  agent: AgentId,
): GatewayHookAdapter | undefined {
  const adapter = getAgentDefinition(agent).hook;
  if (adapter === undefined) return undefined;
  return adapter === "custom"
    ? createCustomHookAdapter(agent)
    : adapters[adapter];
}

export function listGatewayHookAgents(): AgentId[] {
  return listAgentDefinitions()
    .filter((definition) => definition.hook !== undefined)
    .map((definition) => definition.id);
}
