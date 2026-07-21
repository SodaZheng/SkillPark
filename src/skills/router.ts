import type { SkillEntry } from "../domain/skills.js";

export const DEFAULT_ROUTE_LIMIT = 3;
export const DEFAULT_ROUTE_THRESHOLD = 0.6;
export const DEFAULT_ROUTE_SCORE_MARGIN = 0.18;
export const MAX_ROUTED_DESCRIPTION_BYTES = 1_024;
export const MAX_ROUTED_NAME_BYTES = 160;

const MAX_ROUTING_TEXT_CHARS = 32_000;

export interface RoutableSkill {
  entryName: string;
  name: string;
  description: string;
  aliases?: readonly string[];
}

export interface RoutedSkill {
  entryName: string;
  name: string;
  description: string;
  score: number;
  confidence: "explicit" | "high" | "medium";
  reasons: string[];
}

export interface SkillRouteResult {
  catalogSize: number;
  matches: RoutedSkill[];
}

export interface SkillRouteOptions {
  limit?: number;
  threshold?: number;
  scoreMargin?: number;
}

interface IndexedSkill extends RoutableSkill {
  title: AnalyzedText;
  descriptionText: AnalyzedText;
  aliasText: AnalyzedText;
}

interface AnalyzedText {
  features: Set<string>;
  normalized: string;
}

interface ScoredSkill {
  skill: IndexedSkill;
  score: number;
  confidence: RoutedSkill["confidence"];
  reasons: string[];
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
  "do",
  "for",
  "from",
  "help",
  "i",
  "in",
  "into",
  "is",
  "it",
  "make",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "skill",
  "skills",
  "some",
  "that",
  "the",
  "this",
  "to",
  "use",
  "using",
  "want",
  "with",
  "you",
  "一个",
  "一些",
  "一下",
  "可以",
  "如何",
  "帮",
  "帮我",
  "把",
  "技能",
  "我",
  "想",
  "用",
  "的",
  "给",
  "请",
  "这个",
  "需要",
]);

const CONCEPT_GROUPS: ReadonlyArray<
  readonly [concept: string, aliases: readonly string[]]
> = [
  [
    "document",
    [
      "document",
      "documents",
      "docx",
      "word",
      "contract",
      "memo",
      "文档",
      "合同",
      "公文",
    ],
  ],
  ["pdf", ["pdf", "acrobat", "便携式文档"]],
  [
    "spreadsheet",
    [
      "spreadsheet",
      "spreadsheets",
      "excel",
      "xlsx",
      "xls",
      "csv",
      "tsv",
      "workbook",
      "workbooks",
      "电子表格",
      "表格",
      "工作簿",
    ],
  ],
  [
    "presentation",
    [
      "presentation",
      "presentations",
      "slide",
      "slides",
      "deck",
      "ppt",
      "pptx",
      "keynote",
      "演示文稿",
      "幻灯片",
      "演示",
    ],
  ],
  [
    "image",
    [
      "image",
      "images",
      "photo",
      "photos",
      "picture",
      "pictures",
      "illustration",
      "illustrations",
      "icon",
      "icons",
      "poster",
      "banner",
      "logo",
      "png",
      "jpg",
      "jpeg",
      "图像",
      "图片",
      "照片",
      "插画",
      "图标",
      "海报",
    ],
  ],
  [
    "article",
    [
      "article",
      "articles",
      "essay",
      "briefing",
      "longform",
      "long-form",
      "文章",
      "长文",
    ],
  ],
  [
    "frontend",
    [
      "frontend",
      "front-end",
      "html",
      "css",
      "javascript",
      "typescript",
      "react",
      "ui",
      "ux",
      "dashboard",
      "webapp",
      "web-app",
      "landing page",
      "前端",
      "界面",
      "仪表盘",
      "落地页",
    ],
  ],
  [
    "browser",
    [
      "browser",
      "chrome",
      "chromium",
      "webpage",
      "website",
      "url",
      "浏览器",
      "网页",
      "网站",
    ],
  ],
  [
    "video",
    ["video", "videos", "movie", "film", "animation", "视频", "电影", "动画"],
  ],
  [
    "database",
    [
      "database",
      "databases",
      "sql",
      "schema",
      "migration",
      "migrations",
      "数据库",
      "数据迁移",
    ],
  ],
  [
    "test",
    [
      "test",
      "tests",
      "testing",
      "spec",
      "specs",
      "vitest",
      "jest",
      "测试",
      "用例",
    ],
  ],
  [
    "git",
    [
      "git",
      "github",
      "repository",
      "repositories",
      "repo",
      "repos",
      "pull request",
      "pull requests",
      "代码仓库",
      "拉取请求",
    ],
  ],
  ["email", ["email", "emails", "mail", "gmail", "outlook", "邮件", "邮箱"]],
  [
    "calendar",
    [
      "calendar",
      "calendars",
      "schedule",
      "meeting",
      "meetings",
      "日历",
      "日程",
      "会议",
    ],
  ],
  ["audio", ["audio", "speech", "voice", "tts", "音频", "语音", "配音"]],
  ["translation", ["translate", "translation", "translator", "翻译"]],
  [
    "research",
    ["research", "survey", "reddit", "hacker news", "调研", "研究", "舆情"],
  ],
];

