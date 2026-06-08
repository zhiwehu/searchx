import fs from "node:fs/promises";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { catalog } from "./catalog.js";
import { killProcessTree } from "./processUtils.js";
import type { IngestedAsset, MediaKind, SearchMode, SearchRequest, SearchResponse, SearchResultItem } from "./types.js";

type QmdStore = {
  update(options?: unknown): Promise<unknown>;
  embed(options?: unknown): Promise<unknown>;
  search(options: unknown): Promise<unknown[]>;
  searchLex(query: string, options?: unknown): Promise<unknown[]>;
  searchVector(query: string, options?: unknown): Promise<unknown[]>;
  getStatus?: () => Promise<unknown>;
  listCollections?: () => Promise<unknown>;
  close?: () => Promise<void>;
};

type DeepSearchOptions = {
  query: string;
  limit: number;
  candidateLimit: number;
  minScore?: number;
  collection: string;
  chunkStrategy: string;
};

type DeepSearchWorkerEntrypoint = {
  path: string;
  execArgv: string[];
};

type QmdIndexWorkerEntrypoint = {
  path: string;
  execArgv: string[];
};

type DeepSearchWorkerMessage =
  | { type: "result"; results: unknown[] }
  | { type: "error"; error: string };

type QmdIndexProgress = {
  phase: "indexing" | "embedding";
  message: string;
};

type QmdIndexWorkerMessage =
  | { type: "progress"; phase: "indexing" | "embedding"; message: string }
  | { type: "result"; result: unknown }
  | { type: "error"; error: string };

type SearchIntent = {
  originalQuery: string;
  semanticQuery: string;
  terms: string[];
  typeFilters: FileTypeFilter[];
  dateRange?: DateRange;
  visualContent: boolean;
};

type DateRange = {
  label: string;
  startMs: number;
  endMs: number;
};

type FileTypeFilter = {
  label: string;
  extensions: string[];
  kinds: MediaKind[];
};

type FileTypeRule = FileTypeFilter & {
  pattern: RegExp;
};

let storePromise: Promise<QmdStore> | undefined;

const metadataScanMaxAssets = 500;
const metadataScanMaxBytes = 500_000;
const structuredSemanticMinScore = 0.45;

const fileTypeRules: FileTypeRule[] = [
  {
    label: "PPT",
    pattern: /\b(?:pptx?|powerpoint)\b|PPT|幻灯片|演示文稿/g,
    extensions: [".ppt", ".pptx"],
    kinds: []
  },
  {
    label: "PDF",
    pattern: /\bpdf\b|PDF/g,
    extensions: [".pdf"],
    kinds: []
  },
  {
    label: "Word",
    pattern: /\b(?:docx?|word)\b|Word/g,
    extensions: [".doc", ".docx"],
    kinds: []
  },
  {
    label: "Excel",
    pattern: /\b(?:xlsx?|excel|csv)\b|Excel|表格/g,
    extensions: [".xls", ".xlsx", ".csv", ".tsv"],
    kinds: []
  },
  {
    label: "Image",
    pattern: /\b(?:png|jpe?g|webp|gif|heic|bmp|tiff?)\b|图片|图像|照片|截图/g,
    extensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".bmp", ".tif", ".tiff"],
    kinds: ["image"]
  },
  {
    label: "Audio",
    pattern: /\b(?:mp3|wav|m4a|aac|flac|ogg)\b|音频|录音|语音|ASR/gi,
    extensions: [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"],
    kinds: ["audio"]
  },
  {
    label: "Video",
    pattern: /\b(?:mp4|mov|mkv|webm|avi)\b|视频|录像|录屏/g,
    extensions: [".mp4", ".mov", ".mkv", ".webm", ".avi"],
    kinds: ["video"]
  },
  {
    label: "Archive",
    pattern: /\b(?:zip|rar|7z|tar|gz)\b|压缩包|压缩文件/g,
    extensions: [".zip", ".rar", ".7z", ".tar", ".gz"],
    kinds: ["archive"]
  },
  {
    label: "Markdown",
    pattern: /\b(?:md|markdown|txt|text)\b|Markdown|文本/g,
    extensions: [".md", ".markdown", ".txt"],
    kinds: ["text"]
  }
];

const timePatterns = [
  /最近\s*\d+\s*天/g,
  /近\s*\d+\s*天/g,
  /过去\s*\d+\s*天/g,
  /最近一周|近一周|过去一周|过去7天/g,
  /最近一个月|近一个月|过去一个月|过去30天/g,
  /今天|今日|昨天|昨日|前天/g,
  /上周|上一周|本周|这周|这个周/g,
  /上个月|上一月|本月|这个月/g,
  /今年|去年/g,
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
  /\b\d{8}\b/g,
  /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?/g
];

