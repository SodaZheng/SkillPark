import { isAbsolute, resolve } from "node:path";
import { UsageError } from "../domain/errors.js";
import { sourceEntryName } from "./entry-name.js";
import type { SourceSpec } from "./types.js";

const githubShorthand = /^([\w.-]+)\/([\w.-]+)$/;

export function parseSource(value: string, cwd: string): SourceSpec {
  if (value.startsWith(".") || value.startsWith("/") || isAbsolute(value)) {
    const source = { kind: "local", path: resolve(cwd, value) } as const;
    sourceEntryName(source);
    return source;
  }

  const shorthand = githubShorthand.exec(value);
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) {
    const repository = shorthand[2].replace(/(?:\.git)+$/, "");
    const source = {
      kind: "git",
      url: `https://github.com/${shorthand[1]}/${repository}.git`,
    } as const;
    sourceEntryName(source);
    return source;
  }

  if (/^(?:https?:\/\/|ssh:\/\/|git@)/.test(value)) {
    const source = { kind: "git", url: value } as const;
    sourceEntryName(source);
    return source;
  }

  throw new UsageError(`Unsupported source: ${value}`);
}
