import { afterEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubClient } from "../../github/src/index.js";
import { main } from "../src/index.js";

vi.mock("../../github/src/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../github/src/index.js")>(),
  createInstallationToken: vi.fn(async () => "installation-token"),
}));

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function preparePaths(mode: "PREPARE_ONLY" | "PREPARE_REPAIR_ONLY") {
  const directory = await mkdtemp(join(tmpdir(), "steward-dependabot-body-"));
  temporaryDirectories.push(directory);
  vi.stubEnv(mode, "true");
  for (const [name, file] of Object.entries({ GITHUB_OUTPUT: "output.txt", PR_COPILOT_PROMPT_PATH: "prompt.txt", PR_PREPARED_FACTS_PATH: "facts.json", PR_COPILOT_REPAIR_PROMPT_PATH: "repair.txt" })) vi.stubEnv(name, join(directory, file));
  return directory;
}

function fixture(author: { id: number; login: string; type: string }) {
  const head = "a".repeat(40), base = "b".repeat(40);
  for (const [key, value] of Object.entries({ APP_ID: "4243096", INSTALLATION_ID: "145952003", STEWARD_APP_PRIVATE_KEY: "test-key", STEWARD_CONFIG_DIRECTORY: resolve("config"), GITHUB_STEP_SUMMARY: "", GITHUB_OUTPUT: "", PREPARE_ONLY: "", PREPARE_REPAIR_ONLY: "", COPILOT_OUTPUT_PATH: "", COPILOT_STEP_OUTCOME: "", PR_TEMPLATE_PATH: "" })) vi.stubEnv(key, value);
  const transport = vi.fn(async () => { throw new Error("unexpected external request"); });
  vi.stubGlobal("fetch", transport);
  vi.spyOn(GitHubClient.prototype, "getRepositoryById").mockResolvedValue({ id: 1296724484, full_name: "splrad/steward", owner: { id: 302208797, login: "splrad" }, default_branch: "main", private: false });
  vi.spyOn(GitHubClient.prototype, "getRef").mockImplementation(async (_owner, _repo, ref) => ({ object: { sha: ref === "heads/main" ? base : head } }));
  vi.spyOn(GitHubClient.prototype, "compare").mockResolvedValue({ ahead_by: 1, total_commits: 1, commits: [{ sha: head, commit: { message: "chore(deps): update dependency" } }], files: [{ filename: "package-lock.json", status: "modified", additions: 1, deletions: 1, patch: "-old\n+new" }] });
  const body = "Bumps dependency from 1 to 2.\n<details>Native Dependabot notes</details>";
  vi.spyOn(GitHubClient.prototype, "listPullRequests").mockResolvedValue([{ number: 196, user: author, body, base: { ref: "main", sha: base } }]);
  const write = vi.spyOn(GitHubClient.prototype, "updatePullRequest").mockRejectedValue(new Error("unexpected body write"));
  const create = vi.spyOn(GitHubClient.prototype, "createPullRequest").mockRejectedValue(new Error("unexpected PR creation"));
  return { transport, write, create, run: () => main(["pr-automation", "--delivery-id", "test", "--repository-id", "1296724484", "--source-ref", "refs/heads/dependabot/npm_and_yarn/yaml-2.9.1", "--event-after-sha", head, "--source-actor-id", "44151430", "--source-actor-login", "axiomoth", "--policy-sha", base]) };
}

describe("人工推送后的Dependabot正文边界", () => {
  it.each([
    ["PREPARE_ONLY", "b".repeat(40)], ["PREPARE_ONLY", "d".repeat(40)],
    ["PREPARE_REPAIR_ONLY", "b".repeat(40)], ["PREPARE_REPAIR_ONLY", "d".repeat(40)],
    ["execute", "b".repeat(40)], ["execute", "d".repeat(40)],
  ] as const)("非默认目标在%s阶段保留原文且跳过生成，目标SHA=%s", async (mode, targetSha) => {
    const f = fixture({ id: 44151430, login: "axiomoth", type: "User" });
    vi.mocked(GitHubClient.prototype.listPullRequests).mockResolvedValue([{ number: 230,
      user: { id: 44151430, login: "axiomoth", type: "User" }, body: "人工正文",
      base: { ref: "release/test", sha: targetSha },
    }]);
    const directory = await preparePaths(mode === "execute" ? "PREPARE_ONLY" : mode);
    if (mode === "execute") vi.stubEnv("PREPARE_ONLY", "");
    await expect(f.run()).resolves.toBeUndefined();
    expect(await readdir(directory)).toEqual(mode === "PREPARE_ONLY" ? ["output.txt"] : []);
    if (mode === "PREPARE_ONLY") expect(await readFile(join(directory, "output.txt"), "utf8")).toBe("copilot-required=false\n");
    expect(f.write).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("准备阶段跳过官方Dependabot，不生成模型输入", async () => {
    const f = fixture({ id: 49699333, login: "dependabot[bot]", type: "Bot" });
    const directory = await preparePaths("PREPARE_ONLY");
    await f.run();
    expect(await readFile(join(directory, "output.txt"), "utf8")).toBe("copilot-required=false\n");
    expect(await readdir(directory)).toEqual(["output.txt"]);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("修复准备阶段也跳过官方Dependabot，不读取或生成模型输入", async () => {
    const f = fixture({ id: 49699333, login: "dependabot[bot]", type: "Bot" });
    const directory = await preparePaths("PREPARE_REPAIR_ONLY");
    await f.run();
    expect(await readdir(directory)).toEqual([]);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([
    { id: 1, login: "dependabot[bot]", type: "Bot" },
    { id: 49699333, login: "other[bot]", type: "Bot" },
    { id: 49699333, login: "dependabot[bot]", type: "User" },
    { id: 44151430, login: "axiomoth", type: "User" },
  ])("其他身份仍生成模型输入和执行信号：%j", async author => {
    const f = fixture(author);
    const directory = await preparePaths("PREPARE_ONLY");
    await f.run();
    expect(await readFile(join(directory, "output.txt"), "utf8")).toBe("copilot-required=false\ncopilot-required=true\n");
    expect(await readFile(join(directory, "prompt.txt"), "utf8")).not.toBe("");
    expect(JSON.parse(await readFile(join(directory, "facts.json"), "utf8"))).toMatchObject({ repositoryId: 1296724484, headSha: "a".repeat(40), baseSha: "b".repeat(40) });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
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
