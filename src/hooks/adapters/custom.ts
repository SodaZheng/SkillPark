import type { AgentId } from "../../domain/agents.js";
import { gatewayHookCommand, gatewayHookWindowsCommand } from "../context.js";
import type { GatewayHookAdapter } from "../types.js";
import { createGroupedJsonHookAdapter } from "./grouped-json.js";

export function createCustomHookAdapter(agent: AgentId): GatewayHookAdapter {
  return createGroupedJsonHookAdapter({
    id: "custom",
    event: "UserPromptSubmit",
    globalConfig: `.${agent}/settings.json`,
    projectConfig: `.${agent}/settings.json`,
    handler: (agentId) => ({
      type: "command",
      command: gatewayHookCommand(agentId),
      commandWindows: gatewayHookWindowsCommand(agentId),
      timeout: 30,
      statusMessage: "Checking parked skills",
    }),
  });
}