const fillerPatterns = [
  /帮我找到|帮我找|帮忙找|请帮我|麻烦帮我|我想要|想要|我想找|想找|我要找|查找|麻烦|帮忙|帮我|找到|找一下|找出|寻找|找找|找/g,
  /文件|资料|内容|关于|包含|包括|查找|搜索|检索|查询|里面|中|里|有|的/g,
  /\b(?:file|files|about|with|contains?|search|find|in)\b/gi
];

export async function getQmdStore(): Promise<QmdStore> {
  if (!storePromise) {
    storePromise = createQmdStore();
  }
  return storePromise;
}

export async function closeQmdStore(): Promise<void> {
  if (!storePromise) return;
  const store = await storePromise;
  await store.close?.();
  storePromise = undefined;
}

export async function refreshQmdIndex(
  options: { embed?: boolean; force?: boolean } = {},
  report?: (progress: QmdIndexProgress) => void
): Promise<unknown> {
  await fs.mkdir(config.markdownDir, { recursive: true });
  const worker = await resolveQmdIndexWorker();
  if (worker) {
    await closeQmdStore();
    return runQmdIndexWorker(worker, options, report);
  }

  const store = await getQmdStore();
  const update = await store.update({
    collections: [config.qmdCollection],
    onProgress: (info: Record<string, unknown>) => {
      const current = typeof info.current === "number" ? info.current : 0;
      const total = typeof info.total === "number" ? info.total : 0;
      report?.({
        phase: "indexing",
        message: total > 0 ? `刷新 QMD 文本索引：${current}/${total}` : "刷新 QMD 文本索引。"
      });
    }
  });

  if (!options.embed) {
    return { update, embed: null };
  }

  const embed = await store.embed({
    force: options.force === true,
    chunkStrategy: config.qmdChunkStrategy,
    onProgress: (info: Record<string, unknown>) => {
      const chunksEmbedded = typeof info.chunksEmbedded === "number" ? info.chunksEmbedded : 0;
      const totalChunks = typeof info.totalChunks === "number" ? info.totalChunks : 0;
      const errors = typeof info.errors === "number" ? info.errors : 0;
      report?.({
        phase: "embedding",
        message: `生成 QMD 向量索引：chunks ${chunksEmbedded}/${totalChunks}${errors > 0 ? `, errors ${errors}` : ""}`
      });
    }
  });
  return { update, embed };
}

