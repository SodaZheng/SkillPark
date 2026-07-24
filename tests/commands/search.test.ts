import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/app/create-program.js";
import { createCommandContext } from "../../src/commands/context.js";
import { searchParkedSkills } from "../../src/commands/search.js";
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

describe("search command", () => {
  it("returns readable bounded hits without active skills", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "codex");
    await createSkill(parked, "documents", {
      name: "documents",
      description: "Create and edit Word DOCX documents and contracts.",
    });
    await createSkill(parked, "imagegen", {
      name: "imagegen",
      description: "Generate and edit raster images.",
    });
    await createSkill(join(home, ".codex", "skills"), "active-documents", {
      name: "active-documents",
      description: "Create Word documents.",
    });
    const { messages, output } = captureOutput();

    await createProgram(
      createCommandContext({ homeDir: home, output }),
    ).parseAsync([
      "node",
      "skillpark",
      "search",
      "codex",
      "Word",
      "DOCX",
      "contract",
    ]);

    const result = messages[0] ?? "";
    expect(result).toContain("2 checked; full catalog omitted");
    expect(result).toContain("Hit 1:");
    expect(result).toContain("Entry name: documents");
    expect(result).toContain("Matched fields:");
    expect(result).not.toContain("Entry name: imagegen");
    expect(result).not.toContain("Confidence:");
    expect(() => JSON.parse(result)).toThrow();
  });

  it("exposes the same bounded search behavior to programmatic callers", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "claude");
    await createSkill(parked, "slides", {
      name: "slides",
      description: "Create PowerPoint presentations and slide decks.",
      search: { keywords: ["演示文稿"] },
    });

    await expect(
      searchParkedSkills("claude", "演示文稿 PowerPoint slides", home),
    ).resolves.toMatchObject({
      catalogSize: 1,
      hits: [expect.objectContaining({ entryName: "slides" })],
    });
  });

  it("validates the hit limit", async () => {
    const home = await makeTempHome();

    await expect(
      createProgram(createCommandContext({ homeDir: home })).parseAsync([
        "node",
        "skillpark",
        "search",
        "codex",
        "request",
        "--limit",
        "0",
      ]),
    ).rejects.toEqual(
      new UsageError("Search limit must be an integer from 1 to 10"),
    );
  });

  it("does not register the removed route command", () => {
    const names = createProgram(
      createCommandContext({ homeDir: "/temporary-home-not-used" }),
    ).commands.map((command) => command.name());

    expect(names).toContain("search");
    expect(names).not.toContain("route");
  });
});
