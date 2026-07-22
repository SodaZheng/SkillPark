import type { AgentId } from "../domain/agents.js";
import type { SkillSearchResult } from "../skills/search.js";
import {
  GATEWAY_HOOK_MAX_DESCRIPTION_BYTES,
  gatewayHookCommand,
  gatewayHookWindowsCommand,
} from "./context.js";
import { getGatewayHookAdapter, listGatewayHookAgents } from "./registry.js";
import type { GatewayHookAdapter, HookMergeResult } from "./types.js";

export type { GatewayHookAdapter };
export {
  GATEWAY_HOOK_MAX_DESCRIPTION_BYTES,
  gatewayHookCommand,
  gatewayHookWindowsCommand,
  getGatewayHookAdapter,
  listGatewayHookAgents,
};

export function mergeGatewayHookConfiguration(
  configuration: Record<string, unknown>,
  agent: AgentId,
): HookMergeResult {
  const adapter = getGatewayHookAdapter(agent);
  if (adapter === undefined) {
    throw new Error(`Agent does not support a SkillPark search hook: ${agent}`);
  }
  return adapter.merge(configuration, agent);
}

export function renderGatewayHookOutput(
  agent: AgentId,
  search: SkillSearchResult,
  input?: string,
): string {
  const adapter = getGatewayHookAdapter(agent);
  if (adapter === undefined) {
    throw new Error(`Agent does not support a SkillPark search hook: ${agent}`);
  }
  return adapter.render(agent, search, input);
}
