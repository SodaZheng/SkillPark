import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CANCELLED } from "../../src/tui/ports.js";
import {
  reduceSelectionKey,
  selectMany,
} from "../../src/tui/searchable-multiselect.js";

describe("selection keyboard state", () => {
  it("enters search with slash", () => {
    const initial = { searchMode: false, selected: new Set<string>() };

    expect(reduceSelectionKey(initial, "/", ["pdf", "docs"])).toMatchObject({
      searchMode: true,
    });
  });

  it("selects and deselects all visible items with a", () => {
    const initial = { searchMode: false, selected: new Set<string>() };

    const selected = reduceSelectionKey(initial, "a", ["pdf", "docs"]);
    expect([...selected.selected]).toEqual(["pdf", "docs"]);

    const deselected = reduceSelectionKey(selected, "a", ["pdf", "docs"]);
    expect([...deselected.selected]).toEqual([]);
  });

  it("does not toggle selection with a while searching", () => {
    const initial = { searchMode: true, selected: new Set(["pdf"]) };

    const next = reduceSelectionKey(initial, "a", ["pdf", "docs"]);

    expect(next).toBe(initial);
    expect([...next.selected]).toEqual(["pdf"]);
  });

  it("does not select disabled visible choices", () => {
    const initial = { searchMode: false, selected: new Set<string>() };

    const selected = reduceSelectionKey(initial, "a", [
      { value: "pdf", disabled: true },
      { value: "docs" },
    ]);

    expect([...selected.selected]).toEqual(["docs"]);
  });
});

describe("searchable multi-select prompt", () => {
  it("moves with Down and selects the focused choice with Space", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const result = selectMany(
      "Select skills",
      [
        { value: "pdf", label: "pdf" },
        { value: "docs", label: "docs" },
      ],
      { input, noColor: true, output },
    );

    input.write("\u001b[B");
    input.write(" ");
    input.write("\r");

    await expect(result).resolves.toEqual(["docs"]);
  });

  it("selects all enabled choices with a", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    const result = selectMany(
      "Select skills",
      [
        { value: "pdf", label: "pdf", disabled: true },
        { value: "docs", label: "docs" },
      ],
      { input, noColor: true, output },
    );

    input.write("a");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rendered).not.toContain("Search / a");
    input.write("\r");

    await expect(result).resolves.toEqual(["docs"]);
  });

  it("treats a as search text after slash instead of selecting all", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const result = selectMany(
      "Select skills",
      [
        { value: "alpha", label: "alpha" },
        { value: "beta", label: "beta" },
      ],
      { input, noColor: true, output },
    );

    input.write("/a");
    input.write(" ");
    input.write("\r");

    await expect(result).resolves.toEqual(["alpha"]);
  });

  it.each([
    ["Escape", "\u001b"],
    ["Ctrl+C", "\u0003"],
  ])("maps %s to CANCELLED", async (_name, key) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const result = selectMany(
      "Select skills",
      [{ value: "pdf", label: "pdf" }],
      { input, noColor: true, output },
    );

    input.write(key);

    await expect(result).resolves.toBe(CANCELLED);
  });
});
