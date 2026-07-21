import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";

export interface TreeDigestEntry {
  path: string;
  kind: "directory" | "file" | "link";
  size?: number;
  sha256?: string;
  target?: string;
}

export async function digestTree(root: string): Promise<TreeDigestEntry[]> {
  const result: TreeDigestEntry[] = [];

  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    const relativePath = relative(root, path) || ".";
    if (info.isSymbolicLink()) {
      result.push({
        path: relativePath,
        kind: "link",
        target: await readlink(path),
      });
      return;
    }
    if (info.isDirectory()) {
      result.push({ path: relativePath, kind: "directory" });
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name));
      }
      return;
    }

    const content = await readFile(path);
    result.push({
      path: relativePath,
      kind: "file",
      size: info.size,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }

  await visit(root);
  return result;
}
