import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import { assertFreshValidationBase, assertManagedBranchPull, assertWorkflowPaths, classificationInstallationPermissions, copilotInstructionSourcePath, decodeAiClassificationPayload, decodeClassificationCheckState, describeCopilotFallback, encodeAiClassificationPayload, env, extractCopilotAssistantContent, gitDiffCheckArguments, hasActiveCopilotCheckRun, hasNewCopilotRequestEvent, hasRequestedCopilotReviewer, humanPushPullRequestCreateInput, isCopilotReviewerIdentity, matchesGeneratedCopilotInstructions, parseInvocation, prAutomationInstallationPermissions, renderAiClassificationEvidence, throwFreshValidationBaseFailure, writeManagedFileToBranch } from "../src/index.js";

const Ajv = AjvModule as unknown as typeof import("ajv").default;
const addFormats = addFormatsModule as unknown as typeof import("ajv-formats").default;

afterEach(() => {
  delete process.env.TEST_REQUIRED_ENV;
  delete process.env.GITHUB_STEP_SUMMARY;
});

describe("中央命令入口", () => {
  it("只接受十个命令及其已知、唯一、成对参数", () => {
    const commands = ["onboard-repository", "pr-automation", "pr-classification", "sync-copilot-instructions", "sync-managed-labels", "validate", "release-preflight", "release-notes", "release-publish", "release-verify"];
    for (const command of commands) expect(parseInvocation([command]).command).toBe(command);
    expect(() => parseInvocation(["unknown"])).toThrow("未知命令");
    expect(() => parseInvocation(["validate", "--unknown", "x"])).toThrow("未知参数");
    expect(() => parseInvocation(["validate", "--workspace"])).toThrow("参数格式");
    expect(() => parseInvocation(["validate", "--workspace", "a", "--workspace", "b"])).toThrow("重复参数");
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

  it("AI影子分类载荷使用规范编码并受当前分类配置约束", () => {
    const suggestion = {
      kind: "feature",
      confidence: "high" as const,
      evidence: ["packages/core/src/automation.ts新增分类建议字段"],
    };
    const encoded = encodeAiClassificationPayload(suggestion, ["feature", "bug"]);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeAiClassificationPayload(encoded, ["feature", "bug"])).toEqual(suggestion);
    expect(() => decodeAiClassificationPayload(encoded, ["bug"])).toThrow("不属于当前分类配置");
    expect(() => decodeAiClassificationPayload(`${encoded}=`, ["feature"])).toThrow("载荷格式无效");
    expect(() => decodeAiClassificationPayload("a".repeat(4_097), ["feature"])).toThrow("载荷格式无效");
    expect(() => decodeAiClassificationPayload(Buffer.from("not-json", "utf8").toString("base64url"), ["feature"]))
      .toThrow("AI影子分类载荷格式无效");
  });

  it("只接受规范编码且字段完整的Check v3所有权状态", () => {
    const state = { v: 3, inputDigest: "a".repeat(64), policy: "b".repeat(64), primary: { id: "feature", source: "deterministic-fallback", reasonCode: "primary-deterministic-type-selected" }, risks: ["breaking-change"], facets: ["javascript"], areas: ["area:source"], decisionDigest: "c".repeat(64) };
    const encoded = `v3:${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
    expect(decodeClassificationCheckState(encoded)).toEqual(state);
    expect(decodeClassificationCheckState(encoded.replace("v3:", "v2:"))).toBeNull();
    expect(decodeClassificationCheckState(`${encoded}=`)).toBeNull();
    expect(decodeClassificationCheckState(`v3:${Buffer.from("{}", "utf8").toString("base64url")}`)).toBeNull();
  });

  it("AI影子分类依据以Markdown纯文本写入检查摘要", () => {
    expect(renderAiClassificationEvidence({
      kind: "feature",
      confidence: "medium",
      evidence: ["packages/core/a_b*~|file.ts"],
    })).toBe("packages/core/a\\_b\\*\\~\\|file\\.ts");
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
      pull_requests: "read",
      issues: "write",
      checks: "write",
      metadata: "read",
    });
    expect(classificationInstallationPermissions("observe").issues).toBe("read");
    expect(prAutomationInstallationPermissions()).toEqual({
      contents: "read",
      pull_requests: "write",
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
      "AI影子建议未参与标签写入",
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
    expect(source).not.toMatch(/createComment|updateComment|issue_comment|issues\/[^/]+\/comments/iu);
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
