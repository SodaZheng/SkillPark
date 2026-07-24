import { randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  getAgentSkillRoot,
  parseAgentId,
  supportsGlobalSkills,
} from "../agents/registry.js";
import type { AgentId } from "../domain/agents.js";
import {
  applyLegacyHookCleanup,
  preflightLegacyHookCleanup,
} from "../migrations/legacy-hooks.js";
import {
  preflightContextInstructions,
  writeContextInstructions,
} from "../instructions/context-file.js";
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

async function treesMatch(
  first: string,
  second: string,
  ignoredPaths: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  const [firstDigest, secondDigest] = await Promise.all([
    digestTree(first),
    digestTree(second),
  ]);
  const included = (entry: { path: string }) => !ignoredPaths.has(entry.path);
  return (
    JSON.stringify(firstDigest.filter(included)) ===
    JSON.stringify(secondDigest.filter(included))
  );
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
  const boundary =
    scope === "global"
      ? (context.agentConfigDirs[agent] ?? context.homeDir)
      : context.cwd;
  const skillRoot = getAgentSkillRoot(
    agent,
    scope,
    context.homeDir,
    context.cwd,
    context.agentConfigDirs,
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
  configDirs: CommandContext["agentConfigDirs"],
): ItemExecutor {
  const guarded = createAgentRootGuardedExecutor(
    homeDir,
    executor,
    cwd,
    configDirs,
  );
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
  agent: AgentId,
  source: string,
  locations: InstallLocations,
  force: boolean,
): Promise<SkillInstallDisposition> {
  await assertSafeRootWithinBoundary(locations.boundary, locations.skillRoot);
  if (!(await pathExists(locations.skillDestination))) return "install";
  const info = await lstat(locations.skillDestination);
  const metadataPath = join("agents", "openai.yaml");
  if (
    !info.isSymbolicLink() &&
    info.isDirectory() &&
    (await treesMatch(source, locations.skillDestination))
  ) {
    return "unchanged";
  }
  if (
    !info.isSymbolicLink() &&
    info.isDirectory() &&
    (await treesMatch(
      source,
      locations.skillDestination,
      new Set([metadataPath]),
    )) &&
    (agent !== "codex" ||
      !(await pathExists(join(locations.skillDestination, metadataPath))))
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
  await assertSafeAgentRoots(
    context.homeDir,
    agent,
    context.cwd,
    context.agentConfigDirs,
  );
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
      context.agentConfigDirs,
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

async function synchronizeCodexMetadata(
  agent: AgentId,
  source: string,
  locations: InstallLocations,
  retainForSharedCodex: boolean,
): Promise<void> {
  const relativeMetadataPath = join("agents", "openai.yaml");
  const destination = join(locations.skillDestination, relativeMetadataPath);
  if (agent === "codex") {
    await mkdir(join(locations.skillDestination, "agents"), {
      recursive: true,
    });
    await copyFile(join(source, relativeMetadataPath), destination);
    return;
  }
  if (retainForSharedCodex) return;
  await rm(destination, {
    force: true,
  });
}

export async function runInstall(
  agentArgument: string,
  context: CommandContext,
  options: InstallOptions = {},
): Promise<void> {
  const agent = parseAgentId(agentArgument);
  const scope = options.scope ?? "global";
  const locations = installLocations(agent, context, scope);
  const force = options.force ?? false;
  const source = bundledGatewaySkillRoot();

  await recoverPendingTransactions(context);

  await assertGatewaySource(source);
  const skillDisposition: SkillInstallDisposition =
    await preflightSkillDestination(agent, source, locations, force);
  const legacyHookPlan = await preflightLegacyHookCleanup(
    agent,
    context,
    scope,
  );
  const contextInstructionPlan = await preflightContextInstructions(
    agent,
    context,
    scope,
  );
  const retainMetadataForSharedCodex =
    agent !== "codex" &&
    scope === "current" &&
    (
      await preflightContextInstructions("codex", context, "current")
    )?.expected?.includes("<!-- skillpark-context:codex:start -->") === true;

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
    await synchronizeCodexMetadata(
      agent,
      source,
      locations,
      retainMetadataForSharedCodex,
    );
    context.output.success(
      `Installed SkillPark gateway skill for ${agent} (${scope}): ${locations.skillDestination}`,
    );
  } else if (skillDisposition === "replace") {
    context.output.info(`${locations.skillDestination} ⇐ ${source}`);
    if (scope === "global") {
      await assertSafeAgentRoots(
        context.homeDir,
        agent,
        context.cwd,
        context.agentConfigDirs,
      );
    }
    await replaceSkill(source, locations);
    await synchronizeCodexMetadata(
      agent,
      source,
      locations,
      retainMetadataForSharedCodex,
    );
    context.output.success(
      `Replaced SkillPark gateway skill for ${agent} (${scope}): ${locations.skillDestination}`,
    );
  } else {
    await synchronizeCodexMetadata(
      agent,
      source,
      locations,
      retainMetadataForSharedCodex,
    );
    context.output.info(
      `SkillPark gateway skill is already installed for ${agent} (${scope}): ${locations.skillDestination}`,
    );
  }

  if (legacyHookPlan?.changed) {
    await applyLegacyHookCleanup(legacyHookPlan);
    if (legacyHookPlan.removedHandlers > 0) {
      context.output.success(
        `Removed ${legacyHookPlan.removedHandlers} legacy SkillPark hook ${legacyHookPlan.removedHandlers === 1 ? "handler" : "handlers"} for ${agent} (${scope}): ${legacyHookPlan.path}`,
      );
    } else {
      context.output.success(
        `Removed legacy SkillPark hook metadata for ${agent} (${scope}): ${legacyHookPlan.path}`,
      );
    }
  }

  if (contextInstructionPlan !== undefined) {
    const guidanceLabel = contextInstructionPlan.compatibilityFallback
      ? "AGENTS.md compatibility guidance"
      : "context guidance";
    if (contextInstructionPlan.changed) {
      await writeContextInstructions(
        scope === "global"
          ? (context.agentConfigDirs[agent] ?? context.homeDir)
          : context.cwd,
        contextInstructionPlan,
      );
      context.output.success(
        `Installed SkillPark ${guidanceLabel} for ${agent} (${scope}): ${contextInstructionPlan.path}`,
      );
    } else {
      context.output.info(
        `SkillPark ${guidanceLabel} is current for ${agent} (${scope}): ${contextInstructionPlan.path}`,
      );
    }
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
              context.agentConfigDirs,
            ),
          },
        ]
      : []),
    {
      value: "current",
      label: "Current project",
      hint: getAgentSkillRoot(
        agent,
        "current",
        context.homeDir,
        context.cwd,
        context.agentConfigDirs,
      ),
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
