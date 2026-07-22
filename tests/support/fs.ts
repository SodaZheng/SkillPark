import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

export async function makeTempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skillpark-home-"));
}

export async function createSkill(
  parent: string,
  entryName: string,
  frontmatter: {
    name: string;
    description: string;
    search?: { keywords: string[] };
  } = {
    name: entryName,
    description: `${entryName} skill`,
  },
): Promise<string> {
  const path = join(parent, entryName);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\n${stringify(frontmatter)}---\n\n# ${frontmatter.name}\n`,
  );
  return path;
}
