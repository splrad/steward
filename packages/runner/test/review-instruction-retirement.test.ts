import { describe, expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { generateOrganizationReviewInstructions, generateReviewInstructionSet } from "../../core/src/index.js";
import { GitHubRequestError } from "../../github/src/index.js";
import { main, writeManagedFilesToBranch } from "../src/index.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const committed = "c".repeat(40);
const retiredPath = ".github/copilot-instructions.md";
const files = [{ path: "AGENTS.md", content: "共享规则" }];
const retiredFiles = [{ path: retiredPath, content: "已知生成原文" }];
const missing = () => { throw new GitHubRequestError(404, "GET", retiredPath, "missing"); };
const blobHash = (content: string) => createHash("sha1").update("blob " + Buffer.byteLength(content, "utf8") + "\0" + content).digest("hex");

function fixture(retired: string | null = "已知生成原文", branchSha: string | null = null) {
  const content = (text: string) => ({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") });
  const client = {
    compare: vi.fn(async () => ({ merge_base_commit: { sha: base }, ahead_by: 1, total_commits: 1, commits: [{}], files: [{ filename: retiredPath }] })),
    getContent: vi.fn(async (_owner: string, _repo: string, path: string, ref: string): Promise<any> => {
      if (path === retiredPath) return ref === committed || retired === null ? missing() : content(retired);
      return content("共享规则");
    }),
    getGitCommit: vi.fn(async () => ({ tree: { sha: "d".repeat(40) } })),
    getGitTree: vi.fn(async () => ({ sha: "d".repeat(40), truncated: false, tree: [{ path: retiredPath, mode: "100644", type: "blob", sha: blobHash("已知生成原文") }] })),
    createBlob: vi.fn(async () => ({ sha: "e".repeat(40) })),
    createTree: vi.fn(async (_owner: string, _repo: string, _body: unknown) => ({ sha: "f".repeat(40) })),
    createCommit: vi.fn(async () => ({ sha: committed })),
    createRef: vi.fn(async () => ({})),
    updateRef: vi.fn(async () => ({})),
    getRef: vi.fn(async () => ({ object: { sha: committed } })),
  };
  const input = { gh: client as any, owner: "splrad", repo: "steward", files, retiredFiles, branch: "steward/review-instructions", title: "同步规则", defaultSha: base, branchSha };
  return { client, input, content };
}

describe("审查文件受控退役", () => {
  it("全部profile采用旧摘要后仍可导出新组织文本，仓库生成继续拒绝旧摘要", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-export-"));
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("导出不应访问网络"); }));
    try {
      await cp(resolve("config"), join(directory, "config"), { recursive: true });
      const profiles = JSON.parse(await readFile(join(directory, "config/review/profiles.json"), "utf8"));
      const rules = JSON.parse(await readFile(join(directory, "config/review/rules.json"), "utf8"));
      delete profiles.$schema; delete rules.$schema;
      const original = await generateOrganizationReviewInstructions(profiles, rules);
      for (const profile of profiles.profiles) profile.organizationInstructionsDigest = original.digest;
      rules.rules.find((rule: any) => rule.id === "common.direct-evidence").consequence += "更新后的规则";
      await writeFile(join(directory, "config/review/profiles.json"), JSON.stringify(profiles));
      await writeFile(join(directory, "config/review/rules.json"), JSON.stringify(rules));
      vi.stubEnv("STEWARD_CONFIG_DIRECTORY", join(directory, "config"));
      await main(["render-review-instructions", "--policy-sha", base]);
      const exported = JSON.parse(String(output.mock.calls[0]![0]));
      expect(exported.organization).toEqual(await generateOrganizationReviewInstructions(profiles, rules));
      expect(exported.organization.digest).not.toBe(original.digest);
      expect(exported).not.toHaveProperty("repository");
      for (const profile of profiles.profiles) {
        await expect(main(["render-review-instructions", "--profile", profile.id, "--policy-sha", base])).rejects.toThrow("摘要与当前中央规则不一致");
      }
    } finally { output.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["absent", "directory", "file", "parent-file"])("本地校验直接核对退役路径：%s", async kind => {
    const directory = await mkdtemp(join(tmpdir(), "review-validation-"));
    try {
      await cp(resolve("config"), join(directory, "config"), { recursive: true });
      const profiles = JSON.parse(await readFile(join(directory, "config/review/profiles.json"), "utf8"));
      const rules = JSON.parse(await readFile(join(directory, "config/review/rules.json"), "utf8"));
      delete profiles.$schema; delete rules.$schema;
      profiles.profiles.find((profile: any) => profile.id === "steward").organizationInstructionsDigest = (await generateOrganizationReviewInstructions(profiles, rules)).digest;
      await writeFile(join(directory, "config/review/profiles.json"), JSON.stringify(profiles));
      const registry = JSON.parse(await readFile(join(directory, "config/repositories.json"), "utf8"));
      registry.repositories["1296724484"].allowedWorkflowPaths = [];
      await writeFile(join(directory, "config/repositories.json"), JSON.stringify(registry));
      const validation = JSON.parse(await readFile(join(directory, "config/profiles/validation/steward.json"), "utf8"));
      validation.tasks = ["verify-review-instructions"];
      await writeFile(join(directory, "config/profiles/validation/steward.json"), JSON.stringify(validation));
      const workspace = join(directory, "workspace");
      await mkdir(workspace);
      const instructions = await generateReviewInstructionSet("steward", profiles, rules);
      await writeFile(join(workspace, "AGENTS.md"), instructions.files[0].content);
      if (kind === "directory") {
        await mkdir(join(workspace, retiredPath), { recursive: true });
        await writeFile(join(workspace, retiredPath, "manual.md"), "人工内容");
      } else if (kind === "file") {
        await mkdir(join(workspace, ".github"));
        await writeFile(join(workspace, retiredPath), "人工内容");
      } else if (kind === "parent-file") await writeFile(join(workspace, ".github"), "阻挡路径的文件");
      vi.stubEnv("STEWARD_CONFIG_DIRECTORY", join(directory, "config"));
      vi.stubEnv("GITHUB_STEP_SUMMARY", join(directory, "summary"));
      vi.stubEnv("VALIDATION_BASE_SHA", ""); vi.stubEnv("VALIDATION_BASE_REF", "");
      const validationRun = main(["validate", "--workspace", workspace, "--repository-id", "1296724484", "--profile", "steward"]);
      if (kind === "absent") await expect(validationRun).resolves.toBeUndefined();
      else await expect(validationRun).rejects.toThrow("验证任务失败");
      if (kind === "directory") expect(await readFile(join(workspace, retiredPath, "manual.md"), "utf8")).toBe("人工内容");
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  it("只读导出采用同一规则源，不调用网络或写入GitHub", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const network = vi.fn(() => { throw new Error("导出不应访问网络"); });
    vi.stubGlobal("fetch", network);
    vi.stubEnv("STEWARD_CONFIG_DIRECTORY", resolve("config"));
    try {
      await main(["render-review-instructions", "--profile", "common", "--policy-sha", base]);
      const exported = JSON.parse(String(output.mock.calls[0]![0]));
      const { $schema: _p, ...profiles } = JSON.parse(await readFile("config/review/profiles.json", "utf8"));
      const { $schema: _r, ...rules } = JSON.parse(await readFile("config/review/rules.json", "utf8"));
      expect(exported.organization).toEqual(await generateOrganizationReviewInstructions(profiles, rules));
      expect(exported.policySha).toBe(base);
      expect(exported.repository.files).toHaveLength(2);
      expect(network).not.toHaveBeenCalled();
    } finally { output.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
  it.each([null, head])("新建或更新分支以固定父提交核对原文并原子退役：%s", async branchSha => {
    const { client, input } = fixture("已知生成原文", branchSha);
    await expect(writeManagedFilesToBranch(input)).resolves.toEqual({ changed: true, headSha: committed });
    expect(client.getContent).toHaveBeenCalledWith("splrad", "steward", retiredPath, branchSha ?? base);
    expect(client.createTree).toHaveBeenCalledWith("splrad", "steward", expect.objectContaining({
      tree: [{ path: "AGENTS.md", mode: "100644", type: "blob", sha: "e".repeat(40) },
        { path: retiredPath, mode: "100644", type: "blob", sha: null }],
    }));
    expect(client.createBlob).toHaveBeenCalledTimes(1);
    expect(client.getContent).toHaveBeenCalledWith("splrad", "steward", retiredPath, committed);
  });

  it("已退役时幂等返回，不生成空提交", async () => {
    const { client, input } = fixture(null);
    await expect(writeManagedFilesToBranch(input)).resolves.toEqual({ changed: false, headSha: base });
    expect(client.createTree).not.toHaveBeenCalled();
    expect(client.createCommit).not.toHaveBeenCalled();
  });

  it("人工改动不能被退役，写入开始前拒绝", async () => {
    const { client, input } = fixture("已知生成原文加人工规则");
    await expect(writeManagedFilesToBranch(input)).rejects.toThrow("人工修改");
    expect(client.createBlob).not.toHaveBeenCalled();
    expect(client.createTree).not.toHaveBeenCalled();
  });

  it("读取失败不能被当作文件不存在", async () => {
    const { client, input } = fixture();
    client.getContent.mockRejectedValue(new GitHubRequestError(403, "GET", retiredPath, "forbidden"));
    await expect(writeManagedFilesToBranch(input)).rejects.toThrow("403");
    expect(client.createCommit).not.toHaveBeenCalled();
  });

  describe.each([null, head])("退役空响应不发布分支：%s", branchSha => {
    it.each([null, undefined])("父提交读取成功却返回%s时在写入前拒绝", async response => {
      const { client, input } = fixture("已知生成原文", branchSha);
      const getContent = client.getContent.getMockImplementation()!;
      client.getContent.mockImplementation(async (owner, repo, path, ref) =>
        path === retiredPath && ref === (branchSha ?? base) ? response : getContent(owner, repo, path, ref));
      await expect(writeManagedFilesToBranch(input)).rejects.toThrow("退役文件读取返回空响应");
      expect(client.createBlob).not.toHaveBeenCalled();
      expect(client.createTree).not.toHaveBeenCalled();
      expect(client.createCommit).not.toHaveBeenCalled();
      expect(client.createRef).not.toHaveBeenCalled();
      expect(client.updateRef).not.toHaveBeenCalled();
    });

    it.each([null, undefined])("新提交退役读回成功却返回%s时拒绝发布", async response => {
      const { client, input } = fixture("已知生成原文", branchSha);
      const getContent = client.getContent.getMockImplementation()!;
      client.getContent.mockImplementation(async (owner, repo, path, ref) =>
        path === retiredPath && ref === committed ? response : getContent(owner, repo, path, ref));
      await expect(writeManagedFilesToBranch(input)).rejects.toThrow("退役文件写入后仍然存在");
      expect(client.createCommit).toHaveBeenCalledOnce();
      expect(client.createRef).not.toHaveBeenCalled();
      expect(client.updateRef).not.toHaveBeenCalled();
    });
  });

  it("退役范围不能扩展到AGENTS或任意路径", async () => {
    const { client, input } = fixture();
    for (const path of ["AGENTS.md", "README.md", "../outside", "/absolute"]) {
      await expect(writeManagedFilesToBranch({ ...input, retiredFiles: [{ path, content: "原文" }] })).rejects.toThrow("范围");
    }
    expect(client.getContent).not.toHaveBeenCalled();
  });

  it("不能同时生成和退役同一路径", async () => {
    const { client, input } = fixture();
    await expect(writeManagedFilesToBranch({ ...input, files: [...files, { path: retiredPath, content: "新规则" }] })).rejects.toThrow("文件无效");
    expect(client.getContent).not.toHaveBeenCalled();
  });

  it("退役读回失败时不移动或创建分支", async () => {
    const { client, input, content } = fixture();
    client.getContent.mockImplementation(async (_owner, _repo, path) => content(path === retiredPath ? "已知生成原文" : "共享规则"));
    await expect(writeManagedFilesToBranch(input)).rejects.toThrow("退役文件写入后仍然存在");
    expect(client.createRef).not.toHaveBeenCalled();
    expect(client.updateRef).not.toHaveBeenCalled();
  });

  it("符号链接或目录不作为可退役普通文件", async () => {
    const { client, input, content } = fixture();
    client.getContent.mockImplementation(async (_owner, _repo, path) => path === retiredPath ? { ...content("已知生成原文"), type: "symlink" } : content("共享规则"));
    await expect(writeManagedFilesToBranch(input)).rejects.toThrow("人工修改");
    expect(client.createBlob).not.toHaveBeenCalled();
  });

  it.each(["120000", "100755", "040000"])("Git模式%s不能伪装成普通规则文件被退役", async mode => {
    const { client, input } = fixture();
    client.getGitTree.mockResolvedValue({ sha: "d".repeat(40), truncated: false, tree: [{ path: retiredPath, mode, type: "blob", sha: blobHash("已知生成原文") }] });
    await expect(writeManagedFilesToBranch(input)).rejects.toThrow("普通Git文件");
    expect(client.createBlob).not.toHaveBeenCalled();
  });

  it("截断的Git tree或不匹配blob使退役失败关闭", async () => {
    const { client, input } = fixture();
    client.getGitTree.mockResolvedValue({ sha: "d".repeat(40), truncated: true, tree: [] });
    await expect(writeManagedFilesToBranch(input)).rejects.toThrow("证据不完整");
    client.getGitTree.mockResolvedValue({ sha: "d".repeat(40), truncated: false, tree: [{ path: retiredPath, mode: "100644", type: "blob", sha: "0".repeat(40) }] });
    await expect(writeManagedFilesToBranch(input)).rejects.toThrow("普通Git文件");
    expect(client.createBlob).not.toHaveBeenCalled();
  });
});
