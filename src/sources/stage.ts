import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sourceEntryName } from "./entry-name.js";
import type {
  ProcessRunner,
  SerializedObjectIdentity,
  SourceSpec,
  SourceStageRecovery,
  StagedSource,
} from "./types.js";

type ErrorWithCleanup = Error & { cleanupErrors?: unknown[] };
type CleanupPhase =
  | "active"
  | "isolated"
  | "marker-only"
  | "marker-removed"
  | "cleaned";

interface ObjectIdentity {
  dev: bigint;
  ino: bigint;
}

interface StageArtifact {
  id: string;
  tempRoot: string;
  container: string;
  marker: string;
  payload: string;
  isolatedPayload: string;
  markerContent: string;
  tempRootIdentity: ObjectIdentity;
  containerIdentity: ObjectIdentity;
  payloadIdentity: ObjectIdentity;
  markerIdentity: ObjectIdentity;
  phase: CleanupPhase;
}

const maximumContainerAttempts = 8;

function attachCleanupError(primary: unknown, cleanup: unknown): void {
  if (!(primary instanceof Error)) return;
  try {
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
  } catch {
    // A frozen primary error still takes precedence over cleanup diagnostics.
  }
}

function manualCleanup(message: string): Error {
  return new Error(`Manual cleanup required: ${message}`);
}

function objectIdentity(info: { dev: bigint; ino: bigint }): ObjectIdentity {
  return { dev: info.dev, ino: info.ino };
}

function serializeIdentity(identity: ObjectIdentity): SerializedObjectIdentity {
  return { dev: String(identity.dev), ino: String(identity.ino) };
}

function deserializeIdentity(
  identity: SerializedObjectIdentity,
): ObjectIdentity {
  if (!/^\d+$/.test(identity.dev) || !/^\d+$/.test(identity.ino)) {
    throw manualCleanup("invalid persisted staging identity");
  }
  return { dev: BigInt(identity.dev), ino: BigInt(identity.ino) };
}

function stageRecoveryDescriptor(
  artifact: StageArtifact,
  source: SourceSpec,
): SourceStageRecovery {
  return {
    version: 2,
    id: artifact.id,
    tempRoot: resolve(artifact.tempRoot),
    container: resolve(artifact.container),
    marker: resolve(artifact.marker),
    payload: resolve(artifact.payload),
    isolatedPayload: resolve(artifact.isolatedPayload),
    tempRootIdentity: serializeIdentity(artifact.tempRootIdentity),
    containerIdentity: serializeIdentity(artifact.containerIdentity),
    payloadIdentity: serializeIdentity(artifact.payloadIdentity),
    markerIdentity: serializeIdentity(artifact.markerIdentity),
    source,
  };
}

export function sourceStageOwnerMarker(stage: SourceStageRecovery): string {
  return `${JSON.stringify({
    version: stage.version,
    id: stage.id,
    role: "source-stage",
    tempRoot: stage.tempRoot,
    container: stage.container,
    marker: stage.marker,
    payload: stage.payload,
    isolatedPayload: stage.isolatedPayload,
    tempRootIdentity: stage.tempRootIdentity,
    containerIdentity: stage.containerIdentity,
    payloadIdentity: stage.payloadIdentity,
    source: stage.source,
  })}\n`;
}

function sameIdentity(
  info: { dev: bigint; ino: bigint },
  expected: ObjectIdentity,
): boolean {
  return info.dev === expected.dev && info.ino === expected.ino;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function requireDirectoryIdentity(
  path: string,
  expected: ObjectIdentity,
  label: string,
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw manualCleanup(`${label} disappeared: ${path}`);
    }
    throw error;
  }
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    !sameIdentity(info, expected)
  ) {
    throw manualCleanup(`${label} identity changed: ${path}`);
  }
}

async function requireTempRoot(artifact: StageArtifact): Promise<void> {
  await requireDirectoryIdentity(
    artifact.tempRoot,
    artifact.tempRootIdentity,
    "staging temp root",
  );
}

async function requireContainer(artifact: StageArtifact): Promise<void> {
  await requireTempRoot(artifact);
  await requireDirectoryIdentity(
    artifact.container,
    artifact.containerIdentity,
    "staging container",
  );
}

async function requireMarker(artifact: StageArtifact): Promise<void> {
  await requireContainer(artifact);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(artifact.marker, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw manualCleanup(`owner marker disappeared: ${artifact.marker}`);
    }
    throw error;
  }
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    !sameIdentity(info, artifact.markerIdentity)
  ) {
    throw manualCleanup(`owner marker type changed: ${artifact.marker}`);
  }
  if ((await readFile(artifact.marker, "utf8")) !== artifact.markerContent) {
    throw manualCleanup(`owner marker changed: ${artifact.marker}`);
  }
}

