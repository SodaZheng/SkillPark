import type { Command } from "commander";
import { parseAgentId } from "../agents/registry.js";
import { UsageError } from "../domain/errors.js";
import {
  getGatewayHookAdapter,
  listGatewayHookAgents,
  renderGatewayHookOutput,
} from "../hooks/gateway.js";
import { CANCELLED } from "../tui/ports.js";
import { selectAgent } from "./agent-selection.js";
import type { CommandContext } from "./context.js";
import { routeParkedSkills } from "./route.js";

export async function runHook(
  agentArgument: string,
  context: CommandContext,
): Promise<void> {
  const agent = parseAgentId(agentArgument);
  const adapter = getGatewayHookAdapter(agent);
  if (adapter === undefined) {
    throw new UsageError(`Routing hooks are not supported for agent: ${agent}`);
  }
  const input = await context.input.read();
  const prompt = extractHookPrompt(input);
  const routing = await routeParkedSkills(
    agent,
    prompt,
    context.homeDir,
    context.cwd,
  );
  context.output.write(renderGatewayHookOutput(agent, routing, input));
}

export function extractHookPrompt(input: string): string {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (typeof parsed.prompt === "string") return parsed.prompt;
    if (typeof parsed.transformedPrompt === "string") {
      return parsed.transformedPrompt;
    }
  } catch {
    // Malformed or absent hook input produces no candidates, never a full catalog.
  }
  return "";
}

export function registerHookCommand(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("hook [agent]", { hidden: true })
    .description("Emit parked-skill routing context for an agent hook")
    .action(async (agentArgument: string | undefined) => {
      const agent = await selectAgent(agentArgument, context, {
        message: "Select an agent hook to preview",
        allowedAgents: listGatewayHookAgents(),
      });
      if (agent === CANCELLED) return;
      await runHook(agent, context);
    });
}
