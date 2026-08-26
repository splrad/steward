import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analysisInputDigest, issueSnapshotContentDigest, managedBodyOutsideIssueLinksDigest, normalizeIssueSnapshot, openIssueSetDigest, renderIssueLinksBlock, upsertIssueLinksBlock } from "../../core/src/issues.js";
import { buildIssueCopilotPrompt, extractIssueCopilotContent, gitInstallationTokenAuthorizationHeader, loadIssueCopilotResult, parseIssueCopilotResult, parsePrIssueLinkArgs, revalidationCandidates, runGit, runPrIssueLink, verifyIssueLinkConvergence, workflowRevalidationPlan } from "../src/pr-issue-link.js";

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
  for (const name of ["APP_ID", "INSTALLATION_ID", "STEWARD_APP_PRIVATE_KEY", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "ISSUE_LINK_LIST_ONLY", "ISSUE_LINK_PREPARE_ONLY", "ISSUE_LINK_ACK_ONLY", "ISSUE_PREPARED_FACTS_PATH", "ISSUE_COPILOT_PROMPT_PATH", "ISSUE_COPILOT_OUTPUT_PATH", "COPILOT_STEP_OUTCOME", "RUNTIME_URL", "SNAPSHOT_REVALIDATION_BUDGET", "SNAPSHOT_VALIDATED_GENERATION"]) delete process.env[name];
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

function bodyWriteRuntimeResponse(value: string, method: string, body: any, targetRepositoryId = repositoryId): Response | null {
  if (!value.includes(`/internal/issue-snapshots/${targetRepositoryId}/body-write-intents/42`)) return null;
  if (method === "POST" && value.endsWith("/prepare")) return new Response(JSON.stringify({ ...body, writeId: "intent", status: "prepared", deliveryProven: false, blockedReason: null }), { status: 200 });
  if (method === "POST" && value.endsWith("/patched")) return new Response(JSON.stringify({ writeId: "intent", status: "patched", deliveryProven: false, blockedReason: null }), { status: 200 });
  if (method === "POST" && value.endsWith("/block")) return new Response(JSON.stringify({ writeId: "intent", status: "blocked", deliveryProven: false, blockedReason: "pre-patch-drift" }), { status: 200 });
  if (method === "GET" && value.endsWith("/active")) return new Response("null", { status: 200 });
  if (method === "POST" && value.endsWith("/wait")) return new Response(JSON.stringify({ writeId: "intent", status: "confirmed", deliveryProven: true, blockedReason: null }), { status: 200 });
  return new Response("unexpected body write request", { status: 500 });
}

function invocation(overrides: Record<string, string> = {}): Record<string, string> {
  return { "delivery-id": "delivery-1", "repository-id": String(repositoryId), "pull-request-number": "42", "scan-all": "false", "invalidate-only": "false", "cleanup-unmanaged": "false", "policy-sha": policySha, ...overrides };
}

function repository(): any {
  return { id: repositoryId, full_name: "splrad/steward", private: false, default_branch: "main", has_issues: true, archived: false, disabled: false };
}

function pull(body = "", userId = 44151430, baseRef = "main", state = "open", mergedAt: string | null = null, targetRepositoryId = repositoryId): any {
  return { number: 42, state, merged_at: mergedAt, body, user: { id: userId }, head: { sha: headSha, repo: { id: targetRepositoryId } }, base: { sha: baseSha, ref: baseRef, repo: { id: targetRepositoryId } } };
}