export async function searchQmd(request: SearchRequest): Promise<SearchResponse> {
  const query = request.query?.trim();
  if (!query) {
    throw Object.assign(new Error("Missing query"), { statusCode: 400 });
  }

  const modeRequested = parseSearchMode(request.mode);
  let mode: SearchMode = modeRequested;
  let warning: string | undefined;
  const limit = clampInteger(request.limit, 1, 50, 10);
  const minScore = typeof request.minScore === "number" ? request.minScore : undefined;
  const store = await getQmdStore();
  const status = await readQmdStatus(store);
  const intent = analyzeSearchQuery(query);
  const semanticQuery = intent.semanticQuery || query;

  if ((mode === "hybrid" || mode === "vector" || mode === "deep") && !status.hasVectorIndex) {
    if (mode === "vector" || mode === "deep") {
      throw Object.assign(new Error("还没有向量索引。请先重新同步，或调用 /api/index 生成向量索引。"), { statusCode: 400 });
    }
    mode = "lex";
    warning = "还没有生成 QMD 向量索引，本次已自动降级为关键词检索。重新同步或调用 /api/index 生成向量索引后，智能检索会更准。";
  }

  const assets = await catalog.list();
  const catalogResults = await searchCatalogMatches(intent, assets, limit);
  let results: SearchResultItem[];
  try {
    if (mode === "lex") {
      const rawResults = await store.searchLex(semanticQuery, { limit, minScore, collection: config.qmdCollection });
      const qmdResults = filterResultsByIntent(rawResults.map((result) => normalizeResult(result, assets)), intent);
      results = mergeIntentResults(intent, catalogResults, qmdResults, limit);
    } else if (mode === "vector") {
      const rawResults = await store.searchVector(semanticQuery, { limit, minScore, collection: config.qmdCollection });
      const qmdResults = filterResultsByIntent(rawResults.map((result) => normalizeResult(result, assets)), intent);
      results = mergeIntentResults(intent, catalogResults, qmdResults, limit);
    } else if (mode === "hybrid") {
      const qmdResults = await searchFastHybrid(store, semanticQuery, { limit, minScore }, assets, intent);
      results = mergeIntentResults(intent, catalogResults, qmdResults, limit);
      warning = warning ?? "快速混合模式使用关键词 + 向量，不触发 QMD rerank/query-expansion 大模型。";
    } else {
      const rawResults = await searchDeep(store, {
        query: semanticQuery,
        limit,
        candidateLimit: deepCandidateLimit(limit),
        minScore,
        collection: config.qmdCollection,
        chunkStrategy: config.qmdChunkStrategy
      });
      const qmdResults = filterResultsByIntent(rawResults.map((result) => normalizeResult(result, assets)), intent);
      results = mergeIntentResults(intent, catalogResults, qmdResults, limit);
    }
  } catch (error) {
    if (mode === "deep") {
      try {
        const qmdResults = await searchFastHybrid(store, semanticQuery, { limit, minScore }, assets, intent);
        results = mergeIntentResults(intent, catalogResults, qmdResults, limit);
        mode = "hybrid";
        warning = `深度检索暂不可用，本次已降级为快速混合检索：${errorMessage(error)}`;
      } catch (fallbackError) {
        const rawResults = await store.searchLex(semanticQuery, { limit, minScore, collection: config.qmdCollection });
        const qmdResults = filterResultsByIntent(rawResults.map((result) => normalizeResult(result, assets)), intent);
        results = mergeIntentResults(intent, catalogResults, qmdResults, limit);
        mode = "lex";
        warning = `深度检索暂不可用，快速混合检索也失败，本次已降级为关键词检索：${errorMessage(fallbackError)}`;
      }
    } else if (mode === "hybrid") {
      const rawResults = await store.searchLex(semanticQuery, { limit, minScore, collection: config.qmdCollection });
      const qmdResults = filterResultsByIntent(rawResults.map((result) => normalizeResult(result, assets)), intent);
      results = mergeIntentResults(intent, catalogResults, qmdResults, limit);
      mode = "lex";
      warning = `向量检索暂不可用，本次已降级为关键词检索：${errorMessage(error)}`;
    } else {
      throw error;
    }
  }

  return {
    results,
    modeRequested,
    modeUsed: mode,
    warning
  };
}

export function parseSearchMode(value: unknown): SearchMode {
  if (value === undefined || value === null || value === "") return "hybrid";
  if (value === "lex" || value === "vector" || value === "hybrid" || value === "deep") return value;
  throw Object.assign(new Error("Invalid search mode. Expected one of: lex, vector, hybrid, deep."), { statusCode: 400 });
}

export async function getQmdStatus(): Promise<unknown> {
  const store = await getQmdStore();
  if (store.getStatus) return store.getStatus();
  if (store.listCollections) return { collections: await store.listCollections() };
  return { ok: true };
}

export function analyzeSearchQuery(query: string, now = new Date()): SearchIntent {
  let semanticQuery = query;
  const typeFilters: FileTypeFilter[] = [];

  for (const rule of fileTypeRules) {
    if (!patternMatches(rule.pattern, query)) continue;
    typeFilters.push({ label: rule.label, extensions: rule.extensions, kinds: rule.kinds });
    semanticQuery = semanticQuery.replace(rule.pattern, " ");
  }

  const dateRange = parseDateRange(query, now);
  if (dateRange) {
    for (const pattern of timePatterns) {
      semanticQuery = semanticQuery.replace(pattern, " ");
    }
  }

  for (const pattern of fillerPatterns) {
    semanticQuery = semanticQuery.replace(pattern, " ");
  }

  semanticQuery = normalizeQueryText(semanticQuery);
  const terms = extractTerms(semanticQuery);
  return {
    originalQuery: query,
    semanticQuery,
    terms,
    typeFilters,
    dateRange,
    visualContent: isVisualContentQuery(query, semanticQuery, terms, typeFilters)
  };
}

function isVisualContentQuery(
  originalQuery: string,
  semanticQuery: string,
  terms: string[],
  typeFilters: FileTypeFilter[]
): boolean {
  if (!typeFilters.some((filter) => filter.kinds.includes("image"))) return false;
  if (terms.length === 0 || compactForMatch(semanticQuery).length === 0) return false;
  if (/\.[a-z0-9]{1,8}\b/i.test(originalQuery)) return false;
  if (/文件名|路径|后缀|扩展名/.test(originalQuery)) return false;
  return true;
}

