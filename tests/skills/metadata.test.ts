import { describe, expect, it } from "vitest";
import { readSkillMetadata } from "../../src/skills/metadata.js";
import { createSkill, makeTempHome } from "../support/fs.js";

describe("readSkillMetadata", () => {
  it("reads valid YAML frontmatter", async () => {
    const home = await makeTempHome();
    const path = await createSkill(home, "pdf", {
      name: "pdf",
      description: "Work with PDFs",
    });
    await expect(readSkillMetadata(path)).resolves.toEqual({
      name: "pdf",
      description: "Work with PDFs",
      valid: true,
      warnings: [],
    });
  });

  it("reads and normalizes optional search keywords", async () => {
    const home = await makeTempHome();
    const path = await createSkill(home, "documents", {
      name: "documents",
      description: "Create Word documents",
      search: { keywords: [" 写合同 ", "contract drafting", "写合同"] },
    });

    await expect(readSkillMetadata(path)).resolves.toMatchObject({
      search: { keywords: ["写合同", "contract drafting"] },
      valid: true,
    });
  });
});
