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
  const profilesPath = join(directory, "config/review/profiles.json");
  const profiles = JSON.parse(await readFile(profilesPath, "utf8"));
  for (const profile of profiles.profiles) delete profile.organizationInstructionsDigest;
  await writeFile(profilesPath, JSON.stringify(profiles));
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
  const dispatch = vi.spyOn(prototype, "request").mockImplementation(async (method, path) => {
    if (method !== "POST" || !/^\/repos\/splrad\/steward\/actions\/workflows\/(pr-classification|pr-issue-link)\.yml\/dispatches$/u.test(path)) throw new Error(`未预期的API调用: ${method} ${path}`);
    return undefined as any;
  });
  return { directory, repository, prototype, token, dispatch };
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
  it("统一观察入口核对当前仓库和PR，只读返回证据", async () => {
    const f = await fixture(mode);
    for (const [name, value] of Object.entries({ TRIGGER_ACTOR_ID: "301115370", WORKFLOW_REPOSITORY: "splrad/steward",
      WORKFLOW_EVENT: "workflow_dispatch", WORKFLOW_RUN_REF: "refs/heads/main", WORKFLOW_DEFAULT_BRANCH: "main",
      WORKFLOW_REF: "splrad/steward/.github/workflows/native-review.yml@refs/heads/main", WORKFLOW_SHA: policySha,
    })) vi.stubEnv(name, value);
    vi.spyOn(f.prototype, "getPullRequest").mockResolvedValue({ number: 1, state: "open", draft: false,
      user: { id: 49699333, login: "dependabot[bot]", type: "Bot" },
      base: { ref: "main", repo: { id: f.repository.id } }, head: { sha: headSha, repo: { id: f.repository.id } },
    });
    await withoutReviewToken(() => main(["observe-copilot-review", "--repository-id", String(f.repository.id), "--pull-request-number", "1", "--event-head-sha", headSha, "--policy-sha", policySha]));
    expect(await readFile(join(f.directory, "summary"), "utf8")).toContain('\"state\":\"none\"');
    expect(f.dispatch.mock.calls.some(([, path]) => path.endsWith("/requested_reviewers"))).toBe(false);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each(['sync-review-instructions','sync-managed-labels','onboard-repository'])('rejects retired %s without token access or network', async command => {
    const f = await fixture(mode);
    await expect(withoutReviewToken(() => main([command]))).rejects.toThrow('未知命令');
    expect(f.token).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });
});
