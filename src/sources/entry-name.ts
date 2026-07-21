import { basename } from "node:path";
import { UsageError } from "../domain/errors.js";
import type { SourceSpec } from "./types.js";

const windowsUnsafe = /[<>:"/\\|?*]/u;
const windowsReserved =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

export function validateEntryName(
  value: string,
  label = "source entry name",
): string {
  const unsafe =
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.startsWith(".") ||
    value.trim() !== value ||
    value.endsWith(".") ||
    [...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f) ||
    windowsUnsafe.test(value) ||
    windowsReserved.test(value);
  if (unsafe) {
    throw new UsageError(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function sourceEntryName(source: SourceSpec): string {
  if (source.kind === "local") {
    return validateEntryName(basename(source.path));
  }

  const withoutTrailingSeparators = source.url.replace(/[\\/]+$/u, "");
  const scpPath = /^git@[^:]+:(.*)$/u.exec(withoutTrailingSeparators)?.[1];
  const sourcePath = scpPath ?? withoutTrailingSeparators;
  const finalComponent = sourcePath.split(/[\\/]/u).at(-1) ?? "";
  return validateEntryName(finalComponent.replace(/(?:\.git)+$/iu, ""));
}
