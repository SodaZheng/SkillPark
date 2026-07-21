import { describe, expect, it } from "vitest";
import type { SkillEntry } from "../../src/domain/skills.js";
import { buildMovePlan, findNameConflicts } from "../../src/storage/plan.js";

const skill = (
  entryName: string,
  path: string,
  kind: SkillEntry["kind"] = "directory",
): SkillEntry => ({
  entryName,
  path,
  kind,
  broken: false,
  metadata: {
    name: entryName,
    description: `${entryName} skill`,
    valid: true,
    warnings: [],
  },
});

describe("storage plans", () => {
  it("maps store selections from active to parked without links", () => {
    const plan = buildMovePlan({
      action: "store",
      agent: "claude",
      selected: [skill("pdf", "/home/u/.claude/skills/pdf")],
      paths: {
        active: "/home/u/.claude/skills",
        parked: "/home/u/.skillpark/skills/claude",
      },
    });
    expect(plan.items[0]).toMatchObject({
      operation: "move",
      source: "/home/u/.claude/skills/pdf",
      destination: "/home/u/.skillpark/skills/claude/pdf",
    });
  });

  it("maps restore selections from parked to active with entry identity", () => {
    const plan = buildMovePlan({
      action: "restore",
      agent: "codex",
      selected: [skill("pdf", "/home/u/.skillpark/skills/codex/pdf", "link")],
      paths: {
        active: "/home/u/.codex/skills",
        parked: "/home/u/.skillpark/skills/codex",
      },
    });

    expect(plan.items[0]).toMatchObject({
      agent: "codex",
      entryName: "pdf",
      entryKind: "link",
      operation: "move",
      source: "/home/u/.skillpark/skills/codex/pdf",
      destination: "/home/u/.codex/skills/pdf",
    });
  });

  it("creates one item for each selected entry", () => {
    const plan = buildMovePlan({
      action: "store",
      agent: "claude",
      selected: [skill("pdf", "/active/pdf"), skill("yaml", "/active/yaml")],
      paths: { active: "/active", parked: "/parked" },
    });

    expect(plan.items).toHaveLength(2);
    expect(plan.items.map((item) => item.entryName)).toEqual(["pdf", "yaml"]);
  });

  it("assigns distinct IDs to the plan and every item", () => {
    const plan = buildMovePlan({
      action: "store",
      agent: "claude",
      selected: [skill("pdf", "/active/pdf"), skill("yaml", "/active/yaml")],
      paths: { active: "/active", parked: "/parked" },
    });
    const ids = [plan.id, ...plan.items.map((item) => item.id)];

    for (const id of ids) {
      expect(id).toEqual(expect.any(String));
      expect(id).not.toBe("");
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports names that exist in both states", () => {
    const conflicts = findNameConflicts(
      [skill("pdf", "/active/pdf")],
      [skill("pdf", "/parked/pdf")],
    );
    expect(conflicts.get("pdf")).toContain("/active/pdf");
    expect(conflicts.get("pdf")).toContain("/parked/pdf");
  });

  it("reports only matching names with their corresponding paths", () => {
    const conflicts = findNameConflicts(
      [
        skill("pdf", "/active/pdf"),
        skill("yaml", "/active/yaml"),
        skill("active-only", "/active/active-only"),
      ],
      [
        skill("pdf", "/parked/pdf"),
        skill("yaml", "/parked/yaml"),
        skill("parked-only", "/parked/parked-only"),
      ],
    );

    expect([...conflicts.keys()]).toEqual(["pdf", "yaml"]);
    expect(conflicts.get("pdf")).toBe("/active/pdf conflicts with /parked/pdf");
    expect(conflicts.get("yaml")).toBe(
      "/active/yaml conflicts with /parked/yaml",
    );
    expect(conflicts.has("active-only")).toBe(false);
    expect(conflicts.has("parked-only")).toBe(false);
  });
});