async function searchCatalogMatches(intent: SearchIntent, assets: IngestedAsset[], limit: number): Promise<SearchResultItem[]> {
  const candidates = assets.filter((asset) => assetMatchesHardFilters(asset, intent));
  const shouldReadMarkdown = intent.terms.length > 0
    && (intent.typeFilters.length > 0 || Boolean(intent.dateRange) || candidates.length <= metadataScanMaxAssets);
  const scored: Array<SearchResultItem & { rankScore: number }> = [];

  for (const asset of candidates) {
    const metadata = [asset.title, asset.relativePath, asset.sourcePath, asset.sourceExt, asset.kind].join(" ");
    const reasons: string[] = [];
    let rankScore = 0;
    let termMatched = false;
    let snippet: string | undefined;

    if (matchContains(metadata, intent.originalQuery)) {
      rankScore += 120;
      termMatched = true;
      reasons.push("文件名或路径匹配原始查询");
    }
    if (intent.semanticQuery && matchContains(metadata, intent.semanticQuery)) {
      rankScore += 80;
      termMatched = true;
      reasons.push("文件名或路径匹配查询意图");
    }
    for (const term of intent.terms) {
      if (matchContains(asset.title, term)) {
        rankScore += 35;
        termMatched = true;
        reasons.push(`文件名匹配：${term}`);
      } else if (matchContains(asset.relativePath, term) || matchContains(asset.sourcePath, term)) {
        rankScore += 22;
        termMatched = true;
        reasons.push(`路径匹配：${term}`);
      }
    }

    if (shouldReadMarkdown) {
      const contentMatch = await readMarkdownMatch(asset, intent);
      if (contentMatch.rankScore > 0) {
        rankScore += contentMatch.rankScore;
        termMatched = true;
        snippet = contentMatch.snippet;
        reasons.push(...contentMatch.reasons);
      }
    }

    if (intent.typeFilters.length > 0) {
      rankScore += 12;
      reasons.push(`文件类型匹配：${intent.typeFilters.map((filter) => filter.label).join("/")}`);
    }
    if (intent.dateRange) {
      rankScore += 12;
      reasons.push(`时间匹配：${intent.dateRange.label}`);
    }

    const hasHardFilter = intent.typeFilters.length > 0 || Boolean(intent.dateRange);
    if (intent.terms.length > 0 && !termMatched) continue;
    if (rankScore <= 0 && !hasHardFilter) continue;
    if (!snippet) snippet = reasons.slice(0, 3).join("；");

    scored.push({
      id: asset.id,
      title: asset.title,
      score: normalizeCatalogScore(rankScore),
      rankScore,
      snippet,
      displayPath: asset.relativePath,
      markdownPath: asset.markdownPath,
      source: asset,
      raw: {
        source: "catalog",
        semanticQuery: intent.semanticQuery,
        typeFilters: intent.typeFilters.map((filter) => filter.label),
        dateRange: intent.dateRange?.label,
        reasons
      }
    });
  }

  return scored
    .sort((a, b) => b.rankScore - a.rankScore || b.source!.mtimeMs - a.source!.mtimeMs)
    .slice(0, Math.min(Math.max(limit * 2, limit), 50))
    .map(({ rankScore: _rankScore, ...item }) => item);
}

function normalizeCatalogScore(rankScore: number): number {
  if (!Number.isFinite(rankScore) || rankScore <= 0) return 0;
  return Math.max(0.01, Math.min(0.99, rankScore / 100));
}

async function readMarkdownMatch(asset: IngestedAsset, intent: SearchIntent): Promise<{ rankScore: number; snippet?: string; reasons: string[] }> {
  try {
    const raw = await fs.readFile(asset.markdownPath, "utf8");
    const content = raw.length > metadataScanMaxBytes ? raw.slice(0, metadataScanMaxBytes) : raw;
    const reasons: string[] = [];
    let rankScore = 0;
    let snippet: string | undefined;

    if (intent.semanticQuery && matchContains(content, intent.semanticQuery)) {
      rankScore += 35;
      reasons.push("Markdown 内容匹配查询意图");
      snippet = snippetAround(content, intent.semanticQuery);
    }

    for (const term of intent.terms) {
      if (!matchContains(content, term)) continue;
      rankScore += 12;
      reasons.push(`Markdown 内容匹配：${term}`);
      snippet = snippet ?? snippetAround(content, term);
    }

    return { rankScore, snippet, reasons };
  } catch {
    return { rankScore: 0, reasons: [] };
  }
}

