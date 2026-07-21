import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ItemExecutor } from "../../src/storage/execute-transaction.js";
import type { JournalStore } from "../../src/storage/journal.js";
import { createJournalStore } from "../../src/storage/journal.js";
import {
  createNodeItemExecutor,
  reverseTransactionItem,
} from "../../src/storage/node-item-executor.js";
import {
  operationArtifactPaths,
  operationOwnerMarker,
  type OperationArtifactRole,
} from "../../src/storage/operation-artifacts.js";
import { recoverTransaction } from "../../src/storage/recover.js";
import type {
  ItemState,
  TransactionItem,
  TransactionRecord,
} from "../../src/storage/types.js";
import { makeTempHome } from "../support/fs.js";

function itemFor(
  source: string,
  destination: string,
  operation: TransactionItem["operation"] = "move",
): TransactionItem {
  return {
    id: "pdf",
    agent: "claude",
    entryName: "pdf",
    entryKind: "directory",
    operation,
    source,
    destination,
  };
}

function recordFor(item: TransactionItem, state: ItemState): TransactionRecord {
  return {
    id: "recovery",
    action: item.operation === "copy" ? "add" : "store",
    createdAt: "2026-07-16T00:00:00.000Z",
    items: [item],
    states: { [item.id]: state },
  };
}

const recoveryMatrix = (["move", "copy"] as const).flatMap((operation) =>
  (["planned", "running", "completed", "reverted"] as const).flatMap((state) =>
    (["source-only", "destination-only", "both", "neither"] as const).map(
      (layout) => ({
        operation,
        state,
        layout,
        automatic:
          operation === "move"
            ? layout === "source-only" ||
              (layout === "destination-only" &&
                (state === "running" || state === "completed"))
            : layout === "source-only" ||
              (layout === "both" && state === "completed"),
      }),
    ),
  ),
);

type ArtifactDirection = "forward" | "reverse";

interface ArtifactIdentity {
  direction: ArtifactDirection;
  role: OperationArtifactRole;
}

const forwardArtifacts: ArtifactIdentity[] = [
  { direction: "forward", role: "destination-temp" },
  { direction: "forward", role: "source-quarantine" },
  { direction: "forward", role: "destination-quarantine" },
];

