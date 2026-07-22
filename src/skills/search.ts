import MiniSearch from "minisearch";
import { stemmer } from "stemmer";
import type { SkillEntry } from "../domain/skills.js";

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCHED_DESCRIPTION_BYTES = 1_024;
export const MAX_SEARCHED_NAME_BYTES = 160;

const MAX_SEARCH_TEXT_CHARS = 32_000;

export type SearchMatchField = "name" | "keywords" | "description";

export interface SearchableSkill {
  entryName: string;
  name: string;
  description: string;
  keywords?: readonly string[];
}

export interface SkillSearchHit {
  entryName: string;
  name: string;
  description: string;
  score: number;
  exactInvocation: boolean;
  matchedTerms: string[];
  matchedFields: SearchMatchField[];
}

export interface SkillSearchResult {
  catalogSize: number;
  hits: SkillSearchHit[];
}

export interface SkillSearchOptions {
  limit?: number;
}

interface SearchDocument {
  id: number;
  name: string;
  keywords: string;
  description: string;
}

const STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "help",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "me",
  "might",
  "must",
  "my",
  "of",
  "on",
  "or",
  "please",
  "should",
  "some",
  "that",
  "the",
  "their",
  "there",
  "then",
  "than",
  "this",
  "to",
  "use",
  "using",
  "want",
  "was",
  "were",
  "what",
  "when",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
  "一个",
  "一些",
  "一下",
  "可以",
  "如何",
  "帮",
  "帮我",
  "把",
  "我",
  "想",
  "用",
  "的",
  "给",
  "请",
  "这个",
  "需要",
]);

const NEGATIVE_MARKER =
  /\b(?:do\s+not|don't|does\s+not|not\s+for|should\s+not|must\s+not|avoid(?:\s+using)?|rather\s+than|instead\s+of|except(?:\s+for)?|not\s+intended\s+for)\b|(?:不适用(?:于)?|不用于|不要用于|不要用|不应该|不能用于|而不是|无需|除外|不生成|不处理)/iu;

const segmenter = new Intl.Segmenter("und", { granularity: "word" });

export function searchableSkillFromEntry(entry: SkillEntry): SearchableSkill {
  return {
    entryName: entry.entryName,
    name: entry.metadata.name,
    description: entry.metadata.description,
    ...(entry.metadata.search === undefined
      ? {}
      : { keywords: entry.metadata.search.keywords }),
  };
}

/**
 * Retrieve a bounded candidate set from parked-skill metadata.
 *
 * This function deliberately does not decide whether a skill applies. It uses
 * field-weighted BM25, Unicode word segmentation, CJK bigrams, English
 * stemming, prefixes, and conservative typo matching. The host model performs
 * query expansion and the final skill-trigger decision.
 */
export function searchSkills(
  query: string,
  catalog: readonly SearchableSkill[],
  options: SkillSearchOptions = {},
): SkillSearchResult {
  const validCatalog = catalog.filter(
    (skill) => skill.entryName !== "skillpark" && skill.description.trim(),
  );
  const limit = positiveInteger(options.limit, DEFAULT_SEARCH_LIMIT);
  const compactQuery = compactSearchText(query);
  if (
    tokenizeSearchText(compactQuery).length === 0 ||
    validCatalog.length === 0
  ) {
    return { catalogSize: validCatalog.length, hits: [] };
  }

  const documents = validCatalog.map((skill, id) => ({
    id,
    name: `${skill.entryName} ${skill.name}`,
    keywords: skill.keywords?.join(" ") ?? "",
    description: positiveDescription(skill.description),
  }));
  const index = new MiniSearch<SearchDocument>({
    fields: ["name", "keywords", "description"],
    idField: "id",
    tokenize: tokenizeSearchText,
    processTerm: identityTerm,
  });
  index.addAll(documents);

  const lexicalResults = index.search(compactQuery, {
    combineWith: "OR",
    boost: { name: 6, keywords: 4, description: 1 },
    prefix: (term) => isFuzzyTerm(term) && term.length >= 5,
    fuzzy: (term) => (isFuzzyTerm(term) && term.length >= 5 ? 0.2 : false),
    maxFuzzy: 2,
    weights: { fuzzy: 0.45, prefix: 0.6 },
  });

  const resultsById = new Map(
    lexicalResults.map((result) => [Number(result.id), result]),
  );
  const queryTermDisplays = searchTermDisplays(compactQuery);
  const ranked = validCatalog
    .map((skill, id) => {
      const result = resultsById.get(id);
      const exactInvocation = isExplicitInvocation(compactQuery, skill);
      if (result === undefined && !exactInvocation) return undefined;
      const matchedFields = new Set<SearchMatchField>();
      for (const fields of Object.values(result?.match ?? {})) {
        for (const field of fields) {
          if (isSearchMatchField(field)) matchedFields.add(field);
        }
      }
      if (exactInvocation) matchedFields.add("name");
      const matchedTerms = [
        ...new Set(
          (result?.queryTerms ?? [skill.entryName]).map(
            (term) =>
              queryTermDisplays.get(term) ?? displayInternalSearchTerm(term),
          ),
        ),
      ]
        .filter(Boolean)
        .slice(0, 8);
      return {
        skill,
        score: result?.score ?? 0,
        exactInvocation,
        matchedTerms,
        matchedFields: [...matchedFields].sort(),
      };
    })
    .filter((item) => item !== undefined)
    .sort(
      (left, right) =>
        Number(right.exactInvocation) - Number(left.exactInvocation) ||
        right.score - left.score ||
        left.skill.entryName.localeCompare(right.skill.entryName),
    )
    .slice(0, limit);

  return {
    catalogSize: validCatalog.length,
    hits: ranked.map(({ skill, ...match }) => ({
      entryName: skill.entryName,
      name: truncateUtf8(skill.name, MAX_SEARCHED_NAME_BYTES),
      description: truncateUtf8(
        skill.description,
        MAX_SEARCHED_DESCRIPTION_BYTES,
      ),
      score: Number(match.score.toFixed(3)),
      exactInvocation: match.exactInvocation,
      matchedTerms: match.matchedTerms.map((term) => truncateUtf8(term, 80)),
      matchedFields: match.matchedFields,
    })),
  };
}

function tokenizeSearchText(value: string): string[] {
  const tokens = new Set<string>();
  forEachSearchToken(value, (token) => tokens.add(token));
  return [...tokens];
}

function searchTermDisplays(value: string): Map<string, string> {
  const displays = new Map<string, string>();
  forEachSearchToken(value, (token, display) => {
    if (!displays.has(token)) displays.set(token, display);
  });
  return displays;
}

function forEachSearchToken(
  value: string,
  emit: (token: string, display: string) => void,
): void {
  const prepared = prepareSearchText(compactSearchText(value));
  for (const part of segmenter.segment(prepared)) {
    if (!part.isWordLike) continue;
    const raw = part.segment;
    const normalized = raw.toLocaleLowerCase();
    if (!normalized || STOP_WORDS.has(normalized)) continue;
    emit(normalized, raw);
    if (/^[a-z][a-z0-9-]*$/u.test(normalized)) {
      emit(`stem:${stemmer(normalized)}`, raw);
    }
    const camelParts = splitCamelCase(raw);
    if (camelParts.length > 1) {
      for (const camelPart of camelParts) {
        const normalizedPart = camelPart.toLocaleLowerCase();
        if (!normalizedPart || STOP_WORDS.has(normalizedPart)) continue;
        emit(`camel:${normalizedPart}`, raw);
        if (/^[a-z][a-z0-9-]*$/u.test(normalizedPart)) {
          emit(`camel-stem:${stemmer(normalizedPart)}`, raw);
        }
      }
    }
    for (const sequence of raw.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
    ) ?? []) {
      const characters = [...sequence];
      for (let index = 0; index < characters.length - 1; index += 1) {
        const bigram = `${characters[index]}${characters[index + 1]}`;
        emit(`cjk:${bigram}`, bigram);
      }
    }
  }
}

