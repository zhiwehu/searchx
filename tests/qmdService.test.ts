import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSearchQuery, parseSearchMode } from "../src/qmdService.js";

test("parseSearchMode accepts supported modes and defaults to hybrid", () => {
  assert.equal(parseSearchMode(undefined), "hybrid");
  assert.equal(parseSearchMode(""), "hybrid");
  assert.equal(parseSearchMode("lex"), "lex");
  assert.equal(parseSearchMode("vector"), "vector");
  assert.equal(parseSearchMode("hybrid"), "hybrid");
  assert.equal(parseSearchMode("deep"), "deep");
});

test("parseSearchMode rejects unsupported modes", () => {
  assert.throws(
    () => parseSearchMode("semantic"),
    /Invalid search mode/
  );
});

test("analyzeSearchQuery extracts Chinese time, type, and semantic terms", () => {
  const intent = analyzeSearchQuery("上周关于产品的PPT文件", new Date(2026, 5, 2, 12));

  assert.equal(intent.semanticQuery, "产品");
  assert.deepEqual(intent.terms, ["产品"]);
  assert.deepEqual(intent.typeFilters.map((filter) => filter.label), ["PPT"]);
  assert.equal(localDate(intent.dateRange?.startMs), "2026-05-25");
  assert.equal(localDate(intent.dateRange?.endMs), "2026-06-01");
});

test("analyzeSearchQuery keeps content keywords after removing file type words", () => {
  const intent = analyzeSearchQuery("内容有麦克风的pdf");

  assert.equal(intent.semanticQuery, "麦克风");
  assert.deepEqual(intent.terms, ["麦克风"]);
  assert.deepEqual(intent.typeFilters.map((filter) => filter.extensions), [[".pdf"]]);
});

test("analyzeSearchQuery preserves whiteboard as image search content", () => {
  const intent = analyzeSearchQuery("开会白板图片");

  assert.equal(intent.semanticQuery, "开会白板");
  assert.deepEqual(intent.terms, ["开会白板", "开会", "白板"]);
  assert.deepEqual(intent.typeFilters.map((filter) => filter.label), ["Image"]);
});

test("analyzeSearchQuery keeps filename stems searchable when a type suffix is present", () => {
  const intent = analyzeSearchQuery("slide8_output.pptx");

  assert.equal(intent.semanticQuery, "slide8_output");
  assert.deepEqual(intent.typeFilters.map((filter) => filter.label), ["PPT"]);
});

function localDate(ms: number | undefined): string {
  if (ms === undefined) {
    assert.fail("Expected timestamp to be defined.");
  }
  const date = new Date(ms);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
