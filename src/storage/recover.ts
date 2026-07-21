import { lstat, rename } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { digestTree } from "./digest-tree.js";
import type { ItemExecutor } from "./execute-transaction.js";
import type { JournalStore } from "./journal.js";
import { reverseTransactionItem } from "./node-item-executor.js";
import {
  attachCleanupError,
  cleanupOwnedOperationArtifact,
  inspectOperationArtifact,
  manualRecoveryError,
  requireOwnedOperationArtifact,
  type OperationArtifactRole,
} from "./operation-artifacts.js";
import type { ItemState, TransactionItem, TransactionRecord } from "./types.js";

const artifactRoles: OperationArtifactRole[] = [
  "destination-temp",
  "source-quarantine",
  "destination-quarantine",
];

type ArtifactDirection = "forward" | "reverse";

interface ArtifactIdentity {
  direction: ArtifactDirection;
  role: OperationArtifactRole;
}

interface ItemArtifactEvidence {
  item: TransactionItem;
  state: ItemState;
  owned: ArtifactIdentity[];
}

const forwardArtifactIdentities: ArtifactIdentity[] = artifactRoles.map(
  (role) => ({ direction: "forward", role }),
);

const moveArtifactIdentities: ArtifactIdentity[] = [
  ...forwardArtifactIdentities,
  ...artifactRoles.map(
    (role): ArtifactIdentity => ({
      direction: "reverse",
      role,
    }),
  ),
];

const allowedArtifactStates = new Set([
  "move:running:forward:destination-temp",
  "move:running:forward:source-quarantine",
  "move:running:forward:destination-quarantine",
  "move:running:reverse:destination-temp",
  "move:running:reverse:source-quarantine",
  "move:completed:reverse:destination-temp",
  "move:completed:reverse:source-quarantine",
  "copy:running:forward:destination-temp",
  "copy:completed:forward:destination-quarantine",
]);

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function mayHaveRun(state: ItemState): boolean {
  return state === "running" || state === "completed";
}

