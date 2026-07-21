import { describe, expect, it } from "vitest";
import { renderTable } from "../../src/tui/table.js";

describe("renderTable", () => {
  it("aligns full-width text and wraps long cells", () => {
    expect(
      renderTable(
        [
          { header: "Name", maxWidth: 4 },
          { header: "Info", maxWidth: 6 },
        ],
        [["中文", "one two three"]],
      ),
    ).toBe(
      [
        "┌──────┬────────┐",
        "│ Name │ Info   │",
        "├──────┼────────┤",
        "│ 中文 │ one    │",
        "│      │ two    │",
        "│      │ three  │",
        "└──────┴────────┘",
      ].join("\n"),
    );
  });

  it("rejects rows that do not match the column count", () => {
    expect(() => renderTable([{ header: "Only" }], [["one", "two"]])).toThrow(
      "Table rows must match the column count",
    );
  });

  it("separates complete data rows without splitting wrapped cells", () => {
    const rendered = renderTable(
      [{ header: "Name" }, { header: "Info", maxWidth: 5 }],
      [
        ["first", "one two"],
        ["second", "three"],
      ],
    );

    expect(rendered).toContain(
      [
        "│ first  │ one   │",
        "│        │ two   │",
        "├────────┼───────┤",
        "│ second │ three │",
      ].join("\n"),
    );
  });
});
