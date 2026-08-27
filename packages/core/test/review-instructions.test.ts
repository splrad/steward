import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generateReviewInstructionSet, planReviewInstructionSync, validateReviewRegistries, type ReviewProfileRegistry, type ReviewRuleRegistry } from "../src/review-instructions.js";

async function registries(): Promise<{ profiles: ReviewProfileRegistry; rules: ReviewRuleRegistry }> {
  const profiles = JSON.parse(await readFile("config/review/profiles.json", "utf8"));
  const rules = JSON.parse(await readFile("config/review/rules.json", "utf8"));
  delete profiles.$schema;
  delete rules.$schema;
  return { profiles, rules };
}

describe("代码审查说明", () => {
  it("三个仓库profile稳定生成双目标并严格分流受众", async () => {
    const { profiles, rules } = await registries();
    for (const profile of ["steward", "layerscape", "github"]) {
      const generated = await generateReviewInstructionSet(profile, profiles, rules);
      expect(generated.files.map(file => file.path)).toEqual(["AGENTS.md", ".github/copilot-instructions.md"]);
      expect(generated.files.every(file => file.content.endsWith("\n") && !file.content.includes("\r") && [...file.content].length <= 4000)).toBe(true);
      const shared = generated.files[0];
      const copilot = generated.files[1];
      expect(shared.ruleIds).toContain("common.review-language-zh");
      expect(shared.content).toContain("简体中文");
      expect(copilot.ruleIds).toEqual(["copilot.inline-findings", "copilot.review-scope"]);
      expect(copilot.content).not.toContain("common.review-language-zh");
      expect(shared.content).not.toContain("copilot.inline-findings");
      expect(shared.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(copilot.digest).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("按规则编号排序且摘要可重复", async () => {
    const { profiles, rules } = await registries();
    const first = await generateReviewInstructionSet("steward", profiles, rules);
    const second = await generateReviewInstructionSet("steward", profiles, { ...rules, rules: [...rules.rules].reverse() });
    expect(first).toEqual(second);
    expect(first.files[0].ruleIds).toEqual([...first.files[0].ruleIds].sort());
  });

  it("拒绝未知、退役和不完整引用", async () => {
    const { profiles, rules } = await registries();
    await expect(generateReviewInstructionSet("missing", profiles, rules)).rejects.toThrow("不存在或已退役");
    const retired = structuredClone(profiles);
    retired.profiles.find(profile => profile.id === "steward")!.status = "retired";
    await expect(generateReviewInstructionSet("steward", retired, rules)).rejects.toThrow("不存在或已退役");
    const invalid = structuredClone(rules);
    invalid.rules[0]!.profiles = ["missing"];
    expect(() => validateReviewRegistries(profiles, invalid)).toThrow("引用不存在或已退役");
    const unknown = structuredClone(rules) as any;
    unknown.rules[0].extra = true;
    expect(() => validateReviewRegistries(profiles, unknown)).toThrow("字段不符合固定合同");
  });

  it("资源集只允许无变化、创建或唯一受管分支更新", async () => {
    const { profiles, rules } = await registries();
    const generated = await generateReviewInstructionSet("common", profiles, rules);
    const current = Object.fromEntries(generated.files.map(file => [file.path, file.content]));
    expect(planReviewInstructionSync({ current, generated, branchExists: true, branchOwnedBySteward: false, openPullRequests: 9 })).toBe("unchanged");
    expect(planReviewInstructionSync({ current: {}, generated, branchExists: false, branchOwnedBySteward: false, openPullRequests: 0 })).toBe("create");
    expect(planReviewInstructionSync({ current: { ...current, "AGENTS.md": "drift" }, generated, branchExists: true, branchOwnedBySteward: true, openPullRequests: 1 })).toBe("update");
    expect(() => planReviewInstructionSync({ current: {}, generated, branchExists: true, branchOwnedBySteward: false, openPullRequests: 1 })).toThrow("冲突");
  });
});
