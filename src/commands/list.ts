import type { Command } from "commander";
import { getAgentDefinition, getAgentPaths } from "../agents/registry.js";
import type { AgentConfigDirs, AgentId } from "../domain/agents.js";
import type { SkillEntry } from "../domain/skills.js";
import { scanSkillEntries } from "../skills/scan.js";
import { findNameConflicts } from "../storage/plan.js";
import { CANCELLED } from "../tui/ports.js";
import { renderTable } from "../tui/table.js";
import { selectAgent } from "./agent-selection.js";
import type { CommandContext } from "./context.js";

interface ListOptions {
  parked?: boolean;
  query?: string;
}

export interface AgentStatus {
  agent: AgentId;
  active: SkillEntry[];
  parked: SkillEntry[];
  conflicts: string[];
}

export async function collectAgentStatus(
  agent: AgentId,
  homeDir: string,
  cwd: string = process.cwd(),
  configDirs: AgentConfigDirs = {},
): Promise<AgentStatus> {
  const paths = getAgentPaths(agent, homeDir, cwd, configDirs);
  const [active, parked] = await Promise.all([
    scanSkillEntries(paths.active, "active"),
    scanSkillEntries(paths.parked, "parked"),
  ]);

  return {
    agent,
    active,
    parked,
    conflicts: [...findNameConflicts(active, parked).keys()].sort(),
  };
}

function health(entry: SkillEntry, conflicts: readonly string[]): string {
  const issues = [
    conflicts.includes(entry.entryName) ? "Name conflict" : undefined,
    ...entry.metadata.warnings,
  ].filter((issue): issue is string => issue !== undefined);
  return issues.length === 0 ? "Ready" : issues.join(" · ");
}

function renderEntries(
  entries: readonly { state: "Active" | "Parked"; entry: SkillEntry }[],
  conflicts: readonly string[],
): string {
  return renderTable(
    [
      { header: "State" },
      { header: "Entry", maxWidth: 32 },
      { header: "Skill name", maxWidth: 32 },
      { header: "Description", maxWidth: 64 },
      { header: "Health", maxWidth: 52 },
    ],
    entries.map(({ state, entry }) => [
      state,
      entry.entryName,
      entry.metadata.name,
      entry.metadata.description,
      health(entry, conflicts),
    ]),
  );
}

function visibleConflicts(status: AgentStatus): string[] {
  const visibleNames = new Set(
    [...status.active, ...status.parked].map((entry) => entry.entryName),
  );
  return status.conflicts.filter((name) => visibleNames.has(name));
}

function renderStatus(status: AgentStatus): string {
  const label = getAgentDefinition(status.agent).label;
  const conflicts = visibleConflicts(status);
  const summary = [
    `Active (${status.active.length})`,
    `Parked (${status.parked.length})`,
    ...(conflicts.length > 0 ? [`Conflicts (${conflicts.length})`] : []),
  ].join(" · ");
  const entries = [
    ...status.active.map((entry) => ({ state: "Active" as const, entry })),
    ...status.parked.map((entry) => ({ state: "Parked" as const, entry })),
  ];
  return entries.length === 0
    ? `${label}\n${summary}\nNo skills found.`
    : `${label}\n${summary}\n${renderEntries(entries, conflicts)}`;
}

function matchesQuery(entry: SkillEntry, query: string | undefined): boolean {
  const normalized = query?.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const searchable = [
    entry.entryName,
    entry.metadata.name,
    entry.metadata.description,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return normalized
    .split(/\s+/u)
    .filter(Boolean)
    .every((term) => searchable.includes(term));
}

function filterStatus(status: AgentStatus, options: ListOptions): AgentStatus {
  return {
    ...status,
    active: options.parked
      ? []
      : status.active.filter((entry) => matchesQuery(entry, options.query)),
    parked: status.parked.filter((entry) => matchesQuery(entry, options.query)),
  };
}

function renderParkedOnly(status: AgentStatus): string {
  const label = getAgentDefinition(status.agent).label;
  const conflicts = visibleConflicts(status);
  const summary = [
    `Parked (${status.parked.length})`,
    ...(conflicts.length > 0 ? [`Conflicts (${conflicts.length})`] : []),
  ].join(" · ");
  if (status.parked.length === 0) {
    return `${label}\n${summary}\nNo parked skills found.`;
  }
  return `${label}\n${summary}\n${renderEntries(
    status.parked.map((entry) => ({ state: "Parked", entry })),
    conflicts,
  )}`;
}

export function registerListCommand(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("list [agent]")
    .description("List active and parked skills")
    .option("--parked", "Show only parked skills")
    .option("-q, --query <query>", "Filter skills")
    .action(async (agent: string | undefined, options: ListOptions) => {
      const selectedAgent = await selectAgent(agent, context, {
        message: "Select an agent whose skills you want to list",
      });
      if (selectedAgent === CANCELLED) return;
      const agents: AgentId[] = [selectedAgent];
      const statuses = (
        await Promise.all(
          agents.map((id) =>
            collectAgentStatus(
              id,
              context.homeDir,
              context.cwd,
              context.agentConfigDirs,
            ),
          ),
        )
      ).map((status) => filterStatus(status, options));
      context.output.write(
        statuses
          .map(options.parked ? renderParkedOnly : renderStatus)
          .join("\n\n"),
      );
    });
}
