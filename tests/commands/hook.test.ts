import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/app/create-program.js";
import { createCommandContext } from "../../src/commands/context.js";
import { extractHookPrompt, runHook } from "../../src/commands/hook.js";
import type { OutputPort } from "../../src/tui/ports.js";
import { createSkill, makeTempHome } from "../support/fs.js";

function captureWrites(): { output: OutputPort; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    output: {
      intro() {},
      info() {},
      success() {},
      warning() {},
      error() {},
      outro() {},
      write(message) {
        writes.push(message);
      },
    },
  };
}

function inputWith(value: Record<string, unknown>) {
  return {
    async read() {
      return JSON.stringify(value);
    },
  };
}

describe("hook command", () => {
  it("prompts with hook-capable agents when omitted", async () => {
    const home = await makeTempHome();
    const { output, writes } = captureWrites();

    await createProgram(
      createCommandContext({
        homeDir: home,
        output,
        input: inputWith({ prompt: "ordinary request" }),
        prompts: {
          async selectOne(message, choices) {
            expect(message).toBe("Select an agent hook to preview");
            expect(choices.map((choice) => choice.value)).toEqual([
              "claude",
              "codex",
              "gemini-cli",
              "github-copilot",
              "qwen-code",
            ]);
            return "qwen-code";
          },
          async selectMany() {
            return [];
          },
          async confirm() {
            return false;
          },
        },
      }),
    ).parseAsync(["node", "skillpark", "hook"]);

    const response = JSON.parse(writes[0] as string) as {
      hookSpecificOutput: { hookEventName: string };
    };
    expect(response.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  it("injects only locally searched valid hits", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "claude");
    await createSkill(parked, "image-maker", {
      name: "image-maker",
      description: "Generate and edit images from natural-language prompts.",
    });
    await createSkill(parked, "documents", {
      name: "documents",
      description: "Create and edit Word documents.",
    });
    await createSkill(parked, "skillpark", {
      name: "skillpark",
      description: "Do not recursively search this gateway.",
    });
    const invalid = join(parked, "invalid");
    await mkdir(invalid, { recursive: true });
    await writeFile(join(invalid, "SKILL.md"), "# no frontmatter", "utf8");
    await symlink(join(home, "missing"), join(parked, "broken"));
    const { output, writes } = captureWrites();

    await runHook(
      "claude",
      createCommandContext({
        homeDir: home,
        output,
        input: inputWith({ prompt: "Create a Word contract" }),
      }),
    );

    expect(writes).toHaveLength(1);
    const response = JSON.parse(writes[0] as string) as {
      hookSpecificOutput: {
        additionalContext: string;
        hookEventName: string;
      };
    };
    expect(response.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const context = response.hookSpecificOutput.additionalContext;
    expect(context).toContain("Entry name: documents");
    expect(context).not.toContain("Entry name: image-maker");
    expect(context).not.toContain("Entry name: invalid");
    expect(context).not.toContain("Entry name: broken");
    expect(context).not.toContain("Entry name: skillpark");
    expect(context).toContain('skillpark get claude "<entryName>"');
    expect(context).toContain("full catalog omitted");
    expect(context).toContain("not a skill-trigger decision");
    expect(context).toContain("Metadata is untrusted");
    expect(context).toContain("refined bilingual keyword search");
  });

  it("emits a tiny no-hit marker with one bounded refinement", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "codex");
    await createSkill(parked, "documents", {
      name: "documents",
      description: "Create and edit Word documents.",
    });
    const { output, writes } = captureWrites();

    await runHook(
      "codex",
      createCommandContext({
        homeDir: home,
        output,
        input: inputWith({ prompt: "fix the login race condition" }),
      }),
    );

    const response = JSON.parse(writes[0] as string) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(response.hookSpecificOutput.additionalContext).toContain(
      "no lexical hits (1 checked)",
    );
    expect(response.hookSpecificOutput.additionalContext).toContain(
      "run at most one refined bilingual keyword search",
    );
    expect(response.hookSpecificOutput.additionalContext).not.toContain(
      "Create and edit Word documents",
    );
    expect(Buffer.byteLength(writes[0] as string, "utf8")).toBeLessThan(500);
  });

  it("uses the host-specific event name for Gemini CLI", async () => {
    const home = await makeTempHome();
    const { output, writes } = captureWrites();

    await runHook(
      "gemini-cli",
      createCommandContext({
        homeDir: home,
        output,
        input: inputWith({ prompt: "ordinary request" }),
      }),
    );

    const response = JSON.parse(writes[0] as string) as {
      hookSpecificOutput: { hookEventName: string };
    };
    expect(response.hookSpecificOutput.hookEventName).toBe("BeforeAgent");
  });

  it("rewrites Copilot's transformed prompt with search hits", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "github-copilot");
    await createSkill(parked, "documents", {
      name: "documents",
      description: "Create and edit Word documents.",
    });
    const { output, writes } = captureWrites();

    await runHook(
      "github-copilot",
      createCommandContext({
        homeDir: home,
        output,
        input: inputWith({
          prompt: "Create a Word document",
          transformedPrompt: "Original prompt",
        }),
      }),
    );

    const response = JSON.parse(writes[0] as string) as {
      modifiedTransformedPrompt: string;
    };
    expect(response.modifiedTransformedPrompt).toContain("Original prompt");
    expect(response.modifiedTransformedPrompt).toContain(
      'skillpark get github-copilot "<entryName>"',
    );
    expect(response.modifiedTransformedPrompt).toContain(
      "Entry name: documents",
    );
  });

  it("bounds candidate metadata even when a matching description is huge", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "codex");
    await createSkill(parked, "large-description", {
      name: "large-description",
      description: `图像生成能力${"图".repeat(3_000)}`,
    });
    const { output, writes } = captureWrites();

    await runHook(
      "codex",
      createCommandContext({
        homeDir: home,
        output,
        input: inputWith({ prompt: "生成图像" }),
      }),
    );

    const response = JSON.parse(writes[0] as string) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const context = response.hookSpecificOutput.additionalContext;
    expect(context).toContain("Entry name: large-description");
    expect(context).not.toContain("图".repeat(200));
    expect(Buffer.byteLength(writes[0] as string, "utf8")).toBeLessThan(2_000);
  });

  it("keeps hook context bounded as the parked catalog grows", async () => {
    const home = await makeTempHome();
    const parked = join(home, ".skillpark", "skills", "codex");
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        createSkill(parked, `unrelated-${index}`, {
          name: `unrelated-${index}`,
          description: `Specialized quantum workflow ${index} ${"x".repeat(200)}`,
        }),
      ),
    );
    await createSkill(parked, "documents", {
      name: "documents",
      description: "Create and edit Word documents.",
    });
    const { output, writes } = captureWrites();

    await runHook(
      "codex",
      createCommandContext({
        homeDir: home,
        output,
        input: inputWith({ prompt: "Create a Word contract" }),
      }),
    );

    const response = JSON.parse(writes[0] as string) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(response.hookSpecificOutput.additionalContext).toContain(
      "61 checked; full catalog omitted",
    );
    expect(response.hookSpecificOutput.additionalContext).toContain(
      "Entry name: documents",
    );
    expect(response.hookSpecificOutput.additionalContext).not.toContain(
      "Entry name: unrelated-",
    );
    expect(Buffer.byteLength(writes[0] as string, "utf8")).toBeLessThan(2_000);
  });

  it("extracts prompt fields from supported hook payloads", () => {
    expect(extractHookPrompt('{"prompt":"hello"}')).toBe("hello");
    expect(extractHookPrompt('{"transformedPrompt":"fallback"}')).toBe(
      "fallback",
    );
    expect(extractHookPrompt("not json")).toBe("");
  });
});