const segmenter = new Intl.Segmenter("und", { granularity: "word" });

export function routableSkillFromEntry(entry: SkillEntry): RoutableSkill {
  return {
    entryName: entry.entryName,
    name: entry.metadata.name,
    description: entry.metadata.description,
    ...(entry.metadata.routing === undefined
      ? {}
      : { aliases: entry.metadata.routing.aliases }),
  };
}

export function routeSkills(
  prompt: string,
  catalog: readonly RoutableSkill[],
  options: SkillRouteOptions = {},
): SkillRouteResult {
  const validCatalog = catalog.filter(
    (skill) => skill.entryName !== "skillpark" && skill.description.trim(),
  );
  const limit = positiveInteger(options.limit, DEFAULT_ROUTE_LIMIT);
  const threshold = boundedNumber(
    options.threshold,
    DEFAULT_ROUTE_THRESHOLD,
    0,
    1,
  );
  const scoreMargin = boundedNumber(
    options.scoreMargin,
    DEFAULT_ROUTE_SCORE_MARGIN,
    0,
    1,
  );
  const query = analyzeText(compactRoutingText(prompt));
  if (query.features.size === 0 || validCatalog.length === 0) {
    return { catalogSize: validCatalog.length, matches: [] };
  }

  const indexed = validCatalog.map(indexSkill);
  const documentFrequency = featureDocumentFrequency(indexed);
  const scored = indexed
    .map((skill) => scoreSkill(query, skill, documentFrequency, indexed.length))
    .filter((candidate) => candidate.score >= threshold)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.skill.entryName.localeCompare(right.skill.entryName),
    );
  const topScore = scored[0]?.score;
  const matches = scored
    .filter(
      (candidate) =>
        candidate.confidence === "explicit" ||
        topScore === undefined ||
        candidate.score >= topScore - scoreMargin,
    )
    .slice(0, limit)
    .map(toRoutedSkill);
  return { catalogSize: validCatalog.length, matches };
}

function indexSkill(skill: RoutableSkill): IndexedSkill {
  return {
    ...skill,
    title: analyzeText(`${skill.entryName} ${skill.name}`),
    descriptionText: analyzeText(skill.description),
    aliasText: analyzeText(skill.aliases?.join(" ") ?? ""),
  };
}