const moveArtifacts: ArtifactIdentity[] = [
  ...forwardArtifacts,
  { direction: "reverse", role: "destination-temp" },
  { direction: "reverse", role: "source-quarantine" },
  { direction: "reverse", role: "destination-quarantine" },
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

const artifactStateMatrix = (["move", "copy"] as const).flatMap((operation) =>
  (["planned", "running", "completed", "reverted"] as const).flatMap((state) =>
    (operation === "move" ? moveArtifacts : forwardArtifacts).map(
      ({ direction, role }) => {
        const key = `${operation}:${state}:${direction}:${role}`;
        return {
          operation,
          state,
          direction,
          role,
          allowed: allowedArtifactStates.has(key),
        };
      },
    ),
  ),
);

function directedItem(
  item: TransactionItem,
  direction: ArtifactDirection,
): TransactionItem {
  return direction === "forward" ? item : reverseTransactionItem(item);
}

async function createOwnedMarkerOnlyArtifact(
  item: TransactionItem,
  direction: ArtifactDirection,
  role: OperationArtifactRole,
): Promise<ReturnType<typeof operationArtifactPaths>> {
  const artifactItem = directedItem(item, direction);
  const paths = operationArtifactPaths(artifactItem, role);
  await mkdir(paths.container, { recursive: true });
  await writeFile(paths.marker, operationOwnerMarker(artifactItem, role));
  return paths;
}

describe("recoverTransaction", () => {
  it.each(artifactStateMatrix)(
    "enforces $operation/$state with $direction $role artifact",
    async ({ operation, state, direction, role, allowed }) => {
      const home = await makeTempHome();
      const source = join(home, "active", "pdf");
      const destination = join(home, "parked", "pdf");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "SKILL.md"), "source");
      const item = itemFor(source, destination, operation);
      const record = recordFor(item, state);
      const artifact = await createOwnedMarkerOnlyArtifact(
        item,
        direction,
        role,
      );
      const marker = await readFile(artifact.marker, "utf8");
      const journals = createJournalStore(
        join(home, ".skillpark", ".transactions"),
      );
      await journals.save(record);

      const recovery = recoverTransaction(
        record,
        createNodeItemExecutor(),
        journals,
      );
      if (allowed) {
        await recovery;
        await expect(access(artifact.container)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await journals.list()).toEqual([]);
      } else {
        await expect(recovery).rejects.toThrow(
          `Manual recovery required: ${direction} ${role} artifact is incompatible with ${operation}/${state}`,
        );
        await expect(readFile(artifact.marker, "utf8")).resolves.toBe(marker);
        await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
          "source",
        );
        expect((await journals.list())[0]?.states).toEqual({ pdf: state });
      }
    },
  );

  it("preserves a planned move with both paths and a forward source-quarantine marker", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "same");
    await writeFile(join(destination, "SKILL.md"), "same");
    const item = itemFor(source, destination);
    const record = recordFor(item, "planned");
    const artifact = await createOwnedMarkerOnlyArtifact(
      item,
      "forward",
      "source-quarantine",
    );
    const marker = await readFile(artifact.marker, "utf8");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow(
      "Manual recovery required: forward source-quarantine artifact is incompatible with move/planned",
    );

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "same",
    );
    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "same",
    );
    await expect(readFile(artifact.marker, "utf8")).resolves.toBe(marker);
    expect((await journals.list())[0]?.states).toEqual({ pdf: "planned" });
  });

  it("rejects multiple individually allowed artifacts before changing either", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    const item = itemFor(source, destination);
    const record = recordFor(item, "running");
    const forward = await createOwnedMarkerOnlyArtifact(
      item,
      "forward",
      "destination-temp",
    );
    const reverse = await createOwnedMarkerOnlyArtifact(
      item,
      "reverse",
      "destination-temp",
    );
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow(
      "Manual recovery required: multiple operation artifacts for pdf",
    );

    await expect(readFile(forward.marker, "utf8")).resolves.toBe(
      operationOwnerMarker(item, "destination-temp"),
    );
    await expect(readFile(reverse.marker, "utf8")).resolves.toBe(
      operationOwnerMarker(reverseTransactionItem(item), "destination-temp"),
    );
    expect((await journals.list())[0]?.states).toEqual({ pdf: "running" });
  });

  it("preflights a later artifact-state contradiction before cleaning an earlier item", async () => {
    const home = await makeTempHome();
    const firstSource = join(home, "active", "one");
    const firstDestination = join(home, "parked", "one");
    const secondSource = join(home, "active", "two");
    const secondDestination = join(home, "parked", "two");
    await mkdir(firstSource, { recursive: true });
    await mkdir(secondSource, { recursive: true });
    await writeFile(join(firstSource, "SKILL.md"), "one");
    await writeFile(join(secondSource, "SKILL.md"), "two");
    const first = {
      ...itemFor(firstSource, firstDestination),
      id: "one",
      entryName: "one",
    };
    const second = {
      ...itemFor(secondSource, secondDestination),
      id: "two",
      entryName: "two",
    };
    const firstArtifact = await createOwnedMarkerOnlyArtifact(
      first,
      "forward",
      "destination-temp",
    );
    const secondArtifact = await createOwnedMarkerOnlyArtifact(
      second,
      "forward",
      "source-quarantine",
    );
    const record: TransactionRecord = {
      id: "global-preflight",
      action: "store",
      createdAt: "2026-07-16T00:00:00.000Z",
      items: [first, second],
      states: { one: "running", two: "planned" },
    };
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow("artifact is incompatible with move/planned");

    await expect(readFile(firstArtifact.marker, "utf8")).resolves.toBe(
      operationOwnerMarker(first, "destination-temp"),
    );
    await expect(readFile(secondArtifact.marker, "utf8")).resolves.toBe(
      operationOwnerMarker(second, "source-quarantine"),
    );
    expect((await journals.list())[0]?.states).toEqual({
      one: "running",
      two: "planned",
    });
  });

  it("preflights every state before cleaning an artifact", async () => {
    const home = await makeTempHome();
    const missingSource = join(home, "active", "missing");
    const missingDestination = join(home, "parked", "missing");
    const artifactSource = join(home, "active", "artifact");
    const artifactDestination = join(home, "parked", "artifact");
    await mkdir(missingSource, { recursive: true });
    await mkdir(artifactSource, { recursive: true });
    await writeFile(join(missingSource, "SKILL.md"), "missing");
    await writeFile(join(artifactSource, "SKILL.md"), "artifact");
    const missing = {
      ...itemFor(missingSource, missingDestination),
      id: "missing",
      entryName: "missing",
    };
    const artifactItem = {
      ...itemFor(artifactSource, artifactDestination),
      id: "artifact",
      entryName: "artifact",
    };
    const artifact = await createOwnedMarkerOnlyArtifact(
      artifactItem,
      "forward",
      "destination-temp",
    );
    const persisted: TransactionRecord = {
      id: "missing-state-preflight",
      action: "store",
      createdAt: "2026-07-16T00:00:00.000Z",
      items: [missing, artifactItem],
      states: { missing: "planned", artifact: "running" },
    };
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(persisted);
    const record: TransactionRecord = {
      ...persisted,
      states: { artifact: "running" },
    };

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow("Manual recovery required: missing state for missing");

    await expect(readFile(artifact.marker, "utf8")).resolves.toBe(
      operationOwnerMarker(artifactItem, "destination-temp"),
    );
    expect((await journals.list())[0]?.states).toEqual({
      missing: "planned",
      artifact: "running",
    });
  });

  it.each(recoveryMatrix)(
    "reconciles $operation/$state with $layout paths",
    async ({ operation, state, layout, automatic }) => {
      const home = await makeTempHome();
      const source = join(home, "active", "pdf");
      const destination = join(home, "parked", "pdf");
      if (layout === "source-only" || layout === "both") {
        await mkdir(source, { recursive: true });
        await writeFile(join(source, "SKILL.md"), "same");
      }
      if (layout === "destination-only" || layout === "both") {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "SKILL.md"), "same");
      }
      const item = itemFor(source, destination, operation);
      const record = recordFor(item, state);
      const journals = createJournalStore(
        join(home, ".skillpark", ".transactions"),
      );
      await journals.save(record);

      const recovery = recoverTransaction(
        record,
        createNodeItemExecutor(),
        journals,
      );
      if (automatic) {
        await recovery;
        expect(await journals.list()).toEqual([]);
        await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
          "same",
        );
        await expect(access(destination)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        await expect(recovery).rejects.toThrow("Manual recovery required");
        expect(await journals.list()).toHaveLength(1);
        if (layout === "source-only" || layout === "both") {
          await expect(
            readFile(join(source, "SKILL.md"), "utf8"),
          ).resolves.toBe("same");
        }
        if (layout === "destination-only" || layout === "both") {
          await expect(
            readFile(join(destination, "SKILL.md"), "utf8"),
          ).resolves.toBe("same");
        }
      }
    },
  );

  it("moves a completed destination back to its original source", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "pdf");
    const record = recordFor(itemFor(source, destination), "completed");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await recoverTransaction(record, createNodeItemExecutor(), journals);

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "pdf",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await journals.list()).toEqual([]);
  });

  it("recovers a running move that reached its destination before a crash", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "pdf");
    const record = recordFor(itemFor(source, destination), "running");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await recoverTransaction(record, createNodeItemExecutor(), journals);

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "pdf",
    );
    expect(await journals.list()).toEqual([]);
  });

  it("requires manual recovery rather than deleting either of two move copies", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    await writeFile(join(destination, "SKILL.md"), "occupant");
    const record = recordFor(itemFor(source, destination), "running");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow(`Manual recovery required: ${source} and ${destination}`);

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "occupant",
    );
    expect(await journals.list()).toHaveLength(1);
  });

  it("removes a verified completed copy while preserving its source", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "installed", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "pdf");
    await writeFile(join(destination, "SKILL.md"), "pdf");
    const record = recordFor(itemFor(source, destination, "copy"), "completed");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await recoverTransaction(record, createNodeItemExecutor(), journals);

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "pdf",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await journals.list()).toEqual([]);
  });

  it("preserves the only safe copy when the copy source is missing", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "installed", "pdf");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "only copy");
    const record = recordFor(itemFor(source, destination, "copy"), "completed");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow("Manual recovery required: copy source missing for pdf");

    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "only copy",
    );
    expect(await journals.list()).toHaveLength(1);
  });

  it("preserves a destination for a copy that was never started", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "installed", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    await writeFile(join(destination, "SKILL.md"), "occupant");
    const record = recordFor(itemFor(source, destination, "copy"), "planned");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow(
      "Manual recovery required: unexpected copy destination for pdf",
    );

    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "occupant",
    );
    expect(await journals.list()).toHaveLength(1);
  });

  it("preserves an ambiguous destination for a running copy", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "installed", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "same content");
    await writeFile(join(destination, "SKILL.md"), "same content");
    const record = recordFor(itemFor(source, destination, "copy"), "running");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow("Manual recovery required: ambiguous copy for pdf");

    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "same content",
    );
    expect(await journals.list()).toHaveLength(1);
  });

  it("preserves a changed completed copy for manual recovery", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "installed", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    await writeFile(join(destination, "SKILL.md"), "changed");
    const record = recordFor(itemFor(source, destination, "copy"), "completed");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow(
      "Manual recovery required: copied content changed for pdf",
    );

    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "changed",
    );
    expect(await journals.list()).toHaveLength(1);
  });

  it("cleans an owned crash temp before removing a running journal", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "pdf");
    const item = itemFor(source, destination);
    const record = recordFor(item, "running");
    const temporary = operationArtifactPaths(item, "destination-temp");
    const primary = new Error("crash before placement");
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async beforeFinalPlacement() {
        throw primary;
      },
      async remove(path) {
        if (path === temporary.payload) throw new Error("simulated crash");
        await rm(path, { recursive: true, force: true });
      },
    });
    await expect(executor.apply(item)).rejects.toBe(primary);
    await expect(
      readFile(join(temporary.payload, "SKILL.md"), "utf8"),
    ).resolves.toBe("pdf");
    await expect(readFile(temporary.marker, "utf8")).resolves.toBe(
      `${JSON.stringify({
        version: 1,
        itemId: item.id,
        role: "destination-temp",
        source: resolve(item.source),
        destination: resolve(item.destination),
      })}\n`,
    );
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await recoverTransaction(record, createNodeItemExecutor(), journals);

    await expect(access(temporary.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "pdf",
    );
    expect(await journals.list()).toEqual([]);
  });

  it.each([
    { label: "missing", marker: undefined },
    { label: "mismatched", marker: "not-this-operation" },
  ])(
    "preserves a temp with a $label owner marker and retains its journal",
    async ({ marker }) => {
      const home = await makeTempHome();
      const source = join(home, "active", "pdf");
      const destination = join(home, "parked", "pdf");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "SKILL.md"), "source");
      const item = itemFor(source, destination);
      const record = recordFor(item, "running");
      const temporary = operationArtifactPaths(item, "destination-temp");
      await mkdir(temporary.payload, { recursive: true });
      await writeFile(join(temporary.payload, "occupant.md"), "unowned");
      if (marker !== undefined) await writeFile(temporary.marker, marker);
      const journals = createJournalStore(
        join(home, ".skillpark", ".transactions"),
      );
      await journals.save(record);

      await expect(
        recoverTransaction(record, createNodeItemExecutor(), journals),
      ).rejects.toThrow(
        "Manual recovery required: unowned destination-temp artifact",
      );

      await expect(
        readFile(join(temporary.payload, "occupant.md"), "utf8"),
      ).resolves.toBe("unowned");
      await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
        "source",
      );
      expect(await journals.list()).toHaveLength(1);
    },
  );

  it("preflights every artifact owner before cleaning any owned artifact", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "pdf");
    const item = itemFor(source, destination);
    const record = recordFor(item, "running");
    const temporary = operationArtifactPaths(item, "destination-temp");
    const quarantine = operationArtifactPaths(item, "destination-quarantine");
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async beforeFinalPlacement() {
        throw new Error("leave owned temp");
      },
      async remove(path) {
        if (path === temporary.payload) throw new Error("keep owned temp");
        await rm(path, { recursive: true, force: true });
      },
    });
    await expect(executor.apply(item)).rejects.toThrow("leave owned temp");
    await mkdir(quarantine.payload, { recursive: true });
    await writeFile(join(quarantine.payload, "occupant.md"), "unowned");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow(
      "Manual recovery required: unowned destination-quarantine artifact",
    );

    await expect(
      readFile(join(temporary.payload, "SKILL.md"), "utf8"),
    ).resolves.toBe("pdf");
    await expect(
      readFile(join(quarantine.payload, "occupant.md"), "utf8"),
    ).resolves.toBe("unowned");
    expect(await journals.list()).toHaveLength(1);
  });

  it("re-digests the isolated destination and preserves a replacement made after the first digest", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "installed", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "original");
    await writeFile(join(destination, "SKILL.md"), "original");
    const item = itemFor(source, destination, "copy");
    const record = recordFor(item, "completed");
    const nodeExecutor = createNodeItemExecutor();
    const executor: ItemExecutor = {
      apply: nodeExecutor.apply,
      async revert(current) {
        await rm(destination, { recursive: true });
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "SKILL.md"), "replacement");
        await nodeExecutor.revert(current);
      },
    };
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, executor, journals),
    ).rejects.toThrow("Verification failed");

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "original",
    );
    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "replacement",
    );
    expect(await journals.list()).toHaveLength(1);
  });

  it("does not overwrite a new occupant when quarantine restoration is needed", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "installed", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "original");
    await writeFile(join(destination, "SKILL.md"), "original");
    const item = itemFor(source, destination, "copy");
    const record = recordFor(item, "completed");
    const quarantine = operationArtifactPaths(item, "destination-quarantine");
    const nodeExecutor = createNodeItemExecutor({
      async beforeQuarantineRestore() {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "SKILL.md"), "late occupant");
      },
    });
    const executor: ItemExecutor = {
      apply: nodeExecutor.apply,
      async revert(current) {
        await rm(destination, { recursive: true });
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "SKILL.md"), "replacement");
        await nodeExecutor.revert(current);
      },
    };
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    const rejection = await recoverTransaction(
      record,
      executor,
      journals,
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("Verification failed");
    expect(
      (rejection as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          "Manual recovery required: quarantine restore destination exists",
        ),
      }),
    ]);

    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "late occupant",
    );
    await expect(
      readFile(join(quarantine.payload, "SKILL.md"), "utf8"),
    ).resolves.toBe("replacement");
    expect(await journals.list()).toHaveLength(1);
  });

  it("recovers a full owned source quarantine but preserves partial quarantine for manual recovery", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "pdf");
    const item = itemFor(source, destination);
    const sourceQuarantine = operationArtifactPaths(item, "source-quarantine");
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source && to === destination) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async remove(path) {
        if (path === sourceQuarantine.payload) {
          throw new Error("crash before source cleanup");
        }
        await rm(path, { recursive: true, force: true });
      },
    });
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    const record = recordFor(item, "running");
    await journals.save(record);
    await expect(executor.apply(item)).rejects.toThrow(
      "crash before source cleanup",
    );

    await recoverTransaction(record, createNodeItemExecutor(), journals);

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "pdf",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(sourceQuarantine.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await journals.list()).toEqual([]);
  });

  it("resumes cleanup of an owned destination quarantine before journal removal", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "installed", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "pdf");
    await writeFile(join(destination, "SKILL.md"), "pdf");
    const item = itemFor(source, destination, "copy");
    const record = recordFor(item, "completed");
    const quarantine = operationArtifactPaths(item, "destination-quarantine");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);
    const failingExecutor = createNodeItemExecutor({
      async remove(path) {
        if (path === quarantine.payload) throw new Error("cleanup interrupted");
        await rm(path, { recursive: true, force: true });
      },
    });

    await expect(
      recoverTransaction(record, failingExecutor, journals),
    ).rejects.toThrow("cleanup interrupted");
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(quarantine.payload, "SKILL.md"), "utf8"),
    ).resolves.toBe("pdf");
    expect(await journals.list()).toHaveLength(1);

    const [persisted] = await journals.list();
    if (persisted === undefined) throw new Error("missing recovery record");
    await recoverTransaction(persisted, createNodeItemExecutor(), journals);

    await expect(access(quarantine.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "pdf",
    );
    expect(await journals.list()).toEqual([]);
  });

  it("preserves a source and partially removed destination quarantine", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "installed", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "pdf");
    await writeFile(join(source, "remaining.md"), "remaining");
    await writeFile(join(destination, "SKILL.md"), "pdf");
    await writeFile(join(destination, "remaining.md"), "remaining");
    const item = itemFor(source, destination, "copy");
    const record = recordFor(item, "completed");
    const quarantine = operationArtifactPaths(item, "destination-quarantine");
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);
    const primary = new Error("partial destination cleanup");
    const executor = createNodeItemExecutor({
      async remove(path) {
        if (path === quarantine.payload) {
          await rm(join(path, "SKILL.md"), { force: true });
          throw primary;
        }
        await rm(path, { recursive: true, force: true });
      },
    });

    await expect(recoverTransaction(record, executor, journals)).rejects.toBe(
      primary,
    );

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "pdf",
    );
    await expect(
      readFile(join(quarantine.payload, "remaining.md"), "utf8"),
    ).resolves.toBe("remaining");
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await journals.list()).toHaveLength(1);

    const [persisted] = await journals.list();
    if (persisted === undefined) throw new Error("missing recovery record");
    await writeFile(join(quarantine.container, "unexpected"), "preserve me");
    let recoveryError: unknown;
    try {
      await recoverTransaction(persisted, createNodeItemExecutor(), journals);
    } catch (error) {
      recoveryError = error;
    }
    expect(recoveryError).toBeInstanceOf(Error);
    expect((recoveryError as Error).message).toBe(
      "Manual recovery required: copied content changed for pdf",
    );
    expect(
      (recoveryError as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toHaveLength(1);
    expect(
      (recoveryError as Error & { cleanupErrors?: Error[] }).cleanupErrors?.[0]
        ?.message,
    ).toBe(
      "Manual recovery required: unexpected entries in owned destination-quarantine artifact for pdf",
    );
    await expect(
      readFile(join(destination, "remaining.md"), "utf8"),
    ).resolves.toBe("remaining");
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "pdf",
    );
    expect(await journals.list()).toHaveLength(1);
  });

  it("retains a reverted filesystem and journal when journal save fails", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "pdf");
    const record = recordFor(itemFor(source, destination), "completed");
    const real = createJournalStore(join(home, ".skillpark", ".transactions"));
    await real.save(record);
    const primary = new Error("journal save failed");
    const failing: JournalStore = {
      ...real,
      async save() {
        throw primary;
      },
    };

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), failing),
    ).rejects.toBe(primary);
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "pdf",
    );
    expect((await real.list())[0]?.states).toEqual({ pdf: "completed" });

    const [persisted] = await real.list();
    if (persisted === undefined) throw new Error("missing recovery record");
    await recoverTransaction(persisted, createNodeItemExecutor(), real);
    expect(await real.list()).toEqual([]);
  });

  it("retains a fully reverted journal when journal removal fails", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "pdf");
    const record = recordFor(itemFor(source, destination), "completed");
    const real = createJournalStore(join(home, ".skillpark", ".transactions"));
    await real.save(record);
    const primary = new Error("journal remove failed");
    const failing: JournalStore = {
      ...real,
      async remove() {
        throw primary;
      },
    };

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), failing),
    ).rejects.toBe(primary);
    expect((await real.list())[0]?.states).toEqual({ pdf: "reverted" });

    const [persisted] = await real.list();
    if (persisted === undefined) throw new Error("missing recovery record");
    await recoverTransaction(persisted, createNodeItemExecutor(), real);
    expect(await real.list()).toEqual([]);
  });

  it("persists reverse-order progress when an earlier item is ambiguous", async () => {
    const home = await makeTempHome();
    const firstSource = join(home, "active", "one");
    const firstDestination = join(home, "parked", "one");
    const secondSource = join(home, "active", "two");
    const secondDestination = join(home, "parked", "two");
    await mkdir(firstSource, { recursive: true });
    await mkdir(firstDestination, { recursive: true });
    await mkdir(secondDestination, { recursive: true });
    await writeFile(join(firstSource, "SKILL.md"), "source");
    await writeFile(join(firstDestination, "SKILL.md"), "occupant");
    await writeFile(join(secondDestination, "SKILL.md"), "two");
    const first = { ...itemFor(firstSource, firstDestination), id: "one" };
    const second = { ...itemFor(secondSource, secondDestination), id: "two" };
    const record: TransactionRecord = {
      id: "multi-recovery",
      action: "store",
      createdAt: "2026-07-16T00:00:00.000Z",
      items: [first, second],
      states: { one: "completed", two: "completed" },
    };
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save(record);

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals),
    ).rejects.toThrow(
      `Manual recovery required: ${firstSource} and ${firstDestination}`,
    );

    await expect(
      readFile(join(secondSource, "SKILL.md"), "utf8"),
    ).resolves.toBe("two");
    expect((await journals.list())[0]?.states).toEqual({
      one: "completed",
      two: "reverted",
    });
  });

  it("does not enable missing-source recovery for a forged non-add record", async () => {
    const home = await makeTempHome();
    const source = join(home, "stage", "payload", "pdf");
    const destination = join(home, "parked", "pdf");
    const item = itemFor(source, destination, "copy");
    const tempRoot = join(home, "stage");
    const container = join(tempRoot, ".skillpark-stage-forged");
    const record: TransactionRecord = {
      id: "forged-recovery",
      action: "store",
      createdAt: "2026-07-16T00:00:00.000Z",
      sourceStage: {
        version: 2,
        id: "forged",
        tempRoot,
        container,
        marker: join(container, "owner.json"),
        payload: join(home, "stage", "payload"),
        isolatedPayload: join(container, ".cleanup-payload-forged"),
        tempRootIdentity: { dev: "1", ino: "2" },
        containerIdentity: { dev: "1", ino: "3" },
        payloadIdentity: { dev: "1", ino: "4" },
        markerIdentity: { dev: "1", ino: "5" },
        source: { kind: "local", path: join(home, "input") },
      },
      items: [item],
      states: { pdf: "reverted" },
    };
    let removed = false;
    const journals: JournalStore = {
      async create() {
        throw new Error("unexpected create");
      },
      async save() {},
      async remove() {
        removed = true;
      },
      async list() {
        return [record];
      },
    };

    await expect(
      recoverTransaction(record, createNodeItemExecutor(), journals, {
        allowMissingRevertedCopySource: true,
      }),
    ).rejects.toThrow("Manual recovery required");
    expect(removed).toBe(false);
  });
});
