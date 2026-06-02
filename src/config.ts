import path from "node:path";
import { loadDotEnv } from "./env.js";

loadDotEnv();

const falseValues = new Set(["0", "false", "FALSE", "no", "NO", "off", "OFF"]);
const cwd = process.cwd();
const dataDir = path.resolve(process.env.SEARCHX_DATA_DIR ?? path.join(cwd, ".searchx"));
const xdgCacheHome = path.resolve(process.env.XDG_CACHE_HOME ?? path.join(dataDir, "cache"));
process.env.XDG_CACHE_HOME = xdgCacheHome;

export const config = {
  cwd,
  host: process.env.SEARCHX_HOST ?? "127.0.0.1",
  port: Number.parseInt(process.env.SEARCHX_PORT ?? "7310", 10),
  dataDir,
  markdownDir: path.join(dataDir, "markdown"),
  qmdModelDir: path.join(xdgCacheHome, "qmd", "models"),
  catalogPath: path.join(dataDir, "catalog.json"),
  qmdDbPath: path.join(dataDir, "qmd.sqlite"),
  qmdCollection: process.env.SEARCHX_QMD_COLLECTION ?? "searchx",
  qmdEmbedOnIngest: !falseValues.has(process.env.SEARCHX_QMD_EMBED_ON_INGEST ?? ""),
  qmdChunkStrategy: process.env.SEARCHX_QMD_CHUNK_STRATEGY ?? "auto",
  pythonBin: process.env.SEARCHX_PYTHON ?? "python",
  converterScript: path.join(cwd, "python", "convert_markitdown.py"),
  converterTimeoutMs: Number.parseInt(process.env.SEARCHX_CONVERTER_TIMEOUT_MS ?? "120000", 10),
  deepSearchTimeoutMs: Number.parseInt(process.env.SEARCHX_DEEP_SEARCH_TIMEOUT_MS ?? "30000", 10),
  deepSearchCandidateLimit: Number.parseInt(process.env.SEARCHX_DEEP_SEARCH_CANDIDATE_LIMIT ?? "16", 10),
  allowRawFileAccess: process.env.SEARCHX_ALLOW_RAW_FILE_ACCESS === "1",
  maxJsonBodyBytes: 1_000_000
};
