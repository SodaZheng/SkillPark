import type { AgentId } from "../domain/agents.js";
import type { EntryKind } from "../domain/skills.js";
import type { SourceStageRecovery } from "../sources/types.js";

export type TransactionAction = "store" | "restore" | "add" | "install";
export type TransactionOperation = "move" | "copy";
export type ItemState = "planned" | "running" | "completed" | "reverted";

export interface TransactionItem {
  id: string;
  agent: AgentId;
  entryName: string;
  entryKind: EntryKind;
  operation: TransactionOperation;
  source: string;
  destination: string;
}

export interface TransactionPlan {
  id: string;
  action: TransactionAction;
  createdAt: string;
  items: TransactionItem[];
  sourceStage?: SourceStageRecovery;
}

export interface TransactionRecord extends TransactionPlan {
  states: Record<string, ItemState>;
}
