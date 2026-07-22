import { execFile, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const homes: string[] = [];
const cliPath = join(process.cwd(), "dist", "cli.js");

async function run(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "skillpark-e2e-"));
  homes.push(home);
  const options = {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home },
  };
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ["dist/cli.js", ...args],
      options,
    );
    return { code: 0, stdout, stderr, home };
  } catch (error) {
    const failure = error as Error & {
      code: number;
      stdout: string;
      stderr: string;
    };
    return {
      code: failure.code,
      stdout: failure.stdout,
      stderr: failure.stderr,
      home,
    };
  }
}

async function seedPendingStore(home: string): Promise<string> {
  const source = join(home, ".claude", "skills", "pending");
  const destination = join(home, ".skillpark", "skills", "claude", "pending");
  await mkdir(destination, { recursive: true });
  await writeFile(
    join(destination, "SKILL.md"),
    "---\nname: pending\ndescription: pending\n---\n",
    "utf8",
  );
  const journal = join(home, ".skillpark", ".transactions", "pending.jsonl");
  await mkdir(join(journal, ".."), { recursive: true });
  await writeFile(
    journal,
    `${JSON.stringify({
      id: "pending",
      action: "store",
      createdAt: "2026-07-20T00:00:00.000Z",
      items: [
        {
          id: "pending-item",
          agent: "claude",
          entryName: "pending",
          entryKind: "directory",
          operation: "move",
          source,
          destination,
        },
      ],
      states: { "pending-item": "completed" },
    })}\n`,
    "utf8",
  );
  return journal;
}

async function runWithInput(
  args: string[],
  input: string,
): Promise<{ code: number; stdout: string; stderr: string; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "skillpark-e2e-"));
  homes.push(home);
  await seedPendingStore(home);

  return spawnWithInput(home, args, input);
}

async function runInteractive(
  args: string[],
  input: string,
  cwd = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "skillpark-e2e-"));
  homes.push(home);
  return spawnWithInput(home, args, input, cwd);
}

async function spawnWithInput(
  home: string,
  args: string[],
  input: string,
  cwd = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string; home: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("CLI prompt did not exit"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr, home });
    });
    child.stdin.end(input);
  });
}

afterEach(async () =>
  Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  ),
);

describe("built CLI", () => {
  it.runIf(process.platform !== "win32")(
    "runs through the POSIX symlink shape used by npm bins",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "skillpark-bin-"));
      homes.push(directory);
      const bin = join(directory, "skillpark");
      await symlink(join(process.cwd(), "dist", "cli.js"), bin, "file");

      const { stdout, stderr } = await exec(process.execPath, [
        bin,
        "--version",
      ]);

      expect(stdout).toBe("0.1.1\n");
      expect(stderr).toBe("");
    },
  );

  it("prints branded root help and version", async () => {
    const root = await run([]);
    const version = await run(["--version"]);
    expect(root).toMatchObject({ code: 0, stderr: "" });
    expect(root.stdout).toContain("Park and load agent skills on demand");
    expect(root.stdout).toContain("Examples:");
    expect(version).toMatchObject({ code: 0, stdout: "0.1.1\n", stderr: "" });
  });

  it("maps unknown commands and invalid agent ids to exit code 2", async () => {
    const command = await run(["launch"]);
    const agent = await run(["store", "../other"]);
    const installComponent = await run(["install", "claude", "skill"]);
    expect(command.code).toBe(2);
    expect(command.stderr).toContain("unknown command 'launch'");
    expect(agent.code).toBe(2);
    expect(agent.stderr).toContain("Invalid agent id: ../other");
    expect(installComponent.code).toBe(1);
    expect(installComponent.stderr).toContain("too many arguments");
  });

  it("maps runtime failures to exit code 1 without a stack trace", async () => {
    const result = await run(["add", "./missing-source"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error:");
    expect(result.stderr).not.toContain("at runAdd");
  });

  it("installs the bundled gateway skill and hook into the selected agent", async () => {
    const result = await runInteractive(["install", "codex"], "\r");

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(
      "Installed SkillPark gateway skill for codex (global)",
    );
    expect(result.stdout).toContain(
      "Installed SkillPark search hook for codex (global)",
    );
    await expect(
      readFile(
        join(result.home, ".codex", "skills", "skillpark", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("/skillpark /pdf rotate report.pdf");
    await expect(
      readFile(join(result.home, ".codex", "hooks.json"), "utf8"),
    ).resolves.toContain("skillpark hook codex");

    const gateway = join(result.home, ".codex", "skills", "skillpark");
    await writeFile(join(gateway, "stale.txt"), "replace me", "utf8");
    const forced = await spawnWithInput(
      result.home,
      ["install", "codex", "--force"],
      "\r",
    );
    expect(forced).toMatchObject({ code: 0, stderr: "" });
    expect(forced.stdout).toContain(
      "Replaced SkillPark gateway skill for codex (global)",
    );
    await expect(access(join(gateway, "stale.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const hookConfiguration = await readFile(
      join(result.home, ".codex", "hooks.json"),
      "utf8",
    );
    expect(hookConfiguration.match(/skillpark hook codex/g)).toHaveLength(1);
  });

  it("installs SkillPark for a convention-based custom agent", async () => {
    const result = await runInteractive(["install", "sodagent"], "\r");

    expect(result).toMatchObject({ code: 0, stderr: "" });
    await expect(
      readFile(
        join(result.home, ".sodagent", "skills", "skillpark", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("SkillPark Read-Only Gateway");
    await expect(
      readFile(join(result.home, ".sodagent", "settings.json"), "utf8"),
    ).resolves.toContain("skillpark hook sodagent");
  });

  it("selects an agent interactively when store omits it", async () => {
    const result = await runInteractive(["store"], "\r");

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(
      "Select an agent whose skills you want to park",
    );
    expect(result.stdout).toContain("No skills available to store");
  });

  it("selects the current project scope interactively", async () => {
    const project = await mkdtemp(join(tmpdir(), "skillpark-project-"));
    homes.push(project);

    const result = await runInteractive(
      ["install", "claude"],
      "\u001b[B\r",
      project,
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    await expect(
      readFile(join(project, ".claude", "settings.json"), "utf8"),
    ).resolves.toContain("skillpark hook claude");
    await expect(
      access(join(project, ".claude", "skills", "skillpark", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(access(join(result.home, ".claude"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    { input: "n\r", response: "false" },
    { input: "\u001b", response: "Escape cancellation" },
    { input: "\u0003", response: "Ctrl+C cancellation" },
  ])(
    "maps recovery $response to exit code 0 without a runtime error",
    async ({ input }) => {
      const result = await runWithInput(["store", "claude"], input);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      await expect(
        access(
          join(result.home, ".skillpark", ".transactions", "pending.jsonl"),
        ),
      ).resolves.toBeUndefined();
    },
  );
});
