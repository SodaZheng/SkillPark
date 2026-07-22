import { gatewayHookCommand, gatewayHookWindowsCommand } from "../context.js";
import { createGroupedJsonHookAdapter } from "./grouped-json.js";

export const codexHookAdapter = createGroupedJsonHookAdapter({
  id: "codex",
  event: "UserPromptSubmit",
  globalConfig: ".codex/hooks.json",
  projectConfig: ".codex/hooks.json",
  initialConfiguration: {
    description: "SkillPark read-only parked-skill search",
  },
  handler: (agent) => ({
    type: "command",
    command: gatewayHookCommand(agent),
    commandWindows: gatewayHookWindowsCommand(agent),
    timeout: 30,
    statusMessage: "Checking parked skills",
  }),
  warning: (scope) =>
    scope === "current"
      ? "Codex project hooks require a trusted project; review the hook in /hooks."
      : "Review and trust the SkillPark hook in Codex with /hooks if prompted.",
});
