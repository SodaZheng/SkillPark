import { lstat, realpath } from "node:fs/promises";
import * as nativePath from "node:path";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getAgentPaths, supportsGlobalSkills } from "../agents/registry.js";
import type { AgentId } from "../domain/agents.js";
import type { ItemExecutor } from "../storage/execute-transaction.js";

export interface PathSemantics {
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  sep: string;
}

export function containsPath(
  container: string,
  candidate: string,
  paths: PathSemantics = nativePath,
): boolean {
  const difference = paths.relative(
    paths.resolve(container),
    paths.resolve(candidate),
  );
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(difference))
  );
}

export async function prospectivePhysicalPath(path: string): Promise<string> {
  let existing = resolve(path);
  const missingComponents: string[] = [];
  while (true) {
    try {
      return join(await realpath(existing), ...missingComponents);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missingComponents.unshift(basename(existing));
      existing = parent;
    }
  }
}

export async function assertSafeRootWithinBoundary(
  boundary: string,
  root: string,
): Promise<void> {
  const home = resolve(boundary);
  const target = resolve(root);
  if (target === home || !containsPath(home, target)) {
    throw new Error(`Unsafe agent root outside boundary: ${root}`);
  }

  const homeInfo = await lstat(home);
  if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) {
    throw new Error(`Unsafe agent root boundary: ${home}`);
  }

  let current = home;
  for (const component of relative(home, target).split(sep)) {
    current = join(current, component);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Unsafe agent root component: ${current}`);
    }
  }
}

export async function assertSafeAgentRoots(
  homeDir: string,
  agent: AgentId,
  cwd: string = process.cwd(),
): Promise<void> {
  const paths = getAgentPaths(agent, homeDir, cwd);
  await assertSafeRootWithinBoundary(
    supportsGlobalSkills(agent) ? homeDir : cwd,
    paths.active,
  );
  await assertSafeRootWithinBoundary(homeDir, paths.parked);
  const [activeRoot, parkedRoot] = await Promise.all([
    prospectivePhysicalPath(paths.active),
    prospectivePhysicalPath(paths.parked),
  ]);
  if (
    containsPath(activeRoot, parkedRoot) ||
    containsPath(parkedRoot, activeRoot)
  ) {
    throw new Error(
      `Unsafe agent roots overlap: ${paths.active} and ${paths.parked}`,
    );
  }
}

export async function assertSafeSelectedAgentRoots(
  homeDir: string,
  agents: readonly AgentId[],
  cwd: string = process.cwd(),
): Promise<void> {
  for (const agent of agents) await assertSafeAgentRoots(homeDir, agent, cwd);
}

export function createAgentRootGuardedExecutor(
  homeDir: string,
  executor: ItemExecutor,
  cwd: string = process.cwd(),
): ItemExecutor {
  return {
    async apply(item) {
      await assertSafeAgentRoots(homeDir, item.agent, cwd);
      await executor.apply(item);
    },
    async revert(item) {
      await assertSafeAgentRoots(homeDir, item.agent, cwd);
      await executor.revert(item);
    },
  };
}
