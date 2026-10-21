import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateReviewInstructionSet } from "../../core/src/review-instructions.js";
import { assertFreshValidationBase, assertManagedBranchPull, classificationInstallationPermissions, decodeAiClassificationPayload, decodeClassificationCheckState, encodeAiClassificationPayload, encodeClassificationCheckState, env, gitDiffCheckArguments, hasActiveCopilotCheckRun, hasNewCopilotRequestEvent, hasRequestedCopilotReviewer, isCopilotReviewerIdentity, isTrustedAiClassificationSource, main, matchesGeneratedReviewInstructions, parseInvocation, renderAiClassificationEvidence, reusedAiClassificationAssessment, reviewInstructionSyncInstallationPermissions, reviewRegistryPaths, throwFreshValidationBaseFailure, writeManagedFilesToBranch } from "../src/index.js";

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
  it("退役片段命令在读取网络或令牌前拒绝", async () => {
    process.env.STEWARD_CONFIG_DIRECTORY = resolve("config");
    const transport = vi.fn(() => { throw new Error("unexpected network"); });
    vi.stubGlobal("fetch", transport);
    await expect(main(["validate", "--workspace", ".", "--repository-id", "1296724484", "--profile", "steward", "--fragments-only", "true"])).rejects.toThrow("未知参数");
    expect(transport).not.toHaveBeenCalled();
  });
  it("产品构建命令接收工作流中的 build-id", () => {
    const continuation = parseInvocation(['release-candidate', '--operation', 'generator-continue', '--artifact-id', '123', '--run-id', '456']);
    expect(continuation.args['artifact-id']).toBe('123');
    expect(continuation.args['run-id']).toBe('456');
    expect(parseInvocation(["release-build", "--operation", "plan-product", "--build-id", "release"]).args["build-id"]).toBe("release");
  });
  it("只接受现行命令及其已知、唯一、成对参数", () => {
    const commands = ["managed-repository-ids", "onboard-repository", "pr-classification", "request-copilot-review", "sync-review-instructions", "sync-managed-labels", "validate", "release-candidate"];
    for (const command of commands) expect(parseInvocation([command]).command).toBe(command);
    expect(() => parseInvocation(["unknown"])).toThrow("未知命令");
    expect(() => parseInvocation(["validate", "--unknown", "x"])).toThrow("未知参数");
    expect(() => parseInvocation(["validate", "--workspace"])).toThrow("参数格式");
    expect(() => parseInvocation(["validate", "--workspace", "a", "--workspace", "b"])).toThrow("重复参数");
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

  it("接入失败保留标签错误且不派发议题同步", async () => {
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
    const reviewProfiles = JSON.parse(await readFile(resolve("config", "review", "profiles.json"), "utf8"));
    const reviewRules = JSON.parse(await readFile(resolve("config", "review", "rules.json"), "utf8"));
    delete reviewProfiles.$schema;
    delete reviewRules.$schema;
    const generated = await generateReviewInstructionSet("steward", reviewProfiles, reviewRules);
    const instructions = Object.fromEntries(generated.files.map(file => [file.path, file.content]));
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
      for (const [path, content] of Object.entries(instructions)) if (value.includes(`/repos/splrad/steward/contents/${path}?ref=${"b".repeat(40)}`)) return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") }), { status: 200 });
      for (const file of generated.retiredFiles ?? []) if (value.includes(`/repos/splrad/steward/contents/${file.path}?ref=${"b".repeat(40)}`)) return new Response("Not Found", { status: 404 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/issue-sync.yml/dispatches")) return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    });

    await expect(main([
      "onboard-repository", "--repository-id", String(repositoryId), "--repository-full-name", "splrad/steward",
      "--trigger", "repository-visibility-changed", "--delivery-id", "onboard-label-failure", "--policy-sha", policySha,
    ])).rejects.toThrow("受管标签同步失败: splrad/steward");
    const dispatch = calls.find(call => call.url.endsWith("/repos/splrad/steward/actions/workflows/issue-sync.yml/dispatches"));
    expect(dispatch).toBeUndefined();
  });

  it("退役议题同步入口在处理编号前拒绝运行", async () => {
    await expect(main([
      "issue-sync",
      "--delivery-id", "delivery-unsafe-integer",
      "--repository-id", "9007199254740993",
      "--scan-all", "true",
      "--policy-sha", "a".repeat(40),
    ])).rejects.toThrow("未知命令");
  });



  it("缺失环境变量立即失败", () => {
    expect(() => env("TEST_REQUIRED_ENV")).toThrow("缺少环境变量");
    process.env.TEST_REQUIRED_ENV = "present";
    expect(env("TEST_REQUIRED_ENV")).toBe("present");
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



  it("AI分类来源必须绑定App触发者、Steward工作流和当前策略提交", () => {
    const policySha = "a".repeat(40);
    const trusted = { TRIGGER_ACTOR_ID: "301115370", WORKFLOW_REPOSITORY: "splrad/steward", WORKFLOW_EVENT: "workflow_dispatch", WORKFLOW_REF: "splrad/steward/.github/workflows/pr-classification.yml@refs/heads/trunk", WORKFLOW_RUN_REF: "refs/heads/trunk", WORKFLOW_SHA: policySha };
    expect(isTrustedAiClassificationSource(policySha, trusted)).toBe(true);
    for (const key of Object.keys(trusted)) expect(isTrustedAiClassificationSource(policySha, { ...trusted, [key]: "untrusted" })).toBe(false);
  });

  it("只接受规范编码且字段完整的Check v4分类状态", () => {
    const codec = { primaryKinds: ["feature", "bug"], riskFlags: ["breaking-change"], facets: ["javascript"], areas: ["area:source"] };
    const state = { v: 4 as const, repositoryId: 1, pullRequestNumber: 2, headSha: "f".repeat(40), inputDigest: "a".repeat(64), policy: "b".repeat(64), policySha: "d".repeat(40), mode: "shadow" as const, primary: { id: "feature", source: "deterministic-fallback" as const, reasonCode: "primary-deterministic-type-selected" }, ownedRiskFlags: [], riskFlags: ["breaking-change"], facets: ["javascript"], areas: ["area:source"], decisionDigest: "c".repeat(64) };
    const encoded = encodeClassificationCheckState(state, codec);
    expect(encoded).toHaveLength(251);
    expect(decodeClassificationCheckState(encoded, codec)).toEqual(state);
    expect(decodeClassificationCheckState(encoded, codec, { repositoryId: 1, pullRequestNumber: 2, headSha: "f".repeat(40) })).toEqual(state);
    expect(decodeClassificationCheckState(encoded, codec, { repositoryId: 1, pullRequestNumber: 3, headSha: "f".repeat(40) })).toBeNull();
    expect(decodeClassificationCheckState(encoded, codec, { repositoryId: 1, pullRequestNumber: 2, headSha: state.headSha, policySha: state.policySha })).toEqual(state);
    expect(decodeClassificationCheckState(encoded, codec, { repositoryId: 1, pullRequestNumber: 2, headSha: state.headSha, policySha: "e".repeat(40) })).toBeNull();
    expect(() => encodeClassificationCheckState({ ...state, policySha: "invalid" }, codec)).toThrow("上下文无效");
    expect(() => encodeClassificationCheckState({ ...state, ownedRiskFlags: ["breaking-change"], riskFlags: [] }, codec)).toThrow("风险所有权");
    expect(decodeClassificationCheckState(encoded.replace("v4:", "v3:"), codec)).toBeNull();
    expect(decodeClassificationCheckState(`${encoded}=`, codec)).toBeNull();
    expect(decodeClassificationCheckState(`v4:${Buffer.from("{}", "utf8").toString("base64url")}`, codec)).toBeNull();
    const bufferFrom = vi.spyOn(Buffer, "from");
    try {
      expect(decodeClassificationCheckState(`v4:${"A".repeat(20_000)}`, codec)).toBeNull();
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








  it("审查说明只忽略Git检出产生的CRLF差异", () => {
    const generated = "第一行\n第二行\n";
    expect(matchesGeneratedReviewInstructions("第一行\r\n第二行\r\n", generated)).toBe(true);
    expect(matchesGeneratedReviewInstructions("第一行\n第二行\n", generated)).toBe(true);
    expect(matchesGeneratedReviewInstructions("第一行\r第二行\r", generated)).toBe(false);
    expect(matchesGeneratedReviewInstructions("第一行\r\n修改内容\r\n", generated)).toBe(false);
    expect(matchesGeneratedReviewInstructions("第一行\r\n第二行", generated)).toBe(false);
  });

  it("所有仓库都从可信中央检出读取审查规则注册表", () => {
    const workspace = join(tmpdir(), "candidate-steward");
    const configuredDirectory = process.env.STEWARD_CONFIG_DIRECTORY;
    delete process.env.STEWARD_CONFIG_DIRECTORY;
    try {
      for (const repositoryId of [1296724484, 1187527897, 1296725317]) {
        expect(reviewRegistryPaths(repositoryId, workspace).profiles).toMatch(/config[\\/]review[\\/]profiles\.json$/u);
        expect(reviewRegistryPaths(repositoryId, workspace).profiles).not.toBe(join(workspace, "config", "review", "profiles.json"));
        expect(reviewRegistryPaths(repositoryId, workspace).rules).toMatch(/config[\\/]review[\\/]rules\.json$/u);
      }
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

  it("审查说明同步令牌包含仓库团队读取权限", () => {
    expect(reviewInstructionSyncInstallationPermissions()).toEqual({
      administration: "read",
      contents: "write",
      pull_requests: "write",
      issues: "read",
      checks: "read",
      metadata: "read",
      members: "read",
    });
  });

  it("双文件内容相同时复用当前来源提交", async () => {
    const files = [{ path: "AGENTS.md", content: "共享" }, { path: ".github/copilot-instructions.md", content: "补充" }];
    const client = {
      compare: async () => ({ merge_base_commit: { sha: "a".repeat(40) }, ahead_by: 1, total_commits: 1, commits: [{}], files: files.map(file => ({ filename: file.path })) }),
      getContent: async (_owner: string, _repo: string, path: string) => ({ encoding: "base64", content: Buffer.from(files.find(file => file.path === path)!.content, "utf8").toString("base64") }),
    } as any;
    await expect(writeManagedFilesToBranch({ gh: client, owner: "splrad", repo: ".github", files, branch: "steward/review-instructions", title: "同步", defaultSha: "a".repeat(40), branchSha: "b".repeat(40) })).resolves.toEqual({ changed: false, headSha: "b".repeat(40) });
  });

  it("受管分支只修改一个目标时仍可继续更新", async () => {
    const files = [{ path: "AGENTS.md", content: "新共享" }, { path: ".github/copilot-instructions.md", content: "新补充" }];
    const client = {
      compare: async () => ({ merge_base_commit: { sha: "a".repeat(40) }, ahead_by: 1, total_commits: 1, commits: [{}], files: [{ filename: files[1]!.path }] }),
      getContent: async (_owner: string, _repo: string, path: string, ref: string) => ({ encoding: "base64", content: Buffer.from(ref === "c".repeat(40) ? files.find(file => file.path === path)!.content : "旧内容", "utf8").toString("base64") }),
      getGitCommit: async () => ({ tree: { sha: "f".repeat(40) } }),
      createBlob: async () => ({ sha: "1".repeat(40) }),
      createTree: async () => ({ sha: "2".repeat(40) }),
      createCommit: async () => ({ sha: "c".repeat(40) }),
      updateRef: async () => undefined,
      getRef: async () => ({ object: { sha: "c".repeat(40) } }),
    } as any;
    await expect(writeManagedFilesToBranch({ gh: client, owner: "splrad", repo: ".github", files, branch: "steward/review-instructions", title: "同步", defaultSha: "a".repeat(40), branchSha: "b".repeat(40) })).resolves.toEqual({ changed: true, headSha: "c".repeat(40) });
  });

  it("受管分支发现空差异或资源集外文件时停止更新", async () => {
    const files = [{ path: "AGENTS.md", content: "共享" }, { path: ".github/copilot-instructions.md", content: "补充" }];
    const input = { owner: "splrad", repo: ".github", files, branch: "steward/review-instructions", title: "同步", defaultSha: "a".repeat(40), branchSha: "b".repeat(40) };
    const client = (changedFiles: readonly string[]) => ({
      compare: async () => ({ merge_base_commit: { sha: "a".repeat(40) }, ahead_by: 1, total_commits: 1, commits: [{}], files: changedFiles.map(filename => ({ filename })) }),
    }) as any;
    await expect(writeManagedFilesToBranch({ gh: client([]), ...input })).rejects.toThrow("受管分支包含非预期改动");
    await expect(writeManagedFilesToBranch({ gh: client(["README.md"]), ...input })).rejects.toThrow("受管分支包含非预期改动");
  });

  it("双文件通过一个tree和一个commit原子写入并逐字读回", async () => {
    const files = [{ path: "AGENTS.md", content: "新共享" }, { path: ".github/copilot-instructions.md", content: "新补充" }];
    const calls: string[] = [];
    let treeBody: any;
    const client = {
      compare: async () => ({ merge_base_commit: { sha: "a".repeat(40) }, ahead_by: 1, total_commits: 1, commits: [{}], files: files.map(file => ({ filename: file.path })) }),
      getContent: async (_owner: string, _repo: string, path: string, ref: string) => ({ encoding: "base64", content: Buffer.from(ref === "c".repeat(40) ? files.find(file => file.path === path)!.content : "旧内容", "utf8").toString("base64") }),
      getGitCommit: async () => ({ tree: { sha: "f".repeat(40) } }),
      createBlob: async (_owner: string, _repo: string, content: string) => { calls.push(`blob:${content}`); return { sha: content === "新共享" ? "1".repeat(40) : "2".repeat(40) }; },
      createTree: async (_owner: string, _repo: string, body: any) => { calls.push("tree"); treeBody = body; return { sha: "3".repeat(40) }; },
      createCommit: async () => { calls.push("commit"); return { sha: "c".repeat(40) }; },
      updateRef: async () => { calls.push("updateRef"); },
      getRef: async () => ({ object: { sha: "c".repeat(40) } }),
    } as any;
    await expect(writeManagedFilesToBranch({ gh: client, owner: "splrad", repo: ".github", files, branch: "steward/review-instructions", title: "同步", defaultSha: "a".repeat(40), branchSha: "b".repeat(40) })).resolves.toEqual({ changed: true, headSha: "c".repeat(40) });
    expect(calls).toEqual(["blob:新共享", "blob:新补充", "tree", "commit", "updateRef"]);
    expect(treeBody.tree.map((entry: any) => entry.path)).toEqual(files.map(file => file.path));
  });

  it("新分支任一blob失败时不创建tree、commit或分支", async () => {
    const files = [{ path: "AGENTS.md", content: "新共享" }, { path: ".github/copilot-instructions.md", content: "新补充" }];
    const calls: string[] = [];
    const client = {
      compare: async () => ({ merge_base_commit: { sha: "a".repeat(40) }, ahead_by: 1, total_commits: 1, commits: [{}], files: files.map(file => ({ filename: file.path })) }),
      getContent: async () => ({ encoding: "base64", content: Buffer.from("旧内容", "utf8").toString("base64") }),
      getGitCommit: async () => ({ tree: { sha: "f".repeat(40) } }),
      createBlob: async (_owner: string, _repo: string, content: string) => { if (content === "新补充") throw new Error("blob失败"); return { sha: "1".repeat(40) }; },
      createTree: async () => { calls.push("tree"); },
      createCommit: async () => { calls.push("commit"); },
      updateRef: async () => { calls.push("updateRef"); },
      createRef: async () => { calls.push("createRef"); },
    } as any;
    await expect(writeManagedFilesToBranch({ gh: client, owner: "splrad", repo: ".github", files, branch: "steward/review-instructions", title: "同步", defaultSha: "a".repeat(40), branchSha: null })).rejects.toThrow("blob失败");
    expect(calls).toEqual([]);
  });

  it("新分支只在资源集提交完成后指向最终提交", async () => {
    const files = [{ path: "AGENTS.md", content: "新共享" }, { path: ".github/copilot-instructions.md", content: "新补充" }];
    const calls: string[] = [];
    const client = {
      getContent: async (_owner: string, _repo: string, path: string, ref: string) => ({ encoding: "base64", content: Buffer.from(ref === "c".repeat(40) ? files.find(file => file.path === path)!.content : "旧内容", "utf8").toString("base64") }),
      getGitCommit: async () => ({ tree: { sha: "f".repeat(40) } }),
      createBlob: async () => ({ sha: "1".repeat(40) }),
      createTree: async () => ({ sha: "2".repeat(40) }),
      createCommit: async () => { calls.push("commit"); return { sha: "c".repeat(40) }; },
      createRef: async (_owner: string, _repo: string, _ref: string, sha: string) => { calls.push(`createRef:${sha}`); },
      getRef: async () => ({ object: { sha: "c".repeat(40) } }),
    } as any;
    await expect(writeManagedFilesToBranch({ gh: client, owner: "splrad", repo: ".github", files, branch: "steward/review-instructions", title: "同步", defaultSha: "a".repeat(40), branchSha: null })).resolves.toEqual({ changed: true, headSha: "c".repeat(40) });
    expect(calls).toEqual(["commit", `createRef:${"c".repeat(40)}`]);
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
      ["config/review/profiles.json", "schema/review-profiles.schema.json"],
      ["config/review/rules.json", "schema/review-rules.schema.json"],
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
    repositories.repositories["1296724484"].reviewInstructionsProfile = "INVALID";
    expect(validate(repositories)).toBe(false);
  });

  it("中央配置黄金事实逐字冻结", async () => {
    const repositories = JSON.parse(await readFile("config/repositories.json", "utf8"));
    expect(repositories.organization).toEqual({ id: 302208797, login: "splrad" });
    expect(repositories.defaults.public).toMatchObject({ managed: true, reviewInstructionsProfile: "common", validationProfile: "public-basic", delivery: { githubRelease: { enabled: false } } });
    expect(repositories.repositories["1187527897"].reviewGovernance).toMatchObject({ scope: "full", lifecycle: "repository-ready", owner: "splrad/maintainers", exception: null });
    expect(repositories.repositories["1296724484"].reviewGovernance).toMatchObject({ scope: "full", lifecycle: "repository-ready", owner: "splrad/maintainers", exception: null });
    expect(repositories.repositories["1296725317"].reviewGovernance).toMatchObject({ scope: "policy-only", lifecycle: "repository-ready" });
    expect(Object.keys(repositories.repositories).sort()).toEqual(["1187527897", "1296724484", "1296725317"]);
    expect(repositories.repositories["1187527897"].builds['release-assets'].outputs.map((value: any) => value.match)).toEqual(["AFR-Deployer_v{version}.exe", "AFR-DLL_v{version}.zip", "Fonts.zip"]);
    expect(repositories.repositories["1187527897"].delivery.githubRelease.state).toBe('pending');
  });

  it("实现冻结完整比较、唯一拉取请求、漂移和同名检查失败保护", async () => {
    const source = await readFile("packages/runner/src/index.ts", "utf8");
    for (const fragment of [
      "同名分类检查存在歧义",
      "分类输入在写入期间已经漂移",
      "TRIGGER_ACTOR_ID === \"301115370\"",
      "AI处理状态：",
    ]) expect(source).toContain(fragment);
    expect(source).not.toMatch(/heads\/main|base\.ref\s*!==\s*"main"|default_branch\s*!==\s*"main"/u);
    expect(source).toMatch(/if\s*\(labelPlan\.add\.length\)\s*await gh\.addLabels\(owner, repo, number, labelPlan\.add\);/u);
    expect(source).not.toMatch(/for\s*\([^)]*labelPlan\.add[^)]*\)\s*await gh\.addLabels/u);
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


});
