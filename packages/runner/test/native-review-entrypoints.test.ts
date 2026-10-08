import { afterEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as github from "../../github/src/index.js";
import { generateOrganizationReviewInstructions, generateReviewInstructionSet } from "../../core/src/index.js";
import { main } from "../src/index.js";

const policySha = "a".repeat(40);
const baseSha = "b".repeat(40);
const headSha = "c".repeat(40);
const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(mode: "native" | undefined, policyOnly = false) {
  const directory = await mkdtemp(join(tmpdir(), "native-entrypoints-"));
  temporary.push(directory);
  await cp(resolve("config"), join(directory, "config"), { recursive: true });
  const registry = JSON.parse(await readFile(join(directory, "config/repositories.json"), "utf8"));
  for (const configuration of [...Object.values(registry.defaults), ...Object.values(registry.repositories)] as any[]) {
    if (mode === undefined) delete configuration.copilotReviewTrigger;
    else configuration.copilotReviewTrigger = mode;
  }
  await writeFile(join(directory, "config/repositories.json"), JSON.stringify(registry));
  for (const [name, value] of Object.entries({
    STEWARD_CONFIG_DIRECTORY: join(directory, "config"), APP_ID: "4243096", INSTALLATION_ID: "145952003",
    STEWARD_APP_PRIVATE_KEY: "fixture-key", SYNC_TRIGGER: "workflow_run", GITHUB_OUTPUT: join(directory, "output"),
    GITHUB_STEP_SUMMARY: join(directory, "summary"), PREPARE_ONLY: "", PREPARE_REPAIR_ONLY: "",
    COPILOT_OUTPUT_PATH: "", PR_PREPARED_FACTS_PATH: "", COPILOT_STEP_OUTCOME: "", PR_TEMPLATE_PATH: "",
    COPILOT_GITHUB_TOKEN: "fixture-cli-token",
  })) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("未模拟的网络请求"); }));
  const token = vi.spyOn(github, "createInstallationToken").mockResolvedValue("fixture-installation-token");
  const repository = {
    id: policyOnly ? 1296725317 : 1296724484, full_name: policyOnly ? "splrad/.github" : "splrad/steward",
    owner: { id: 302208797, login: "splrad" }, private: false, fork: false, archived: false,
    disabled: false, has_issues: !policyOnly, default_branch: "main",
  };
  const prototype = github.GitHubClient.prototype;
  vi.spyOn(prototype, "getRepositoryById").mockResolvedValue(repository);
  vi.spyOn(prototype, "getRepository").mockResolvedValue({ default_branch: "main" });
  vi.spyOn(prototype, "listInstallationRepositories").mockResolvedValue([repository]);
  vi.spyOn(prototype, "getRequestedReviewers").mockResolvedValue({ users: [] });
  vi.spyOn(prototype, "listPullRequestReviews").mockResolvedValue([]);
  vi.spyOn(prototype, "listIssueEvents").mockResolvedValue([]);
  vi.spyOn(prototype, "listAllCheckRuns").mockResolvedValue([]);
  const reviewWrite = vi.spyOn(prototype, "requestReviewers").mockRejectedValue(new Error("native发起了审查请求"));
  const dispatch = vi.spyOn(prototype, "request").mockImplementation(async (method, path) => {
    if (method !== "POST" || !/^\/repos\/splrad\/steward\/actions\/workflows\/(pr-classification|pr-issue-link)\.yml\/dispatches$/u.test(path)) throw new Error(`未预期的API调用: ${method} ${path}`);
    return undefined as any;
  });
  return { directory, repository, prototype, token, reviewWrite, dispatch };
}

async function withoutReviewToken(run: () => Promise<void>) {
  const environment = process.env;
  let reads = 0;
  process.env = new Proxy({ ...environment }, {
    get(target, name) {
      if (name === "COPILOT_REVIEW_REQUEST_TOKEN") { reads++; throw new Error("native读取了请求令牌"); }
      return Reflect.get(target, name);
    },
  });
  try {
    await run();
    expect(reads).toBe(0);
    expect(process.env.COPILOT_GITHUB_TOKEN).toBe("fixture-cli-token");
  } finally { process.env = environment; }
}

