import type { AgentId, AgentScope, HookAdapterId } from "../domain/agents.js";
import type { SkillSearchResult } from "../skills/search.js";

export interface HookMergeResult {
  changed: boolean;
  configuration: Record<string, unknown>;
}

export interface HookLocationContext {
  cwd: string;
  homeDir: string;
  scope: AgentScope;
  globalConfigDir?: string;
}

export interface GatewayHookAdapter {
  id: HookAdapterId;
  event: string;
  initialConfiguration?: Record<string, unknown>;
  configPath(context: HookLocationContext): string;
  merge(
    configuration: Record<string, unknown>,
    agent: AgentId,
  ): HookMergeResult;
  render(agent: AgentId, search: SkillSearchResult, input?: string): string;
  warning?(scope: AgentScope): string | undefined;
}

export interface CommandHandler {
  type: "command";
  command: string;
  [key: string]: unknown;
}
