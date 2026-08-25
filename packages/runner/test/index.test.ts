import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFreshValidationBase, assertManagedBranchPull, assertPreparedCopilotFacts, assertWorkflowPaths, classificationInstallationPermissions, copilotInstructionSourcePath, decodeAiClassificationPayload, decodeClassificationCheckState, describeCopilotFallback, describeCopilotRepairAvailability, describeCopilotRepairOutputFailure, encodeAiClassificationPayload, encodeClassificationCheckState, env, extractCopilotAssistantContent, gitDiffCheckArguments, hasActiveCopilotCheckRun, hasNewCopilotRequestEvent, hasRequestedCopilotReviewer, humanPushPullRequestCreateInput, inspectAutomationPullRequestBinding, inspectCopilotGeneratedSummary, isCopilotReviewerIdentity, isTrustedAiClassificationSource, issueSyncInstallationPermissions, main, matchesGeneratedCopilotInstructions, normalizeCopilotJsonCandidate, parseInvocation, prAutomationInstallationPermissions, prepareAiClassificationPayload, reconcileIssueSnapshots, renderAiClassificationEvidence, resolveCopilotGeneratedSummary, reusedAiClassificationAssessment, throwFreshValidationBaseFailure, writeManagedFileToBranch } from "../src/index.js";

const Ajv = AjvModule as unknown as typeof import("ajv").default;
const addFormats = addFormatsModule as unknown as typeof import("ajv-formats").default;

afterEach(() => {
  delete process.env.TEST_REQUIRED_ENV;
  delete process.env.GITHUB_STEP_SUMMARY;
  delete process.env.APP_ID;
  delete process.env.INSTALLATION_ID;
  delete process.env.STEWARD_APP_PRIVATE_KEY;
  delete process.env.STEWARD_CONFIG_DIRECTORY;
  delete process.env.RUNTIME_URL;
  vi.unstubAllGlobals();
});

