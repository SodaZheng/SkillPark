import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listAgentDefinitions,
  supportsGlobalSkills,
} from "../../src/agents/registry.js";
import { createCommandContext } from "../../src/commands/context.js";
import {
  preflightContextInstructions,
  renderContextInstructions,
} from "../../src/instructions/context-file.js";
import { makeTempHome } from "../support/fs.js";

const nativeContextAgents = new Set([
  "claude",
  "codex",
  "gemini-cli",
  "github-copilot",
  "qwen-code",
]);

describe("persistent context guidance", () => {
  it("routes matching requests through the installed skill instead of duplicating its CLI workflow", () => {
    const instructions = renderContextInstructions("codex");

    expect(instructions).toContain("### When to invoke the skill");
    expect(instructions).toContain(
      "Use the installed skill named `skillpark` through the host's normal skill mechanism",
    );
    expect(instructions).toContain(
      "invoke the `skillpark` skill before acting",
    );
    expect(instructions).toContain(
      "you do not know how to do the task, are unsure of the best workflow",
    );
    expect(instructions).toContain("the user asks for a skill, names one");
    expect(instructions).toContain(
      "a specialist skill could plausibly improve reliability",
    );
    expect(instructions).toContain("claim a capability is unavailable");
    expect(instructions).toContain(
      "Pass the user's complete request and any explicit skill name",
    );
    expect(instructions).toContain(
      "casual conversation, simple factual answers",
    );
    expect(instructions).toContain(
      "do not bypass it by running SkillPark CLI commands directly",
    );
    expect(instructions).not.toContain("skillpark search");
    expect(instructions).not.toContain("skillpark get");
    expect(instructions).not.toContain("skillpark list");
    expect(instructions).not.toContain("skillpark hook");
  });

  it("plans a native or AGENTS.md context file for all built-in agents", async () => {
    const home = await makeTempHome();
    const current = await makeTempHome();
    const context = createCommandContext({ cwd: current, homeDir: home });
    const definitions = listAgentDefinitions();

    expect(definitions).toHaveLength(73);
    for (const definition of definitions) {
      const scope = supportsGlobalSkills(definition.id) ? "global" : "current";
      const plan = await preflightContextInstructions(
        definition.id,
        context,
        scope,
      );
      expect(plan, definition.id).toBeDefined();
      expect(plan?.compatibilityFallback, definition.id).toBe(
        !nativeContextAgents.has(definition.id),
      );
      if (!nativeContextAgents.has(definition.id)) {
        expect(plan?.path, definition.id).toMatch(/AGENTS\.md$/u);
      }
    }
  });

  it("uses AGENTS.md compatibility guidance for custom agents", async () => {
    const home = await makeTempHome();
    const current = await makeTempHome();
    const context = createCommandContext({ cwd: current, homeDir: home });

    const global = await preflightContextInstructions(
      "sodagent",
      context,
      "global",
    );
    const project = await preflightContextInstructions(
      "sodagent",
      context,
      "current",
    );

    expect(global).toEqual(
      expect.objectContaining({
        compatibilityFallback: true,
        path: join(home, ".sodagent", "AGENTS.md"),
      }),
    );
    expect(project).toEqual(
      expect.objectContaining({
        compatibilityFallback: true,
        path: join(current, "AGENTS.md"),
      }),
    );
  });
});
