import type { AgentId, AgentScope, HookAdapterId } from "../domain/agents.js";
import type { SkillRouteResult } from "../skills/router.js";

export interface HookMergeResult {
  changed: boolean;
  configuration: Record<string, unknown>;
}

export interface HookLocationContext {
  cwd: string;
  homeDir: string;
  scope: AgentScope;
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
  render(agent: AgentId, routing: SkillRouteResult, input?: string): string;
  warning?(scope: AgentScope): string | undefined;
}

export interface CommandHandler {
  type: "command";
  command: string;
  [key: string]: unknown;
}
