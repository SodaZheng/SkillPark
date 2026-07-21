import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename as nodeRename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { TransactionItem } from "./types.js";

export type OperationArtifactRole =
  | "destination-temp"
  | "source-quarantine"
  | "destination-quarantine";

export interface OperationArtifactPaths {
  container: string;
  marker: string;
  payload: string;
}

export interface OperationArtifactOptions {
  remove?(path: string): Promise<void>;
  rename?(source: string, destination: string): Promise<void>;
  writeMarker?(path: string, content: string): Promise<void>;
}

export type OperationArtifactState = "absent" | "owned" | "unowned";

export type ErrorWithCleanup = Error & { cleanupErrors?: unknown[] };

function normalizedIdentity(
  item: TransactionItem,
  role: OperationArtifactRole,
): {
  version: 1;
  itemId: string;
  role: OperationArtifactRole;
  source: string;
  destination: string;
} {
  return {
    version: 1,
    itemId: item.id,
    role,
    source: resolve(item.source),
    destination: resolve(item.destination),
  };
}

export function operationOwnerMarker(
  item: TransactionItem,
  role: OperationArtifactRole,
): string {
  return `${JSON.stringify(normalizedIdentity(item, role))}\n`;
}

export function operationArtifactPaths(
  item: TransactionItem,
  role: OperationArtifactRole,
): OperationArtifactPaths {
  const identity = normalizedIdentity(item, role);
  const { source, destination } = identity;
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  const anchor = role === "source-quarantine" ? source : destination;
  const container = join(
    dirname(anchor),
    `.skillpark-operation-${digest}-${role}`,
  );
  return {
    container,
    marker: join(container, "owner.json"),
    payload: join(container, "payload"),
  };
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

export function manualRecoveryError(message: string): Error {
  return new Error(`Manual recovery required: ${message}`);
}

export function attachCleanupError(
  primary: unknown,
  cleanup: unknown,
): unknown {
  if (!(primary instanceof Error)) return primary;
  const error = primary as ErrorWithCleanup;
  if (error.cleanupErrors === undefined) {
    Object.defineProperty(error, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: [],
      writable: true,
    });
  }
  error.cleanupErrors?.push(cleanup);
  return primary;
}

export async function inspectOperationArtifact(
  item: TransactionItem,
  role: OperationArtifactRole,
): Promise<OperationArtifactState> {
  const paths = operationArtifactPaths(item, role);
  let containerInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    containerInfo = await lstat(paths.container);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!containerInfo.isDirectory() || containerInfo.isSymbolicLink()) {
    return "unowned";
  }

  try {
    const markerInfo = await lstat(paths.marker);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) return "unowned";
    return (await readFile(paths.marker, "utf8")) ===
      operationOwnerMarker(item, role)
      ? "owned"
      : "unowned";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unowned";
    throw error;
  }
}

export async function requireOwnedOperationArtifact(
  item: TransactionItem,
  role: OperationArtifactRole,
): Promise<OperationArtifactPaths> {
  if ((await inspectOperationArtifact(item, role)) !== "owned") {
    throw manualRecoveryError(`unowned ${role} artifact for ${item.entryName}`);
  }
  return operationArtifactPaths(item, role);
}

export async function createOperationArtifact(
  item: TransactionItem,
  role: OperationArtifactRole,
  options: OperationArtifactOptions = {},
): Promise<OperationArtifactPaths> {
  const paths = operationArtifactPaths(item, role);
  if (await exists(paths.container)) {
    const state = await inspectOperationArtifact(item, role);
    throw manualRecoveryError(
      `${state === "owned" ? "existing owned" : "unowned"} ${role} artifact for ${item.entryName}`,
    );
  }

  await mkdir(paths.container, { mode: 0o700 });
  const writeMarker =
    options.writeMarker ??
    ((path: string, content: string) =>
      writeFile(path, content, { encoding: "utf8", flag: "wx" }));
  try {
    await writeMarker(paths.marker, operationOwnerMarker(item, role));
  } catch (error) {
    try {
      await rmdir(paths.container);
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }
  return paths;
}

export async function cleanupOwnedOperationArtifact(
  item: TransactionItem,
  role: OperationArtifactRole,
  options: OperationArtifactOptions = {},
): Promise<void> {
  const state = await inspectOperationArtifact(item, role);
  if (state === "absent") return;
  const paths = await requireOwnedOperationArtifact(item, role);
  const remove =
    options.remove ??
    ((path: string) => rm(path, { recursive: true, force: true }));

  if (await exists(paths.payload)) {
    await requireOwnedOperationArtifact(item, role);
    await remove(paths.payload);
  }

  await requireOwnedOperationArtifact(item, role);
  const remaining = (await readdir(paths.container)).sort();
  if (remaining.length !== 1 || remaining[0] !== "owner.json") {
    throw manualRecoveryError(
      `unexpected entries in owned ${role} artifact for ${item.entryName}`,
    );
  }
  await unlink(paths.marker);
  await rmdir(paths.container);
}

export async function cleanupOperationArtifactAfterFailure(
  item: TransactionItem,
  role: OperationArtifactRole,
  primary: unknown,
  options: OperationArtifactOptions = {},
): Promise<never> {
  try {
    await cleanupOwnedOperationArtifact(item, role, options);
  } catch (cleanupError) {
    attachCleanupError(primary, cleanupError);
  }
  throw primary;
}

export async function moveIntoOperationArtifact(
  item: TransactionItem,
  role: OperationArtifactRole,
  source: string,
  options: OperationArtifactOptions = {},
): Promise<OperationArtifactPaths> {
  const paths = await createOperationArtifact(item, role, options);
  const rename = options.rename ?? nodeRename;
  try {
    await rename(source, paths.payload);
  } catch (error) {
    await cleanupOperationArtifactAfterFailure(item, role, error, options);
  }
  return paths;
}
