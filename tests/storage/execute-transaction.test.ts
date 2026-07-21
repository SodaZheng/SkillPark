import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../src/domain/agents.js";
import type { ItemExecutor } from "../../src/storage/execute-transaction.js";
import { executeTransaction } from "../../src/storage/execute-transaction.js";
import { ABORTED_TAIL, createJournalStore } from "../../src/storage/journal.js";
import type { TransactionPlan } from "../../src/storage/types.js";
import { makeTempHome } from "../support/fs.js";

const plan: TransactionPlan = {
  id: "tx-1",
  action: "store",
  createdAt: "2026-07-16T00:00:00.000Z",
  items: [
    {
      id: "one",
      agent: "claude",
      entryName: "one",
      entryKind: "directory",
      operation: "move",
      source: "/a/one",
      destination: "/b/one",
    },
    {
      id: "two",
      agent: "claude",
      entryName: "two",
      entryKind: "directory",
      operation: "move",
      source: "/a/two",
      destination: "/b/two",
    },
  ],
};

describe("executeTransaction", () => {
  it("allows create to be called after destructuring the journal store", async () => {
    const home = await makeTempHome();
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    const { create } = journals;

    const record = await create(plan);

    expect(record.states).toEqual({ one: "planned", two: "planned" });
    await expect(journals.list()).resolves.toEqual([record]);
  });

  it("round-trips journal items for every supported agent", async () => {
    const home = await makeTempHome();
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    const baseItem = plan.items[0];
    if (baseItem === undefined) throw new Error("Expected a base item");
    const allAgentsPlan: TransactionPlan = {
      ...plan,
      id: "tx-all-agents",
      items: AGENT_IDS.map((agent, index) => ({
        ...baseItem,
        id: `item-${index}`,
        agent,
        entryName: `skill-${index}`,
        source: `/active/skill-${index}`,
        destination: `/parked/skill-${index}`,
      })),
    };

    const record = await journals.create(allAgentsPlan);

    await expect(journals.list()).resolves.toEqual([record]);
  });

  it("reverts completed items in reverse order when a later item fails", async () => {
    const calls: string[] = [];
    const executor: ItemExecutor = {
      async apply(item) {
        calls.push(`apply:${item.id}`);
        if (item.id === "two") throw new Error("injected failure");
      },
      async revert(item) {
        calls.push(`revert:${item.id}`);
      },
    };
    const home = await makeTempHome();
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );

    await expect(executeTransaction(plan, executor, journals)).rejects.toThrow(
      "injected failure",
    );
    expect(calls).toEqual(["apply:one", "apply:two", "revert:one"]);
    expect(await journals.list()).toEqual([
      expect.objectContaining({ states: { one: "reverted", two: "running" } }),
    ]);
  });

  it("reverts multiple completed items from last to first", async () => {
    const calls: string[] = [];
    const rollbackPlan: TransactionPlan = {
      ...plan,
      items: [
        ...plan.items,
        {
          id: "three",
          agent: "claude",
          entryName: "three",
          entryKind: "directory",
          operation: "move",
          source: "/a/three",
          destination: "/b/three",
        },
      ],
    };
    const executor: ItemExecutor = {
      async apply(item) {
        calls.push(`apply:${item.id}`);
        if (item.id === "three") throw new Error("injected failure");
      },
      async revert(item) {
        calls.push(`revert:${item.id}`);
      },
    };
    const home = await makeTempHome();
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );

    await expect(
      executeTransaction(rollbackPlan, executor, journals),
    ).rejects.toThrow("injected failure");
    expect(calls).toEqual([
      "apply:one",
      "apply:two",
      "apply:three",
      "revert:two",
      "revert:one",
    ]);
  });

  it("retains the journal when rollback itself fails", async () => {
    const executor: ItemExecutor = {
      async apply(item) {
        if (item.id === "two") throw new Error("apply failed");
      },
      async revert() {
        throw new Error("revert failed");
      },
    };
    const home = await makeTempHome();
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );

    await expect(executeTransaction(plan, executor, journals)).rejects.toThrow(
      "apply failed",
    );
    const [record] = await journals.list();
    expect(record?.states).toEqual({ one: "completed", two: "running" });
  });

  it("removes the journal after every item succeeds", async () => {
    const applied: string[] = [];
    const executor: ItemExecutor = {
      async apply(item) {
        applied.push(item.id);
      },
      async revert() {
        throw new Error("revert should not run");
      },
    };
    const home = await makeTempHome();
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );

    await executeTransaction(plan, executor, journals);

    expect(applied).toEqual(["one", "two"]);
    expect(await journals.list()).toEqual([]);
  });

  it("reads the last complete record when a crash leaves a partial tail", async () => {
    const home = await makeTempHome();
    const root = join(home, ".skillpark", ".transactions");
    const journals = createJournalStore(root);
    await mkdir(root, { recursive: true });
    await journals.create(plan);
    await appendFile(join(root, "tx-1.jsonl"), '{"interrupted"');

    const [record] = await journals.list();
    expect(record?.states).toEqual({ one: "planned", two: "planned" });
  });

  it("reads a legacy trailing-newline journal with a partial tail", async () => {
    const home = await makeTempHome();
    const root = join(home, ".skillpark", ".transactions");
    const journals = createJournalStore(root);
    const record = await journals.create(plan);
    await writeFile(
      join(root, "tx-1.jsonl"),
      `${JSON.stringify(record)}\n{"interrupted"`,
    );

    await expect(journals.list()).resolves.toEqual([record]);
  });

  it("reads a new record saved after a partial tail", async () => {
    const home = await makeTempHome();
    const root = join(home, ".skillpark", ".transactions");
    const journals = createJournalStore(root);
    const record = await journals.create(plan);
    await appendFile(join(root, "tx-1.jsonl"), '{"interrupted"');
    record.states.one = "running";

    await journals.save(record);

    const [latest] = await journals.list();
    expect(latest?.states).toEqual({ one: "running", two: "planned" });
  });

  it.each([
    {
      label: "a partial abort marker",
      suffix: `{"partial"${ABORTED_TAIL.slice(0, -4)}`,
    },
    {
      label: "a complete abort marker without its commit newline",
      suffix: `{"partial"${ABORTED_TAIL}`,
    },
    {
      label: "a committed abort marker",
      suffix: `{"partial"${ABORTED_TAIL}\n`,
    },
    {
      label: "a repeated abort after a partial marker",
      suffix: `{"partial"${ABORTED_TAIL.slice(0, -4)}${ABORTED_TAIL}\n`,
    },
  ])("returns the last committed record after $label", async ({ suffix }) => {
    const home = await makeTempHome();
    const root = join(home, ".skillpark", ".transactions");
    const journals = createJournalStore(root);
    const record = await journals.create(plan);
    await appendFile(join(root, "tx-1.jsonl"), suffix);

    await expect(journals.list()).resolves.toEqual([record]);
  });

  it("ignores a complete JSON record without a commit newline", async () => {
    const home = await makeTempHome();
    const root = join(home, ".skillpark", ".transactions");
    const journals = createJournalStore(root);
    const record = await journals.create(plan);
    const uncommitted = {
      ...record,
      states: { one: "running" as const, two: "planned" as const },
    };
    await appendFile(join(root, "tx-1.jsonl"), JSON.stringify(uncommitted));

    await expect(journals.list()).resolves.toEqual([record]);
  });

  it("rejects a corrupt record terminated by a newline", async () => {
    const home = await makeTempHome();
    const root = join(home, ".skillpark", ".transactions");
    const journals = createJournalStore(root);
    const record = await journals.create(plan);
    await writeFile(
      join(root, "tx-1.jsonl"),
      `${JSON.stringify(record)}\n{"corrupt"\n`,
    );

    await expect(journals.list()).rejects.toThrow(
      "Corrupt transaction journal",
    );
  });

  it.each([
    { label: "malformed JSON", fragment: '{"corrupt"' },
    { label: "invalid record structure", fragment: "{}" },
  ])(
    "rejects committed $label before a newer valid record",
    async ({ fragment }) => {
      const home = await makeTempHome();
      const root = join(home, ".skillpark", ".transactions");
      const journals = createJournalStore(root);
      const record = await journals.create(plan);
      const newer = {
        ...record,
        states: { one: "running" as const, two: "planned" as const },
      };
      await writeFile(
        join(root, "tx-1.jsonl"),
        `${JSON.stringify(record)}\n${fragment}\n${JSON.stringify(newer)}\n`,
      );

      await expect(journals.list()).rejects.toThrow(
        "Corrupt transaction journal",
      );
    },
  );

  it.each([
    { label: "null", serialized: "null" },
    { label: "an empty object", serialized: "{}" },
    {
      label: "states that do not match the transaction items",
      serialized: JSON.stringify({ ...plan, states: { one: "planned" } }),
    },
  ])(
    "rejects an invalid transaction record: $label",
    async ({ serialized }) => {
      const home = await makeTempHome();
      const root = join(home, ".skillpark", ".transactions");
      const journals = createJournalStore(root);
      const record = await journals.create(plan);
      await writeFile(
        join(root, "tx-1.jsonl"),
        `${JSON.stringify(record)}\n${serialized}\n`,
      );

      await expect(journals.list()).rejects.toThrow(
        "Corrupt transaction journal",
      );
    },
  );

  it("rejects a transaction record with an empty id", async () => {
    const home = await makeTempHome();
    const journals = createJournalStore(
      join(home, ".skillpark", ".transactions"),
    );
    await journals.save({
      ...plan,
      id: "",
      states: { one: "planned", two: "planned" },
    });

    await expect(journals.list()).rejects.toThrow(
      "Corrupt transaction journal",
    );
  });

  it("rejects malformed persisted source-stage ownership metadata", async () => {
    const home = await makeTempHome();
    const root = join(home, ".skillpark", ".transactions");
    const journals = createJournalStore(root);
    await mkdir(root, { recursive: true });
    const record = {
      ...plan,
      action: "add",
      sourceStage: {
        version: 2,
        id: "stage-id",
        tempRoot: "/tmp/root",
        container: "/tmp/root/.skillpark-stage-stage-id",
        marker: "/tmp/root/.skillpark-stage-stage-id/owner.json",
        payload: "/tmp/root/.skillpark-stage-stage-id/payload",
        isolatedPayload:
          "/tmp/root/.skillpark-stage-stage-id/.cleanup-payload-stage-id",
        tempRootIdentity: { dev: "1", ino: "2" },
        containerIdentity: { dev: "1", ino: "3" },
        payloadIdentity: { dev: "changed", ino: "4" },
        source: { kind: "local", path: "/input" },
      },
      states: { one: "planned", two: "planned" },
    };
    await writeFile(join(root, "tx-1.jsonl"), `${JSON.stringify(record)}\n`, {
      flag: "wx",
    });

    await expect(journals.list()).rejects.toThrow(
      "Corrupt transaction journal",
    );
  });

  it("rejects a forged store/copy record carrying an add source stage", async () => {
    const home = await makeTempHome();
    const root = join(home, ".skillpark", ".transactions");
    const journals = createJournalStore(root);
    await mkdir(root, { recursive: true });
    const tempRoot = join(home, ".skillpark", ".tmp");
    const container = join(tempRoot, ".skillpark-stage-stage-id");
    const record = {
      id: "tx-1",
      action: "store",
      createdAt: "2026-07-16T00:00:00.000Z",
      sourceStage: {
        version: 2,
        id: "stage-id",
        tempRoot,
        container,
        marker: join(container, "owner.json"),
        payload: join(container, "payload"),
        isolatedPayload: join(container, ".cleanup-payload-stage-id"),
        tempRootIdentity: { dev: "1", ino: "2" },
        containerIdentity: { dev: "1", ino: "3" },
        payloadIdentity: { dev: "1", ino: "4" },
        markerIdentity: { dev: "1", ino: "5" },
        source: { kind: "local", path: join(home, "input") },
      },
      items: [
        {
          id: "one",
          agent: "claude",
          entryName: "one",
          entryKind: "directory",
          operation: "copy",
          source: join(container, "payload", "one"),
          destination: join(home, ".skillpark", "skills", "claude", "one"),
        },
      ],
      states: { one: "completed" },
    };
    await writeFile(join(root, "tx-1.jsonl"), `${JSON.stringify(record)}\n`, {
      flag: "wx",
    });

    await expect(journals.list()).rejects.toThrow(
      "Corrupt transaction journal",
    );
  });
});
