import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { catalog } from "./catalog.js";
import type { IngestedAsset, SearchMode, SearchRequest, SearchResponse, SearchResultItem } from "./types.js";

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

let storePromise: Promise<QmdStore> | undefined;

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

export async function refreshQmdIndex(options: { embed?: boolean; force?: boolean } = {}): Promise<unknown> {
  await fs.mkdir(config.markdownDir, { recursive: true });
  const store = await getQmdStore();
  const update = await store.update({
    collections: [config.qmdCollection]
  });

  if (!options.embed) {
    return { update, embed: null };
  }

  const embed = await store.embed({
    force: options.force === true,
    chunkStrategy: config.qmdChunkStrategy
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

  if ((mode === "hybrid" || mode === "vector" || mode === "deep") && !status.hasVectorIndex) {
    if (mode === "vector" || mode === "deep") {
      throw Object.assign(new Error("还没有向量索引。请先在同步时勾选“同步后生成向量索引”。"), { statusCode: 400 });
    }
    mode = "lex";
    warning = "还没有生成 QMD 向量索引，本次已自动降级为关键词检索。勾选“同步后生成向量索引”后再用自然语言模式会更准。";
  }

  const assets = await catalog.list();
  let results: SearchResultItem[];
  try {
    if (mode === "lex") {
      const rawResults = await store.searchLex(query, { limit, minScore, collection: config.qmdCollection });
      results = rawResults.map((result) => normalizeResult(result, assets));
    } else if (mode === "vector") {
      const rawResults = await store.searchVector(query, { limit, minScore, collection: config.qmdCollection });
      results = rawResults.map((result) => normalizeResult(result, assets));
    } else if (mode === "hybrid") {
      results = await searchFastHybrid(store, query, { limit, minScore }, assets);
      warning = warning ?? "快速自然语言模式使用关键词 + 向量，不触发 QMD rerank/query-expansion 大模型。";
    } else {
      const rawResults = await store.search({
        query,
        limit,
        minScore,
        collection: config.qmdCollection,
        chunkStrategy: config.qmdChunkStrategy
      });
      results = rawResults.map((result) => normalizeResult(result, assets));
    }
  } catch (error) {
    if (mode === "deep") {
      try {
        results = await searchFastHybrid(store, query, { limit, minScore }, assets);
        mode = "hybrid";
        warning = `深度自然语言检索暂不可用，本次已降级为快速混合检索：${errorMessage(error)}`;
      } catch (fallbackError) {
        const rawResults = await store.searchLex(query, { limit, minScore, collection: config.qmdCollection });
        results = rawResults.map((result) => normalizeResult(result, assets));
        mode = "lex";
        warning = `深度自然语言检索暂不可用，快速混合检索也失败，本次已降级为关键词检索：${errorMessage(fallbackError)}`;
      }
    } else if (mode === "hybrid") {
      const rawResults = await store.searchLex(query, { limit, minScore, collection: config.qmdCollection });
      results = rawResults.map((result) => normalizeResult(result, assets));
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
  assets: IngestedAsset[]
): Promise<SearchResultItem[]> {
  const searchLimit = Math.min(Math.max(options.limit * 2, options.limit), 50);
  const [lexRaw, vectorRaw] = await Promise.all([
    store.searchLex(query, { limit: searchLimit, minScore: options.minScore, collection: config.qmdCollection }),
    store.searchVector(query, { limit: searchLimit, minScore: options.minScore, collection: config.qmdCollection })
  ]);
  const lexItems = lexRaw.map((result) => normalizeResult(result, assets));
  const vectorItems = vectorRaw.map((result) => normalizeResult(result, assets));
  return mergeRankedResults([lexItems, vectorItems], options.limit);
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

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
