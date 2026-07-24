import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/app/create-program.js";
import { createCommandContext } from "../../src/commands/context.js";
import { runInstall } from "../../src/commands/install.js";
import { UsageError } from "../../src/domain/errors.js";
import { bundledGatewaySkillRoot } from "../../src/skills/gateway.js";
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

const agents = [
  {
    agent: "claude",
    configRoot: ".claude",
  },
  { agent: "codex", configRoot: ".codex" },
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

  it.each(["../hook", "skill name"])(
    "rejects unsafe custom agent id $agent before prompting",
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
      ).rejects.toEqual(
        new UsageError(
          `Invalid agent id: ${agent}. Use lowercase letters and numbers separated by single hyphens (maximum 64 characters).`,
        ),
      );
      expect(prompted).toBe(false);
    },
  );

  it("installs a gateway skill and persistent context for a custom agent", async () => {
    const home = await makeTempHome();
    const context = createCommandContext({ homeDir: home });

    await runInstall("sodagent", context);
    await runInstall("sodagent", context);

    await expect(
      readFile(
        join(home, ".sodagent", "skills", "skillpark", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("SkillPark Read-Only Gateway");
    await expect(
      access(join(home, ".sodagent", "settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(home, ".sodagent", "AGENTS.md"), "utf8"),
    ).resolves.toContain(
      "Use the installed skill named `skillpark` through the host's normal skill mechanism",
    );
    await expect(
      access(
        join(home, ".sodagent", "skills", "skillpark", "agents", "openai.yaml"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(agents)(
    "installs the gateway skill and context globally for $agent by default",
    async ({ agent, configRoot }) => {
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
      const codexMetadata = access(join(destination, "agents", "openai.yaml"));
      if (agent === "codex") {
        await expect(codexMetadata).resolves.toBeUndefined();
      } else {
        await expect(codexMetadata).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(access(join(current, configRoot))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(join(home, ".skillpark", "skills", agent, "skillpark")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(messages).toContain(
        `Installed SkillPark gateway skill for ${agent} (global): ${destination}`,
      );
      expect(messages).not.toContainEqual(expect.stringContaining("hook"));
    },
  );

  it.each([
    {
      agent: "gemini-cli",
      instructionPath: ".gemini/GEMINI.md",
      skillPath: ".gemini/skills/skillpark/SKILL.md",
    },
    {
      agent: "qwen-code",
      instructionPath: ".qwen/QWEN.md",
      skillPath: ".qwen/skills/skillpark/SKILL.md",
    },
  ] as const)(
    "installs native context guidance and the gateway skill for $agent",
    async ({ agent, instructionPath, skillPath }) => {
      const home = await makeTempHome();

      await runInstall(agent, createCommandContext({ homeDir: home }));

      await expect(access(join(home, skillPath))).resolves.toBeUndefined();
      const contextInstructions = await readFile(
        join(home, instructionPath),
        "utf8",
      );
      expect(contextInstructions).toContain("## SkillPark skill routing");
      expect(contextInstructions).toContain(
        `host's SkillPark agent id is \`${agent}\``,
      );
      expect(contextInstructions).not.toContain("skillpark search");
      expect(contextInstructions).not.toContain("skillpark get");
    },
  );

  it("installs GitHub Copilot's context guidance without settings hooks", async () => {
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
    await expect(
      access(join(current, ".github/copilot/settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(current, ".github/copilot-instructions.md"), "utf8"),
    ).resolves.toContain(
      "Use the installed skill named `skillpark` through the host's normal skill mechanism",
    );
  });

  it.each([
    {
      agent: "claude",
      globalPath: ".claude/CLAUDE.md",
      currentPath: "CLAUDE.md",
    },
    {
      agent: "codex",
      globalPath: ".codex/AGENTS.md",
      currentPath: "AGENTS.md",
    },
    {
      agent: "gemini-cli",
      globalPath: ".gemini/GEMINI.md",
      currentPath: "GEMINI.md",
    },
    {
      agent: "qwen-code",
      globalPath: ".qwen/QWEN.md",
      currentPath: "QWEN.md",
    },
    {
      agent: "github-copilot",
      globalPath: ".copilot/copilot-instructions.md",
      currentPath: ".github/copilot-instructions.md",
    },
  ] as const)(
    "installs agent-specific context files for $agent",
    async ({ agent, currentPath, globalPath }) => {
      const home = await makeTempHome();
      const current = await makeTempHome();

      await runInstall(
        agent,
        createCommandContext({ cwd: current, homeDir: home }),
      );
      await runInstall(
        agent,
        createCommandContext({ cwd: current, homeDir: home }),
        { scope: "current" },
      );

      for (const path of [join(home, globalPath), join(current, currentPath)]) {
        const instructions = await readFile(path, "utf8");
        expect(instructions).toContain(
          `<!-- skillpark-context:${agent}:start -->`,
        );
        expect(instructions).toContain(
          `host's SkillPark agent id is \`${agent}\``,
        );
        expect(instructions).toContain(
          "invoke the `skillpark` skill before acting",
        );
        expect(instructions).not.toContain("skillpark search");
        expect(instructions).not.toContain("skillpark get");
      }
    },
  );

  it("preserves user instructions and idempotently refreshes its marked block", async () => {
    const home = await makeTempHome();
    const contextPath = join(home, ".claude", "CLAUDE.md");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      contextPath,
      [
        "# My instructions",
        "",
        "Always preserve this text.",
        "",
        "<!-- skillpark-context:claude:start -->",
        "old SkillPark guidance",
        "<!-- skillpark-context:claude:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    const context = createCommandContext({ homeDir: home });
    await runInstall("claude", context);
    await runInstall("claude", context);

    const instructions = await readFile(contextPath, "utf8");
    expect(instructions).toContain("Always preserve this text.");
    expect(instructions).not.toContain("old SkillPark guidance");
    expect(instructions).toContain(
      "invoke the `skillpark` skill before acting",
    );
    expect(
      instructions.match(/<!-- skillpark-context:claude:start -->/gu),
    ).toHaveLength(1);
    expect(
      instructions.match(/<!-- skillpark-context:claude:end -->/gu),
    ).toHaveLength(1);
  });

  it("rejects malformed context markers before installing the gateway", async () => {
    const home = await makeTempHome();
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "AGENTS.md"),
      "<!-- skillpark-context:codex:start -->\nbroken\n",
      "utf8",
    );

    await expect(
      runInstall("codex", createCommandContext({ homeDir: home })),
    ).rejects.toThrow("contains malformed SkillPark markers");
    await expect(
      access(join(home, ".codex", "skills", "skillpark")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(home, ".codex", "hooks.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs gateway and AGENTS.md compatibility guidance for other agents", async () => {
    const home = await makeTempHome();
    const { messages, output } = captureOutput();

    await runInstall("cursor", createCommandContext({ homeDir: home, output }));

    await expect(
      access(join(home, ".cursor/skills/skillpark/SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      readFile(join(home, ".cursor", "AGENTS.md"), "utf8"),
    ).resolves.toContain("host's SkillPark agent id is `cursor`");
    expect(messages).toContainEqual(
      expect.stringContaining("AGENTS.md compatibility guidance for cursor"),
    );
    expect(messages).not.toContainEqual(expect.stringContaining("hook"));
  });

  it("keeps multiple agent blocks isolated in a shared project AGENTS.md", async () => {
    const home = await makeTempHome();
    const current = await makeTempHome();
    const context = createCommandContext({ cwd: current, homeDir: home });

    await runInstall("codex", context, { scope: "current" });
    await runInstall("cursor", context, { scope: "current" });
    await runInstall("cursor", context, { scope: "current" });

    const instructions = await readFile(join(current, "AGENTS.md"), "utf8");
    expect(instructions).toContain("<!-- skillpark-context:codex:start -->");
    expect(instructions).toContain("<!-- skillpark-context:cursor:start -->");
    expect(instructions).toContain("host's SkillPark agent id is `codex`");
    expect(instructions).toContain("host's SkillPark agent id is `cursor`");
    expect(instructions).not.toContain("skillpark search");
    expect(instructions).not.toContain("skillpark get");
    expect(
      instructions.match(/<!-- skillpark-context:cursor:start -->/gu),
    ).toHaveLength(1);
    await expect(
      access(
        join(
          current,
          ".agents",
          "skills",
          "skillpark",
          "agents",
          "openai.yaml",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("restores Codex metadata when Codex joins a shared project skill root", async () => {
    const home = await makeTempHome();
    const current = await makeTempHome();
    const context = createCommandContext({ cwd: current, homeDir: home });
    const metadata = join(
      current,
      ".agents",
      "skills",
      "skillpark",
      "agents",
      "openai.yaml",
    );

    await runInstall("cursor", context, { scope: "current" });
    await expect(access(metadata)).rejects.toMatchObject({ code: "ENOENT" });

    await runInstall("codex", context, { scope: "current" });
    await expect(access(metadata)).resolves.toBeUndefined();
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
    await expect(
      readFile(join(current, "AGENTS.md"), "utf8"),
    ).resolves.toContain("host's SkillPark agent id is `eve`");
  });

  it.each(agents)(
    "supports project-local skill and context installation for $agent",
    async ({ agent, configRoot }) => {
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

  it.each([
    {
      agent: "claude",
      configPath: ".claude/settings.json",
      configuration: {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: "skillpark hook claude" }],
            },
          ],
        },
      },
    },
    {
      agent: "codex",
      configPath: ".codex/hooks.json",
      configuration: {
        description: "SkillPark read-only parked-skill search",
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "skillpark hook codex",
                  commandWindows: "skillpark.cmd hook codex",
                },
              ],
            },
          ],
        },
      },
    },
    {
      agent: "gemini-cli",
      configPath: ".gemini/settings.json",
      configuration: {
        hooks: {
          BeforeAgent: [
            {
              hooks: [
                { type: "command", command: "skillpark hook gemini-cli" },
              ],
            },
          ],
        },
      },
    },
    {
      agent: "qwen-code",
      configPath: ".qwen/settings.json",
      configuration: {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: "skillpark hook qwen-code" }],
            },
          ],
        },
      },
    },
    {
      agent: "github-copilot",
      configPath: ".copilot/settings.json",
      configuration: {
        hooks: {
          userPromptTransformed: [
            {
              type: "command",
              command: "skillpark hook github-copilot",
            },
          ],
        },
      },
    },
    {
      agent: "sodagent",
      configPath: ".sodagent/settings.json",
      configuration: {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: "skillpark hook sodagent" }],
            },
          ],
        },
      },
    },
  ])(
    "deletes an otherwise empty legacy hook config for $agent",
    async ({ agent, configPath, configuration }) => {
      const home = await makeTempHome();
      const path = join(home, configPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(configuration)}\n`, "utf8");

      await runInstall(agent, createCommandContext({ homeDir: home }));

      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("removes every SkillPark hook while preserving user settings and hooks", async () => {
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
                hooks: [
                  { type: "command", command: "existing-hook" },
                  { type: "command", command: "skillpark hook claude" },
                  { type: "command", command: "skillpark hook claude" },
                  { type: "command", command: "skillpark hook codex" },
                ],
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
    expect(configuration).toMatchObject({
      permissions: { allow: ["Read"] },
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "existing-hook" }],
          },
        ],
      },
    });
    expect(JSON.stringify(configuration)).not.toContain("skillpark hook");
    expect(
      messages.filter((message) =>
        message.includes("Removed 3 legacy SkillPark hook handlers"),
      ),
    ).toHaveLength(1);
    expect(await context.journals.list()).toEqual([]);
  });

  it("uses a custom agent config directory for skill, cleanup, and context", async () => {
    const home = await makeTempHome();
    const customConfig = await makeTempHome();
    const context = createCommandContext({
      homeDir: home,
      agentConfigDirs: { claude: customConfig },
    });
    await writeFile(
      join(customConfig, "settings.json"),
      `${JSON.stringify({
        preferences: { theme: "dark" },
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: "skillpark hook claude" }],
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    await runInstall("claude", context);

    await expect(
      readFile(join(customConfig, "skills", "skillpark", "SKILL.md"), "utf8"),
    ).resolves.toContain("SkillPark Read-Only Gateway");
    expect(await readJson(join(customConfig, "settings.json"))).toEqual({
      preferences: { theme: "dark" },
    });
    await expect(
      readFile(join(customConfig, "CLAUDE.md"), "utf8"),
    ).resolves.toContain("host's SkillPark agent id is `claude`");
    await expect(access(join(home, ".claude"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes Codex metadata from an exact legacy Claude gateway without --force", async () => {
    const home = await makeTempHome();
    const destination = join(home, ".claude", "skills", "skillpark");
    await cp(bundledGatewaySkillRoot(), destination, { recursive: true });
    const { messages, output } = captureOutput();

    await runInstall("claude", createCommandContext({ homeDir: home, output }));

    await expect(
      access(join(destination, "agents", "openai.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(destination, "SKILL.md"), "utf8"),
    ).resolves.toContain("SkillPark Read-Only Gateway");
    expect(messages).toContain(
      `SkillPark gateway skill is already installed for claude (global): ${destination}`,
    );
  });

  it("force-replaces a different current-project skill without creating hooks", async () => {
    const home = await makeTempHome();
    const current = await makeTempHome();
    const skillRoot = join(current, ".claude", "skills");
    const destination = await createSkill(skillRoot, "skillpark", {
      name: "skillpark",
      description: "old user-owned gateway",
    });
    await writeFile(join(destination, "owner.txt"), "replace me", "utf8");
    await writeFile(
      join(current, ".claude", "settings.json"),
      `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: "skillpark hook claude" }],
            },
          ],
        },
      })}\n`,
      "utf8",
    );
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
    await expect(
      access(join(current, ".claude", "settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(messages).toContain(
      `Replaced SkillPark gateway skill for claude (current): ${destination}`,
    );
  });

  it("removes a legacy Windows command without deleting a different POSIX hook", async () => {
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

    expect(await readJson(configPath)).toEqual({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "different-posix-command",
              },
            ],
          },
        ],
      },
    });
  });

  it("rejects malformed legacy hook config before installing the skill", async () => {
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

  it("rejects unsafe custom agent ids before changing the filesystem", async () => {
    const home = await makeTempHome();

    await expect(
      runInstall("../other", createCommandContext({ homeDir: home })),
    ).rejects.toThrow("Invalid agent id");
    await expect(access(join(home, ".skillpark"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
