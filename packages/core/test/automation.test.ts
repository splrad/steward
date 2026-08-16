import { describe, expect, it } from "vitest";
import {
  buildDeterministicSummary,
  buildPrompt,
  coauthorMarker,
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
  summary: "本次修改增加中央规则并保持所有仓库的行为完全一致。",
  changes: ["增加中央配置并同步更新相关实现内容"],
  reviewNotes: ["请重点确认默认分支和仓库权限没有发生变化"],
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
      { ...valid, summary: "太短" },
      { ...valid, changes: [] },
      { ...valid, changes: ["太短"] },
      { ...valid, reviewNotes: Array.from({ length: 6 }, () => "请重点确认默认分支和仓库权限没有发生变化") },
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
    expect(organizationPullRequestTemplate).toContain("### 人工补充");
    expect(buildPrompt(facts, generated)).toContain(JSON.stringify(generated));
  });

  it("只替换唯一受管区并逐字保留人工正文", () => {
    const manualBefore = "人工前言\r\n";
    const manualAfter = "\r\n人工结尾  \n";
    const template = `${manualBefore}${summaryStart}\n等待生成\n${summaryEnd}${manualAfter}`;
    const body = renderManagedBody({
      generated: validateGeneratedSummary(valid),
      templateBody: template,
      actor: "axiomoth",
      contributors: [{ id: 44151430, login: "axiomoth", name: "Axiom Oth", email: "owner@example.com" }],
      context: "c".repeat(64),
    });
    expect(body.startsWith(manualBefore)).toBe(true);
    expect(body).toContain(`${summaryEnd}${manualAfter}`);
    expect(body.match(/workflow:auto-summary:start/g)).toHaveLength(1);
    expect(body.match(/workflow:auto-summary:end/g)).toHaveLength(1);
    expect(body).toContain("[@axiomoth](https://github.com/axiomoth)");
    expect(body).toContain(`${coauthorMarker}\nCo-authored-by: Axiom Oth <owner@example.com>`);
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
    expect(normalizeContributor({ id: 44151430, login: "axiomoth", type: "User", name: " Axiom ", email: " owner@example.com " })).toEqual({ id: 44151430, login: "axiomoth", name: "Axiom", email: "owner@example.com" });
    expect(normalizeContributor({ id: 301115370, login: "splrad-steward[bot]", type: "Bot" })).toBeNull();
  });
});
