import { describe, expect, it } from "vitest";
import {
  buildDeterministicSummary,
  buildPrompt,
  escapeMarkdownText,
  organizationPullRequestTemplate,
  renderManagedBody,
  summaryEnd,
  summaryStart,
  validateAiClassificationSuggestion,
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
  classification: {
    kind: "feature",
    confidence: "high",
    evidence: ["packages/core/src/automation.ts新增结构化分类建议字段"],
  },
} as const;

describe("拉取请求自动化", () => {
  it("接受完整结构并拒绝每类无效字段", () => {
    expect(validateGeneratedSummary(valid)).toEqual(valid);
    const englishBody = {
      ...valid,
      title: "Preserve GitHub API field names",
      summary: "Update pull request body generation without translating established API names.",
      motivation: "GitHub API fields are clearer when their original names are retained.",
      changes: ["Preserve pull_request event names and code identifiers in generated summaries."],
      impact: ["Maintainers can compare generated text directly with GitHub API documentation."],
      releaseAndMigration: ["No migration is required for existing pull requests."],
    };
    expect(validateGeneratedSummary(englishBody)).toEqual(englishBody);
    const { classification: _classification, ...withoutClassification } = valid;
    expect(validateGeneratedSummary({ ...valid, classification: null })).toEqual(withoutClassification);
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
      { ...valid, classification: { ...valid.classification, kind: "feature?" } },
      { ...valid, classification: { ...valid.classification, confidence: "certain" } },
      { ...valid, classification: { ...valid.classification, evidence: [] } },
      { ...valid, classification: { ...valid.classification, evidence: ["src/a.ts\n伪造第二行"] } },
      { ...valid, classification: { ...valid.classification, extra: true } },
      { ...valid, extra: true },
    ];
    for (const value of invalid) expect(() => validateGeneratedSummary(value)).toThrow();
    expect(validateAiClassificationSuggestion(valid.classification, ["feature", "bug"])).toEqual(valid.classification);
    expect(() => validateAiClassificationSuggestion(valid.classification, ["bug"])).toThrow("不属于当前分类配置");
  });

  it("生成约定式标题、完整模板和确定性回退", () => {
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
    const prompt = buildPrompt(facts, generated, ["feature", "bug", "chore"]);
    expect(prompt).toContain(JSON.stringify(generated));
    expect(prompt).toContain("没有对应事实时必须返回空数组");
    expect(prompt).toContain("motivation仅在本次提交信息或差异中存在明确的问题、需求或决策依据时使用");
    expect(prompt).toContain("summary、motivation和changes必须基于本次提交信息和差异事实填写");
    expect(prompt).toContain("motivation只说明为什么需要本次修改，不得重复summary或changes");
    expect(prompt).toContain("正文写给提交者和维护者");
    expect(prompt).toContain("不使用“人类推送”“真人推送”“普通人类”等内部分类称呼");
    expect(prompt).toContain("不使用“不仅……而且……”和为了凑数的三项并列");
    expect(prompt).toContain("不得加入第一人称、情绪、幽默、主观评价或差异没有提供的事实");
    expect(prompt).toContain("classification是只读影子建议，不直接写入标签");
    expect(prompt).toContain("无法基于已显示差异给出建议时必须为null");
    expect(prompt).toContain("kind只能使用feature、bug、chore");
    expect(buildDeterministicSummary({ ...facts, commitSubjects: [`ci:${" ".repeat(100_000)}修复中央验证`] })).toMatchObject({ type: "ci", title: "修复中央验证" });
    expect(buildDeterministicSummary({ ...facts, commitSubjects: ["fix(core): Preserve GitHub API names"] })).toMatchObject({ type: "fix", scope: "core", title: "Preserve GitHub API names" });
    expect(buildDeterministicSummary({ ...facts, commitSubjects: ["fix(THIS-SCOPE-IS-WAY-TOO-LONG): 修复错误"] })).toMatchObject({ scope: "this-scope-is-way-to" });
    expect(buildDeterministicSummary({ ...facts, commitSubjects: ["普通提交"], areas: ["area:中文"] })).toMatchObject({ scope: "repo" });
    expect(buildDeterministicSummary({ ...facts, commitSubjects: [`fix(${"-".repeat(100_000)}): 修复错误`] })).toMatchObject({ scope: "repo" });
  });

  it("生成完整正文、折叠贡献者信息并迁移旧模板", () => {
    const template = `人工前言\n<!-- workflow:auto-summary:start -->\n等待生成\n<!-- workflow:auto-summary:end -->\n### 人工补充\n旧内容\n`;
    const body = renderManagedBody({
      generated: validateGeneratedSummary(valid),
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
    expect(body).toContain("## 关联事项");
    expect(body).toContain("- #135");
    expect(body).not.toContain("## 发布与迁移");
    expect(body).toContain("## 贡献者");
    expect(body).toContain('aria-label="查看第1位贡献者的GitHub资料"');
    expect(body).toContain('<img src="https://avatars.githubusercontent.com/u/44151430?v=4" alt=""');
    expect(body).toContain("<details>");
    expect(body).not.toContain("显示名称");
    expect(body).not.toContain("Axiom Oth");
    expect(body).not.toContain("GitHub：");
    expect(body).toContain('<li><a href="https://github.com/axiomoth">@axiomoth</a></li>');
    expect(body).toContain('<li><a href="https://github.com/contributor2">@contributor2</a></li>');
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
    for (const heading of ["变更原因", "背景与目标", "影响分析", "关联事项", "发布与迁移", "贡献者"]) expect(body).not.toContain(`## ${heading}`);
    expect(body).toContain("## 摘要");
    expect(body).toContain("## 主要改动");
  });

  it("将确定性回退中的路径片段作为纯文本渲染", () => {
    const generated = buildDeterministicSummary({
      sourceRef: "refs/heads/feature/untrusted-path",
      targetRef: "refs/heads/main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      commitSubjects: ["普通提交"],
      files: ["<img src=x onerror=alert(1)>\n#伪标题/a.ts"],
      diffStat: "1个文件",
      diffExcerpt: "diff",
      areas: ["area:source"],
      contributors: [],
    });
    const body = renderManagedBody({ generated, templateBody: organizationPullRequestTemplate, actor: "axiomoth", contributors: [], context: "x" });
    expect(body).toContain("&lt;img src=x onerror=alert\\(1\\)&gt; \\#伪标题");
    expect(body).not.toContain("<img src=x");
    expect(body).not.toContain("\n#伪标题");
  });

  it("将人工智能依据中的Markdown控制符转义为纯文本", () => {
    expect(escapeMarkdownText("packages/core/a_b*~|file.ts"))
      .toBe("packages/core/a\\_b\\*\\~\\|file\\.ts");
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
    expect(normalizeContributor({ id: 44151430, login: "axiomoth", type: "User", name: ` A\n\tB${"字".repeat(100_000)} ` })).toEqual({ id: 44151430, login: "axiomoth", name: `A B${"字".repeat(77)}` });
    expect(normalizeContributor({ id: 44151430, login: "axiomoth", type: "User", email: `${"a".repeat(100_000)}@example.com` })).toEqual({ id: 44151430, login: "axiomoth" });
    expect(normalizeContributor({ id: 301115370, login: "splrad-steward[bot]", type: "Bot" })).toBeNull();
  });
});
