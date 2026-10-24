import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("protects trusted validation and delivery inputs without requiring ownership for ordinary files", () => {
  const text = readFileSync(fileURLToPath(new URL("../../../.github/CODEOWNERS", import.meta.url)), "utf8");
  const entries = text.split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#"));
  const scopes = ["/.github/", "/.github/CODEOWNERS", "/config/", "/schema/", "/scripts/",
    "/packages/core/", "/packages/github/", "/packages/runtime/", "/packages/runner/",
    "/package.json", "/package-lock.json", "/mise.toml", "/mise.lock", "/.mise/locks/"];
  expect(entries.map(line => line.trim().split(/\s+/))).toEqual(scopes.map(scope => [scope, "@axiomoth"]));
  expect(new Set(entries).size).toBe(entries.length);
});