function containsPath(container: string, candidate: string): boolean {
  const difference = relative(resolve(container), resolve(candidate));
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

function validateRecordOperationSemantics(record: TransactionRecord): void {
  if (record.action === "add" || record.action === "install") {
    if (record.items.some((item) => item.operation !== "copy")) {
      throw manualRecoveryError(
        `${record.action} transaction contains a non-copy item`,
      );
    }
    if (record.action === "add") {
      if (
        record.sourceStage !== undefined &&
        record.items.some(
          (item) =>
            !containsPath(record.sourceStage?.payload ?? "", item.source),
        )
      ) {
        throw manualRecoveryError(
          "add transaction source is outside its source stage",
        );
      }
    } else if (record.sourceStage !== undefined) {
      throw manualRecoveryError(
        "install transaction carries source-stage ownership",
      );
    }
    return;
  }
  if (
    record.sourceStage !== undefined ||
    record.items.some((item) => item.operation !== "move")
  ) {
    throw manualRecoveryError(
      "non-add transaction has incompatible recovery semantics",
    );
  }
}

function digestsMatch(
  first: Awaited<ReturnType<typeof digestTree>>,
  second: Awaited<ReturnType<typeof digestTree>>,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function artifactItems(item: TransactionItem): TransactionItem[] {
  return item.operation === "move"
    ? [item, reverseTransactionItem(item)]
    : [item];
}

function artifactIdentities(item: TransactionItem): ArtifactIdentity[] {
  return item.operation === "move"
    ? moveArtifactIdentities
    : forwardArtifactIdentities;
}

function directedItem(
  item: TransactionItem,
  direction: ArtifactDirection,
): TransactionItem {
  return direction === "forward" ? item : reverseTransactionItem(item);
}

function artifactAllowed(
  item: TransactionItem,
  state: ItemState,
  identity: ArtifactIdentity,
): boolean {
  return allowedArtifactStates.has(
    `${item.operation}:${state}:${identity.direction}:${identity.role}`,
  );
}

async function preflightRecovery(record: TransactionRecord): Promise<void> {
  const states = new Map<TransactionItem, ItemState>();
  for (const item of record.items) {
    const state = record.states[item.id];
    if (state === undefined) {
      throw manualRecoveryError(`missing state for ${item.entryName}`);
    }
    states.set(item, state);
  }

  const evidence: ItemArtifactEvidence[] = [];
  for (const item of record.items) {
    const owned: ArtifactIdentity[] = [];
    for (const identity of artifactIdentities(item)) {
      const state = await inspectOperationArtifact(
        directedItem(item, identity.direction),
        identity.role,
      );
      if (state === "unowned") {
        throw manualRecoveryError(
          `unowned ${identity.role} artifact for ${item.entryName}`,
        );
      }
      if (state === "owned") owned.push(identity);
    }
    const state = states.get(item);
    if (state === undefined) throw new Error("unreachable missing item state");
    evidence.push({ item, state, owned });
  }

  for (const { item, state, owned } of evidence) {
    if (owned.length > 1) {
      throw manualRecoveryError(
        `multiple operation artifacts for ${item.entryName}`,
      );
    }
    const [identity] = owned;
    if (identity !== undefined && !artifactAllowed(item, state, identity)) {
      throw manualRecoveryError(
        `${identity.direction} ${identity.role} artifact is incompatible with ${item.operation}/${state}`,
      );
    }
  }
}

async function recoverDestinationTemp(item: TransactionItem): Promise<void> {
  const state = await inspectOperationArtifact(item, "destination-temp");
  if (state === "absent") return;
  const paths = await requireOwnedOperationArtifact(item, "destination-temp");
  if ((await exists(paths.payload)) && !(await exists(item.source))) {
    throw manualRecoveryError(
      `destination-temp may be the only copy for ${item.entryName}`,
    );
  }
  await cleanupOwnedOperationArtifact(item, "destination-temp");
}

async function restoreOwnedPayload(
  item: TransactionItem,
  role: OperationArtifactRole,
  destination: string,
  primary?: unknown,
): Promise<void> {
  try {
    const paths = await requireOwnedOperationArtifact(item, role);
    if (await exists(destination)) {
      throw manualRecoveryError(
        `quarantine restore destination exists: ${destination}`,
      );
    }
    await requireOwnedOperationArtifact(item, role);
    await rename(paths.payload, destination);
    await cleanupOwnedOperationArtifact(item, role);
  } catch (cleanupError) {
    if (primary === undefined) throw cleanupError;
    attachCleanupError(primary, cleanupError);
    throw primary;
  }
  if (primary !== undefined) throw primary;
}

async function recoverDestinationQuarantine(
  item: TransactionItem,
): Promise<void> {
  const state = await inspectOperationArtifact(item, "destination-quarantine");
  if (state === "absent") return;
  const paths = await requireOwnedOperationArtifact(
    item,
    "destination-quarantine",
  );
  if (!(await exists(paths.payload))) {
    await cleanupOwnedOperationArtifact(item, "destination-quarantine");
    return;
  }
  if (!(await exists(item.source))) {
    throw manualRecoveryError(
      `destination-quarantine may be the only copy for ${item.entryName}`,
    );
  }

  const [sourceDigest, quarantineDigest] = await Promise.all([
    digestTree(item.source),
    digestTree(paths.payload),
  ]);
  if (digestsMatch(sourceDigest, quarantineDigest)) {
    await cleanupOwnedOperationArtifact(item, "destination-quarantine");
    return;
  }
  if (await exists(item.destination)) {
    throw manualRecoveryError(
      `changed destination-quarantine and occupied destination for ${item.entryName}`,
    );
  }
  await restoreOwnedPayload(
    item,
    "destination-quarantine",
    item.destination,
    manualRecoveryError(`copied content changed for ${item.entryName}`),
  );
}

async function removeKnownDestinationCopy(
  item: TransactionItem,
  executor: ItemExecutor,
): Promise<void> {
  await executor.revert({ ...item, operation: "copy" });
}

async function recoverForwardSourceQuarantine(
  item: TransactionItem,
  executor: ItemExecutor,
): Promise<void> {
  const state = await inspectOperationArtifact(item, "source-quarantine");
  if (state === "absent") return;
  const paths = await requireOwnedOperationArtifact(item, "source-quarantine");
  const sourceExists = await exists(item.source);
  const destinationExists = await exists(item.destination);

  if (!(await exists(paths.payload))) {
    await cleanupOwnedOperationArtifact(item, "source-quarantine");
    if (sourceExists && destinationExists) {
      await removeKnownDestinationCopy(item, executor);
    }
    return;
  }
  if (sourceExists || !destinationExists) {
    throw manualRecoveryError(
      `ambiguous source-quarantine paths for ${item.entryName}`,
    );
  }

  const [quarantineDigest, destinationDigest] = await Promise.all([
    digestTree(paths.payload),
    digestTree(item.destination),
  ]);
  if (!digestsMatch(quarantineDigest, destinationDigest)) {
    throw manualRecoveryError(
      `partially removed source-quarantine for ${item.entryName}`,
    );
  }

  await restoreOwnedPayload(item, "source-quarantine", item.source);
  await removeKnownDestinationCopy(item, executor);
}

async function recoverReverseSourceQuarantine(
  item: TransactionItem,
): Promise<void> {
  const state = await inspectOperationArtifact(item, "source-quarantine");
  if (state === "absent") return;
  const paths = await requireOwnedOperationArtifact(item, "source-quarantine");
  if (!(await exists(paths.payload))) {
    await cleanupOwnedOperationArtifact(item, "source-quarantine");
    return;
  }
  if ((await exists(item.source)) || !(await exists(item.destination))) {
    throw manualRecoveryError(
      `ambiguous rollback source-quarantine paths for ${item.entryName}`,
    );
  }
  const [quarantineDigest, destinationDigest] = await Promise.all([
    digestTree(paths.payload),
    digestTree(item.destination),
  ]);
  if (!digestsMatch(quarantineDigest, destinationDigest)) {
    throw manualRecoveryError(
      `partially removed rollback source-quarantine for ${item.entryName}`,
    );
  }
  await cleanupOwnedOperationArtifact(item, "source-quarantine");
}

async function recoverArtifacts(
  item: TransactionItem,
  state: ItemState,
  executor: ItemExecutor,
): Promise<void> {
  if (item.operation === "copy") {
    if (state === "running") await recoverDestinationTemp(item);
    if (state === "completed") await recoverDestinationQuarantine(item);
    return;
  }

  if (state === "running") {
    await recoverDestinationTemp(item);
    await recoverForwardSourceQuarantine(item, executor);
    await recoverDestinationQuarantine(item);
  }
  if (state === "running" || state === "completed") {
    const reversed = reverseTransactionItem(item);
    await recoverDestinationTemp(reversed);
    await recoverReverseSourceQuarantine(reversed);
  }
}

async function requireArtifactsAbsent(
  record: TransactionRecord,
): Promise<void> {
  for (const item of record.items) {
    for (const artifactItem of artifactItems(item)) {
      for (const role of artifactRoles) {
        if ((await inspectOperationArtifact(artifactItem, role)) !== "absent") {
          throw manualRecoveryError(
            `${role} artifact remains for ${item.entryName}`,
          );
        }
      }
    }
  }
}

async function recoverMove(
  item: TransactionItem,
  state: ItemState,
  executor: ItemExecutor,
): Promise<void> {
  const sourceExists = await exists(item.source);
  const destinationExists = await exists(item.destination);
  if (sourceExists && !destinationExists) return;
  if (sourceExists && destinationExists) {
    throw manualRecoveryError(`${item.source} and ${item.destination}`);
  }
  if (!sourceExists && !destinationExists) {
    throw manualRecoveryError(`both paths missing for ${item.entryName}`);
  }
  if (!mayHaveRun(state)) {
    throw manualRecoveryError(
      `unexpected move destination for ${item.entryName}`,
    );
  }
  await executor.revert(item);
}

async function recoverCopy(
  item: TransactionItem,
  state: ItemState,
  executor: ItemExecutor,
  allowMissingRevertedSource: boolean,
): Promise<void> {
  const sourceExists = await exists(item.source);
  const destinationExists = await exists(item.destination);
  if (
    allowMissingRevertedSource &&
    state === "reverted" &&
    !destinationExists
  ) {
    return;
  }
  if (!sourceExists) {
    throw manualRecoveryError(`copy source missing for ${item.entryName}`);
  }
  if (!destinationExists) return;
  if (!mayHaveRun(state)) {
    throw manualRecoveryError(
      `unexpected copy destination for ${item.entryName}`,
    );
  }
  if (state === "running") {
    throw manualRecoveryError(`ambiguous copy for ${item.entryName}`);
  }

  const [sourceDigest, destinationDigest] = await Promise.all([
    digestTree(item.source),
    digestTree(item.destination),
  ]);
  if (!digestsMatch(sourceDigest, destinationDigest)) {
    throw manualRecoveryError(`copied content changed for ${item.entryName}`);
  }
  await executor.revert(item);
}

export async function recoverTransaction(
  record: TransactionRecord,
  executor: ItemExecutor,
  journals: JournalStore,
  options: {
    allowMissingRevertedCopySource?: boolean;
    beforeJournalRemoval?(): Promise<void>;
  } = {},
): Promise<void> {
  validateRecordOperationSemantics(record);
  if (
    options.allowMissingRevertedCopySource === true &&
    (record.action !== "add" || record.sourceStage === undefined)
  ) {
    throw manualRecoveryError(
      "missing copy sources require an owned add source stage",
    );
  }
  await preflightRecovery(record);
  for (const item of [...record.items].reverse()) {
    const state = record.states[item.id];
    if (state === undefined) {
      throw manualRecoveryError(`missing state for ${item.entryName}`);
    }
    await recoverArtifacts(item, state, executor);
    if (item.operation === "move") {
      await recoverMove(item, state, executor);
    } else {
      await recoverCopy(
        item,
        state,
        executor,
        options.allowMissingRevertedCopySource === true,
      );
    }
    record.states[item.id] = "reverted";
    await journals.save(record);
  }
  await requireArtifactsAbsent(record);
  await options.beforeJournalRemoval?.();
  await journals.remove(record.id);
}
