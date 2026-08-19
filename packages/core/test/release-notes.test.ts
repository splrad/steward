import { describe, expect, it } from "vitest";
import profile from "../../../config/profiles/classification/layerscape.json" with { type: "json" };
import type { ClassificationDecision, ClassificationProfile } from "../src/classification.js";
import { categorizeReleasePullRequests, collectReleasePullRequests, renderReleaseNotes, selectPreviousRelease, type CategorizedReleasePullRequest, type ReleasePullRequest } from "../src/release-notes.js";

function pull(number: number, title: string, files = ["src/a.cs"], labels: string[] = [], login = "alice", type = "User"): ReleasePullRequest {
  const runtimeRelease = files.some(file => file.startsWith("src/"));
  const decision: ClassificationDecision = { primaryKind: { id: "chore", source: "deterministic-fallback", reasonCode: "primary-fallback-selected" }, riskFlags: [], facets: [], areas: runtimeRelease ? [{ id: "area:runtime", source: "rule", ruleId: "test" }] : [], aiState: "missing", runtimeRelease, installOrPackage: false };
  return { number, title, body: "", labels, files, author: { login, type }, mergedAt: `2026-08-16T00:00:0${number}Z`, mergeSha: String(number).repeat(40).slice(0, 40), decision };
}

describe("发布说明", () => {
  it("选择最新第一父祖先发布", () => {
    const releases = [
      { tag: "v1.0.0", targetSha: "a", publishedAt: "2026-01-01T00:00:00Z", draft: false, prerelease: false },
      { tag: "v2.0.0", targetSha: "b", publishedAt: "2026-02-01T00:00:00Z", draft: false, prerelease: false },
      { tag: "v3.0.0", targetSha: "c", publishedAt: "2026-03-01T00:00:00Z", draft: true, prerelease: false },
    ];
    expect(selectPreviousRelease(releases, new Set(["a", "b"]))?.tag).toBe("v2.0.0");
    expect(selectPreviousRelease(releases, new Set())).toBeNull();
  });

  it("排除四个标签、按时间和编号排序并去重", () => {
    const excluded = ["ignore-for-release", "skip-changelog", "no-changelog", "no-release-notes"];
    const values = [pull(3, "third"), pull(2, "excluded", ["src/a.cs"], ["no-changelog"]), pull(1, "first"), { ...pull(3, "latest duplicate"), mergedAt: "2026-08-17T00:00:00Z" }];
    expect(collectReleasePullRequests(values, excluded).map(value => value.title)).toEqual(["first", "latest duplicate"]);
    for (const label of excluded) expect(collectReleasePullRequests([pull(1, "x", ["src/a.cs"], [label])], excluded)).toEqual([]);
  });

  it("排除纯版本、文档和自动化改动", () => {
    const values = [pull(1, "version", ["Version.props"]), pull(2, "docs", ["docs/a.md"]), pull(3, "automation", [".github/copilot-instructions.md"]), pull(4, "runtime", ["src/a.cs"])];
    expect(categorizeReleasePullRequests(profile as unknown as ClassificationProfile, values).map(value => value.number)).toEqual([4]);
  });

  it("类别始终按七类固定顺序输出，机器人不生成账号链接，真人贡献者去重", () => {
    const definitions = [
      ["其他插件变更", "🔌", 7],
      ["安装与发布包", "📦", 6],
      ["性能优化", "⚡", 5],
      ["问题修复", "🛠", 4],
      ["新增功能", "✨", 3],
      ["安全修复", "🔒", 2],
      ["破坏性变更", "🚨", 1],
    ] as const;
    const categorized: CategorizedReleasePullRequest[] = definitions.map(([title, icon, number]) => ({ ...pull(number, `更新 ${title}`, ["src/a.cs"], [], number === 6 ? "dependabot[bot]" : "alice", number === 6 ? "Bot" : "User"), category: { title, icon } }));
    const text = renderReleaseNotes({ repositoryId: 1187527897, targetSha: "a".repeat(40), policySha: "b".repeat(40), displayVersion: "1.2.3", categorized, emptyRuntimeText: "空" });
    const headings = [...text.matchAll(/^### (.+)$/gmu)].map(match => match[1]);
    expect(headings).toEqual(["🚨 破坏性变更", "🔒 安全修复", "✨ 新增功能", "🛠 问题修复", "⚡ 性能优化", "📦 安装与发布包", "🔌 其他插件变更"]);
    expect(text).toContain("贡献者：自动化机器人");
    expect(text.match(/\[@alice\]\(https:\/\/github\.com\/alice\)/g)).toHaveLength(7);
    expect(text.match(/^\[@alice\]\(https:\/\/github\.com\/alice\)$/gmu)).toHaveLength(1);
    expect(text).not.toContain("github.com/dependabot");
  });

  it("第6.7节完整正文逐字稳定", () => {
    const categorized: CategorizedReleasePullRequest[] = [{ ...pull(12, "修复  多余\n空格"), category: { title: "问题修复", icon: "🛠" } }];
    const actual = renderReleaseNotes({ repositoryId: 1187527897, targetSha: "a".repeat(40), policySha: "b".repeat(40), displayVersion: "1.2.3", categorized, emptyRuntimeText: "本版本无用户可见运行代码变化。" });
    const expected = `<!-- steward:release-notes:v1 repository=1187527897 target=${"a".repeat(40)} policy=${"b".repeat(40)} -->

## 📦 下载说明

| 文件 | 用途 |
| --- | --- |
| \`AFR-Deployer_v1.2.3.exe\` | 普通用户安装或升级LayerScape的首选安装程序 |
| \`AFR-DLL_v1.2.3.zip\` | 手工部署AutoCAD 2018至2027插件文件 |
| \`Fonts.zip\` | 单独获取随产品发布的字体资源 |

一般用户只需下载 **AFR-Deployer_v1.2.3.exe**。需要手工部署插件文件时下载 **AFR-DLL_v1.2.3.zip**；仅需字体资源时下载 **Fonts.zip**。

---

## 🆕 更新内容

### 🛠 问题修复

- 修复 多余 空格（拉取请求 [#12](https://github.com/splrad/LayerScape/pull/12)；贡献者：[@alice](https://github.com/alice)）

## 👥 贡献者

[@alice](https://github.com/alice)

---

## ⚠️ 升级说明

- 支持直接覆盖安装。
- 无需卸载旧版本。
- 已安装字体不会被删除。
`;
    expect(actual).toBe(expected);
  });

  it("没有运行时代码时只输出固定空正文", () => {
    const text = renderReleaseNotes({ repositoryId: 1187527897, targetSha: "a".repeat(40), policySha: "b".repeat(40), displayVersion: "1.2.3", categorized: [], emptyRuntimeText: "本版本无用户可见运行代码变化。" });
    expect(text).toContain("本版本无用户可见运行代码变化。");
    expect(text).not.toContain("## 👥 贡献者");
    expect(text).toContain("无需卸载旧版本。");
  });
});
