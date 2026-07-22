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
import { registerSearchCommand } from "../commands/search.js";
import { registerStoreCommand } from "../commands/store.js";
import pkg from "../../package.json" with { type: "json" };

export function createProgram(
  context: CommandContext = createCommandContext(),
): Command {
  const program = new Command()
    .name("skillpark")
    .description("Park and load agent skills on demand.")
    .version(pkg.version)
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Examples:
  $ skillpark store
  $ skillpark add ./skills
  $ skillpark install
  $ skillpark search codex "spreadsheet Excel workbook 电子表格 工作簿"
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
  registerSearchCommand(program, context);
  registerHookCommand(program, context);
  return program;
}
