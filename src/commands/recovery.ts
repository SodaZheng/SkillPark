import { join, resolve } from "node:path";
import { getAgentPaths } from "../agents/registry.js";
import { CommandCancelledError } from "../domain/errors.js";
import { validateEntryName } from "../sources/entry-name.js";
import {
  GATEWAY_SKILL_ENTRY_NAME,
  bundledGatewaySkillRoot,
} from "../skills/gateway.js";
import {
  cleanupRetainedSourceStage,
  preflightRetainedSourceStage,
} from "../sources/stage.js";
import type { ItemExecutor } from "../storage/execute-transaction.js";
import { recoverTransaction } from "../storage/recover.js";
import type { TransactionItem, TransactionRecord } from "../storage/types.js";
import { CANCELLED } from "../tui/ports.js";
import type { CommandContext } from "./context.js";
import {
  assertSafeSelectedAgentRoots,
  containsPath,
  createAgentRootGuardedExecutor,
} from "./path-safety.js";

function manualRecovery(message: string): Error {
  return new Error(`Manual recovery required: ${message}`);
}

function samePath(first: string, second: string): boolean {
  return resolve(first) === resolve(second);
}

function validateRecoveryRecord(
  record: TransactionRecord,
  homeDir: string,
  cwd: string = process.cwd(),
): void {
  if (record.action === "add" && record.sourceStage === undefined) {
    throw manualRecovery("add transaction is missing source-stage ownership");
  }
  if (record.action !== "add" && record.sourceStage !== undefined) {
    throw manualRecovery("non-add transaction carries source-stage ownership");
  }

  for (const item of record.items) {
    try {
      validateEntryName(item.entryName, "recovery entry name");
    } catch {
      throw manualRecovery(
        `unsafe entry name: ${JSON.stringify(item.entryName)}`,
      );
    }
    const paths = getAgentPaths(item.agent, homeDir, cwd);
    const active = join(paths.active, item.entryName);
    const parked = join(paths.parked, item.entryName);
    if (record.action === "store") {
      if (
        item.operation !== "move" ||
        !samePath(item.source, active) ||
        !samePath(item.destination, parked)
      ) {
        throw manualRecovery(`store item path mismatch for ${item.entryName}`);
      }
    } else if (record.action === "restore") {
      if (
        item.operation !== "move" ||
        !samePath(item.source, parked) ||
        !samePath(item.destination, active)
      ) {
        throw manualRecovery(
          `restore item path mismatch for ${item.entryName}`,
        );
      }
    } else if (record.action === "add") {
      const sourceStage = record.sourceStage;
      if (
        sourceStage === undefined ||
        item.operation !== "copy" ||
        !samePath(item.destination, parked) ||
        !containsPath(sourceStage.payload, item.source)
      ) {
        throw manualRecovery(`add item path mismatch for ${item.entryName}`);
      }
    } else {
      const gatewaySource = bundledGatewaySkillRoot();
      if (
        item.entryName !== GATEWAY_SKILL_ENTRY_NAME ||
        item.operation !== "copy" ||
        !samePath(item.source, gatewaySource) ||
        !samePath(item.destination, active)
      ) {
        throw manualRecovery(
          `install item path mismatch for ${item.entryName}`,
        );
      }
    }
  }
}

function sameItemIdentity(
  original: TransactionItem,
  candidate: TransactionItem,
): boolean {
  const operationMatches =
    candidate.operation === original.operation ||
    (original.operation === "move" && candidate.operation === "copy");
  return (
    candidate.id === original.id &&
    candidate.agent === original.agent &&
    candidate.entryName === original.entryName &&
    candidate.entryKind === original.entryKind &&
    operationMatches &&
    samePath(candidate.source, original.source) &&
    samePath(candidate.destination, original.destination)
  );
}

function createRecoveryExecutor(
  record: TransactionRecord,
  homeDir: string,
  cwd: string,
  executor: ItemExecutor,
): ItemExecutor {
  const guarded = createAgentRootGuardedExecutor(homeDir, executor, cwd);
  const requireMembership = (item: TransactionItem) => {
    validateRecoveryRecord(record, homeDir, cwd);
    if (!record.items.some((original) => sameItemIdentity(original, item))) {
      throw manualRecovery(`executor item is outside transaction ${record.id}`);
    }
  };
  return {
    async apply(item) {
      requireMembership(item);
      await guarded.apply(item);
    },
    async revert(item) {
      requireMembership(item);
      await guarded.revert(item);
    },
  };
}

export async function recoverPendingTransactions(
  context: CommandContext,
): Promise<void> {
  const records = await context.journals.list();
  if (records.length === 0) return;

  const confirmed = await context.prompts.confirm(
    `Recover ${records.length} unfinished SkillPark transaction${records.length === 1 ? "" : "s"} before continuing?`,
  );
  if (confirmed === CANCELLED || confirmed === false) {
    throw new CommandCancelledError(
      "Recovery is required before another filesystem change",
    );
  }

  for (const record of records) {
    validateRecoveryRecord(record, context.homeDir, context.cwd);
    await assertSafeSelectedAgentRoots(
      context.homeDir,
      [...new Set(record.items.map((item) => item.agent))],
      context.cwd,
    );
    const options =
      record.sourceStage === undefined
        ? {}
        : {
            allowMissingRevertedCopySource: true,
            beforeJournalRemoval: () =>
              cleanupRetainedSourceStage(
                record.sourceStage as NonNullable<typeof record.sourceStage>,
                join(context.homeDir, ".skillpark", ".tmp"),
                record.items.map((item) => item.source),
              ),
          };
    if (record.sourceStage !== undefined) {
      await preflightRetainedSourceStage(
        record.sourceStage,
        join(context.homeDir, ".skillpark", ".tmp"),
        record.items.map((item) => item.source),
        record.items.some((item) => record.states[item.id] !== "reverted"),
      );
    }
    await recoverTransaction(
      record,
      createRecoveryExecutor(
        record,
        context.homeDir,
        context.cwd,
        context.executor,
      ),
      context.journals,
      options,
    );
  }
  context.output.success("Recovered unfinished SkillPark transactions.");
}
