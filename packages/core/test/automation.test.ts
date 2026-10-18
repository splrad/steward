import { describe, expect, it } from "vitest";
import {
  escapeMarkdownText,
  type GeneratedSummary,
  organizationPullRequestTemplate,
  renderManagedBody,
  summaryEnd,
  summaryStart,
} from "../src/automation.js";
import { contributorBlockAnchor, renderIssueLinksBlock, upsertIssueLinksBlock } from "../src/issues.js";
import { isHumanActor, normalizeContributor } from "../src/identity.js";

const valid: GeneratedSummary = {
  type: "feat",
  scope: "repo",
  title: "增加中央规则",
  summary: "本次修改将拉取请求标题与正文改为由SPLRAD Steward统一生成和维护。",
  motivation: "现有流程仍保留人工补充区，而且Copilot生成步骤可能被条件判断跳过。",
  changes: ["调整人工智能输出字段并按实际内容渲染正文章节", "修复Copilot生成步骤的工作流触发条件"],
  impact: ["后续自动拉取请求的正文将完全由人工智能或确定性回退生成"],
  releaseAndMigration: [],
} as const;

describe("拉取请求自动化", () => {
  it("生成完整正文、展示多人贡献者并迁移旧模板", () => {
    const template = `人工前言\n<!-- workflow:auto-summary:start -->\n等待生成\n<!-- workflow:auto-summary:end -->\n### 人工补充\n旧内容\n`;
    const body = renderManagedBody({
      generated: (valid),
      templateBody: template,
      actor: "axiomoth",
      contributors: [
        { id: 44151430, login: "axiomoth", name: "Axiom Oth", avatarUrl: "https://avatars.githubusercontent.com/u/44151430?v=4" },
        { id: 12345678, login: "contributor2", name: "Contributor Two", avatarUrl: "https://avatars.githubusercontent.com/u/12345678?v=4" },
      ],
      context: "c".repeat(64),
    });
    expect(body.startsWith(`${summaryStart}\n## 摘要`)).toBe(true);
    expect(body).toContain("## 变更原因");
    expect(body).not.toContain("## 背景与目标");
    expect(body).toContain("## 主要改动");
    expect(body).toContain("## 影响分析");
    expect(body).not.toContain("## 关联事项");
    expect(body).not.toContain("## 发布与迁移");
    expect(body).toContain("## 贡献者");
    expect(body).toContain('aria-label="查看第1位贡献者的GitHub资料"');
    expect(body).toContain('<img src="https://avatars.githubusercontent.com/u/44151430?v=4" alt=""');
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("显示名称");
    expect(body).not.toContain("Axiom Oth");
    expect(body).not.toContain("GitHub：");
    expect(body).toContain('<a href="https://github.com/axiomoth">@axiomoth</a> · <a href="https://github.com/contributor2">@contributor2</a>');
    expect(body).toContain('<!-- workflow:source-contributors:axiomoth,contributor2 -->');
    expect(body).not.toContain("人工前言");
    expect(body).not.toContain("### 人工补充");
    expect(body).not.toContain("旧内容");
    expect(body).not.toContain("Co-authored-by");
    expect(body.match(/workflow:managed-pr:start/g)).toHaveLength(1);
    expect(body.match(/workflow:managed-pr:end/g)).toHaveLength(1);
  });

  it("没有对应内容时省略可选章节和机器人贡献者章节", () => {
    const generated = ({ ...valid, motivation: null, impact: [], releaseAndMigration: [] });
    const body = renderManagedBody({ generated, templateBody: organizationPullRequestTemplate, actor: "splrad-steward[bot]", contributors: [], context: "x" });
    for (const heading of ["变更原因", "背景与目标", "影响分析", "关联事项", "发布与迁移", "贡献者"]) expect(body).not.toContain(`## ${heading}`);
    expect(body).toContain("## 摘要");
    expect(body).toContain("## 主要改动");
    expect(body).not.toContain("贡献者：");
    expect(body).toContain("<!-- workflow:source-contributors: -->");
    expect(body).not.toContain(contributorBlockAnchor);
  });

  it.each(["axiomoth", "splrad-steward[bot]"])("单人贡献者显示为一行，来源账号为%s", (actor) => {
    const body = renderManagedBody({
      generated: (valid), templateBody: organizationPullRequestTemplate,
      actor, contributors: [{ id: 44151430, login: "axiomoth" }], context: "single",
    });
    expect(body).toContain('\n\n贡献者：<a href="https://github.com/axiomoth">@axiomoth</a>\n\n<!-- workflow:source-actor:');
    expect(body).not.toContain("## 贡献者");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<details>");
    expect(body).toContain(`<!-- workflow:source-actor:${actor} -->`);
    expect(body).toContain("<!-- workflow:source-contributors:axiomoth -->");
    expect(body).toContain(`${contributorBlockAnchor}\n\n贡献者：`);
  });

  it.each([0, 1, 2])("旧贡献者章节更新为当前%d人样式", (count) => {
    const contributors = [{ id: 44151430, login: "axiomoth" }, { id: 12345678, login: "contributor2" }].slice(0, count);
    const existingBody = `${summaryStart}\n## 贡献者\n\n<details>\n<summary>查看贡献者信息</summary>\n旧贡献者列表\n</details>\n<!-- workflow:source-contributors:former -->\n${summaryEnd}\n`;
    const input = { generated: (valid), templateBody: organizationPullRequestTemplate, actor: "axiomoth", contributors, context: "updated" };
    const rebuilt = renderManagedBody({ ...input, existingBody });
    expect(rebuilt).toBe(renderManagedBody(input));
    expect(rebuilt).not.toContain("查看贡献者信息");
    expect(rebuilt).not.toContain("旧贡献者列表");
    expect(rebuilt).not.toContain("former");
    expect(rebuilt.match(/workflow:source-contributors:/g)).toHaveLength(1);
    expect(rebuilt.split(contributorBlockAnchor).length - 1).toBe(count ? 1 : 0);
    expect(renderManagedBody({ ...input, existingBody: rebuilt })).toBe(rebuilt);
  });

  it.each([false, true])("单人正文插入议题块与完整重建顺序一致，包含发布章节：%s", (withRelease) => {
    const input = {
      generated: ({ ...valid, releaseAndMigration: withRelease ? ["更新发布说明"] : [] }),
      templateBody: organizationPullRequestTemplate, actor: "axiomoth",
      contributors: [{ id: 44151430, login: "axiomoth" }], context: "issue-order",
    };
    const issueBlock = renderIssueLinksBlock({
      repositoryId: 1187527897, pullRequestNumber: 191,
      baseSha: "0".repeat(40), headSha: "1".repeat(40), generation: 1, analysisInputDigest: "a".repeat(64),
    }, [{ repositoryId: 1187527897, number: 135 }]);
    const inserted = upsertIssueLinksBlock(renderManagedBody(input), issueBlock);
    expect(inserted.indexOf("## 解决的议题")).toBeLessThan(inserted.indexOf("贡献者："));
    if (withRelease) expect(inserted.indexOf("## 解决的议题")).toBeLessThan(inserted.indexOf("## 发布与迁移"));
    expect(inserted).toBe(renderManagedBody({ ...input, existingBody: inserted }));
    expect(upsertIssueLinksBlock(inserted, issueBlock)).toBe(inserted);
  });

  it.each([1, 2])("议题块通过语义标记定位%d人贡献者区域", (count) => {
    const input = {
      generated: ({ ...valid, releaseAndMigration: [] }),
      templateBody: organizationPullRequestTemplate, actor: "axiomoth",
      contributors: [{ id: 44151430, login: "axiomoth" }, { id: 12345678, login: "contributor2" }].slice(0, count),
      context: "semantic-anchor",
    };
    const body = renderManagedBody(input)
      .replaceAll("https://github.com/", "https://profiles.example/")
      .replaceAll("## 贡献者", "## Contributors")
      .replaceAll("贡献者：", "Contributors: ");
    const issueBlock = renderIssueLinksBlock({
      repositoryId: 1187527897, pullRequestNumber: 191,
      baseSha: "0".repeat(40), headSha: "1".repeat(40), generation: 1, analysisInputDigest: "a".repeat(64),
    }, [{ repositoryId: 1187527897, number: 135 }]);
    const inserted = upsertIssueLinksBlock(body, issueBlock);
    expect(inserted.indexOf("## 解决的议题")).toBeLessThan(inserted.indexOf(contributorBlockAnchor));
    expect(inserted.replace(`${issueBlock}\n\n`, "")).toBe(body);
    expect(upsertIssueLinksBlock(inserted, issueBlock)).toBe(inserted);
  });

  it("普通正文重建逐字保留唯一合法议题子块并拒绝损坏子块", () => {
    const issueBlock = renderIssueLinksBlock({
      repositoryId: 1187527897,
      pullRequestNumber: 42,
      baseSha: "0".repeat(40),
      headSha: "1".repeat(40),
      generation: 17,
      analysisInputDigest: "a".repeat(64),
    }, [{ repositoryId: 1187527897, number: 135 }]);
    const withRelease = ({ ...valid, releaseAndMigration: ["无需迁移，发布行为保持不变"] });
    const previous = upsertIssueLinksBlock(
      renderManagedBody({ generated: withRelease, templateBody: organizationPullRequestTemplate, actor: "axiomoth", contributors: [], context: "old" }),
      issueBlock,
    );
    const rebuilt = renderManagedBody({ generated: ({ ...valid, summary: "本次修改重新生成普通正文，同时必须保留议题工作流拥有的原始子块。", releaseAndMigration: ["无需迁移，发布行为保持不变"] }), existingBody: previous, templateBody: organizationPullRequestTemplate, actor: "axiomoth", contributors: [], context: "new" });
    expect(rebuilt).toContain(issueBlock);
    expect(rebuilt.match(/workflow:issue-links:start/g)).toHaveLength(1);
    expect(rebuilt.indexOf("## 影响分析")).toBeLessThan(rebuilt.indexOf("## 解决的议题"));
    expect(rebuilt.indexOf("## 解决的议题")).toBeLessThan(rebuilt.indexOf("## 发布与迁移"));
    expect(() => renderManagedBody({ generated: (valid), existingBody: previous.replace("workflow:issue-links:end", "workflow:issue-links:broken"), templateBody: organizationPullRequestTemplate, actor: "axiomoth", contributors: [], context: "new" })).toThrow("议题");
  });

  it("将人工智能依据中的Markdown控制符转义为纯文本", () => {
    expect(escapeMarkdownText("packages/core/a_b*~|file.ts"))
      .toBe("packages/core/a\\_b\\*\\~\\|file\\.ts");
  });

  it("拒绝缺失、重复或交叉的受管标记", () => {
    const input = { generated: (valid), actor: "axiomoth", contributors: [], context: "x" };
    expect(() => renderManagedBody({ ...input, templateBody: "无标记" })).toThrow("标记");
    expect(() => renderManagedBody({ ...input, templateBody: `${summaryStart}\n${summaryStart}\n${summaryEnd}` })).toThrow("标记");
    expect(() => renderManagedBody({ ...input, templateBody: `${summaryEnd}\n${summaryStart}` })).toThrow("标记");
  });

  it("贡献者只接受可识别真人并排除机器人", () => {
    expect(isHumanActor({ id: 44151430, login: "axiomoth", type: "User" })).toBe(true);
    expect(isHumanActor({ id: 301115370, login: "splrad-steward[bot]", type: "Bot" })).toBe(false);
    expect(normalizeContributor({ id: 44151430, login: "axiomoth", type: "User", name: " Axiom ", email: " owner@example.com ", avatarUrl: " https://avatars.githubusercontent.com/u/44151430?v=4 " })).toEqual({ id: 44151430, login: "axiomoth", name: "Axiom", email: "owner@example.com", avatarUrl: "https://avatars.githubusercontent.com/u/44151430?v=4" });
    expect(normalizeContributor({ id: 44151430, login: "axiomoth", type: "User", name: ` A\n\tB${"字".repeat(100_000)} ` })).toEqual({ id: 44151430, login: "axiomoth", name: `A B${"字".repeat(77)}` });
    expect(normalizeContributor({ id: 44151430, login: "axiomoth", type: "User", email: `${"a".repeat(100_000)}@example.com` })).toEqual({ id: 44151430, login: "axiomoth" });
    expect(normalizeContributor({ id: 301115370, login: "splrad-steward[bot]", type: "Bot" })).toBeNull();
  });
});