function filterResultsByIntent(items: SearchResultItem[], intent: SearchIntent): SearchResultItem[] {
  if (intent.typeFilters.length === 0 && !intent.dateRange) return items;
  return items.filter((item) => {
    if (!resultMatchesHardFilters(item, intent)) return false;
    if (intent.terms.length === 0) return true;
    if (resultMatchesAnyTerm(item, intent)) return true;
    return item.score >= structuredSemanticMinScore;
  });
}

function resultMatchesHardFilters(item: SearchResultItem, intent: SearchIntent): boolean {
  if (item.source) return assetMatchesHardFilters(item.source, intent);

  if (intent.dateRange) return false;
  if (intent.typeFilters.length === 0) return true;

  const metadata = [item.title, item.displayPath, item.markdownPath].filter(Boolean).join(" ");
  return intent.typeFilters.some((filter) => filter.extensions.some((extension) => metadata.toLowerCase().includes(extension)));
}

function assetMatchesHardFilters(asset: IngestedAsset, intent: SearchIntent): boolean {
  if (intent.typeFilters.length > 0 && !assetMatchesType(asset, intent.typeFilters)) return false;
  if (intent.dateRange && !assetMatchesDateRange(asset, intent.dateRange)) return false;
  return true;
}

function assetMatchesType(asset: IngestedAsset, filters: FileTypeFilter[]): boolean {
  const sourceExt = normalizeExtension(asset.sourceExt || path.extname(asset.sourcePath));
  return filters.some((filter) => {
    if (filter.extensions.some((extension) => normalizeExtension(extension) === sourceExt)) return true;
    return filter.kinds.includes(asset.kind);
  });
}

function assetMatchesDateRange(asset: IngestedAsset, range: DateRange): boolean {
  const timeMs = Number.isFinite(asset.mtimeMs) ? asset.mtimeMs : Date.parse(asset.convertedAt);
  return Number.isFinite(timeMs) && timeMs >= range.startMs && timeMs < range.endMs;
}

function resultMatchesAnyTerm(item: SearchResultItem, intent: SearchIntent): boolean {
  const metadata = [
    item.title,
    item.displayPath,
    item.snippet,
    item.markdownPath,
    item.source?.title,
    item.source?.relativePath,
    item.source?.sourcePath,
    JSON.stringify(item.raw)
  ].filter(Boolean).join(" ");
  return intent.terms.some((term) => matchContains(metadata, term));
}

async function readQmdStatus(store: QmdStore): Promise<{ hasVectorIndex: boolean }> {
  if (!store.getStatus) return { hasVectorIndex: false };
  try {
    const status = (await store.getStatus()) as { hasVectorIndex?: unknown };
    return { hasVectorIndex: status.hasVectorIndex === true };
  } catch {
    return { hasVectorIndex: false };
  }
}

async function createQmdStore(): Promise<QmdStore> {
  const qmd = (await import("@tobilu/qmd")) as {
    createStore: (options: unknown) => Promise<QmdStore>;
  };

  await fs.mkdir(config.markdownDir, { recursive: true });
  await fs.mkdir(path.dirname(config.qmdDbPath), { recursive: true });

  return qmd.createStore({
    dbPath: config.qmdDbPath,
    config: {
      collections: {
        [config.qmdCollection]: {
          path: config.markdownDir,
          pattern: "**/*.md",
          ignore: ["**/.DS_Store"]
        }
      }
    }
  });
}

function normalizeResult(result: unknown, assets: IngestedAsset[]): SearchResultItem {
  const record = asRecord(result);
  const markdownPath = firstString(
    record.markdownPath,
    record.filepath,
    record.filePath,
    record.path,
    record.displayPath,
    asRecord(record.document).path,
    asRecord(record.doc).path
  );
  const id = inferAssetId(markdownPath, record, assets);
  const source = id ? assets.find((asset) => asset.id === id) : undefined;

  return {
    id,
    title: firstString(record.title, asRecord(record.document).title, source?.title, markdownPath, "Untitled") ?? "Untitled",
    score: typeof record.score === "number" ? record.score : 0,
    snippet: compactSnippet(firstString(record.snippet, record.text, record.content, record.body)),
    displayPath: firstString(source?.relativePath, record.displayPath, record.path, source?.sourcePath),
    markdownPath: source?.markdownPath ?? markdownPath,
    source,
    raw: compactRaw(result)
  };
}

