import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeProcessRunner } from "../../src/sources/process-runner.js";
import {
  sourceStageOwnerMarker,
  stageSource,
} from "../../src/sources/stage.js";
import { makeTempHome } from "../support/fs.js";

const mocks = vi.hoisted(() => {
  let stageCounter = 0;
  const stageIds: string[] = [];
  return {
    afterIsolation: undefined as
      | ((isolatedPath: string) => Promise<void>)
      | undefined,
    afterReaddir: undefined as
      | { path: string; action(): Promise<void> }
      | undefined,
    cleanupFailure: undefined as Error | undefined,
    copyCalls: 0,
    lstatFailure: undefined as { path: string; error: Error } | undefined,
    markerFailure: undefined as Error | undefined,
    ownerWrites: 0,
    probeFailure: undefined as Error | undefined,
    randomUUID: vi.fn(() => stageIds.shift() ?? `stage-${++stageCounter}`),
    resetStageIds() {
      stageCounter = 0;
      stageIds.length = 0;
    },
    spawn: vi.fn(),
    stageIds,
    unlinkFailure: undefined as Error | undefined,
  };
});

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:crypto", () => ({ randomUUID: mocks.randomUUID }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    cp: async (...args: Parameters<typeof actual.cp>) => {
      mocks.copyCalls += 1;
      return actual.cp(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const failure = mocks.lstatFailure;
      if (failure !== undefined && String(args[0]) === failure.path) {
        mocks.lstatFailure = undefined;
        throw failure.error;
      }
      return actual.lstat(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const result = await actual.readdir(...args);
      const hook = mocks.afterReaddir;
      if (hook !== undefined && String(args[0]) === hook.path) {
        mocks.afterReaddir = undefined;
        await hook.action();
      }
      return result;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      const hook = mocks.afterIsolation;
      if (hook !== undefined && String(args[1]).includes(".cleanup-payload-")) {
        mocks.afterIsolation = undefined;
        await hook(String(args[1]));
      }
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const failure = mocks.cleanupFailure;
      mocks.cleanupFailure = undefined;
      if (failure !== undefined) {
        const probeFailure = mocks.probeFailure;
        mocks.probeFailure = undefined;
        if (probeFailure !== undefined) {
          mocks.lstatFailure = { path: String(args[0]), error: probeFailure };
        }
        throw failure;
      }
      return actual.rm(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      const failure = mocks.unlinkFailure;
      mocks.unlinkFailure = undefined;
      if (failure !== undefined) {
        const probeFailure = mocks.probeFailure;
        mocks.probeFailure = undefined;
        if (probeFailure !== undefined) {
          mocks.lstatFailure = { path: String(args[0]), error: probeFailure };
        }
        throw failure;
      }
      return actual.unlink(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (basename(String(args[0])) === "owner.json") {
        mocks.ownerWrites += 1;
      }
      const failure = mocks.markerFailure;
      if (failure !== undefined && basename(String(args[0])) === "owner.json") {
        mocks.markerFailure = undefined;
        throw failure;
      }
      return actual.writeFile(...args);
    },
  };
});

afterEach(() => {
  mocks.afterIsolation = undefined;
  mocks.cleanupFailure = undefined;
  mocks.markerFailure = undefined;
  mocks.ownerWrites = 0;
  mocks.lstatFailure = undefined;
  mocks.probeFailure = undefined;
  mocks.unlinkFailure = undefined;
  mocks.afterReaddir = undefined;
  mocks.copyCalls = 0;
  mocks.randomUUID.mockClear();
  mocks.resetStageIds();
  mocks.spawn.mockReset();
});

