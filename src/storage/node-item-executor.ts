import { COPYFILE_EXCL } from "node:constants";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  rename as nodeRename,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { digestTree } from "./digest-tree.js";
import type { ItemExecutor } from "./execute-transaction.js";
import {
  attachCleanupError,
  cleanupOperationArtifactAfterFailure,
  cleanupOwnedOperationArtifact,
  createOperationArtifact,
  manualRecoveryError,
  moveIntoOperationArtifact,
  type OperationArtifactOptions,
  type OperationArtifactRole,
  operationArtifactPaths,
  requireOwnedOperationArtifact,
} from "./operation-artifacts.js";
import type { TransactionItem, TransactionPlan } from "./types.js";

export interface NodeExecutorOptions {
  rename?(source: string, destination: string): Promise<void>;
  remove?(path: string): Promise<void>;
  createSymlink?(
    target: string,
    path: string,
    type?: "dir" | "file" | "junction",
  ): Promise<void>;
  writeMarker?(path: string, content: string): Promise<void>;
  beforeFinalPlacement?(temporary: string, destination: string): Promise<void>;
  beforeSourceIsolation?(source: string, quarantine: string): Promise<void>;
  beforeQuarantineRestore?(
    quarantine: string,
    destination: string,
  ): Promise<void>;
  platform?: NodeJS.Platform;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function requireAbsent(path: string): Promise<void> {
  if (await exists(path)) throw new Error(`Destination exists: ${path}`);
}

function pathIdentity(path: string): string {
  const identity = normalize(resolve(path));
  return process.platform === "win32" || process.platform === "darwin"
    ? identity.toLowerCase()
    : identity;
}

function rebaseContainedPath(
  logicalRoot: string,
  physicalRoot: string,
  candidate: string,
): string {
  const difference = relative(resolve(logicalRoot), resolve(candidate));
  if (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  ) {
    return resolve(physicalRoot, difference);
  }
  return candidate;
}

export async function preflightTransaction(
  plan: TransactionPlan,
): Promise<void> {
  const destinations = new Set<string>();
  for (const item of plan.items) {
    if (!(await exists(item.source))) {
      throw new Error(`Source disappeared: ${item.source}`);
    }
    const sourceInfo = await lstat(item.source);
    const actualKind = sourceInfo.isSymbolicLink()
      ? "link"
      : sourceInfo.isDirectory()
        ? "directory"
        : "unsupported";
    if (actualKind !== item.entryKind) {
      throw new Error(`Source type changed: ${item.source}`);
    }
    if (await exists(item.destination)) {
      throw new Error(`Destination exists: ${item.destination}`);
    }
    const destinationIdentity = pathIdentity(item.destination);
    if (destinations.has(destinationIdentity)) {
      throw new Error(`Duplicate destination: ${item.destination}`);
    }
    destinations.add(destinationIdentity);
  }
}

export function reverseTransactionItem(item: TransactionItem): TransactionItem {
  return {
    ...item,
    source: item.destination,
    destination: item.source,
  };
}

function digestsMatch(
  first: Awaited<ReturnType<typeof digestTree>>,
  second: Awaited<ReturnType<typeof digestTree>>,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

export function createNodeItemExecutor(
  options: NodeExecutorOptions = {},
): ItemExecutor {
  const rename = options.rename ?? nodeRename;
  const remove =
    options.remove ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  const createSymlink = options.createSymlink ?? symlink;
  const platform = options.platform ?? process.platform;
  const artifactOptions: OperationArtifactOptions = {
    remove,
    rename,
    ...(options.writeMarker === undefined
      ? {}
      : { writeMarker: options.writeMarker }),
  };
  const localArtifactOptions: OperationArtifactOptions = {
    remove,
    rename: nodeRename,
    ...(options.writeMarker === undefined
      ? {}
      : { writeMarker: options.writeMarker }),
  };
  const sourceArtifactOptions: OperationArtifactOptions = {
    ...localArtifactOptions,
    rename: async (source, destination) => {
      await options.beforeSourceIsolation?.(source, destination);
      await nodeRename(source, destination);
    },
  };

  async function copyLink(
    source: string,
    destination: string,
    logicalSource: string,
    logicalRoot: string,
    physicalRoot: string,
  ): Promise<void> {
    const target = await readlink(source);
    if (platform !== "win32") {
      await createSymlink(target, destination);
      return;
    }

    let type: "dir" | "file" | undefined;
    try {
      const resolvedTarget = isAbsolute(target)
        ? target
        : resolve(dirname(logicalSource), target);
      const physicalTarget = rebaseContainedPath(
        logicalRoot,
        physicalRoot,
        resolvedTarget,
      );
      type = (await stat(physicalTarget)).isDirectory() ? "dir" : "file";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (type === undefined) {
      await createSymlink(target, destination);
      return;
    }
    await createSymlink(target, destination, type);
  }

  async function copyEntry(
    source: string,
    destination: string,
    deferDirectoryMetadata = false,
    logicalSource: string = source,
    logicalRoot: string = logicalSource,
    physicalRoot: string = source,
  ): Promise<void> {
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      await copyLink(
        source,
        destination,
        logicalSource,
        logicalRoot,
        physicalRoot,
      );
      return;
    }
    if (info.isDirectory()) {
      await mkdir(destination, { mode: info.mode | 0o700 });
      for (const name of (await readdir(source)).sort()) {
        await copyEntry(
          join(source, name),
          join(destination, name),
          false,
          join(logicalSource, name),
          logicalRoot,
          physicalRoot,
        );
      }
      if (!deferDirectoryMetadata) {
        await chmod(destination, info.mode);
        await utimes(destination, info.atime, info.mtime);
      }
      return;
    }
    if (info.isFile()) {
      await copyFile(source, destination, COPYFILE_EXCL);
      await chmod(destination, info.mode);
      const updated = await stat(source);
      await utimes(destination, updated.atime, updated.mtime);
      return;
    }
    throw new Error(`Unsupported filesystem entry: ${source}`);
  }

  async function restoreArtifactPayload(
    item: TransactionItem,
    role: OperationArtifactRole,
    destination: string,
    primary: unknown,
  ): Promise<never> {
    const paths = operationArtifactPaths(item, role);
    try {
      await requireOwnedOperationArtifact(item, role);
      await options.beforeQuarantineRestore?.(paths.payload, destination);
      if (await exists(destination)) {
        throw manualRecoveryError(
          `quarantine restore destination exists: ${destination}`,
        );
      }
      await nodeRename(paths.payload, destination);
      await cleanupOwnedOperationArtifact(item, role, localArtifactOptions);
    } catch (cleanupError) {
      attachCleanupError(primary, cleanupError);
    }
    throw primary;
  }

  async function copyVerified(
    item: TransactionItem,
    source: string,
    destination: string,
    copyOptions: {
      logicalSource?: string;
      progress?: { placed: boolean };
    } = {},
  ): Promise<void> {
    await requireAbsent(destination);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = await createOperationArtifact(
      item,
      "destination-temp",
      artifactOptions,
    );
    let placed = false;
    try {
      const sourceInfo = await lstat(source);
      await copyEntry(
        source,
        temporary.payload,
        sourceInfo.isDirectory(),
        copyOptions.logicalSource ?? source,
        copyOptions.logicalSource ?? source,
        source,
      );
      const [sourceDigest, copyDigest] = await Promise.all([
        digestTree(source),
        digestTree(temporary.payload),
      ]);
      if (!digestsMatch(sourceDigest, copyDigest)) {
        throw new Error(`Verification failed: ${source}`);
      }

      await options.beforeFinalPlacement?.(temporary.payload, destination);
      await requireAbsent(destination);
      await rename(temporary.payload, destination);
      placed = true;
      if (copyOptions.progress !== undefined) {
        copyOptions.progress.placed = true;
      }
      if (sourceInfo.isDirectory()) {
        await chmod(destination, sourceInfo.mode);
        await utimes(destination, sourceInfo.atime, sourceInfo.mtime);
      }
      await cleanupOwnedOperationArtifact(
        item,
        "destination-temp",
        artifactOptions,
      );
    } catch (error) {
      if (placed) throw error;
      await cleanupOperationArtifactAfterFailure(
        item,
        "destination-temp",
        error,
        artifactOptions,
      );
    }
  }

  async function removeVerifiedDestination(
    item: TransactionItem,
  ): Promise<void> {
    if (!(await exists(item.destination))) return;
    const quarantine = await moveIntoOperationArtifact(
      item,
      "destination-quarantine",
      item.destination,
      localArtifactOptions,
    );
    let verificationError: Error | undefined;
    try {
      const [sourceDigest, quarantineDigest] = await Promise.all([
        digestTree(item.source),
        digestTree(quarantine.payload),
      ]);
      if (!digestsMatch(sourceDigest, quarantineDigest)) {
        verificationError = new Error(
          `Verification failed: ${item.destination}`,
        );
        await restoreArtifactPayload(
          item,
          "destination-quarantine",
          item.destination,
          verificationError,
        );
      }
      await cleanupOwnedOperationArtifact(
        item,
        "destination-quarantine",
        localArtifactOptions,
      );
    } catch (error) {
      if (verificationError !== undefined) throw verificationError;
      throw error;
    }
  }

  async function move(item: TransactionItem): Promise<void> {
    await mkdir(dirname(item.destination), { recursive: true });
    await requireAbsent(item.destination);
    try {
      await rename(item.source, item.destination);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    }

    // A cross-device move cannot be atomic. Isolate the source first so a
    // permission or sharing violation is reported before a destination copy
    // exists, and so crash recovery always has an owned copy to restore.
    await requireAbsent(item.destination);
    const quarantine = await moveIntoOperationArtifact(
      item,
      "source-quarantine",
      item.source,
      sourceArtifactOptions,
    );
    const progress = { placed: false };
    try {
      await copyVerified(item, quarantine.payload, item.destination, {
        logicalSource: item.source,
        progress,
      });
    } catch (error) {
      if (!progress.placed) {
        await restoreArtifactPayload(
          item,
          "source-quarantine",
          item.source,
          error,
        );
      }
      throw error;
    }
    const [sourceDigest, destinationDigest] = await Promise.all([
      digestTree(quarantine.payload),
      digestTree(item.destination),
    ]);
    if (!digestsMatch(sourceDigest, destinationDigest)) {
      const verificationError = new Error(
        `Verification failed: ${item.source}`,
      );
      await restoreArtifactPayload(
        item,
        "source-quarantine",
        item.source,
        verificationError,
      );
    }
    await cleanupOwnedOperationArtifact(
      item,
      "source-quarantine",
      localArtifactOptions,
    );
  }

  return {
    async apply(item) {
      if (item.operation === "move") {
        await move(item);
      } else {
        await copyVerified(item, item.source, item.destination);
      }
    },
    async revert(item) {
      if (item.operation === "move") {
        await move(reverseTransactionItem(item));
      } else {
        await removeVerifiedDestination(item);
      }
    },
  };
}
