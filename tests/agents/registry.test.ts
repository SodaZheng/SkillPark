import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectAgents,
  getAgentSkillRoot,
  getAgentPaths,
  listAgentDefinitions,
  parseAgentId,
} from "../../src/agents/registry.js";

const homes: string[] = [];
afterEach(async () =>
  Promise.all(
    homes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("agent registry", () => {
  it("accepts every skills-compatible id and the claude-code alias", () => {
    expect(parseAgentId("claude-code")).toBe("claude");
    expect(parseAgentId("codex")).toBe("codex");
    expect(parseAgentId("cursor")).toBe("cursor");
    expect(parseAgentId("GEMINI-CLI")).toBe("gemini-cli");
    expect(listAgentDefinitions()).toHaveLength(73);
    expect(() => parseAgentId("other")).toThrow("Unsupported agent: other");
  });

  it("resolves active and parked paths from the injected home", () => {
    expect(getAgentPaths("claude", "/home/tester")).toEqual({
      active: join("/home/tester", ".claude", "skills"),
      parked: join("/home/tester", ".skillpark", "skills", "claude"),
    });
    expect(getAgentSkillRoot("codex", "current", "/home/tester", "/repo")).toBe(
      join("/repo", ".agents", "skills"),
    );
    expect(
      getAgentSkillRoot("opencode", "global", "/home/tester", "/repo"),
    ).toBe(join("/home/tester", ".config", "opencode", "skills"));
    expect(() =>
      getAgentSkillRoot("eve", "global", "/home/tester", "/repo"),
    ).toThrow("does not support global skill installation");
  });

  it("marks an agent detected when its config root exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "skillpark-agent-"));
    homes.push(home);
    await mkdir(join(home, ".codex"));
    const detected = await detectAgents(home);
    expect(detected).toHaveLength(73);
    expect(detected.find((agent) => agent.id === "claude")).toEqual(
      expect.objectContaining({ detected: false }),
    );
    expect(detected.find((agent) => agent.id === "codex")).toEqual(
      expect.objectContaining({ detected: true }),
    );
  });
});
