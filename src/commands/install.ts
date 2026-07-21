import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  getAgentSkillRoot,
  parseAgentId,
  supportsGlobalSkills,
} from "../agents/registry.js";
import type { AgentId } from "../domain/agents.js";
import { getGatewayHookAdapter } from "../hooks/gateway.js";
import {
  preflightHookConfiguration,
  writeHookConfiguration,
} from "../hooks/config-file.js";
import {
  GATEWAY_SKILL_ENTRY_NAME,
  bundledGatewaySkillRoot,
} from "../skills/gateway.js";
import { readSkillMetadata } from "../skills/metadata.js";
import { digestTree } from "../storage/digest-tree.js";
import {
  executeTransaction,
  type ItemExecutor,
} from "../storage/execute-transaction.js";
import { preflightTransaction } from "../storage/node-item-executor.js";
import type { TransactionItem, TransactionPlan } from "../storage/types.js";
import { CANCELLED } from "../tui/ports.js";
import { selectAgent } from "./agent-selection.js";
import type { CommandContext } from "./context.js";
import {
  assertSafeAgentRoots,
  assertSafeRootWithinBoundary,
  createAgentRootGuardedExecutor,
} from "./path-safety.js";
import { recoverPendingTransactions } from "./recovery.js";

export type InstallScope = "global" | "current";

export interface InstallOptions {
  force?: boolean;
  scope?: InstallScope;
}

type SkillInstallDisposition = "install" | "replace" | "unchanged";

