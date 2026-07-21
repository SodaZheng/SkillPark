import { Command } from "commander";
import { registerAddCommand } from "../commands/add.js";
import { registerAgentsCommand } from "../commands/agents.js";
import {
  createCommandContext,
  type CommandContext,
} from "../commands/context.js";
import { registerListCommand } from "../commands/list.js";
import { registerInstallCommand } from "../commands/install.js";
import { registerGetCommand } from "../commands/get.js";
import { registerHookCommand } from "../commands/hook.js";
import { registerRestoreCommand } from "../commands/restore.js";
import { registerRouteCommand } from "../commands/route.js";
import { registerStoreCommand } from "../commands/store.js";

export function createProgram(
  context: CommandContext = createCommandContext(),
): Command {
  const program = new Command()
    .name("skillpark")
    .description("Park and load agent skills on demand.")
    .version("0.1.0")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Examples:
  $ skillpark store
  $ skillpark add ./skills
  $ skillpark install
  $ skillpark route codex "create an Excel workbook"
  $ skillpark get /documents
  $ skillpark list`,
    );
  registerStoreCommand(program, context);
  registerRestoreCommand(program, context);
  registerListCommand(program, context);
  registerAddCommand(program, context);
  registerAgentsCommand(program, context);
  registerInstallCommand(program, context);
  registerGetCommand(program, context);
  registerRouteCommand(program, context);
  registerHookCommand(program, context);
  return program;
}
