import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { isPathInsideRoot } from "../src/static.js";

test("isPathInsideRoot rejects sibling paths with the same prefix", () => {
  const root = path.resolve("public");
  const sibling = path.resolve("public2", "index.html");
  const child = path.resolve("public", "index.html");

  assert.equal(isPathInsideRoot(root, child), true);
  assert.equal(isPathInsideRoot(root, sibling), false);
});