describe("nodeProcessRunner", () => {
  it("spawns an argument array with shell execution disabled", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child as ChildProcess;
    });

    await nodeProcessRunner.run("git", ["--version"]);

    expect(mocks.spawn).toHaveBeenCalledWith("git", ["--version"], {
      shell: false,
      stdio: "ignore",
    });
  });

  it("rejects non-zero process exits", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 7));
      return child as ChildProcess;
    });

    await expect(nodeProcessRunner.run("git", ["status"])).rejects.toThrow(
      "git exited with code 7",
    );
  });

  it("reports the terminating signal when no exit code exists", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return child as ChildProcess;
    });

    await expect(nodeProcessRunner.run("git", ["status"])).rejects.toThrow(
      "git terminated by signal SIGTERM",
    );
  });

  it("preserves a spawn error and removes the competing exit listener", async () => {
    const child = new EventEmitter();
    const primary = new Error("spawn failed");
    mocks.spawn.mockReturnValue(child as ChildProcess);

    const running = nodeProcessRunner.run("git", ["status"]);
    child.emit("error", primary);

    await expect(running).rejects.toBe(primary);
    expect(child.listenerCount("exit")).toBe(0);
    child.emit("exit", 7);
  });

  it("removes the competing error listener after a successful exit", async () => {
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child as ChildProcess);

    const running = nodeProcessRunner.run("git", ["status"]);
    child.emit("exit", 0);

    await expect(running).resolves.toBeUndefined();
    expect(child.listenerCount("error")).toBe(0);
  });
});

