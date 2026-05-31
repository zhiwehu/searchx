import assert from "node:assert/strict";
import test from "node:test";
import { parseSearchMode } from "../src/qmdService.js";

test("parseSearchMode accepts supported modes and defaults to hybrid", () => {
  assert.equal(parseSearchMode(undefined), "hybrid");
  assert.equal(parseSearchMode(""), "hybrid");
  assert.equal(parseSearchMode("lex"), "lex");
  assert.equal(parseSearchMode("vector"), "vector");
  assert.equal(parseSearchMode("hybrid"), "hybrid");
});

test("parseSearchMode rejects unsupported modes", () => {
  assert.throws(
    () => parseSearchMode("semantic"),
    /Invalid search mode/
  );
});
