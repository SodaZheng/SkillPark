import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AGENT_IDS } from "../domain/agents.js";
import type { SourceStageRecovery } from "../sources/types.js";
import type { ItemState, TransactionPlan, TransactionRecord } from "./types.js";

export interface JournalStore {
  create(plan: TransactionPlan): Promise<TransactionRecord>;
  save(record: TransactionRecord): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<TransactionRecord[]>;
}

export const ABORTED_TAIL = "\u001eABORTED_TAIL";

const transactionActions = ["store", "restore", "add", "install"] as const;
const entryKinds = ["directory", "link"] as const;
const transactionOperations = ["move", "copy"] as const;
const itemStates = ["planned", "running", "completed", "reverted"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAllowedString(
  value: unknown,
  allowed: readonly string[],
): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function isSerializedIdentity(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.dev === "string" &&
    /^\d+$/.test(value.dev) &&
    typeof value.ino === "string" &&
    /^\d+$/.test(value.ino)
  );
}

function isSourceSpec(value: unknown): boolean {
  return (
    isObject(value) &&
    ((value.kind === "local" && isNonEmptyString(value.path)) ||
      (value.kind === "git" && isNonEmptyString(value.url)))
  );
}

function isSourceStageRecovery(value: unknown): value is SourceStageRecovery {
  return (
    isObject(value) &&
    value.version === 2 &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.tempRoot) &&
    isNonEmptyString(value.container) &&
    isNonEmptyString(value.marker) &&
    isNonEmptyString(value.payload) &&
    isNonEmptyString(value.isolatedPayload) &&
    isSerializedIdentity(value.tempRootIdentity) &&
    isSerializedIdentity(value.containerIdentity) &&
    isSerializedIdentity(value.payloadIdentity) &&
    isSerializedIdentity(value.markerIdentity) &&
    isSourceSpec(value.source)
  );
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

function isTransactionItem(value: unknown): boolean {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isAllowedString(value.agent, AGENT_IDS) &&
    isNonEmptyString(value.entryName) &&
    isAllowedString(value.entryKind, entryKinds) &&
    isAllowedString(value.operation, transactionOperations) &&
    isNonEmptyString(value.source) &&
    isNonEmptyString(value.destination)
  );
}

function isTransactionRecord(
  value: unknown,
  expectedId: string,
): value is TransactionRecord {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.id) ||
    value.id !== expectedId ||
    !isAllowedString(value.action, transactionActions) ||
    !isNonEmptyString(value.createdAt) ||
    !Array.isArray(value.items) ||
    !value.items.every(isTransactionItem) ||
    (value.sourceStage !== undefined &&
      !isSourceStageRecovery(value.sourceStage)) ||
    !isObject(value.states)
  ) {
    return false;
  }

  const items = value.items as TransactionRecord["items"];
  if (value.action === "add") {
    const sourceStage = value.sourceStage;
    if (
      items.some((item) => item.operation !== "copy") ||
      (sourceStage !== undefined &&
        (!isSourceStageRecovery(sourceStage) ||
          items.some(
            (item) => !containsPath(sourceStage.payload, item.source),
          )))
    ) {
      return false;
    }
  } else if (value.action === "install") {
    if (
      value.sourceStage !== undefined ||
      items.some((item) => item.operation !== "copy")
    ) {
      return false;
    }
  } else {
    if (
      value.sourceStage !== undefined ||
      items.some((item) => item.operation !== "move")
    ) {
      return false;
    }
  }

  const itemIds = new Set(
    value.items.map((item) => (item as Record<string, unknown>).id as string),
  );
  const stateEntries = Object.entries(value.states);
  return (
    itemIds.size === value.items.length &&
    stateEntries.length === itemIds.size &&
    stateEntries.every(
      ([itemId, state]) =>
        itemIds.has(itemId) && isAllowedString(state, itemStates),
    )
  );
}

async function writeAll(handle: FileHandle, data: string): Promise<void> {
  const buffer = Buffer.from(data, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesWritten === 0) {
      throw new Error("Unable to append transaction journal");
    }
    offset += bytesWritten;
  }
}

export function createJournalStore(root: string): JournalStore {
  const pathFor = (id: string) => join(root, `${id}.jsonl`);

  const corrupt = (path: string) =>
    new Error(`Corrupt transaction journal: ${path}`);

  const parseCompleteRecord = (
    fragment: string,
    path: string,
    expectedId: string,
  ): TransactionRecord => {
    let value: unknown;
    try {
      value = JSON.parse(fragment);
    } catch {
      throw corrupt(path);
    }
    if (!isTransactionRecord(value, expectedId)) throw corrupt(path);
    return value;
  };

  const save = async (record: TransactionRecord): Promise<void> => {
    await mkdir(root, { recursive: true });
    const handle = await open(pathFor(record.id), "a+");
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const lastByte = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(lastByte, 0, 1, size - 1);
        if (bytesRead !== 1) {
          throw new Error("Unable to inspect transaction journal tail");
        }
        if (lastByte[0] !== 0x0a) {
          await writeAll(handle, ABORTED_TAIL);
          await writeAll(handle, "\n");
          await handle.sync();
        }
      }

      await writeAll(handle, `${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  const create = async (plan: TransactionPlan): Promise<TransactionRecord> => {
    const states = Object.fromEntries(
      plan.items.map((item) => [item.id, "planned"]),
    ) as Record<string, ItemState>;
    const record = { ...plan, states };
    await save(record);
    return record;
  };

  return {
    create,
    save,
    async remove(id) {
      await rm(pathFor(id), { force: true });
    },
    async list() {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }

      return Promise.all(
        names
          .filter((name) => name.endsWith(".jsonl"))
          .sort()
          .map(async (name) => {
            const path = join(root, name);
            const content = await readFile(path, "utf8");
            const expectedId = name.slice(0, -".jsonl".length);
            const fragments = content.split("\n");
            fragments.pop();

            let latest: TransactionRecord | undefined;
            for (const fragment of fragments) {
              if (fragment.endsWith(ABORTED_TAIL)) continue;
              latest = parseCompleteRecord(fragment, path, expectedId);
            }
            if (!latest) throw corrupt(path);
            return latest;
          }),
      );
    },
  };
}
