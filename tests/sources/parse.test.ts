import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../../src/domain/errors.js";
import { validateEntryName } from "../../src/sources/entry-name.js";
import { parseSource } from "../../src/sources/parse.js";

describe("parseSource", () => {
  it("normalizes GitHub owner/repo shorthand to one .git suffix", () => {
    expect(parseSource("vercel-labs/agent-skills", "/work")).toEqual({
      kind: "git",
      url: "https://github.com/vercel-labs/agent-skills.git",
    });
    expect(parseSource("vercel-labs/agent-skills.git", "/work")).toEqual({
      kind: "git",
      url: "https://github.com/vercel-labs/agent-skills.git",
    });
  });

  it.each([
    "https://github.com/vercel-labs/agent-skills.git",
    "http://example.test/owner/repo.git",
    "ssh://git@example.test/owner/repo.git",
    "git@example.test:owner/repo.git",
  ])("accepts the Git URL form %s without rewriting it", (value) => {
    expect(parseSource(value, "/work")).toEqual({ kind: "git", url: value });
  });

  it("resolves explicit relative and absolute local paths using Node path semantics", () => {
    expect(parseSource("./skills", "/work/project")).toEqual({
      kind: "local",
      path: resolve("/work/project", "skills"),
    });
    expect(parseSource("../skills", "/work/project")).toEqual({
      kind: "local",
      path: resolve("/work/project", "../skills"),
    });

    const absolute = resolve("/tmp", "source-skills");
    expect(isAbsolute(absolute)).toBe(true);
    expect(parseSource(absolute, "/work/project")).toEqual({
      kind: "local",
      path: absolute,
    });
  });

  it.each([
    "",
    "plain-name",
    "owner/repo/extra",
    "ftp://example.test/repo",
    "~/skills",
  ])("rejects unsupported or shell-expanded source syntax %j", (value) => {
    expect(() => parseSource(value, "/work")).toThrow(UsageError);
    expect(() => parseSource(value, "/work")).toThrow(
      `Unsupported source: ${value}`,
    );
  });

  it.each(["owner/..", "owner/.git", "owner/CON.git"])(
    "rejects shorthand with an unsafe repository name %j",
    (value) => {
      expect(() => parseSource(value, "/work")).toThrow(UsageError);
    },
  );
});

describe("validateEntryName", () => {
  it.each([
    "",
    ".",
    "..",
    ".hidden",
    "with/slash",
    "with\\backslash",
    "with\0nul",
    "bad:name",
    "bad<name",
    'bad"name',
    "bad|name",
    "bad?name",
    "bad*name",
    "CON",
    "nul.txt",
    "COM1",
    "com9.md",
    "LPT1",
    "lpt9.skill",
    "trailing.",
    "trailing ",
    " leading",
  ])("rejects the unsafe cross-platform component %j", (value) => {
    expect(() => validateEntryName(value)).toThrow(UsageError);
  });

  it.each(["skill", "skill.git", "COM10", "lpt10.md", "技能"])(
    "accepts the safe visible component %j",
    (value) => {
      expect(validateEntryName(value)).toBe(value);
    },
  );
});