async function requireEntries(
  artifact: StageArtifact,
  expected: readonly string[],
): Promise<void> {
  const actual = (await readdir(artifact.container)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw manualCleanup(
      `unexpected staging container entries: ${artifact.container}`,
    );
  }
}

async function requireActiveArtifact(artifact: StageArtifact): Promise<void> {
  await requireMarker(artifact);
  await requireDirectoryIdentity(
    artifact.payload,
    artifact.payloadIdentity,
    "staging payload",
  );
  await requireEntries(artifact, ["owner.json", "payload"]);
  await requireMarker(artifact);
}

async function requireIsolatedArtifact(artifact: StageArtifact): Promise<void> {
  await requireMarker(artifact);
  await requireDirectoryIdentity(
    artifact.isolatedPayload,
    artifact.payloadIdentity,
    "isolated staging payload",
  );
  await requireEntries(artifact, [
    "owner.json",
    basename(artifact.isolatedPayload),
  ]);
  await requireMarker(artifact);
}

async function requireMarkerOnlyArtifact(
  artifact: StageArtifact,
): Promise<void> {
  await requireMarker(artifact);
  await requireEntries(artifact, ["owner.json"]);
  await requireMarker(artifact);
}

async function cleanupStageArtifact(artifact: StageArtifact): Promise<void> {
  if (artifact.phase === "cleaned") return;

  if (artifact.phase === "active") {
    await requireActiveArtifact(artifact);
    await rename(artifact.payload, artifact.isolatedPayload);
    artifact.phase = "isolated";
    await requireIsolatedArtifact(artifact);
  }

  if (artifact.phase === "isolated") {
    await requireIsolatedArtifact(artifact);
    try {
      await rm(artifact.isolatedPayload, { recursive: true, force: false });
      artifact.phase = "marker-only";
    } catch (error) {
      try {
        if (!(await pathExists(artifact.isolatedPayload))) {
          artifact.phase = "marker-only";
        }
      } catch (probeError) {
        attachCleanupError(error, probeError);
      }
      throw error;
    }
  }

  if (artifact.phase === "marker-only") {
    await requireMarkerOnlyArtifact(artifact);
    try {
      await unlink(artifact.marker);
      artifact.phase = "marker-removed";
    } catch (error) {
      try {
        if (!(await pathExists(artifact.marker))) {
          artifact.phase = "marker-removed";
        }
      } catch (probeError) {
        attachCleanupError(error, probeError);
      }
      throw error;
    }
  }

  if (artifact.phase === "marker-removed") {
    await requireContainer(artifact);
    await requireEntries(artifact, []);
    await rmdir(artifact.container);
    artifact.phase = "cleaned";
  }
}

async function cleanupAfterFailure(
  artifact: StageArtifact,
  primary: unknown,
): Promise<never> {
  try {
    await cleanupStageArtifact(artifact);
  } catch (cleanupError) {
    attachCleanupError(primary, cleanupError);
  }
  throw primary;
}

async function removeEmptyCreatedContainer(
  container: string,
  expected: ObjectIdentity,
): Promise<void> {
  await requireDirectoryIdentity(container, expected, "staging container");
  if ((await readdir(container)).length !== 0) {
    throw manualCleanup(`non-empty unmarked staging container: ${container}`);
  }
  await rmdir(container);
}

async function removeUnmarkedPayloadCreatedContainer(
  artifact: StageArtifact,
): Promise<void> {
  await requireContainer(artifact);
  if (await pathExists(artifact.marker)) {
    throw manualCleanup(`partially written owner marker: ${artifact.marker}`);
  }
  await requireDirectoryIdentity(
    artifact.payload,
    artifact.payloadIdentity,
    "new staging payload",
  );
  await requireEntries(artifact, ["payload"]);
  await rename(artifact.payload, artifact.isolatedPayload);
  await requireContainer(artifact);
  await requireDirectoryIdentity(
    artifact.isolatedPayload,
    artifact.payloadIdentity,
    "isolated new staging payload",
  );
  await requireEntries(artifact, [basename(artifact.isolatedPayload)]);
  await rm(artifact.isolatedPayload, { recursive: true, force: false });
  await requireContainer(artifact);
  await requireEntries(artifact, []);
  await rmdir(artifact.container);
  artifact.phase = "cleaned";
}

