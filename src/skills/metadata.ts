import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { SkillMetadata } from "../domain/skills.js";

export async function readSkillMetadata(
  skillPath: string,
  fallbackName?: string,
): Promise<SkillMetadata> {
  const fallback = fallbackName ?? basename(skillPath);
  try {
    const markdown = await readFile(join(skillPath, "SKILL.md"), "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
    if (!match?.[1]) {
      return {
        name: fallback,
        description: "",
        valid: false,
        warnings: ["Missing YAML frontmatter"],
      };
    }
    const data = parse(match[1]) as {
      name?: unknown;
      description?: unknown;
      routing?: unknown;
    };
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const description =
      typeof data.description === "string" ? data.description.trim() : "";
    const routing = readRoutingMetadata(data.routing);
    const warnings = [
      !name && "Missing name",
      !description && "Missing description",
    ].filter(Boolean) as string[];
    return {
      name: name || fallback,
      description,
      ...(routing === undefined ? {} : { routing }),
      valid: warnings.length === 0,
      warnings,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      name: fallback,
      description: "",
      valid: false,
      warnings: [
        code === "ENOENT" ? "Missing SKILL.md" : "Unreadable SKILL.md",
      ],
    };
  }
}

function readRoutingMetadata(
  value: unknown,
): SkillMetadata["routing"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const aliases = (value as { aliases?: unknown }).aliases;
  if (!Array.isArray(aliases)) return undefined;
  const normalized = [
    ...new Set(
      aliases
        .filter((alias): alias is string => typeof alias === "string")
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0 && alias.length <= 160),
    ),
  ].slice(0, 32);
  return normalized.length === 0 ? undefined : { aliases: normalized };
}
