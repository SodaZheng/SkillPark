import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestTree } from "../../src/storage/digest-tree.js";
import { executeTransaction } from "../../src/storage/execute-transaction.js";
import { createJournalStore } from "../../src/storage/journal.js";
import {
  createNodeItemExecutor,
  preflightTransaction,
} from "../../src/storage/node-item-executor.js";
import { operationArtifactPaths } from "../../src/storage/operation-artifacts.js";
import type {
  TransactionItem,
  TransactionPlan,
} from "../../src/storage/types.js";
import { makeTempHome } from "../support/fs.js";

function moveItem(source: string, destination: string): TransactionItem {
  return {
    id: "pdf",
    agent: "claude",
    entryName: "pdf",
    entryKind: "directory",
    operation: "move",
    source,
    destination,
  };
}

function planFor(item: TransactionItem): TransactionPlan {
  return {
    id: "transaction",
    action: "store",
    createdAt: "2026-07-16T00:00:00.000Z",
    items: [item],
  };
}

describe("digestTree", () => {
  it("produces a deterministic digest without following links", async () => {
    const home = await makeTempHome();
    const root = join(home, "tree");
    const external = join(home, "external");
    await mkdir(join(root, "nested"), { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(root, "nested", "SKILL.md"), "content");
    await writeFile(join(external, "outside.md"), "outside");
    await symlink(
      external,
      join(root, "linked"),
      process.platform === "win32" ? "junction" : undefined,
    );

    const first = await digestTree(root);
    const second = await digestTree(root);

    expect(first).toEqual(second);
    expect(first).toEqual([
      { path: ".", kind: "directory" },
      { path: "linked", kind: "link", target: external },
      { path: "nested", kind: "directory" },
      {
        path: join("nested", "SKILL.md"),
        kind: "file",
        size: 7,
        sha256: createHash("sha256").update("content").digest("hex"),
      },
    ]);
    expect(first.some((entry) => entry.path.includes("outside.md"))).toBe(
      false,
    );
  });
});

describe("preflightTransaction", () => {
  it("accepts sources with matching kinds and absent destinations", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    await mkdir(source, { recursive: true });

    await expect(
      preflightTransaction(
        planFor(moveItem(source, join(home, "parked", "pdf"))),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a missing source", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");

    await expect(
      preflightTransaction(
        planFor(moveItem(source, join(home, "parked", "pdf"))),
      ),
    ).rejects.toThrow(`Source disappeared: ${source}`);
  });

  it("rejects a source whose kind changed", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    await mkdir(join(home, "active"), { recursive: true });
    await writeFile(source, "not a directory");

    await expect(
      preflightTransaction(
        planFor(moveItem(source, join(home, "parked", "pdf"))),
      ),
    ).rejects.toThrow(`Source type changed: ${source}`);
  });

  it("rejects an existing destination", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });

    await expect(
      preflightTransaction(planFor(moveItem(source, destination))),
    ).rejects.toThrow(`Destination exists: ${destination}`);
  });

  it("rejects duplicate destinations within a plan", async () => {
    const home = await makeTempHome();
    const first = join(home, "active", "one");
    const second = join(home, "active", "two");
    const destination = join(home, "parked", "shared");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const plan: TransactionPlan = {
      ...planFor(moveItem(first, destination)),
      items: [
        { ...moveItem(first, destination), id: "one", entryName: "one" },
        { ...moveItem(second, destination), id: "two", entryName: "two" },
      ],
    };

    await expect(preflightTransaction(plan)).rejects.toThrow(
      `Duplicate destination: ${destination}`,
    );
  });

  it("rejects destinations that become duplicates after path normalization", async () => {
    const home = await makeTempHome();
    const first = join(home, "active", "one");
    const second = join(home, "active", "two");
    const destination = join(home, "parked", "shared");
    const equivalent = `${join(home, "parked", "nested")}/../shared`;
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const plan: TransactionPlan = {
      ...planFor(moveItem(first, destination)),
      items: [
        { ...moveItem(first, destination), id: "one", entryName: "one" },
        { ...moveItem(second, equivalent), id: "two", entryName: "two" },
      ],
    };

    await expect(preflightTransaction(plan)).rejects.toThrow(
      `Duplicate destination: ${equivalent}`,
    );
  });

  it.skipIf(process.platform !== "win32")(
    "rejects case-insensitive duplicate destinations on Windows",
    async () => {
      const home = await makeTempHome();
      const first = join(home, "active", "one");
      const second = join(home, "active", "two");
      const destination = join(home, "parked", "Shared");
      const equivalent = join(home, "parked", "shared");
      await mkdir(first, { recursive: true });
      await mkdir(second, { recursive: true });
      const plan: TransactionPlan = {
        ...planFor(moveItem(first, destination)),
        items: [
          { ...moveItem(first, destination), id: "one", entryName: "one" },
          { ...moveItem(second, equivalent), id: "two", entryName: "two" },
        ],
      };

      await expect(preflightTransaction(plan)).rejects.toThrow(
        `Duplicate destination: ${equivalent}`,
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "conservatively rejects case-insensitive duplicate destinations on macOS",
    async () => {
      const home = await makeTempHome();
      const first = join(home, "active", "one");
      const second = join(home, "active", "two");
      const destination = join(home, "parked", "Shared");
      const equivalent = join(home, "parked", "shared");
      await mkdir(first, { recursive: true });
      await mkdir(second, { recursive: true });
      const plan: TransactionPlan = {
        ...planFor(moveItem(first, destination)),
        items: [
          { ...moveItem(first, destination), id: "one", entryName: "one" },
          { ...moveItem(second, equivalent), id: "two", entryName: "two" },
        ],
      };

      await expect(preflightTransaction(plan)).rejects.toThrow(
        `Duplicate destination: ${equivalent}`,
      );
    },
  );
});

