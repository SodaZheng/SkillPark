import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectAgent } from "../../src/commands/agent-selection.js";
import { createCommandContext } from "../../src/commands/context.js";
import { CANCELLED } from "../../src/tui/ports.js";
import { makeTempHome } from "../support/fs.js";

describe("agent selection", () => {
  it("moves detected agents to the front and keeps every agent available", async () => {
    const home = await makeTempHome();
    const cwd = await makeTempHome();
    await mkdir(join(home, ".codex"));
    const selection: { message?: string; values?: string[] } = {};

    const agent = await selectAgent(
      undefined,
      createCommandContext({
        cwd,
        homeDir: home,
        prompts: {
          async selectOne(message, choices) {
            selection.message = message;
            selection.values = choices.map((choice) => choice.value);
            return "codex";
          },
          async selectMany() {
            return [];
          },
          async confirm() {
            return false;
          },
        },
      }),
      { message: "Choose the host" },
    );

    expect(agent).toBe("codex");
    expect(selection.message).toBe("Choose the host");
    expect(selection.values).toHaveLength(73);
    expect(selection.values?.[0]).toBe("codex");
  });

  it("supports aliases without prompting and propagates cancellation", async () => {
    const context = createCommandContext({
      prompts: {
        async selectOne() {
          return CANCELLED;
        },
        async selectMany() {
          return [];
        },
        async confirm() {
          return false;
        },
      },
    });

    await expect(selectAgent("claude-code", context)).resolves.toBe("claude");
    await expect(selectAgent(undefined, context)).resolves.toBe(CANCELLED);
  });

  it("can restrict choices to agents supported by a command", async () => {
    const home = await makeTempHome();
    const values: string[] = [];
    const context = createCommandContext({
      homeDir: home,
      prompts: {
        async selectOne(_message, choices) {
          values.push(...choices.map((choice) => choice.value));
          return "qwen-code";
        },
        async selectMany() {
          return [];
        },
        async confirm() {
          return false;
        },
      },
    });

    await expect(
      selectAgent(undefined, context, {
        allowedAgents: ["claude", "qwen-code"],
      }),
    ).resolves.toBe("qwen-code");
    expect(values).toEqual(["claude", "qwen-code"]);
  });
});