interface InstallLocations {
  boundary: string;
  scope: InstallScope;
  skillDestination: string;
  skillRoot: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function samePath(first: string, second: string): boolean {
  return resolve(first) === resolve(second);
}

async function treesMatch(first: string, second: string): Promise<boolean> {
  const [firstDigest, secondDigest] = await Promise.all([
    digestTree(first),
    digestTree(second),
  ]);
  return JSON.stringify(firstDigest) === JSON.stringify(secondDigest);
}

async function assertGatewaySource(source: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Bundled SkillPark gateway is missing: ${source}`);
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error(`Bundled SkillPark gateway is not a directory: ${source}`);
  }
  const metadata = await readSkillMetadata(source);
  if (!metadata.valid || metadata.name !== GATEWAY_SKILL_ENTRY_NAME) {
    throw new Error(`Bundled SkillPark gateway is invalid: ${source}`);
  }
}

function installLocations(
  agent: AgentId,
  context: CommandContext,
  scope: InstallScope,
): InstallLocations {
  const boundary = scope === "global" ? context.homeDir : context.cwd;
  const skillRoot = getAgentSkillRoot(
    agent,
    scope,
    context.homeDir,
    context.cwd,
  );
  return {
    boundary,
    scope,
    skillDestination: join(skillRoot, GATEWAY_SKILL_ENTRY_NAME),
    skillRoot,
  };
}

function assertInstallItem(
  item: TransactionItem,
  agent: AgentId,
  source: string,
  destination: string,
): void {
  if (
    item.agent !== agent ||
    item.entryName !== GATEWAY_SKILL_ENTRY_NAME ||
    item.entryKind !== "directory" ||
    item.operation !== "copy" ||
    !samePath(item.source, source) ||
    !samePath(item.destination, destination)
  ) {
    throw new Error(
      "SkillPark gateway install item escaped its expected paths",
    );
  }
}

function createInstallGuardedExecutor(
  homeDir: string,
  cwd: string,
  agent: AgentId,
  source: string,
  destination: string,
  executor: ItemExecutor,
): ItemExecutor {
  const guarded = createAgentRootGuardedExecutor(homeDir, executor, cwd);
  return {
    async apply(item) {
      assertInstallItem(item, agent, source, destination);
      await guarded.apply(item);
    },
    async revert(item) {
      assertInstallItem(item, agent, source, destination);
      await guarded.revert(item);
    },
  };
}

async function preflightSkillDestination(
  source: string,
  locations: InstallLocations,
  force: boolean,
): Promise<SkillInstallDisposition> {
  await assertSafeRootWithinBoundary(locations.boundary, locations.skillRoot);
  if (!(await pathExists(locations.skillDestination))) return "install";
  const info = await lstat(locations.skillDestination);
  if (
    !info.isSymbolicLink() &&
    info.isDirectory() &&
    (await treesMatch(source, locations.skillDestination))
  ) {
    return "unchanged";
  }
  if (force) return "replace";
  throw new Error(
    `Cannot install SkillPark gateway because the destination exists: ${locations.skillDestination}`,
  );
}

async function createVerifiedTemporarySkillCopy(
  source: string,
  locations: InstallLocations,
): Promise<string> {
  await mkdir(locations.skillRoot, { recursive: true });
  await assertSafeRootWithinBoundary(locations.boundary, locations.skillRoot);
  const temporary = join(
    locations.skillRoot,
    `.skillpark-install-${randomUUID()}`,
  );
  try {
    await cp(source, temporary, {
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    if (!(await treesMatch(source, temporary))) {
      throw new Error(`Verification failed: ${source}`);
    }
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
}

async function installGlobalSkill(
  agent: AgentId,
  source: string,
  destination: string,
  context: CommandContext,
): Promise<void> {
  await assertSafeAgentRoots(context.homeDir, agent, context.cwd);
  const plan: TransactionPlan = {
    id: randomUUID(),
    action: "install",
    createdAt: new Date().toISOString(),
    items: [
      {
        id: randomUUID(),
        agent,
        entryName: GATEWAY_SKILL_ENTRY_NAME,
        entryKind: "directory",
        operation: "copy",
        source,
        destination,
      },
    ],
  };
  await preflightTransaction(plan);
  await executeTransaction(
    plan,
    createInstallGuardedExecutor(
      context.homeDir,
      context.cwd,
      agent,
      source,
      destination,
      context.executor,
    ),
    context.journals,
  );
}

async function installCurrentSkill(
  source: string,
  locations: InstallLocations,
): Promise<void> {
  const temporary = await createVerifiedTemporarySkillCopy(source, locations);
  let placed = false;
  try {
    await assertSafeRootWithinBoundary(locations.boundary, locations.skillRoot);
    if (await pathExists(locations.skillDestination)) {
      throw new Error(`Destination exists: ${locations.skillDestination}`);
    }
    await rename(temporary, locations.skillDestination);
    placed = true;
  } finally {
    if (!placed) await rm(temporary, { force: true, recursive: true });
  }
}

async function replaceSkill(
  source: string,
  locations: InstallLocations,
): Promise<void> {
  const temporary = await createVerifiedTemporarySkillCopy(source, locations);
  const backup = join(
    locations.skillRoot,
    `.skillpark-replaced-${randomUUID()}`,
  );
  let placed = false;
  try {
    await assertSafeRootWithinBoundary(locations.boundary, locations.skillRoot);
    if (!(await pathExists(locations.skillDestination))) {
      throw new Error(
        `Cannot replace SkillPark gateway because the destination disappeared: ${locations.skillDestination}`,
      );
    }
    await rename(locations.skillDestination, backup);
    try {
      if (await pathExists(locations.skillDestination)) {
        throw new Error(`Destination exists: ${locations.skillDestination}`);
      }
      await rename(temporary, locations.skillDestination);
      placed = true;
    } catch (error) {
      if (await pathExists(locations.skillDestination)) {
        throw new Error(
          `Manual recovery required: original SkillPark gateway is retained at ${backup}`,
          { cause: error },
        );
      }
      try {
        await rename(backup, locations.skillDestination);
      } catch (restoreError) {
        throw new Error(
          `Manual recovery required: original SkillPark gateway is retained at ${backup}`,
          { cause: restoreError },
        );
      }
      throw error;
    }
    await rm(backup, { force: true, recursive: true });
  } finally {
    if (!placed) await rm(temporary, { force: true, recursive: true });
  }
}

export async function runInstall(
  agentArgument: string,
  context: CommandContext,
  options: InstallOptions = {},
): Promise<void> {
  const agent = parseAgentId(agentArgument);
  const scope = options.scope ?? "global";
  const hookAdapter = getGatewayHookAdapter(agent);
  const locations = installLocations(agent, context, scope);
  const force = options.force ?? false;
  const source = bundledGatewaySkillRoot();

  await recoverPendingTransactions(context);

  await assertGatewaySource(source);
  const skillDisposition: SkillInstallDisposition =
    await preflightSkillDestination(source, locations, force);
  const hookPlan =
    hookAdapter !== undefined
      ? await preflightHookConfiguration(agent, hookAdapter, context, scope)
      : undefined;

  if (skillDisposition === "install") {
    context.output.info(`${locations.skillDestination} ← ${source}`);
    if (scope === "global") {
      await installGlobalSkill(
        agent,
        source,
        locations.skillDestination,
        context,
      );
    } else {
      await installCurrentSkill(source, locations);
    }
    context.output.success(
      `Installed SkillPark gateway skill for ${agent} (${scope}): ${locations.skillDestination}`,
    );
  } else if (skillDisposition === "replace") {
    context.output.info(`${locations.skillDestination} ⇐ ${source}`);
    if (scope === "global") {
      await assertSafeAgentRoots(context.homeDir, agent, context.cwd);
    }
    await replaceSkill(source, locations);
    context.output.success(
      `Replaced SkillPark gateway skill for ${agent} (${scope}): ${locations.skillDestination}`,
    );
  } else {
    context.output.info(
      `SkillPark gateway skill is already installed for ${agent} (${scope}): ${locations.skillDestination}`,
    );
  }

  if (hookPlan !== undefined) {
    if (hookPlan.changed) {
      await writeHookConfiguration(
        scope === "global" ? context.homeDir : context.cwd,
        hookPlan,
      );
      context.output.success(
        `Installed SkillPark routing hook for ${agent} (${scope}): ${hookPlan.path}`,
      );
    } else {
      context.output.info(
        `SkillPark routing hook is already installed for ${agent} (${scope}): ${hookPlan.path}`,
      );
    }
    const warning = hookAdapter?.warning?.(scope);
    if (warning !== undefined) context.output.warning(warning);
  }
}

export async function runInteractiveInstall(
  agentArgument: string,
  force: boolean,
  context: CommandContext,
): Promise<void> {
  const agent = parseAgentId(agentArgument);
  if (context.prompts.selectOne === undefined) {
    throw new Error("Interactive install scope selection is unavailable");
  }
  const choices = [
    ...(supportsGlobalSkills(agent)
      ? [
          {
            value: "global",
            label: "Global",
            hint: getAgentSkillRoot(
              agent,
              "global",
              context.homeDir,
              context.cwd,
            ),
          },
        ]
      : []),
    {
      value: "current",
      label: "Current project",
      hint: getAgentSkillRoot(agent, "current", context.homeDir, context.cwd),
    },
  ];
  const selectedScope = await context.prompts.selectOne(
    `Where should SkillPark install for ${agent}?`,
    choices,
  );
  if (selectedScope === CANCELLED) return;
  if (selectedScope !== "global" && selectedScope !== "current") {
    throw new Error(`Invalid install scope selection: ${selectedScope}`);
  }
  await runInstall(agentArgument, context, {
    force,
    scope: selectedScope,
  });
}

export function registerInstallCommand(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("install")
    .description("Install SkillPark for an agent")
    .argument("[agent]", "Agent id (prompts if omitted)")
    .option("--force", "Replace an existing SkillPark skill")
    .action(
      async (
        agentArgument: string | undefined,
        options: { force?: boolean },
      ) => {
        const agent = await selectAgent(agentArgument, context, {
          message: "Select an agent to configure",
        });
        if (agent === CANCELLED) return;
        await runInteractiveInstall(agent, options.force ?? false, context);
      },
    );
}
