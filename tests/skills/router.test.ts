import { describe, expect, it } from "vitest";
import { type RoutableSkill, routeSkills } from "../../src/skills/router.js";

const catalog: RoutableSkill[] = [
  {
    entryName: "documents",
    name: "Document Workshop",
    description: "Create and edit Microsoft Word DOCX documents.",
    aliases: ["写合同", "contract drafting"],
  },
  {
    entryName: "pdf",
    name: "PDF Toolkit",
    description: "Read, create, inspect, and verify PDF files.",
  },
  {
    entryName: "spreadsheets",
    name: "Spreadsheets",
    description: "Create and analyze Excel XLSX, CSV, and TSV workbooks.",
  },
  {
    entryName: "presentations",
    name: "Presentations",
    description: "Create and edit PowerPoint slide decks.",
  },
  {
    entryName: "imagegen",
    name: "Image Generator",
    description: "Generate and edit raster images, illustrations, and posters.",
  },
  {
    entryName: "last30days",
    name: "Last 30 Days",
    description: "Research recent discussions on Reddit and Hacker News.",
  },
];

describe("routeSkills", () => {
  it.each([
    ["create a contract draft", "documents"],
    ["把数据整理成 Excel 表格", "spreadsheets"],
    ["make a pitch deck", "presentations"],
    ["生成一张海报", "imagegen"],
    ["what has Reddit said recently?", "last30days"],
  ])("routes %s to %s", (prompt, expected) => {
    const result = routeSkills(prompt, catalog);

    expect(result.matches[0]?.entryName).toBe(expected);
    expect(result.matches.length).toBeLessThanOrEqual(3);
  });

  it("returns an exact explicit invocation with maximum confidence", () => {
    const result = routeSkills("$pdf rotate this file", catalog);

    expect(result.matches[0]).toMatchObject({
      entryName: "pdf",
      score: 1,
      confidence: "explicit",
    });
  });

  it("uses author-provided aliases without exposing the full catalog", () => {
    const result = routeSkills("帮我写合同", catalog);

    expect(result.catalogSize).toBe(catalog.length);
    expect(result.matches).toEqual([
      expect.objectContaining({
        entryName: "documents",
        reasons: expect.arrayContaining(["alias phrase: 写合同"]),
      }),
    ]);
  });

  it("tolerates a close spelling error in a skill name", () => {
    const result = routeSkills("make a spredsheet", catalog);

    expect(result.matches[0]?.entryName).toBe("spreadsheets");
    expect(result.matches[0]?.reasons[0]).toContain("typo");
  });

  it("returns no candidates for an unrelated request", () => {
    expect(
      routeSkills("fix the login race condition", catalog).matches,
    ).toEqual([]);
  });

  it("keeps only candidates close to the top score and respects the limit", () => {
    const overlapping = Array.from({ length: 12 }, (_, index) => ({
      entryName: `image-${index}`,
      name: `Image ${index}`,
      description: "Generate images and illustrations.",
    }));

    const result = routeSkills("generate an image", overlapping, { limit: 2 });

    expect(result.catalogSize).toBe(12);
    expect(result.matches).toHaveLength(2);
  });

  it("bounds routed metadata before it can enter model context", () => {
    const result = routeSkills("generate an image", [
      {
        entryName: "large-image-skill",
        name: `Image ${"n".repeat(1_000)}`,
        description: `Generate images ${"图".repeat(10_000)}`,
      },
    ]);

    expect(
      Buffer.byteLength(result.matches[0]?.name ?? "", "utf8"),
    ).toBeLessThanOrEqual(160);
    expect(
      Buffer.byteLength(result.matches[0]?.description ?? "", "utf8"),
    ).toBeLessThanOrEqual(1_024);
  });
});
