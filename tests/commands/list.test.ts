import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/app/create-program.js";
import { createCommandContext } from "../../src/commands/context.js";
import { collectAgentStatus } from "../../src/commands/list.js";
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

describe("collectAgentStatus", () => {
  it("groups active, parked, and conflicting entries", async () => {
    const home = await makeTempHome();
    await createSkill(join(home, ".claude", "skills"), "active-only");
    await createSkill(join(home, ".claude", "skills"), "conflict");
    await createSkill(
      join(home, ".skillpark", "skills", "claude"),
      "parked-only",
    );
    await createSkill(join(home, ".skillpark", "skills", "claude"), "conflict");

    const status = await collectAgentStatus("claude", home);

    expect(status.active.map((entry) => entry.entryName)).toEqual([
      "active-only",
      "conflict",
    ]);
    expect(status.parked.map((entry) => entry.entryName)).toEqual([
      "conflict",
      "parked-only",
    ]);
    expect(status.conflicts).toEqual(["conflict"]);
  });
});

describe("list command", () => {
  it("writes filtered parked metadata as readable text", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "codex");
    await createSkill(parked, "documents", {
      name: "Document Workshop",
      description: "Create and edit Word files",
    });
    await createSkill(parked, "pdf-forms", {
      name: "PDF Toolkit",
      description: "Fill and verify PDF forms",
    });
    await createSkill(join(home, ".codex", "skills"), "active-only");
    const { messages, output } = captureOutput();

    await createProgram(
      createCommandContext({ homeDir: home, output }),
    ).parseAsync([
      "node",
      "skillpark",
      "list",
      "codex",
      "--parked",
      "--query",
      "pdf forms",
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Parked (1)");
    expect(messages[0]).toContain("Skill name");
    expect(messages[0]).toContain("PDF Toolkit");
    expect(messages[0]).toContain("Fill and verify PDF forms");
    expect(messages[0]).toMatch(/│ Parked │ pdf-forms │/u);
    expect(messages[0]).not.toContain("documents");
    expect(messages[0]).not.toContain("active-only");
  });

  it("keeps invalid parked entries and warnings visible in text", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "claude");
    await mkdir(join(parked, "invalid"), { recursive: true });
    await writeFile(
      join(parked, "invalid", "SKILL.md"),
      "---\nname: invalid\n---\n",
      "utf8",
    );
    await symlink(
      join(home, "missing-target"),
      join(parked, "broken"),
      process.platform === "win32" ? "junction" : undefined,
    );
    const { messages, output } = captureOutput();

    await createProgram(
      createCommandContext({ homeDir: home, output }),
    ).parseAsync(["node", "skillpark", "list", "claude", "--parked"]);

    expect(messages[0]).toMatch(/│ Parked │ broken\s+│/u);
    expect(messages[0]).toContain("Link target is missing · Missing SKILL.md");
    expect(messages[0]).toMatch(/│ Parked │ invalid\s+│/u);
    expect(messages[0]).toContain("Missing description");
  });

  it("renders counts, conflicts, and broken parked links", async () => {
    const home = await makeTempHome();
    await createSkill(join(home, ".claude", "skills"), "active-only");
    await createSkill(join(home, ".claude", "skills"), "conflict");
    const parked = join(home, ".skillpark", "skills", "claude");
    await createSkill(parked, "parked-only");
    await createSkill(parked, "conflict");
    await mkdir(parked, { recursive: true });
    await symlink(
      join(home, "missing"),
      join(parked, "broken"),
      process.platform === "win32" ? "junction" : undefined,
    );
    const { messages, output } = captureOutput();
    const context = createCommandContext({
      homeDir: home,
      output,
    });

    await createProgram(context).parseAsync([
      "node",
      "skillpark",
      "list",
      "claude",
    ]);

    expect(messages.join("\n")).toContain("Active (2)");
    expect(messages.join("\n")).toContain("Parked (3)");
    expect(messages.join("\n")).toContain("Conflicts (1)");
    expect(messages.join("\n").match(/Name conflict/g)).toHaveLength(2);
    expect(messages.join("\n")).toContain(
      "Link target is missing · Missing SKILL.md",
    );
  });

  it("renders sorted entries and health for both sides of a conflict", async () => {
    const home = await makeTempHome();
    const active = join(home, ".claude", "skills");
    const parked = join(home, ".skillpark", "skills", "claude");
    await createSkill(active, "z-active");
    await createSkill(active, "conflict");
    await createSkill(active, "a-active");
    await createSkill(parked, "z-parked");
    await createSkill(parked, "conflict");
    await mkdir(join(parked, "invalid"), { recursive: true });
    await writeFile(
      join(parked, "invalid", "SKILL.md"),
      "---\nname: invalid\n---\n",
      "utf8",
    );
    await symlink(
      join(home, "missing-target"),
      join(parked, "broken"),
      process.platform === "win32" ? "junction" : undefined,
    );
    const { messages, output } = captureOutput();

    await createProgram(
      createCommandContext({ homeDir: home, output }),
    ).parseAsync(["node", "skillpark", "list", "claude"]);

    const rows = (messages[0] as string)
      .split("\n")
      .filter((line) => /^│ (?:Active|Parked) /u.test(line))
      .map((line) => {
        const cells = line.split("│").map((cell) => cell.trim());
        return [cells[1], cells[2], cells[5]];
      });
    expect(rows).toEqual([
      ["Active", "a-active", "Ready"],
      ["Active", "conflict", "Name conflict"],
      ["Active", "z-active", "Ready"],
      ["Parked", "broken", "Link target is missing · Missing SKILL.md"],
      ["Parked", "conflict", "Name conflict"],
      ["Parked", "invalid", "Missing description"],
      ["Parked", "z-parked", "Ready"],
    ]);
  });

  it.each([
    { argument: "claude", heading: "Claude Code" },
    { argument: "claude-code", heading: "Claude Code" },
    { argument: "codex", heading: "Codex" },
  ])("accepts the $argument agent name", async ({ argument, heading }) => {
    const home = await makeTempHome();
    const { messages, output } = captureOutput();

    await createProgram(
      createCommandContext({ homeDir: home, output }),
    ).parseAsync(["node", "skillpark", "list", argument]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.split("\n")[0]).toBe(heading);
    expect(messages[0]).toContain("Active (0)");
    expect(messages[0]).toContain("Parked (0)");
  });

  it("uses convention-based paths for a custom agent", async () => {
    const home = await makeTempHome();
    const { messages, output } = captureOutput();

    await createProgram(
      createCommandContext({ homeDir: home, output }),
    ).parseAsync(["node", "skillpark", "list", "sodagent"]);

    expect(messages[0]?.split("\n")[0]).toBe("sodagent");
    expect(messages[0]).toContain("Active (0)");
    expect(messages[0]).toContain("Parked (0)");
  });

  it("rejects an unsafe custom agent id", async () => {
    const home = await makeTempHome();
    const { output } = captureOutput();

    await expect(
      createProgram(createCommandContext({ homeDir: home, output })).parseAsync(
        ["node", "skillpark", "list", "../other"],
      ),
    ).rejects.toThrow("Invalid agent id");
  });

  it("prompts for an agent when omitted and writes only its status", async () => {
    const home = await makeTempHome();
    const { messages, output } = captureOutput();
    let journalCalls = 0;
    const context = createCommandContext({
      homeDir: home,
      output,
      prompts: {
        async selectOne(message, choices) {
          expect(message).toBe("Select an agent whose skills you want to list");
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
      journals: {
        async create() {
          journalCalls += 1;
          throw new Error("list must not create a journal");
        },
        async save() {
          journalCalls += 1;
        },
        async remove() {
          journalCalls += 1;
        },
        async list() {
          journalCalls += 1;
          return [];
        },
      },
    });

    await createProgram(context).parseAsync(["node", "skillpark", "list"]);

    expect(messages).toEqual([
      ["Codex", "Active (0) · Parked (0)", "No skills found."].join("\n"),
    ]);
    expect(journalCalls).toBe(0);
    await expect(access(join(home, ".claude"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(home, ".codex"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(home, ".skillpark"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("ignores scanner-invisible regular files without changing them", async () => {
    const home = await makeTempHome();
    const active = join(home, ".claude", "skills");
    const parked = join(home, ".skillpark", "skills", "claude");
    await mkdir(active, { recursive: true });
    await mkdir(parked, { recursive: true });
    await writeFile(join(active, "occupied"), "active occupant", "utf8");
    await writeFile(join(parked, "occupied"), "parked occupant", "utf8");
    const { messages, output } = captureOutput();

    await createProgram(
      createCommandContext({ homeDir: home, output }),
    ).parseAsync(["node", "skillpark", "list", "claude"]);

    expect(messages).toEqual([
      ["Claude Code", "Active (0) · Parked (0)", "No skills found."].join("\n"),
    ]);
    await expect(readFile(join(active, "occupied"), "utf8")).resolves.toBe(
      "active occupant",
    );
    await expect(readFile(join(parked, "occupied"), "utf8")).resolves.toBe(
      "parked occupant",
    );
  });
});
