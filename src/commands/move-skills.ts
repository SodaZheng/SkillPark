import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentPaths, parseAgentId } from "../agents/registry.js";
import { scanSkillEntries } from "../skills/scan.js";
import { executeTransaction } from "../storage/execute-transaction.js";
import { preflightTransaction } from "../storage/node-item-executor.js";
import { buildMovePlan, findNameConflicts } from "../storage/plan.js";
import { CANCELLED } from "../tui/ports.js";
import type { CommandContext } from "./context.js";
import {
  assertSafeAgentRoots,
  createAgentRootGuardedExecutor,
} from "./path-safety.js";
import { recoverPendingTransactions } from "./recovery.js";

async function isOccupied(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function runMoveSkills(
  action: "store" | "restore",
  agentArgument: string,
  context: CommandContext,
): Promise<void> {
  const agent = parseAgentId(agentArgument);
  await recoverPendingTransactions(context);
  await assertSafeAgentRoots(
    context.homeDir,
    agent,
    context.cwd,
    context.agentConfigDirs,
  );
  const paths = getAgentPaths(
    agent,
    context.homeDir,
    context.cwd,
    context.agentConfigDirs,
  );
  const [active, parked] = await Promise.all([
    scanSkillEntries(paths.active, "active"),
    scanSkillEntries(paths.parked, "parked"),
  ]);
  const source = action === "store" ? active : parked;
  if (source.length === 0) {
    const scannedPath = action === "store" ? paths.active : paths.parked;
    context.output.info(
      `No skills available to ${action}. Scanned: ${scannedPath}`,
    );
    return;
  }

  const unavailable = findNameConflicts(active, parked);
  const destinationRoot = action === "store" ? paths.parked : paths.active;
  await Promise.all(
    source.map(async (entry) => {
      const destination = join(destinationRoot, entry.entryName);
      if (
        (await isOccupied(destination)) &&
        !unavailable.has(entry.entryName)
      ) {
        unavailable.set(entry.entryName, `Destination exists: ${destination}`);
      }
    }),
  );
  const selectedNames = await context.prompts.selectMany(
    action === "store"
      ? `Select ${agentArgument} skills to park`
      : `Select ${agentArgument} skills to restore`,
    source.map((entry) => ({
      value: entry.entryName,
      label: entry.metadata.name,
      hint:
        unavailable.get(entry.entryName) ??
        [entry.metadata.description, ...entry.metadata.warnings]
          .filter(Boolean)
          .join(" · "),
      disabled: unavailable.has(entry.entryName),
    })),
  );
  if (selectedNames === CANCELLED || selectedNames.length === 0) return;

  const selected = source.filter(
    (entry) =>
      selectedNames.includes(entry.entryName) &&
      !unavailable.has(entry.entryName),
  );
  if (selected.length === 0) return;
  const plan = buildMovePlan({ action, agent, selected, paths });
  await assertSafeAgentRoots(
    context.homeDir,
    agent,
    context.cwd,
    context.agentConfigDirs,
  );
  await preflightTransaction(plan);
  context.output.info(
    plan.items.map((item) => `${item.source} → ${item.destination}`).join("\n"),
  );
  const confirmed = await context.prompts.confirm(
    `${action === "store" ? "Park" : "Restore"} ${plan.items.length} skill${plan.items.length === 1 ? "" : "s"}?`,
  );
  if (confirmed !== true) return;

  await assertSafeAgentRoots(
    context.homeDir,
    agent,
    context.cwd,
    context.agentConfigDirs,
  );
  await preflightTransaction(plan);
  await executeTransaction(
    plan,
    createAgentRootGuardedExecutor(
      context.homeDir,
      context.executor,
      context.cwd,
      context.agentConfigDirs,
    ),
    context.journals,
  );
  const verb = action === "store" ? "Parked" : "Restored";
  context.output.success(
    `${verb} ${plan.items.length} · unchanged ${source.length - plan.items.length} · failed 0`,
  );
}
