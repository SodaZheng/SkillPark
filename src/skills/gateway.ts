import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GATEWAY_SKILL_ENTRY_NAME = "skillpark";

export function bundledGatewaySkillRoot(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "skills",
    GATEWAY_SKILL_ENTRY_NAME,
  );
}
