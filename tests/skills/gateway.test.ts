import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { bundledGatewaySkillRoot } from "../../src/skills/gateway.js";
import { readSkillMetadata } from "../../src/skills/metadata.js";

describe("bundled SkillPark gateway", () => {
  it("advertises concrete uncertainty and specialist-skill triggers", async () => {
    const metadata = await readSkillMetadata(bundledGatewaySkillRoot());

    expect(metadata.valid).toBe(true);
    expect(metadata.description).toContain(
      "does not know how to perform a request",
    );
    expect(metadata.description).toContain("unsure of the best workflow");
    expect(metadata.description).toContain(
      "suspects a skill could do the work",
    );
    expect(metadata.description).toContain("claim a capability is unavailable");
    expect(metadata.description).toContain("materially new capability");
    expect(metadata.description).toContain("bounded candidate set");
    expect(metadata.description).not.toContain("skillpark list");
    expect(metadata.description).not.toContain("skillpark get");
  });

  it("defines model-expanded search, trigger validation, and mutation boundaries", async () => {
    const instructions = await readFile(
      join(bundledGatewaySkillRoot(), "SKILL.md"),
      "utf8",
    );

    expect(instructions).toContain("## Search at routing checkpoints");
    expect(instructions).toContain("You do not know how to do the task");
    expect(instructions).toContain(
      "A skill might perform the task more reliably",
    );
    expect(instructions).toContain("claim the capability or tool");
    expect(instructions).toContain("Use a low threshold");
    expect(instructions).toContain(
      "Reading files, planning, delegation, or a tool failure",
    );
    expect(instructions).toContain(
      'skillpark search <agent> "<capability keywords>"',
    );
    expect(instructions).toMatch(
      /Never exceed two search passes for the same\s+capability/u,
    );
    expect(instructions).not.toContain("hook-provided");
    expect(instructions).toContain(
      "A materially new capability receives its own bounded search budget",
    );
    expect(instructions).toContain("Never use `skillpark list` for automatic");
    expect(instructions).toMatch(
      /full parked\s+catalog must not\s+enter model context/u,
    );
    expect(instructions).toContain("normal skill-trigger rules");
    expect(instructions).toContain("retrieval relevance only");
    expect(instructions).toContain("Chinese-English language boundary");
    expect(instructions).toContain("PDF OCR extract convert PDF 提取 转换");
    expect(instructions).toContain("For each selected hit");
    expect(instructions).toContain(
      "Never execute `skillpark store`, `skillpark restore`, `skillpark add`, or",
    );
    expect(instructions).not.toContain("skillpark route");
  });

  it("explicitly enables implicit invocation in Codex metadata", async () => {
    const configuration = parse(
      await readFile(
        join(bundledGatewaySkillRoot(), "agents", "openai.yaml"),
        "utf8",
      ),
    ) as {
      interface?: {
        default_prompt?: string;
        display_name?: string;
        short_description?: string;
      };
      policy?: { allow_implicit_invocation?: boolean };
    };

    expect(configuration.policy?.allow_implicit_invocation).toBe(true);
    expect(configuration.interface?.display_name).toBe("SkillPark");
    expect(configuration.interface?.short_description).toContain(
      "Discover parked specialist skills",
    );
    expect(configuration.interface?.default_prompt).toBe(
      "Use $skillpark when you are unsure how to proceed or suspect a specialist skill could handle the task better.",
    );
  });
});
