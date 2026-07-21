import type { Command } from "commander";
import { getAgentPaths, parseAgentId } from "../agents/registry.js";
import type { AgentId } from "../domain/agents.js";
import { UsageError } from "../domain/errors.js";
import { gatewayContext } from "../hooks/context.js";
import { GATEWAY_SKILL_ENTRY_NAME } from "../skills/gateway.js";
import {
  DEFAULT_ROUTE_LIMIT,
  routableSkillFromEntry,
  routeSkills,
  type SkillRouteResult,
} from "../skills/router.js";
import { scanSkillEntries } from "../skills/scan.js";
import type { CommandContext } from "./context.js";

interface RouteOptions {
  limit?: string;
}

export interface AgentSkillRouteResult extends SkillRouteResult {
  agent: AgentId;
}

export async function routeParkedSkills(
  agent: AgentId,
  prompt: string,
  homeDir: string,
  cwd: string = process.cwd(),
  limit: number = DEFAULT_ROUTE_LIMIT,
): Promise<AgentSkillRouteResult> {
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
    .map(routableSkillFromEntry);
  return { agent, ...routeSkills(prompt, catalog, { limit }) };
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_ROUTE_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new UsageError("Route limit must be an integer from 1 to 10");
  }
  return parsed;
}

export function registerRouteCommand(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("route <agent> <query...>")
    .description("Route a request to a small parked-skill candidate set")
    .option("--limit <count>", "Maximum candidates (1-10)")
    .action(
      async (
        agentArgument: string,
        queryParts: string[],
        options: RouteOptions,
      ) => {
        const prompt = queryParts.join(" ").trim();
        if (!prompt) throw new UsageError("Routing query cannot be empty");
        const result = await routeParkedSkills(
          parseAgentId(agentArgument),
          prompt,
          context.homeDir,
          context.cwd,
          parseLimit(options.limit),
        );
        context.output.write(gatewayContext(result.agent, result));
      },
    );
}
