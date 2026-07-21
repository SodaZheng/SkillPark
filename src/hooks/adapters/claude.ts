import { gatewayHookCommand } from "../context.js";
import { createGroupedJsonHookAdapter } from "./grouped-json.js";

export const claudeHookAdapter = createGroupedJsonHookAdapter({
  id: "claude",
  event: "UserPromptSubmit",
  globalConfig: ".claude/settings.json",
  projectConfig: ".claude/settings.json",
  handler: (agent) => ({
    type: "command",
    command: gatewayHookCommand(agent),
    timeout: 30,
    statusMessage: "Checking parked skills",
  }),
});
