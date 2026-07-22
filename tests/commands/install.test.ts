import {
  access,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/app/create-program.js";
import { createCommandContext } from "../../src/commands/context.js";
import { runInstall } from "../../src/commands/install.js";
import { UsageError } from "../../src/domain/errors.js";
import {
  CANCELLED,
  type OutputPort,
  type PromptPort,
} from "../../src/tui/ports.js";
import { createSkill, makeTempHome } from "../support/fs.js";

function captureOutput(): { messages: string[]; output: OutputPort } {
  const messages: string[] = [];
  const record = (message: string) => messages.push(message);
  return {
    messages,
    output: {
      intro: record,
      info: record,
      success: record,
      warning: record,
      error: record,
      outro: record,
      write: record,
    },
  };
}

function scopePrompts(
  scope: "global" | "current" | typeof CANCELLED,
  selections: { choices?: string[]; message?: string } = {},
): PromptPort {
  return {
    async selectOne(message, choices) {
      selections.message = message;
      selections.choices = choices.map((choice) => choice.value);
      return scope;
    },
    async selectMany() {
      return [];
    },
    async confirm() {
      return false;
    },
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function hookCommands(configuration: Record<string, unknown>): string[] {
  const hooks = configuration.hooks as Record<string, unknown>;
  const groups = hooks.UserPromptSubmit as {
    hooks: { command?: string }[];
  }[];
  return groups.flatMap((group) =>
    group.hooks.flatMap((handler) =>
      handler.command === undefined ? [] : [handler.command],
    ),
  );
}

function groupedHookCommands(
  configuration: Record<string, unknown>,
  event: string,
): string[] {
  const hooks = configuration.hooks as Record<string, unknown>;
  const groups = hooks[event] as { hooks: { command?: string }[] }[];
  return groups.flatMap((group) =>
    group.hooks.flatMap((handler) =>
      handler.command === undefined ? [] : [handler.command],
    ),
  );
}

const agents = [
  {
    agent: "claude",
    configRoot: ".claude",
    hookFile: "settings.json",
  },
  { agent: "codex", configRoot: ".codex", hookFile: "hooks.json" },
] as const;

describe("install command", () => {
  it("documents automatic installation and interactive scope selection in help", () => {
    const program = createProgram();
    const install = program.commands.find(
      (command) => command.name() === "install",
    );
    const help = install?.helpInformation() ?? "";

    expect(install?.description()).toBe("Install SkillPark for an agent");
    expect(help).toContain("--force");
    expect(help).toContain("[agent]");
    expect(help).not.toContain("[component]");
    expect(help).not.toContain("--current");
  });

  it("prompts for an agent when omitted from install", async () => {
    const home = await makeTempHome();
    const current = await makeTempHome();
    const prompts: string[] = [];
    const selected = "cursor";

    await createProgram(
      createCommandContext({
        cwd: current,
        homeDir: home,
        prompts: {
          async selectOne(message, choices) {
            prompts.push(message);
            if (prompts.length === 1) {
              expect(choices).toHaveLength(73);
              return selected;
            }
            return CANCELLED;
          },
          async selectMany() {
            return [];
          },
          async confirm() {
            return false;
          },
        },
      }),
    ).parseAsync(["node", "skillpark", "install"]);

    expect(prompts).toEqual([
      "Select an agent to configure",
      `Where should SkillPark install for ${selected}?`,
    ]);
    await expect(access(join(home, ".skillpark"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["hook", "skill"])(
    "does not treat install $agent as a component shortcut",
    async (agent) => {
      const home = await makeTempHome();
      let prompted = false;

      await expect(
        createProgram(
          createCommandContext({
            homeDir: home,
            prompts: {
              async selectOne() {
                prompted = true;
                return CANCELLED;
              },
              async selectMany() {
                return [];
              },
              async confirm() {
                return false;
              },
            },
          }),
        ).parseAsync(["node", "skillpark", "install", agent]),
      ).rejects.toEqual(new UsageError(`Unsupported agent: ${agent}`));
      expect(prompted).toBe(false);
    },
  );

  it.each(agents)(
    "installs the gateway skill and search hook globally for $agent by default",
    async ({ agent, configRoot, hookFile }) => {
      const home = await makeTempHome();
      const current = await makeTempHome();
      const { messages, output } = captureOutput();

      await createProgram(
        createCommandContext({
          cwd: current,
          homeDir: home,
          output,
          prompts: scopePrompts("global"),
        }),
      ).parseAsync(["node", "skillpark", "install", agent]);

      const destination = join(home, configRoot, "skills", "skillpark");
      const instructions = await readFile(
        join(destination, "SKILL.md"),
        "utf8",
      );
      expect(instructions).toContain("skillpark get <agent>");
      await expect(
        access(join(destination, "agents", "openai.yaml")),
      ).resolves.toBeUndefined();
      const hookPath = join(home, configRoot, hookFile);
      const configuration = await readJson(hookPath);
      expect(hookCommands(configuration)).toContain(`skillpark hook ${agent}`);
      const groups = (configuration.hooks as Record<string, unknown>)
        .UserPromptSubmit as { hooks: { commandWindows?: string }[] }[];
      expect(groups.at(-1)?.hooks[0]?.commandWindows).toBe(
        agent === "codex" ? "skillpark.cmd hook codex" : undefined,
      );
      await expect(access(join(current, configRoot))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(join(home, ".skillpark", "skills", agent, "skillpark")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(messages).toContain(
        `Installed SkillPark gateway skill for ${agent} (global): ${destination}`,
      );
      expect(messages).toContain(
        `Installed SkillPark search hook for ${agent} (global): ${hookPath}`,
      );
    },
  );

  it.each([
    {
      agent: "gemini-cli",
      event: "BeforeAgent",
      hookPath: ".gemini/settings.json",
      skillPath: ".gemini/skills/skillpark/SKILL.md",
    },
    {
      agent: "qwen-code",
      event: "UserPromptSubmit",
      hookPath: ".qwen/settings.json",
      skillPath: ".qwen/skills/skillpark/SKILL.md",
    },
  ] as const)(
    "installs the native prompt hook and gateway skill for $agent",
    async ({ agent, event, hookPath, skillPath }) => {
      const home = await makeTempHome();

      await runInstall(agent, createCommandContext({ homeDir: home }));

      await expect(access(join(home, skillPath))).resolves.toBeUndefined();
      expect(
        groupedHookCommands(await readJson(join(home, hookPath)), event),
      ).toContain(`skillpark hook ${agent}`);
    },
  );

  it("installs GitHub Copilot's prompt-transform hook format", async () => {
    const home = await makeTempHome();
    const current = await makeTempHome();

    await runInstall(
      "github-copilot",
      createCommandContext({ cwd: current, homeDir: home }),
      { scope: "current" },
    );

    await expect(
      access(join(current, ".agents/skills/skillpark/SKILL.md")),
    ).resolves.toBeUndefined();
    const configuration = await readJson(
      join(current, ".github/copilot/settings.json"),
    );
    const hooks = configuration.hooks as Record<string, unknown>;
    expect(hooks.userPromptTransformed).toEqual([
      expect.objectContaining({
        command: "skillpark hook github-copilot",
        timeoutSec: 30,
        type: "command",
      }),
    ]);
  });

  it("installs only the skill for hookless agents without a warning", async () => {
    const home = await makeTempHome();
    const { messages, output } = captureOutput();

    await runInstall("cursor", createCommandContext({ homeDir: home, output }));

    await expect(
      access(join(home, ".cursor/skills/skillpark/SKILL.md")),
    ).resolves.toBeUndefined();
    expect(messages).not.toContainEqual(
      expect.stringContaining("search hook protocol"),
    );
  });

  it("supports current-project installation for project-only agents", async () => {
    const home = await makeTempHome();
    const current = await makeTempHome();
    const selection: { choices?: string[] } = {};

    await createProgram(
      createCommandContext({
        cwd: current,
        homeDir: home,
        prompts: scopePrompts("current", selection),
      }),
    ).parseAsync(["node", "skillpark", "install", "eve"]);

    expect(selection.choices).toEqual(["current"]);
    await expect(
      access(join(current, "agent/skills/skillpark/SKILL.md")),
    ).resolves.toBeUndefined();
  });

  it.each(agents)(
    "supports project-local skill and hook installation for $agent",
    async ({ agent, configRoot, hookFile }) => {
      const home = await makeTempHome();
      const current = await makeTempHome();
      const selection: { choices?: string[]; message?: string } = {};

      await createProgram(
        createCommandContext({
          cwd: current,
          homeDir: home,
          prompts: scopePrompts("current", selection),
        }),
      ).parseAsync(["node", "skillpark", "install", agent]);

      await expect(
        access(
          join(
            current,
            agent === "codex" ? ".agents" : configRoot,
            "skills",
            "skillpark",
            "SKILL.md",
          ),
        ),
      ).resolves.toBeUndefined();
      const hookPath = join(current, configRoot, hookFile);
      expect(hookCommands(await readJson(hookPath))).toContain(
        `skillpark hook ${agent}`,
      );
      await expect(access(join(home, configRoot))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(selection.choices).toEqual(["global", "current"]);
      expect(selection.message).toBe(
        `Where should SkillPark install for ${agent}?`,
      );
    },
  );

  it("cancels interactive installation without changing the filesystem", async () => {
    const home = await makeTempHome();

    await createProgram(
      createCommandContext({
        homeDir: home,
        prompts: scopePrompts(CANCELLED),
      }),
    ).parseAsync(["node", "skillpark", "install", "claude"]);

    await expect(access(join(home, ".claude"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("merges with existing hooks and is idempotent", async () => {
    const home = await makeTempHome();
    const configRoot = join(home, ".claude");
    const configPath = join(configRoot, "settings.json");
    await mkdir(configRoot, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          permissions: { allow: ["Read"] },
          hooks: {
            UserPromptSubmit: [
              {
                matcher: "",
                hooks: [{ type: "command", command: "existing-hook" }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const { messages, output } = captureOutput();
    const context = createCommandContext({ homeDir: home, output });

    await runInstall("claude", context);
    await runInstall("claude", context);

    const configuration = await readJson(configPath);
    expect(configuration.permissions).toEqual({ allow: ["Read"] });
    expect(hookCommands(configuration)).toEqual([
      "existing-hook",
      "skillpark hook claude",
    ]);
    expect(
      messages.filter((message) => message.includes("already installed")),
    ).toHaveLength(2);
    expect(await context.journals.list()).toEqual([]);
  });

  it("installs the global skill and hook into a custom agent config directory", async () => {
    const home = await makeTempHome();
    const customConfig = await makeTempHome();
    const context = createCommandContext({
      homeDir: home,
      agentConfigDirs: { claude: customConfig },
    });

    await runInstall("claude", context);

    await expect(
      readFile(join(customConfig, "skills", "skillpark", "SKILL.md"), "utf8"),
    ).resolves.toContain("SkillPark Read-Only Gateway");
    expect(
      hookCommands(await readJson(join(customConfig, "settings.json"))),
    ).toContain("skillpark hook claude");
    await expect(access(join(home, ".claude"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("force-replaces a different current-project skill without duplicating the hook", async () => {
    const home = await makeTempHome();
    const current = await makeTempHome();
    const skillRoot = join(current, ".claude", "skills");
    const destination = await createSkill(skillRoot, "skillpark", {
      name: "skillpark",
      description: "old user-owned gateway",
    });
    await writeFile(join(destination, "owner.txt"), "replace me", "utf8");
    const { messages, output } = captureOutput();
    const install = () =>
      createProgram(
        createCommandContext({
          cwd: current,
          homeDir: home,
          output,
          prompts: scopePrompts("current"),
        }),
      ).parseAsync(["node", "skillpark", "install", "claude", "--force"]);

    await install();
    await install();

    await expect(access(join(destination, "owner.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(destination, "SKILL.md"), "utf8"),
    ).resolves.toContain("SkillPark Read-Only Gateway");
    expect(await readdir(skillRoot)).toEqual(["skillpark"]);
    const configuration = await readJson(
      join(current, ".claude", "settings.json"),
    );
    expect(
      hookCommands(configuration).filter(
        (command) => command === "skillpark hook claude",
      ),
    ).toHaveLength(1);
    expect(messages).toContain(
      `Replaced SkillPark gateway skill for claude (current): ${destination}`,
    );
  });

  it("does not mistake a Windows-only command match for a complete Codex hook", async () => {
    const home = await makeTempHome();
    const configRoot = join(home, ".codex");
    const configPath = join(configRoot, "hooks.json");
    await mkdir(configRoot, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "different-posix-command",
                  commandWindows: "skillpark.cmd hook codex",
                },
              ],
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    await runInstall("codex", createCommandContext({ homeDir: home }));

    expect(hookCommands(await readJson(configPath))).toEqual([
      "different-posix-command",
      "skillpark hook codex",
    ]);
  });

  it("rejects malformed hook config before installing the skill", async () => {
    const home = await makeTempHome();
    const destination = await createSkill(
      join(home, ".claude", "skills"),
      "skillpark",
      { name: "skillpark", description: "keep on preflight failure" },
    );
    await writeFile(join(destination, "owner.txt"), "keep me", "utf8");
    await writeFile(join(home, ".claude", "settings.json"), "{nope", "utf8");

    await expect(
      runInstall("claude", createCommandContext({ homeDir: home }), {
        force: true,
      }),
    ).rejects.toThrow("is not valid JSON");
    await expect(
      readFile(join(destination, "owner.txt"), "utf8"),
    ).resolves.toBe("keep me");
  });

  it("rejects a config root symlink without writing outside the scope", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    await symlink(outside, join(home, ".claude"), "dir");

    await expect(
      runInstall("claude", createCommandContext({ homeDir: home })),
    ).rejects.toThrow("Unsafe agent root component");
    await expect(access(join(outside, "settings.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never overwrites a different active skillpark entry", async () => {
    const home = await makeTempHome();
    const destination = await createSkill(
      join(home, ".claude", "skills"),
      "skillpark",
      { name: "skillpark", description: "user-owned gateway" },
    );
    await writeFile(join(destination, "owner.txt"), "keep me", "utf8");

    await expect(
      runInstall("claude", createCommandContext({ homeDir: home })),
    ).rejects.toThrow(
      `Cannot install SkillPark gateway because the destination exists: ${destination}`,
    );
    await expect(
      readFile(join(destination, "owner.txt"), "utf8"),
    ).resolves.toBe("keep me");
    await expect(
      access(join(home, ".claude", "settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported agents before changing the filesystem", async () => {
    const home = await makeTempHome();

    await expect(
      runInstall("other", createCommandContext({ homeDir: home })),
    ).rejects.toEqual(new UsageError("Unsupported agent: other"));
    await expect(access(join(home, ".skillpark"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
