import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgentConfigDirs } from "../agents/registry.js";
import type { AgentConfigDirs } from "../domain/agents.js";
import { createJournalStore, type JournalStore } from "../storage/journal.js";
import { createNodeItemExecutor } from "../storage/node-item-executor.js";
import type { ItemExecutor } from "../storage/execute-transaction.js";
import { nodeProcessRunner } from "../sources/process-runner.js";
import type { ProcessRunner } from "../sources/types.js";
import { createClackUi } from "../tui/clack-ui.js";
import type { InputPort, OutputPort, PromptPort } from "../tui/ports.js";

export interface CommandContext {
  homeDir: string;
  cwd: string;
  agentConfigDirs: AgentConfigDirs;
  prompts: PromptPort;
  output: OutputPort;
  journals: JournalStore;
  executor: ItemExecutor;
  processRunner: ProcessRunner;
  input: InputPort;
}

const processInput: InputPort = {
  async read() {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  },
};

export function createCommandContext(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  const homeDir = overrides.homeDir ?? homedir();
  const cwd = overrides.cwd ?? process.cwd();
  const ui = createClackUi();
  return {
    homeDir,
    cwd,
    agentConfigDirs:
      overrides.agentConfigDirs ?? resolveAgentConfigDirs(homeDir, cwd),
    prompts: overrides.prompts ?? ui.prompts,
    output: overrides.output ?? ui.output,
    journals:
      overrides.journals ??
      createJournalStore(join(homeDir, ".skillpark", ".transactions")),
    executor: overrides.executor ?? createNodeItemExecutor(),
    processRunner: overrides.processRunner ?? nodeProcessRunner,
    input: overrides.input ?? processInput,
  };
}