async function createStageArtifact(
  source: SourceSpec,
  tempRoot: string,
): Promise<StageArtifact> {
  await mkdir(tempRoot, { recursive: true });
  const tempInfo = await lstat(tempRoot, { bigint: true });
  if (tempInfo.isSymbolicLink() || !tempInfo.isDirectory()) {
    throw new Error(`Unsafe staging temp root: ${tempRoot}`);
  }
  const tempRootIdentity = objectIdentity(tempInfo);

  for (let attempt = 0; attempt < maximumContainerAttempts; attempt += 1) {
    const id = randomUUID();
    const container = join(tempRoot, `.skillpark-stage-${id}`);
    try {
      await mkdir(container, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }

    const containerInfo = await lstat(container, { bigint: true });
    if (containerInfo.isSymbolicLink() || !containerInfo.isDirectory()) {
      throw manualCleanup(`new staging container changed: ${container}`);
    }
    const containerIdentity = objectIdentity(containerInfo);
    const marker = join(container, "owner.json");
    const payload = join(container, "payload");
    const isolatedPayload = join(container, `.cleanup-payload-${id}`);

    const partialArtifact: StageArtifact = {
      id,
      tempRoot,
      container,
      marker,
      payload,
      isolatedPayload,
      markerContent: "",
      tempRootIdentity,
      containerIdentity,
      payloadIdentity: { dev: -1n, ino: -1n },
      markerIdentity: { dev: -1n, ino: -1n },
      phase: "active",
    };
    try {
      await mkdir(payload, { mode: 0o700 });
    } catch (error) {
      try {
        await removeEmptyCreatedContainer(container, containerIdentity);
      } catch (cleanupError) {
        attachCleanupError(error, cleanupError);
      }
      throw error;
    }

    const payloadInfo = await lstat(payload, { bigint: true });
    if (payloadInfo.isSymbolicLink() || !payloadInfo.isDirectory()) {
      throw manualCleanup(`new staging payload changed: ${payload}`);
    }
    partialArtifact.payloadIdentity = objectIdentity(payloadInfo);
    partialArtifact.phase = "active";
    const descriptor = stageRecoveryDescriptor(partialArtifact, source);
    partialArtifact.markerContent = sourceStageOwnerMarker(descriptor);
    try {
      await writeFile(marker, partialArtifact.markerContent, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      try {
        await removeUnmarkedPayloadCreatedContainer(partialArtifact);
      } catch (cleanupError) {
        attachCleanupError(error, cleanupError);
      }
      throw error;
    }
    const markerInfo = await lstat(marker, { bigint: true });
    if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) {
      throw manualCleanup(`new owner marker changed: ${marker}`);
    }
    partialArtifact.markerIdentity = objectIdentity(markerInfo);
    await requireActiveArtifact(partialArtifact);
    return partialArtifact;
  }

  throw new Error(
    `Unable to allocate an exclusive staging container in ${tempRoot}`,
  );
}

async function requireLocalSource(path: string): Promise<ObjectIdentity> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Local source must be a real directory: ${path}`);
  }
  return objectIdentity(info);
}

async function requireLocalSourceIdentity(
  path: string,
  expected: ObjectIdentity,
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Local source changed during staging: ${path}`);
    }
    throw error;
  }
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    !sameIdentity(info, expected)
  ) {
    throw new Error(`Local source changed during staging: ${path}`);
  }
}

