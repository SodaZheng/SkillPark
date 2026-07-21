import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { detectAgents, getAgentPaths } from "../agents/registry.js";
import type { AgentId } from "../domain/agents.js";
import type { SkillEntry } from "../domain/skills.js";
import { discoverSourceSkills } from "../sources/discover.js";
import { parseSource } from "../sources/parse.js";
import { stageSource } from "../sources/stage.js";
import type { StagedSource } from "../sources/types.js";
import {
  executeTransaction,
  type ItemExecutor,
} from "../storage/execute-transaction.js";
import { preflightTransaction } from "../storage/node-item-executor.js";
import type { TransactionItem, TransactionPlan } from "../storage/types.js";
import type { ProgressPort } from "../tui/ports.js";
import { CANCELLED } from "../tui/ports.js";
import type { CommandContext } from "./context.js";
import {
  assertSafeAgentRoots,
  assertSafeSelectedAgentRoots,
  containsPath,
  createAgentRootGuardedExecutor,
  prospectivePhysicalPath,
} from "./path-safety.js";
import { recoverPendingTransactions } from "./recovery.js";

async function pathOccupied(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function addNameConflict(path: string): Error {
  return new Error(
    `Selection contains a skill with an active or parked name conflict: ${path}`,
  );
}

async function assertAddItemTargetsAvailable(
  homeDir: string,
  cwd: string,
  item: TransactionItem,
): Promise<void> {
  const paths = getAgentPaths(item.agent, homeDir, cwd);
  const active = join(paths.active, item.entryName);
  if (await pathOccupied(active)) throw addNameConflict(active);
  const parked = join(paths.parked, item.entryName);
  if (await pathOccupied(parked)) {
    throw new Error(`Destination exists: ${parked}`);
  }
}

async function assertAddPlanTargetsAvailable(
  homeDir: string,
  cwd: string,
  plan: TransactionPlan,
): Promise<void> {
  for (const item of plan.items) {
    await assertAddItemTargetsAvailable(homeDir, cwd, item);
  }
}

function createAddGuardedExecutor(
  homeDir: string,
  cwd: string,
  executor: ItemExecutor,
): ItemExecutor {
  const rootGuarded = createAgentRootGuardedExecutor(homeDir, executor, cwd);
  return {
    async apply(item) {
      await assertSafeAgentRoots(homeDir, item.agent, cwd);
      await assertAddItemTargetsAvailable(homeDir, cwd, item);
      await rootGuarded.apply(item);
    },
    revert: (item) => rootGuarded.revert(item),
  };
}

async function localSourceContainsTempRoot(
  source: string,
  tempRoot: string,
): Promise<boolean> {
  if (containsPath(source, tempRoot)) return true;
  const [physicalSource, physicalTempRoot] = await Promise.all([
    realpath(source),
    prospectivePhysicalPath(tempRoot),
  ]);
  return containsPath(physicalSource, physicalTempRoot);
}

type ErrorWithCleanup = Error & { cleanupErrors?: unknown[] };

interface AddLifecycle {
  retainStage: boolean;
}

function attachCleanupError(primary: unknown, cleanup: unknown): void {
  if (!(primary instanceof Error)) return;
  try {
    const error = primary as ErrorWithCleanup;
    if (error.cleanupErrors === undefined) {
      Object.defineProperty(error, "cleanupErrors", {
        configurable: true,
        enumerable: false,
        value: [],
        writable: true,
      });
    }
    error.cleanupErrors?.push(cleanup);
  } catch {
    // A frozen primary error still takes precedence over cleanup diagnostics.
  }
}

async function executeStagedAdd(
  staged: StagedSource,
  context: CommandContext,
  lifecycle: AddLifecycle,
  preparationProgress?: ProgressPort,
): Promise<string | undefined> {
  let agents: Awaited<ReturnType<typeof detectAgents>>;
  let skills: Awaited<ReturnType<typeof discoverSourceSkills>>;
  try {
    [agents, skills] = await Promise.all([
      detectAgents(context.homeDir, context.cwd),
      discoverSourceSkills(staged.root, staged.rootEntryName),
    ]);
  } catch (error) {
    preparationProgress?.error("Source scan failed");
    throw error;
  }
  if (skills.length === 0) {
    preparationProgress?.error("No valid skills found");
    throw new Error("No valid skills found in source");
  }
  preparationProgress?.advance(
    1,
    `Found ${skills.length} skill${skills.length === 1 ? "" : "s"}`,
  );
  preparationProgress?.stop("Source ready");

  const selectedAgents = await context.prompts.selectMany(
    "Select target agents",
    agents.map((agent) => ({
      value: agent.id,
      label: agent.label,
      hint: `${agent.detected ? "detected" : "not detected"} → ${agent.paths.parked}`,
    })),
  );
  if (selectedAgents === CANCELLED || selectedAgents.length === 0) return;
  const offeredAgents = new Map(agents.map((agent) => [agent.id, agent]));
  const agentIds: AgentId[] = [];
  const seenAgents = new Set<AgentId>();
  for (const selectedAgent of selectedAgents) {
    const offered = offeredAgents.get(selectedAgent as AgentId);
    if (offered === undefined) {
      throw new Error(`Unknown selected agent: ${selectedAgent}`);
    }
    if (!seenAgents.has(offered.id)) {
      seenAgents.add(offered.id);
      agentIds.push(offered.id);
    }
  }
  await assertSafeSelectedAgentRoots(context.homeDir, agentIds, context.cwd);

  const choices = await Promise.all(
    skills.map(async (skill) => {
      const occupied: string[] = [];
      for (const agent of agentIds) {
        const paths = getAgentPaths(agent, context.homeDir, context.cwd);
        if (await pathOccupied(join(paths.active, skill.entryName))) {
          occupied.push(`${agent}: active`);
        }
        if (await pathOccupied(join(paths.parked, skill.entryName))) {
          occupied.push(`${agent}: parked`);
        }
      }
      return {
        value: skill.entryName,
        label: skill.metadata.name,
        hint:
          occupied.length > 0
            ? `conflict in ${occupied.join(", ")}`
            : skill.metadata.description,
        disabled: occupied.length > 0,
      };
    }),
  );
  const selectedSkills = await context.prompts.selectMany(
    "Select skills to install",
    choices,
  );
  if (selectedSkills === CANCELLED || selectedSkills.length === 0) return;

  const offeredSkills = new Map(
    skills.map((skill) => [skill.entryName, skill]),
  );
  const chosen: SkillEntry[] = [];
  const selectedEntryNames: string[] = [];
  const seenSkills = new Set<string>();
  for (const selectedSkill of selectedSkills) {
    const offered = offeredSkills.get(selectedSkill);
    if (offered === undefined) {
      throw new Error(`Unknown selected skill: ${selectedSkill}`);
    }
    if (!seenSkills.has(offered.entryName)) {
      seenSkills.add(offered.entryName);
      selectedEntryNames.push(offered.entryName);
      chosen.push(offered);
    }
  }

  const blocked = new Set(
    choices.filter((choice) => choice.disabled).map((choice) => choice.value),
  );
  if (selectedEntryNames.some((entryName) => blocked.has(entryName))) {
    throw new Error(
      "Selection contains a skill with an active or parked name conflict",
    );
  }

  const plan: TransactionPlan = {
    id: randomUUID(),
    action: "add",
    createdAt: new Date().toISOString(),
    sourceStage: staged.sourceStage,
    items: agentIds.flatMap((agent) =>
      chosen.map((skill) => ({
        id: randomUUID(),
        agent,
        entryName: skill.entryName,
        entryKind: skill.kind,
        operation: "copy" as const,
        source: skill.path,
        destination: join(
          getAgentPaths(agent, context.homeDir, context.cwd).parked,
          skill.entryName,
        ),
      })),
    ),
  };

  await assertSafeSelectedAgentRoots(context.homeDir, agentIds, context.cwd);
  await assertAddPlanTargetsAvailable(context.homeDir, context.cwd, plan);
  await preflightTransaction(plan);
  context.output.info(
    plan.items.map((item) => `${item.destination} ← ${item.source}`).join("\n"),
  );
  const confirmed = await context.prompts.confirm(
    `Install ${chosen.length} skill${chosen.length === 1 ? "" : "s"} into SkillPark for ${agentIds.length} agent${agentIds.length === 1 ? "" : "s"}?`,
  );
  if (confirmed !== true) return;
  await assertSafeSelectedAgentRoots(context.homeDir, agentIds, context.cwd);
  await assertAddPlanTargetsAvailable(context.homeDir, context.cwd, plan);

  const installationProgress = context.output.progress?.(plan.items.length);
  installationProgress?.start(
    `Installing ${plan.items.length} parked skill cop${plan.items.length === 1 ? "y" : "ies"}`,
  );
  const guardedExecutor = createAddGuardedExecutor(
    context.homeDir,
    context.cwd,
    context.executor,
  );
  const reportingExecutor: ItemExecutor = {
    async apply(item) {
      installationProgress?.message(
        `Installing ${item.entryName} for ${item.agent}`,
      );
      await guardedExecutor.apply(item);
      installationProgress?.advance(
        1,
        `Installed ${item.entryName} for ${item.agent}`,
      );
    },
    revert: (item) => guardedExecutor.revert(item),
  };

  try {
    await executeTransaction(plan, reportingExecutor, context.journals);
  } catch (primary) {
    installationProgress?.error("Installation failed");
    try {
      lifecycle.retainStage = (await context.journals.list()).some(
        (record) => record.id === plan.id,
      );
    } catch (inspectionError) {
      lifecycle.retainStage = true;
      attachCleanupError(primary, inspectionError);
    }
    throw primary;
  }
  installationProgress?.stop("Installation complete");
  return `Installed ${plan.items.length} parked skill cop${plan.items.length === 1 ? "y" : "ies"}.`;
}

export async function runAdd(
  sourceArgument: string,
  context: CommandContext,
): Promise<void> {
  const source = parseSource(sourceArgument, context.cwd);
  await recoverPendingTransactions(context);
  const tempRoot = join(context.homeDir, ".skillpark", ".tmp");
  if (
    source.kind === "local" &&
    (await localSourceContainsTempRoot(source.path, tempRoot))
  ) {
    throw new Error(
      `Local source contains the staging temp root: ${source.path}`,
    );
  }
  const preparationProgress = context.output.progress?.(2);
  preparationProgress?.start(
    source.kind === "git" ? "Cloning source" : "Copying local source",
  );
  let staged: StagedSource;
  try {
    staged = await stageSource(source, tempRoot, context.processRunner);
  } catch (error) {
    preparationProgress?.error("Source preparation failed");
    throw error;
  }
  preparationProgress?.advance(1, "Scanning for skills");
  const lifecycle: AddLifecycle = { retainStage: false };

  let failed = false;
  let primary: unknown;
  let successMessage: string | undefined;
  try {
    successMessage = await executeStagedAdd(
      staged,
      context,
      lifecycle,
      preparationProgress,
    );
  } catch (error) {
    failed = true;
    primary = error;
  }

  if (!lifecycle.retainStage) {
    try {
      await staged.cleanup();
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
      attachCleanupError(primary, cleanupError);
    }
  }

  if (failed) throw primary;
  if (successMessage !== undefined) {
    context.output.success(successMessage);
  }
}

export function registerAddCommand(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("add <source>")
    .description("Add skills to SkillPark")
    .action(async (source: string) => runAdd(source, context));
}