describe("stageSource", () => {
  it("publishes one immutable recovery marker after payload identity is known", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();

    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );

    expect(mocks.ownerWrites).toBe(1);
    expect(await readFile(staged.sourceStage.marker, "utf8")).toBe(
      sourceStageOwnerMarker(staged.sourceStage),
    );
  });

  it.each([
    { kind: "local" as const, path: "/tmp/.hidden-source" },
    { kind: "local" as const, path: "/tmp/CON" },
    { kind: "git" as const, url: "https://example.test/owner/.git" },
    { kind: "git" as const, url: "https://example.test/owner/trailing..git" },
  ])(
    "rejects an unsafe derived entry name before staging %#",
    async (source) => {
      const parent = await makeTempHome();
      const tempRoot = join(parent, "not-created");
      const run = vi.fn();

      await expect(stageSource(source, tempRoot, { run })).rejects.toThrow(
        "Unsafe source entry name",
      );
      expect(run).not.toHaveBeenCalled();
      await expect(lstat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("invokes git clone with exact arguments and no string shell command", async () => {
    const tempRoot = await makeTempHome();
    const run = vi.fn(async (_command: string, args: string[]) => {
      const destination = args.at(-1);
      if (destination === undefined) throw new Error("missing destination");
      expect((await lstat(destination)).isDirectory()).toBe(true);
      expect(await readdir(destination)).toEqual([]);
      await writeFile(join(destination, "cloned.txt"), "clone");
    });

    const staged = await stageSource(
      { kind: "git", url: "https://github.com/o/r.git" },
      tempRoot,
      { run },
    );

    expect(run).toHaveBeenCalledWith("git", [
      "clone",
      "--depth",
      "1",
      "--",
      "https://github.com/o/r.git",
      staged.root,
    ]);
    expect(staged.rootEntryName).toBe("r");
    expect(await readFile(join(staged.root, "cloned.txt"), "utf8")).toBe(
      "clone",
    );
  });

  it("retries an exclusive container collision without deleting the occupant", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const occupied = join(tempRoot, ".skillpark-stage-collision");
    await mkdir(occupied);
    await writeFile(join(occupied, "occupant.txt"), "keep");
    mocks.stageIds.push("collision", "fresh");

    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );

    expect(dirname(staged.root)).toBe(join(tempRoot, ".skillpark-stage-fresh"));
    expect(await readFile(join(occupied, "occupant.txt"), "utf8")).toBe("keep");
  });

  it("uses only non-recursive cleanup when owner marker creation fails", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const primary = new Error("marker failed");
    mocks.markerFailure = primary;
    mocks.stageIds.push("marker-failure");

    await expect(
      stageSource({ kind: "local", path: source }, tempRoot, { run: vi.fn() }),
    ).rejects.toBe(primary);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("deep-copies a local source without dereferencing symbolic links", async () => {
    const tempRoot = await makeTempHome();
    const sourceParent = await makeTempHome();
    const source = join(sourceParent, "source-skill");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "target.txt"), "original");
    await symlink("../target.txt", join(source, "nested", "target-link"));

    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );

    expect(staged.rootEntryName).toBe("source-skill");
    expect(await readFile(join(staged.root, "target.txt"), "utf8")).toBe(
      "original",
    );
    expect(
      (
        await lstat(join(staged.root, "nested", "target-link"))
      ).isSymbolicLink(),
    ).toBe(true);
    expect(await readlink(join(staged.root, "nested", "target-link"))).toBe(
      "../target.txt",
    );
  });

  it.each(["symlink", "file"])(
    "rejects a local source root that is a %s",
    async (kind) => {
      const tempRoot = await makeTempHome();
      const parent = await makeTempHome();
      const source = join(parent, "source");
      if (kind === "symlink") {
        await symlink(await makeTempHome(), source);
      } else {
        await writeFile(source, "not a directory");
      }

      await expect(
        stageSource({ kind: "local", path: source }, tempRoot, {
          run: vi.fn(),
        }),
      ).rejects.toThrow("Local source must be a real directory");
    },
  );

  it("detects local source-root replacement before copying a child", async () => {
    const tempRoot = await makeTempHome();
    const parent = await makeTempHome();
    const source = join(parent, "source");
    const moved = join(parent, "moved-source");
    const external = await makeTempHome();
    await mkdir(source);
    await writeFile(join(source, "safe.txt"), "safe");
    await writeFile(join(external, "outside.txt"), "outside");
    mocks.afterReaddir = {
      path: source,
      async action() {
        await rename(source, moved);
        await symlink(external, source);
      },
    };

    await expect(
      stageSource({ kind: "local", path: source }, tempRoot, { run: vi.fn() }),
    ).rejects.toThrow("Local source changed during staging");
    expect(mocks.copyCalls).toBe(0);
  });

  it("provides idempotent cleanup that removes only its staged root", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const sibling = join(tempRoot, "keep.txt");
    await writeFile(sibling, "keep");

    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );
    const container = dirname(staged.root);
    await staged.cleanup();
    await staged.cleanup();

    expect(await readFile(sibling, "utf8")).toBe("keep");
    expect(await readdir(tempRoot)).toEqual(["keep.txt"]);
    await expect(lstat(container)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a replacement payload during normal cleanup", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );
    await rm(staged.root, { recursive: true, force: true });
    await mkdir(staged.root);
    await writeFile(join(staged.root, "occupant.txt"), "keep");

    await expect(staged.cleanup()).rejects.toThrow("Manual cleanup required");
    expect(await readFile(join(staged.root, "occupant.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("never restores a replacement that appears at the isolated payload path", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );
    const isolated = join(dirname(staged.root), ".cleanup-payload-stage-1");
    mocks.afterIsolation = async (isolatedPath) => {
      await rm(isolatedPath, { recursive: true, force: true });
      await mkdir(isolatedPath);
      await writeFile(join(isolatedPath, "occupant.txt"), "keep");
    };

    await expect(staged.cleanup()).rejects.toThrow("Manual cleanup required");
    await expect(lstat(staged.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(isolated, "occupant.txt"), "utf8")).toBe("keep");
  });

  it("preserves a replacement container during normal cleanup", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );
    const container = dirname(staged.root);
    const moved = `${tempRoot}-moved-owned-container`;
    await rename(container, moved);
    await mkdir(container);
    await writeFile(join(container, "occupant.txt"), "keep");

    await expect(staged.cleanup()).rejects.toThrow("Manual cleanup required");
    expect(await readFile(join(container, "occupant.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("preserves a replacement tempRoot during normal cleanup", async () => {
    const parent = await makeTempHome();
    const tempRoot = join(parent, "staging");
    const source = await makeTempHome();
    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );
    const moved = join(parent, "moved-staging");
    await rename(tempRoot, moved);
    await mkdir(tempRoot);
    await writeFile(join(tempRoot, "occupant.txt"), "keep");

    await expect(staged.cleanup()).rejects.toThrow("Manual cleanup required");
    expect(await readFile(join(tempRoot, "occupant.txt"), "utf8")).toBe("keep");
  });

  it("rejects unexpected entries in its owned container without deleting them", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );
    const extra = join(dirname(staged.root), "unexpected.txt");
    await writeFile(extra, "keep");

    await expect(staged.cleanup()).rejects.toThrow("Manual cleanup required");
    expect(await readFile(extra, "utf8")).toBe("keep");
    expect((await lstat(staged.root)).isDirectory()).toBe(true);
  });

  it("retries cleanup safely from an isolated payload", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );
    const container = dirname(staged.root);
    const primary = new Error("payload removal failed");
    mocks.cleanupFailure = primary;

    await expect(staged.cleanup()).rejects.toBe(primary);
    await expect(lstat(staged.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(container)).toEqual([
      ".cleanup-payload-stage-1",
      "owner.json",
    ]);

    await staged.cleanup();
    await expect(lstat(container)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a payload-removal error when the absence probe also fails", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );
    const primary = new Error("payload removal failed");
    const probe = new Error("payload probe failed");
    mocks.cleanupFailure = primary;
    mocks.probeFailure = probe;

    await expect(staged.cleanup()).rejects.toBe(primary);
    expect(
      (primary as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([probe]);
  });

  it("retries cleanup safely from marker-only state", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );
    const container = dirname(staged.root);
    const primary = new Error("marker unlink failed");
    mocks.unlinkFailure = primary;

    await expect(staged.cleanup()).rejects.toBe(primary);
    expect(await readdir(container)).toEqual(["owner.json"]);

    await staged.cleanup();
    await expect(lstat(container)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a marker-unlink error when the absence probe also fails", async () => {
    const tempRoot = await makeTempHome();
    const source = await makeTempHome();
    const staged = await stageSource(
      { kind: "local", path: source },
      tempRoot,
      { run: vi.fn() },
    );
    const primary = new Error("marker unlink failed");
    const probe = new Error("marker probe failed");
    mocks.unlinkFailure = primary;
    mocks.probeFailure = probe;

    await expect(staged.cleanup()).rejects.toBe(primary);
    expect(
      (primary as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([probe]);
  });

  it("cleans a partial Git clone without deleting tempRoot siblings", async () => {
    const tempRoot = await makeTempHome();
    await writeFile(join(tempRoot, "keep.txt"), "keep");
    const primary = new Error("clone failed");
    const runner = {
      run: vi.fn(async (_command: string, args: string[]) => {
        const destination = args.at(-1);
        if (destination === undefined) throw new Error("missing destination");
        await writeFile(join(destination, "partial"), "partial");
        throw primary;
      }),
    };

    await expect(
      stageSource(
        { kind: "git", url: "ssh://git@example.test/o/r.git" },
        tempRoot,
        runner,
      ),
    ).rejects.toBe(primary);
    expect(await readdir(tempRoot)).toEqual(["keep.txt"]);
  });

  it("preserves a runner replacement and the primary failure identity", async () => {
    const tempRoot = await makeTempHome();
    const primary = new Error("clone failed");
    let payload = "";
    const runner = {
      run: vi.fn(async (_command: string, args: string[]) => {
        payload = args.at(-1) ?? "";
        await rm(payload, { recursive: true, force: true });
        await mkdir(payload);
        await writeFile(join(payload, "occupant.txt"), "keep");
        throw primary;
      }),
    };

    await expect(
      stageSource(
        { kind: "git", url: "https://example.test/o/r.git" },
        tempRoot,
        runner,
      ),
    ).rejects.toBe(primary);
    expect(await readFile(join(payload, "occupant.txt"), "utf8")).toBe("keep");
    expect(
      (primary as Error & { cleanupErrors?: Error[] }).cleanupErrors?.[0]
        ?.message,
    ).toContain("Manual cleanup required");
  });

  it("preserves the primary failure identity when cleanup also fails", async () => {
    const tempRoot = await makeTempHome();
    const primary = new Error("clone failed");
    const cleanup = new Error("cleanup failed");
    mocks.cleanupFailure = cleanup;

    await expect(
      stageSource({ kind: "git", url: "git@example.test:o/r.git" }, tempRoot, {
        run: vi.fn(async () => Promise.reject(primary)),
      }),
    ).rejects.toBe(primary);
    expect(
      (primary as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([cleanup]);
  });

  it("propagates a missing local source filesystem error", async () => {
    const tempRoot = await makeTempHome();
    const missing = join(tempRoot, "does-not-exist");

    await expect(
      stageSource({ kind: "local", path: missing }, tempRoot, { run: vi.fn() }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it.each([
    "https://example.test/owner/repository.git",
    "ssh://git@example.test/owner/repository.git/",
    "git@example.test:owner/repository.git",
  ])("derives a stable root entry name from %s", async (url) => {
    const tempRoot = await makeTempHome();
    const staged = await stageSource({ kind: "git", url }, tempRoot, {
      run: vi.fn(),
    });
    expect(staged.rootEntryName).toBe("repository");
    expect(basename(staged.root)).not.toBe("repository");
  });
});
