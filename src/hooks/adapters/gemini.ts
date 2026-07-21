import { gatewayHookCommand } from "../context.js";
import { createGroupedJsonHookAdapter } from "./grouped-json.js";

export const geminiHookAdapter = createGroupedJsonHookAdapter({
  id: "gemini",
  event: "BeforeAgent",
  globalConfig: ".gemini/settings.json",
  projectConfig: ".gemini/settings.json",
  handler: (agent) => ({
    type: "command",
    command: gatewayHookCommand(agent),
    name: "skillpark-router",
    description: "Inject parked SkillPark metadata before each agent turn",
    timeout: 30_000,
  }),
});