describe.each(["native", undefined] as const)("三入口令牌隔离：%s", mode => {
  it.each(["directory", "undecodable", "null", "missing"])("组织同步只将404视为退役路径缺失：%s", async kind => {
    const f = await fixture(mode, true);
    const { $schema: _p, ...profiles } = JSON.parse(await readFile(join(f.directory, "config/review/profiles.json"), "utf8"));
    const { $schema: _r, ...rules } = JSON.parse(await readFile(join(f.directory, "config/review/rules.json"), "utf8"));
    profiles.profiles.find((profile: any) => profile.id === "github").organizationInstructionsDigest = (await generateOrganizationReviewInstructions(profiles, rules)).digest;
    await writeFile(join(f.directory, "config/review/profiles.json"), JSON.stringify(profiles));
    const instructions = await generateReviewInstructionSet("github", profiles, rules);
    vi.spyOn(f.prototype, "listRepositoryTeams").mockResolvedValue([{ slug: "maintainers", permission: "maintain" }]);
    vi.spyOn(f.prototype, "getRef").mockResolvedValue({ object: { sha: baseSha } });
    vi.spyOn(f.prototype, "getContent").mockImplementation(async (_owner, _repo, path) => {
      if (path === "AGENTS.md") return { type: "file", encoding: "base64", content: Buffer.from(instructions.files[0].content).toString("base64") };
      if (kind === "missing") throw new github.GitHubRequestError(404, "GET", path, "missing");
      if (kind === "directory") return [{ type: "file", name: "manual.md" }];
      if (kind === "null") return null;
      return { type: "file", encoding: "none", content: "" };
    });
    const write = vi.spyOn(f.prototype, "createBlob");
    const run = () => main(["sync-review-instructions", "--repository-id", String(f.repository.id), "--policy-sha", policySha]);
    if (kind === "missing") {
      await withoutReviewToken(run);
      expect(await readFile(join(f.directory, "summary"), "utf8")).toContain("状态：unchanged");
    } else await expect(withoutReviewToken(run)).rejects.toThrow("审查说明同步失败");
    expect(write).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("Dependabot命令保留来源与资格核验，完成只读观察", async () => {
    const f = await fixture(mode);
    for (const [name, value] of Object.entries({ TRIGGER_ACTOR_ID: "301115370", WORKFLOW_REPOSITORY: "splrad/steward",
      WORKFLOW_EVENT: "workflow_dispatch", WORKFLOW_RUN_REF: "refs/heads/main", WORKFLOW_DEFAULT_BRANCH: "main",
      WORKFLOW_REF: "splrad/steward/.github/workflows/pr-automation.yml@refs/heads/main", WORKFLOW_SHA: policySha,
    })) vi.stubEnv(name, value);
    vi.spyOn(f.prototype, "getPullRequest").mockResolvedValue({ number: 1, state: "open", draft: false,
      user: { id: 49699333, login: "dependabot[bot]", type: "Bot" },
      base: { ref: "main", repo: { id: f.repository.id } }, head: { sha: headSha, repo: { id: f.repository.id } },
    });
    await withoutReviewToken(() => main(["request-copilot-review", "--repository-id", String(f.repository.id), "--pull-request-number", "1", "--event-head-sha", headSha, "--policy-sha", policySha, "--delivery-id", "fixture-delivery"]));
    expect(await readFile(join(f.directory, "summary"), "utf8")).toContain("observed-none");
    expect(f.reviewWrite).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])("policy-only规则同步使用实际载体并派发分类，组织模式=%s", async organizationMode => {
    const f = await fixture(mode, true);
    const { $schema: _profileSchema, ...profiles } = JSON.parse(await readFile(join(f.directory, "config/review/profiles.json"), "utf8"));
    const { $schema: _ruleSchema, ...rules } = JSON.parse(await readFile(join(f.directory, "config/review/rules.json"), "utf8"));
    const original = await generateReviewInstructionSet("github", profiles, rules);
    if (organizationMode) {
      profiles.profiles.find((profile: any) => profile.id === "github").organizationInstructionsDigest = (await generateOrganizationReviewInstructions(profiles, rules)).digest;
      await writeFile(join(f.directory, "config/review/profiles.json"), JSON.stringify(profiles));
    }
    const instructions = await generateReviewInstructionSet("github", profiles, rules);
    vi.spyOn(f.prototype, "listRepositoryTeams").mockResolvedValue([{ slug: "maintainers", permission: "maintain" }]);
    vi.spyOn(f.prototype, "listPullRequests").mockResolvedValue([]);
    let branchCreated = false;
    vi.spyOn(f.prototype, "getRef").mockImplementation(async (_owner, _repo, ref) => {
      if (ref === "heads/main") return { object: { sha: baseSha } };
      if (!branchCreated) throw new github.GitHubRequestError(404, "GET", ref, "missing");
      return { object: { sha: headSha } };
    });
    vi.spyOn(f.prototype, "getContent").mockImplementation(async (_owner, _repo, path, ref) => {
      if (organizationMode && path === ".github/copilot-instructions.md") {
        if (ref === headSha) throw new github.GitHubRequestError(404, "GET", path, "missing");
        return { type: "file", encoding: "base64", content: Buffer.from(original.files[1]!.content).toString("base64") };
      }
      return { encoding: "base64", content: Buffer.from(ref === headSha ? instructions.files.find(file => file.path === path)!.content : "旧规则").toString("base64") };
    });
    vi.spyOn(f.prototype, "getGitCommit").mockResolvedValue({ tree: { sha: "d".repeat(40) } });
    const retiredContent = original.files[1]!.content;
    vi.spyOn(f.prototype, "getGitTree").mockResolvedValue({ sha: "d".repeat(40), truncated: false, tree: [
      { path: ".github/copilot-instructions.md", type: "blob", mode: "100644",
        sha: createHash("sha1").update("blob " + Buffer.byteLength(retiredContent, "utf8") + "\0" + retiredContent).digest("hex") },
    ] });
    const blobs = vi.spyOn(f.prototype, "createBlob").mockResolvedValue({ sha: "e".repeat(40) });
    const tree = vi.spyOn(f.prototype, "createTree").mockResolvedValue({ sha: "f".repeat(40) });
    vi.spyOn(f.prototype, "createCommit").mockResolvedValue({ sha: headSha });
    vi.spyOn(f.prototype, "createRef").mockImplementation(async () => { branchCreated = true; return {}; });
    const create = vi.spyOn(f.prototype, "createPullRequest").mockResolvedValue({ number: 1 });
    await withoutReviewToken(() => main(["sync-review-instructions", "--repository-id", String(f.repository.id), "--policy-sha", policySha]));
    expect(blobs.mock.calls.map(call => call[2])).toEqual(instructions.files.map(file => file.content));
    expect(tree.mock.calls[0]![2]).toMatchObject({ tree: [{ path: "AGENTS.md" }, { path: ".github/copilot-instructions.md" }] });
    if (organizationMode) expect(tree.mock.calls[0]![2]).toMatchObject({ tree: [{ path: "AGENTS.md" }, { path: ".github/copilot-instructions.md", sha: null }] });
    expect(create).toHaveBeenCalledWith("splrad", ".github", expect.objectContaining({ head: "steward/review-instructions", base: "main", body: expect.stringContaining("<!-- workflow:managed-pr:start -->") }));
    expect(f.dispatch).toHaveBeenCalledExactlyOnceWith("POST", "/repos/splrad/steward/actions/workflows/pr-classification.yml/dispatches", expect.objectContaining({ inputs: expect.objectContaining({ policySha, repositoryId: String(f.repository.id), eventHeadSha: headSha }) }));
    expect(f.reviewWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(create.mock.calls)).not.toContain("undefined");
    if (organizationMode) expect(JSON.stringify(create.mock.calls)).toContain("组织公共规则");
  });

  it("真人推送创建Draft和正文，继续派发议题关联与分类", async () => {
    const f = await fixture(mode);
    vi.spyOn(f.prototype, "getRef").mockImplementation(async (_owner, _repo, ref) => ({ object: { sha: ref === "heads/main" ? baseSha : headSha } }));
    vi.spyOn(f.prototype, "compare").mockResolvedValue({ ahead_by: 1, total_commits: 1,
      commits: [{ sha: headSha, commit: { message: "fix: 修复规则同步" } }],
      files: [{ filename: "packages/runner/src/index.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }],
    });
    vi.spyOn(f.prototype, "listPullRequests").mockResolvedValue([]);
    const create = vi.spyOn(f.prototype, "createPullRequest").mockResolvedValue({ number: 1 });
    vi.spyOn(f.prototype, "getPullRequest").mockResolvedValue({ head: { repo: { id: f.repository.id }, ref: "feature/test", sha: headSha }, base: { ref: "main", sha: baseSha } });
    await withoutReviewToken(() => main(["pr-automation", "--repository-id", String(f.repository.id), "--policy-sha", policySha,
      "--source-ref", "refs/heads/feature/test", "--event-after-sha", headSha, "--source-actor-id", "1234", "--source-actor-login", "fixture-user", "--delivery-id", "fixture-delivery",
    ]));
    expect(create).toHaveBeenCalledWith("splrad", "steward", expect.objectContaining({ draft: true, head: "feature/test", base: "main", body: expect.stringContaining("<!-- workflow:managed-pr:start -->") }));
    expect(f.dispatch.mock.calls.map(call => call[1])).toEqual(["/repos/splrad/steward/actions/workflows/pr-issue-link.yml/dispatches", "/repos/splrad/steward/actions/workflows/pr-classification.yml/dispatches"]);
    for (const call of f.dispatch.mock.calls) expect(call[2]).toMatchObject({ inputs: { policySha } });
    expect(f.token.mock.calls.every(([input]) => input.policySha === policySha)).toBe(true);
    expect(f.reviewWrite).not.toHaveBeenCalled();
    expect(await readFile(join(f.directory, "output"), "utf8")).toContain(`headSha=${headSha}`);
  });
});
