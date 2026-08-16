import { readFile, stat } from "node:fs/promises";
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import { assertManagedBranchPull, classificationInstallationPermissions, env, hasActiveCopilotCheckRun, hasNewCopilotRequestEvent, hasRequestedCopilotReviewer, isCopilotReviewerIdentity, parseInvocation, writeManagedFileToBranch } from "../src/index.js";

const Ajv = AjvModule as unknown as typeof import("ajv").default;
const addFormats = addFormatsModule as unknown as typeof import("ajv-formats").default;

afterEach(() => {
  delete process.env.TEST_REQUIRED_ENV;
});

describe("中央命令入口", () => {
  it("只接受九个命令及其已知、唯一、成对参数", () => {
    const commands = ["onboard-repository", "pr-automation", "pr-classification", "sync-copilot-instructions", "validate", "release-preflight", "release-notes", "release-publish", "release-verify"];
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
      "同名分类检查存在歧义",
      "分类输入在写入期间已经漂移",
      "LayerScape不可变发布尚未启用",
      "当前默认分支第一父提交链",
    ]) expect(source).toContain(fragment);
    expect(source).not.toMatch(/heads\/main|base\.ref\s*!==\s*"main"|default_branch\s*!==\s*"main"/u);
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
