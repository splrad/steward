import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analysisInputDigest, managedBodyOutsideIssueLinksDigest, openIssueSetDigest, renderIssueLinksBlock, upsertIssueLinksBlock } from "../../core/src/issues.js";
import { extractIssueCopilotContent, parsePrIssueLinkArgs, runPrIssueLink, verifyIssueLinkConvergence } from "../src/pr-issue-link.js";

const repositoryId = 1296724484;
const policySha = "a".repeat(40);
const baseSha = "b".repeat(40);
const headSha = "c".repeat(40);
let privateKey = "";

beforeAll(() => {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } }).privateKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ["APP_ID", "INSTALLATION_ID", "STEWARD_APP_PRIVATE_KEY", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "ISSUE_LINK_LIST_ONLY", "ISSUE_LINK_PREPARE_ONLY", "ISSUE_PREPARED_FACTS_PATH", "ISSUE_COPILOT_PROMPT_PATH", "ISSUE_COPILOT_OUTPUT_PATH", "COPILOT_STEP_OUTCOME", "RUNTIME_URL"]) delete process.env[name];
});

async function withRunnerEnvironment<T>(operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "steward-issue-link-test-"));
  process.env.APP_ID = "4243096";
  process.env.INSTALLATION_ID = "145952003";
  process.env.STEWARD_APP_PRIVATE_KEY = privateKey;
  process.env.GITHUB_OUTPUT = join(directory, "output.txt");
  process.env.GITHUB_STEP_SUMMARY = join(directory, "summary.txt");
  await writeFile(process.env.GITHUB_OUTPUT, "");
  await writeFile(process.env.GITHUB_STEP_SUMMARY, "");
  try { return await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function invocation(overrides: Record<string, string> = {}): Record<string, string> {
  return { "delivery-id": "delivery-1", "repository-id": String(repositoryId), "pull-request-number": "42", "scan-all": "false", "invalidate-only": "false", "policy-sha": policySha, ...overrides };
}

function repository(): any {
  return { id: repositoryId, full_name: "splrad/steward", private: false, default_branch: "main" };
}

function pull(body = "", userId = 44151430, baseRef = "main"): any {
  return { number: 42, state: "open", body, user: { id: userId }, head: { sha: headSha, repo: { id: repositoryId } }, base: { sha: baseSha, ref: baseRef, repo: { id: repositoryId } } };
}

describe("拉取请求议题关联运行器", () => {
  it("严格区分单拉取请求与仓库扫描参数", () => {
    expect(parsePrIssueLinkArgs({ "delivery-id": "delivery-1", "repository-id": String(repositoryId), "pull-request-number": "42", "scan-all": "false", "invalidate-only": "false", "policy-sha": policySha }))
      .toEqual({ deliveryId: "delivery-1", repositoryId, pullRequestNumber: 42, scanAll: false, invalidateOnly: false, policySha });
    expect(parsePrIssueLinkArgs({ "delivery-id": "delivery-2", "repository-id": String(repositoryId), "scan-all": "true", "invalidate-only": "true", "policy-sha": policySha }))
      .toEqual({ deliveryId: "delivery-2", repositoryId, scanAll: true, invalidateOnly: true, policySha });
    expect(() => parsePrIssueLinkArgs({ "delivery-id": "delivery-3", "repository-id": String(repositoryId), "scan-all": "false", "invalidate-only": "false", "policy-sha": policySha })).toThrow("不一致");
    expect(() => parsePrIssueLinkArgs({ "delivery-id": "delivery-4", "repository-id": String(repositoryId), "pull-request-number": "42", "scan-all": "true", "invalidate-only": "false", "policy-sha": policySha })).toThrow("不一致");
  });

  it("只接受无工具、无子代理且以唯一成功结果结束的JSONL", () => {
    const content = JSON.stringify({ issueDecisions: [] });
    const message = JSON.stringify({ type: "assistant.message", data: { content, toolRequests: [] } });
    const result = JSON.stringify({ type: "result", exitCode: 0 });
    expect(extractIssueCopilotContent(`${message}\n${result}\n`)).toBe(content);
    expect(() => extractIssueCopilotContent(`${message}\n${JSON.stringify({ type: "tool.execution_start" })}\n${result}\n`)).toThrow("子代理或工具");
    expect(() => extractIssueCopilotContent(`${JSON.stringify({ type: "assistant.message", agentId: "child", data: { content, toolRequests: [] } })}\n${result}\n`)).toThrow("子代理或工具");
    expect(() => extractIssueCopilotContent(`${message}\n${result}\n${result}\n`)).toThrow("结果无效");
  });

  it("保留人工关联，只要求自动关联等于期望集合扣除人工集合", () => {
    const desired = [{ repositoryId, number: 1 }, { repositoryId, number: 2 }];
    expect(verifyIssueLinkConvergence(desired, {
      all: [{ repositoryId, number: 1 }, { repositoryId, number: 2 }, { repositoryId, number: 99 }],
      manual: [{ repositoryId, number: 2 }, { repositoryId, number: 99 }],
      automatic: [{ repositoryId, number: 1 }],
    }, repositoryId)).toEqual({ converged: true, expectedAutomatic: [{ repositoryId, number: 1 }] });
    expect(verifyIssueLinkConvergence(desired, {
      all: [{ repositoryId, number: 1 }, { repositoryId, number: 2 }],
      manual: [{ repositoryId, number: 2 }],
      automatic: [{ repositoryId, number: 1 }, { repositoryId, number: 3 }],
    }, repositoryId).converged).toBe(false);
  });

  it("仓库扫描完整列出所有开放拉取请求且只写入矩阵输出", async () => {
    await withRunnerEnvironment(async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.includes("/repos/splrad/steward/pulls?state=open")) return new Response(JSON.stringify([{ number: 9 }, { number: 3 }]), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_LIST_ONLY = "true";
      await runPrIssueLink(invocation({ "scan-all": "true", "pull-request-number": undefined as unknown as string }));
      const output = await readFile(process.env.GITHUB_OUTPUT!, "utf8");
      expect(output).toContain('matrix=[{"pullRequestNumber":3},{"pullRequestNumber":9}]');
      expect(output).toContain("count=2");
      expect(calls.filter(call => ["PATCH", "PUT", "DELETE"].includes(call.method))).toEqual([]);
      expect(calls.find(call => call.url.includes("/access_tokens"))?.body.permissions).toEqual({ contents: "read", pull_requests: "write", issues: "read", checks: "write", metadata: "read" });
    });
  });

  it("非受管默认分支拉取请求只发布 not-applicable 检查", async () => {
    await withRunnerEnvironment(async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull()), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await runPrIssueLink(invocation());
      const check = calls.find(call => call.method === "POST" && call.url.endsWith("/check-runs"));
      expect(check?.body).toEqual(expect.objectContaining({ name: "PR Issue Link Gate", head_sha: headSha, status: "completed", conclusion: "success" }));
      expect(check?.body.output.title).toBe("议题关联不适用");
      expect(calls.some(call => call.url.includes("workers.dev") || (call.method === "PATCH" && call.url.endsWith("/pulls/42")))).toBe(false);
    });
  });

  it("受管拉取请求离开默认分支后只清理议题块并确认自动关系为空", async () => {
    await withRunnerEnvironment(async () => {
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n## 发布与迁移\n\n无\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370, "release")), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370, "release")), { status: 200 });
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await runPrIssueLink(invocation());
      expect(currentBody).toBe(outer);
      expect(calls.filter(call => call.url.endsWith("/graphql"))).toHaveLength(3);
      expect(calls.some(call => call.url.includes("workers.dev"))).toBe(false);
    });
  });

  it("新鲜度复核失败后清理旧块，并完成已经开始的检查", async () => {
    await withRunnerEnvironment(async (directory) => {
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const oldBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, oldBlock);
      const fullDiffDigest = "e".repeat(64);
      const openSetDigest = openIssueSetDigest(repositoryId, []);
      const unmanagedBodyDigest = managedBodyOutsideIssueLinksDigest(currentBody);
      const prepared = {
        schemaVersion: 1, repositoryId, repositoryFullName: "splrad/steward", pullRequestNumber: 42,
        baseSha, headSha, generation: 2, policySha, fullDiffDigest, changedFiles: [], candidateDigests: [], candidates: [],
        openSetDigest, unmanagedBodyDigest,
        analysisInputDigest: analysisInputDigest({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, policySha, fullDiffDigest, candidateDigests: [], openSetDigest, unmanagedBodyDigest }),
      };
      process.env.ISSUE_PREPARED_FACTS_PATH = join(directory, "prepared.json");
      process.env.RUNTIME_URL = "https://runtime.test";
      process.env.COPILOT_STEP_OUTCOME = "failure";
      await writeFile(process.env.ISSUE_PREPARED_FACTS_PATH, JSON.stringify(prepared));
      let snapshotReads = 0;
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: baseSha } }), { status: 200 });
        if (value.endsWith(`/internal/issue-snapshots/${repositoryId}`)) {
          snapshotReads++;
          return snapshotReads === 1
            ? new Response(JSON.stringify({ repositoryId, generation: 2, syncState: "ready", openSetDigest, snapshots: [] }), { status: 200 })
            : new Response("unavailable", { status: 503 });
        }
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha }] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      await runPrIssueLink(invocation());
      expect(currentBody).toBe(outer);
      const check = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(check?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "success" }));
      expect(check?.body.output.summary).toContain("freshness-failed-cleaned");
    });
  });

  it("收敛前置事实读取失败时仍完成已经开始的检查", async () => {
    await withRunnerEnvironment(async (directory) => {
      const fullDiffDigest = "e".repeat(64);
      const openSetDigest = openIssueSetDigest(repositoryId, []);
      const unmanagedBodyDigest = managedBodyOutsideIssueLinksDigest("");
      const prepared = {
        schemaVersion: 1, repositoryId, repositoryFullName: "splrad/steward", pullRequestNumber: 42,
        baseSha, headSha, generation: 2, policySha, fullDiffDigest, changedFiles: [], candidateDigests: [], candidates: [],
        openSetDigest, unmanagedBodyDigest,
        analysisInputDigest: analysisInputDigest({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, policySha, fullDiffDigest, candidateDigests: [], openSetDigest, unmanagedBodyDigest }),
      };
      process.env.ISSUE_PREPARED_FACTS_PATH = join(directory, "prepared.json");
      process.env.RUNTIME_URL = "https://runtime.test";
      await writeFile(process.env.ISSUE_PREPARED_FACTS_PATH, JSON.stringify(prepared));
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response("temporarily unavailable", { status: 503 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha }] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      await expect(runPrIssueLink(invocation())).rejects.toThrow("503");
      const check = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(check?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "failure" }));
      expect(check?.body.output.summary).toContain("prerequisite-failed-unclean");
    });
  });

  it("事实准备失败时，在确认清空后以 safe-empty 成功结束", async () => {
    await withRunnerEnvironment(async (directory) => {
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n## 发布与迁移\n\n无\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      let checkExists = false;
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 });
        if (value.endsWith("/internal/issue-snapshots/1296724484")) return new Response("unavailable", { status: 503 });
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: checkExists ? [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha }] : [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) { checkExists = true; return new Response(JSON.stringify({ id: 1 }), { status: 201 }); }
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      process.env.RUNTIME_URL = "https://runtime.test";
      process.env.ISSUE_PREPARED_FACTS_PATH = join(directory, "prepared.json");
      process.env.ISSUE_COPILOT_PROMPT_PATH = join(directory, "prompt.txt");
      await runPrIssueLink(invocation());
      expect(currentBody).toBe(outer);
      const update = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(update?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "success" }));
      expect(update?.body.output.title).toBe("议题关联已安全跳过");
      expect(await readFile(process.env.GITHUB_OUTPUT!, "utf8")).toContain("copilot-required=false");
    });
  });
});