function positiveDescription(value: string): string {
  const positive: string[] = [];
  for (const clause of value.split(/[.!?;。！？；\n]+/u)) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    const marker = NEGATIVE_MARKER.exec(trimmed);
    if (marker?.index === undefined) {
      positive.push(trimmed);
      continue;
    }
    const prefix = trimmed.slice(0, marker.index).trim();
    if (prefix) positive.push(prefix);
  }
  return positive.join(" ");
}

function isExplicitInvocation(query: string, skill: SearchableSkill): boolean {
  const normalizedQuery = normalizeText(query);
  return [skill.entryName, skill.name]
    .map(normalizeText)
    .filter(Boolean)
    .some((name) => {
      const escaped = escapeRegExp(name).replace(/ /gu, "\\s+");
      return (
        new RegExp(`(?:^|\\s)[/$]${escaped}(?=$|\\s|[,:;])`, "iu").test(
          normalizedQuery,
        ) ||
        new RegExp(
          `(?:use|invoke|run)\\s+(?:the\\s+)?${escaped}\\s+skill\\b`,
          "iu",
        ).test(normalizedQuery) ||
        new RegExp(`(?:使用|调用|运行)\\s*${escaped}\\s*技能`, "iu").test(
          normalizedQuery,
        )
      );
    });
}

function isSearchMatchField(value: string): value is SearchMatchField {
  return value === "name" || value === "keywords" || value === "description";
}

function displayInternalSearchTerm(term: string): string {
  for (const prefix of ["camel-stem:", "camel:", "stem:", "cjk:"]) {
    if (term.startsWith(prefix)) return term.slice(prefix.length);
  }
  return term;
}

function normalizeText(value: string): string {
  return prepareSearchText(value)
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function prepareSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[_]+/gu, "-")
    .replace(/[\u2018\u2019]/gu, "'");
}

function splitCamelCase(value: string): string[] {
  const separated = value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
  return separated === value ? [value] : separated.split(/\s+/u);
}

function isFuzzyTerm(term: string): boolean {
  return /^[a-z0-9-]{4,}$/u.test(term);
}

function identityTerm(term: string): string {
  return term;
}

function compactSearchText(value: string): string {
  if (value.length <= MAX_SEARCH_TEXT_CHARS) return value;
  const half = MAX_SEARCH_TEXT_CHARS / 2;
  return `${value.slice(0, half)} ${value.slice(-half)}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
