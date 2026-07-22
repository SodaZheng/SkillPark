import { describe, expect, it } from "vitest";
import { type SearchableSkill, searchSkills } from "../../src/skills/search.js";

const catalog: SearchableSkill[] = [
  {
    entryName: "documents",
    name: "Document Workshop",
    description: "Create and edit Microsoft Word DOCX documents and contracts.",
    keywords: ["写合同", "contract drafting"],
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
];

describe("searchSkills", () => {
  it.each([
    ["Word DOCX contract", "documents"],
    ["Excel XLSX workbook", "spreadsheets"],
    ["PowerPoint slide deck", "presentations"],
    ["raster image poster", "imagegen"],
  ])("retrieves %s as %s", (query, expected) => {
    const result = searchSkills(query, catalog);

    expect(result.hits[0]?.entryName).toBe(expected);
    expect(result.hits.length).toBeLessThanOrEqual(5);
  });

  it("puts an explicit invocation first without treating scores as confidence", () => {
    const result = searchSkills("$pdf rotate this file", catalog);

    expect(result.hits[0]).toMatchObject({
      entryName: "pdf",
      exactInvocation: true,
      matchedFields: expect.arrayContaining(["name"]),
    });
  });

  it("uses author-provided search keywords", () => {
    const result = searchSkills("帮我写合同", catalog);

    expect(result.hits[0]).toMatchObject({
      entryName: "documents",
      matchedFields: expect.arrayContaining(["keywords"]),
    });
  });

  it("tolerates a close English spelling error", () => {
    const result = searchSkills("spredsheet workbook", catalog);

    expect(result.hits[0]?.entryName).toBe("spreadsheets");
  });

  it("uses English stems without truncating displayed query terms", () => {
    const result = searchSkills("medical records redaction", [
      {
        entryName: "medical-redactor",
        name: "Medical Redactor",
        description: "Redact medical record identifiers.",
      },
    ]);

    expect(result.hits[0]?.entryName).toBe("medical-redactor");
    expect(result.hits[0]?.matchedTerms).toEqual([
      "medical",
      "records",
      "redaction",
    ]);
    expect(result.hits[0]?.matchedTerms).not.toContain("medic");
    expect(result.hits[0]?.matchedTerms).not.toContain("redact");
  });

  it("preserves camel-case product names as whole search terms", () => {
    const productCatalog: SearchableSkill[] = [
      {
        entryName: "typescript-tools",
        name: "TypeScript Tools",
        description: "Analyze TypeScript and JavaScript projects.",
      },
    ];

    const result = searchSkills("TypeScript analysis", productCatalog);
    expect(result.hits[0]?.matchedTerms).toContain("TypeScript");
    expect(result.hits[0]?.matchedTerms).not.toContain("type");
    expect(result.hits[0]?.matchedTerms).not.toContain("script");
    expect(searchSkills("Java", productCatalog).hits).toEqual([]);
  });

  it("returns no hits when the query has no lexical intersection", () => {
    expect(searchSkills("fix login race condition", catalog).hits).toEqual([]);
  });

  it("lets a host model bridge Chinese requests to English metadata", () => {
    const medical: SearchableSkill[] = [
      {
        entryName: "medical-deidentifier",
        name: "Medical De-identifier",
        description:
          "De-identify medical records, redact PHI, and anonymize clinical notes.",
      },
    ];

    expect(searchSkills("把这些病历脱敏", medical).hits).toEqual([]);
    expect(
      searchSkills(
        "病历 脱敏 medical records de-identify PHI redaction",
        medical,
      ).hits[0]?.entryName,
    ).toBe("medical-deidentifier");
  });

  it("lets a host model bridge English requests to Chinese metadata", () => {
    const medical: SearchableSkill[] = [
      {
        entryName: "medical-redactor",
        name: "病历脱敏",
        description: "移除医疗病历中的身份信息，执行脱敏和去标识化。",
      },
    ];

    expect(searchSkills("de-identify clinical notes", medical).hits).toEqual(
      [],
    );
    expect(
      searchSkills(
        "de-identify clinical notes 医疗 病历 脱敏 去标识化",
        medical,
      ).hits[0]?.entryName,
    ).toBe("medical-redactor");
  });

  it("matches reordered Chinese wording with CJK bigrams", () => {
    const result = searchSkills("生成图像", [
      {
        entryName: "chinese-image",
        name: "图像工具",
        description: "提供图像生成能力和海报制作。",
      },
    ]);

    expect(result.hits[0]?.entryName).toBe("chinese-image");
  });

  it("does not retrieve a skill only through a negative description clause", () => {
    const result = searchSkills("SVG vector logo", [
      {
        entryName: "raster-images",
        name: "Raster Images",
        description: "Generate raster images. Do not use for SVG vector logos.",
      },
    ]);

    expect(result.hits).toEqual([]);
  });

  it("respects the requested bound", () => {
    const overlapping = Array.from({ length: 12 }, (_, index) => ({
      entryName: `image-${index}`,
      name: `Image ${index}`,
      description: "Generate raster images and illustrations.",
    }));

    expect(
      searchSkills("raster image illustration", overlapping, { limit: 2 }).hits,
    ).toHaveLength(2);
  });

  it("bounds metadata before it can enter model context", () => {
    const result = searchSkills("image", [
      {
        entryName: "large-image-skill",
        name: `Image ${"n".repeat(1_000)}`,
        description: `Generate images ${"图".repeat(10_000)}`,
      },
    ]);

    expect(
      Buffer.byteLength(result.hits[0]?.name ?? "", "utf8"),
    ).toBeLessThanOrEqual(160);
    expect(
      Buffer.byteLength(result.hits[0]?.description ?? "", "utf8"),
    ).toBeLessThanOrEqual(1_024);
  });

  it("excludes the gateway and invalid descriptions", () => {
    const result = searchSkills("skill gateway", [
      { entryName: "skillpark", name: "skillpark", description: "gateway" },
      { entryName: "empty", name: "empty", description: "" },
    ]);

    expect(result).toEqual({ catalogSize: 0, hits: [] });
  });
});
