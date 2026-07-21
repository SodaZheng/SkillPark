#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CommanderError } from "commander";
import { createProgram } from "./app/create-program.js";
import { CommandCancelledError, UsageError } from "./domain/errors.js";

function printRuntimeError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  console.error(`error: ${message}${code ? ` (${code})` : ""}`);
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = createProgram().exitOverride();
  if (argv.length === 2) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return 0;
      }
      return 2;
    }
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    if (error instanceof CommandCancelledError) return 0;
    printRuntimeError(error);
    return 1;
  }
}

const entrypoint = process.argv[1];
let invokedAsEntrypoint = false;
if (entrypoint) {
  try {
    invokedAsEntrypoint =
      import.meta.url === pathToFileURL(await realpath(entrypoint)).href;
  } catch {
    // Importing this module must not execute the CLI if argv[1] is unavailable.
  }
}
if (invokedAsEntrypoint) {
  process.exitCode = await main();
}
