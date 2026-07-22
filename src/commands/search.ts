import type { Command } from "commander";
import { getAgentPaths, parseAgentId } from "../agents/registry.js";
import type { AgentId } from "../domain/agents.js";
import { UsageError } from "../domain/errors.js";
import { gatewayContext } from "../hooks/context.js";
import { GATEWAY_SKILL_ENTRY_NAME } from "../skills/gateway.js";
import {
  DEFAULT_SEARCH_LIMIT,
  searchableSkillFromEntry,
  searchSkills,
  type SkillSearchResult,
} from "../skills/search.js";
import { scanSkillEntries } from "../skills/scan.js";
import type { CommandContext } from "./context.js";

interface SearchOptions {
  limit?: string;
}

export interface AgentSkillSearchResult extends SkillSearchResult {
  agent: AgentId;
}

export async function searchParkedSkills(
  agent: AgentId,
  query: string,
  homeDir: string,
  cwd: string = process.cwd(),
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<AgentSkillSearchResult> {
  const entries = await scanSkillEntries(
    getAgentPaths(agent, homeDir, cwd).parked,
    "parked",
  );
  const catalog = entries
    .filter(
      (entry) =>
        entry.entryName !== GATEWAY_SKILL_ENTRY_NAME &&
        entry.metadata.valid &&
        !entry.broken,
    )
    .map(searchableSkillFromEntry);
  return { agent, ...searchSkills(query, catalog, { limit }) };
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new UsageError("Search limit must be an integer from 1 to 10");
  }
  return parsed;
}

export function registerSearchCommand(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("search <agent> <query...>")
    .description("Search parked-skill metadata for a bounded candidate set")
    .option("--limit <count>", "Maximum hits (1-10)")
    .action(
      async (
        agentArgument: string,
        queryParts: string[],
        options: SearchOptions,
      ) => {
        const query = queryParts.join(" ").trim();
        if (!query) throw new UsageError("Search query cannot be empty");
        const result = await searchParkedSkills(
          parseAgentId(agentArgument),
          query,
          context.homeDir,
          context.cwd,
          parseLimit(options.limit),
        );
        context.output.write(gatewayContext(result.agent, result));
      },
    );
}
