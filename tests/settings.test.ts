import assert from "node:assert/strict";
import test from "node:test";
import { getRuntimeSettings } from "../src/settings.js";

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