async function searchFastHybrid(
  store: QmdStore,
  query: string,
  options: { limit: number; minScore?: number },
  assets: IngestedAsset[],
  intent?: SearchIntent
): Promise<SearchResultItem[]> {
  const searchLimit = Math.min(Math.max(options.limit * 2, options.limit), 50);
  const [lexRaw, vectorRaw] = await Promise.all([
    store.searchLex(query, { limit: searchLimit, minScore: options.minScore, collection: config.qmdCollection }),
    store.searchVector(query, { limit: searchLimit, minScore: options.minScore, collection: config.qmdCollection })
  ]);
  const lexItems = lexRaw.map((result) => normalizeResult(result, assets));
  const vectorItems = vectorRaw.map((result) => normalizeResult(result, assets));
  const merged = mergeRankedResults([lexItems, vectorItems], options.limit);
  return intent ? filterResultsByIntent(merged, intent) : merged;
}

function mergeIntentResults(
  intent: SearchIntent,
  catalogResults: SearchResultItem[],
  qmdResults: SearchResultItem[],
  limit: number
): SearchResultItem[] {
  const lists = intent.visualContent ? [qmdResults, catalogResults] : [catalogResults, qmdResults];
  return mergeRankedResults(lists, limit);
}

function mergeRankedResults(lists: SearchResultItem[][], limit: number): SearchResultItem[] {
  const merged = new Map<string, SearchResultItem & { rankScore: number }>();
  const rankK = 60;

  for (const list of lists) {
    list.forEach((item, index) => {
      const key = item.id ?? item.markdownPath ?? item.displayPath ?? item.title;
      const rankScore = 1 / (rankK + index + 1);
      const existing = merged.get(key);
      if (existing) {
        existing.rankScore += rankScore;
        existing.score = Math.max(existing.score, item.score);
        if (!existing.snippet && item.snippet) existing.snippet = item.snippet;
        return;
      }
      merged.set(key, { ...item, rankScore });
    });
  }

  return Array.from(merged.values())
    .sort((a, b) => b.rankScore - a.rankScore || b.score - a.score)
    .slice(0, limit)
    .map(({ rankScore: _rankScore, ...item }) => item);
}

function inferAssetId(markdownPath: string | undefined, record: Record<string, unknown>, assets: IngestedAsset[]): string | undefined {
  const embeddedId = firstSearchxId(record.body, record.content, record.text, record.snippet);
  if (embeddedId && assets.some((asset) => asset.id === embeddedId)) return embeddedId;

  const candidates = [
    markdownPath,
    firstString(record.displayPath),
    firstString(record.path),
    firstString(record.filepath),
    firstString(record.docid),
    firstString(record.docId)
  ];

  const normalizedCandidates = candidates
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
    .flatMap((candidate) => {
      const normalized = path.normalize(candidate);
      return path.isAbsolute(normalized) ? [normalized] : [normalized, path.normalize(path.join(config.markdownDir, normalized))];
    });

  for (const candidate of normalizedCandidates) {
    const byPath = assets.find((asset) => {
      const markdown = path.normalize(asset.markdownPath);
      const relativeMarkdown = path.normalize(path.relative(config.markdownDir, asset.markdownPath));
      const source = path.normalize(asset.sourcePath);
      const relativeSource = path.normalize(asset.relativePath);
      return candidate === markdown || candidate === relativeMarkdown || candidate === source || candidate === relativeSource;
    });
    if (byPath) return byPath.id;
  }

  return undefined;
}

