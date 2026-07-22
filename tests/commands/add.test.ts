import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, posix } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/app/create-program.js";
import { runAdd } from "../../src/commands/add.js";
import { createCommandContext } from "../../src/commands/context.js";
import { containsPath } from "../../src/commands/path-safety.js";
import {
  createJournalStore,
  type JournalStore,
} from "../../src/storage/journal.js";
import { createNodeItemExecutor } from "../../src/storage/node-item-executor.js";
import { CANCELLED, type OutputPort } from "../../src/tui/ports.js";
import { createSkill, makeTempHome } from "../support/fs.js";

const mocks = vi.hoisted(() => ({
  cleanupFailure: undefined as Error | undefined,
  lstatFailure: undefined as { error: Error; path: string } | undefined,
  stageFailure: undefined as Error | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async lstat(...args: Parameters<typeof actual.lstat>) {
      const failure = mocks.lstatFailure;
      if (failure !== undefined && String(args[0]) === failure.path) {
        mocks.lstatFailure = undefined;
        throw failure.error;
      }
      return actual.lstat(...args);
    },
  };
});

vi.mock("../../src/sources/stage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/sources/stage.js")>();
  return {
    ...actual,
    async stageSource(...args: Parameters<typeof actual.stageSource>) {
      const stageFailure = mocks.stageFailure;
      mocks.stageFailure = undefined;
      if (stageFailure !== undefined) throw stageFailure;
      const staged = await actual.stageSource(...args);
      return {
        ...staged,
        async cleanup() {
          await staged.cleanup();
          const cleanupFailure = mocks.cleanupFailure;
          mocks.cleanupFailure = undefined;
          if (cleanupFailure !== undefined) throw cleanupFailure;
        },
      };
    },
  };
});

afterEach(() => {
  mocks.cleanupFailure = undefined;
  mocks.lstatFailure = undefined;
  mocks.stageFailure = undefined;
});

function silentOutput(): OutputPort {
  return {
    intro() {},
    info() {},
    success() {},
    warning() {},
    error() {},
    outro() {},
    write() {},
  };
}

async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(
    target,
    path,
    process.platform === "win32" ? "junction" : "dir",
  );
}

const nonInstallingCases: {
  confirmation: boolean | typeof CANCELLED;
  name: string;
  selections: (string[] | typeof CANCELLED)[];
}[] = [
  {
    name: "agent selection is cancelled",
    selections: [CANCELLED],
    confirmation: true,
  },
  {
    name: "agent selection is empty",
    selections: [[]],
    confirmation: true,
  },
  {
    name: "skill selection is cancelled",
    selections: [["claude"], CANCELLED],
    confirmation: true,
  },
  {
    name: "skill selection is empty",
    selections: [["claude"], []],
    confirmation: true,
  },
  {
    name: "confirmation is declined",
    selections: [["claude"], ["pdf"]],
    confirmation: false,
  },
  {
    name: "confirmation is cancelled",
    selections: [["claude"], ["pdf"]],
    confirmation: CANCELLED,
  },
];

