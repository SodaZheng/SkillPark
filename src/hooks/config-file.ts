import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentConfigDirs, AgentId, AgentScope } from "../domain/agents.js";
import { assertSafeRootWithinBoundary } from "../commands/path-safety.js";
import type { GatewayHookAdapter } from "./types.js";

export interface HookConfigContext {
  cwd: string;
  homeDir: string;
  agentConfigDirs: AgentConfigDirs;
}

export interface HookConfigurationPlan {
  changed: boolean;
  expected: string | undefined;
  mode: number;
  next: string;
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function preflightHookConfiguration(
  agent: AgentId,
  adapter: GatewayHookAdapter,
  context: HookConfigContext,
  scope: AgentScope,
): Promise<HookConfigurationPlan> {
  const globalConfigDir =
    scope === "global" ? context.agentConfigDirs[agent] : undefined;
  const boundary =
    scope === "global"
      ? globalConfigDir === undefined
        ? context.homeDir
        : dirname(globalConfigDir)
      : context.cwd;
  const hookConfig = adapter.configPath({
    cwd: context.cwd,
    ...(globalConfigDir === undefined ? {} : { globalConfigDir }),
    homeDir: context.homeDir,
    scope,
  });
  await assertSafeRootWithinBoundary(boundary, dirname(hookConfig));
  let expected: string | undefined;
  let mode = 0o600;
  let configuration = adapter.initialConfiguration ?? {};
  try {
    const info = await lstat(hookConfig);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(
        `Cannot install SkillPark hook into an unsafe config file: ${hookConfig}`,
      );
    }
    mode = info.mode & 0o777;
    expected = await readFile(hookConfig, "utf8");
    const parsed = JSON.parse(expected) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("configuration must be a JSON object");
    }
    configuration = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new Error(
          `Cannot install SkillPark hook because ${hookConfig} is not valid JSON`,
        );
      }
      if (
        error instanceof Error &&
        error.message === "configuration must be a JSON object"
      ) {
        throw new Error(
          `Cannot install SkillPark hook because ${hookConfig} must contain a JSON object`,
        );
      }
      throw error;
    }
  }
  const merged = adapter.merge(configuration, agent);
  return {
    changed: merged.changed,
    expected,
    mode,
    next: `${JSON.stringify(merged.configuration, null, 2)}\n`,
    path: hookConfig,
  };
}

export async function writeHookConfiguration(
  boundary: string,
  plan: HookConfigurationPlan,
): Promise<void> {
  await mkdir(dirname(plan.path), { recursive: true });
  await assertSafeRootWithinBoundary(boundary, dirname(plan.path));
  const temporary = joinTemporaryPath(plan.path);
  let placed = false;
  try {
    await writeFile(temporary, plan.next, {
      encoding: "utf8",
      flag: "wx",
      mode: plan.mode,
    });
    if ((await readOptionalFile(plan.path)) !== plan.expected) {
      throw new Error(
        `Cannot install SkillPark hook because the config changed during installation: ${plan.path}`,
      );
    }
    const currentInfo = await optionalLstat(plan.path);
    if (
      currentInfo !== undefined &&
      (currentInfo.isSymbolicLink() || !currentInfo.isFile())
    ) {
      throw new Error(
        `Cannot install SkillPark hook into an unsafe config file: ${plan.path}`,
      );
    }
    await rename(temporary, plan.path);
    placed = true;
  } finally {
    if (!placed) await rm(temporary, { force: true });
  }
}

function joinTemporaryPath(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.skillpark-${randomUUID()}.tmp`,
  );
}

async function optionalLstat(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
