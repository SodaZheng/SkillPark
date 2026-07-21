import { detectAgents, parseAgentId } from "../agents/registry.js";
import type { AgentDetection, AgentId } from "../domain/agents.js";
import { UsageError } from "../domain/errors.js";
import {
  CANCELLED,
  type Cancelled,
  type SelectionChoice,
} from "../tui/ports.js";
import type { CommandContext } from "./context.js";

interface SelectAgentOptions {
  message?: string;
  allowedAgents?: readonly AgentId[];
}

export function agentSelectionChoices(
  detections: readonly AgentDetection[],
  allowedAgents?: readonly AgentId[],
): SelectionChoice[] {
  const allowed =
    allowedAgents === undefined ? undefined : new Set<AgentId>(allowedAgents);
  return detections
    .filter((agent) => allowed?.has(agent.id) ?? true)
    .map((agent, index) => ({ agent, index }))
    .sort(
      (left, right) =>
        Number(right.agent.detected) - Number(left.agent.detected) ||
        left.index - right.index,
    )
    .map(({ agent }) => ({
      value: agent.id,
      label: `${agent.label} (${agent.id})`,
      hint: `${agent.detected ? "detected" : "not detected"} → ${agent.paths.active}`,
    }));
}

export async function selectAgent(
  agentArgument: string | undefined,
  context: CommandContext,
  options: SelectAgentOptions = {},
): Promise<AgentId | Cancelled> {
  if (agentArgument !== undefined) {
    return parseAgentId(agentArgument);
  }

  if (context.prompts.selectOne === undefined) {
    throw new UsageError(
      "Agent selection is unavailable; pass an agent id explicitly.",
    );
  }

  const detections = await detectAgents(context.homeDir, context.cwd);
  const choices = agentSelectionChoices(detections, options.allowedAgents);
  if (choices.length === 0) {
    throw new UsageError("No supported agents are available for this command.");
  }
  const selected = await context.prompts.selectOne(
    options.message ?? "Select an agent",
    choices,
  );
  if (selected === CANCELLED) return CANCELLED;
  if (!choices.some((choice) => choice.value === selected)) {
    throw new Error(`Invalid agent selection: ${selected}`);
  }
  return parseAgentId(selected);
}
