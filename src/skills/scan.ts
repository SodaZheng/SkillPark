import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ScanMode, SkillEntry } from "../domain/skills.js";
import { readSkillMetadata } from "./metadata.js";

export async function scanSkillEntries(
  directory: string,
  mode: ScanMode,
): Promise<SkillEntry[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries: SkillEntry[] = [];
  for (const entryName of names.sort((a, b) => a.localeCompare(b))) {
    if (entryName.startsWith(".")) continue;
    const path = join(directory, entryName);
    const info = await lstat(path);
    if (!info.isDirectory() && !info.isSymbolicLink()) continue;
    const kind = info.isSymbolicLink() ? "link" : "directory";
    let metadataPath = path;
    let broken = false;
    if (kind === "link") {
      try {
        metadataPath = await realpath(path);
        if (mode === "active" && !(await lstat(metadataPath)).isDirectory()) {
          continue;
        }
      } catch {
        broken = true;
      }
    }
    const metadata = await readSkillMetadata(metadataPath, entryName);
    if (broken) metadata.warnings.unshift("Link target is missing");
    if (
      mode === "active" &&
      (broken || metadata.warnings.includes("Missing SKILL.md"))
    ) {
      continue;
    }
    entries.push({
      entryName: basename(path),
      path,
      kind,
      broken,
      metadata,
    });
  }
  return entries;
}
