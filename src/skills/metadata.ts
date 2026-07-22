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
      search?: unknown;
    };
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const description =
      typeof data.description === "string" ? data.description.trim() : "";
    const search = readSearchMetadata(data.search);
    const warnings = [
      !name && "Missing name",
      !description && "Missing description",
    ].filter(Boolean) as string[];
    return {
      name: name || fallback,
      description,
      ...(search === undefined ? {} : { search }),
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

function readSearchMetadata(
  value: unknown,
): SkillMetadata["search"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keywords = (value as { keywords?: unknown }).keywords;
  if (!Array.isArray(keywords)) return undefined;
  const normalized = [
    ...new Set(
      keywords
        .filter((keyword): keyword is string => typeof keyword === "string")
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0 && keyword.length <= 160),
    ),
  ].slice(0, 32);
  return normalized.length === 0 ? undefined : { keywords: normalized };
}
