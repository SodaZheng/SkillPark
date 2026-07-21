import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/app/create-program.js";
import { createCommandContext } from "../../src/commands/context.js";
import { getParkedSkill } from "../../src/commands/get.js";
import { UsageError } from "../../src/domain/errors.js";
import type { OutputPort } from "../../src/tui/ports.js";
import { createSkill, makeTempHome } from "../support/fs.js";

function captureOutput(): { messages: string[]; output: OutputPort } {
  const messages: string[] = [];
  return {
    messages,
    output: {
      intro() {},
      info() {},
      success() {},
      warning() {},
      error() {},
      outro() {},
      write(message) {
        messages.push(message);
      },
    },
  };
}

describe("get command", () => {
  it("prints the selected root and complete SKILL.md", async () => {
    const home = await makeTempHome();
    const root = await createSkill(
      join(home, ".skillpark", "skills", "claude"),
      "documents",
    );
    await writeFile(
      join(root, "SKILL.md"),
      "---\nname: documents\ndescription: Document work\n---\n\n# Complete instructions\n\nRead references/forms.md.\n",
      "utf8",
    );
    const { messages, output } = captureOutput();

    await createProgram(
      createCommandContext({ homeDir: home, output }),
    ).parseAsync(["node", "skillpark", "get", "claude-code", "/documents"]);

    expect(messages).toEqual([expect.stringContaining(`Skill root: ${root}`)]);
    expect(messages[0]).toContain(
      `Instruction file: ${join(root, "SKILL.md")}`,
    );
    expect(messages[0]).toContain("# Complete instructions");
    expect(messages[0]).toContain("Read references/forms.md.");
  });

  it("treats one argument as the skill and prompts for its agent", async () => {
    const home = await makeTempHome();
    const root = await createSkill(
      join(home, ".skillpark", "skills", "codex"),
      "documents",
    );
    const { messages, output } = captureOutput();

    await createProgram(
      createCommandContext({
        homeDir: home,
        output,
        prompts: {
          async selectOne(message, choices) {
            expect(message).toBe("Select the agent that owns /documents");
            expect(choices).toHaveLength(73);
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
    ).parseAsync(["node", "skillpark", "get", "/documents"]);

    expect(messages).toEqual([expect.stringContaining(`Skill root: ${root}`)]);
  });

  it("reports a missing skill before prompting for an agent", async () => {
    const home = await makeTempHome();

    await expect(
      createProgram(createCommandContext({ homeDir: home })).parseAsync([
        "node",
        "skillpark",
        "get",
      ]),
    ).rejects.toEqual(
      new UsageError(
        "Missing skill name. Usage: skillpark get [agent] <skill>",
      ),
    );
  });

  it("requires the exact direct-child entry name", async () => {
    const home = await makeTempHome();
    await createSkill(join(home, ".skillpark", "skills", "codex"), "documents");

    await expect(getParkedSkill("codex", "../documents", home)).rejects.toEqual(
      new UsageError('Unsafe parked skill name: "../documents"'),
    );
  });

  it("points missing names back to the parked list", async () => {
    const home = await makeTempHome();

    await expect(getParkedSkill("codex", "/missing", home)).rejects.toEqual(
      new UsageError(
        "Parked skill not found for codex: missing. Use `skillpark list codex --parked` to list valid entry names.",
      ),
    );
  });
});
