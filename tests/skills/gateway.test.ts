import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { bundledGatewaySkillRoot } from "../../src/skills/gateway.js";
import { readSkillMetadata } from "../../src/skills/metadata.js";

describe("bundled SkillPark gateway", () => {
  it("advertises an unconditional local routing pass for every request", async () => {
    const metadata = await readSkillMetadata(bundledGatewaySkillRoot());

    expect(metadata.valid).toBe(true);
    expect(metadata.description).toContain("Invoke before every user request");
    expect(metadata.description).toContain(
      "small locally routed candidate set",
    );
    expect(metadata.description).toContain(
      "instead of listing every parked skill",
    );
    expect(metadata.description).not.toContain("skillpark list");
    expect(metadata.description).not.toContain("skillpark get");
  });

  it("defines bounded local routing and mutation boundaries", async () => {
    const instructions = await readFile(
      join(bundledGatewaySkillRoot(), "SKILL.md"),
      "utf8",
    );

    expect(instructions).toContain("## Route every request locally");
    expect(instructions).toContain("Before responding to every user request");
    expect(instructions).toContain(
      'skillpark route <agent> "<current user request>"',
    );
    expect(instructions).toMatch(/Do not run a\s+second\s+routing/u);
    expect(instructions).toContain("Never use `skillpark list` for automatic");
    expect(instructions).toMatch(
      /full\s+parked catalog must not enter model context/u,
    );
    expect(instructions).toContain(
      "Apply the host agent's normal skill-trigger",
    );
    expect(instructions).toContain("Scores are recall hints");
    expect(instructions).toContain("For each selected candidate");
    expect(instructions).toContain(
      "Never execute `skillpark store`, `skillpark restore`, `skillpark add`, or",
    );
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
      "small parked-skill candidate set",
    );
    expect(configuration.interface?.default_prompt).toBe(
      "Use $skillpark to consume the local router result for this request and load only true matches.",
    );
  });
});
