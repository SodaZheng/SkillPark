import type { JournalStore } from "./journal.js";
import type {
  TransactionItem,
  TransactionPlan,
  TransactionRecord,
} from "./types.js";

export interface ItemExecutor {
  apply(item: TransactionItem): Promise<void>;
  revert(item: TransactionItem): Promise<void>;
}

async function setState(
  journals: JournalStore,
  record: TransactionRecord,
  itemId: string,
  state: TransactionRecord["states"][string],
): Promise<void> {
  record.states[itemId] = state;
  await journals.save(record);
}

export async function executeTransaction(
  plan: TransactionPlan,
  executor: ItemExecutor,
  journals: JournalStore,
): Promise<void> {
  const record = await journals.create(plan);
  const completed: TransactionItem[] = [];

  try {
    for (const item of plan.items) {
      await setState(journals, record, item.id, "running");
      await executor.apply(item);
      completed.push(item);
      await setState(journals, record, item.id, "completed");
    }
    await journals.remove(plan.id);
  } catch (error) {
    let rollbackFailed = false;
    for (const item of completed.reverse()) {
      try {
        await executor.revert(item);
        await setState(journals, record, item.id, "reverted");
      } catch {
        rollbackFailed = true;
      }
    }
    if (!rollbackFailed && completed.length === plan.items.length) {
      await journals.remove(plan.id);
    }
    throw error;
  }
}
