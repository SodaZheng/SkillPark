import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCommandContext } from "../../src/commands/context.js";
import { recoverPendingTransactions } from "../../src/commands/recovery.js";
import { runAdd } from "../../src/commands/add.js";
import { runMoveSkills } from "../../src/commands/move-skills.js";
import { CommandCancelledError } from "../../src/domain/errors.js";
import { stageSource } from "../../src/sources/stage.js";
import {
  GATEWAY_SKILL_ENTRY_NAME,
  bundledGatewaySkillRoot,
} from "../../src/skills/gateway.js";
import {
  createJournalStore,
  type JournalStore,
} from "../../src/storage/journal.js";
import type { TransactionRecord } from "../../src/storage/types.js";
import { CANCELLED } from "../../src/tui/ports.js";
import { createSkill, makeTempHome } from "../support/fs.js";

function silentOutput() {
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

async function retainedAdd(
  home: string,
  state: "completed" | "reverted" = "completed",
) {
  const input = join(home, "input");
  await createSkill(join(input, "skills"), "pdf");
  const staged = await stageSource(
    { kind: "local", path: input },
    join(home, ".skillpark", ".tmp"),
    { async run() {} },
  );
  const source = join(staged.root, "skills", "pdf");
  const destination = join(home, ".skillpark", "skills", "claude", "pdf");
  if (state === "completed") {
    await mkdir(join(destination, ".."), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
  const record: TransactionRecord = {
    id: "retained-add",
    action: "add",
    createdAt: "2026-07-16T00:00:00.000Z",
    sourceStage: staged.sourceStage,
    items: [
      {
        id: "pdf",
        agent: "claude",
        entryName: "pdf",
        entryKind: "directory",
        operation: "copy",
        source,
        destination,
      },
    ],
    states: { pdf: state },
  };
  return { destination, record, stage: staged.sourceStage };
}

describe("recoverPendingTransactions", () => {
  it("does not prompt when no journal exists", async () => {
    const context = createCommandContext({ homeDir: await makeTempHome() });
    const confirm = vi.spyOn(context.prompts, "confirm");

    await recoverPendingTransactions(context);

    expect(confirm).not.toHaveBeenCalled();
  });

  it("recovers a completed gateway install by removing the verified copy", async () => {
    const home = await makeTempHome();
    const source = bundledGatewaySkillRoot();
    const destination = join(
      home,
      ".codex",
      "skills",
      GATEWAY_SKILL_ENTRY_NAME,
    );
    await mkdir(join(destination, ".."), { recursive: true });
    await cp(source, destination, { recursive: true });
    const record: TransactionRecord = {
      id: "pending-install",
      action: "install",
      createdAt: "2026-07-20T00:00:00.000Z",
      items: [
        {
          id: "gateway",
          agent: "codex",
          entryName: GATEWAY_SKILL_ENTRY_NAME,
          entryKind: "directory",
          operation: "copy",
          source,
          destination,
        },
      ],
      states: { gateway: "completed" },
    };
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(record);

    await recoverPendingTransactions(context);

    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await context.journals.list()).toEqual([]);
  });

  it("rejects an install journal whose source is not the bundled gateway", async () => {
    const home = await makeTempHome();
    const source = await createSkill(join(home, "forged"), "skillpark");
    const destination = join(home, ".codex", "skills", "skillpark");
    const record: TransactionRecord = {
      id: "forged-install",
      action: "install",
      createdAt: "2026-07-20T00:00:00.000Z",
      items: [
        {
          id: "gateway",
          agent: "codex",
          entryName: "skillpark",
          entryKind: "directory",
          operation: "copy",
          source,
          destination,
        },
      ],
      states: { gateway: "planned" },
    };
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(record);

    await expect(recoverPendingTransactions(context)).rejects.toThrow(
      "Manual recovery required: install item path mismatch for skillpark",
    );
    await expect(access(source)).resolves.toBeUndefined();
  });

  it.each([false, CANCELLED] as const)(
    "reports recovery confirmation %s as command cancellation and retains the journal",
    async (confirmation) => {
      const home = await makeTempHome();
      const pending = await retainedAdd(home, "reverted");
      const context = createCommandContext({
        homeDir: home,
        prompts: {
          async selectMany() {
            return [];
          },
          async confirm() {
            return confirmation;
          },
        },
        output: silentOutput(),
      });
      await context.journals.save(pending.record);

      await expect(recoverPendingTransactions(context)).rejects.toBeInstanceOf(
        CommandCancelledError,
      );
      expect(await context.journals.list()).toHaveLength(1);
    },
  );

  it.each(["store", "restore"] as const)(
    "gates %s before scanning either agent root",
    async (action) => {
      const home = await makeTempHome();
      const destination = await createSkill(
        join(home, ".skillpark", "skills", "claude"),
        "pending",
      );
      const record: TransactionRecord = {
        id: `pending-${action}`,
        action: "store",
        createdAt: "2026-07-16T00:00:00.000Z",
        items: [
          {
            id: "pending",
            agent: "claude",
            entryName: "pending",
            entryKind: "directory",
            operation: "move",
            source: join(home, ".claude", "skills", "pending"),
            destination,
          },
        ],
        states: { pending: "completed" },
      };
      const context = createCommandContext({
        homeDir: home,
        prompts: {
          async selectMany() {
            throw new Error("scan reached prompting");
          },
          async confirm() {
            return false;
          },
        },
        output: silentOutput(),
      });
      await context.journals.save(record);

      await expect(runMoveSkills(action, "claude", context)).rejects.toThrow(
        "Recovery is required",
      );
      await expect(access(destination)).resolves.toBeUndefined();
    },
  );

  it("gates add after source parsing but before source filesystem access or staging", async () => {
    const home = await makeTempHome();
    const pending = await retainedAdd(home, "reverted");
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          throw new Error("staging reached prompting");
        },
        async confirm() {
          return false;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(pending.record);

    await expect(runAdd("./missing-source", context)).rejects.toThrow(
      "Recovery is required",
    );
    await expect(access(join(home, "missing-source"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores a completed move before another mutation can start", async () => {
    const home = await makeTempHome();
    const destination = await createSkill(
      join(home, ".skillpark", "skills", "claude"),
      "pdf",
    );
    const source = join(home, ".claude", "skills", "pdf");
    const record: TransactionRecord = {
      id: "pending-store",
      action: "store",
      createdAt: "2026-07-16T00:00:00.000Z",
      items: [
        {
          id: "pdf",
          agent: "claude",
          entryName: "pdf",
          entryKind: "directory",
          operation: "move",
          source,
          destination,
        },
      ],
      states: { pdf: "completed" },
    };
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(record);

    await recoverPendingTransactions(context);

    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toContain(
      "name: pdf",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await context.journals.list()).toEqual([]);
  });

  it("refuses recovery when a parked root is replaced with an active-root alias", async () => {
    const home = await makeTempHome();
    const retainedAddState = await retainedAdd(home);
    const activeRoot = join(home, ".claude", "skills");
    const parkedRoot = join(home, ".skillpark", "skills", "claude");
    const { record } = retainedAddState;
    const displaced = join(home, "displaced-parked-root");
    const activeCopy = join(activeRoot, "pdf");
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          await rename(parkedRoot, displaced);
          await mkdir(activeRoot, { recursive: true });
          await rename(join(displaced, "pdf"), activeCopy);
          await symlink(
            activeRoot,
            parkedRoot,
            process.platform === "win32" ? "junction" : "dir",
          );
          return true;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(record);

    await expect(recoverPendingTransactions(context)).rejects.toThrow(
      "Unsafe agent root",
    );

    await expect(
      readFile(join(activeCopy, "SKILL.md"), "utf8"),
    ).resolves.toContain("name: pdf");
    expect(await context.journals.list()).toHaveLength(1);
  });

  it("rejects an add journal targeting a valuable path outside the agent parked root", async () => {
    const home = await makeTempHome();
    const { destination, record } = await retainedAdd(home);
    const item = record.items[0];
    if (item === undefined) throw new Error("missing retained add item");
    await rm(destination, { recursive: true });
    const valuable = join(home, "Documents", "valuable");
    await mkdir(join(home, "Documents"), { recursive: true });
    await cp(item.source, valuable, { recursive: true });
    item.destination = valuable;
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(record);

    await expect(recoverPendingTransactions(context)).rejects.toThrow(
      "Manual recovery required",
    );

    await expect(
      readFile(join(valuable, "SKILL.md"), "utf8"),
    ).resolves.toContain("name: pdf");
    const [retained] = await context.journals.list();
    expect(retained?.states).toEqual({ pdf: "completed" });
  });

  it("reverts an add, safely cleans its retained source stage, then removes the journal", async () => {
    const home = await makeTempHome();
    const { destination, record, stage } = await retainedAdd(home);
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(record);

    await recoverPendingTransactions(context);

    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(stage.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await context.journals.list()).toEqual([]);
  });

  it("recovers an add whose discovered root skill is the stage payload itself", async () => {
    const home = await makeTempHome();
    const input = await createSkill(home, "root-input", {
      name: "root-skill",
      description: "root skill",
    });
    const staged = await stageSource(
      { kind: "local", path: input },
      join(home, ".skillpark", ".tmp"),
      { async run() {} },
    );
    const destination = join(
      home,
      ".skillpark",
      "skills",
      "claude",
      "root-input",
    );
    await mkdir(join(home, ".skillpark", "skills", "claude"), {
      recursive: true,
    });
    await cp(staged.root, destination, { recursive: true });
    const record: TransactionRecord = {
      id: "root-stage-add",
      action: "add",
      createdAt: "2026-07-16T00:00:00.000Z",
      sourceStage: staged.sourceStage,
      items: [
        {
          id: "root-input",
          agent: "claude",
          entryName: "root-input",
          entryKind: "directory",
          operation: "copy",
          source: staged.root,
          destination,
        },
      ],
      states: { "root-input": "completed" },
    };
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(record);

    await recoverPendingTransactions(context);

    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(staged.sourceStage.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await context.journals.list()).toEqual([]);
  });

  it("preserves a retained stage and journal when ownership metadata is changed", async () => {
    const home = await makeTempHome();
    const { destination, record, stage } = await retainedAdd(home);
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(record);
    await writeFile(stage.marker, "changed ownership\n");

    await expect(recoverPendingTransactions(context)).rejects.toThrow(
      "Manual cleanup required",
    );

    await expect(lstat(stage.container)).resolves.toBeDefined();
    await expect(
      readFile(join(destination, "SKILL.md"), "utf8"),
    ).resolves.toContain("name: pdf");
    const [retained] = await context.journals.list();
    expect(retained?.states).toEqual({ pdf: "completed" });
  });

  it("preserves an exact-content regular-file replacement of the owner marker", async () => {
    const home = await makeTempHome();
    const { destination, record, stage } = await retainedAdd(home);
    const markerContent = await readFile(stage.marker, "utf8");
    await rename(stage.marker, join(home, "owned-marker.json"));
    await writeFile(stage.marker, markerContent);
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(record);

    await expect(recoverPendingTransactions(context)).rejects.toThrow(
      "Manual cleanup required",
    );

    expect((await lstat(stage.marker)).isFile()).toBe(true);
    await expect(
      readFile(join(destination, "SKILL.md"), "utf8"),
    ).resolves.toContain("name: pdf");
    const [retained] = await context.journals.list();
    expect(retained?.states).toEqual({ pdf: "completed" });
  });

  it.runIf(process.platform !== "win32")(
    "preserves a symbolic-link replacement of the owner marker",
    async () => {
      const home = await makeTempHome();
      const { destination, record, stage } = await retainedAdd(home);
      const ownedMarker = join(home, "owned-marker.json");
      await rename(stage.marker, ownedMarker);
      await symlink(ownedMarker, stage.marker, "file");
      const context = createCommandContext({
        homeDir: home,
        prompts: {
          async selectMany() {
            return [];
          },
          async confirm() {
            return true;
          },
        },
        output: silentOutput(),
      });
      await context.journals.save(record);

      await expect(recoverPendingTransactions(context)).rejects.toThrow(
        "Manual cleanup required",
      );

      expect((await lstat(stage.marker)).isSymbolicLink()).toBe(true);
      await expect(
        readFile(join(destination, "SKILL.md"), "utf8"),
      ).resolves.toContain("name: pdf");
      const [retained] = await context.journals.list();
      expect(retained?.states).toEqual({ pdf: "completed" });
    },
  );

  it("retries after stage cleanup completed but journal removal was interrupted", async () => {
    const home = await makeTempHome();
    const { destination, record, stage } = await retainedAdd(home);
    const baseJournals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await baseJournals.save(record);
    const interruption = new Error("journal removal interrupted");
    let removeCalls = 0;
    const interruptedJournals: JournalStore = {
      create: baseJournals.create,
      save: baseJournals.save,
      list: baseJournals.list,
      async remove(id) {
        removeCalls += 1;
        if (removeCalls === 1) throw interruption;
        await baseJournals.remove(id);
      },
    };
    const context = createCommandContext({
      homeDir: home,
      journals: interruptedJournals,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });

    await expect(recoverPendingTransactions(context)).rejects.toBe(
      interruption,
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(stage.container)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await baseJournals.list()).toHaveLength(1);

    await recoverPendingTransactions(context);
    expect(await baseJournals.list()).toEqual([]);
  });

  it.each(["isolated", "marker-only", "marker-removed"] as const)(
    "continues retained-stage cleanup from the %s phase",
    async (phase) => {
      const home = await makeTempHome();
      const { record, stage } = await retainedAdd(home, "reverted");
      await rename(stage.payload, stage.isolatedPayload);
      if (phase !== "isolated") {
        await rm(stage.isolatedPayload, { recursive: true });
      }
      if (phase === "marker-removed") await unlink(stage.marker);
      const context = createCommandContext({
        homeDir: home,
        prompts: {
          async selectMany() {
            return [];
          },
          async confirm() {
            return true;
          },
        },
        output: silentOutput(),
      });
      await context.journals.save(record);

      await recoverPendingTransactions(context);

      await expect(access(stage.container)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await context.journals.list()).toEqual([]);
    },
  );

  it("rejects a replaced temp root even when the retained container is already absent", async () => {
    const home = await makeTempHome();
    const { record, stage } = await retainedAdd(home, "reverted");
    await rm(stage.container, { recursive: true });
    await rename(stage.tempRoot, `${stage.tempRoot}-owned`);
    await mkdir(stage.tempRoot, { recursive: true });
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectMany() {
          return [];
        },
        async confirm() {
          return true;
        },
      },
      output: silentOutput(),
    });
    await context.journals.save(record);

    await expect(recoverPendingTransactions(context)).rejects.toThrow(
      "Manual cleanup required",
    );

    const [retained] = await context.journals.list();
    expect(retained?.states).toEqual({ pdf: "reverted" });
  });
});