describe("中央命令入口", () => {
  it("只接受十四个命令及其已知、唯一、成对参数", () => {
    const commands = ["issue-sync", "managed-repository-ids", "reconcile-repository-lifecycle", "onboard-repository", "pr-automation", "pr-classification", "pr-issue-link", "sync-copilot-instructions", "sync-managed-labels", "validate", "release-preflight", "release-notes", "release-publish", "release-verify"];
    for (const command of commands) expect(parseInvocation([command]).command).toBe(command);
    expect(() => parseInvocation(["unknown"])).toThrow("未知命令");
    expect(() => parseInvocation(["validate", "--unknown", "x"])).toThrow("未知参数");
    expect(() => parseInvocation(["validate", "--workspace"])).toThrow("参数格式");
    expect(() => parseInvocation(["validate", "--workspace", "a", "--workspace", "b"])).toThrow("重复参数");
  });

  it("部署生命周期收敛会墓碑当前不具备议题能力的仓库并调度全PR清理", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    process.env.APP_ID = "4243096";
    process.env.INSTALLATION_ID = "145952003";
    process.env.STEWARD_APP_PRIVATE_KEY = privateKey;
    process.env.STEWARD_CONFIG_DIRECTORY = resolve("config");
    process.env.RUNTIME_URL = "https://runtime.test";
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url); const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: value, body });
      if (value.endsWith("/app/installations/145952003/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/installation/repositories?per_page=100")) return new Response(JSON.stringify({ repositories: [
        { id: 1400000001, full_name: "splrad/default-private", private: true, has_issues: false, archived: false, disabled: false, owner: { id: 302208797, login: "splrad" } },
      ] }), { status: 200 });
      if (value.endsWith("/internal/issue-snapshots/1296724484/lifecycle/reconcile")) return new Response(JSON.stringify({ repositoryId: 1296724484, removedRepositoryIds: [1296725317] }), { status: 200 });
      if (value.endsWith("/internal/issue-snapshots/1400000001/lifecycle")) return new Response(JSON.stringify({ repositoryId: 1400000001, managed: false, issueCapable: false }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/pr-issue-link.yml/dispatches")) return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    });
    await main(["reconcile-repository-lifecycle", "--delivery-id", "deploy-1-1", "--policy-sha", "a".repeat(40)]);
    expect(calls.find(call => call.url.endsWith("/internal/issue-snapshots/1296724484/lifecycle/reconcile"))?.body).toEqual({ repositoryIds: [1400000001] });
    const lifecycleIndex = calls.findIndex(call => call.url.endsWith("/internal/issue-snapshots/1400000001/lifecycle"));
    const cleanupIndex = calls.findIndex(call => call.body?.inputs?.cleanupUnmanaged === "true");
    expect(calls.some(call => call.body?.inputs?.invalidateOnly === "true")).toBe(false);
    expect(lifecycleIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(lifecycleIndex);
    expect(calls[cleanupIndex]!.body.inputs).toEqual({
      deliveryId: "deploy-1-1:1400000001", repositoryId: "1400000001", scanAll: "true", invalidateOnly: "false", cleanupUnmanaged: "true", policySha: "a".repeat(40),
    });
  });

  it("部署对账先失效全部仓库，并在单仓同步失败后继续调度后续仓库", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    process.env.APP_ID = "4243096";
    process.env.INSTALLATION_ID = "145952003";
    process.env.STEWARD_APP_PRIVATE_KEY = privateKey;
    process.env.STEWARD_CONFIG_DIRECTORY = resolve("config");
    process.env.RUNTIME_URL = "https://runtime.test";
    const calls: Array<{ url: string; body: any }> = [];
    const managedRepositories = [
      { id: 1187527897, full_name: "splrad/LayerScape", private: false, has_issues: true, archived: false, disabled: false, owner: { id: 302208797, login: "splrad" } },
      { id: 1296724484, full_name: "splrad/steward", private: false, has_issues: true, archived: false, disabled: false, owner: { id: 302208797, login: "splrad" } },
    ];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url); const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: value, body });
      if (value.endsWith("/app/installations/145952003/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/installation/repositories?per_page=100")) return new Response(JSON.stringify({ repositories: managedRepositories }), { status: 200 });
      if (value.endsWith("/internal/issue-snapshots/1296724484/lifecycle/reconcile")) return new Response(JSON.stringify({ repositoryId: 1296724484, removedRepositoryIds: [] }), { status: 200 });
      if (value.endsWith("/internal/issue-snapshots/1187527897/lifecycle")) return new Response(JSON.stringify({ repositoryId: 1187527897, managed: true, issueCapable: true }), { status: 200 });
      if (value.endsWith("/internal/issue-snapshots/1296724484/lifecycle")) return new Response(JSON.stringify({ repositoryId: 1296724484, managed: true, issueCapable: true }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/pr-issue-link.yml/dispatches")) return new Response(null, { status: 204 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/issue-sync.yml/dispatches")) return new Response(body.inputs.repositoryId === "1187527897" ? "failure" : null, { status: body.inputs.repositoryId === "1187527897" ? 500 : 204 });
      return new Response("unexpected", { status: 500 });
    });
    await expect(main(["reconcile-repository-lifecycle", "--delivery-id", "deploy-1-2", "--policy-sha", "a".repeat(40)])).rejects.toThrow();
    const invalidations = calls.filter(call => call.body?.inputs?.invalidateOnly === "true");
    const lifecycleIndexes = calls.map((call, index) => /\/internal\/issue-snapshots\/\d+\/lifecycle$/u.test(call.url) ? index : -1).filter(index => index >= 0);
    const scans = calls.filter(call => call.url.endsWith("/repos/splrad/steward/actions/workflows/issue-sync.yml/dispatches"));
    expect(invalidations.map(call => call.body.inputs.repositoryId)).toEqual(["1187527897", "1296724484"]);
    expect(Math.max(...invalidations.map(call => calls.indexOf(call)))).toBeLessThan(Math.min(...lifecycleIndexes));
    expect(scans.map(call => call.body.inputs.repositoryId)).toEqual(["1187527897", "1296724484"]);
    expect(Math.max(...lifecycleIndexes)).toBeLessThan(calls.indexOf(scans[0]!));
  });

  it("部署对账会尝试失效全部仓库，任一失效失败时不变更生命周期", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    process.env.APP_ID = "4243096";
    process.env.INSTALLATION_ID = "145952003";
    process.env.STEWARD_APP_PRIVATE_KEY = privateKey;
    process.env.STEWARD_CONFIG_DIRECTORY = resolve("config");
    process.env.RUNTIME_URL = "https://runtime.test";
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url); const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: value, body });
      if (value.endsWith("/app/installations/145952003/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/installation/repositories?per_page=100")) return new Response(JSON.stringify({ repositories: [
        { id: 1187527897, full_name: "splrad/LayerScape", private: false, has_issues: true, archived: false, disabled: false, owner: { id: 302208797, login: "splrad" } },
        { id: 1296724484, full_name: "splrad/steward", private: false, has_issues: true, archived: false, disabled: false, owner: { id: 302208797, login: "splrad" } },
      ] }), { status: 200 });
      if (value.endsWith("/internal/issue-snapshots/1296724484/lifecycle/reconcile")) return new Response(JSON.stringify({ repositoryId: 1296724484, removedRepositoryIds: [] }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/pr-issue-link.yml/dispatches")) return new Response(body.inputs.repositoryId === "1187527897" ? "failure" : null, { status: body.inputs.repositoryId === "1187527897" ? 500 : 204 });
      return new Response("unexpected", { status: 500 });
    });
    await expect(main(["reconcile-repository-lifecycle", "--delivery-id", "deploy-1-3", "--policy-sha", "a".repeat(40)])).rejects.toThrow();
    expect(calls.filter(call => call.body?.inputs?.invalidateOnly === "true").map(call => call.body.inputs.repositoryId)).toEqual(["1187527897", "1296724484"]);
    expect(calls.some(call => /\/internal\/issue-snapshots\/\d+\/lifecycle$/u.test(call.url))).toBe(false);
  });

  it("部署对账在单仓生命周期失败后继续收敛并同步其他仓库", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    process.env.APP_ID = "4243096";
    process.env.INSTALLATION_ID = "145952003";
    process.env.STEWARD_APP_PRIVATE_KEY = privateKey;
    process.env.STEWARD_CONFIG_DIRECTORY = resolve("config");
    process.env.RUNTIME_URL = "https://runtime.test";
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url); const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: value, body });
      if (value.endsWith("/app/installations/145952003/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/installation/repositories?per_page=100")) return new Response(JSON.stringify({ repositories: [
        { id: 1187527897, full_name: "splrad/LayerScape", private: false, has_issues: true, archived: false, disabled: false, owner: { id: 302208797, login: "splrad" } },
        { id: 1296724484, full_name: "splrad/steward", private: false, has_issues: true, archived: false, disabled: false, owner: { id: 302208797, login: "splrad" } },
      ] }), { status: 200 });
      if (value.endsWith("/internal/issue-snapshots/1296724484/lifecycle/reconcile")) return new Response(JSON.stringify({ repositoryId: 1296724484, removedRepositoryIds: [] }), { status: 200 });
      if (value.endsWith("/internal/issue-snapshots/1187527897/lifecycle")) return new Response("failure", { status: 500 });
      if (value.endsWith("/internal/issue-snapshots/1296724484/lifecycle")) return new Response(JSON.stringify({ repositoryId: 1296724484, managed: true, issueCapable: true }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/pr-issue-link.yml/dispatches")) return new Response(null, { status: 204 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/issue-sync.yml/dispatches")) return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    });
    await expect(main(["reconcile-repository-lifecycle", "--delivery-id", "deploy-1-4", "--policy-sha", "a".repeat(40)])).rejects.toThrow("仓库生命周期运行时请求失败:500");
    expect(calls.filter(call => /\/internal\/issue-snapshots\/\d+\/lifecycle$/u.test(call.url)).map(call => call.url.match(/issue-snapshots\/(\d+)/u)?.[1])).toEqual(["1187527897", "1296724484"]);
    expect(calls.filter(call => call.url.endsWith("/repos/splrad/steward/actions/workflows/issue-sync.yml/dispatches")).map(call => call.body.inputs.repositoryId)).toEqual(["1296724484"]);
  });

  it("部署初始化仓库清单包含公开默认纳管仓库并排除默认private仓库", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    process.env.APP_ID = "4243096";
    process.env.INSTALLATION_ID = "145952003";
    process.env.STEWARD_APP_PRIVATE_KEY = privateKey;
    process.env.STEWARD_CONFIG_DIRECTORY = resolve("config");
    const requests: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      requests.push({ url: value, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (value.endsWith("/app/installations/145952003/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/installation/repositories?per_page=100")) return new Response(JSON.stringify({ repositories: [
        { id: 1296724484, full_name: "splrad/steward", private: false, owner: { id: 302208797, login: "splrad" } },
        { id: 1400000000, full_name: "splrad/default-managed", private: false, owner: { id: 302208797, login: "splrad" } },
        { id: 1400000001, full_name: "splrad/default-private", private: true, owner: { id: 302208797, login: "splrad" } },
      ] }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await main(["managed-repository-ids", "--policy-sha", "a".repeat(40)]);
      expect(output).toHaveBeenCalledWith("1296724484\n1400000000\n");
      expect(requests[0]!.body).toEqual({ permissions: { metadata: "read" } });
      expect(requests[0]!.body).not.toHaveProperty("repository_ids");
    } finally {
      output.mockRestore();
    }
  });

  it("接入成功后即使标签同步失败也先派发首次议题快照", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    process.env.APP_ID = "4243096";
    process.env.INSTALLATION_ID = "145952003";
    process.env.STEWARD_APP_PRIVATE_KEY = privateKey;
    process.env.STEWARD_CONFIG_DIRECTORY = resolve("config");
    const policySha = "a".repeat(40);
    const repositoryId = 1296724484;
    const desiredSettings = {
      allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: false,
      delete_branch_on_merge: true, squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "BLANK",
    };
    const repository = {
      id: repositoryId, full_name: "splrad/steward", private: false, owner: { id: 302208797, login: "splrad" },
      fork: false, has_issues: true, archived: false, disabled: false, default_branch: "main", ...desiredSettings,
    };
    const instructions = `${(await readFile(resolve("config", "copilot", "common.md"), "utf8")).trimEnd()}\n`;
    const calls: Array<{ url: string; method: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init: RequestInit = {}) => {
      const value = String(url); const method = init.method ?? "GET"; const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: value, method, body });
      if (value.endsWith("/app/installations/145952003/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith(`/repositories/${repositoryId}`)) return new Response(JSON.stringify(repository), { status: 200 });
      if (value.endsWith("/installation/repositories?per_page=100")) return new Response(JSON.stringify({ repositories: [repository] }), { status: 200 });
      if (value.includes("/repos/splrad/steward/labels?per_page=100")) return new Response("label failure", { status: 500 });
      if (value.endsWith("/repos/splrad/steward/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: "b".repeat(40) } }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/teams?per_page=100")) return new Response(JSON.stringify([{ slug: "maintainers", permission: "maintain" }]), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/rulesets?includes_parents=true&per_page=100")) return new Response(JSON.stringify([{ id: 18883080, enforcement: "active" }]), { status: 200 });
      if (value.endsWith("/repos/splrad/steward") && method === "PATCH") return new Response(JSON.stringify(repository), { status: 200 });
      if (value.endsWith("/repos/splrad/steward") && method === "GET") return new Response(JSON.stringify(repository), { status: 200 });
      if (value.includes("/repos/splrad/steward/contents/.github/copilot-instructions.md?ref=main")) return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(instructions, "utf8").toString("base64") }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/issue-sync.yml/dispatches")) return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    });

    await expect(main([
      "onboard-repository", "--repository-id", String(repositoryId), "--repository-full-name", "splrad/steward",
      "--trigger", "repository-visibility-changed", "--delivery-id", "onboard-label-failure", "--policy-sha", policySha,
    ])).rejects.toThrow("受管标签同步失败: splrad/steward");
    const dispatch = calls.find(call => call.url.endsWith("/repos/splrad/steward/actions/workflows/issue-sync.yml/dispatches"));
    expect(dispatch?.body).toEqual({ ref: "main", inputs: { deliveryId: "onboard-label-failure", repositoryId: String(repositoryId), scanAll: "true", policySha } });
  });

  it("在创建安装令牌前拒绝超出安全整数范围的编号", async () => {
    await expect(main([
      "issue-sync",
      "--delivery-id", "delivery-unsafe-integer",
      "--repository-id", "9007199254740993",
      "--scan-all", "true",
      "--policy-sha", "a".repeat(40),
    ])).rejects.toThrow("安全整数");
  });

  it("未启用 Issues 的仓库在读取议题或 Runtime 前停止同步", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    process.env.APP_ID = "4243096";
    process.env.INSTALLATION_ID = "145952003";
    process.env.STEWARD_APP_PRIVATE_KEY = privateKey;
    process.env.STEWARD_CONFIG_DIRECTORY = resolve("config");
    process.env.RUNTIME_URL = "https://runtime.test";
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const value = String(url); calls.push(value);
      if (value.endsWith("/app/installations/145952003/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/installation/repositories?per_page=100")) return new Response(JSON.stringify({ repositories: [
        { id: 1296724484, full_name: "splrad/steward", private: false, has_issues: false, archived: false, disabled: false, owner: { id: 302208797, login: "splrad" } },
      ] }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    await expect(main(["issue-sync", "--delivery-id", "issues-disabled", "--repository-id", "1296724484", "--scan-all", "true", "--policy-sha", "a".repeat(40)]))
      .rejects.toThrow("仓库未启用议题同步");
    expect(calls.some(value => {
      const url = new URL(value);
      return url.pathname.includes("/issues") || url.origin === "https://runtime.test";
    })).toBe(false);
  });

  it("缺失环境变量立即失败", () => {
    expect(() => env("TEST_REQUIRED_ENV")).toThrow("缺少环境变量");
    process.env.TEST_REQUIRED_ENV = "present";
    expect(env("TEST_REQUIRED_ENV")).toBe("present");
  });

  it("创建拉取请求的输入显式包含draft标记", () => {
    expect(humanPushPullRequestCreateInput({ title: "feat(pr): 草案", body: "正文", head: "feature/a", base: "main" })).toEqual({
      title: "feat(pr): 草案",
      body: "正文",
      head: "feature/a",
      base: "main",
      draft: true,
    });
  });

  it("AI分类上下文封装使用规范、限长编码", () => {
    const envelope = {
      schemaVersion: 2 as const,
      repositoryId: 1, pullRequestNumber: 2, sourceRepositoryId: 1,
      sourceRef: "refs/heads/change", targetRef: "refs/heads/main",
      headSha: "a".repeat(40), baseSha: "b".repeat(40), policySha: "c".repeat(40),
      catalogDigest: "d".repeat(64), profileDigest: "e".repeat(64), repositoryClassificationDigest: "f".repeat(64), classificationPolicyDigest: "1".repeat(64), inputDigest: "2".repeat(64),
      effectiveAiMode: "shadow" as const,
      suggestion: { primaryKind: "feature", confidence: "high" as const, evidence: [{ path: "packages/core/src/automation.ts", reason: "新增分类建议字段" }] },
    };
    const encoded = encodeAiClassificationPayload(envelope);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeAiClassificationPayload(encoded)).toEqual(envelope);
    expect(() => decodeAiClassificationPayload(`${encoded}=`)).toThrow("封装格式无效");
    expect(() => decodeAiClassificationPayload("a".repeat(16_385))).toThrow("封装格式无效");
    expect(() => decodeAiClassificationPayload(Buffer.from("not-json", "utf8").toString("base64url"))).toThrow("AI分类封装格式无效");
  });

  it("无效AI分类只传固定占位值且封装失败时安全降级", () => {
    const envelope = {
      schemaVersion: 2 as const,
      repositoryId: 1, pullRequestNumber: 2, sourceRepositoryId: 1,
      sourceRef: "refs/heads/change", targetRef: "refs/heads/main",
      headSha: "a".repeat(40), baseSha: "b".repeat(40), policySha: "c".repeat(40),
      catalogDigest: "d".repeat(64), profileDigest: "e".repeat(64), repositoryClassificationDigest: "f".repeat(64), classificationPolicyDigest: "1".repeat(64), inputDigest: "2".repeat(64),
      effectiveAiMode: "shadow" as const,
      suggestion: null,
    };
    const invalid = prepareAiClassificationPayload({ state: "invalid", raw: { untrusted: "x".repeat(20_000) }, reason: "classification.primaryKind无效" }, envelope);
    expect(invalid.state).toBe("encoded");
    if (invalid.state === "encoded") expect(decodeAiClassificationPayload(invalid.payload)).toEqual({ ...envelope, suggestion: { invalid: true } });

    const validSuggestion = { primaryKind: "feature", confidence: "high" as const, evidence: [{ path: "packages/core/src/automation.ts", reason: "新增分类建议字段" }] };
    const valid = { state: "valid" as const, suggestion: validSuggestion, raw: validSuggestion };
    expect(prepareAiClassificationPayload(valid, { ...envelope, sourceRef: "x".repeat(20_000) })).toEqual({ state: "encoding-failed" });
    expect(prepareAiClassificationPayload({ state: "missing" }, envelope)).toEqual({ state: "missing" });
  });

  it("默认分支仅SHA前进时跳过AI封装，其他拉取请求绑定漂移仍失败", () => {
    const expected = { repositoryId: 1, sourceBranch: "change", headSha: "a".repeat(40), baseBranch: "main", baseSha: "b".repeat(40) };
    const pull = {
      head: { repo: { id: 1 }, ref: "change", sha: "a".repeat(40) },
      base: { ref: "main", sha: "b".repeat(40) },
    };
    expect(inspectAutomationPullRequestBinding(pull, expected)).toBe("matched");
    expect(inspectAutomationPullRequestBinding({ ...pull, base: { ...pull.base, sha: "c".repeat(40) } }, expected)).toBe("base-sha-drifted");
    for (const changed of [
      { ...pull, head: { ...pull.head, repo: { id: 2 } } },
      { ...pull, head: { ...pull.head, ref: "other" } },
      { ...pull, head: { ...pull.head, sha: "d".repeat(40) } },
      { ...pull, base: { ...pull.base, ref: "release" } },
    ]) expect(() => inspectAutomationPullRequestBinding(changed, expected)).toThrow("AI分类封装对应的拉取请求事实已经漂移");
  });

  it("AI分类来源必须绑定App触发者、Steward工作流和当前策略提交", () => {
    const policySha = "a".repeat(40);
    const trusted = { TRIGGER_ACTOR_ID: "301115370", WORKFLOW_REPOSITORY: "splrad/steward", WORKFLOW_EVENT: "workflow_dispatch", WORKFLOW_REF: "splrad/steward/.github/workflows/pr-classification.yml@refs/heads/trunk", WORKFLOW_RUN_REF: "refs/heads/trunk", WORKFLOW_SHA: policySha };
    expect(isTrustedAiClassificationSource(policySha, trusted)).toBe(true);
    for (const key of Object.keys(trusted)) expect(isTrustedAiClassificationSource(policySha, { ...trusted, [key]: "untrusted" })).toBe(false);
  });

  it("只接受规范编码且字段完整的Check v3所有权状态", () => {
    const codec = { primaryKinds: ["feature", "bug"], riskFlags: ["breaking-change"], facets: ["javascript"], areas: ["area:source"] };
    const state = { v: 3 as const, repositoryId: 1, pullRequestNumber: 2, headSha: "f".repeat(40), inputDigest: "a".repeat(64), policy: "b".repeat(64), mode: "shadow" as const, primary: { id: "feature", source: "deterministic-fallback" as const, reasonCode: "primary-deterministic-type-selected" }, risks: ["breaking-change"], facets: ["javascript"], areas: ["area:source"], decisionDigest: "c".repeat(64) };
    const encoded = encodeClassificationCheckState(state, codec);
    expect(encoded).toHaveLength(223);
    expect(decodeClassificationCheckState(encoded, codec)).toEqual(state);
    expect(decodeClassificationCheckState(encoded, codec, { repositoryId: 1, pullRequestNumber: 2, headSha: "f".repeat(40) })).toEqual(state);
    expect(decodeClassificationCheckState(encoded, codec, { repositoryId: 1, pullRequestNumber: 3, headSha: "f".repeat(40) })).toBeNull();
    expect(decodeClassificationCheckState(encoded.replace("v3:", "v2:"), codec)).toBeNull();
    expect(decodeClassificationCheckState(`${encoded}=`, codec)).toBeNull();
    expect(decodeClassificationCheckState(`v3:${Buffer.from("{}", "utf8").toString("base64url")}`, codec)).toBeNull();
    const bufferFrom = vi.spyOn(Buffer, "from");
    try {
      expect(decodeClassificationCheckState(`v3:${"A".repeat(20_000)}`, codec)).toBeNull();
      expect(bufferFrom).not.toHaveBeenCalled();
    } finally {
      bufferFrom.mockRestore();
    }
    const corrupted = `${encoded.slice(0, -1)}${encoded.endsWith("A") ? "B" : "A"}`;
    expect(decodeClassificationCheckState(corrupted, codec)).toBeNull();
    const aiState = { ...state, mode: "active" as const, primary: { id: "feature", source: "ai" as const, reasonCode: "primary-ai-accepted" }, acceptedAiPrimaryKind: "feature" };
    const decodedAi = decodeClassificationCheckState(encodeClassificationCheckState(aiState, codec), codec);
    expect(reusedAiClassificationAssessment(decodedAi)).toMatchObject({ status: "reused", suggestion: null, verifiedSuggestion: { primaryKind: "feature", reused: true } });
    expect(reusedAiClassificationAssessment(decodeClassificationCheckState(encoded, codec))).toBeNull();
    expect(() => encodeClassificationCheckState({ ...aiState, acceptedAiPrimaryKind: "bug" }, codec)).toThrow("AI主类不一致");
  });

  it("AI影子分类依据以Markdown纯文本写入检查摘要", () => {
    expect(renderAiClassificationEvidence({
      primaryKind: "feature",
      confidence: "medium",
      evidence: [{ path: "packages/core/a_b*~|file.ts", reason: "仅调整内部实现" }],
    })).toBe("packages/core/a\\_b\\*\\~\\|file\\.ts：仅调整内部实现");
    expect(renderAiClassificationEvidence(null)).toBe("未提供");
  });

  it("Copilot回退原因按安全阶段记录且不输出未知异常正文", () => {
    expect(describeCopilotFallback("copilot-step", new Error("命令输出"))).toBe("Copilot命令执行失败");
    expect(describeCopilotFallback("prepared-facts-read", new Error("临时路径"))).toBe("人工智能输入文件无法读取");
    expect(describeCopilotFallback("prepared-facts-parse", new Error("原始JSON"))).toBe("人工智能输入文件不是有效JSON");
    expect(describeCopilotFallback("prepared-facts-check", new Error("人工智能输入对应的分支事实已经漂移"))).toBe("人工智能输入对应的分支事实已经漂移");
    expect(describeCopilotFallback("copilot-output-read", new Error("临时路径"))).toBe("Copilot输出文件无法读取");
    expect(describeCopilotFallback("copilot-output-envelope", new Error("token=secret"))).toBe("Copilot输出传输封装无效");
    expect(describeCopilotFallback("copilot-output-parse", new Error("原始JSON"))).toBe("Copilot输出不是有效JSON");
    expect(describeCopilotFallback("copilot-output-parse", new SyntaxError("Unexpected non-whitespace character after JSON at position 123 (line 2 column 1)"))).toBe("Copilot输出不是有效JSON（位置123）");
    expect(describeCopilotFallback("copilot-output-validate", new Error("summary长度或格式无效"))).toBe("Copilot输出字段校验失败：summary长度或格式无效");
    expect(describeCopilotFallback("copilot-output-validate", new Error("不可信内容\nsecret=value"))).toBe("Copilot输出字段校验失败");
  });

  it("从唯一成功结果中的最后一条根消息提取原始业务JSON", () => {
    const generated = JSON.stringify({ type: "fix", scope: "pr", title: "使用JSONL正文" });
    const wrapped = [
      JSON.stringify({ type: "assistant.turn_start", data: { turnId: "0" } }),
      JSON.stringify({ type: "assistant.message", data: { messageId: "message-1", content: "处理中", toolRequests: [] } }),
      JSON.stringify({ type: "assistant.message", agentId: "subagent-1", data: { messageId: "message-2", content: "子代理内容", toolRequests: [] } }),
      JSON.stringify({ type: "assistant.message", data: { messageId: "message-3", content: generated, toolRequests: [] } }),
      JSON.stringify({ type: "assistant.turn_end", data: { turnId: "0" } }),
      JSON.stringify({ type: "result", sessionId: "session-1", exitCode: 0, usage: {} }),
    ].join("\n") + "\n";
    expect(() => JSON.parse(wrapped)).toThrow();
    expect(JSON.parse(extractCopilotAssistantContent(wrapped))).toEqual({ type: "fix", scope: "pr", title: "使用JSONL正文" });
    expect(extractCopilotAssistantContent(wrapped.replaceAll("\n", "\r\n"))).toBe(generated);
  });

  it("拒绝缺失、重复结果、失败或带工具行为的Copilot JSONL封装", () => {
    const message = JSON.stringify({ type: "assistant.message", data: { content: "{}", toolRequests: [] } });
    const success = JSON.stringify({ type: "result", sessionId: "session-1", exitCode: 0, usage: {} });
    const failure = JSON.stringify({ type: "result", sessionId: "session-1", exitCode: 1, usage: {} });
    const toolMessage = JSON.stringify({ type: "assistant.message", data: { content: "{}", toolRequests: [{ toolCallId: "call-1", name: "bash" }] } });
    const serverToolMessage = JSON.stringify({ type: "assistant.message", data: { content: "{}", toolRequests: [], serverTools: { provider: "test" } } });
    const toolExecution = JSON.stringify({ type: "tool.execution_start", data: { toolCallId: "call-1" } });
    const subagentMessage = JSON.stringify({ type: "assistant.message", agentId: "subagent-1", data: { content: "{}", toolRequests: [] } });
    const childMessage = JSON.stringify({ type: "assistant.message", data: { content: "{}", parentToolCallId: "call-1", toolRequests: [] } });
    expect(() => extractCopilotAssistantContent(`${success}\n`)).toThrow("Copilot JSONL消息无效");
    expect(() => extractCopilotAssistantContent(`${message}\n`)).toThrow("Copilot JSONL结果无效");
    expect(() => extractCopilotAssistantContent(`${message}\n${success}\n${success}\n`)).toThrow("Copilot JSONL结果无效");
    expect(() => extractCopilotAssistantContent(`${message}\n${failure}\n`)).toThrow("Copilot JSONL结果无效");
    expect(() => extractCopilotAssistantContent(`${message}\n${success}\n${JSON.stringify({ type: "session.end", data: {} })}\n`)).toThrow("Copilot JSONL结果无效");
    expect(() => extractCopilotAssistantContent(`${toolMessage}\n${success}\n`)).toThrow("Copilot JSONL消息无效");
    expect(() => extractCopilotAssistantContent(`${serverToolMessage}\n${success}\n`)).toThrow("Copilot JSONL消息无效");
    expect(() => extractCopilotAssistantContent(`${message}\n${toolExecution}\n${success}\n`)).toThrow("Copilot JSONL消息无效");
    expect(() => extractCopilotAssistantContent(`${subagentMessage}\n${success}\n`)).toThrow("Copilot JSONL消息无效");
    expect(() => extractCopilotAssistantContent(`${childMessage}\n${success}\n`)).toThrow("Copilot JSONL消息无效");
  });

  it("严格限制Copilot JSONL格式和大小且不泄露原始内容", () => {
    const secret = "COPILOT_GITHUB_TOKEN=secret-value";
    try {
      extractCopilotAssistantContent(`{\"type\":\"assistant.message\",\"data\":{\"content\":\"${secret}\"}\n`);
      throw new Error("非JSON输入未被拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Copilot JSONL输出格式无效");
      expect((error as Error).message).not.toContain(secret);
    }
    expect(() => extractCopilotAssistantContent(`${JSON.stringify(["not-an-event"])}\n`)).toThrow("Copilot JSONL输出格式无效");
    expect(() => extractCopilotAssistantContent("x".repeat(2_097_153))).toThrow("Copilot JSONL输出大小无效");
    const oversizedContent = JSON.stringify({ type: "assistant.message", data: { content: "文".repeat(21_846), toolRequests: [] } });
    const success = JSON.stringify({ type: "result", sessionId: "session-1", exitCode: 0, usage: {} });
    expect(() => extractCopilotAssistantContent(`${oversizedContent}\n${success}\n`)).toThrow("Copilot JSONL消息无效");
    const tooManyLines = Array.from({ length: 256 }, () => JSON.stringify({ type: "assistant.turn_start", data: {} }));
    expect(() => extractCopilotAssistantContent(`${tooManyLines.join("\n")}\n${success}\n`)).toThrow("Copilot JSONL输出格式无效");
    expect(() => extractCopilotAssistantContent("{}\n\n")).toThrow("Copilot JSONL输出格式无效");
  });

  it("只允许业务JSON解析或字段校验失败进入一次修复", () => {
    const wrap = (content: string, toolRequests: unknown[] = []) => [
      JSON.stringify({ type: "assistant.message", data: { content, toolRequests } }),
      JSON.stringify({ type: "result", sessionId: "session-1", exitCode: 0, usage: {} }),
    ].join("\n") + "\n";
    const valid = JSON.stringify({
      type: "fix", scope: "pr", title: "修复正文生成",
      summary: "本次修改为正文生成增加严格校验后的受控修复步骤。",
      motivation: null,
      changes: ["增加一次受控修复并保留确定性回退边界"],
      impact: [], releaseAndMigration: [], classification: null,
    });
    expect(inspectCopilotGeneratedSummary(wrap(valid))).toMatchObject({ state: "valid" });
    const { classification: _classification, ...withoutClassification } = JSON.parse(valid);
    const missingClassification = JSON.stringify(withoutClassification);
    expect(inspectCopilotGeneratedSummary(wrap(missingClassification))).toMatchObject({
      state: "repairable",
      stage: "copilot-output-validate",
      reason: "Copilot输出字段校验失败：classification字段缺失",
    });
    expect(resolveCopilotGeneratedSummary(wrap(missingClassification))).toMatchObject({
      state: "repair-required",
      primaryFailureReason: "Copilot输出字段校验失败：classification字段缺失",
    });
    expect(resolveCopilotGeneratedSummary(wrap(missingClassification), wrap(valid))).toMatchObject({
      state: "adopted",
      mode: "copilot-repaired",
      classification: { state: "abstained" },
      primaryFailureReason: "Copilot输出字段校验失败：classification字段缺失",
    });
    expect(resolveCopilotGeneratedSummary(wrap(missingClassification), wrap(missingClassification))).toMatchObject({
      state: "fallback",
      fallbackReason: "Copilot输出字段校验失败：classification字段缺失",
      repairFailureReason: "Copilot修复输出字段校验失败：classification字段缺失",
    });
    const invalidChanges = JSON.stringify({ ...JSON.parse(valid), changes: ["太短"] });
    expect(resolveCopilotGeneratedSummary(wrap(invalidChanges))).toMatchObject({
      state: "repair-required",
      primaryFailureReason: "Copilot输出字段校验失败：changes[]长度或格式无效",
    });
    expect(resolveCopilotGeneratedSummary(wrap(invalidChanges), wrap(valid))).toMatchObject({
      state: "adopted",
      mode: "copilot-repaired",
      primaryFailureReason: "Copilot输出字段校验失败：changes[]长度或格式无效",
    });
    expect(resolveCopilotGeneratedSummary(wrap(invalidChanges), wrap(invalidChanges))).toMatchObject({
      state: "fallback",
      fallbackReason: "Copilot输出字段校验失败：changes[]长度或格式无效",
      repairFailureReason: "Copilot修复输出字段校验失败：changes[]长度或格式无效",
    });
    const invalidClassification = JSON.stringify({ ...JSON.parse(valid), classification: { primaryKind: "feature", confidence: "certain", evidence: [] } });
    expect(inspectCopilotGeneratedSummary(wrap(invalidClassification))).toMatchObject({ state: "valid", classification: { state: "invalid" } });
    expect(resolveCopilotGeneratedSummary(wrap(invalidClassification))).toMatchObject({ state: "adopted", mode: "copilot", classification: { state: "invalid" } });

    expect(normalizeCopilotJsonCandidate(`\n\uFEFF${valid}\n`)).toEqual({ candidate: valid, normalization: "none" });
    expect(normalizeCopilotJsonCandidate(`\n\`\`\`json\n${valid}\n\`\`\`\n`)).toEqual({ candidate: valid, normalization: "single-json-fence" });
    expect(inspectCopilotGeneratedSummary(wrap(`\`\`\`JSON\n${valid}\n\`\`\``))).toMatchObject({ state: "valid", normalization: "single-json-fence" });
    expect(resolveCopilotGeneratedSummary(wrap(`\`\`\`json\n${valid}\n\`\`\``))).toMatchObject({ state: "adopted", mode: "copilot", normalization: "single-json-fence" });

    const unsafeWrappers = [
      `说明\n\`\`\`json\n${valid}\n\`\`\``,
      `\`\`\`json\n${valid}\n\`\`\`\n说明`,
      `\`\`\`\n${valid}\n\`\`\``,
      `\`\`\`json\n${valid}\n\`\`\`\n\`\`\`json\n${valid}\n\`\`\``,
      `\`\`\`json\n\`\`\`json\n${valid}\n\`\`\`\n\`\`\``,
    ];
    for (const unsafeWrapper of unsafeWrappers) {
      expect(inspectCopilotGeneratedSummary(wrap(unsafeWrapper))).toMatchObject({ state: "repairable", stage: "copilot-output-parse" });
    }
    expect(inspectCopilotGeneratedSummary(wrap(unsafeWrappers[0]!))).toMatchObject({ reason: "Copilot输出JSON代码围栏无效" });
    expect(inspectCopilotGeneratedSummary(wrap("```json\n{\"type\":\n```"))).toMatchObject({ state: "repairable", stage: "copilot-output-parse", reason: "Copilot输出不是有效JSON", normalization: "single-json-fence" });

    const malformed = inspectCopilotGeneratedSummary(wrap(`${valid}\n额外说明`));
    expect(malformed).toMatchObject({ state: "repairable", stage: "copilot-output-parse" });
    if (malformed.state !== "repairable") throw new Error("畸形业务JSON没有进入修复状态");
    expect(malformed.reason).not.toContain("额外说明");

    const invalidFields = inspectCopilotGeneratedSummary(wrap(JSON.stringify({ type: "fix", scope: "pr" })));
    expect(invalidFields).toMatchObject({ state: "repairable", stage: "copilot-output-validate" });

    const toolEnvelope = inspectCopilotGeneratedSummary(wrap(valid, [{ toolCallId: "call-1", name: "bash" }]));
    expect(toolEnvelope).toEqual({ state: "rejected", stage: "copilot-output-envelope", reason: "Copilot输出传输封装无效" });

    const repaired = resolveCopilotGeneratedSummary(wrap(`${valid}\n额外说明`), wrap(valid));
    expect(repaired).toMatchObject({ state: "adopted", mode: "copilot-repaired" });
    if (repaired.state !== "adopted") throw new Error("有效修复结果没有被采用");
    expect(repaired.primaryFailureReason).toMatch(/^Copilot输出不是有效JSON/u);
    expect(resolveCopilotGeneratedSummary(wrap(`${valid}\n额外说明`), wrap(`\`\`\`json\n${valid}\n\`\`\``))).toMatchObject({ state: "adopted", mode: "copilot-repaired", normalization: "single-json-fence" });
    const repairFailed = resolveCopilotGeneratedSummary(wrap(`${valid}\n额外说明`), wrap("仍然不是JSON"));
    expect(repairFailed).toMatchObject({ state: "fallback", repairFailureReason: "Copilot修复输出不是有效JSON" });
    if (repairFailed.state !== "fallback") throw new Error("无效修复结果没有回退");
    expect(repairFailed.fallbackReason).toMatch(/^Copilot输出不是有效JSON/u);
  });

  it("修复判断和最终收敛使用同一份准备事实漂移校验", () => {
    const expected = { repositoryId: 1, sourceRef: "refs/heads/fix", headSha: "a".repeat(40), baseSha: "b".repeat(40), policySha: "c".repeat(40) };
    expect(() => assertPreparedCopilotFacts({ ...expected }, expected)).not.toThrow();
    expect(() => assertPreparedCopilotFacts({ ...expected, headSha: "d".repeat(40) }, expected)).toThrow("人工智能输入对应的分支事实已经漂移");
    expect(() => assertPreparedCopilotFacts(null, expected)).toThrow("人工智能输入对应的分支事实已经漂移");
  });

  it("区分Copilot修复步骤结果和输出读取失败阶段", () => {
    expect(describeCopilotRepairAvailability("success", "repair.jsonl")).toBeNull();
    expect(describeCopilotRepairAvailability("success", undefined)).toBe("失败（Copilot修复输出路径缺失）");
    expect(describeCopilotRepairAvailability(undefined, "repair.jsonl")).toBe("未运行（未收到Copilot修复步骤结果）");
    expect(describeCopilotRepairAvailability("skipped", "repair.jsonl")).toBe("未运行（Copilot修复步骤已跳过）");
    expect(describeCopilotRepairAvailability("cancelled", "repair.jsonl")).toBe("未完成（Copilot修复步骤已取消）");
    expect(describeCopilotRepairAvailability("failure", "repair.jsonl")).toBe("失败（Copilot修复命令执行失败）");
    expect(describeCopilotRepairAvailability("unexpected", "repair.jsonl")).toBe("未完成（Copilot修复步骤结果无效）");
    expect(describeCopilotRepairOutputFailure("read")).toBe("失败（Copilot修复输出文件无法读取）");
    expect(describeCopilotRepairOutputFailure("envelope")).toBe("失败（Copilot修复输出传输封装无效）");
  });

  it("Copilot说明只忽略Git检出产生的CRLF差异", () => {
    const generated = "第一行\n第二行\n";
    expect(matchesGeneratedCopilotInstructions("第一行\r\n第二行\r\n", generated)).toBe(true);
    expect(matchesGeneratedCopilotInstructions("第一行\n第二行\n", generated)).toBe(true);
    expect(matchesGeneratedCopilotInstructions("第一行\r第二行\r", generated)).toBe(false);
    expect(matchesGeneratedCopilotInstructions("第一行\r\n修改内容\r\n", generated)).toBe(false);
    expect(matchesGeneratedCopilotInstructions("第一行\r\n第二行", generated)).toBe(false);
  });

  it("仅Steward中央仓库从候选工作区读取Copilot说明源", () => {
    const workspace = join(tmpdir(), "candidate-steward");
    const configuredDirectory = process.env.STEWARD_CONFIG_DIRECTORY;
    delete process.env.STEWARD_CONFIG_DIRECTORY;
    try {
      expect(copilotInstructionSourcePath(1296724484, workspace, "common.md")).toBe(join(workspace, "config", "copilot", "common.md"));
      expect(copilotInstructionSourcePath(1296724484, workspace, "layerscape.md")).toBe(join(workspace, "config", "copilot", "layerscape.md"));
      expect(copilotInstructionSourcePath(1187527897, workspace, "common.md")).toMatch(/config[\\/]copilot[\\/]common\.md$/u);
      expect(copilotInstructionSourcePath(1187527897, workspace, "common.md")).not.toBe(join(workspace, "config", "copilot", "common.md"));
      expect(copilotInstructionSourcePath(1296725317, workspace, "common.md")).toMatch(/config[\\/]copilot[\\/]common\.md$/u);
      expect(copilotInstructionSourcePath(1296725317, workspace, "common.md")).not.toBe(join(workspace, "config", "copilot", "common.md"));
    } finally {
      if (configuredDirectory === undefined) delete process.env.STEWARD_CONFIG_DIRECTORY;
      else process.env.STEWARD_CONFIG_DIRECTORY = configuredDirectory;
    }
  });

  it("Git空白检查接受CRLF并继续拒绝真正的行尾空格", async () => {
    const repository = await mkdtemp(join(tmpdir(), "steward-git-diff-check-"));
    const runGit = (args: string[]) => spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    const requireGit = (args: string[]) => {
      const result = runGit(args);
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")}失败`).trim());
      return result.stdout.trim();
    };
    try {
      requireGit(["init", "--quiet"]);
      requireGit(["config", "user.name", "SPLRAD Steward Tests"]);
      requireGit(["config", "user.email", "tests@splrad.invalid"]);
      requireGit(["config", "core.autocrlf", "false"]);
      const file = join(repository, "sample.txt");
      await writeFile(file, "value=1\r\n", "utf8");
      requireGit(["add", "sample.txt"]);
      requireGit(["commit", "--quiet", "-m", "base"]);
      const base = requireGit(["rev-parse", "HEAD"]);

      await writeFile(file, "value=2\r\n", "utf8");
      requireGit(["add", "sample.txt"]);
      requireGit(["commit", "--quiet", "-m", "crlf"]);
      expect(gitDiffCheckArguments(base)).toEqual([
        "-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol",
        "diff", "--check", `${base}...HEAD`,
      ]);
      expect(gitDiffCheckArguments()).toEqual([
        "-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol",
        "diff", "--check",
      ]);
      expect(runGit(gitDiffCheckArguments(base)).status).toBe(0);

      await writeFile(file, "value=3 \r\n", "utf8");
      requireGit(["add", "sample.txt"]);
      requireGit(["commit", "--quiet", "-m", "real trailing whitespace"]);
      const invalid = runGit(gitDiffCheckArguments(base));
      expect(invalid.status).not.toBe(0);
      expect(invalid.stdout).toContain("trailing whitespace");

      await writeFile(file, "value=4\n", "utf8");
      requireGit(["add", "sample.txt"]);
      requireGit(["commit", "--quiet", "-m", "lf"]);
      expect(runGit(gitDiffCheckArguments(base)).status).toBe(0);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("中央验证拒绝已经落后于当前目标分支的旧合并候选", async () => {
    const repository = await mkdtemp(join(tmpdir(), "steward-validation-base-"));
    const runGit = (args: string[]) => spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    const requireGit = (args: string[]) => {
      const result = runGit(args);
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")}失败`).trim());
      return result.stdout.trim();
    };
    try {
      requireGit(["init", "--quiet"]);
      requireGit(["config", "user.name", "SPLRAD Steward Tests"]);
      requireGit(["config", "user.email", "tests@splrad.invalid"]);
      await writeFile(join(repository, "sample.txt"), "base\n", "utf8");
      requireGit(["add", "sample.txt"]);
      requireGit(["commit", "--quiet", "-m", "base"]);
      const eventBase = requireGit(["rev-parse", "HEAD"]);
      requireGit(["update-ref", "refs/remotes/origin/main", eventBase]);
      expect(assertFreshValidationBase(repository, eventBase, "main")).toBe(eventBase);

      await writeFile(join(repository, "sample.txt"), "current\n", "utf8");
      requireGit(["add", "sample.txt"]);
      requireGit(["commit", "--quiet", "-m", "current"]);
      const currentBase = requireGit(["rev-parse", "HEAD"]);
      requireGit(["update-ref", "refs/remotes/origin/main", currentBase]);
      expect(() => assertFreshValidationBase(repository, eventBase, "main"))
        .toThrow(`基础分支已更新；当前运行基于${eventBase}，main现为${currentBase}，请更新拉取请求分支后重新验证`);
      expect(() => assertFreshValidationBase(repository, eventBase, "../main")).toThrow("基础分支引用无效");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("基础分支摘要无论写入成功失败都保留原始校验错误", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steward-validation-summary-"));
    const primary = new Error("基础分支已更新");
    process.env.GITHUB_STEP_SUMMARY = join(directory, "missing", "summary.md");
    try {
      await expect(throwFreshValidationBaseFailure(primary)).rejects.toBe(primary);
      const summaryPath = join(directory, "summary.md");
      process.env.GITHUB_STEP_SUMMARY = summaryPath;
      await expect(throwFreshValidationBaseFailure(primary)).rejects.toBe(primary);
      expect(await readFile(summaryPath, "utf8")).toBe("# SPLRAD Steward / PR Validation\n\n- ❌ verify-base-freshness: 基础分支已更新\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("工作流允许清单与仓库当前文件必须逐项一致", () => {
    const allowed = [".github/workflows/current.yml"];
    expect(() => assertWorkflowPaths(allowed, allowed)).not.toThrow();
    expect(() => assertWorkflowPaths([], allowed)).toThrow("缺少：.github/workflows/current.yml；未允许：无");
    expect(() => assertWorkflowPaths([...allowed, ".github/workflows/unknown.yml"], allowed)).toThrow("缺少：无；未允许：.github/workflows/unknown.yml");
  });

  it("识别平台实际返回的Copilot身份并给分类令牌完整的拉取请求写权限", () => {
    for (const identity of ["Copilot", "copilot", "copilot-pull-request-reviewer", "copilot-pull-request-reviewer[bot]"]) {
      expect(isCopilotReviewerIdentity(identity)).toBe(true);
    }
    for (const identity of ["copilot-agent[bot]", "splrad-steward[bot]", "maintainers", ""]) {
      expect(isCopilotReviewerIdentity(identity)).toBe(false);
    }
    expect(hasRequestedCopilotReviewer({ users: [{ login: "Copilot" }] })).toBe(true);
    expect(hasRequestedCopilotReviewer({ users: [{ login: "copilot-pull-request-reviewer[bot]" }] })).toBe(true);
    expect(hasRequestedCopilotReviewer({ users: [], teams: [{ slug: "copilot" }] } as any)).toBe(false);
    expect(hasNewCopilotRequestEvent([
      { id: 9, event: "review_requested", requested_reviewer: { login: "Copilot" } },
      { id: 11, event: "review_requested", requested_reviewer: { login: "human" } },
    ], 10)).toBe(false);
    expect(hasNewCopilotRequestEvent([{ id: 11, event: "review_requested", requested_reviewer: { login: "Copilot" } }], 10)).toBe(true);
    expect(hasNewCopilotRequestEvent([{ id: 12, event: "copilot_work_started" }], 10)).toBe(true);
    expect(classificationInstallationPermissions()).toEqual({
      contents: "read",
      pull_requests: "write",
      issues: "write",
      checks: "write",
      metadata: "read",
    });
    expect(classificationInstallationPermissions("observe")).toEqual({
      contents: "read",
      pull_requests: "read",
      issues: "read",
      checks: "write",
      metadata: "read",
    });
    expect(prAutomationInstallationPermissions()).toEqual({
      contents: "read",
      pull_requests: "write",
      issues: "read",
      checks: "read",
      metadata: "read",
    });
  });

  it("只接受绑定当前拉取请求和当前提交的活动Copilot检查", () => {
    const activeCopilotCheck = {
      name: "copilot-pull-request-reviewer",
      app: { id: 15368, slug: "github-actions" },
      head_sha: "a".repeat(40),
      status: "in_progress",
      pull_requests: [{ number: 7, head: { sha: "a".repeat(40) } }],
    };
    expect(hasActiveCopilotCheckRun([activeCopilotCheck], 7, "a".repeat(40))).toBe(true);
    expect(hasActiveCopilotCheckRun([{ ...activeCopilotCheck, status: "queued" }], 7, "a".repeat(40))).toBe(true);
    expect(hasActiveCopilotCheckRun([{ ...activeCopilotCheck, status: "completed", conclusion: "success" }], 7, "a".repeat(40))).toBe(false);
    expect(hasActiveCopilotCheckRun([{ ...activeCopilotCheck, app: { id: 4243096, slug: "splrad-steward" } }], 7, "a".repeat(40))).toBe(false);
    expect(hasActiveCopilotCheckRun([{ ...activeCopilotCheck, head_sha: "b".repeat(40) }], 7, "a".repeat(40))).toBe(false);
    expect(hasActiveCopilotCheckRun([{ ...activeCopilotCheck, pull_requests: [{ number: 8, head: { sha: "a".repeat(40) } }] }], 7, "a".repeat(40))).toBe(false);
    expect(hasActiveCopilotCheckRun([{ ...activeCopilotCheck, pull_requests: [] }], 7, "a".repeat(40))).toBe(false);
  });

  it("已有受管文件内容相同时复用当前来源提交且不重置分支", async () => {
    const calls: string[] = [];
    const client = {
      compare: async () => ({ merge_base_commit: { sha: "a".repeat(40) }, ahead_by: 1, total_commits: 1, commits: [{}], files: [{ filename: ".github/copilot-instructions.md" }] }),
      getContent: async () => ({ encoding: "base64", content: Buffer.from("相同内容", "utf8").toString("base64"), sha: "f".repeat(40) }),
      createRef: async () => { calls.push("createRef"); },
      putContent: async () => { calls.push("putContent"); return { commit: { sha: "c".repeat(40) } }; },
      updateRef: async () => { calls.push("updateRef"); },
    } as any;
    await expect(writeManagedFileToBranch({ gh: client, owner: "splrad", repo: ".github", path: ".github/copilot-instructions.md", content: "相同内容", branch: "steward/repository-onboarding", title: "接入", defaultSha: "a".repeat(40), branchSha: "b".repeat(40) })).resolves.toEqual({ changed: false, headSha: "b".repeat(40) });
    expect(calls).toEqual([]);
  });

  it("已有受管文件变化时直接在来源分支提交且不经过默认分支", async () => {
    const calls: Array<{ name: string; body?: any }> = [];
    const client = {
      compare: async () => ({ merge_base_commit: { sha: "a".repeat(40) }, ahead_by: 1, total_commits: 1, commits: [{}], files: [{ filename: ".github/copilot-instructions.md" }] }),
      getContent: async () => ({ encoding: "base64", content: Buffer.from("旧内容", "utf8").toString("base64"), sha: "f".repeat(40) }),
      createRef: async () => { calls.push({ name: "createRef" }); },
      putContent: async (_owner: string, _repo: string, _path: string, body: any) => { calls.push({ name: "putContent", body }); return { commit: { sha: "c".repeat(40) } }; },
      updateRef: async () => { calls.push({ name: "updateRef" }); },
    } as any;
    await expect(writeManagedFileToBranch({ gh: client, owner: "splrad", repo: ".github", path: ".github/copilot-instructions.md", content: "新内容", branch: "steward/repository-onboarding", title: "接入", defaultSha: "a".repeat(40), branchSha: "b".repeat(40) })).resolves.toEqual({ changed: true, headSha: "c".repeat(40) });
    expect(calls).toEqual([{ name: "putContent", body: { message: "接入", content: Buffer.from("新内容", "utf8").toString("base64"), branch: "steward/repository-onboarding", sha: "f".repeat(40) } }]);
  });

  it("默认分支前进时只按共同基准校验受管分支自己的改动", async () => {
    const comparisons: string[] = [];
    const mergeBaseSha = "9".repeat(40);
    const client = {
      compare: async (_owner: string, _repo: string, base: string) => {
        comparisons.push(base);
        return base === "a".repeat(40)
          ? { merge_base_commit: { sha: mergeBaseSha }, ahead_by: 1, total_commits: 1, commits: [{}], files: [{ filename: "默认分支新增文件" }, { filename: ".github/copilot-instructions.md" }] }
          : { merge_base_commit: { sha: mergeBaseSha }, ahead_by: 1, total_commits: 1, commits: [{}], files: [{ filename: ".github/copilot-instructions.md" }] };
      },
      getContent: async () => ({ encoding: "base64", content: Buffer.from("目标内容", "utf8").toString("base64"), sha: "f".repeat(40) }),
    } as any;
    await expect(writeManagedFileToBranch({ gh: client, owner: "splrad", repo: ".github", path: ".github/copilot-instructions.md", content: "目标内容", branch: "steward/repository-onboarding", title: "接入", defaultSha: "a".repeat(40), branchSha: "b".repeat(40) })).resolves.toEqual({ changed: false, headSha: "b".repeat(40) });
    expect(comparisons).toEqual(["a".repeat(40), mergeBaseSha]);
  });

  it("首次写入后重复运行只创建一次提交", async () => {
    let content: string | null = null;
    let headSha = "a".repeat(40);
    let writes = 0;
    const client = {
      compare: async () => ({ merge_base_commit: { sha: "a".repeat(40) }, ahead_by: 1, total_commits: 1, commits: [{}], files: [{ filename: ".github/copilot-instructions.md" }] }),
      getContent: async () => content === null ? null : ({ encoding: "base64", content: Buffer.from(content, "utf8").toString("base64"), sha: "f".repeat(40) }),
      createRef: async () => undefined,
      putContent: async (_owner: string, _repo: string, _path: string, body: any) => { writes += 1; content = Buffer.from(body.content, "base64").toString("utf8"); headSha = "b".repeat(40); return { commit: { sha: headSha } }; },
    } as any;
    const first = await writeManagedFileToBranch({ gh: client, owner: "splrad", repo: ".github", path: ".github/copilot-instructions.md", content: "目标内容", branch: "steward/repository-onboarding", title: "接入", defaultSha: "a".repeat(40), branchSha: null });
    const second = await writeManagedFileToBranch({ gh: client, owner: "splrad", repo: ".github", path: ".github/copilot-instructions.md", content: "目标内容", branch: "steward/repository-onboarding", title: "接入", defaultSha: "a".repeat(40), branchSha: headSha });
    expect(first).toEqual({ changed: true, headSha: "b".repeat(40) });
    expect(second).toEqual({ changed: false, headSha: "b".repeat(40) });
    expect(writes).toBe(1);
  });

  it("受管分支与开放拉取请求必须成对且拉取请求必须属于Steward", () => {
    const stewardPull = { user: { id: 301115370 }, merged_at: null };
    expect(() => assertManagedBranchPull(false, undefined, "steward/repository-onboarding")).not.toThrow();
    expect(() => assertManagedBranchPull(false, stewardPull, "steward/repository-onboarding")).not.toThrow();
    expect(() => assertManagedBranchPull(true, stewardPull, "steward/repository-onboarding")).not.toThrow();
    expect(() => assertManagedBranchPull(true, undefined, "steward/repository-onboarding")).toThrow("受管分支不是Steward拥有的开放拉取请求");
    expect(() => assertManagedBranchPull(false, { user: { id: 44151430 }, merged_at: null }, "steward/repository-onboarding")).toThrow("受管分支不是Steward拥有的开放拉取请求");
    expect(() => assertManagedBranchPull(false, { user: { id: 301115370 }, merged_at: "2026-08-17T00:00:00Z" }, "steward/repository-onboarding")).toThrow("受管分支不是Steward拥有的开放拉取请求");
  });

  it("四个结构文件接受全部中央配置并拒绝额外字段", async () => {
    const pairs = [
      ["config/repositories.json", "schema/repositories.schema.json"],
      ["config/profiles/classification/default.json", "schema/classification-profile.schema.json"],
      ["config/profiles/classification/layerscape.json", "schema/classification-profile.schema.json"],
      ["config/profiles/validation/public-basic.json", "schema/validation-profile.schema.json"],
      ["config/profiles/validation/layerscape.json", "schema/validation-profile.schema.json"],
      ["config/profiles/validation/steward.json", "schema/validation-profile.schema.json"],
      ["config/profiles/release/layerscape.json", "schema/release-profile.schema.json"],
    ] as const;
    for (const [dataPath, schemaPath] of pairs) {
      const ajv = new Ajv({ allErrors: true, strict: true });
      addFormats(ajv);
      const data = JSON.parse(await readFile(dataPath, "utf8"));
      const schema = JSON.parse(await readFile(schemaPath, "utf8"));
      const validate = ajv.compile(schema);
      expect(validate(data), dataPath).toBe(true);
      const invalid = structuredClone(data);
      invalid.unexpectedField = true;
      expect(validate(invalid), `${dataPath}反例`).toBe(false);
    }
    const repositories = JSON.parse(await readFile("config/repositories.json", "utf8"));
    const schema = JSON.parse(await readFile("schema/repositories.schema.json", "utf8"));
    const ajv = new Ajv({ allErrors: true, strict: true }); addFormats(ajv);
    const validate = ajv.compile(schema);
    repositories.repositories["1296724484"].copilotInstructionsProfile = "unregistered";
    expect(validate(repositories)).toBe(false);
  });

  it("中央配置黄金事实逐字冻结", async () => {
    const repositories = JSON.parse(await readFile("config/repositories.json", "utf8"));
    const release = JSON.parse(await readFile("config/profiles/release/layerscape.json", "utf8"));
    expect(repositories.organization).toEqual({ id: 302208797, login: "splrad" });
    expect(repositories.defaults.public).toMatchObject({ managed: true, prAutomation: true, validationProfile: "public-basic", releaseProfile: null });
    expect(Object.keys(repositories.repositories).sort()).toEqual(["1187527897", "1296724484", "1296725317"]);
    expect(release.build.projects.map((value: any) => value.path)).toEqual(Array.from({ length: 10 }, (_, index) => {
      const year = 2018 + index;
      return `src/AutoCAD/AFR-ACAD${year}/AFR-ACAD${year}.csproj`;
    }));
    expect(release.assets.map((value: any) => value.nameTemplate)).toEqual(["AFR-Deployer_v{displayVersion}.exe", "AFR-DLL_v{displayVersion}.zip", "Fonts.zip"]);
    expect(release.releaseNotes.excludedLabels).toEqual(["ignore-for-release", "skip-changelog", "no-changelog", "no-release-notes"]);
  });

  it("实现冻结完整比较、唯一拉取请求、漂移和同名检查失败保护", async () => {
    const source = await readFile("packages/runner/src/index.ts", "utf8");
    for (const fragment of [
      "提交比较结果未完整返回",
      "文件比较达到接口上限",
      "同一来源分支存在多个匹配拉取请求",
      "读取期间来源或目标分支已经漂移",
      "人工智能输入对应的分支事实已经漂移",
      "人工智能回退原因：",
      "人工智能输出证据：",
      "同名分类检查存在歧义",
      "分类输入在写入期间已经漂移",
      "TRIGGER_ACTOR_ID === \"301115370\"",
      "AI处理状态：",
      "LayerScape不可变发布尚未启用",
      "当前默认分支第一父提交链",
    ]) expect(source).toContain(fragment);
    expect(source).not.toMatch(/heads\/main|base\.ref\s*!==\s*"main"|default_branch\s*!==\s*"main"/u);
    expect(source).toMatch(/if\s*\(labelPlan\.add\.length\)\s*await gh\.addLabels\(owner, repo, number, labelPlan\.add\);/u);
    expect(source).not.toMatch(/for\s*\([^)]*labelPlan\.add[^)]*\)\s*await gh\.addLabels/u);
    const automateSource = source.slice(source.indexOf("async function automate"), source.indexOf("async function classify"));
    const defaultBranchIgnore = automateSource.indexOf("sourceBranch === repository.default_branch");
    const classificationProfileRead = automateSource.indexOf('configPath("profiles", "classification"');
    expect(defaultBranchIgnore).toBeGreaterThanOrEqual(0);
    expect(classificationProfileRead).toBeGreaterThan(defaultBranchIgnore);
  });

  it("终态没有普通评论写入、旧包或旧运行目录", async () => {
    const sourceFiles = [
      "packages/runner/src/index.ts",
      "packages/runtime/src/index.ts",
      "packages/github/src/client.ts",
      "packages/core/src/automation.ts",
    ];
    const source = (await Promise.all(sourceFiles.map(path => readFile(path, "utf8")))).join("\n");
    expect(source).not.toMatch(/createComment|updateComment/iu);
    const commentWritePattern = /request(?:<[^>]*>)?\s*\(\s*["'](?:POST|PATCH|DELETE)["']\s*,\s*`\/repos\/\$\{owner\}\/\$\{repo\}\/issues\/\$\{number\}\/comments/iu;
    expect(source).not.toMatch(commentWritePattern);
    for (const forbidden of [
      'client.request("POST", `/repos/${owner}/${repo}/issues/${number}/comments`)',
      "client.request<any> ( 'PATCH' , `/repos/${owner}/${repo}/issues/${number}/comments/7`)",
    ]) expect(forbidden).toMatch(commentWritePattern);
    expect(source).toMatch(/paginateWithValidators(?:<[^>]*>)?\(\s*["']comments["']\s*,\s*`\/repos\/\$\{owner\}\/\$\{repo\}\/issues\/\$\{number\}\/comments\?per_page=100`\s*\)/u);
    for (const path of [
      "action",
      "packages/access-auth",
      "packages/cli",
      "packages/control",
      "packages/control-runtime",
      "packages/coordinator",
      "packages/diagnostics",
      "packages/ingress",
      "packages/manifest",
      "packages/promotion",
      "packages/recovery",
      "packages/relay",
    ]) await expect(stat(path)).rejects.toThrow();
  });

  it("工作流摘要代码不输出密钥或令牌值", async () => {
    const source = await readFile("packages/runner/src/index.ts", "utf8");
    const summaries = source.split("\n").filter(line => line.includes("summary([")).join("\n");
    expect(summaries).not.toMatch(/STEWARD_APP_PRIVATE_KEY|COPILOT_REVIEW_REQUEST_TOKEN|installation-token|upload_url/iu);
  });

  it("Runner内所有议题关联派发都显式传递未纳管清理模式", async () => {
    const source = await readFile("packages/runner/src/index.ts", "utf8");
    const dispatches = [...source.matchAll(/dispatchCentralWorkflow\("pr-issue-link\.yml"/gu)];
    expect(dispatches).toHaveLength(5);
    const modes = dispatches.map(dispatch => /cleanupUnmanaged:\s*"(true|false)"/u.exec(source.slice(dispatch.index, dispatch.index + 700))?.[1]);
    expect(modes.sort()).toEqual(["false", "false", "false", "false", "true"]);
  });

  it("PR自动化正文写入后显式重调度议题关联", async () => {
    const source = await readFile("packages/runner/src/index.ts", "utf8");
    const automation = source.slice(source.indexOf("async function automate("), source.indexOf("async function classify("));
    const bodyWrite = automation.indexOf("updatePullRequestBodyDurably(");
    const dispatch = automation.indexOf('dispatchCentralWorkflow("pr-issue-link.yml"');
    const copilot = automation.indexOf("ensureCopilotReview(", dispatch);
    const classification = automation.indexOf("dispatchClassification(", dispatch);
    expect(bodyWrite).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(bodyWrite);
    expect(copilot).toBeGreaterThan(dispatch);
    expect(classification).toBeGreaterThan(dispatch);
    expect(automation.slice(dispatch, dispatch + 700)).toMatch(/pullRequestNumber:\s*String\(pull\.number\)[\s\S]*cleanupUnmanaged:\s*"false"/u);
  });
});

describe("议题快照同步", () => {
  it("目标仓库令牌只申请Issues和Metadata读取权限", () => {
    expect(issueSyncInstallationPermissions()).toEqual({ issues: "read", metadata: "read" });
  });

  function dependencies(input: {
    live?: readonly number[];
    stored?: readonly number[];
    refresh?: (issueNumber: number) => { changed?: boolean; deleted?: boolean; generation: number };
    failReady?: boolean;
    failDispatch?: boolean;
    failDispatchOnce?: boolean;
    initialState?: "uninitialized" | "scanning" | "ready" | "degraded";
  } = {}) {
    const states: string[] = [];
    const refreshed: number[] = [];
    let dispatched = 0;
    let released = 0;
    let pendingGeneration: number | null = null;
    let pendingStateRevision: number | null = null;
    return {
      states, refreshed, dispatched: () => dispatched, released: () => released,
      value: {
        listLiveOpenIssues: async () => ({ numbers: input.live ?? [], skipped: 2 }),
        getState: async () => ({ repositoryId: 1296724484, generation: 4, syncState: input.initialState ?? "ready", reconciliationGeneration: pendingGeneration, reconciliationStateRevision: pendingStateRevision, snapshots: (input.stored ?? []).map(issueNumber => ({ issueNumber })) }),
        setScanState: async (state: "scanning" | "ready" | "degraded") => {
          states.push(state);
          if (state === "ready" && input.failReady) throw new Error("开放集合未收敛");
          if (state === "ready") { pendingGeneration = 7; pendingStateRevision = 9; }
          return { repositoryId: 1296724484, generation: 7, syncState: state, snapshots: [] };
        },
        refresh: async (issueNumber: number) => {
          refreshed.push(issueNumber);
          const result = input.refresh?.(issueNumber) ?? { changed: false, generation: 4 };
          if (result.changed === true || result.deleted === true) pendingGeneration = result.generation;
          return { repositoryId: 1296724484, issueNumber, ...result };
        },
        dispatchFormalReconciliation: async (generation: number) => {
          if (pendingGeneration !== generation) throw new Error("待处理代次不一致");
          dispatched++;
          if (input.failDispatch || (input.failDispatchOnce && dispatched === 1)) throw new Error("工作流派发失败");
        },
        releaseFormalReconciliation: async (generation: number, stateRevision: number) => {
          if (pendingGeneration !== generation || pendingStateRevision !== stateRevision) throw new Error("待释放重算请求不一致");
          released++;
        },
      },
    };
  }

  it("单议题在失效后即使内容未变也创建并调度同代次重算", async () => {
    const changed = dependencies({ refresh: () => ({ changed: true, generation: 5 }) });
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, issueNumber: 8, scanAll: false }, changed.value)).resolves.toEqual(expect.objectContaining({ refreshed: 1, changed: 1, generation: 7, dispatched: true }));
    expect(changed.dispatched()).toBe(1);
    expect(changed.states).toEqual(["scanning", "ready"]);
    const duplicate = dependencies({ refresh: () => ({ changed: false, generation: 5 }) });
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, issueNumber: 8, scanAll: false }, duplicate.value)).resolves.toEqual(expect.objectContaining({ changed: 0, generation: 7, dispatched: true }));
    expect(duplicate.dispatched()).toBe(1);
    expect(duplicate.states).toEqual(["scanning", "ready"]);
    const uninitialized = dependencies({ initialState: "uninitialized", live: [8], refresh: () => ({ changed: true, generation: 5 }) });
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, issueNumber: 8, scanAll: false }, uninitialized.value)).resolves.toEqual(expect.objectContaining({ issueNumber: null, dispatched: true }));
    expect(uninitialized.states).toEqual(["scanning", "ready"]);
  });

  it("全量同步对GitHub与D1开放集合取并集并修复漏关闭或删除", async () => {
    const fixture = dependencies({ live: [1, 2], stored: [2, 3], refresh: issueNumber => issueNumber === 3 ? { deleted: true, generation: 7 } : { changed: true, generation: 4 + issueNumber } });
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, scanAll: true }, fixture.value)).resolves.toEqual({ repositoryId: 1296724484, issueNumber: null, refreshed: 3, skipped: 2, changed: 3, generation: 7, dispatched: true });
    expect(fixture.refreshed).toEqual([1, 2, 3]);
    expect(fixture.states).toEqual(["scanning", "ready"]);
    expect(fixture.dispatched()).toBe(1);
  });

  it("空仓也收敛为ready，失败则尽力标记degraded", async () => {
    const empty = dependencies();
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, scanAll: true }, empty.value)).resolves.toEqual(expect.objectContaining({ refreshed: 0, changed: 0, generation: 7, dispatched: true }));
    expect(empty.states).toEqual(["scanning", "ready"]);
    const failed = dependencies({ failReady: true });
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, scanAll: true }, failed.value)).rejects.toThrow("开放集合未收敛");
    expect(failed.states).toEqual(["scanning", "ready", "degraded"]);
    expect(failed.dispatched()).toBe(0);
    const dispatchFailed = dependencies({ failDispatch: true });
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, scanAll: true }, dispatchFailed.value)).rejects.toThrow("工作流派发失败");
    expect(dispatchFailed.states).toEqual(["scanning", "ready"]);
    expect(dispatchFailed.dispatched()).toBe(1);
    expect(dispatchFailed.released()).toBe(1);
  });

  it("派发失败后保留D1待处理代次，重试即使内容未变也会再次派发", async () => {
    const fixture = dependencies({ refresh: () => ({ changed: true, generation: 5 }), failDispatchOnce: true });
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, issueNumber: 8, scanAll: false }, fixture.value)).rejects.toThrow("工作流派发失败");
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, issueNumber: 8, scanAll: false }, fixture.value)).resolves.toEqual(expect.objectContaining({ dispatched: true }));
    expect(fixture.dispatched()).toBe(2);
    expect(fixture.released()).toBe(1);
  });

  it("派发成功后仍保留D1待处理代次，由正式收敛成功路径另行确认", async () => {
    const fixture = dependencies({ refresh: () => ({ changed: true, generation: 5 }) });
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, issueNumber: 8, scanAll: false }, fixture.value)).resolves.toEqual(expect.objectContaining({ dispatched: true }));
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, issueNumber: 8, scanAll: false }, fixture.value)).resolves.toEqual(expect.objectContaining({ dispatched: true }));
    expect(fixture.dispatched()).toBe(2);
  });

  it("拒绝重复开放编号和互相矛盾的单项参数", async () => {
    const duplicate = dependencies({ live: [1, 1] });
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, scanAll: true }, duplicate.value)).rejects.toThrow("GitHub开放议题集合无效");
    expect(duplicate.states).toEqual(["scanning", "degraded"]);
    await expect(reconcileIssueSnapshots({ repositoryId: 1296724484, issueNumber: 1, scanAll: true }, dependencies().value)).rejects.toThrow("参数不一致");
  });
});
