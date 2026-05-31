import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { RuntimeSettings } from "./types.js";

const envPath = path.resolve(process.cwd(), ".env");

const managedKeys = [
  "SEARCHX_PYTHON",
  "SEARCHX_MARKITDOWN_PLUGINS",
  "SEARCHX_MARKITDOWN_ARCHIVES",
  "SEARCHX_MARKITDOWN_MEDIA",
  "SEARCHX_MARKITDOWN_USE_LLM",
  "SEARCHX_LLM_MODEL",
  "SEARCHX_LLM_PROMPT",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "SEARCHX_QMD_EMBED_ON_INGEST",
  "SEARCHX_QMD_CHUNK_STRATEGY",
  "QMD_EMBED_MODEL",
  "QMD_RERANK_MODEL",
  "QMD_GENERATE_MODEL",
  "QMD_FORCE_CPU",
  "QMD_LLAMA_GPU"
] as const;

type ManagedKey = (typeof managedKeys)[number];

export function getRuntimeSettings(): RuntimeSettings {
  return {
    pythonBin: process.env.SEARCHX_PYTHON ?? config.pythonBin,
    markitdownPlugins: process.env.SEARCHX_MARKITDOWN_PLUGINS === "1",
    markitdownArchives: !isFalse(process.env.SEARCHX_MARKITDOWN_ARCHIVES),
    markitdownMedia: !isFalse(process.env.SEARCHX_MARKITDOWN_MEDIA),
    markitdownUseLlm: process.env.SEARCHX_MARKITDOWN_USE_LLM === "1",
    llmModel: process.env.SEARCHX_LLM_MODEL ?? "",
    llmPrompt: process.env.SEARCHX_LLM_PROMPT ?? "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    qmdEmbedOnIngest: process.env.SEARCHX_QMD_EMBED_ON_INGEST === "1",
    qmdChunkStrategy: process.env.SEARCHX_QMD_CHUNK_STRATEGY ?? config.qmdChunkStrategy,
    qmdEmbedModel: process.env.QMD_EMBED_MODEL ?? "",
    qmdRerankModel: process.env.QMD_RERANK_MODEL ?? "",
    qmdGenerateModel: process.env.QMD_GENERATE_MODEL ?? "",
    qmdForceCpu: isTruthy(process.env.QMD_FORCE_CPU),
    qmdLlamaGpu: process.env.QMD_LLAMA_GPU ?? "auto"
  };
}

export async function updateRuntimeSettings(patch: Partial<RuntimeSettings>): Promise<RuntimeSettings> {
  const current = getRuntimeSettings();
  const next: RuntimeSettings = {
    ...current,
    ...patch
  };

  const envValues: Record<ManagedKey, string> = {
    SEARCHX_PYTHON: next.pythonBin,
    SEARCHX_MARKITDOWN_PLUGINS: next.markitdownPlugins ? "1" : "0",
    SEARCHX_MARKITDOWN_ARCHIVES: next.markitdownArchives ? "1" : "0",
    SEARCHX_MARKITDOWN_MEDIA: next.markitdownMedia ? "1" : "0",
    SEARCHX_MARKITDOWN_USE_LLM: next.markitdownUseLlm ? "1" : "0",
    SEARCHX_LLM_MODEL: next.llmModel,
    SEARCHX_LLM_PROMPT: next.llmPrompt,
    OPENAI_BASE_URL: next.openaiBaseUrl,
    OPENAI_API_KEY: next.openaiApiKey,
    SEARCHX_QMD_EMBED_ON_INGEST: next.qmdEmbedOnIngest ? "1" : "0",
    SEARCHX_QMD_CHUNK_STRATEGY: next.qmdChunkStrategy,
    QMD_EMBED_MODEL: next.qmdEmbedModel,
    QMD_RERANK_MODEL: next.qmdRerankModel,
    QMD_GENERATE_MODEL: next.qmdGenerateModel,
    QMD_FORCE_CPU: next.qmdForceCpu ? "1" : "0",
    QMD_LLAMA_GPU: next.qmdLlamaGpu
  };

  for (const [key, value] of Object.entries(envValues)) {
    if (value === "") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  config.pythonBin = next.pythonBin || "python";
  config.qmdEmbedOnIngest = next.qmdEmbedOnIngest;
  config.qmdChunkStrategy = next.qmdChunkStrategy || "auto";

  await writeEnv(envValues);
  return getRuntimeSettings();
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "TRUE";
}

function isFalse(value: string | undefined): boolean {
  return value === "0" || value === "false" || value === "FALSE" || value === "no" || value === "NO";
}

async function writeEnv(values: Record<ManagedKey, string>): Promise<void> {
  const existing = await readEnvEntries();
  for (const key of managedKeys) {
    if (values[key] === "") {
      existing.delete(key);
    } else {
      existing.set(key, values[key]);
    }
  }

  const lines = [
    "# SearchX local runtime settings",
    ...Array.from(existing.entries()).map(([key, value]) => `${key}=${quoteEnv(value)}`)
  ];
  await fs.writeFile(envPath, `${lines.join("\n")}\n`, "utf8");
}

async function readEnvEntries(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const raw = await fs.readFile(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      result.set(trimmed.slice(0, index).trim(), unquoteEnv(trimmed.slice(index + 1).trim()));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

function unquoteEnv(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}
