import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/app/create-program.js";
import { createCommandContext } from "../../src/commands/context.js";
import { runMoveSkills } from "../../src/commands/move-skills.js";
import { UsageError } from "../../src/domain/errors.js";
import {
  createJournalStore,
  type JournalStore,
} from "../../src/storage/journal.js";
import { createNodeItemExecutor } from "../../src/storage/node-item-executor.js";
import { CANCELLED, type OutputPort } from "../../src/tui/ports.js";
import { createSkill, makeTempHome } from "../support/fs.js";

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

describe("store and restore", () => {
  it.each([
    { command: "store", source: ".claude/skills", action: "park" },
    {
      command: "restore",
      source: ".skillpark/skills/claude",
      action: "restore",
    },
  ])(
    "prompts for an agent when omitted from $command",
    async ({ command, source, action }) => {
      const home = await makeTempHome();
      await createSkill(join(home, source), "pdf");
      const messages: string[] = [];

      await createProgram(
        createCommandContext({
          homeDir: home,
          prompts: {
            async selectOne(message, choices) {
              messages.push(message);
              expect(choices).toHaveLength(73);
              return "claude";
            },
            async selectMany(message) {
              messages.push(message);
              return CANCELLED;
            },
            async confirm() {
              throw new Error("must not confirm");
            },
          },
          output: silentOutput(),
        }),
      ).parseAsync(["node", "skillpark", command]);

      expect(messages[0]).toContain("Select an agent whose skills you want");
      expect(messages[1]).toContain(`Select claude skills to ${action}`);
    },
  );

  it("parks only selected skills and restores them without affecting Codex", async () => {
    const home = await makeTempHome();
    await createSkill(join(home, ".claude", "skills"), "pdf");
    await createSkill(join(home, ".claude", "skills"), "docs");
    await createSkill(join(home, ".codex", "skills"), "pdf");
    const selections = [["pdf"], ["pdf"]];
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? CANCELLED;
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

    await runMoveSkills("store", "claude", context);
    await expect(
      access(join(home, ".claude", "skills", "pdf")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(home, ".skillpark", "skills", "claude", "pdf")),
    ).resolves.toBeUndefined();
    await runMoveSkills("restore", "claude", context);
    await expect(
      access(join(home, ".claude", "skills", "pdf")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(home, ".codex", "skills", "pdf")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(home, ".claude", "skills", "docs")),
    ).resolves.toBeUndefined();
  });

  it("scans and parks skills from a custom agent's global directory", async () => {
    const home = await makeTempHome();
    await createSkill(join(home, ".sodagent", "skills"), "documents");
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany(message, choices) {
          expect(message).toBe("Select sodagent skills to park");
          expect(choices.map((choice) => choice.value)).toEqual(["documents"]);
          return ["documents"];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await runMoveSkills("store", "sodagent", context);

    await expect(
      access(join(home, ".sodagent", "skills", "documents")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(home, ".skillpark", "skills", "sodagent", "documents")),
    ).resolves.toBeUndefined();
  });

  it("makes no change when selection is cancelled", async () => {
    const home = await makeTempHome();
    const active = await createSkill(join(home, ".claude", "skills"), "pdf");
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return CANCELLED;
        },
        async confirm() {
          throw new Error("must not confirm");
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

    await runMoveSkills("store", "claude", context);

    await expect(access(active)).resolves.toBeUndefined();
    await expect(access(join(home, ".skillpark"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([false, CANCELLED] as readonly (false | typeof CANCELLED)[])(
    "makes no change when confirmation returns %s",
    async (confirmation) => {
      const home = await makeTempHome();
      const active = await createSkill(join(home, ".claude", "skills"), "pdf");
      const context = createCommandContext({
        homeDir: home,
        prompts: {
          async selectMany() {
            return ["pdf"];
          },
          async confirm() {
            return confirmation;
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

      await runMoveSkills("store", "claude", context);

      await expect(access(active)).resolves.toBeUndefined();
      await expect(access(join(home, ".skillpark"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("does not execute a disabled conflict even if a prompt adapter returns it", async () => {
    const home = await makeTempHome();
    await createSkill(join(home, ".claude", "skills"), "safe");
    await createSkill(join(home, ".claude", "skills"), "conflict");
    await createSkill(join(home, ".skillpark", "skills", "claude"), "conflict");
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany(_message, choices) {
          expect(
            choices.find((choice) => choice.value === "conflict")?.disabled,
          ).toBe(true);
          return ["conflict", "safe"];
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

    await runMoveSkills("store", "claude", context);

    await expect(
      access(join(home, ".skillpark", "skills", "claude", "safe")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(home, ".claude", "skills", "conflict")),
    ).resolves.toBeUndefined();
  });

  it.each([
    { action: "store" as const, occupant: "regular file" as const },
    {
      action: "restore" as const,
      occupant: "metadata-less directory" as const,
    },
    { action: "restore" as const, occupant: "broken link" as const },
  ])(
    "disables an invisible $occupant destination during $action",
    async ({ action, occupant }) => {
      const home = await makeTempHome();
      const activeRoot = join(home, ".claude", "skills");
      const parkedRoot = join(home, ".skillpark", "skills", "claude");
      const sourceRoot = action === "store" ? activeRoot : parkedRoot;
      const destinationRoot = action === "store" ? parkedRoot : activeRoot;
      const source = await createSkill(sourceRoot, "pdf");
      const destination = join(destinationRoot, "pdf");
      await mkdir(destinationRoot, { recursive: true });
      if (occupant === "regular file") {
        await writeFile(destination, "occupied", "utf8");
      } else if (occupant === "metadata-less directory") {
        await mkdir(destination);
      } else {
        await symlink(
          join(home, "missing-target"),
          destination,
          process.platform === "win32" ? "junction" : undefined,
        );
      }

      let confirmCalls = 0;
      let journalCalls = 0;
      let executorCalls = 0;
      const context = createCommandContext({
        homeDir: home,
        prompts: {
          async selectMany(_message, choices) {
            const choice = choices.find(
              (candidate) => candidate.value === "pdf",
            );
            expect(choice?.disabled).toBe(true);
            expect(choice?.hint).toContain(destination);
            return ["pdf"];
          },
          async confirm() {
            confirmCalls += 1;
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
        journals: {
          async create() {
            journalCalls += 1;
            throw new Error("must not create journal");
          },
          async save() {},
          async remove() {},
          async list() {
            return [];
          },
        },
        executor: {
          async apply() {
            executorCalls += 1;
            throw new Error("must not apply");
          },
          async revert() {},
        },
      });

      await runMoveSkills(action, "claude", context);

      expect(confirmCalls).toBe(0);
      expect(journalCalls).toBe(0);
      expect(executorCalls).toBe(0);
      expect((await lstat(source)).isDirectory()).toBe(true);
      const destinationInfo = await lstat(destination);
      if (occupant === "regular file") {
        expect(destinationInfo.isFile()).toBe(true);
        expect(await readFile(destination, "utf8")).toBe("occupied");
      } else if (occupant === "metadata-less directory") {
        expect(destinationInfo.isDirectory()).toBe(true);
        await expect(
          access(join(destination, "SKILL.md")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(destinationInfo.isSymbolicLink()).toBe(true);
        expect(await readlink(destination)).toBe(join(home, "missing-target"));
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "propagates a non-ENOENT destination lstat error",
    async () => {
      const home = await makeTempHome();
      await createSkill(join(home, ".claude", "skills"), "pdf");
      const parkedRoot = join(home, ".skillpark", "skills", "claude");
      await mkdir(parkedRoot, { recursive: true });
      await chmod(parkedRoot, 0o400);
      const context = createCommandContext({
        homeDir: home,
        prompts: {
          async selectMany() {
            throw new Error("must propagate before prompting");
          },
          async confirm() {
            throw new Error("must not confirm");
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

      try {
        await expect(
          runMoveSkills("store", "claude", context),
        ).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(parkedRoot, 0o700);
      }
    },
  );

  it("restores the exact broken link entry without dereferencing it", async () => {
    const home = await makeTempHome();
    const parkedRoot = join(home, ".skillpark", "skills", "claude");
    await mkdir(parkedRoot, { recursive: true });
    await symlink(
      join(home, "missing-target"),
      join(parkedRoot, "broken"),
      process.platform === "win32" ? "junction" : undefined,
    );
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany(_message, choices) {
          expect(choices[0]?.hint).toContain("Link target is missing");
          return ["broken"];
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

    await runMoveSkills("restore", "claude", context);

    expect(
      (await lstat(join(home, ".claude", "skills", "broken"))).isSymbolicLink(),
    ).toBe(true);
  });

  it("uses active and parked scan modes for store and restore", async () => {
    const home = await makeTempHome();
    const activeRoot = join(home, ".claude", "skills");
    const parkedRoot = join(home, ".skillpark", "skills", "claude");
    await mkdir(activeRoot, { recursive: true });
    await mkdir(parkedRoot, { recursive: true });
    await symlink(join(home, "missing-active"), join(activeRoot, "broken"));
    await symlink(join(home, "missing-parked"), join(parkedRoot, "broken"));
    const messages: string[] = [];
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany(_message, choices) {
          expect(choices.map((choice) => choice.value)).toEqual(["broken"]);
          return CANCELLED;
        },
        async confirm() {
          throw new Error("must not confirm");
        },
      },
      output: {
        intro() {},
        info(message) {
          messages.push(message);
        },
        success() {},
        warning() {},
        error() {},
        outro() {},
        write() {},
      },
    });

    await runMoveSkills("store", "claude", context);
    await runMoveSkills("restore", "claude", context);

    expect(messages[0]).toContain(activeRoot);
  });

  it("returns an empty state with the scanned path without creating it", async () => {
    const home = await makeTempHome();
    const activeRoot = join(home, ".claude", "skills");
    const messages: string[] = [];
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          throw new Error("must not select");
        },
        async confirm() {
          throw new Error("must not confirm");
        },
      },
      output: {
        intro() {},
        info(message) {
          messages.push(message);
        },
        success() {},
        warning() {},
        error() {},
        outro() {},
        write() {},
      },
    });

    await runMoveSkills("store", "claude", context);

    expect(messages).toEqual([
      `No skills available to store. Scanned: ${activeRoot}`,
    ]);
    await expect(access(activeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts agent aliases and rejects unsafe custom ids before prompting", async () => {
    const home = await makeTempHome();
    await createSkill(join(home, ".claude", "skills"), "pdf");
    let prompted = 0;
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          prompted += 1;
          return CANCELLED;
        },
        async confirm() {
          throw new Error("must not confirm");
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

    await runMoveSkills("store", "claude-code", context);
    await expect(
      runMoveSkills("store", "../unknown", context),
    ).rejects.toBeInstanceOf(UsageError);
    expect(prompted).toBe(1);
    await expect(access(join(home, ".skillpark"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preflights before journal creation and preserves executor errors", async () => {
    const home = await makeTempHome();
    const source = await createSkill(join(home, ".claude", "skills"), "pdf");
    const originalError = new Error("apply failed");
    let createCalls = 0;
    let applyCalls = 0;
    let removeBeforePreflight = true;
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          if (removeBeforePreflight) {
            await rm(source, { recursive: true });
          }
          return ["pdf"];
        },
        async confirm() {
          return true;
        },
      },
      output: {
        intro() {},
        info() {},
        success() {
          throw new Error("must not report success");
        },
        warning() {},
        error() {},
        outro() {},
        write() {},
      },
      journals: {
        async create(plan) {
          createCalls += 1;
          return {
            ...plan,
            states: Object.fromEntries(
              plan.items.map((item) => [item.id, "planned" as const]),
            ),
          };
        },
        async save() {},
        async remove() {},
        async list() {
          return [];
        },
      },
      executor: {
        async apply() {
          applyCalls += 1;
          throw originalError;
        },
        async revert() {},
      },
    });

    await expect(runMoveSkills("store", "claude", context)).rejects.toThrow(
      `Source disappeared: ${source}`,
    );
    expect(createCalls).toBe(0);
    expect(applyCalls).toBe(0);

    await createSkill(join(home, ".claude", "skills"), "pdf");
    removeBeforePreflight = false;
    await expect(runMoveSkills("store", "claude", context)).rejects.toBe(
      originalError,
    );
    expect(createCalls).toBe(1);
    expect(applyCalls).toBe(1);
  });

  it("rejects a parked root that redirects store outside the home boundary", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    const source = await createSkill(join(home, ".claude", "skills"), "pdf");
    await mkdir(join(home, ".skillpark", "skills"), { recursive: true });
    await linkDirectory(outside, join(home, ".skillpark", "skills", "claude"));
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return ["pdf"];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runMoveSkills("store", "claude", context)).rejects.toThrow(
      "Unsafe agent root",
    );
    await expect(access(source)).resolves.toBeUndefined();
    await expect(access(join(outside, "pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an active root that redirects restore outside the home boundary", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    const source = await createSkill(
      join(home, ".skillpark", "skills", "claude"),
      "pdf",
    );
    await mkdir(join(home, ".claude"), { recursive: true });
    await linkDirectory(outside, join(home, ".claude", "skills"));
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return ["pdf"];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runMoveSkills("restore", "claude", context)).rejects.toThrow(
      "Unsafe agent root",
    );
    await expect(access(source)).resolves.toBeUndefined();
    await expect(access(join(outside, "pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    { action: "store" as const, alias: "parked to active" },
    { action: "restore" as const, alias: "active to parked" },
  ])("rejects $alias root aliasing during $action", async ({ action }) => {
    const home = await makeTempHome();
    const active = join(home, ".claude", "skills");
    const parked = join(home, ".skillpark", "skills", "claude");
    const sourceRoot = action === "store" ? active : parked;
    const source = await createSkill(sourceRoot, "pdf");
    const aliasRoot = action === "store" ? parked : active;
    await mkdir(join(aliasRoot, ".."), { recursive: true });
    await linkDirectory(sourceRoot, aliasRoot);
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return ["pdf"];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runMoveSkills(action, "claude", context)).rejects.toThrow(
      "Unsafe agent root",
    );
    await expect(access(source)).resolves.toBeUndefined();
  });

  it("rechecks agent roots immediately before transaction preflight", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    const source = await createSkill(join(home, ".claude", "skills"), "pdf");
    const parked = join(home, ".skillpark", "skills", "claude");
    const confirm = vi.fn(async () => true);
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          await mkdir(join(home, ".skillpark", "skills"), { recursive: true });
          await linkDirectory(outside, parked);
          return ["pdf"];
        },
        confirm,
      },
      output: silentOutput(),
    });

    await expect(runMoveSkills("store", "claude", context)).rejects.toThrow(
      "Unsafe agent root",
    );
    expect(confirm).not.toHaveBeenCalled();
    await expect(access(source)).resolves.toBeUndefined();
    await expect(access(join(outside, "pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rechecks agent roots after confirmation", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    const source = await createSkill(join(home, ".claude", "skills"), "pdf");
    const parked = join(home, ".skillpark", "skills", "claude");
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return ["pdf"];
        },
        async confirm() {
          await mkdir(join(home, ".skillpark", "skills"), { recursive: true });
          await linkDirectory(outside, parked);
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runMoveSkills("store", "claude", context)).rejects.toThrow(
      "Unsafe agent root",
    );
    await expect(access(source)).resolves.toBeUndefined();
    await expect(access(join(outside, "pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    {
      action: "store" as const,
      mutation: "regular file" as const,
      expected: "Source type changed",
    },
    {
      action: "restore" as const,
      mutation: "link" as const,
      expected: "Source type changed",
    },
    {
      action: "store" as const,
      mutation: "missing" as const,
      expected: "Source disappeared",
    },
    {
      action: "restore" as const,
      mutation: "destination" as const,
      expected: "Destination exists",
    },
  ])(
    "preflights again after confirmation when $action source becomes $mutation",
    async ({ action, mutation, expected }) => {
      const home = await makeTempHome();
      const active = join(home, ".claude", "skills");
      const parked = join(home, ".skillpark", "skills", "claude");
      const sourceRoot = action === "store" ? active : parked;
      const destinationRoot = action === "store" ? parked : active;
      const source = await createSkill(sourceRoot, "pdf");
      const destination = join(destinationRoot, "pdf");
      const replacement = await createSkill(
        join(await makeTempHome(), "replacement"),
        "pdf",
      );
      const baseJournals = createJournalStore(
        join(home, ".skillpark", ".transactions"),
      );
      let createCalls = 0;
      const journals: JournalStore = {
        async create(plan) {
          createCalls += 1;
          return baseJournals.create(plan);
        },
        save: baseJournals.save,
        remove: baseJournals.remove,
        list: baseJournals.list,
      };
      const apply = vi.fn(async () => {
        throw new Error("executor must not run");
      });
      const context = createCommandContext({
        homeDir: home,
        journals,
        prompts: {
          async selectMany() {
            return ["pdf"];
          },
          async confirm() {
            if (mutation === "destination") {
              await createSkill(destinationRoot, "pdf");
            } else {
              await rm(source, { recursive: true });
              if (mutation === "regular file") {
                await writeFile(source, "replacement", "utf8");
              } else if (mutation === "link") {
                await linkDirectory(replacement, source);
              }
            }
            return true;
          },
        },
        output: silentOutput(),
        executor: { apply, async revert() {} },
      });

      await expect(runMoveSkills(action, "claude", context)).rejects.toThrow(
        expected,
      );
      expect(apply).not.toHaveBeenCalled();
      expect(createCalls).toBe(0);
      expect(await baseJournals.list()).toEqual([]);
      if (mutation === "destination") {
        await expect(access(source)).resolves.toBeUndefined();
        await expect(access(destination)).resolves.toBeUndefined();
      }
    },
  );

  it("rechecks agent roots after the running journal save and before apply", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    const source = await createSkill(join(home, ".claude", "skills"), "pdf");
    const parked = join(home, ".skillpark", "skills", "claude");
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
          await mkdir(join(home, ".skillpark", "skills"), { recursive: true });
          await linkDirectory(outside, parked);
        }
      },
    };
    const context = createCommandContext({
      homeDir: home,
      journals,
      prompts: {
        async selectMany() {
          return ["pdf"];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(runMoveSkills("store", "claude", context)).rejects.toThrow(
      "Unsafe agent root",
    );
    await expect(access(source)).resolves.toBeUndefined();
    await expect(access(join(outside, "pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const [record] = await baseJournals.list();
    const [item] = record?.items ?? [];
    expect(item).toBeDefined();
    expect(item === undefined ? undefined : record?.states[item.id]).toBe(
      "running",
    );
  });

  it("refuses rollback through a root replaced during apply", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    const active = join(home, ".claude", "skills");
    const parked = join(home, ".skillpark", "skills", "claude");
    const displaced = join(home, "displaced-parked-root");
    await createSkill(active, "one");
    await createSkill(active, "two");
    const nodeExecutor = createNodeItemExecutor();
    const primary = new Error("second move failed");
    let applications = 0;
    let firstEntry = "";
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return ["one", "two"];
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
            firstEntry = item.entryName;
            await nodeExecutor.apply(item);
            return;
          }
          await rename(parked, displaced);
          await rename(join(displaced, firstEntry), join(outside, firstEntry));
          await linkDirectory(outside, parked);
          throw primary;
        },
        revert: (item) => nodeExecutor.revert(item),
      },
    });

    await expect(runMoveSkills("store", "claude", context)).rejects.toBe(
      primary,
    );
    await expect(
      readFile(join(outside, firstEntry, "SKILL.md"), "utf8"),
    ).resolves.toContain(`name: ${firstEntry}`);
    await expect(access(join(active, firstEntry))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const [record] = await context.journals.list();
    expect(record?.states).toEqual(
      expect.objectContaining({
        [record?.items[0]?.id ?? "missing"]: "completed",
      }),
    );
  });

  it("builds move operations with correct store and restore paths and reports counts", async () => {
    const home = await makeTempHome();
    await createSkill(join(home, ".claude", "skills"), "pdf");
    await createSkill(join(home, ".claude", "skills"), "docs");
    await createSkill(join(home, ".skillpark", "skills", "claude"), "archive");
    const applied: Array<{
      operation: string;
      source: string;
      destination: string;
    }> = [];
    const successes: string[] = [];
    const selections = [["pdf"], ["archive"]];
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return selections.shift() ?? CANCELLED;
        },
        async confirm() {
          return true;
        },
      },
      output: {
        intro() {},
        info() {},
        success(message) {
          successes.push(message);
        },
        warning() {},
        error() {},
        outro() {},
        write() {},
      },
      executor: {
        async apply(item) {
          applied.push(item);
        },
        async revert() {},
      },
    });

    await runMoveSkills("store", "claude", context);
    await runMoveSkills("restore", "claude", context);

    expect(applied).toEqual([
      expect.objectContaining({
        operation: "move",
        source: join(home, ".claude", "skills", "pdf"),
        destination: join(home, ".skillpark", "skills", "claude", "pdf"),
      }),
      expect.objectContaining({
        operation: "move",
        source: join(home, ".skillpark", "skills", "claude", "archive"),
        destination: join(home, ".claude", "skills", "archive"),
      }),
    ]);
    expect(successes).toEqual([
      "Parked 1 · unchanged 1 · failed 0",
      "Restored 1 · unchanged 0 · failed 0",
    ]);
  });

  it("registers store and restore commands", () => {
    const home = "/temporary-home-not-used";
    const program = createProgram(
      createCommandContext({
        homeDir: home,
        prompts: {
          async selectMany() {
            return CANCELLED;
          },
          async confirm() {
            return CANCELLED;
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
      }),
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