describe("runAdd", () => {
  it("does not case-fold paths solely because of a platform label", () => {
    expect(containsPath("/Volumes/Case", "/Volumes/case/child", posix)).toBe(
      false,
    );
    expect(containsPath("/Volumes/Case", "/Volumes/Case/child", posix)).toBe(
      true,
    );
  });

  it("rejects a parked root alias to active before it can write an active skill", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    const active = join(home, ".claude", "skills");
    const parked = join(home, ".skillpark", "skills", "claude");
    await createSkill(join(source, "skills"), "pdf");
    await mkdir(active, { recursive: true });
    await mkdir(join(home, ".skillpark", "skills"), { recursive: true });
    await linkDirectory(active, parked);
    const selections = [["claude"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow("Unsafe agent root");
    await expect(access(join(active, "pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an active root alias to parked before the new parked skill becomes active", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    const active = join(home, ".claude", "skills");
    const parked = join(home, ".skillpark", "skills", "claude");
    await createSkill(join(source, "skills"), "pdf");
    await mkdir(parked, { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await linkDirectory(parked, active);
    const selections = [["claude"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow("Unsafe agent root");
    await expect(access(join(parked, "pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a regular file in the parked root chain", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    await mkdir(join(home, ".skillpark", "skills"), { recursive: true });
    await writeFile(join(home, ".skillpark", "skills", "claude"), "occupied");
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return ["claude"];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow("Unsafe agent root");
  });

  it("propagates non-ENOENT errors while validating root components", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const primary = Object.assign(new Error("root denied"), { code: "EACCES" });
    mocks.lstatFailure = { path: join(home, ".claude"), error: primary };
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return ["claude"];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toBe(primary);
    expect(await readdir(join(home, ".skillpark", ".tmp"))).toEqual([]);
  });

  it("rechecks agent roots after confirmation before executing", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    const active = join(home, ".claude", "skills");
    const parked = join(home, ".skillpark", "skills", "claude");
    await createSkill(join(source, "skills"), "pdf");
    const selections = [["claude"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          await mkdir(active, { recursive: true });
          await mkdir(join(home, ".skillpark", "skills"), {
            recursive: true,
          });
          await linkDirectory(active, parked);
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow("Unsafe agent root");
    await expect(access(join(active, "pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an active-name conflict created during confirmation", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    const active = join(home, ".claude", "skills", "pdf");
    const parked = join(home, ".skillpark", "skills", "claude", "pdf");
    await createSkill(join(source, "skills"), "pdf");
    const selections = [["claude"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          await createSkill(join(home, ".claude", "skills"), "pdf");
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow(
      "active or parked name conflict",
    );
    await expect(access(active)).resolves.toBeUndefined();
    await expect(access(parked)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await context.journals.list()).toEqual([]);
    expect(await readdir(join(home, ".skillpark", ".tmp"))).toEqual([]);
  });

  it("rejects an active-name conflict created after the running journal save", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    const active = join(home, ".claude", "skills", "pdf");
    const parked = join(home, ".skillpark", "skills", "claude", "pdf");
    await createSkill(join(source, "skills"), "pdf");
    const baseJournals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    let injected = false;
    const journals: JournalStore = {
      create: baseJournals.create,
      list: baseJournals.list,
      remove: baseJournals.remove,
      async save(record) {
        await baseJournals.save(record);
        if (!injected && Object.values(record.states).includes("running")) {
          injected = true;
          await createSkill(join(home, ".claude", "skills"), "pdf");
        }
      },
    };
    const selections = [["claude"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      journals,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow(
      "active or parked name conflict",
    );
    await expect(access(active)).resolves.toBeUndefined();
    await expect(access(parked)).rejects.toMatchObject({ code: "ENOENT" });
    const [record] = await baseJournals.list();
    const [item] = record?.items ?? [];
    expect(item).toBeDefined();
    expect(item === undefined ? undefined : record?.states[item.id]).toBe(
      "running",
    );
    for (const retainedItem of record?.items ?? []) {
      await expect(lstat(retainedItem.source)).resolves.toBeDefined();
    }
  });

  it("rolls back earlier agents despite an active-name conflict before a later apply", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const baseJournals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    let injected = false;
    const journals: JournalStore = {
      create: baseJournals.create,
      list: baseJournals.list,
      remove: baseJournals.remove,
      async save(record) {
        await baseJournals.save(record);
        const running = record.items.find(
          (item) => record.states[item.id] === "running",
        );
        if (!injected && running?.agent === "codex") {
          injected = true;
          await createSkill(join(home, ".claude", "skills"), "pdf");
          await createSkill(join(home, ".codex", "skills"), "pdf");
        }
      },
    };
    const selections = [["claude", "codex"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      journals,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow(
      "active or parked name conflict",
    );
    for (const agent of ["claude", "codex"]) {
      await expect(
        access(join(home, `.${agent}`, "skills", "pdf")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(home, ".skillpark", "skills", agent, "pdf")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    const [record] = await baseJournals.list();
    const claudeItem = record?.items.find((item) => item.agent === "claude");
    const codexItem = record?.items.find((item) => item.agent === "codex");
    expect(
      claudeItem === undefined ? undefined : record?.states[claudeItem.id],
    ).toBe("reverted");
    expect(
      codexItem === undefined ? undefined : record?.states[codexItem.id],
    ).toBe("running");
    for (const retainedItem of record?.items ?? []) {
      await expect(lstat(retainedItem.source)).resolves.toBeDefined();
    }
  });

  it("rechecks agent roots immediately before transaction preflight", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    const active = join(home, ".claude", "skills");
    const parked = join(home, ".skillpark", "skills", "claude");
    await createSkill(join(source, "skills"), "pdf");
    const confirm = vi.fn(async () => false);
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany(message) {
          if (message === "Select target agents") return ["claude"];
          await mkdir(active, { recursive: true });
          await mkdir(join(home, ".skillpark", "skills"), {
            recursive: true,
          });
          await linkDirectory(active, parked);
          return ["pdf"];
        },
        confirm,
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow("Unsafe agent root");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rechecks agent roots after the running journal save and before apply", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    const active = join(home, ".claude", "skills");
    const parked = join(home, ".skillpark", "skills", "claude");
    await createSkill(join(source, "skills"), "pdf");
    const baseJournals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    let replaced = false;
    const journals: JournalStore = {
      create: baseJournals.create,
      list: baseJournals.list,
      remove: baseJournals.remove,
      async save(record) {
        await baseJournals.save(record);
        if (!replaced && Object.values(record.states).includes("running")) {
          replaced = true;
          await mkdir(active, { recursive: true });
          await mkdir(join(home, ".skillpark", "skills"), {
            recursive: true,
          });
          await linkDirectory(active, parked);
        }
      },
    };
    const selections = [["claude"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      journals,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow("Unsafe agent root");
    await expect(access(join(active, "pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const [record] = await baseJournals.list();
    const [item] = record?.items ?? [];
    expect(item).toBeDefined();
    expect(item === undefined ? undefined : record?.states[item.id]).toBe(
      "running",
    );
    for (const retainedItem of record?.items ?? []) {
      await expect(lstat(retainedItem.source)).resolves.toBeDefined();
    }
  });

  it("refuses rollback through an unsafe parked root and retains recovery state", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    const active = join(home, ".claude", "skills");
    const parked = join(home, ".skillpark", "skills", "claude");
    const displaced = join(home, "displaced-parked-root");
    await createSkill(join(source, "skills"), "pdf");
    const nodeExecutor = createNodeItemExecutor();
    const primary = new Error("second copy failed");
    let applications = 0;
    const selections = [["claude", "codex"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
      executor: {
        async apply(item) {
          applications += 1;
          if (applications === 1) {
            await nodeExecutor.apply(item);
            return;
          }
          await rename(parked, displaced);
          await mkdir(active, { recursive: true });
          await rename(join(displaced, "pdf"), join(active, "pdf"));
          await linkDirectory(active, parked);
          throw primary;
        },
        revert: (item) => nodeExecutor.revert(item),
      },
    });

    await expect(runAdd(source, context)).rejects.toBe(primary);
    await expect(
      readFile(join(active, "pdf", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: pdf");
    const [record] = await context.journals.list();
    expect(record?.states).toEqual(
      expect.objectContaining({
        [record?.items[0]?.id ?? "missing"]: "completed",
      }),
    );
    for (const item of record?.items ?? []) {
      await expect(lstat(item.source)).resolves.toBeDefined();
    }
  });

  it("rejects a local source containing the staging root before staging starts", async () => {
    const home = await makeTempHome();
    mocks.stageFailure = new Error("unsafe staging was invoked");
    const context = createCommandContext({ homeDir: home, cwd: home });

    await expect(runAdd(".", context)).rejects.toThrow(
      "contains the staging temp root",
    );
    await expect(
      access(join(home, ".skillpark", ".tmp")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a source alias that physically contains the staging root",
    async () => {
      const physicalHome = await makeTempHome();
      const source = join(physicalHome, "root");
      const aliasParent = await makeTempHome();
      await mkdir(source);
      await symlink(physicalHome, join(aliasParent, "alias"), "dir");
      mocks.stageFailure = new Error("unsafe staging was invoked");
      const context = createCommandContext({
        homeDir: source,
        cwd: aliasParent,
      });

      await expect(
        runAdd(join(aliasParent, "alias", "root"), context),
      ).rejects.toThrow("contains the staging temp root");
      await expect(
        access(join(source, ".skillpark", ".tmp")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("copies selected skills only into each selected agent parked directory", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const selections = [["claude", "codex"], ["pdf"]];
    const previews: string[] = [];
    const confirmations: string[] = [];
    const successes: string[] = [];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm(message) {
          confirmations.push(message);
          return true;
        },
      },
      output: {
        intro() {},
        info(message) {
          previews.push(message);
        },
        success(message) {
          successes.push(message);
        },
        warning() {},
        error() {},
        outro() {},
        write() {},
      },
    });

    await runAdd(source, context);

    await expect(
      access(join(home, ".skillpark", "skills", "claude", "pdf")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(home, ".skillpark", "skills", "codex", "pdf")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(home, ".claude", "skills", "pdf")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(home, ".codex", "skills", "pdf")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(previews.join("\n")).toContain(
      join(home, ".skillpark", "skills", "claude", "pdf"),
    );
    expect(previews.join("\n")).toContain(
      join(home, ".skillpark", "skills", "codex", "pdf"),
    );
    expect(previews).toHaveLength(1);
    expect(previews[0]?.split("\n")).toHaveLength(2);
    expect(confirmations).toEqual([
      "Install 1 skill into SkillPark for 2 agents?",
    ]);
    expect(successes).toEqual(["Installed 2 parked skill copies."]);
  });

  it("blocks a skill whose name is already active for a selected agent", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    await createSkill(join(home, ".claude", "skills"), "pdf");
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany(message, choices) {
          if (message === "Select target agents") return ["claude"];
          expect(
            choices.find((choice) => choice.value === "pdf")?.disabled,
          ).toBe(true);
          return ["pdf"];
        },
        async confirm() {
          return true;
        },
      },
      output: {
        intro() {},
        info() {},
        success() {},
        warning() {},
        error() {},
        outro() {},
        write() {},
      },
    });

    await expect(runAdd(source, context)).rejects.toThrow(
      "active or parked name conflict",
    );
    await expect(
      access(join(home, ".skillpark", "skills", "claude", "pdf")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an agent selection that was not offered", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const apply = vi.fn();
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return ["../../outside"];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
      executor: { apply, async revert() {} },
    });

    await expect(runAdd(source, context)).rejects.toThrow(
      "Unknown selected agent",
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects a skill selection that was not discovered", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const selections = [["claude"], ["../../outside"]];
    const apply = vi.fn();
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
      executor: { apply, async revert() {} },
    });

    await expect(runAdd(source, context)).rejects.toThrow(
      "Unknown selected skill",
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("preserves a pre-transaction error when staged cleanup also fails", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const selections = [["claude"], ["pdf"]];
    const primary = new Error("confirmation failed");
    const cleanup = new Error("cleanup failed");
    mocks.cleanupFailure = cleanup;
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          throw primary;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toBe(primary);
    expect(
      (primary as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([cleanup]);
    expect(Object.keys(primary)).not.toContain("cleanupErrors");
  });

  it.each(nonInstallingCases)(
    "does not install when $name",
    async ({ selections, confirmation }) => {
      const home = await makeTempHome();
      const source = join(home, "source");
      await createSkill(join(source, "skills"), "pdf");
      let selectionIndex = 0;
      const success = vi.fn();
      const context = createCommandContext({
        homeDir: home,
        cwd: home,
        prompts: {
          async selectMany() {
            return selections[selectionIndex++] ?? [];
          },
          async confirm() {
            return confirmation;
          },
        },
        output: { ...silentOutput(), success },
      });

      await runAdd(source, context);

      await expect(
        access(join(home, ".skillpark", "skills", "claude", "pdf")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(success).not.toHaveBeenCalled();
      expect(await readdir(join(home, ".skillpark", ".tmp"))).toEqual([]);
    },
  );

  it("cleans staging after rejecting a source with no valid metadata", async () => {
    const home = await makeTempHome();
    const invalid = join(home, "source", "skills", "invalid");
    await mkdir(invalid, { recursive: true });
    await writeFile(join(invalid, "SKILL.md"), "# Missing frontmatter");
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      output: silentOutput(),
    });

    await expect(runAdd(join(home, "source"), context)).rejects.toThrow(
      "No valid skills found",
    );
    expect(await readdir(join(home, ".skillpark", ".tmp"))).toEqual([]);
  });

  it("cleans staging after duplicate discovered skill metadata is rejected", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "one", {
      name: "duplicate",
      description: "first",
    });
    await createSkill(join(source, "skills"), "two", {
      name: "duplicate",
      description: "second",
    });
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow(
      "Duplicate skill name",
    );
    expect(await readdir(join(home, ".skillpark", ".tmp"))).toEqual([]);
  });

  it("removes the first parked copy when the second agent copy fails", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const nodeExecutor = createNodeItemExecutor();
    const selections = [["claude", "codex"], ["pdf"]];
    let applications = 0;
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
      executor: {
        async apply(item) {
          applications += 1;
          if (applications === 2) {
            throw new Error("injected second-copy failure");
          }
          await nodeExecutor.apply(item);
        },
        revert: (item) => nodeExecutor.revert(item),
      },
    });

    await expect(runAdd(source, context)).rejects.toThrow(
      "injected second-copy failure",
    );
    await expect(
      access(join(home, ".skillpark", "skills", "claude", "pdf")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(home, ".skillpark", "skills", "codex", "pdf")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const [record] = await context.journals.list();
    expect(record).toBeDefined();
    expect(record?.sourceStage).toBeDefined();
    expect(
      record?.items.every((item) =>
        item.source.startsWith(`${record.sourceStage?.payload}/`),
      ),
    ).toBe(true);
    for (const item of record?.items ?? []) {
      expect((await lstat(item.source)).isDirectory()).toBe(true);
      expect(await readFile(join(item.source, "SKILL.md"), "utf8")).toContain(
        "name: pdf",
      );
    }
    expect(await readdir(join(home, ".skillpark", ".tmp"))).not.toEqual([]);
  });

  it("preserves the primary error and stage when journal state cannot be inspected", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const baseJournals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    const inspection = new Error("journal inspection failed");
    let listCalls = 0;
    const journals: JournalStore = {
      create: baseJournals.create,
      save: baseJournals.save,
      remove: baseJournals.remove,
      async list() {
        listCalls += 1;
        if (listCalls === 1) return [];
        throw inspection;
      },
    };
    const primary = new Error("copy failed");
    const selections = [["claude"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      journals,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
      executor: {
        async apply() {
          throw primary;
        },
        async revert() {},
      },
    });

    await expect(runAdd(source, context)).rejects.toBe(primary);
    expect(
      (primary as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([inspection]);
    expect(Object.keys(primary)).not.toContain("cleanupErrors");
    const [record] = await baseJournals.list();
    expect(record).toBeDefined();
    for (const item of record?.items ?? []) {
      await expect(lstat(item.source)).resolves.toBeDefined();
    }
    expect(await readdir(join(home, ".skillpark", ".tmp"))).not.toEqual([]);
  });

  it("cleans staging after an execute error when no matching journal remains", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const baseJournals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    const journals: JournalStore = {
      async create(plan) {
        const record = await baseJournals.create(plan);
        await baseJournals.remove(plan.id);
        return record;
      },
      async save() {},
      remove: baseJournals.remove,
      list: baseJournals.list,
    };
    const primary = new Error("copy failed without retained journal");
    const selections = [["claude"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      journals,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
      executor: {
        async apply() {
          throw primary;
        },
        async revert() {},
      },
    });

    await expect(runAdd(source, context)).rejects.toBe(primary);
    expect(await baseJournals.list()).toEqual([]);
    expect(await readdir(join(home, ".skillpark", ".tmp"))).toEqual([]);
  });

  it("does not print success when cleanup fails after the transaction", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const selections = [["claude"], ["pdf"]];
    const cleanup = new Error("cleanup failed");
    const success = vi.fn();
    mocks.cleanupFailure = cleanup;
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: { ...silentOutput(), success },
    });

    await expect(runAdd(source, context)).rejects.toBe(cleanup);
    expect(success).not.toHaveBeenCalled();
    await expect(
      access(join(home, ".skillpark", "skills", "claude", "pdf")),
    ).resolves.toBeUndefined();
  });

  it("propagates cleanup failure when a prompt is cancelled", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const cleanup = new Error("cancel cleanup failed");
    mocks.cleanupFailure = cleanup;
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return CANCELLED;
        },
        async confirm() {
          return false;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toBe(cleanup);
  });

  it("treats a parked regular file as an installation conflict", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    const parked = join(home, ".skillpark", "skills", "claude");
    await createSkill(join(source, "skills"), "pdf");
    await mkdir(parked, { recursive: true });
    await writeFile(join(parked, "pdf"), "occupied");
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany(message, choices) {
          if (message === "Select target agents") return ["claude"];
          expect(choices[0]?.disabled).toBe(true);
          return ["pdf"];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toThrow(
      "active or parked name conflict",
    );
    expect(await readFile(join(parked, "pdf"), "utf8")).toBe("occupied");
  });

  it.runIf(process.platform !== "win32")(
    "treats a broken active link as an installation conflict",
    async () => {
      const home = await makeTempHome();
      const source = join(home, "source");
      const active = join(home, ".claude", "skills");
      await createSkill(join(source, "skills"), "pdf");
      await mkdir(active, { recursive: true });
      await symlink("missing-target", join(active, "pdf"));
      const context = createCommandContext({
        homeDir: home,
        cwd: home,
        prompts: {
          async selectMany(message, choices) {
            if (message === "Select target agents") return ["claude"];
            expect(choices[0]?.disabled).toBe(true);
            return ["pdf"];
          },
          async confirm() {
            return true;
          },
        },
        output: silentOutput(),
      });

      await expect(runAdd(source, context)).rejects.toThrow(
        "active or parked name conflict",
      );
      expect((await lstat(join(active, "pdf"))).isSymbolicLink()).toBe(true);
    },
  );

  it("propagates non-ENOENT errors while checking occupancy", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const primary = Object.assign(new Error("occupancy denied"), {
      code: "EACCES",
    });
    mocks.lstatFailure = {
      path: join(home, ".claude", "skills", "pdf"),
      error: primary,
    };
    const selections = [["claude"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runAdd(source, context)).rejects.toBe(primary);
  });

  it("preflight blocks a destination that appears after skill choices are built", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    const destination = join(home, ".skillpark", "skills", "claude", "pdf");
    await createSkill(join(source, "skills"), "pdf");
    const info = vi.fn();
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany(message) {
          if (message === "Select target agents") return ["claude"];
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "occupant.txt"), "keep");
          return ["pdf"];
        },
        async confirm() {
          return true;
        },
      },
      output: { ...silentOutput(), info },
    });

    await expect(runAdd(source, context)).rejects.toThrow(
      `Destination exists: ${destination}`,
    );
    expect(info).not.toHaveBeenCalled();
    expect(await readFile(join(destination, "occupant.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("deduplicates repeated offered agents and skills before planning", async () => {
    const home = await makeTempHome();
    const source = join(home, "source");
    await createSkill(join(source, "skills"), "pdf");
    const selections = [
      ["claude", "claude", "codex"],
      ["pdf", "pdf"],
    ];
    const success = vi.fn();
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm(message) {
          expect(message).toBe("Install 1 skill into SkillPark for 2 agents?");
          return true;
        },
      },
      output: { ...silentOutput(), success },
    });

    await runAdd(source, context);

    await expect(
      access(join(home, ".skillpark", "skills", "claude", "pdf")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(home, ".skillpark", "skills", "codex", "pdf")),
    ).resolves.toBeUndefined();
    expect(success).toHaveBeenCalledWith("Installed 2 parked skill copies.");
  });

  it("uses the injected process runner for git sources without network access", async () => {
    const home = await makeTempHome();
    const selections = [["codex"], ["pdf"]];
    const progressEvents: string[][] = [];
    const run = vi.fn(async (_command: string, args: string[]) => {
      const destination = args.at(-1);
      if (destination === undefined) throw new Error("missing destination");
      await createSkill(join(destination, "skills"), "pdf");
    });
    const context = createCommandContext({
      homeDir: home,
      cwd: home,
      processRunner: { run },
      prompts: {
        async selectMany() {
          return selections.shift() ?? [];
        },
        async confirm() {
          return true;
        },
      },
      output: {
        ...silentOutput(),
        progress(maximum) {
          const events: string[] = [`max:${maximum}`];
          progressEvents.push(events);
          return {
            advance(step, message) {
              events.push(`advance:${step}:${message}`);
            },
            error(message) {
              events.push(`error:${message}`);
            },
            message(message) {
              events.push(`message:${message}`);
            },
            start(message) {
              events.push(`start:${message}`);
            },
            stop(message) {
              events.push(`stop:${message}`);
            },
          };
        },
      },
    });

    await runAdd("owner/repository", context);

    expect(run).toHaveBeenCalledWith("git", [
      "clone",
      "--depth",
      "1",
      "--",
      "https://github.com/owner/repository.git",
      expect.any(String),
    ]);
    await expect(
      access(join(home, ".skillpark", "skills", "codex", "pdf")),
    ).resolves.toBeUndefined();
    expect(progressEvents).toEqual([
      [
        "max:2",
        "start:Cloning source",
        "advance:1:Scanning for skills",
        "advance:1:Found 1 skill",
        "stop:Source ready",
      ],
      [
        "max:1",
        "start:Installing 1 parked skill copy",
        "message:Installing pdf for codex",
        "advance:1:Installed pdf for codex",
        "stop:Installation complete",
      ],
    ]);
  });

  it("registers the add command with the existing program commands", () => {
    const program = createProgram(
      createCommandContext({ homeDir: "/temporary-home-not-used" }),
    );

    expect(program.commands.map((command) => command.name())).toEqual([
      "store",
      "restore",
      "list",
      "add",
      "agents",
      "install",
      "get",
      "search",
      "hook",
    ]);
  });
});
