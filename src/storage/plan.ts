import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentId, AgentPaths } from "../domain/agents.js";
import type { SkillEntry } from "../domain/skills.js";
import type { TransactionPlan } from "./types.js";

export interface BuildMovePlanInput {
  action: "store" | "restore";
  agent: AgentId;
  selected: SkillEntry[];
  paths: AgentPaths;
}

export function buildMovePlan(input: BuildMovePlanInput): TransactionPlan {
  const sourceRoot =
    input.action === "store" ? input.paths.active : input.paths.parked;
  const destinationRoot =
    input.action === "store" ? input.paths.parked : input.paths.active;

  return {
    id: randomUUID(),
    action: input.action,
    createdAt: new Date().toISOString(),
    items: input.selected.map((entry) => ({
      id: randomUUID(),
      agent: input.agent,
      entryName: entry.entryName,
      entryKind: entry.kind,
      operation: "move",
      source: join(sourceRoot, entry.entryName),
      destination: join(destinationRoot, entry.entryName),
    })),
  };
}

export function findNameConflicts(
  active: SkillEntry[],
  parked: SkillEntry[],
): Map<string, string> {
  const activeByName = new Map(
    active.map((entry) => [entry.entryName, entry.path]),
  );
  const conflicts = new Map<string, string>();

  for (const entry of parked) {
    const activePath = activeByName.get(entry.entryName);
    if (activePath) {
      conflicts.set(
        entry.entryName,
        `${activePath} conflicts with ${entry.path}`,
      );
    }
  }

  return conflicts;
}
