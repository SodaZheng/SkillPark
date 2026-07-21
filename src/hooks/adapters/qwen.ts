import { gatewayHookCommand } from "../context.js";
import { createGroupedJsonHookAdapter } from "./grouped-json.js";

export const qwenHookAdapter = createGroupedJsonHookAdapter({
  id: "qwen",
  event: "UserPromptSubmit",
  globalConfig: ".qwen/settings.json",
  projectConfig: ".qwen/settings.json",
  handler: (agent) => ({
    type: "command",
    command: gatewayHookCommand(agent),
    name: "skillpark-router",
    description: "Inject parked SkillPark metadata before each prompt",
    timeout: 30_000,
    statusMessage: "Checking parked skills",
  }),
});