function firstSearchxId(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const match = /searchx_id:\s*["']?([a-f0-9]{24})["']?/i.exec(value);
    if (match) return match[1];
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function compactRaw(value: unknown): unknown {
  const json = safeJson(value);
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const record = { ...(json as Record<string, unknown>) };
  for (const key of ["body", "content", "text", "snippet", "context"]) {
    if (typeof record[key] === "string") {
      const text = record[key] as string;
      record[key] = text.length > 500 ? `${text.slice(0, 500)}...` : text;
    }
  }
  return record;
}

function compactSnippet(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const body = value.includes("## Extracted content") ? value.split("## Extracted content").slice(1).join("## Extracted content") : value;
  const withoutFrontmatter = body.replace(/^---[\s\S]*?---\s*/, "");
  const normalized = withoutFrontmatter.replace(/\s+/g, " ").trim();
  return normalized.length > 360 ? `${normalized.slice(0, 357)}...` : normalized;
}

function parseDateRange(query: string, now: Date): DateRange | undefined {
  const explicitDate = parseExplicitDate(query);
  if (explicitDate) return dayRange(explicitDate, "指定日期");

  const recentDays = /(?:最近|近|过去)\s*(\d+)\s*天/.exec(query);
  if (recentDays) {
    const days = Math.max(1, Number.parseInt(recentDays[1], 10));
    return {
      label: `最近 ${days} 天`,
      startMs: addDays(startOfDay(now), -days).getTime(),
      endMs: addDays(startOfDay(now), 1).getTime()
    };
  }

  if (/最近一周|近一周|过去一周|过去7天/.test(query)) {
    return {
      label: "最近一周",
      startMs: addDays(startOfDay(now), -7).getTime(),
      endMs: addDays(startOfDay(now), 1).getTime()
    };
  }

  if (/最近一个月|近一个月|过去一个月|过去30天/.test(query)) {
    return {
      label: "最近一个月",
      startMs: addDays(startOfDay(now), -30).getTime(),
      endMs: addDays(startOfDay(now), 1).getTime()
    };
  }

  if (/今天|今日/.test(query)) return dayRange(now, "今天");
  if (/昨天|昨日/.test(query)) return dayRange(addDays(now, -1), "昨天");
  if (/前天/.test(query)) return dayRange(addDays(now, -2), "前天");

  const weekStart = startOfWeek(now);
  if (/上周|上一周/.test(query)) {
    return {
      label: "上周",
      startMs: addDays(weekStart, -7).getTime(),
      endMs: weekStart.getTime()
    };
  }
  if (/本周|这周|这个周/.test(query)) {
    return {
      label: "本周",
      startMs: weekStart.getTime(),
      endMs: addDays(startOfDay(now), 1).getTime()
    };
  }

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  if (/上个月|上一月/.test(query)) {
    return {
      label: "上个月",
      startMs: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
      endMs: monthStart.getTime()
    };
  }
  if (/本月|这个月/.test(query)) {
    return {
      label: "本月",
      startMs: monthStart.getTime(),
      endMs: addDays(startOfDay(now), 1).getTime()
    };
  }

  if (/去年/.test(query)) {
    return {
      label: "去年",
      startMs: new Date(now.getFullYear() - 1, 0, 1).getTime(),
      endMs: new Date(now.getFullYear(), 0, 1).getTime()
    };
  }
  if (/今年/.test(query)) {
    return {
      label: "今年",
      startMs: new Date(now.getFullYear(), 0, 1).getTime(),
      endMs: addDays(startOfDay(now), 1).getTime()
    };
  }

  return undefined;
}

function parseExplicitDate(query: string): Date | undefined {
  const dashed = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(query);
  if (dashed) return validDate(Number(dashed[1]), Number(dashed[2]), Number(dashed[3]));

  const compact = /\b(\d{4})(\d{2})(\d{2})\b/.exec(query);
  if (compact) return validDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));

  const chinese = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(query);
  if (chinese) return validDate(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]));

  return undefined;
}

function validDate(year: number, month: number, day: number): Date | undefined {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return date;
}

function dayRange(day: Date, label: string): DateRange {
  const start = startOfDay(day);
  return {
    label,
    startMs: start.getTime(),
    endMs: addDays(start, 1).getTime()
  };
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date): Date {
  const day = date.getDay();
  const mondayOffset = (day + 6) % 7;
  return addDays(startOfDay(date), -mondayOffset);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function normalizeQueryText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[，。、“”‘’；：？！…（）()[\]{}<>《》【】|\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.。]+$/g, "")
    .trim();
}

function extractTerms(value: string): string[] {
  const terms = new Set<string>();
  const normalized = normalizeQueryText(value);
  for (const part of normalized.split(/\s+/)) {
    const term = part.trim();
    if (term.length === 0 || isStopTerm(term)) continue;
    terms.add(term);
  }

  const compact = compactForMatch(normalized);
  if (compact.length >= 2 && !isStopTerm(compact)) terms.add(compact);
  if (/^\p{Script=Han}{4,}$/u.test(compact)) {
    for (let index = 0; index < compact.length - 1; index += 2) {
      const chunk = compact.slice(index, index + 2);
      if (!isStopTerm(chunk)) terms.add(chunk);
    }
  }
  return Array.from(terms);
}

function isStopTerm(value: string): boolean {
  const compact = compactForMatch(value);
  return /^(的|和|或|与|在|有|中|里|人|的人|人物|一张|一份|一个|一些|内容|关于|文件|资料|图片|图像|照片|截图|搜索|查询|查找|检索|包含|包括|帮我|帮忙|麻烦|找到|寻找|找)$/.test(compact);
}

function matchContains(value: string | undefined, query: string | undefined): boolean {
  if (!value || !query) return false;
  const normalizedValue = normalizeQueryText(value).toLowerCase();
  const normalizedQuery = normalizeQueryText(query).toLowerCase();
  if (normalizedQuery && normalizedValue.includes(normalizedQuery)) return true;
  return compactForMatch(value).includes(compactForMatch(query));
}

function compactForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function snippetAround(content: string, term: string): string | undefined {
  const lowerContent = content.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const index = lowerContent.indexOf(lowerTerm);
  if (index < 0) return compactSnippet(content);
  const start = Math.max(0, index - 140);
  const end = Math.min(content.length, index + lowerTerm.length + 260);
  return compactSnippet(content.slice(start, end));
}

function normalizeExtension(extension: string): string {
  if (!extension) return "";
  const lower = extension.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

function patternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = 0;
  return matches;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function searchDeep(store: QmdStore, options: DeepSearchOptions): Promise<unknown[]> {
  const worker = await resolveDeepSearchWorker();
  if (!worker) return store.search(options);
  return runDeepSearchWorker(worker, options);
}

async function resolveQmdIndexWorker(): Promise<QmdIndexWorkerEntrypoint | undefined> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const jsWorkerPath = path.join(dir, "qmdIndexWorker.js");
  if (await pathExists(jsWorkerPath)) {
    return { path: jsWorkerPath, execArgv: [] };
  }

  const tsWorkerPath = path.join(dir, "qmdIndexWorker.ts");
  if (await pathExists(tsWorkerPath)) {
    return { path: tsWorkerPath, execArgv: process.execArgv };
  }

  return undefined;
}

function runQmdIndexWorker(
  worker: QmdIndexWorkerEntrypoint,
  options: { embed?: boolean; force?: boolean },
  report?: (progress: QmdIndexProgress) => void
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const encoded = Buffer.from(JSON.stringify(options), "utf8").toString("base64url");
    const child = fork(worker.path, [encoded], {
      cwd: config.cwd,
      env: process.env,
      execArgv: worker.execArgv,
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    const timeoutMs = options.embed ? config.qmdEmbedTimeoutMs : config.qmdUpdateTimeoutMs;
    const timeout = setTimeout(() => {
      killProcessTree(child);
      finish(() => reject(new Error(`QMD ${options.embed ? "embed" : "update"} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("message", (message) => {
      const parsed = message as QmdIndexWorkerMessage;
      if (parsed.type === "progress") {
        report?.({ phase: parsed.phase, message: parsed.message });
      } else if (parsed.type === "result") {
        finish(() => resolve(parsed.result));
      } else if (parsed.type === "error") {
        finish(() => reject(new Error(parsed.error)));
      }
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => {
      if (settled) return;
      finish(() => reject(new Error(stderr.trim() || `QMD index worker exited with code ${code ?? "null"} signal ${signal ?? "null"}`)));
    });
  });
}

async function resolveDeepSearchWorker(): Promise<DeepSearchWorkerEntrypoint | undefined> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const jsWorkerPath = path.join(dir, "deepSearchWorker.js");
  if (await pathExists(jsWorkerPath)) {
    return { path: jsWorkerPath, execArgv: [] };
  }

  const tsWorkerPath = path.join(dir, "deepSearchWorker.ts");
  if (await pathExists(tsWorkerPath)) {
    return { path: tsWorkerPath, execArgv: process.execArgv };
  }

  return undefined;
}

function runDeepSearchWorker(worker: DeepSearchWorkerEntrypoint, options: DeepSearchOptions): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const encoded = Buffer.from(JSON.stringify(options), "utf8").toString("base64url");
    const child = fork(worker.path, [encoded], {
      cwd: config.cwd,
      env: process.env,
      execArgv: worker.execArgv,
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    const timeoutMs = deepSearchTimeoutMs();
    const timeout = setTimeout(() => {
      killProcessTree(child);
      finish(() => reject(new Error(`deep search timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("message", (message) => {
      const parsed = message as DeepSearchWorkerMessage;
      if (parsed.type === "result") {
        finish(() => resolve(parsed.results));
      } else if (parsed.type === "error") {
        finish(() => reject(new Error(parsed.error)));
      }
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => {
      if (settled) return;
      finish(() => reject(new Error(stderr.trim() || `deep search worker exited with code ${code ?? "null"} signal ${signal ?? "null"}`)));
    });
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function deepCandidateLimit(limit: number): number {
  const maxCandidates = Number.isFinite(config.deepSearchCandidateLimit) ? Math.max(1, config.deepSearchCandidateLimit) : 16;
  return Math.max(1, Math.min(Math.max(limit * 2, 8), maxCandidates));
}

function deepSearchTimeoutMs(): number {
  return Number.isFinite(config.deepSearchTimeoutMs) && config.deepSearchTimeoutMs > 0 ? config.deepSearchTimeoutMs : 30000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
