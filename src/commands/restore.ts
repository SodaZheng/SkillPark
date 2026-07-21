import type { Command } from "commander";
import { CANCELLED } from "../tui/ports.js";
import { selectAgent } from "./agent-selection.js";
import type { CommandContext } from "./context.js";
import { runMoveSkills } from "./move-skills.js";

export function registerRestoreCommand(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("restore [agent]")
    .description("Restore parked skills")
    .action(async (agentArgument: string | undefined) => {
      const agent = await selectAgent(agentArgument, context, {
        message: "Select an agent whose skills you want to restore",
      });
      if (agent === CANCELLED) return;
      await runMoveSkills("restore", agent, context);
    });
}