async function copyLocalSource(
  source: string,
  sourceIdentity: ObjectIdentity,
  artifact: StageArtifact,
): Promise<void> {
  await requireLocalSourceIdentity(source, sourceIdentity);
  const names = await readdir(source);
  await requireLocalSourceIdentity(source, sourceIdentity);
  for (const name of names) {
    await requireLocalSourceIdentity(source, sourceIdentity);
    await requireActiveArtifact(artifact);
    await cp(join(source, name), join(artifact.payload, name), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    await requireLocalSourceIdentity(source, sourceIdentity);
    await requireActiveArtifact(artifact);
  }
}

export async function stageSource(
  source: SourceSpec,
  tempRoot: string,
  runner: ProcessRunner,
): Promise<StagedSource> {
  const rootEntryName = sourceEntryName(source);
  const localSourceIdentity =
    source.kind === "local" ? await requireLocalSource(source.path) : undefined;
  const artifact = await createStageArtifact(source, tempRoot);

  try {
    if (source.kind === "local") {
      if (localSourceIdentity === undefined) {
        throw new Error("Missing local source identity");
      }
      await copyLocalSource(source.path, localSourceIdentity, artifact);
    } else {
      await runner.run("git", [
        "clone",
        "--depth",
        "1",
        "--",
        source.url,
        artifact.payload,
      ]);
    }
    await requireActiveArtifact(artifact);
  } catch (error) {
    await cleanupAfterFailure(artifact, error);
  }

  return {
    root: artifact.payload,
    rootEntryName,
    sourceStage: stageRecoveryDescriptor(artifact, source),
    cleanup: () => cleanupStageArtifact(artifact),
  };
}

function pathIsInside(container: string, candidate: string): boolean {
  const difference = relative(resolve(container), resolve(candidate));
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

function recoveredArtifact(stage: SourceStageRecovery): StageArtifact {
  if (stage.version !== 2 || !/^[A-Za-z0-9-]+$/.test(stage.id)) {
    throw manualCleanup("invalid source-stage descriptor");
  }
  const expectedContainer = join(
    stage.tempRoot,
    `.skillpark-stage-${stage.id}`,
  );
  if (
    resolve(stage.container) !== resolve(expectedContainer) ||
    resolve(stage.marker) !== resolve(join(expectedContainer, "owner.json")) ||
    resolve(stage.payload) !== resolve(join(expectedContainer, "payload")) ||
    resolve(stage.isolatedPayload) !==
      resolve(join(expectedContainer, `.cleanup-payload-${stage.id}`))
  ) {
    throw manualCleanup("invalid source-stage path descriptor");
  }
  return {
    id: stage.id,
    tempRoot: stage.tempRoot,
    container: stage.container,
    marker: stage.marker,
    payload: stage.payload,
    isolatedPayload: stage.isolatedPayload,
    markerContent: sourceStageOwnerMarker(stage),
    tempRootIdentity: deserializeIdentity(stage.tempRootIdentity),
    containerIdentity: deserializeIdentity(stage.containerIdentity),
    payloadIdentity: deserializeIdentity(stage.payloadIdentity),
    markerIdentity: deserializeIdentity(stage.markerIdentity),
    phase: "active",
  };
}

function retainedStageArtifact(
  stage: SourceStageRecovery,
  expectedTempRoot: string,
  itemSources: readonly string[],
): StageArtifact {
  if (resolve(stage.tempRoot) !== resolve(expectedTempRoot)) {
    throw manualCleanup("source stage is outside the expected temp root");
  }
  if (
    itemSources.length === 0 ||
    itemSources.some((source) => !pathIsInside(stage.payload, source))
  ) {
    throw manualCleanup("transaction source is outside its retained stage");
  }

  return recoveredArtifact(stage);
}

async function inspectRetainedStageArtifact(
  artifact: StageArtifact,
  requireActive: boolean,
): Promise<CleanupPhase> {
  await requireTempRoot(artifact);
  if (!(await pathExists(artifact.container))) {
    if (requireActive) {
      throw manualCleanup(
        `staging container disappeared: ${artifact.container}`,
      );
    }
    return "cleaned";
  }
  await requireContainer(artifact);

  const entries = (await readdir(artifact.container)).sort();
  const markerPresent = entries.includes("owner.json");
  if (!markerPresent) {
    if (entries.length !== 0) {
      throw manualCleanup(
        `unexpected unmarked staging container entries: ${artifact.container}`,
      );
    }
    if (requireActive) {
      throw manualCleanup(`owner marker disappeared: ${artifact.marker}`);
    }
    return "marker-removed";
  }

  await requireMarker(artifact);
  const payloadPresent = entries.includes("payload");
  const isolatedName = basename(artifact.isolatedPayload);
  const isolatedPresent = entries.includes(isolatedName);
  if (payloadPresent && isolatedPresent) {
    throw manualCleanup(`multiple staging payloads: ${artifact.container}`);
  }
  if (payloadPresent) {
    await requireActiveArtifact(artifact);
    return "active";
  } else if (isolatedPresent) {
    if (requireActive) {
      throw manualCleanup(
        `active staging payload disappeared: ${artifact.payload}`,
      );
    }
    await requireIsolatedArtifact(artifact);
    return "isolated";
  }
  if (requireActive) {
    throw manualCleanup(
      `active staging payload disappeared: ${artifact.payload}`,
    );
  }
  await requireMarkerOnlyArtifact(artifact);
  return "marker-only";
}

export async function preflightRetainedSourceStage(
  stage: SourceStageRecovery,
  expectedTempRoot: string,
  itemSources: readonly string[],
  requireActive: boolean,
): Promise<void> {
  const artifact = retainedStageArtifact(stage, expectedTempRoot, itemSources);
  await inspectRetainedStageArtifact(artifact, requireActive);
}

export async function cleanupRetainedSourceStage(
  stage: SourceStageRecovery,
  expectedTempRoot: string,
  itemSources: readonly string[],
): Promise<void> {
  const artifact = retainedStageArtifact(stage, expectedTempRoot, itemSources);
  artifact.phase = await inspectRetainedStageArtifact(artifact, false);
  if (artifact.phase === "cleaned") return;
  if (artifact.phase === "marker-removed") {
    await requireContainer(artifact);
    await requireEntries(artifact, []);
    await rmdir(artifact.container);
    artifact.phase = "cleaned";
    return;
  }
  await cleanupStageArtifact(artifact);
}
