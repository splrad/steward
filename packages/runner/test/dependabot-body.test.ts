import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { GitHubClient } from "../../github/src/index.js";
import { main } from "../src/index.js";

vi.mock("../../github/src/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../github/src/index.js")>(),
  createInstallationToken: vi.fn(async () => "installation-token"),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function fixture(author: { id: number; login: string; type: string }) {
  const head = "a".repeat(40), base = "b".repeat(40);
  for (const [key, value] of Object.entries({ APP_ID: "4243096", INSTALLATION_ID: "145952003", STEWARD_APP_PRIVATE_KEY: "test-key", STEWARD_CONFIG_DIRECTORY: resolve("config"), GITHUB_STEP_SUMMARY: "", PREPARE_ONLY: "", PREPARE_REPAIR_ONLY: "", COPILOT_OUTPUT_PATH: "", COPILOT_STEP_OUTCOME: "", PR_TEMPLATE_PATH: "" })) vi.stubEnv(key, value);
  const transport = vi.fn(async () => { throw new Error("unexpected external request"); });
  vi.stubGlobal("fetch", transport);
  vi.spyOn(GitHubClient.prototype, "getRepositoryById").mockResolvedValue({ id: 1296724484, full_name: "splrad/steward", owner: { id: 302208797, login: "splrad" }, default_branch: "main", private: false });
  vi.spyOn(GitHubClient.prototype, "getRef").mockImplementation(async (_owner, _repo, ref) => ({ object: { sha: ref === "heads/main" ? base : head } }));
  vi.spyOn(GitHubClient.prototype, "compare").mockResolvedValue({ ahead_by: 1, total_commits: 1, commits: [{ sha: head, commit: { message: "chore(deps): update dependency" } }], files: [{ filename: "package-lock.json", status: "modified", additions: 1, deletions: 1, patch: "-old\n+new" }] });
  const body = "Bumps dependency from 1 to 2.\n<details>Native Dependabot notes</details>";
  vi.spyOn(GitHubClient.prototype, "listPullRequests").mockResolvedValue([{ number: 196, user: author, body }]);
  const write = vi.spyOn(GitHubClient.prototype, "updatePullRequest").mockRejectedValue(new Error("unexpected body write"));
  const create = vi.spyOn(GitHubClient.prototype, "createPullRequest").mockRejectedValue(new Error("unexpected PR creation"));
  return { transport, write, create, run: () => main(["pr-automation", "--delivery-id", "test", "--repository-id", "1296724484", "--source-ref", "refs/heads/dependabot/npm_and_yarn/yaml-2.9.1", "--event-after-sha", head, "--source-actor-id", "44151430", "--source-actor-login", "axiomoth", "--policy-sha", base]) };
}

describe("人工推送后的Dependabot正文边界", () => {
  it("真人更新官方Dependabot分支时保留原生正文与独立审查路径", async () => {
    const f = fixture({ id: 49699333, login: "dependabot[bot]", type: "Bot" });
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([
    { id: 1, login: "dependabot[bot]", type: "Bot" },
    { id: 49699333, login: "other[bot]", type: "Bot" },
    { id: 49699333, login: "dependabot[bot]", type: "User" },
  ])("身份不完整时仍执行正文合同校验：%j", async author => {
    const f = fixture(author);
    await expect(f.run()).rejects.toThrow("受管标记缺失、重复或交叉");
    expect(f.write).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
});
