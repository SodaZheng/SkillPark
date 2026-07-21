import type { Command } from "commander";
import { isAbsolute, relative, sep } from "node:path";
import {
  detectAgents,
  getAgentDefinition,
  getAgentSkillRoot,
  supportsGlobalSkills,
} from "../agents/registry.js";
import { getGatewayHookAdapter } from "../hooks/gateway.js";
import { renderTable } from "../tui/table.js";
import type { CommandContext } from "./context.js";

function compactPath(path: string, root: string, prefix: "." | "~"): string {
  const relativePath = relative(root, path);
  if (relativePath === "") return prefix;
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return path;
  }
  return `${prefix}${sep}${relativePath}`;
}

export async function runListAgents(context: CommandContext): Promise<void> {
  const detections = await detectAgents(
    context.homeDir,
    context.cwd,
    context.agentConfigDirs,
  );
  const agents = detections.map((detection) => {
    const definition = getAgentDefinition(detection.id);
    return {
      id: detection.id,
      label: definition.label,
      detected: detection.detected,
      hook: getGatewayHookAdapter(detection.id)?.id,
      globalSkills: supportsGlobalSkills(detection.id)
        ? compactPath(
            getAgentSkillRoot(
              detection.id,
              "global",
              context.homeDir,
              context.cwd,
              context.agentConfigDirs,
            ),
            context.homeDir,
            "~",
          )
        : "unsupported",
      projectSkills: compactPath(
        getAgentSkillRoot(
          detection.id,
          "current",
          context.homeDir,
          context.cwd,
          context.agentConfigDirs,
        ),
        context.cwd,
        ".",
      ),
      parkedSkills: compactPath(detection.paths.parked, context.homeDir, "~"),
    };
  });
  agents.sort(
    (left, right) =>
      Number(right.detected) - Number(left.detected) ||
      left.label.localeCompare(right.label),
  );
  const detected = agents.filter((agent) => agent.detected).length;
  context.output.write(
    [
      `Supported agents: ${agents.length} · Detected: ${detected}`,
      renderTable(
        [
          { header: "Detected" },
          { header: "Agent", maxWidth: 24 },
          { header: "ID", maxWidth: 22 },
          { header: "Integration", maxWidth: 24 },
          { header: "Skill roots", maxWidth: 64 },
        ],
        agents.map((agent) => [
          agent.detected ? "Yes" : "No",
          agent.label,
          agent.id,
          agent.hook === undefined ? "Skills" : `Skills + ${agent.hook} hook`,
          [
            `global=${agent.globalSkills}`,
            `project=${agent.projectSkills}`,
            `parked=${agent.parkedSkills}`,
          ].join(" · "),
        ]),
      ),
    ].join("\n"),
  );
}

export function registerAgentsCommand(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("agents")
    .description("List supported agents")
    .action(async () => runListAgents(context));
}
