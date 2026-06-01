import assert from "node:assert/strict";
import test from "node:test";
import { getRuntimeSettings } from "../src/settings.js";

const envKeys = [
  "SEARCHX_MARKITDOWN_PLUGINS",
  "SEARCHX_MARKITDOWN_USE_LLM",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "SEARCHX_LLM_MODEL",
  "SEARCHX_QMD_EMBED_ON_INGEST"
] as const;

test("runtime settings mask configured OpenAI API keys", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "secret-key";

  try {
    const settings = getRuntimeSettings();
    assert.equal(settings.openaiApiKey, "********");
    assert.equal(settings.openaiApiKeySet, true);
  } finally {
    if (original === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = original;
    }
  }
});

test("runtime settings enable MarkItDown plugins by default", () => {
  withCleanEnv(() => {
    const settings = getRuntimeSettings();
    assert.equal(settings.markitdownPlugins, true);
  });
});

test("runtime settings build QMD vector indexes on ingest by default", () => {
  withCleanEnv(() => {
    const settings = getRuntimeSettings();
    assert.equal(settings.qmdEmbedOnIngest, true);
  });
});

test("runtime settings auto-enable MarkItDown LLM when a provider and model are configured", () => {
  withCleanEnv(() => {
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.SEARCHX_LLM_MODEL = "local-vlm";

    const settings = getRuntimeSettings();
    assert.equal(settings.markitdownUseLlm, true);
  });
});

test("runtime settings allow MarkItDown LLM auto-detection to be disabled explicitly", () => {
  withCleanEnv(() => {
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.SEARCHX_LLM_MODEL = "local-vlm";
    process.env.SEARCHX_MARKITDOWN_USE_LLM = "0";

    const settings = getRuntimeSettings();
    assert.equal(settings.markitdownUseLlm, false);
  });
});

function withCleanEnv(callback: () => void): void {
  const original = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) {
    delete process.env[key];
  }

  try {
    callback();
  } finally {
    for (const key of envKeys) {
      const value = original.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
