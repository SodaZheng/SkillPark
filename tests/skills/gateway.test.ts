import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { bundledGatewaySkillRoot } from "../../src/skills/gateway.js";
import { readSkillMetadata } from "../../src/skills/metadata.js";

describe("bundled SkillPark gateway", () => {
  it("advertises an unconditional bounded search for every request", async () => {
    const metadata = await readSkillMetadata(bundledGatewaySkillRoot());

    expect(metadata.valid).toBe(true);
    expect(metadata.description).toContain("Invoke before every user request");
    expect(metadata.description).toContain("bounded local search");
    expect(metadata.description).toContain("host-model keyword expansion");
    expect(metadata.description).toContain(
      "instead of listing every parked skill",
    );
    expect(metadata.description).not.toContain("skillpark list");
    expect(metadata.description).not.toContain("skillpark get");
  });

  it("defines model-expanded search, trigger validation, and mutation boundaries", async () => {
    const instructions = await readFile(
      join(bundledGatewaySkillRoot(), "SKILL.md"),
      "utf8",
    );

    expect(instructions).toContain("## Search before every request");
    expect(instructions).toContain("Before responding to every user request");
    expect(instructions).toContain(
      'skillpark search <agent> "<capability keywords>"',
    );
    expect(instructions).toContain("never exceed two search");
    expect(instructions).toContain("Count hook-provided results as one pass");
    expect(instructions).toContain("Never use `skillpark list` for automatic");
    expect(instructions).toMatch(
      /full parked\s+catalog must not\s+enter model context/u,
    );
    expect(instructions).toContain("normal skill-trigger rules");
    expect(instructions).toContain("retrieval relevance only");
    expect(instructions).toContain("Chinese-English language boundary");
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
      "bounded parked-skill candidate set",
    );
    expect(configuration.interface?.default_prompt).toBe(
      "Use $skillpark to search parked skills with concise bilingual capability keywords and load only true trigger matches.",
    );
  });
});
