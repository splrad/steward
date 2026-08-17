import { describe, expect, it } from "vitest";
import defaultProfile from "../../../config/profiles/classification/default.json" with { type: "json" };
import layerScapeProfile from "../../../config/profiles/classification/layerscape.json" with { type: "json" };
import { classifyPullRequest, classifyReleasePullRequest, reconcileManagedLabels } from "../src/classification.js";
import { computePullRequestFingerprint } from "../src/fingerprint.js";

describe("拉取请求分类", () => {
  it("覆盖LayerScape全部区域", () => {
    const cases = [
      ["src/AFR.Core/a.cs", "area:runtime"],
      ["Version.props", "area:release"],
      [".github/copilot-instructions.md", "area:automation"],
      ["docs/a.md", "area:docs"],
      ["CADFontAutoReplace.slnx", "area:config"],
    ] as const;
    for (const [file, area] of cases) {
      const result = classifyPullRequest(layerScapeProfile, { title: "chore: 更新内容", body: "", files: [file], currentLabels: [] });
      expect(result.areas, file).toContain(area);
    }
  });

  it("覆盖所有公开类型并保留人工标签", () => {
    const cases = [
      ["feat!: 不兼容修改", "breaking-change"],
      ["fix: 修复安全漏洞", "security"],
      ["fix: 修复插件", "bug"],
      ["feat: 增加功能", "feature"],
      ["perf: 提升性能", "performance"],
      ["build: 更新打包", "build"],
      ["refactor: 整理插件", "plugin"],
      ["docs: 更新说明", "documentation"],
      ["chore: 更新配置", "chore"],
    ] as const;
    for (const [title, kind] of cases) {
      const files = kind === "documentation" ? ["docs/a.md"] : ["src/AFR.Core/a.cs"];
      expect(classifyPullRequest(layerScapeProfile, { title, body: "", files, currentLabels: [] }).kind, title).toBe(kind);
    }
    const result = classifyPullRequest(layerScapeProfile, { title: "fix: 修复插件", body: "", files: ["src/AFR.Core/a.cs"], currentLabels: ["manual"] });
    const plan = reconcileManagedLabels(layerScapeProfile, ["manual", "documentation"], result);
    expect(plan.keep).toEqual(["manual"]);
    expect(plan.add).toEqual(["bug"]);
    expect(plan.remove).toEqual(["documentation"]);
  });

  it("覆盖七个发布类别和非运行时代码排除", () => {
    const cases = [
      ["feat!: 不兼容修改", "破坏性变更", ["src/a.cs"]],
      ["fix: 修复安全漏洞", "安全修复", ["src/a.cs"]],
      ["feat: 新增功能", "新增功能", ["src/a.cs"]],
      ["fix: 修复问题", "问题修复", ["src/a.cs"]],
      ["perf: 提升性能", "性能优化", ["src/a.cs"]],
      ["build: 更新安装包", "安装与发布包", ["tools/Publish-ReleaseAssets.ps1"]],
      ["refactor: 整理插件", "其他插件变更", ["src/a.cs"]],
    ] as const;
    for (const [title, category, files] of cases) {
      const facts = { title, body: "", files: [...files], currentLabels: [] };
      const classification = classifyPullRequest(layerScapeProfile, facts);
      expect(classifyReleasePullRequest(layerScapeProfile, facts, classification)?.title, title).toBe(category);
    }
    for (const file of ["Version.props", "docs/a.md", ".github/copilot-instructions.md"]) {
      const facts = { title: "chore: 更新维护文件", body: "", files: [file], currentLabels: [] };
      const classification = classifyPullRequest(layerScapeProfile, facts);
      expect(classification.runtimeRelease, file).toBe(false);
      expect(classifyReleasePullRequest(layerScapeProfile, facts, classification), file).toBeNull();
    }
  });

  it("默认配置区分文档、工作流和普通维护并拒绝空文件集合", () => {
    expect(classifyPullRequest(defaultProfile, { title: "docs: 更新", body: "", files: ["README.md"], currentLabels: [] }).kind).toBe("documentation");
    expect(classifyPullRequest(defaultProfile, { title: "update", body: "", files: [".github/workflows/a.yml"], currentLabels: [] }).kind).toBe("workflow");
    expect(classifyPullRequest(defaultProfile, { title: "update", body: "", files: ["config.txt"], currentLabels: [] }).kind).toBe("chore");
    expect(() => classifyPullRequest(defaultProfile, { title: "update", body: "", files: [], currentLabels: [] })).toThrow("完整文件集合");
  });

  it("指纹覆盖标题、正文、提交、文件、贡献者、来源和目标提交", async () => {
    const base = {
      repositoryId: 1,
      pullRequestNumber: 2,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      commits: ["c".repeat(40)],
      files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
      title: "fix: 修复",
      body: "正文",
      contributors: [{ id: 1, login: "a" }],
    };
    const value = await computePullRequestFingerprint(base);
    for (const changed of [
      { ...base, title: "fix: 另一个修复" },
      { ...base, body: "另一个正文" },
      { ...base, headSha: "d".repeat(40) },
      { ...base, baseSha: "e".repeat(40) },
      { ...base, commits: ["f".repeat(40)] },
      { ...base, files: [{ ...base.files[0]!, additions: 2 }] },
      { ...base, contributors: [{ id: 2, login: "b" }] },
    ]) expect(await computePullRequestFingerprint(changed)).not.toBe(value);
    expect(await computePullRequestFingerprint({ ...base, commits: [...base.commits].reverse(), files: [...base.files].reverse() })).toBe(value);
    const contributorsWithDisplayFields = [{ id: 1, login: "a", name: "显示名称", email: "a@example.com", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" }];
    expect(await computePullRequestFingerprint({ ...base, contributors: contributorsWithDisplayFields })).toBe(value);
  });
});