function issueSnapshot(number: number): any {
  return normalizeIssueSnapshot({
    repository: { id: repositoryId, fullName: "splrad/steward" },
    issue: { number, title: `议题${number}`, body: "验收要求", state: "open", labels: [], milestone: null, stateReason: null, issueType: null, fieldValues: [], createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T01:00:00Z", commentsCount: 0 },
    comments: [], parent: null, subIssues: [], blockedBy: [], blocking: [],
  });
}

describe("拉取请求议题关联运行器", () => {
  it("严格区分单拉取请求与仓库扫描参数", () => {
    expect(parsePrIssueLinkArgs({ "delivery-id": "delivery-1", "repository-id": String(repositoryId), "pull-request-number": "42", "scan-all": "false", "invalidate-only": "false", "cleanup-unmanaged": "false", "policy-sha": policySha }))
      .toEqual({ deliveryId: "delivery-1", repositoryId, pullRequestNumber: 42, scanAll: false, invalidateOnly: false, cleanupUnmanaged: false, policySha });
    expect(parsePrIssueLinkArgs({ "delivery-id": "delivery-2", "repository-id": String(repositoryId), "scan-all": "true", "invalidate-only": "true", "cleanup-unmanaged": "false", "policy-sha": policySha }))
      .toEqual({ deliveryId: "delivery-2", repositoryId, scanAll: true, invalidateOnly: true, cleanupUnmanaged: false, policySha });
    expect(parsePrIssueLinkArgs({ "delivery-id": "delivery-2", "repository-id": String(repositoryId), "scan-all": "true", "invalidate-only": "false", "cleanup-unmanaged": "false", "reconciliation-generation": "7", "policy-sha": policySha }))
      .toEqual({ deliveryId: "delivery-2", repositoryId, scanAll: true, invalidateOnly: false, cleanupUnmanaged: false, reconciliationGeneration: 7, policySha });
    expect(() => parsePrIssueLinkArgs({ "delivery-id": "delivery-3", "repository-id": String(repositoryId), "scan-all": "false", "invalidate-only": "false", "cleanup-unmanaged": "false", "policy-sha": policySha })).toThrow("不一致");
    expect(() => parsePrIssueLinkArgs({ "delivery-id": "delivery-4", "repository-id": String(repositoryId), "pull-request-number": "42", "scan-all": "true", "invalidate-only": "false", "cleanup-unmanaged": "false", "policy-sha": policySha })).toThrow("不一致");
    expect(() => parsePrIssueLinkArgs({ "delivery-id": "delivery-5", "repository-id": String(repositoryId), "scan-all": "true", "invalidate-only": "true", "cleanup-unmanaged": "false", "reconciliation-generation": "7", "policy-sha": policySha })).toThrow("不能确认");
    expect(() => parsePrIssueLinkArgs({ "delivery-id": "delivery-6", "repository-id": String(repositoryId), "scan-all": "true", "invalidate-only": "true", "cleanup-unmanaged": "true", "policy-sha": policySha })).toThrow("未纳管仓库清理");
  });

  it("Git输出超限时保留调用方定义的大小错误", () => {
    expect(() => runGit(process.cwd(), ["--version"], process.env, 1, "完整差异超过1 MiB")).toThrow("完整差异超过1 MiB");
  });

  it("Git访问把安装令牌作为x-access-token密码传递", () => {
    const header = gitInstallationTokenAuthorizationHeader("installation-token");
    expect(header).toMatch(/^Authorization: Basic [A-Za-z0-9+/]+=*$/u);
    expect(Buffer.from(header.slice("Authorization: Basic ".length), "base64").toString("utf8"))
      .toBe("x-access-token:installation-token");
    expect(header).not.toContain("installation-token");
    expect(() => gitInstallationTokenAuthorizationHeader("installation-token\nextra-header: value")).toThrow("Git安装令牌无效");
  });

  it("仓库不具备议题能力时不创建失效检查", async () => {
    await withRunnerEnvironment(async () => {
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      const managedBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 1, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const value = String(url); const method = init.method ?? "GET"; const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify({ ...repository(), has_issues: false }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(managedBlock, 301115370, "main", "closed", null)), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{
          id: 99, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `v1:${repositoryId}:41:${headSha}`,
        }] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      await runPrIssueLink(invocation({ "invalidate-only": "true" }));
      expect(calls.some(call => call.method === "POST" && call.url.endsWith("/check-runs"))).toBe(false);
      expect(calls.some(call => call.method === "PATCH" && call.url.endsWith("/check-runs/99"))).toBe(false);
    });
  });

  it("只接受无工具、无子代理且以唯一成功结果结束的JSONL", () => {
    const content = JSON.stringify({ issueDecisions: [] });
    const message = JSON.stringify({ type: "assistant.message", data: { content, toolRequests: [] } });
    const result = JSON.stringify({ type: "result", exitCode: 0 });
    expect(extractIssueCopilotContent(`${message}\n${result}\n`)).toBe(content);
    expect(() => extractIssueCopilotContent(`${message}\n${JSON.stringify({ type: "tool.execution_start" })}\n${result}\n`)).toThrow("子代理或工具");
    expect(() => extractIssueCopilotContent(`${JSON.stringify({ type: "assistant.message", agentId: "child", data: { content, toolRequests: [] } })}\n${result}\n`)).toThrow("子代理或工具");
    expect(() => extractIssueCopilotContent(`${message}\n${result}\n${result}\n`)).toThrow("结果无效");
    const context = { targetRepositoryId: repositoryId, candidates: [], changedFiles: [] };
    expect(parseIssueCopilotResult(`${message}\n${result}\n`, context)).toEqual({ desired: [], diagnostic: "validated" });
    for (const output of [
      "not-jsonl",
      `${message}\n${JSON.stringify({ type: "tool.execution_start" })}\n${result}\n`,
      `${message}\n${result}\n${result}\n`,
      `${JSON.stringify({ type: "assistant.message", data: { content: "", toolRequests: [] } })}\n${result}\n`,
    ]) expect(parseIssueCopilotResult(output, context)).toEqual({ desired: [], diagnostic: "copilot-output-invalid" });
    const nonJson = JSON.stringify({ type: "assistant.message", data: { content: "not-json", toolRequests: [] } });
    expect(parseIssueCopilotResult(`${nonJson}\n${result}\n`, context)).toEqual({ desired: [], diagnostic: "business-json-invalid" });
    const wrongContract = JSON.stringify({ type: "assistant.message", data: { content: JSON.stringify({ secret: "must-not-leak" }), toolRequests: [] } });
    const rejectedEnvelope = parseIssueCopilotResult(`${wrongContract}\n${result}\n`, context);
    expect(rejectedEnvelope).toEqual({ desired: [], diagnostic: "decision-envelope-invalid" });
    expect(JSON.stringify(rejectedEnvelope)).not.toContain("must-not-leak");
    const wrongSelection = JSON.stringify({ type: "assistant.message", data: { content: JSON.stringify({ issueDecisions: [{
      repositoryId: repositoryId + 1, number: 7, decision: "related", confidence: "low",
      requirements: ["候选议题要求"], evidence: [], unresolved: [],
    }] }), toolRequests: [] } });
    expect(parseIssueCopilotResult(`${wrongSelection}\n${result}\n`, context)).toEqual({ desired: [], diagnostic: "decision-selection-invalid" });
  });

  it("在提示中给出与严格校验器一致且失败关闭的JSON合同", () => {
    const changedFile = "src/AutoCAD/AFR-ACAD2027/Properties/launchSettings.json";
    const candidate = {
      repositoryId,
      issueNumber: 154,
      state: "open" as const,
      contentDigest: "d".repeat(64),
      validators: [],
      snapshot: issueSnapshot(154),
    };
    const prompt = buildIssueCopilotPrompt({
      repositoryId,
      repositoryFullName: "splrad/LayerScape",
      pullRequestNumber: 155,
      baseSha,
      headSha,
      generation: 1,
      fullDiffDigest: "e".repeat(64),
      fullDiff: `diff --git a/${changedFile} b/${changedFile}`,
      changedFiles: [changedFile],
      candidates: [candidate],
    });
    expect(prompt).toContain("根对象、决策项和证据项都不得增加合同以外的键");
    expect(prompt).toContain("requirement是从0开始的整数");
    expect(prompt).toContain("每个值1至1000个字符且逐字来自changedFiles");
    expect(prompt).toContain('"confidence":"low"');
    expect(prompt).toContain(`"files":["${changedFile.replaceAll("\\", "\\\\")}"]`);
    expect(prompt).not.toContain('"decision":"resolves","confidence":"high"');
    const examplePrefix = "合法结构示例（仅示范字段和类型，decision为partial且confidence为low；不得照抄语义）：";
    const exampleLine = prompt.split("\n\n").find(line => line.startsWith(examplePrefix));
    expect(exampleLine).toBeDefined();
    const exampleMessage = JSON.stringify({ type: "assistant.message", data: { content: exampleLine!.slice(examplePrefix.length), toolRequests: [] } });
    const result = JSON.stringify({ type: "result", exitCode: 0 });
    expect(parseIssueCopilotResult(`${exampleMessage}\n${result}\n`, {
      targetRepositoryId: repositoryId,
      candidates: [{ repositoryId, number: 154, state: "open", contentDigest: candidate.contentDigest, unfetchedReferences: [] }],
      changedFiles: [changedFile],
    })).toEqual({ desired: [], diagnostic: "validated" });
  });

  it("区分Copilot无需运行、步骤失败和输出文件失败", async () => {
    const context = { targetRepositoryId: repositoryId, candidates: [], changedFiles: [] };
    expect(await loadIssueCopilotResult("skipped", undefined, context)).toEqual({ desired: [], diagnostic: "copilot-not-required" });
    expect(await loadIssueCopilotResult("failure", undefined, context)).toEqual({ desired: [], diagnostic: "step-failed" });
    expect(await loadIssueCopilotResult("success", undefined, context)).toEqual({ desired: [], diagnostic: "output-file-invalid" });
    await withRunnerEnvironment(async directory => {
      expect(await loadIssueCopilotResult("success", join(directory, "missing.jsonl"), context)).toEqual({ desired: [], diagnostic: "output-file-invalid" });
    });
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

  it("普通仓库扫描只枚举开放PR，不以完整历史分页为成功前提", async () => {
    await withRunnerEnvironment(async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.includes("/repos/splrad/steward/pulls?state=open")) return new Response(JSON.stringify([
          { ...pull("", 301115370), number: 9 },
          { ...pull("", 301115370), number: 3 },
        ]), { status: 200 });
        if (value.includes("/repos/splrad/steward/pulls?state=all")) return new Response("history-limit", { status: 422 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_LIST_ONLY = "true";
      await runPrIssueLink(invocation({ "scan-all": "true", "pull-request-number": undefined as unknown as string }));
      const output = await readFile(process.env.GITHUB_OUTPUT!, "utf8");
      expect(output).toContain('matrix=[{"pullRequestNumber":3},{"pullRequestNumber":9}]');
      expect(output).toContain("count=2");
      expect(output).toContain("revalidation-budget=1");
      expect(calls.filter(call => ["PATCH", "PUT", "DELETE"].includes(call.method))).toEqual([]);
      expect(calls.find(call => call.url.includes("/access_tokens"))?.body.permissions).toEqual({ contents: "read", pull_requests: "write", issues: "read", checks: "write", metadata: "read" });
    });
  });

  it("正式矩阵按实际validator数量分配预算，并在内联刷新后调度精确代次的全PR收敛", async () => {
    await withRunnerEnvironment(async () => {
      const initialSnapshot = issueSnapshot(7);
      const refreshedSnapshot = { ...initialSnapshot, issue: { ...initialSnapshot.issue, title: "更新后的议题7" } };
      const validator = { resource: "issue" as const, url: "https://api.github.com/repos/splrad/steward/issues/7", etag: '"old"', next: null, status: 200 as const };
      const refreshedValidator = { ...validator, etag: '"new"' };
      const initialState = {
        repositoryId, generation: 1, stateRevision: 1, syncState: "ready", openSetDigest: openIssueSetDigest(repositoryId, [7]),
        snapshots: [{ repositoryId, issueNumber: 7, state: "open", contentDigest: issueSnapshotContentDigest(initialSnapshot), validators: [validator], snapshot: initialSnapshot }],
        reconciliationGeneration: null, reconciliationStateRevision: null,
      };
      const refreshedState = {
        repositoryId, generation: 2, stateRevision: 2, syncState: "ready", openSetDigest: openIssueSetDigest(repositoryId, [7]),
        snapshots: [{ repositoryId, issueNumber: 7, state: "open", contentDigest: issueSnapshotContentDigest(refreshedSnapshot), validators: [refreshedValidator], snapshot: refreshedSnapshot }],
        reconciliationGeneration: 2, reconciliationStateRevision: 1,
      };
      let snapshotReads = 0;
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const value = String(url); const method = init.method ?? "GET"; const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.includes("/repos/splrad/steward/pulls?state=open")) return new Response(JSON.stringify([
          { ...pull("", 301115370), number: 3 }, { ...pull("", 301115370), number: 9 },
        ]), { status: 200 });
        if (value.endsWith(`/internal/issue-snapshots/${repositoryId}`)) {
          snapshotReads++;
          return new Response(JSON.stringify(snapshotReads === 1 ? initialState : refreshedState), { status: 200 });
        }
        if (value.includes("/repos/splrad/steward/issues?state=open")) return new Response(JSON.stringify([{ number: 7, repository_url: "https://api.github.com/repos/splrad/steward" }]), { status: 200, headers: { etag: '"open"' } });
        if (value === validator.url) return new Response(JSON.stringify({ number: 7 }), { status: 200, headers: { etag: '"new"' } });
        if (value.endsWith(`/internal/issue-snapshots/${repositoryId}/7/refresh`)) return new Response(JSON.stringify({ repositoryId, issueNumber: 7, changed: true, generation: 2 }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/actions/workflows/pr-issue-link.yml/dispatches")) return new Response(null, { status: 204 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_LIST_ONLY = "true";
      process.env.RUNTIME_URL = "https://runtime.test";
      await runPrIssueLink(invocation({ "scan-all": "true", "pull-request-number": undefined as unknown as string }));
      const output = await readFile(process.env.GITHUB_OUTPUT!, "utf8");
      expect(output).toContain("snapshot-generation=2");
      expect(output).toContain("revalidation-budget=1");
      const dispatch = calls.find(call => call.method === "POST" && call.url.endsWith("/actions/workflows/pr-issue-link.yml/dispatches"));
      expect(dispatch?.body).toEqual({ ref: "main", inputs: {
        deliveryId: "delivery-1", repositoryId: String(repositoryId), scanAll: "true", invalidateOnly: "false",
        cleanupUnmanaged: "false", reconciliationGeneration: "2", policySha,
      } });
      expect(calls.filter(call => call.url.includes("/access_tokens"))[1]?.body.permissions).toEqual({ actions: "write", metadata: "read" });
    });
  });

  it("未纳管清理矩阵只计入带受管议题块的Steward拉取请求", async () => {
    await withRunnerEnvironment(async () => {
      const managedBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 5, baseSha, headSha, generation: 1, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let requested = "";
      vi.stubGlobal("fetch", async (url: string) => {
        const value = String(url);
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify({ ...repository(), private: true }), { status: 200 });
        if (value.includes("/repos/splrad/steward/pulls?state=all")) {
          requested = value;
          return new Response(JSON.stringify([
            ...Array.from({ length: 257 }, (_, index) => ({ ...pull("", 44151430), number: 100 + index })),
            { ...pull(managedBlock, 301115370), number: 9 },
            { ...pull(managedBlock, 301115370, "main", "closed", null), number: 5 },
            { ...pull(managedBlock, 301115370, "main", "closed", "2026-08-23T00:00:00Z"), number: 6 },
            { ...pull(managedBlock, 44151430, "main", "closed", null), number: 7 },
            { ...pull("", 301115370, "main", "closed", null), number: 8 },
          ]), { status: 200 });
        }
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_LIST_ONLY = "true";
      await runPrIssueLink(invocation({ "scan-all": "true", "pull-request-number": undefined as unknown as string, "cleanup-unmanaged": "true" }));
      const output = await readFile(process.env.GITHUB_OUTPUT!, "utf8");
      expect(new URL(requested).searchParams.get("state")).toBe("all");
      expect(output).toContain('matrix=[{"pullRequestNumber":5},{"pullRequestNumber":9}]');
      expect(output).toContain("count=2");
    });
  });

  it("关闭议题能力后的清理矩阵纳入默认分支无议题块的开放 Steward PR", async () => {
    await withRunnerEnvironment(async () => {
      const managedBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 5, baseSha, headSha, generation: 1, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      vi.stubGlobal("fetch", async (url: string) => {
        const value = String(url);
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify({ ...repository(), has_issues: false }), { status: 200 });
        if (value.includes("/repos/splrad/steward/pulls?state=all")) return new Response(JSON.stringify([
          { ...pull("", 301115370), number: 3 },
          { ...pull("", 301115370, "release"), number: 4 },
          { ...pull(managedBlock, 301115370, "release"), number: 5 },
          { ...pull(managedBlock, 301115370, "main", "closed", null), number: 6 },
          { ...pull("", 301115370, "main", "closed", null), number: 7 },
          { ...pull(managedBlock, 44151430), number: 8 },
        ]), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_LIST_ONLY = "true";
      await runPrIssueLink(invocation({ "scan-all": "true", "pull-request-number": undefined as unknown as string, "cleanup-unmanaged": "true" }));
      const output = await readFile(process.env.GITHUB_OUTPUT!, "utf8");
      expect(output).toContain('matrix=[{"pullRequestNumber":3},{"pullRequestNumber":5},{"pullRequestNumber":6}]');
      expect(output).toContain("count=3");
    });
  });

  it("未纳管清理匹配项超过矩阵上限后不再请求下一页", async () => {
    await withRunnerEnvironment(async () => {
      const managedBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 5, baseSha, headSha, generation: 1, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      const requestedPages: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        const value = String(url);
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify({ ...repository(), private: true }), { status: 200 });
        if (value.includes("/repos/splrad/steward/pulls?state=all")) {
          requestedPages.push(value);
          const page = new URL(value).searchParams.get("page");
          const items = Array.from({ length: page === "3" ? 57 : 100 }, (_, index) => ({ ...pull(managedBlock, 301115370), number: (page === "2" ? 101 : page === "3" ? 201 : 1) + index }));
          return new Response(JSON.stringify(items), { status: 200, headers: { link: `<https://api.github.com/repos/splrad/steward/pulls?state=all&per_page=100&page=${page === null ? 2 : Number(page) + 1}>; rel="next"` } });
        }
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_LIST_ONLY = "true";
      await expect(runPrIssueLink(invocation({ "scan-all": "true", "pull-request-number": undefined as unknown as string, "cleanup-unmanaged": "true" }))).rejects.toThrow("待清理拉取请求超过矩阵上限");
      expect(requestedPages.map(value => new URL(value).searchParams.get("page"))).toEqual([null, "2", "3"]);
    });
  });

  it("只有正式收敛成功路径才按精确代次确认D1待处理记录", async () => {
    await withRunnerEnvironment(async () => {
      process.env.ISSUE_LINK_ACK_ONLY = "true";
      process.env.RUNTIME_URL = "https://runtime.test";
      let pending: number | null = 7;
      let pendingStateRevision: number | null = 4;
      const calls: Array<{ url: string; method: string; headers: Headers }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const value = String(url); const method = init.method ?? "GET"; const headers = new Headers(init.headers);
        calls.push({ url: value, method, headers });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith(`/internal/issue-snapshots/${repositoryId}/reconciliation`) && method === "POST") {
          expect(headers.get("x-steward-reconciliation-generation")).toBe("7");
          expect(headers.get("x-steward-reconciliation-state-revision")).toBe("4");
          pending = null;
          pendingStateRevision = null;
          return new Response(JSON.stringify({ repositoryId, generation: 7, stateRevision: 4, acknowledged: true }), { status: 200 });
        }
        if (value.endsWith(`/internal/issue-snapshots/${repositoryId}`)) return new Response(JSON.stringify({ repositoryId, reconciliationGeneration: pending, reconciliationStateRevision: pendingStateRevision }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      await runPrIssueLink(invocation({ "scan-all": "true", "pull-request-number": undefined as unknown as string, "reconciliation-generation": "7" }));
      expect(pending).toBeNull();
      expect(calls.filter(call => call.method === "POST" && call.url.endsWith("/reconciliation"))).toHaveLength(1);
      expect(await readFile(process.env.GITHUB_STEP_SUMMARY!, "utf8")).toContain("状态：acknowledged");
    });
  });

  it("非 Steward 默认分支拉取请求不创建议题检查", async () => {
    await withRunnerEnvironment(async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull()), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await runPrIssueLink(invocation());
      expect(calls.some(call => call.method === "POST" && call.url.endsWith("/check-runs"))).toBe(false);
      expect(calls.some(call => call.url.includes("workers.dev") || (call.method === "PATCH" && call.url.endsWith("/pulls/42")))).toBe(false);
    });
  });

  it("外部来源PR只读取目标仓库且不创建议题检查", async () => {
    await withRunnerEnvironment(async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42")) {
          const external = pull("", 44151430); external.head.repo.id = 987654321;
          return new Response(JSON.stringify(external), { status: 200 });
        }
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await runPrIssueLink(invocation());
      expect(calls.some(call => call.method === "POST" && call.url.endsWith("/check-runs"))).toBe(false);
      expect(calls.some(call => call.url.includes("workers.dev") || (call.method === "PATCH" && call.url.endsWith("/pulls/42")))).toBe(false);
      expect(calls.filter(call => call.url.includes("/access_tokens")).map(call => call.body.repository_ids)).toEqual([[repositoryId]]);
    });
  });

  it("仓库退出纳管后不读取快照并清理所有受管PR议题状态", async () => {
    await withRunnerEnvironment(async () => {
      process.env.RUNTIME_URL = "https://runtime.test";
      const targetRepositoryId = 1400000000;
      const targetRepository = { ...repository(), id: targetRepositoryId, full_name: "splrad/default-managed", private: true };
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const block = renderIssueLinksBlock({ repositoryId: targetRepositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 9, analysisInputDigest: "d".repeat(64) }, [{ repositoryId: targetRepositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body, targetRepositoryId); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${targetRepositoryId}`)) return new Response(JSON.stringify(targetRepository), { status: 200 });
        if (value.endsWith("/repos/splrad/default-managed/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370, "main", "open", null, targetRepositoryId)), { status: 200 }); }
        if (value.endsWith("/repos/splrad/default-managed/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370, "main", "open", null, targetRepositoryId)), { status: 200 });
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: targetRepositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `v1:${targetRepositoryId}:42:${headSha}` }] }), { status: 200 });
        if (value.endsWith("/repos/splrad/default-managed/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await runPrIssueLink(invocation({ "repository-id": String(targetRepositoryId), "cleanup-unmanaged": "true" }));
      expect(currentBody).toBe(outer);
      expect(calls.some(call => /\/internal\/issue-snapshots\/\d+$/u.test(call.url))).toBe(false);
      expect(calls.some(call => call.url.includes("/body-write-intents/"))).toBe(true);
      const check = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(check?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "success" }));
      expect(check?.body.output.summary).toContain("repository-not-managed");
    });
  });

  it("受管仓库关闭 Issues 后清理议题块并完成既有门禁", async () => {
    await withRunnerEnvironment(async () => {
      process.env.RUNTIME_URL = "https://runtime.test";
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 9, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify({ ...repository(), has_issues: false }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 });
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `v1:${repositoryId}:42:${headSha}` }] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await runPrIssueLink(invocation({ "cleanup-unmanaged": "true" }));
      expect(currentBody).toBe(outer);
      const check = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(check?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "success" }));
      expect(check?.body.output.summary).toContain("repository-issues-disabled");
    });
  });

  it("仓库退出纳管后也清理已关闭未合并PR的受管议题块", async () => {
    await withRunnerEnvironment(async () => {
      process.env.RUNTIME_URL = "https://runtime.test";
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 9, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify({ ...repository(), private: true }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370, "main", "closed", null)), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370, "main", "closed", null)), { status: 200 });
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await runPrIssueLink(invocation({ "cleanup-unmanaged": "true" }));
      expect(currentBody).toBe(outer);
      expect(calls.some(call => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(true);
      expect(calls.some(call => call.url.includes("/body-write-intents/"))).toBe(true);
    });
  });

  it("受管PR关闭未合并后只清理议题块", async () => {
    await withRunnerEnvironment(async () => {
      process.env.RUNTIME_URL = "https://runtime.test";
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 9, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370, "main", "closed", null)), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370, "main", "closed", null)), { status: 200 });
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await runPrIssueLink(invocation());
      expect(currentBody).toBe(outer);
      expect(calls.some(call => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(true);
      expect(calls.some(call => call.method === "POST" && call.url.endsWith("/check-runs"))).toBe(false);
    });
  });

  it("受管拉取请求离开默认分支后清理议题块并把失效门禁收敛为不适用", async () => {
    await withRunnerEnvironment(async () => {
      process.env.RUNTIME_URL = "https://runtime.test";
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n## 发布与迁移\n\n无\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370, "release")), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370, "release")), { status: 200 });
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `v1:${repositoryId}:42:${headSha}` }] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await runPrIssueLink(invocation());
      expect(currentBody).toBe(outer);
      expect(calls.filter(call => call.url.endsWith("/graphql"))).toHaveLength(3);
      expect(calls.some(call => call.url.includes("/body-write-intents/"))).toBe(true);
      const check = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(check?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "success" }));
      expect(check?.body.output.summary).toContain("not-applicable");
      expect(calls.some(call => call.method === "POST" && call.url.endsWith("/check-runs"))).toBe(false);
    });
  });

  it("正文清理在写前观察到并发人工编辑时阻断且不覆盖", async () => {
    await withRunnerEnvironment(async () => {
      process.env.RUNTIME_URL = "https://runtime.test";
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const humanOuter = outer.replace("正文", "人工补充后的正文");
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      let pullReads = 0;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370, "release")), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) {
          pullReads++;
          if (pullReads === 3) currentBody = upsertIssueLinksBlock(humanOuter, block);
          return new Response(JSON.stringify(pull(currentBody, 301115370, "release")), { status: 200 });
        }
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await expect(runPrIssueLink(invocation())).rejects.toThrow("写入前发生漂移");
      expect(currentBody).toBe(upsertIssueLinksBlock(humanOuter, block));
      expect(pullReads).toBe(3);
    });
  });

  it("正文清理在写入前观察到PR已经合并时停止删除", async () => {
    await withRunnerEnvironment(async () => {
      process.env.RUNTIME_URL = "https://runtime.test";
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      const currentBody = upsertIssueLinksBlock(outer, block);
      let pullReads = 0;
      const calls: Array<{ url: string; method: string }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42")) {
          pullReads++;
          return new Response(JSON.stringify(pull(currentBody, 301115370, "release", pullReads >= 3 ? "closed" : "open", pullReads >= 3 ? "2026-08-24T00:00:00Z" : null)), { status: 200 });
        }
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await expect(runPrIssueLink(invocation())).rejects.toThrow("写入前发生漂移");
      expect(pullReads).toBe(3);
      expect(calls.some(call => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(false);
    });
  });

  it("正文写入读回同时绑定head和base提交", async () => {
    await withRunnerEnvironment(async () => {
      process.env.RUNTIME_URL = "https://runtime.test";
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      let drifted = false;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") {
          currentBody = body.body;
          drifted = true;
          return new Response(JSON.stringify(pull(currentBody, 301115370, "release")), { status: 200 });
        }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) {
          const value = pull(currentBody, 301115370, "release");
          if (drifted) value.base.sha = "d".repeat(40);
          return new Response(JSON.stringify(value), { status: 200 });
        }
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      await expect(runPrIssueLink(invocation())).rejects.toThrow("漂移");
    });
  });

  it("模型安全清空时仍复核全部模型输入", async () => {
    for (const testCase of [
      { outcome: "success", output: `${JSON.stringify({ type: "assistant.message", data: { content: "not-json", toolRequests: [] } })}\n${JSON.stringify({ type: "result", exitCode: 0 })}\n`, diagnostic: "business-json-invalid" },
      { outcome: "skipped", output: null, diagnostic: "copilot-not-required" },
    ]) await withRunnerEnvironment(async (directory) => {
      const snapshots = [1, 2].map(number => {
        const snapshot = issueSnapshot(number);
        return {
          repositoryId, issueNumber: number, state: "open", snapshot,
          contentDigest: issueSnapshotContentDigest(snapshot),
          validators: [{ resource: "issue", url: `https://api.github.com/repos/splrad/steward/issues/${number}`, etag: `\"etag-${number}\"`, next: null, status: 200 }],
        };
      });
      const candidateDigests = snapshots.map(item => ({ repositoryId, number: item.issueNumber, contentDigest: item.contentDigest }));
      const openSetDigest = openIssueSetDigest(repositoryId, [1, 2]);
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const unmanagedBodyDigest = managedBodyOutsideIssueLinksDigest(outer);
      const fullDiffDigest = "e".repeat(64);
      const prepared = {
        schemaVersion: 1, repositoryId, repositoryFullName: "splrad/steward", pullRequestNumber: 42,
        baseSha, headSha, generation: 2, stateRevision: 0, policySha, fullDiffDigest, changedFiles: [], candidateDigests,
        candidates: snapshots.map(item => ({ repositoryId, number: item.issueNumber, state: "open", contentDigest: item.contentDigest, unfetchedReferences: [{ kind: "attachment", reference: `issue-${item.issueNumber}` }], validators: item.validators })),
        openSetDigest, unmanagedBodyDigest, revalidationBudget: 1_250,
        analysisInputDigest: analysisInputDigest({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, policySha, fullDiffDigest, candidateDigests, openSetDigest, unmanagedBodyDigest }),
      };
      process.env.ISSUE_PREPARED_FACTS_PATH = join(directory, "prepared.json");
      process.env.ISSUE_COPILOT_OUTPUT_PATH = join(directory, "copilot.jsonl");
      process.env.RUNTIME_URL = "https://runtime.test";
      process.env.COPILOT_STEP_OUTCOME = testCase.outcome;
      await writeFile(process.env.ISSUE_PREPARED_FACTS_PATH, JSON.stringify(prepared));
      if (testCase.output !== null) await writeFile(process.env.ISSUE_COPILOT_OUTPUT_PATH, testCase.output);
      let currentBody = outer;
      const validatorReads: string[] = [];
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: baseSha } }), { status: 200 });
        if (value.endsWith(`/internal/issue-snapshots/${repositoryId}`)) return new Response(JSON.stringify({ repositoryId, generation: 2, stateRevision: 0, syncState: "ready", openSetDigest, snapshots }), { status: 200 });
        if (value.includes("/repos/splrad/steward/issues?")) return new Response(JSON.stringify([1, 2].map(number => ({ number, repository_url: "https://api.github.com/repos/splrad/steward" }))), { status: 200 });
        if (/\/issues\/[12]$/u.test(value)) { validatorReads.push(value); return new Response(null, { status: 304 }); }
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      });
      await runPrIssueLink(invocation());
      expect(validatorReads).toEqual([
        "https://api.github.com/repos/splrad/steward/issues/1",
        "https://api.github.com/repos/splrad/steward/issues/2",
      ]);
      const check = calls.find(call => call.method === "POST" && call.url.endsWith("/check-runs"));
      expect(check?.body.output.summary).toContain("模型结果：safe-empty");
      expect(check?.body.output.summary).toContain(`模型诊断：${testCase.diagnostic}`);
      expect(await readFile(process.env.GITHUB_STEP_SUMMARY!, "utf8")).toContain(`模型诊断：${testCase.diagnostic}`);
    });
  });

  it("正文写入前出现新开放议题时保持失败并等待替代重算", async () => {
    await withRunnerEnvironment(async (directory) => {
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const fullDiffDigest = "e".repeat(64);
      const openSetDigest = openIssueSetDigest(repositoryId, []);
      const unmanagedBodyDigest = managedBodyOutsideIssueLinksDigest(outer);
      const prepared = {
        schemaVersion: 1, repositoryId, repositoryFullName: "splrad/steward", pullRequestNumber: 42,
        baseSha, headSha, generation: 2, stateRevision: 0, policySha, fullDiffDigest, changedFiles: [], candidateDigests: [], candidates: [],
        openSetDigest, unmanagedBodyDigest, revalidationBudget: 1_250,
        analysisInputDigest: analysisInputDigest({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, policySha, fullDiffDigest, candidateDigests: [], openSetDigest, unmanagedBodyDigest }),
      };
      process.env.ISSUE_PREPARED_FACTS_PATH = join(directory, "prepared.json");
      process.env.RUNTIME_URL = "https://runtime.test";
      process.env.COPILOT_STEP_OUTCOME = "failure";
      await writeFile(process.env.ISSUE_PREPARED_FACTS_PATH, JSON.stringify(prepared));
      let liveReads = 0;
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(outer, 301115370)), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: baseSha } }), { status: 200 });
        if (value.endsWith(`/internal/issue-snapshots/${repositoryId}`)) return new Response(JSON.stringify({ repositoryId, generation: 2, stateRevision: 0, syncState: "ready", openSetDigest, snapshots: [] }), { status: 200 });
        if (value.includes("/repos/splrad/steward/issues?")) {
          liveReads++;
          return new Response(JSON.stringify(liveReads === 1 ? [] : [{ number: 7, repository_url: "https://api.github.com/repos/splrad/steward" }]), { status: 200 });
        }
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `v1:${repositoryId}:42:${headSha}` }] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      await expect(runPrIssueLink(invocation())).rejects.toThrow("写入前发生漂移");
      expect(calls.some(call => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(false);
      const check = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(check?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "failure" }));
      expect(check?.body.output.summary).toContain("reconcile-failed-unclean");
    });
  });

  it("准备证据已经过期时保持失败门禁直到替代分析完成", async () => {
    await withRunnerEnvironment(async (directory) => {
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const oldBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      const currentBody = upsertIssueLinksBlock(outer, oldBlock);
      const fullDiffDigest = "e".repeat(64);
      const openSetDigest = openIssueSetDigest(repositoryId, []);
      const unmanagedBodyDigest = managedBodyOutsideIssueLinksDigest(currentBody);
      const prepared = {
        schemaVersion: 1, repositoryId, repositoryFullName: "splrad/steward", pullRequestNumber: 42,
        baseSha, headSha, generation: 2, stateRevision: 0, policySha, fullDiffDigest, changedFiles: [], candidateDigests: [], candidates: [],
        openSetDigest, unmanagedBodyDigest, revalidationBudget: 1_250,
        analysisInputDigest: analysisInputDigest({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, policySha, fullDiffDigest, candidateDigests: [], openSetDigest, unmanagedBodyDigest }),
      };
      process.env.ISSUE_PREPARED_FACTS_PATH = join(directory, "prepared.json");
      process.env.RUNTIME_URL = "https://runtime.test";
      process.env.COPILOT_STEP_OUTCOME = "skipped";
      await writeFile(process.env.ISSUE_PREPARED_FACTS_PATH, JSON.stringify(prepared));
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: baseSha } }), { status: 200 });
        if (value.endsWith(`/internal/issue-snapshots/${repositoryId}`)) return new Response(JSON.stringify({ repositoryId, generation: 3, stateRevision: 1, syncState: "ready", openSetDigest, snapshots: [] }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `v1:${repositoryId}:42:${headSha}` }] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      await runPrIssueLink(invocation());
      const check = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(check?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "failure" }));
      expect(check?.body.output.summary).toContain("stale-discarded");
      expect(check?.body.output.summary).toContain("模型诊断：copilot-not-required");
      expect(await readFile(process.env.GITHUB_STEP_SUMMARY!, "utf8")).toContain("模型诊断：copilot-not-required");
      expect(calls.some(call => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(false);
    });
  });

  it("单PR最终复核预算约束全部模型输入", () => {
    const candidates = [1, 2].map((number) => ({
      repositoryId,
      number,
      validators: Array.from({ length: 6 }, (_, index) => ({ resource: "issue" as const, url: `https://api.github.com/issues/${number}?page=${index}`, etag: `\"etag-${number}-${index}\"`, next: null, status: 200 as const })),
    }));
    expect(revalidationCandidates(candidates, 12)).toEqual(candidates);
    expect(() => revalidationCandidates(candidates, 9)).toThrow("超过预算:12/9");
  });

  it("全工作流预算按实际请求数计算，并在矩阵展开前拒绝超限组合", () => {
    const candidates = Array.from({ length: 50 }, (_, number) => ({
      validators: Array.from({ length: 6 }, (_, index) => ({
        resource: index === 5 ? "parent" as const : "issue" as const,
        url: `https://api.github.com/issues/${number}?page=${index}`,
        etag: index === 5 ? null : `"etag-${number}-${index}"`,
        next: null,
        status: index === 5 ? 404 as const : 200 as const,
      })),
    }));
    expect(workflowRevalidationPlan(candidates.slice(0, 2), 9)).toEqual({ perPullRequestBudget: 12, totalRequests: 120 });
    expect(workflowRevalidationPlan(candidates.slice(0, 2), 9, 30)).toEqual({ perPullRequestBudget: 12, totalRequests: 138 });
    expect(() => workflowRevalidationPlan(candidates, 9)).toThrow("超过全工作流预算:3000/2500");
    expect(() => workflowRevalidationPlan(candidates.slice(0, 2), 9, 2_501)).toThrow("共享议题快照复核请求数无效");
    expect(() => revalidationCandidates([{ validators: candidates[0]!.validators.slice(0, 2) }], 1)).toThrow("超过预算:2/1");
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
        baseSha, headSha, generation: 2, stateRevision: 0, policySha, fullDiffDigest, changedFiles: [], candidateDigests: [], candidates: [],
        openSetDigest, unmanagedBodyDigest, revalidationBudget: 1_250,
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
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: baseSha } }), { status: 200 });
        if (value.endsWith(`/internal/issue-snapshots/${repositoryId}`)) {
          snapshotReads++;
          return snapshotReads === 1
            ? new Response(JSON.stringify({ repositoryId, generation: 2, stateRevision: 0, syncState: "ready", openSetDigest, snapshots: [] }), { status: 200 })
            : new Response("unavailable", { status: 503 });
        }
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `v1:${repositoryId}:42:${headSha}` }] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      await runPrIssueLink(invocation());
      expect(currentBody).toBe(outer);
      const check = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(check?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "success" }));
      expect(check?.body.output.summary).toContain("freshness-failed-cleaned");
      expect(check?.body.output.summary).toContain("模型诊断：step-failed");
      expect(await readFile(process.env.GITHUB_STEP_SUMMARY!, "utf8")).toContain("模型诊断：step-failed");
    });
  });

  it("收敛前置事实读取失败时仍完成已经开始的检查", async () => {
    await withRunnerEnvironment(async (directory) => {
      const fullDiffDigest = "e".repeat(64);
      const openSetDigest = openIssueSetDigest(repositoryId, []);
      const unmanagedBodyDigest = managedBodyOutsideIssueLinksDigest("");
      const prepared = {
        schemaVersion: 1, repositoryId, repositoryFullName: "splrad/steward", pullRequestNumber: 42,
        baseSha, headSha, generation: 2, stateRevision: 0, policySha, fullDiffDigest, changedFiles: [], candidateDigests: [], candidates: [],
        openSetDigest, unmanagedBodyDigest, revalidationBudget: 1_250,
        analysisInputDigest: analysisInputDigest({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, policySha, fullDiffDigest, candidateDigests: [], openSetDigest, unmanagedBodyDigest }),
      };
      process.env.ISSUE_PREPARED_FACTS_PATH = join(directory, "prepared.json");
      process.env.RUNTIME_URL = "https://runtime.test";
      await writeFile(process.env.ISSUE_PREPARED_FACTS_PATH, JSON.stringify(prepared));
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response("temporarily unavailable", { status: 503 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `v1:${repositoryId}:42:${headSha}` }] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      await expect(runPrIssueLink(invocation())).rejects.toThrow("503");
      const check = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(check?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "failure" }));
      expect(check?.body.output.summary).toContain("prerequisite-failed-unclean");
    });
  });

  it("未受管关闭关键字在旧议题块清理后仍保持失败门禁", async () => {
    for (const testCase of [
      { bodySuffix: "", commits: [{ commit: { message: "fix: resolves #99" } }] },
      { bodySuffix: "\nFixes #98\n", commits: [{ commit: { message: "fix: ordinary change" } }] },
    ]) await withRunnerEnvironment(async (directory) => {
      const outer = `<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->${testCase.bodySuffix}`;
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      const openSetDigest = openIssueSetDigest(repositoryId, []);
      let checkExists = false;
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 });
        if (value.includes("/repos/splrad/steward/pulls/42/commits?")) return new Response(JSON.stringify(testCase.commits), { status: 200 });
        if (value.endsWith(`/internal/issue-snapshots/${repositoryId}`)) return new Response(JSON.stringify({ repositoryId, generation: 2, stateRevision: 0, syncState: "ready", openSetDigest, snapshots: [] }), { status: 200 });
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: checkExists ? [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `v1:${repositoryId}:42:${headSha}` }] : [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) { checkExists = true; return new Response(JSON.stringify({ id: 1 }), { status: 201 }); }
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      process.env.RUNTIME_URL = "https://runtime.test";
      process.env.SNAPSHOT_VALIDATED_GENERATION = "2";
      process.env.ISSUE_PREPARED_FACTS_PATH = join(directory, "prepared.json");
      process.env.ISSUE_COPILOT_PROMPT_PATH = join(directory, "prompt.txt");
      await expect(runPrIssueLink(invocation())).rejects.toThrow("关闭关键字");
      expect(currentBody).toBe(outer);
      const check = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(check?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: "failure" }));
      expect(check?.body.output.summary).toContain("unmanaged-closing-keywords-managed-block-cleaned");
    });
  });

  it("仅在提交关闭关键字核验完成后允许 safe-empty", async () => {
    for (const testCase of [
      { snapshotAvailable: false, succeeds: false, category: "commit-keywords-unverified-managed-block-cleaned" },
      { snapshotAvailable: true, succeeds: true, category: "prepare-failed-cleaned" },
    ]) await withRunnerEnvironment(async (directory) => {
      const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n## 发布与迁移\n\n无\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
      const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 2, analysisInputDigest: "d".repeat(64) }, [{ repositoryId, number: 7 }]);
      let currentBody = upsertIssueLinksBlock(outer, block);
      let checkExists = false;
      const calls: Array<{ url: string; method: string; body: any }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET"; const value = String(url); const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: value, method, body });
        const bodyWriteResponse = bodyWriteRuntimeResponse(value, method, body); if (bodyWriteResponse) return bodyWriteResponse;
        if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
        if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository()), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/pulls/42") && method === "PATCH") { currentBody = body.body; return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 }); }
        if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify(pull(currentBody, 301115370)), { status: 200 });
        if (value.endsWith("/internal/issue-snapshots/1296724484")) return testCase.snapshotAvailable
          ? new Response(JSON.stringify({ repositoryId, generation: 2, stateRevision: 0, syncState: "ready", openSetDigest: openIssueSetDigest(repositoryId, []), snapshots: [] }), { status: 200 })
          : new Response("unavailable", { status: 503 });
        if (value.includes("/repos/splrad/steward/pulls/42/commits?")) return new Response(JSON.stringify([{ commit: { message: "fix: ordinary change" } }]), { status: 200 });
        if (value.includes("/repos/splrad/steward/pulls/42/files?")) return new Response("unavailable", { status: 503 });
        if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { databaseId: repositoryId, pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200 });
        if (value.includes(`/commits/${headSha}/check-runs`)) return new Response(JSON.stringify({ check_runs: checkExists ? [{ id: 1, name: "PR Issue Link Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `v1:${repositoryId}:42:${headSha}` }] : [] }), { status: 200 });
        if (value.endsWith("/repos/splrad/steward/check-runs")) { checkExists = true; return new Response(JSON.stringify({ id: 1 }), { status: 201 }); }
        if (value.endsWith("/repos/splrad/steward/check-runs/1")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        return new Response("unexpected", { status: 500 });
      });
      process.env.ISSUE_LINK_PREPARE_ONLY = "true";
      process.env.RUNTIME_URL = "https://runtime.test";
      process.env.SNAPSHOT_VALIDATED_GENERATION = "2";
      process.env.ISSUE_PREPARED_FACTS_PATH = join(directory, "prepared.json");
      process.env.ISSUE_COPILOT_PROMPT_PATH = join(directory, "prompt.txt");
      const result = runPrIssueLink(invocation());
      if (testCase.succeeds) await result;
      else await expect(result).rejects.toThrow();
      expect(currentBody).toBe(outer);
      const update = calls.find(call => call.method === "PATCH" && call.url.endsWith("/check-runs/1"));
      expect(update?.body).toEqual(expect.objectContaining({ status: "completed", conclusion: testCase.succeeds ? "success" : "failure" }));
      expect(update?.body.output.summary).toContain(testCase.category);
      if (testCase.succeeds) expect(await readFile(process.env.GITHUB_OUTPUT!, "utf8")).toContain("copilot-required=false");
    });
  });
});
