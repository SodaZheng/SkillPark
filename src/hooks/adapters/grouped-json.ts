import { basename, join } from "node:path";
import type {
  AgentId,
  AgentScope,
  HookAdapterId,
} from "../../domain/agents.js";
import {
  gatewayHookCommand,
  renderAdditionalContextOutput,
} from "../context.js";
import type { CommandHandler, GatewayHookAdapter } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasGroupedCommand(value: unknown, agent: AgentId): boolean {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some(
    (handler) =>
      isRecord(handler) && handler.command === gatewayHookCommand(agent),
  );
}

export function createGroupedJsonHookAdapter(options: {
  id: Exclude<HookAdapterId, "copilot">;
  event: string;
  globalConfig: string;
  projectConfig: string;
  handler(agent: AgentId): CommandHandler;
  initialConfiguration?: Record<string, unknown>;
  warning?(scope: AgentScope): string | undefined;
}): GatewayHookAdapter {
  return {
    id: options.id,
    event: options.event,
    ...(options.initialConfiguration === undefined
      ? {}
      : { initialConfiguration: options.initialConfiguration }),
    configPath: ({ cwd, globalConfigDir, homeDir, scope }) =>
      scope === "global"
        ? globalConfigDir === undefined
          ? join(homeDir, options.globalConfig)
          : join(globalConfigDir, basename(options.globalConfig))
        : join(cwd, options.projectConfig),
    merge(configuration, agent) {
      const existingHooks = configuration.hooks;
      if (existingHooks !== undefined && !isRecord(existingHooks)) {
        throw new Error(
          "Cannot install SkillPark hook: `hooks` must be an object",
        );
      }
      const hooks = existingHooks ?? {};
      const existingEvent = hooks[options.event];
      if (existingEvent !== undefined && !Array.isArray(existingEvent)) {
        throw new Error(
          `Cannot install SkillPark hook: \`hooks.${options.event}\` must be an array`,
        );
      }
      const eventGroups = existingEvent ?? [];
      if (eventGroups.some((group) => hasGroupedCommand(group, agent))) {
        return { changed: false, configuration };
      }
      return {
        changed: true,
        configuration: {
          ...configuration,
          hooks: {
            ...hooks,
            [options.event]: [
              ...eventGroups,
              { hooks: [options.handler(agent)] },
            ],
          },
        },
      };
    },
    render: (agent, routing) =>
      renderAdditionalContextOutput(options.event, agent, routing),
    ...(options.warning === undefined ? {} : { warning: options.warning }),
  };
}
