import { basename, join } from "node:path";
import { gatewayContext, gatewayHookCommand } from "../context.js";
import type { GatewayHookAdapter } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const event = "userPromptTransformed";

export const copilotHookAdapter: GatewayHookAdapter = {
  id: "copilot",
  event,
  configPath: ({ cwd, globalConfigDir, homeDir, scope }) =>
    scope === "global"
      ? globalConfigDir === undefined
        ? join(homeDir, ".copilot/settings.json")
        : join(globalConfigDir, basename(".copilot/settings.json"))
      : join(cwd, ".github/copilot/settings.json"),
  merge(configuration, agent) {
    const existingHooks = configuration.hooks;
    if (existingHooks !== undefined && !isRecord(existingHooks)) {
      throw new Error(
        "Cannot install SkillPark hook: `hooks` must be an object",
      );
    }
    const hooks = existingHooks ?? {};
    const existingEvent = hooks[event];
    if (existingEvent !== undefined && !Array.isArray(existingEvent)) {
      throw new Error(
        `Cannot install SkillPark hook: \`hooks.${event}\` must be an array`,
      );
    }
    const handlers = existingEvent ?? [];
    if (
      handlers.some(
        (handler) =>
          isRecord(handler) && handler.command === gatewayHookCommand(agent),
      )
    ) {
      return { changed: false, configuration };
    }
    return {
      changed: true,
      configuration: {
        ...configuration,
        hooks: {
          ...hooks,
          [event]: [
            ...handlers,
            {
              type: "command",
              command: gatewayHookCommand(agent),
              timeoutSec: 30,
            },
          ],
        },
      },
    };
  },
  render(agent, search, input) {
    let transformedPrompt: unknown;
    try {
      transformedPrompt = (JSON.parse(input ?? "") as Record<string, unknown>)
        .transformedPrompt;
    } catch {
      transformedPrompt = undefined;
    }
    if (typeof transformedPrompt !== "string") return "{}";
    return JSON.stringify({
      modifiedTransformedPrompt: `${transformedPrompt}\n\n${gatewayContext(agent, search)}`,
    });
  },
};
