import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generateOrganizationReviewInstructions, generateReviewInstructionSet, maximumReviewInstructionCharacters, planReviewInstructionSync, validateReviewInstructionContents, validateReviewRegistries, type ReviewProfileRegistry, type ReviewRuleRegistry } from "../src/review-instructions.js";

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
    for (const profile of ["common", "steward", "layerscape", "github"]) {
      const generated = await generateReviewInstructionSet(profile, profiles, rules);
      expect(generated.files.map(file => file.path)).toEqual(["AGENTS.md", ".github/copilot-instructions.md"]);
      expect(generated.files.every(file => file.content.endsWith("\n") && !file.content.includes("\r") && [...file.content].length <= maximumReviewInstructionCharacters)).toBe(true);
      const shared = generated.files[0];
      const copilot = generated.files[1]!;
      expect(shared.ruleIds).toContain("common.review-language-zh");
      expect(shared.ruleIds).toContain("common.current-head-evidence");
      expect(shared.ruleIds.includes("steward.dist-verification")).toBe(profile === "steward");
      expect(shared.content).toContain("简体中文");
      expect(copilot.ruleIds).toEqual(["copilot.inline-findings", "copilot.review-scope"]);
      expect(copilot.content).not.toContain("common.review-language-zh");
      expect(shared.content).not.toContain("copilot.inline-findings");
      expect(shared.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(copilot.digest).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("候选规则在受管同步中更新已采用的说明", async () => {
    const { profiles, rules } = await registries();
    const generated = await generateReviewInstructionSet("steward", profiles, rules);
    const previousRules = { ...rules, rules: rules.rules.filter(rule =>
      !["common.current-head-evidence", "steward.dist-verification"].includes(rule.id)) };
    const previous = await generateReviewInstructionSet("steward", profiles, previousRules);
    const current = Object.fromEntries(previous.files.map(file => [file.path, file.content]));
    expect(planReviewInstructionSync({ current, generated, branchExists: false, branchOwnedBySteward: false, openPullRequests: 0 })).toBe("create");
    expect(planReviewInstructionSync({ current, generated, branchExists: true, branchOwnedBySteward: true, openPullRequests: 1 })).toBe("update");
    const adopted = Object.fromEntries(generated.files.map(file => [file.path, file.content]));
    expect(planReviewInstructionSync({ current: adopted, generated, branchExists: true, branchOwnedBySteward: true, openPullRequests: 1 })).toBe("unchanged");
  });

  it("按规则编号排序且摘要可重复", async () => {
    const { profiles, rules } = await registries();
    const first = await generateReviewInstructionSet("steward", profiles, rules);
    const second = await generateReviewInstructionSet("steward", profiles, { ...rules, rules: [...rules.rules].reverse() });
    expect(first).toEqual(second);
    expect(first.files[0].ruleIds).toEqual([...first.files[0].ruleIds].sort());
  });

  it("四个profile采用组织摘要后保留完整AGENTS并声明准确退役原文", async () => {
    const { profiles, rules } = await registries();
    const organization = await generateOrganizationReviewInstructions(profiles, rules);
    expect(organization.ruleIds).toEqual(["common.current-head-evidence", "common.direct-evidence", "common.pr-creation", "common.review-language-zh", "copilot.inline-findings", "copilot.review-scope"]);
    expect(organization).toEqual(await generateOrganizationReviewInstructions(profiles, { ...rules, rules: [...rules.rules].reverse() }));
    for (const id of ["common", "steward", "layerscape", "github"]) {
      const original = await generateReviewInstructionSet(id, profiles, rules);
      const migrated = structuredClone(profiles);
      migrated.profiles.find(profile => profile.id === id)!.organizationInstructionsDigest = organization.digest;
      const generated = await generateReviewInstructionSet(id, migrated, rules);
      expect(generated.files).toEqual([original.files[0]]);
      expect(generated.retiredFiles).toEqual([original.files[1]]);
      expect(generated.organization).toEqual(organization);
      const current = Object.fromEntries(original.files.map(file => [file.path, file.content]));
      expect(planReviewInstructionSync({ current, generated, branchExists: false, branchOwnedBySteward: false, openPullRequests: 0 })).toBe("create");
      expect(() => validateReviewInstructionContents(current, generated)).toThrow("已退役");
      delete current[".github/copilot-instructions.md"];
      expect(() => validateReviewInstructionContents(current, generated)).not.toThrow();
      expect(planReviewInstructionSync({ current, generated, branchExists: false, branchOwnedBySteward: false, openPullRequests: 0 })).toBe("unchanged");
      delete current["AGENTS.md"];
      expect(() => validateReviewInstructionContents(current, generated)).toThrow("缺少");
    }
  });

  it("组织采用后仍生成仓库专用Copilot规则", async () => {
    const { profiles, rules } = await registries();
    rules.rules.push({ ...structuredClone(rules.rules.find(rule => rule.id === "copilot.review-scope")!), id: "steward.copilot-local", profiles: ["steward"] });
    profiles.profiles.find(profile => profile.id === "steward")!.organizationInstructionsDigest = (await generateOrganizationReviewInstructions(profiles, rules)).digest;
    const generated = await generateReviewInstructionSet("steward", profiles, rules);
    expect(generated.files[1]!.ruleIds).toEqual(["steward.copilot-local"]);
    expect(generated.retiredFiles).toBeUndefined();
    expect(generated.files[0].ruleIds).toContain("steward.permission-boundary");
  });

  it("组织摘要过期、格式错误或未知配置均失败关闭", async () => {
    const { profiles, rules } = await registries();
    const profile = profiles.profiles.find(profile => profile.id === "steward")!;
    profile.organizationInstructionsDigest = (await generateOrganizationReviewInstructions(profiles, rules)).digest;
    rules.rules.find(rule => rule.id === "common.direct-evidence")!.consequence += "改变";
    await expect(generateReviewInstructionSet("steward", profiles, rules)).rejects.toThrow("摘要与当前中央规则不一致");
    for (const invalid of ["", "unknown", "A".repeat(64), null]) {
      (profile as any).organizationInstructionsDigest = invalid;
      expect(() => validateReviewRegistries(profiles, rules)).toThrow("摘要");
    }
    delete profile.organizationInstructionsDigest;
    (profile as any).organizationMode = true;
    expect(() => validateReviewRegistries(profiles, rules)).toThrow("固定合同");
  });

  it("退役文件有人工改动时停止同步；校验不接受额外旧载体或缺失共享规则", async () => {
    const { profiles, rules } = await registries();
    profiles.profiles.find(profile => profile.id === "common")!.organizationInstructionsDigest = (await generateOrganizationReviewInstructions(profiles, rules)).digest;
    const generated = await generateReviewInstructionSet("common", profiles, rules);
    const current = { "AGENTS.md": generated.files[0].content, ".github/copilot-instructions.md": generated.retiredFiles![0]!.content + "人工内容" };
    expect(() => planReviewInstructionSync({ current, generated, branchExists: false, branchOwnedBySteward: false, openPullRequests: 0 })).toThrow("人工修改");
    expect(() => validateReviewInstructionContents({ "AGENTS.md": generated.files[0].content.replace(/\n/gu, "\r\n") }, generated)).not.toThrow();
    expect(() => validateReviewInstructionContents({ "AGENTS.md": "不同内容" }, generated)).toThrow("不等于");
  });

  it("线性归一化大量尾随换行且只保留一个LF", async () => {
    const { profiles, rules } = await registries();
    const modified = structuredClone(rules);
    modified.rules.find(rule => rule.id === "copilot.review-scope")!.safePath += "\n".repeat(10_000);
    const generated = await generateReviewInstructionSet("steward", profiles, modified);
    const copilot = generated.files.find(file => file.path === ".github/copilot-instructions.md")!;
    expect(copilot.content.endsWith("\n")).toBe(true);
    expect(copilot.content.endsWith("\n\n")).toBe(false);
    expect([...copilot.content].length).toBeLessThanOrEqual(maximumReviewInstructionCharacters);
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
