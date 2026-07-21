import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSourceSkills } from "../../src/sources/discover.js";
import { createSkill, makeTempHome } from "../support/fs.js";

describe("discoverSourceSkills", () => {
  it("rejects a symbolic-link source root instead of scanning through it", async () => {
    const home = await makeTempHome();
    const external = await makeTempHome();
    await createSkill(join(external, "skills"), "escaped");
    const root = join(home, "linked-root");
    await symlink(external, root);

    await expect(discoverSourceSkills(root)).rejects.toThrow(
      "Unsafe source root: symbolic links are not allowed",
    );
  });

  it.each([
    { label: "intermediate", link: ".claude", targetSuffix: [] },
    {
      label: "final container",
      link: join(".claude", "skills"),
      targetSuffix: ["skills"],
    },
  ])(
    "rejects a $label symbolic link in an approved container path",
    async ({ link, targetSuffix }) => {
      const root = await makeTempHome();
      const external = await makeTempHome();
      await createSkill(join(external, "skills"), "escaped");
      const linkPath = join(root, link);
      await mkdir(join(linkPath, ".."), { recursive: true });
      await symlink(join(external, ...targetSuffix), linkPath);

      await expect(discoverSourceSkills(root)).rejects.toThrow(
        "Unsafe source container path: symbolic links are not allowed",
      );
    },
  );

  it("does not parse SKILL.md through a symbolic link", async () => {
    const root = await makeTempHome();
    const external = await createSkill(await makeTempHome(), "external");
    const candidate = join(root, "skills", "linked-metadata");
    await mkdir(candidate, { recursive: true });
    await symlink(join(external, "SKILL.md"), join(candidate, "SKILL.md"));

    expect(await discoverSourceSkills(root)).toEqual([]);
  });

  it("rejects a valid non-hidden skill with an unsafe entry name", async () => {
    const root = await makeTempHome();
    await createSkill(join(root, "skills"), " leading-space", {
      name: "valid-metadata",
      description: "Unsafe destination component",
    });

    await expect(discoverSourceSkills(root)).rejects.toThrow(
      'Unsafe skill entry name: " leading-space"',
    );
  });

  it("rejects an unsafe caller-provided root entry name", async () => {
    const root = await createSkill(await makeTempHome(), "root-skill");

    await expect(discoverSourceSkills(root, "..")).rejects.toThrow(
      'Unsafe skill entry name: ".."',
    );
  });

  it("searches only the root and direct children of approved containers", async () => {
    const root = await makeTempHome();
    await createSkill(join(root, "skills"), "pdf");
    await createSkill(join(root, "examples"), "fixture");
    await createSkill(join(root, "skills", "nested"), "too-deep");
    await createSkill(join(root, ".claude", "skills"), "claude-skill");
    await createSkill(join(root, ".agents", "skills"), "agent-skill");
    await createSkill(join(root, ".codex", "skills"), "codex-skill");

    expect(
      (await discoverSourceSkills(root)).map((entry) => entry.metadata.name),
    ).toEqual(["pdf", "claude-skill", "agent-skill", "codex-skill"]);
  });

  it("uses the original source directory name when the source root is a skill", async () => {
    const home = await makeTempHome();
    const root = await createSkill(home, "random-staging-name", {
      name: "root-metadata-name",
      description: "Root skill",
    });

    expect(await discoverSourceSkills(root, "original-source-name")).toEqual([
      expect.objectContaining({
        entryName: "original-source-name",
        path: root,
        kind: "directory",
        broken: false,
      }),
    ]);
  });

  it("returns stable container and direct-child order", async () => {
    const root = await makeTempHome();
    await createSkill(join(root, "skills"), "zulu");
    await createSkill(join(root, "skills"), "alpha");
    await createSkill(join(root, ".claude", "skills"), "bravo");
    await createSkill(join(root, ".agents", "skills"), "charlie");
    await createSkill(join(root, ".codex", "skills"), "delta");

    expect(
      (await discoverSourceSkills(root)).map((entry) => entry.entryName),
    ).toEqual(["alpha", "zulu", "bravo", "charlie", "delta"]);
  });

  it("ignores hidden, non-directory, symlink, broken-link, and invalid candidates", async () => {
    const root = await makeTempHome();
    const skills = join(root, "skills");
    await mkdir(skills, { recursive: true });
    await createSkill(skills, ".hidden");
    await writeFile(join(skills, "regular-file"), "not a skill");
    await mkdir(join(skills, "missing-metadata"));
    await mkdir(join(skills, "invalid-metadata"));
    await writeFile(join(skills, "invalid-metadata", "SKILL.md"), "# no yaml");
    const external = await createSkill(await makeTempHome(), "external");
    await symlink(external, join(skills, "linked-skill"));
    await symlink(join(root, "missing-target"), join(skills, "broken-link"));
    await createSkill(skills, "valid");

    expect(
      (await discoverSourceSkills(root)).map((entry) => entry.entryName),
    ).toEqual(["valid"]);
  });

  it("rejects duplicate metadata names across supported containers", async () => {
    const root = await makeTempHome();
    await createSkill(join(root, "skills"), "one", {
      name: "shared",
      description: "First",
    });
    await createSkill(join(root, ".agents", "skills"), "two", {
      name: "shared",
      description: "Second",
    });

    await expect(discoverSourceSkills(root)).rejects.toThrow(
      "Duplicate skill name: shared",
    );
  });

  it("rejects duplicate entry directory names across supported containers", async () => {
    const root = await makeTempHome();
    await createSkill(join(root, "skills"), "same", {
      name: "first",
      description: "First",
    });
    await createSkill(join(root, ".codex", "skills"), "same", {
      name: "second",
      description: "Second",
    });

    await expect(discoverSourceSkills(root)).rejects.toThrow(
      "Duplicate skill directory name: same",
    );
  });
});