function scoreSkill(
  query: AnalyzedText,
  skill: IndexedSkill,
  documentFrequency: ReadonlyMap<string, number>,
  catalogSize: number,
): ScoredSkill {
  if (isExplicitInvocation(query.normalized, skill)) {
    return {
      skill,
      score: 1,
      confidence: "explicit",
      reasons: ["explicit skill invocation"],
    };
  }

  const evidence: Array<{ feature: string; strength: number; source: string }> =
    [];
  for (const feature of query.features) {
    const sourceMatch = featureMatch(feature, skill);
    if (sourceMatch === undefined) continue;
    const rarity = featureRarity(
      documentFrequency.get(feature) ?? catalogSize,
      catalogSize,
    );
    evidence.push({
      feature,
      strength: sourceMatch.strength * rarity,
      source: sourceMatch.source,
    });
  }
  if (evidence.length === 0) {
    const fuzzy = fuzzyEvidence(query.features, skill);
    if (fuzzy !== undefined) evidence.push(fuzzy);
  }
  evidence.sort((left, right) => right.strength - left.strength);
  const weights = [1, 0.45, 0.25];
  let weightedEvidence = 0;
  for (const [index, item] of evidence.slice(0, weights.length).entries()) {
    weightedEvidence += item.strength * (weights[index] ?? 0);
  }
  let score = 1 - Math.exp(-1.35 * weightedEvidence);
  const normalizedEntryName = normalizeText(skill.entryName);
  const normalizedName = normalizeText(skill.name);
  if (
    containsPhrase(query.normalized, normalizedEntryName) ||
    containsPhrase(query.normalized, normalizedName)
  ) {
    score += 0.16;
  }
  const matchingAlias = skill.aliases?.find((alias) =>
    containsPhrase(query.normalized, normalizeText(alias)),
  );
  if (matchingAlias !== undefined) score += 0.12;
  score = Math.min(0.99, score);
  const reasons = evidence.slice(0, 3).map((item) => {
    const feature = item.feature.startsWith("@")
      ? item.feature.slice(1)
      : item.feature;
    return `${item.source} matched: ${feature}`;
  });
  if (matchingAlias !== undefined)
    reasons.unshift(`alias phrase: ${matchingAlias}`);
  return {
    skill,
    score,
    confidence: score >= 0.8 ? "high" : "medium",
    reasons: [...new Set(reasons)],
  };
}

function featureMatch(
  feature: string,
  skill: IndexedSkill,
): { source: string; strength: number } | undefined {
  if (skill.title.features.has(feature)) {
    return { source: "name", strength: 1 };
  }
  if (skill.aliasText.features.has(feature)) {
    return { source: "alias", strength: 0.95 };
  }
  if (skill.descriptionText.features.has(feature)) {
    return { source: "description", strength: 0.78 };
  }
  return undefined;
}

function fuzzyEvidence(
  queryFeatures: ReadonlySet<string>,
  skill: IndexedSkill,
): { feature: string; strength: number; source: string } | undefined {
  let best: { feature: string; strength: number; source: string } | undefined;
  for (const queryFeature of queryFeatures) {
    if (!/^[a-z0-9-]{4,}$/u.test(queryFeature)) continue;
    for (const [source, features, strength] of [
      ["name typo", skill.title.features, 0.82],
      ["description typo", skill.descriptionText.features, 0.7],
    ] as const) {
      for (const candidateFeature of features) {
        if (!/^[a-z0-9-]{4,}$/u.test(candidateFeature)) continue;
        const similarity = bigramDice(queryFeature, candidateFeature);
        if (similarity < 0.78) continue;
        const evidence = {
          feature: `${queryFeature}~${candidateFeature}`,
          strength: strength * similarity,
          source,
        };
        if (best === undefined || evidence.strength > best.strength) {
          best = evidence;
        }
      }
    }
  }
  return best;
}

function featureDocumentFrequency(
  catalog: readonly IndexedSkill[],
): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const skill of catalog) {
    const features = new Set([
      ...skill.title.features,
      ...skill.descriptionText.features,
      ...skill.aliasText.features,
    ]);
    for (const feature of features) {
      frequency.set(feature, (frequency.get(feature) ?? 0) + 1);
    }
  }
  return frequency;
}

