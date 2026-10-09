import assert from "node:assert/strict";
import { test } from "vitest";

function uniquePaths(paths: readonly string[]) {
  return [...new Set(paths)].sort();
}

test("uniquePaths returns sorted paths without changing input", () => {
  const input = ["b.ts", "a.ts", "b.ts"];
  assert.deepEqual(uniquePaths(input), ["a.ts", "b.ts"]);
  assert.deepEqual(input, ["b.ts", "a.ts", "b.ts"]);
});

test("uniquePaths handles an empty list", () => {
  assert.deepEqual(uniquePaths([]), []);
});

