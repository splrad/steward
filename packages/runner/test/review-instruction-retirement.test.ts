import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { generateOrganizationReviewInstructions } from "../../core/src/index.js";
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
