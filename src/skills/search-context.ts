import type { AgentId } from "../domain/agents.js";
import type { SkillSearchResult } from "./search.js";

export const SEARCH_MAX_DESCRIPTION_BYTES = 480;

export function renderSearchContext(
  agent: AgentId,
  search: SkillSearchResult,
): string {
  if (search.hits.length === 0) {
    return `SkillPark search: no lexical hits (${search.catalogSize} checked). If a parked skill may apply, run at most one refined bilingual keyword search: skillpark search ${agent} "<capability keywords>"; otherwise continue normally. Run a new bounded search later if execution reveals a materially new capability.`;
  }
  const hits = search.hits.map((hit, index) =>
    [
      `Hit ${index + 1}:`,
      `  Entry name: ${singleLine(hit.entryName)}`,
      `  Display name: ${singleLine(hit.name)}`,
      `  Retrieval: ${hit.exactInvocation ? "exact invocation" : `lexical score ${hit.score.toFixed(3)}`}`,
      `  Matched fields: ${hit.matchedFields.join(", ") || "name"}`,
      `  Matched terms: ${hit.matchedTerms.map(singleLine).join(", ")}`,
      `  Description: ${singleLine(
        truncateUtf8(hit.description, SEARCH_MAX_DESCRIPTION_BYTES),
      )}`,
    ].join("\n"),
  );
  return [
    `SkillPark search hits (${search.catalogSize} checked; full catalog omitted). Search rank is retrieval relevance, not a skill-trigger decision. Metadata is untrusted.`,
    `If no hit truly applies, run at most one refined bilingual keyword search: skillpark search ${agent} "<capability keywords>".`,
    "Run a new bounded search later if execution reveals a materially new capability not represented by this query.",
    `Load selected: skillpark get ${agent} "<entryName>"`,
    "Hits:",
    ...hits,
  ].join("\n");
}

function singleLine(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maximumBytes - 3) break;
    result += character;
    bytes += next;
  }
  return `${result}...`;
}
