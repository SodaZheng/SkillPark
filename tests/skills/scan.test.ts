import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSkillEntries } from "../../src/skills/scan.js";
import { createSkill, makeTempHome } from "../support/fs.js";

describe("scanSkillEntries", () => {
  it.each([
    ["a missing name", "---\ndescription: Target tools\n---\n", "Missing name"],
    [
      "invalid frontmatter",
      "---\nname: [invalid\n---\n",
      "Unreadable SKILL.md",
    ],
  ])(
    "uses the link entry name as metadata fallback for %s",
    async (_case, markdown, warning) => {
      const home = await makeTempHome();
      const active = join(home, ".codex", "skills");
      const target = join(home, "actual");
      await mkdir(active, { recursive: true });
      await mkdir(target);
      await writeFile(join(target, "SKILL.md"), markdown);
      await symlink(
        target,
        join(active, "alias"),
        process.platform === "win32" ? "junction" : undefined,
      );

      const [entry] = await scanSkillEntries(active, "active");

      expect(entry?.metadata).toMatchObject({ name: "alias", valid: false });
      expect(entry?.metadata.warnings).toContain(warning);
    },
  );

  it("scans valid direct children and excludes hidden containers", async () => {
    const home = await makeTempHome();
    const active = join(home, ".claude", "skills");
    await createSkill(active, "pdf", {
      name: "pdf",
      description: "PDF tools",
    });
    await createSkill(join(active, ".system"), "internal", {
      name: "internal",
      description: "Hidden",
    });
    expect(
      (await scanSkillEntries(active, "active")).map(
        (entry) => entry.entryName,
      ),
    ).toEqual(["pdf"]);
  });

  it("lists a broken parked link with a warning", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "codex");
    await mkdir(parked, { recursive: true });
    await symlink(
      join(home, "missing-target"),
      join(parked, "broken"),
      process.platform === "win32" ? "junction" : undefined,
    );
    const [entry] = await scanSkillEntries(parked, "parked");
    expect(entry).toMatchObject({
      entryName: "broken",
      kind: "link",
      broken: true,
    });
    expect(entry?.metadata.warnings).toContain("Link target is missing");
  });

  it("lists malformed active metadata with a warning", async () => {
    const home = await makeTempHome();
    const active = join(home, ".codex", "skills");
    const skill = join(active, "malformed");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: [invalid\n---\n");

    const [entry] = await scanSkillEntries(active, "active");

    expect(entry).toMatchObject({ entryName: "malformed" });
    expect(entry?.metadata.warnings).toContain("Unreadable SKILL.md");
  });

  it("excludes missing SKILL.md from active mode but keeps it parked", async () => {
    const home = await makeTempHome();
    const active = join(home, ".codex", "skills");
    const parked = join(home, ".skillpark", "skills", "codex");
    await mkdir(join(active, "missing"), { recursive: true });
    await mkdir(join(parked, "missing"), { recursive: true });

    expect(await scanSkillEntries(active, "active")).toEqual([]);
    expect(await scanSkillEntries(parked, "parked")).toEqual([
      expect.objectContaining({
        entryName: "missing",
        kind: "directory",
        broken: false,
        metadata: expect.objectContaining({
          name: "missing",
          valid: false,
          warnings: ["Missing SKILL.md"],
        }),
      }),
    ]);
  });

  it("excludes broken links from active mode", async () => {
    const home = await makeTempHome();
    const active = join(home, ".codex", "skills");
    await mkdir(active, { recursive: true });
    await symlink(
      join(home, "missing-target"),
      join(active, "broken"),
      process.platform === "win32" ? "junction" : undefined,
    );

    expect(await scanSkillEntries(active, "active")).toEqual([]);
  });

  it("reads valid link target metadata while preserving the entry name", async () => {
    const home = await makeTempHome();
    const active = join(home, ".codex", "skills");
    const target = await createSkill(home, "actual", {
      name: "canonical",
      description: "Canonical tools",
    });
    await mkdir(active, { recursive: true });
    await symlink(
      target,
      join(active, "alias"),
      process.platform === "win32" ? "junction" : undefined,
    );

    const [entry] = await scanSkillEntries(active, "active");

    expect(entry).toMatchObject({
      entryName: "alias",
      path: join(active, "alias"),
      kind: "link",
      broken: false,
      metadata: {
        name: "canonical",
        description: "Canonical tools",
        valid: true,
        warnings: [],
      },
    });
  });

  it("ignores unrelated files in active mode", async () => {
    const home = await makeTempHome();
    const active = join(home, ".codex", "skills");
    await mkdir(active, { recursive: true });
    await writeFile(join(active, "notes.txt"), "not a skill");
    expect(await scanSkillEntries(active, "active")).toEqual([]);
  });

  it("ignores unrelated files in parked mode", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "codex");
    await mkdir(parked, { recursive: true });
    await writeFile(join(parked, "archive.tar"), "not a skill entry");

    expect(await scanSkillEntries(parked, "parked")).toEqual([]);
  });
});
