import { mkdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { runListAgents } from "../../src/commands/agents.js";
import { createCommandContext } from "../../src/commands/context.js";
import type { OutputPort } from "../../src/tui/ports.js";
import { makeTempHome } from "../support/fs.js";

function captureOutput(): { output: OutputPort; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    output: {
      intro() {},
      info() {},
      success() {},
      warning() {},
      error() {},
      outro() {},
      write(message) {
        writes.push(message);
      },
    },
  };
}

describe("agents command", () => {
  it("lists every compatible agent in a table with key capabilities", async () => {
    const home = await makeTempHome();
    const cwd = await makeTempHome();
    await mkdir(join(home, ".gemini"));
    const { output, writes } = captureOutput();

    await runListAgents(createCommandContext({ cwd, homeDir: home, output }));

    const rendered = writes[0] as string;
    expect(rendered).toContain("Supported agents: 73 · Detected: 1");
    expect(rendered).toContain("│ Detected │ Agent");
    expect(rendered).toContain("│ Integration");
    expect(rendered).toContain("│ Skill roots");
    expect(rendered).toContain(`project=.${sep}${join(".agents", "skills")}`);
    expect(rendered).toContain(
      `parked=~${sep}${join(".skillpark", "skills", "gemini-cli")}`,
    );

    const rows = rendered
      .split("\n")
      .filter((line) => /^│ (?:Yes|No) /u.test(line));
    expect(rows).toHaveLength(73);
    expect(rows[0]).toMatch(
      /│ Yes\s+│ Gemini CLI\s+│ gemini-cli\s+│ Skills \+ gemini hook/u,
    );
    expect(rows.find((row) => row.includes("│ Cursor"))).toMatch(
      /│ cursor\s+│ Skills\s+│/u,
    );
    expect(rows.find((row) => row.includes("│ Eve"))).toMatch(
      /│ eve\s+│ Skills\s+│ global=unsupported/u,
    );
  });
});
