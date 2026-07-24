import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getAgentConfigDir, getAgentDefinition } from "../agents/registry.js";
import { containsPath } from "../commands/path-safety.js";
import type { AgentConfigDirs, AgentId, AgentScope } from "../domain/agents.js";

const FALLBACK_CONTEXT_FILES = {
  global: "AGENTS.md",
  current: "AGENTS.md",
} as const;

export interface ContextInstructionPlan {
  changed: boolean;
  compatibilityFallback: boolean;
  expected: string | undefined;
  mode: number;
  next: string;
  path: string;
}

export interface ContextInstructionContext {
  cwd: string;
  homeDir: string;
  agentConfigDirs: AgentConfigDirs;
}

export function renderContextInstructions(agent: AgentId): string {
  const { end, start } = markers(agent);
  return [
    start,
    "## SkillPark skill routing",
    "",
    `Apply only when the host's SkillPark agent id is \`${agent}\`. Use the installed skill named \`skillpark\` through the host's normal skill mechanism. The skill owns parked-skill search, candidate validation, and loading; do not bypass it by running SkillPark CLI commands directly from this context.`,
    "",
    "### When to invoke the skill",
    "",
    "For every non-trivial request, invoke the `skillpark` skill before acting when:",
    "",
    "- the user asks for a skill, names one, or invokes `/skillpark` or `$skillpark`;",
    "- you do not know how to do the task, are unsure of the best workflow, or the domain is unfamiliar;",
    "- a specialist skill could plausibly improve reliability, safety, speed, or output quality;",
    "- the task involves a specific artifact, file format, product, API, framework, platform, standard, or specialist workflow;",
    "- you are about to improvise, ask how to proceed, claim a capability is unavailable, or execution reveals a materially new capability.",
    "",
    "Pass the user's complete request and any explicit skill name to the gateway skill, then follow its complete instructions. Invoke it again only when execution reveals a materially new capability.",
    "",
    "Skip casual conversation, simple factual answers, trivial edits, work already covered by a loaded skill, and an equivalent SkillPark routing decision already completed for the same capability.",
    end,
  ].join("\n");
}

export async function preflightContextInstructions(
  agent: AgentId,
  context: ContextInstructionContext,
  scope: AgentScope,
): Promise<ContextInstructionPlan | undefined> {
  const path = instructionPath(agent, context, scope);
  if (path === undefined) return undefined;
  const compatibilityFallback =
    getAgentDefinition(agent).contextInstructions === undefined;
  const boundary =
    scope === "global"
      ? (context.agentConfigDirs[agent] ?? context.homeDir)
      : context.cwd;
  await assertSafeInstructionPath(boundary, path);

  let expected: string | undefined;
  let mode = 0o644;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(
        `Cannot install SkillPark context guidance into an unsafe file: ${path}`,
      );
    }
    mode = info.mode & 0o777;
    expected = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const next = mergeContextInstructions(expected, agent, path);
  return {
    changed: next !== expected,
    compatibilityFallback,
    expected,
    mode,
    next,
    path,
  };
}

export async function writeContextInstructions(
  boundary: string,
  plan: ContextInstructionPlan,
): Promise<void> {
  await mkdir(dirname(plan.path), { recursive: true });
  await assertSafeInstructionPath(boundary, plan.path);
  const temporary = join(
    dirname(plan.path),
    `.${basename(plan.path)}.skillpark-${randomUUID()}.tmp`,
  );
  let placed = false;
  try {
    await writeFile(temporary, plan.next, {
      encoding: "utf8",
      flag: "wx",
      mode: plan.mode,
    });
    if ((await readOptionalFile(plan.path)) !== plan.expected) {
      throw new Error(
        `Cannot install SkillPark context guidance because the file changed during installation: ${plan.path}`,
      );
    }
    const currentInfo = await optionalLstat(plan.path);
    if (
      currentInfo !== undefined &&
      (currentInfo.isSymbolicLink() || !currentInfo.isFile())
    ) {
      throw new Error(
        `Cannot install SkillPark context guidance into an unsafe file: ${plan.path}`,
      );
    }
    await rename(temporary, plan.path);
    placed = true;
  } finally {
    if (!placed) await rm(temporary, { force: true });
  }
}

function instructionPath(
  agent: AgentId,
  context: ContextInstructionContext,
  scope: AgentScope,
): string | undefined {
  const files =
    getAgentDefinition(agent).contextInstructions ?? FALLBACK_CONTEXT_FILES;
  if (scope === "current") return join(context.cwd, files.current);
  const configDir = getAgentConfigDir(
    agent,
    context.homeDir,
    context.agentConfigDirs,
  );
  return configDir === undefined ? undefined : join(configDir, files.global);
}

function mergeContextInstructions(
  current: string | undefined,
  agent: AgentId,
  path: string,
): string {
  const block = renderContextInstructions(agent);
  if (current === undefined || current === "") return `${block}\n`;

  const { end: endMarkerText, start: startMarkerText } = markers(agent);
  const starts = markerOffsets(current, startMarkerText);
  const ends = markerOffsets(current, endMarkerText);
  if (starts.length !== ends.length || starts.length > 1) {
    throw new Error(
      `Cannot install SkillPark context guidance because ${path} contains malformed SkillPark markers`,
    );
  }
  if (starts.length === 0) {
    return `${current.replace(/\s*$/u, "")}\n\n${block}\n`;
  }

  const start = starts[0] as number;
  const endMarker = ends[0] as number;
  if (endMarker <= start) {
    throw new Error(
      `Cannot install SkillPark context guidance because ${path} contains malformed SkillPark markers`,
    );
  }
  const end = endMarker + endMarkerText.length;
  return `${current.slice(0, start)}${block}${current.slice(end)}`;
}

function markers(agent: AgentId): { end: string; start: string } {
  return {
    start: `<!-- skillpark-context:${agent}:start -->`,
    end: `<!-- skillpark-context:${agent}:end -->`,
  };
}

function markerOffsets(value: string, marker: string): number[] {
  const offsets: number[] = [];
  let offset = value.indexOf(marker);
  while (offset !== -1) {
    offsets.push(offset);
    offset = value.indexOf(marker, offset + marker.length);
  }
  return offsets;
}

async function assertSafeInstructionPath(
  boundary: string,
  path: string,
): Promise<void> {
  const root = resolve(boundary);
  const target = resolve(path);
  if (target === root || !containsPath(root, target)) {
    throw new Error(
      `Unsafe context instruction path outside boundary: ${path}`,
    );
  }

  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Unsafe context instruction boundary: ${root}`);
  }

  const parent = dirname(target);
  if (parent === root) return;
  let current = root;
  for (const component of relative(root, parent).split(sep)) {
    current = join(current, component);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Unsafe context instruction component: ${current}`);
    }
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