describe("node item executor", () => {
  it("falls back to verified copy when rename returns EXDEV", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "content");
    let injected = false;
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (!injected && from === source) {
          injected = true;
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
    });

    await executor.apply(moveItem(source, destination));

    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "content",
    );
    await expect(
      readFile(join(source, "SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates the source before starting an EXDEV copy", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "content");
    const item = moveItem(source, destination);
    const quarantine = operationArtifactPaths(item, "source-quarantine");
    let observedIsolation = false;
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source && to === destination) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async beforeFinalPlacement() {
        await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          readFile(join(quarantine.payload, "SKILL.md"), "utf8"),
        ).resolves.toBe("content");
        observedIsolation = true;
      },
    });

    await executor.apply(item);

    expect(observedIsolation).toBe(true);
    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "content",
    );
    await expect(access(quarantine.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails before copying when source isolation is denied", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "content");
    const item = moveItem(source, destination);
    const quarantine = operationArtifactPaths(item, "source-quarantine");
    const temporary = operationArtifactPaths(item, "destination-temp");
    const denied = Object.assign(new Error("source isolation denied"), {
      code: "EPERM",
    });
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source && to === destination) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async beforeSourceIsolation() {
        throw denied;
      },
    });

    await expect(executor.apply(item)).rejects.toBe(denied);

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "content",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(quarantine.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(temporary.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores an isolated source when an EXDEV copy fails before placement", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "content");
    const item = moveItem(source, destination);
    const quarantine = operationArtifactPaths(item, "source-quarantine");
    const temporary = operationArtifactPaths(item, "destination-temp");
    const interrupted = new Error("copy interrupted");
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source && to === destination) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async beforeFinalPlacement() {
        throw interrupted;
      },
    });

    await expect(executor.apply(item)).rejects.toBe(interrupted);

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "content",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(quarantine.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(temporary.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform === "win32")(
    "copies a read-only directory through writable staging and restores its mode",
    async () => {
      const home = await makeTempHome();
      const source = join(home, "active", "pdf");
      const destination = join(home, "parked", "pdf");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "SKILL.md"), "content");
      await chmod(source, 0o555);
      const executor = createNodeItemExecutor();

      await executor.apply({
        ...moveItem(source, destination),
        operation: "copy",
      });

      await expect(
        readFile(join(destination, "SKILL.md"), "utf8"),
      ).resolves.toBe("content");
      expect((await lstat(destination)).mode & 0o777).toBe(0o555);
      expect((await lstat(source)).mode & 0o777).toBe(0o555);
    },
  );

  it("preserves a link entry and its target text during EXDEV fallback", async () => {
    const home = await makeTempHome();
    const target = join(home, "external");
    const source = join(home, "active", "linked");
    const destination = join(home, "parked", "linked");
    await mkdir(join(home, "active"), { recursive: true });
    await mkdir(target, { recursive: true });
    await symlink(
      target,
      source,
      process.platform === "win32" ? "junction" : undefined,
    );
    const originalTarget = await readlink(source);
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
    });

    await executor.apply({
      id: "linked",
      agent: "claude",
      entryName: "linked",
      entryKind: "link",
      operation: "move",
      source,
      destination,
    });

    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    expect(await readlink(destination)).toBe(originalTarget);
    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a verified destination when quarantined source removal partially fails", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "content");
    await writeFile(join(source, "remaining.md"), "remaining");
    const item = moveItem(source, destination);
    const sourceQuarantine = operationArtifactPaths(item, "source-quarantine");
    const primary = Object.assign(new Error("partial source removal"), {
      code: "EACCES",
    });
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async remove(path) {
        if (path === sourceQuarantine.payload) {
          await rm(join(path, "SKILL.md"), { force: true });
          throw primary;
        }
        await rm(path, { recursive: true, force: true });
      },
    });
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );

    await expect(
      executeTransaction(planFor(item), executor, journals),
    ).rejects.toBe(primary);
    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "content",
    );
    await expect(
      readFile(join(destination, "remaining.md"), "utf8"),
    ).resolves.toBe("remaining");
    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(sourceQuarantine.payload, "remaining.md"), "utf8"),
    ).resolves.toBe("remaining");
    await expect(
      readFile(join(sourceQuarantine.payload, "SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await journals.list()).toEqual([
      expect.objectContaining({ states: { pdf: "running" } }),
    ]);
  });

  it("rebinds and re-verifies the source quarantine before deleting source content", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "before-copy");
    const item = moveItem(source, destination);
    const sourceQuarantine = operationArtifactPaths(item, "source-quarantine");
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source && to === destination) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async beforeFinalPlacement() {
        await writeFile(
          join(sourceQuarantine.payload, "SKILL.md"),
          "after-copy",
        );
      },
    });

    await expect(executor.apply(item)).rejects.toThrow(
      `Verification failed: ${source}`,
    );

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "after-copy",
    );
    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "before-copy",
    );
    await expect(
      access(operationArtifactPaths(item, "source-quarantine").container),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a destination created after preflight before a same-filesystem move", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    const item = moveItem(source, destination);
    await preflightTransaction(planFor(item));
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "occupant");
    const renameCalls: Array<[string, string]> = [];
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        renameCalls.push([from, to]);
        await rename(from, to);
      },
    });

    await expect(executor.apply(item)).rejects.toThrow(
      `Destination exists: ${destination}`,
    );

    expect(renameCalls).toEqual([]);
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "occupant",
    );
  });

  it("rejects an occupant created before EXDEV copy final placement", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    const item = moveItem(source, destination);
    await preflightTransaction(planFor(item));
    const renameCalls: Array<[string, string]> = [];
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        renameCalls.push([from, to]);
        if (from === source) {
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "SKILL.md"), "occupant");
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
    });

    await expect(executor.apply(item)).rejects.toThrow(
      `Destination exists: ${destination}`,
    );

    expect(renameCalls).toEqual([[source, destination]]);
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "occupant",
    );
    expect(await readdir(join(home, "parked"))).toEqual(["pdf"]);
  });

  it("rechecks after verified copy and before EXDEV final placement", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    const item = moveItem(source, destination);
    const renameCalls: Array<[string, string]> = [];
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        renameCalls.push([from, to]);
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async beforeFinalPlacement() {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "SKILL.md"), "occupant");
      },
    });

    await expect(executor.apply(item)).rejects.toThrow(
      `Destination exists: ${destination}`,
    );

    expect(renameCalls).toEqual([[source, destination]]);
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      "occupant",
    );
    expect(
      (await readdir(dirname(destination))).filter((name) =>
        name.startsWith(".skillpark-operation-"),
      ),
    ).toEqual([]);
  });

  it("keeps the primary placement error identity when owned-temp cleanup fails", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    const item = moveItem(source, destination);
    const temporary = operationArtifactPaths(item, "destination-temp");
    const primary = new Error("placement interrupted");
    const cleanup = new Error("temp cleanup failed");
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
        if (path === temporary.payload) throw cleanup;
        await rm(path, { recursive: true, force: true });
      },
    });

    await expect(executor.apply(item)).rejects.toBe(primary);
    expect(
      (primary as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([cleanup]);
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(temporary.payload, "SKILL.md"), "utf8"),
    ).resolves.toBe("source");
  });

  it("does not trust or clean a pre-existing unowned temp container", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    const item = moveItem(source, destination);
    const temporary = operationArtifactPaths(item, "destination-temp");
    await mkdir(temporary.payload, { recursive: true });
    await writeFile(join(temporary.payload, "occupant.md"), "unowned");
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
    });

    await expect(executor.apply(item)).rejects.toThrow(
      "Manual recovery required: unowned destination-temp artifact",
    );

    await expect(
      readFile(join(temporary.payload, "occupant.md"), "utf8"),
    ).resolves.toBe("unowned");
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recursively clean a container when exclusive marker creation fails", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    const item = moveItem(source, destination);
    const temporary = operationArtifactPaths(item, "destination-temp");
    const primary = new Error("marker write failed");
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async writeMarker(path, content) {
        if (path !== temporary.marker) {
          await writeFile(path, content, { encoding: "utf8", flag: "wx" });
          return;
        }
        await mkdir(join(dirname(path), "foreign"), { recursive: true });
        await writeFile(join(dirname(path), "foreign", "occupant.md"), "keep");
        throw primary;
      },
    });

    await expect(executor.apply(item)).rejects.toBe(primary);
    expect(
      (primary as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([expect.objectContaining({ code: "ENOTEMPTY" })]);
    await expect(
      readFile(join(temporary.container, "foreign", "occupant.md"), "utf8"),
    ).resolves.toBe("keep");
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-reads the exact marker before failed-placement temp cleanup", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    const item = moveItem(source, destination);
    const temporary = operationArtifactPaths(item, "destination-temp");
    const primary = new Error("placement interrupted");
    let removeCalled = false;
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
      async beforeFinalPlacement() {
        await writeFile(temporary.marker, "replacement marker");
        throw primary;
      },
      async remove(path) {
        if (path === temporary.payload) removeCalled = true;
        await rm(path, { recursive: true, force: true });
      },
    });

    await expect(executor.apply(item)).rejects.toBe(primary);
    expect(removeCalled).toBe(false);
    expect(
      (primary as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("unowned destination-temp artifact"),
      }),
    ]);
    await expect(
      readFile(join(temporary.payload, "SKILL.md"), "utf8"),
    ).resolves.toBe("source");
  });

  it("retains a verification error when quarantine restoration cleanup fails", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "installed", "pdf");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    await writeFile(join(destination, "SKILL.md"), "replacement");
    const item = {
      ...moveItem(source, destination),
      operation: "copy" as const,
    };
    const cleanup = new Error("restore cleanup failed");
    const executor = createNodeItemExecutor({
      async beforeQuarantineRestore() {
        throw cleanup;
      },
    });

    const rejection = await executor
      .revert(item)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("Verification failed");
    expect(
      (rejection as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([cleanup]);
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantine = operationArtifactPaths(item, "destination-quarantine");
    await expect(
      readFile(join(quarantine.payload, "SKILL.md"), "utf8"),
    ).resolves.toBe("replacement");
  });

  it("copies nested links without dereferencing their targets", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    const external = join(home, "external");
    await mkdir(source, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "source");
    await writeFile(join(external, "outside.md"), "outside");
    await symlink(
      external,
      join(source, "nested-link"),
      process.platform === "win32" ? "junction" : undefined,
    );
    const executor = createNodeItemExecutor({
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
    });

    await executor.apply(moveItem(source, destination));

    expect(
      (await lstat(join(destination, "nested-link"))).isSymbolicLink(),
    ).toBe(true);
    expect(await readlink(join(destination, "nested-link"))).toBe(external);
    await expect(
      readFile(join(destination, "nested-link", "outside.md"), "utf8"),
    ).resolves.toBe("outside");
    expect(
      (await readdir(destination)).filter((name) => name === "outside.md"),
    ).toEqual([]);
  });

  it("recreates a resolvable Windows directory link with directory type", async () => {
    const home = await makeTempHome();
    const target = join(home, "external");
    const source = join(home, "active", "linked");
    const destination = join(home, "parked", "linked");
    await mkdir(join(home, "active"), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "outside.md"), "outside");
    await symlink(
      target,
      source,
      process.platform === "win32" ? "junction" : undefined,
    );
    let requestedType: "dir" | "file" | "junction" | undefined;
    const executor = createNodeItemExecutor({
      platform: "win32",
      async createSymlink(targetText, path, type) {
        requestedType = type;
        await symlink(targetText, path, type);
      },
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
    });

    await executor.apply({
      ...moveItem(source, destination),
      entryKind: "link",
    });

    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    expect(await readlink(destination)).toBe(target);
    expect(requestedType).toBe("dir");
    await expect(
      readFile(join(destination, "outside.md"), "utf8"),
    ).resolves.toBe("outside");
  });

  it("preserves a relative Windows directory-symlink target", async () => {
    const home = await makeTempHome();
    const target = join(home, "external");
    const source = join(home, "active", "linked");
    const destination = join(home, "parked", "linked");
    await mkdir(join(home, "active"), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "outside.md"), "outside");
    await symlink(
      "../external",
      source,
      process.platform === "win32" ? "dir" : undefined,
    );
    let requestedType: "dir" | "file" | "junction" | undefined;
    const executor = createNodeItemExecutor({
      platform: "win32",
      async createSymlink(targetText, path, type) {
        requestedType = type;
        await symlink(targetText, path, type);
      },
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
    });

    await executor.apply({
      ...moveItem(source, destination),
      entryKind: "link",
    });

    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    expect(await readlink(destination)).toBe("../external");
    expect(requestedType).toBe("dir");
    await expect(
      readFile(join(destination, "outside.md"), "utf8"),
    ).resolves.toBe("outside");
  });

  it("classifies an internal relative Windows link from its pre-isolation location", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    await mkdir(join(source, "target"), { recursive: true });
    await writeFile(join(source, "target", "inside.md"), "inside");
    await symlink(
      "target",
      join(source, "nested-link"),
      process.platform === "win32" ? "dir" : undefined,
    );
    let requestedType: "dir" | "file" | "junction" | undefined;
    const executor = createNodeItemExecutor({
      platform: "win32",
      async createSymlink(targetText, path, type) {
        requestedType = type;
        await symlink(targetText, path, type);
      },
      async rename(from, to) {
        if (from === source && to === destination) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
    });

    await executor.apply(moveItem(source, destination));

    expect(requestedType).toBe("dir");
    expect(await readlink(join(destination, "nested-link"))).toBe("target");
    await expect(
      readFile(join(destination, "nested-link", "inside.md"), "utf8"),
    ).resolves.toBe("inside");
  });

  it.each([
    {
      label: "broken",
      targetKind: "missing" as const,
      expectedType: undefined,
    },
    { label: "file", targetKind: "file" as const, expectedType: "file" },
  ])(
    "copies a $label Windows link without dereferencing it",
    async ({ targetKind, expectedType }) => {
      const home = await makeTempHome();
      const target = join(home, "target");
      const source = join(home, "active", "linked");
      const destination = join(home, "parked", "linked");
      await mkdir(join(home, "active"), { recursive: true });
      if (targetKind === "file") await writeFile(target, "file");
      await symlink(target, source);
      let requestedType: "dir" | "file" | "junction" | undefined;
      const executor = createNodeItemExecutor({
        platform: "win32",
        async createSymlink(targetText, path, type) {
          requestedType = type;
          await symlink(targetText, path, type);
        },
        async rename(from, to) {
          if (from === source) {
            throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
          }
          await rename(from, to);
        },
      });

      await executor.apply({
        ...moveItem(source, destination),
        entryKind: "link",
      });

      expect((await lstat(destination)).isSymbolicLink()).toBe(true);
      expect(await readlink(destination)).toBe(target);
      expect(requestedType).toBe(expectedType);
      await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
      if (targetKind === "file") {
        await expect(readFile(target, "utf8")).resolves.toBe("file");
      }
    },
  );

  it("copies a nested broken Windows link without dereferencing it", async () => {
    const home = await makeTempHome();
    const source = join(home, "active", "pdf");
    const destination = join(home, "parked", "pdf");
    const target = join(home, "missing-target");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "content");
    await symlink(target, join(source, "nested-link"));
    const executor = createNodeItemExecutor({
      platform: "win32",
      async rename(from, to) {
        if (from === source) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await rename(from, to);
      },
    });

    await executor.apply(moveItem(source, destination));

    expect(
      (await lstat(join(destination, "nested-link"))).isSymbolicLink(),
    ).toBe(true);
    expect(await readlink(join(destination, "nested-link"))).toBe(target);
    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
