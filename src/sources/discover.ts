import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SkillEntry } from "../domain/skills.js";
import { readSkillMetadata } from "../skills/metadata.js";
import { validateEntryName } from "./entry-name.js";

const containerComponents = [
  ["skills"],
  [".claude", "skills"],
  [".agents", "skills"],
  [".codex", "skills"],
] as const;

interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

interface FileIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

function identity(path: string, info: { dev: bigint; ino: bigint }) {
  return { path, dev: info.dev, ino: info.ino };
}

async function assertDirectoryIdentity(
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await lstat(expected.path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error(
      `Source directory changed during discovery: ${expected.path}`,
    );
  }
}

async function assertFileIdentity(expected: FileIdentity): Promise<void> {
  const current = await lstat(expected.path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error(
      `Source metadata changed during discovery: ${expected.path}`,
    );
  }
}

async function assertDirectoryChain(
  directories: readonly DirectoryIdentity[],
): Promise<void> {
  for (const directory of directories) {
    await assertDirectoryIdentity(directory);
  }
}

async function requireSourceRoot(root: string): Promise<DirectoryIdentity> {
  const info = await lstat(root, { bigint: true });
  if (info.isSymbolicLink()) {
    throw new Error("Unsafe source root: symbolic links are not allowed");
  }
  if (!info.isDirectory()) {
    throw new Error(`Unsafe source root: not a directory: ${root}`);
  }
  return identity(root, info);
}

async function findContainer(
  root: DirectoryIdentity,
  components: readonly string[],
): Promise<readonly DirectoryIdentity[] | undefined> {
  const chain: DirectoryIdentity[] = [root];
  let path = root.path;
  for (const component of components) {
    await assertDirectoryChain(chain);
    path = join(path, component);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        "Unsafe source container path: symbolic links are not allowed",
      );
    }
    if (!info.isDirectory()) return undefined;
    chain.push(identity(path, info));
  }
  await assertDirectoryChain(chain);
  return chain;
}

async function candidate(
  path: string,
  ancestors: readonly DirectoryIdentity[],
  entryName = basename(path),
): Promise<SkillEntry | undefined> {
  await assertDirectoryChain(ancestors);
  let directoryInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryInfo = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    return undefined;
  }
  const directory = identity(path, directoryInfo);

  const metadataPath = join(path, "SKILL.md");
  let metadataInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    metadataInfo = await lstat(metadataPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (metadataInfo.isSymbolicLink() || !metadataInfo.isFile()) return undefined;
  const metadataFile = identity(metadataPath, metadataInfo);

  await assertDirectoryChain([...ancestors, directory]);
  await assertFileIdentity(metadataFile);
  const metadata = await readSkillMetadata(path);
  await assertDirectoryChain([...ancestors, directory]);
  await assertFileIdentity(metadataFile);
  if (!metadata.valid) return undefined;
  validateEntryName(entryName, "skill entry name");
  return {
    entryName,
    path,
    kind: "directory",
    broken: false,
    metadata,
  };
}

export async function discoverSourceSkills(
  root: string,
  rootEntryName = basename(root),
): Promise<SkillEntry[]> {
  const rootIdentity = await requireSourceRoot(root);
  const discovered: SkillEntry[] = [];
  const rootSkill = await candidate(root, [], rootEntryName);
  if (rootSkill !== undefined) discovered.push(rootSkill);

  for (const components of containerComponents) {
    const chain = await findContainer(rootIdentity, components);
    if (chain === undefined) continue;
    const directory = chain.at(-1);
    if (directory === undefined) continue;
    await assertDirectoryChain(chain);
    const names = (await readdir(directory.path)).sort();
    await assertDirectoryChain(chain);
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const skill = await candidate(join(directory.path, name), chain);
      if (skill !== undefined) discovered.push(skill);
    }
  }

  const metadataNames = new Set<string>();
  const entryNames = new Set<string>();
  for (const skill of discovered) {
    if (metadataNames.has(skill.metadata.name)) {
      throw new Error(`Duplicate skill name: ${skill.metadata.name}`);
    }
    if (entryNames.has(skill.entryName)) {
      throw new Error(`Duplicate skill directory name: ${skill.entryName}`);
    }
    metadataNames.add(skill.metadata.name);
    entryNames.add(skill.entryName);
  }

  return discovered;
}
