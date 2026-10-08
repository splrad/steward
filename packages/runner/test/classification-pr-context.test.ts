import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as github from "../../github/src/index.js";
import { classificationCheckStateCodec, decodeClassificationCheckState, encodeClassificationCheckState, main } from "../src/index.js";

const repositoryId = 1296724484;
const headSha = "b".repeat(40);
const policySha = "c".repeat(40);
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "classification-pr-context-"));
  temporary.push(directory);
  await cp(resolve("config"), join(directory, "config"), { recursive: true });
  const registryPath = join(directory, "config/repositories.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.repositories[String(repositoryId)].classification.labelAssignmentMode = "observe";
  await writeFile(registryPath, JSON.stringify(registry));
  const semantics = JSON.parse(await readFile("config/labels/pr-semantics.json", "utf8"));
  const profile = JSON.parse(await readFile("config/profiles/classification/default.json", "utf8"));
  const codec = classificationCheckStateCodec(semantics, profile);
  for (const [name, value] of Object.entries({ STEWARD_CONFIG_DIRECTORY: join(directory, "config"),
    APP_ID: "4243096", INSTALLATION_ID: "1", STEWARD_APP_PRIVATE_KEY: "test",
    GITHUB_STEP_SUMMARY: join(directory, "summary"), AI_CLASSIFICATION: "" })) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("未模拟的网络请求"); }));
  vi.spyOn(github, "createInstallationToken").mockResolvedValue("test");
  const prototype = github.GitHubClient.prototype;
  vi.spyOn(prototype, "getRepositoryById").mockResolvedValue({ id: repositoryId, full_name: "splrad/steward", default_branch: "main" });
  const pull = (number: number) => ({ number, state: "open", title: "Update tests", body: "", user: { login: "user", type: "User" },
    base: { sha: "a".repeat(40), ref: "main", repo: { id: repositoryId } },
    head: { sha: headSha, ref: `change-${number}`, repo: { id: number === 223 ? repositoryId : 999 } }, changed_files: 1, commits: 1 });
  vi.spyOn(prototype, "getPullRequest").mockImplementation(async (_owner, _repo, number) => pull(number));
  vi.spyOn(prototype, "listOpenPullRequests").mockResolvedValue([pull(223), pull(224)]);
  vi.spyOn(prototype, "listPullFiles").mockResolvedValue([{ filename: "tests/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+test" }]);
  vi.spyOn(prototype, "listPullCommits").mockResolvedValue([{ sha: headSha, commit: { message: "test: update fixtures" } }]);
  vi.spyOn(prototype, "listLabels").mockResolvedValue([]);
  vi.spyOn(prototype, "listRepositoryLabels").mockResolvedValue([]);
  const checks: any[] = [];
  const list = vi.spyOn(prototype, "listAllCheckRuns").mockImplementation(async (_owner, _repo, _head, filter) => {
    return structuredClone(filter === "all" ? checks : checks.slice(-1));
  });
  const create = vi.spyOn(prototype, "createCheckRun").mockImplementation(async (_owner, _repo, body) => {
    const check = { ...(body as object), id: checks.length + 10, app: { id: 4243096 } };
    checks.push(check); return structuredClone(check);
  });
  const update = vi.spyOn(prototype, "updateCheckRun").mockImplementation(async (_owner, _repo, id, body) => {
    const check = checks.find(value => value.id === id);
    if (!check) throw Error("未知检查");
    Object.assign(check, body); return structuredClone(check);
  });
  const makeCheck = (number: number, phase = "success") => ({ id: checks.length + 1,
    name: "PR Classification Gate", head_sha: headSha, app: { id: 4243096 },
    status: phase === "pending" ? "in_progress" : "completed", conclusion: phase === "pending" ? null : phase,
    external_id: phase === "success" ? encodeClassificationCheckState({ v: 4, repositoryId, pullRequestNumber: number, headSha, policySha,
      inputDigest: "a".repeat(64), policy: "a".repeat(64), decisionDigest: "a".repeat(64), mode: "active",
      primary: { id: "chore", source: "deterministic-fallback", reasonCode: "primary-fallback-selected" },
      ownedRiskFlags: [], riskFlags: [], facets: [], areas: [] }, codec) : `${repositoryId}:${number}:${headSha}:${phase}` });
  const run = (number = 224) => main(["pr-classification", "--repository-id", String(repositoryId), "--pull-request-number", String(number), "--event-head-sha", headSha, "--policy-sha", policySha]);
  return { checks, list, create, update, makeCheck, run, codec };
}

describe("分类检查按 PR 隔离", () => {
  it.each(["success", "pending", "failure"])("保留相同 SHA 上另一 PR 的 %s 检查", async phase => {
    const test = await fixture();
    const foreign = test.makeCheck(223, phase);
    test.checks.push(foreign);
    const original = structuredClone(foreign);
    await test.run();
    await test.run();
    expect(test.list.mock.calls.every(call => call[3] === "all")).toBe(true);
    expect(foreign).toEqual(original);
    expect(test.create).toHaveBeenCalledTimes(1);
    expect(test.update.mock.calls.every(call => call[2] !== foreign.id)).toBe(true);
    expect(decodeClassificationCheckState(test.checks[1].external_id, test.codec)).toMatchObject({ repositoryId, pullRequestNumber: 224, headSha });
  });

  it.each(["pending", "failure"])("重用当前 PR 的 %s 检查", async phase => {
    const test = await fixture();
    test.checks.push(test.makeCheck(224, phase));
    await test.run();
    expect(test.create).not.toHaveBeenCalled();
    expect(test.checks[0].conclusion).toBe("success");
  });

  it("全仓扫描为共享 SHA 的同仓和 fork PR 分别发布检查", async () => {
    const test = await fixture();
    test.checks.push(test.makeCheck(223));
    await main(["pr-classification", "--repository-id", String(repositoryId), "--scan-all", "true", "--delivery-id", "scan", "--policy-sha", policySha]);
    expect(test.checks).toHaveLength(2);
    expect(test.checks.map(check => decodeClassificationCheckState(check.external_id, test.codec)?.pullRequestNumber)).toEqual([223, 224]);
    expect(test.checks.every(check => check.conclusion === "success")).toBe(true);
  });

  it.each(["duplicate", "unknown", "corrupt"])("遇到 %s 归属证据时在写入前失败", async scenario => {
    const test = await fixture();
    const check = test.makeCheck(224);
    if (scenario === "unknown") check.external_id = "unbound";
    if (scenario === "corrupt") check.external_id = `${check.external_id.slice(0, -1)}!`;
    test.checks.push(check);
    if (scenario === "duplicate") test.checks.push({ ...check, id: 2 });
    await expect(test.run()).rejects.toThrow(scenario === "duplicate" ? "同名分类检查存在歧义" : "同名分类检查缺少可信归属");
    expect(test.create).not.toHaveBeenCalled();
    expect(test.update).not.toHaveBeenCalled();
  });
});