function featureRarity(documentFrequency: number, catalogSize: number): number {
  const frequency = Math.max(1, documentFrequency);
  const idf = Math.log(1 + (catalogSize - frequency + 0.5) / (frequency + 0.5));
  const maximum = Math.log(1 + (catalogSize + 0.5) / 0.5);
  return 0.85 + 0.15 * (maximum === 0 ? 0 : idf / maximum);
}

function analyzeText(value: string): AnalyzedText {
  const normalized = normalizeText(compactRoutingText(value));
  const rawTokens = [...segmenter.segment(normalized)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
  const tokenFeatures = new Set<string>();
  for (const token of rawTokens) {
    if (STOP_WORDS.has(token)) continue;
    tokenFeatures.add(stemEnglishToken(token));
  }
  const features = new Set(tokenFeatures);
  for (const [concept, aliases] of CONCEPT_GROUPS) {
    if (
      aliases.some((alias) => matchesAlias(normalized, tokenFeatures, alias))
    ) {
      features.add(`@${concept}`);
    }
  }
  return { normalized, features };
}

function matchesAlias(
  normalizedText: string,
  tokenFeatures: ReadonlySet<string>,
  alias: string,
): boolean {
  const normalizedAlias = normalizeText(alias);
  if (/^[a-z0-9-]+$/u.test(normalizedAlias)) {
    return tokenFeatures.has(stemEnglishToken(normalizedAlias));
  }
  return containsPhrase(normalizedText, normalizedAlias);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLocaleLowerCase()
    .replace(/[_]+/gu, "-")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function stemEnglishToken(token: string): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(token)) return token;
  if (token.length > 5 && token.endsWith("ies"))
    return `${token.slice(0, -3)}y`;
  if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 5 && /(?:ch|sh|s|x|z)es$/u.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function isExplicitInvocation(query: string, skill: IndexedSkill): boolean {
  const candidates = [skill.entryName, skill.name]
    .map(normalizeText)
    .filter(Boolean);
  return candidates.some((name) => {
    const escaped = escapeRegExp(name).replace(/ /gu, "\\s+");
    return (
      new RegExp(`(?:^|\\s)[/$]${escaped}(?=$|\\s|[,:;])`, "iu").test(query) ||
      new RegExp(
        `(?:use|invoke|run)\\s+(?:the\\s+)?${escaped}\\s+skill\\b`,
        "iu",
      ).test(query) ||
      new RegExp(`(?:使用|调用|运行)\\s*${escaped}\\s*技能`, "iu").test(query)
    );
  });
}

function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  if (/^[a-z0-9][a-z0-9 -]*$/u.test(phrase)) {
    const escaped = escapeRegExp(phrase).replace(/ /gu, "\\s+");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "iu").test(
      text,
    );
  }
  return text.includes(phrase);
}

function bigramDice(left: string, right: string): number {
  if (left === right) return 1;
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) return 0;
  const remaining = [...rightBigrams];
  let intersection = 0;
  for (const bigram of leftBigrams) {
    const index = remaining.indexOf(bigram);
    if (index === -1) continue;
    intersection += 1;
    remaining.splice(index, 1);
  }
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function bigrams(value: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2));
  }
  return result;
}

function compactRoutingText(value: string): string {
  if (value.length <= MAX_ROUTING_TEXT_CHARS) return value;
  const half = MAX_ROUTING_TEXT_CHARS / 2;
  return `${value.slice(0, half)} ${value.slice(-half)}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function toRoutedSkill(candidate: ScoredSkill): RoutedSkill {
  return {
    entryName: candidate.skill.entryName,
    name: truncateUtf8(candidate.skill.name, MAX_ROUTED_NAME_BYTES),
    description: truncateUtf8(
      candidate.skill.description,
      MAX_ROUTED_DESCRIPTION_BYTES,
    ),
    score: Number(candidate.score.toFixed(3)),
    confidence: candidate.confidence,
    reasons: candidate.reasons.map((reason) => truncateUtf8(reason, 160)),
  };
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
