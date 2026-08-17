import { describe, expect, it } from "vitest";
import {
  buildDeterministicSummary,
  buildPrompt,
  organizationPullRequestTemplate,
  renderManagedBody,
  summaryEnd,
  summaryStart,
  validateGeneratedSummary,
} from "../src/automation.js";
import { isHumanActor, normalizeContributor } from "../src/identity.js";

const valid = {
  type: "feat",
  scope: "repo",
  title: "增加中央规则",
  summary: "本次修改将拉取请求标题与正文改为由SPLRAD Steward统一生成和维护。",
  motivation: "现有流程仍保留人工补充区，而且Copilot生成步骤可能被条件判断跳过。",
  changes: ["调整人工智能输出字段并按实际内容渲染正文章节", "修复Copilot生成步骤的工作流触发条件"],
  impact: ["后续自动拉取请求的正文将完全由人工智能或确定性回退生成"],
  related: ["#135"],
  releaseAndMigration: [],
} as const;

describe("拉取请求自动化", () => {
  it("接受完整中文结构并拒绝每类无效字段", () => {
    expect(validateGeneratedSummary(valid)).toEqual(valid);
    const invalid: unknown[] = [
      null,
      { ...valid, type: "unknown" },
      { ...valid, scope: "UPPER" },
      { ...valid, title: "feat: 增加中央规则" },
      { ...valid, title: "增加中央规则。" },
      { ...valid, title: `增加中央规则${"a".repeat(100)}` },
      { ...valid, summary: "太短" },
      { ...valid, motivation: "太短" },
      { ...valid, changes: [] },
      { ...valid, changes: ["太短"] },
      { ...valid, impact: Array.from({ length: 7 }, () => "更新后的拉取请求正文完全由人工智能管理") },
      { ...valid, related: ["#1\n#2"] },
      { ...valid, related: ["<!-- workflow:managed-pr:end -->"] },
      { ...valid, related: ["--!>"] },
      { ...valid, releaseAndMigration: ["太短"] },
      { ...valid, extra: true },
    ];
    for (const value of invalid) expect(() => validateGeneratedSummary(value)).toThrow();
  });

  it("生成约定式标题、完整模板和确定性中文回退", () => {
    const facts = {
      sourceRef: "refs/heads/feature/rule",
      targetRef: "refs/heads/main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      commitSubjects: ["fix(core): 修复错误"],
      files: ["src/a.ts", "docs/a.md"],
      diffStat: "2个文件",
      diffExcerpt: "diff",
      areas: ["area:source"],
      contributors: [],
    };
    const generated = buildDeterministicSummary(facts);
    expect(generated).toMatchObject({ type: "fix", scope: "core", title: "修复错误" });
    expect(`${generated.type}(${generated.scope}): ${generated.title}`).toBe("fix(core): 修复错误");
    expect(organizationPullRequestTemplate).toContain(summaryStart);
    expect(organizationPullRequestTemplate).toContain(summaryEnd);
    expect(organizationPullRequestTemplate).not.toContain("人工补充");
    expect(buildPrompt(facts, generated)).toContain(JSON.stringify(generated));
    expect(buildPrompt(facts, generated)).toContain("没有对应事实时必须返回空数组");
    expect(buildDeterministicSummary({ ...facts, commitSubjects: [`ci:${" ".repeat(100_000)}修复中央验证`] })).toMatchObject({ type: "ci", title: "修复中央验证" });
    expect(buildDeterministicSummary({ ...facts, commitSubjects: ["fix(THIS-SCOPE-IS-WAY-TOO-LONG): 修复错误"] })).toMatchObject({ scope: "this-scope-is-way-to" });
    expect(buildDeterministicSummary({ ...facts, commitSubjects: ["普通提交"], areas: ["area:中文"] })).toMatchObject({ scope: "repo" });
  });

  it("生成完整正文、折叠贡献者信息并迁移旧模板", () => {
    const template = `人工前言\n<!-- workflow:auto-summary:start -->\n等待生成\n<!-- workflow:auto-summary:end -->\n### 人工补充\n旧内容\n`;
    const body = renderManagedBody({
      generated: validateGeneratedSummary(valid),
      templateBody: template,
      actor: "axiomoth",
      contributors: [{ id: 44151430, login: "axiomoth", name: "Axiom Oth", avatarUrl: "https://avatars.githubusercontent.com/u/44151430?v=4" }],
      context: "c".repeat(64),
    });
    expect(body.startsWith(`${summaryStart}\n## 摘要`)).toBe(true);
    expect(body).toContain("## 背景与目标");
    expect(body).toContain("## 主要改动");
    expect(body).toContain("## 影响分析");
    expect(body).toContain("## 关联事项");
    expect(body).not.toContain("## 发布与迁移");
    expect(body).toContain("## 贡献者");
    expect(body).toContain('aria-label="查看第1位贡献者的GitHub资料"');
    expect(body).toContain('<img src="https://avatars.githubusercontent.com/u/44151430?v=4" alt=""');
    expect(body).toContain("<details>");
    expect(body).toContain("显示名称：</strong>Axiom Oth");
    expect(body).toContain('GitHub：</strong><a href="https://github.com/axiomoth">@axiomoth</a>');
    expect(body).not.toContain("人工前言");
    expect(body).not.toContain("### 人工补充");
    expect(body).not.toContain("旧内容");
    expect(body).not.toContain("Co-authored-by");
    expect(body.match(/workflow:managed-pr:start/g)).toHaveLength(1);
    expect(body.match(/workflow:managed-pr:end/g)).toHaveLength(1);
  });

  it("没有对应内容时省略可选章节和机器人贡献者章节", () => {
    const generated = validateGeneratedSummary({ ...valid, motivation: null, impact: [], related: [], releaseAndMigration: [] });
    const body = renderManagedBody({ generated, templateBody: organizationPullRequestTemplate, actor: "splrad-steward[bot]", contributors: [], context: "x" });
    for (const heading of ["背景与目标", "影响分析", "关联事项", "发布与迁移", "贡献者"]) expect(body).not.toContain(`## ${heading}`);
    expect(body).toContain("## 摘要");
    expect(body).toContain("## 主要改动");
  });

  it("拒绝缺失、重复或交叉的受管标记", () => {
    const input = { generated: validateGeneratedSummary(valid), actor: "axiomoth", contributors: [], context: "x" };
    expect(() => renderManagedBody({ ...input, templateBody: "无标记" })).toThrow("标记");
    expect(() => renderManagedBody({ ...input, templateBody: `${summaryStart}\n${summaryStart}\n${summaryEnd}` })).toThrow("标记");
    expect(() => renderManagedBody({ ...input, templateBody: `${summaryEnd}\n${summaryStart}` })).toThrow("标记");
  });

  it("贡献者只接受可识别真人并排除机器人", () => {
    expect(isHumanActor({ id: 44151430, login: "axiomoth", type: "User" })).toBe(true);
    expect(isHumanActor({ id: 301115370, login: "splrad-steward[bot]", type: "Bot" })).toBe(false);
    expect(normalizeContributor({ id: 44151430, login: "axiomoth", type: "User", name: " Axiom ", email: " owner@example.com ", avatarUrl: " https://avatars.githubusercontent.com/u/44151430?v=4 " })).toEqual({ id: 44151430, login: "axiomoth", name: "Axiom", email: "owner@example.com", avatarUrl: "https://avatars.githubusercontent.com/u/44151430?v=4" });
    expect(normalizeContributor({ id: 44151430, login: "axiomoth", type: "User", email: `${"a".repeat(100_000)}@example.com` })).toEqual({ id: 44151430, login: "axiomoth" });
    expect(normalizeContributor({ id: 301115370, login: "splrad-steward[bot]", type: "Bot" })).toBeNull();
  });
});
