import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { getAgentPaths } from "../agents/registry.js";
import type { AgentId } from "../domain/agents.js";
import { UsageError } from "../domain/errors.js";
import { scanSkillEntries } from "../skills/scan.js";
import { validateEntryName } from "../sources/entry-name.js";
import { CANCELLED } from "../tui/ports.js";
import { selectAgent } from "./agent-selection.js";
import type { CommandContext } from "./context.js";

export async function getParkedSkill(
  agent: AgentId,
  entryName: string,
  homeDir: string,
  cwd: string = process.cwd(),
): Promise<{ root: string; instructionFile: string; instructions: string }> {
  const normalizedEntryName = validateEntryName(
    entryName.startsWith("/") ? entryName.slice(1) : entryName,
    "parked skill name",
  );
  const paths = getAgentPaths(agent, homeDir, cwd);
  const entries = await scanSkillEntries(paths.parked, "parked");
  const entry = entries.find(
    (candidate) => candidate.entryName === normalizedEntryName,
  );
  if (!entry) {
    throw new UsageError(
      `Parked skill not found for ${agent}: ${normalizedEntryName}. Use \`skillpark list ${agent} --parked\` to list valid entry names.`,
    );
  }
  if (entry.broken) {
    throw new Error(`Parked skill link target is missing: ${entry.path}`);
  }
  const instructionFile = join(entry.path, "SKILL.md");
  let instructions: string;
  try {
    instructions = await readFile(instructionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Parked skill has no SKILL.md: ${entry.path}`);
    }
    throw error;
  }
  return { root: entry.path, instructionFile, instructions };
}

export function registerGetCommand(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("get [agent] [skill]")
    .description("Read a parked skill")
    .addHelpText(
      "after",
      `
With one argument, it is the skill name and Agent is prompted.`,
    )
    .action(
      async (
        agentOrSkill: string | undefined,
        skillArgument: string | undefined,
      ) => {
        const agentArgument =
          skillArgument === undefined ? undefined : agentOrSkill;
        const entryName = skillArgument ?? agentOrSkill;
        if (entryName === undefined) {
          throw new UsageError(
            "Missing skill name. Usage: skillpark get [agent] <skill>",
          );
        }
        const agent = await selectAgent(agentArgument, context, {
          message: `Select the agent that owns ${entryName}`,
        });
        if (agent === CANCELLED) return;
        const result = await getParkedSkill(
          agent,
          entryName,
          context.homeDir,
          context.cwd,
        );
        context.output.write(
          `Skill root: ${result.root}\nInstruction file: ${result.instructionFile}\n\n${result.instructions}`,
        );
      },
    );
}
