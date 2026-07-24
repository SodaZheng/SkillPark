import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AGENT_IDS, type AgentId, type AgentScope } from "../domain/agents.js";
import { assertSafeRootWithinBoundary } from "../commands/path-safety.js";
import type { AgentConfigDirs } from "../domain/agents.js";

const CODEX_LEGACY_DESCRIPTION = "SkillPark read-only parked-skill search";

const NATIVE_LEGACY_CONFIGS: Partial<
  Record<AgentId, { global: string; current: string }>
> = {
  claude: {
    global: ".claude/settings.json",
    current: ".claude/settings.json",
  },
  codex: {
    global: ".codex/hooks.json",
    current: ".codex/hooks.json",
  },
  "gemini-cli": {
    global: ".gemini/settings.json",
    current: ".gemini/settings.json",
  },
  "github-copilot": {
    global: ".copilot/settings.json",
    current: ".github/copilot/settings.json",
  },
  "qwen-code": {
    global: ".qwen/settings.json",
    current: ".qwen/settings.json",
  },
};

export interface LegacyHookContext {
  agentConfigDirs: AgentConfigDirs;
  cwd: string;
  homeDir: string;
}

export interface LegacyHookCleanupPlan {
  boundary: string;
  changed: boolean;
  expected: string;
  mode: number;
  next?: string;
  path: string;
  removeFile: boolean;
  removedHandlers: number;
}

interface CleanResult {
  changed: boolean;
  removedHandlers: number;
  value: unknown;
}

const REMOVED = Symbol("removed");

export async function preflightLegacyHookCleanup(
  agent: AgentId,
  context: LegacyHookContext,
  scope: AgentScope,
): Promise<LegacyHookCleanupPlan | undefined> {
  const location = legacyHookLocation(agent, context, scope);
  if (location === undefined) return undefined;
  await assertSafeRootWithinBoundary(location.boundary, dirname(location.path));

  let info: Awaited<ReturnType<typeof lstat>>;
  let expected: string;
  try {
    info = await lstat(location.path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(
        `Cannot clean legacy SkillPark hooks from an unsafe config file: ${location.path}`,
      );
    }
    expected = await readFile(location.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let configuration: unknown;
  try {
    configuration = JSON.parse(expected) as unknown;
  } catch {
    throw new Error(
      `Cannot clean legacy SkillPark hooks because ${location.path} is not valid JSON`,
    );
  }
  if (!isRecord(configuration)) {
    throw new Error(
      `Cannot clean legacy SkillPark hooks because ${location.path} must contain a JSON object`,
    );
  }

  const nextConfiguration = { ...configuration };
  const hooks = cleanHookNode(nextConfiguration.hooks);
  if (hooks.changed) {
    if (
      hooks.value === REMOVED ||
      (isRecord(hooks.value) && Object.keys(hooks.value).length === 0)
    ) {
      delete nextConfiguration.hooks;
    } else {
      nextConfiguration.hooks = hooks.value;
    }
  }

  let changed = hooks.changed;
  if (
    nextConfiguration.description === CODEX_LEGACY_DESCRIPTION &&
    (agent === "codex" || hooks.removedHandlers > 0)
  ) {
    delete nextConfiguration.description;
    changed = true;
  }
  const removeFile = changed && Object.keys(nextConfiguration).length === 0;

  return {
    boundary: location.boundary,
    changed,
    expected,
    mode: info.mode & 0o777,
    ...(removeFile
      ? {}
      : { next: `${JSON.stringify(nextConfiguration, null, 2)}\n` }),
    path: location.path,
    removeFile,
    removedHandlers: hooks.removedHandlers,
  };
}

export async function applyLegacyHookCleanup(
  plan: LegacyHookCleanupPlan,
): Promise<void> {
  if (!plan.changed) return;
  await assertSafeRootWithinBoundary(plan.boundary, dirname(plan.path));
  await assertUnchangedSafeFile(plan);

  if (plan.removeFile) {
    await unlink(plan.path);
    return;
  }

  const temporary = join(
    dirname(plan.path),
    `.${basename(plan.path)}.skillpark-${randomUUID()}.tmp`,
  );
  let placed = false;
  try {
    await writeFile(temporary, plan.next as string, {
      encoding: "utf8",
      flag: "wx",
      mode: plan.mode,
    });
    await assertUnchangedSafeFile(plan);
    await rename(temporary, plan.path);
    placed = true;
  } finally {
    if (!placed) await rm(temporary, { force: true });
  }
}

function legacyHookLocation(
  agent: AgentId,
  context: LegacyHookContext,
  scope: AgentScope,
): { boundary: string; path: string } | undefined {
  const native = NATIVE_LEGACY_CONFIGS[agent];
  const custom = !AGENT_IDS.includes(agent as (typeof AGENT_IDS)[number]);
  if (native === undefined && !custom) return undefined;

  const relativePath = native?.[scope] ?? `.${agent}/settings.json`;
  if (scope === "current") {
    return {
      boundary: context.cwd,
      path: join(context.cwd, relativePath),
    };
  }

  const configDir = context.agentConfigDirs[agent];
  if (configDir !== undefined) {
    return {
      boundary: dirname(configDir),
      path: join(configDir, basename(relativePath)),
    };
  }
  return {
    boundary: context.homeDir,
    path: join(context.homeDir, relativePath),
  };
}

function cleanHookNode(value: unknown): CleanResult {
  if (Array.isArray(value)) {
    let changed = false;
    let removedHandlers = 0;
    const next: unknown[] = [];
    for (const item of value) {
      const cleaned = cleanHookNode(item);
      changed ||= cleaned.changed;
      removedHandlers += cleaned.removedHandlers;
      if (cleaned.value !== REMOVED) next.push(cleaned.value);
    }
    return {
      changed,
      removedHandlers,
      value: changed && next.length === 0 ? REMOVED : next,
    };
  }
  if (!isRecord(value)) {
    return { changed: false, removedHandlers: 0, value };
  }

  if (isLegacyCommand(value.command)) {
    return { changed: true, removedHandlers: 1, value: REMOVED };
  }

  let changed = false;
  let removedHandlers = 0;
  const next: Record<string, unknown> = { ...value };
  if (isLegacyWindowsCommand(next.commandWindows)) {
    delete next.commandWindows;
    changed = true;
    removedHandlers += 1;
  }

  for (const [key, child] of Object.entries(next)) {
    const cleaned = cleanHookNode(child);
    changed ||= cleaned.changed;
    removedHandlers += cleaned.removedHandlers;
    if (cleaned.value === REMOVED) {
      if (key === "hooks") {
        return {
          changed: true,
          removedHandlers,
          value: REMOVED,
        };
      }
      delete next[key];
    } else {
      next[key] = cleaned.value;
    }
  }

  return {
    changed,
    removedHandlers,
    value: changed && Object.keys(next).length === 0 ? REMOVED : next,
  };
}

function isLegacyCommand(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^skillpark hook [a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  );
}

function isLegacyWindowsCommand(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^skillpark\.cmd hook [a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertUnchangedSafeFile(
  plan: LegacyHookCleanupPlan,
): Promise<void> {
  const info = await lstat(plan.path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `Cannot clean legacy SkillPark hooks from an unsafe config file: ${plan.path}`,
    );
  }
  if ((await readFile(plan.path, "utf8")) !== plan.expected) {
    throw new Error(
      `Cannot clean legacy SkillPark hooks because the config changed during installation: ${plan.path}`,
    );
  }
}
