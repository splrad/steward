import { describe, expect, it } from "vitest";
import catalogJson from "../../../config/labels/pr-semantics.json" with { type: "json" };
import defaultJson from "../../../config/profiles/classification/default.json" with { type: "json" };
import layerScapeJson from "../../../config/profiles/classification/layerscape.json" with { type: "json" };
import regressionCanaries from "./fixtures/classification/regression-canaries.v1.json" with { type: "json" };
import digestVectors from "./fixtures/classification/digests.v1.json" with { type: "json" };
import {
  canonicalize, classificationDigests, classificationInputDigest, classifyPullRequest, digest, evaluateClassificationRules, planClassificationLabels,
  validateClassificationProfile, validateRepositoryClassification, validateSemanticCatalog,
  type ClassificationProfile, type RawClassificationFacts, type RepositoryClassification, type SemanticCatalog,
} from "../src/classification.js";

const catalog = catalogJson as unknown as SemanticCatalog;
const defaultProfile = defaultJson as unknown as ClassificationProfile;
const layerScape = layerScapeJson as unknown as ClassificationProfile;
const repository = (profile: string): RepositoryClassification => ({ profile, labelDefinitionMode: "observe", labelAssignmentMode: "observe", ai: { mode: "shadow", adoptedPrimaryKinds: [], canaries: [] } });
const facts = (files: string[], message = "chore: 更新内容"): RawClassificationFacts => ({
  repositoryId: 1, pullRequestNumber: 2, sourceRepositoryId: 1, sourceRef: "refs/heads/change", targetRef: "refs/heads/main",
  author: { login: "user", type: "User" }, headSha: "a".repeat(40), baseSha: "b".repeat(40),
  commits: [{ sha: "c".repeat(40), message }], files: files.map(path => ({ path, status: "modified", additions: 1, deletions: 0 })),
});

describe("角色化拉取请求分类", () => {
  it("验证中央目录、profile和仓库三轴合同", () => {
    validateSemanticCatalog(catalog);
    validateClassificationProfile(catalog, defaultProfile);
    validateClassificationProfile(catalog, layerScape);
    validateRepositoryClassification(defaultProfile, repository("default"));
    expect(() => validateRepositoryClassification(defaultProfile, { ...repository("default"), labelAssignmentMode: "enforce" })).toThrow("物理定义");
    expect(() => validateRepositoryClassification(defaultProfile, { profile: "default", labelDefinitionMode: "enforce", labelAssignmentMode: "enforce", ai: { mode: "draft-canary", adoptedPrimaryKinds: ["feature"], canaries: [] } })).toThrow("精确canary");
    const extraPrimary = structuredClone(catalog); (extraPrimary.roles.primaryKind.definitions as any[]).push({ ...extraPrimary.roles.primaryKind.definitions[0], id: "unknown" });
    expect(() => validateSemanticCatalog(extraPrimary)).toThrow("固定集合");
    const wrongManagement = structuredClone(catalog); (wrongManagement.roles.facets.management as any).assignmentOwner = "steward";
    expect(() => validateSemanticCatalog(wrongManagement)).toThrow("管理合同");
    const physicalSummaryFacet = structuredClone(catalog); physicalSummaryFacet.roles.facets.definitions.find(value => value.id === "style")!.githubLabel = { name: "style", color: "ffffff" };
    expect(() => validateSemanticCatalog(physicalSummaryFacet)).toThrow("facet物理标签");
    const first = classificationDigests(catalog, defaultProfile, repository("default"));
    const reordered = { ...repository("default"), ai: { mode: "shadow" as const, adoptedPrimaryKinds: [], canaries: [] } };
    expect(classificationDigests(catalog, defaultProfile, reordered)).toEqual(first);
  });

  it("规范化摘要显式拒绝JSON不支持的类型", () => {
    expect(canonicalize({ z: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"z":1}');
    for (const value of [undefined, Symbol("x"), () => "x", 1n]) {
      expect(() => canonicalize(value)).toThrow("规范化输入包含JSON不支持的类型");
      expect(() => digest(value)).toThrow("规范化输入包含JSON不支持的类型");
    }
    expect(() => canonicalize([undefined])).toThrow("规范化输入包含JSON不支持的类型: undefined");
    expect(() => canonicalize({ value: 1n })).toThrow("规范化输入包含JSON不支持的类型: bigint");
  });

  it("固定跨平台策略与输入摘要黄金向量", () => {
    const profiles: Record<string, ClassificationProfile> = { default: defaultProfile, layerscape: layerScape };
    for (const profileName of Object.keys(profiles)) {
      const actual = classificationDigests(catalog, profiles[profileName]!, repository(profileName));
      expect(actual).toEqual(digestVectors.policy[profileName as keyof typeof digestVectors.policy]);
    }
    for (const fixture of regressionCanaries.cases) {
      const policyDigest = digestVectors.policy[fixture.profile as keyof typeof digestVectors.policy].classificationPolicyDigest;
      expect(classificationInputDigest(fixture.facts as RawClassificationFacts, digestVectors.policySha, policyDigest)).toBe(digestVectors.inputs[fixture.id as keyof typeof digestVectors.inputs]);
    }
    const reorderedProfile = structuredClone(defaultProfile);
    reorderedProfile.ai.eligiblePrimaryKinds.reverse();
    expect(classificationDigests(catalog, reorderedProfile, repository("default")).profileDigest).not.toBe(digestVectors.policy.default.profileDigest);
    const twoCommits = structuredClone(regressionCanaries.cases[0]!.facts) as RawClassificationFacts;
    twoCommits.commits.push({ sha: "d".repeat(40), message: "chore: 第二项" });
    const reversed = structuredClone(twoCommits); reversed.commits.reverse();
    expect(classificationInputDigest(twoCommits, digestVectors.policySha, digestVectors.policy.default.classificationPolicyDigest)).not.toBe(classificationInputDigest(reversed, digestVectors.policySha, digestVectors.policy.default.classificationPolicyDigest));
  });

  it.each([
    [["README.md"], "documentation"],
    [["tests/a.test.ts"], "test"],
    [[".github/workflows/a.yml"], "workflow"],
    [["package.json", "package-lock.json"], "build"],
  ])("规则锁定 %j 为 %s", (files, expected) => {
    const decision = classifyPullRequest(catalog, defaultProfile, repository("default"), facts(files), { currentLabels: [], stewardOwnedRiskFlags: [], stewardOwnedFacets: [] });
    expect(decision.primaryKind).toMatchObject({ id: expected, source: "hard-rule" });
  });

  it("从原始提交回退并独立派生风险、facet和area", () => {
    const decision = classifyPullRequest(catalog, defaultProfile, repository("default"), facts(["packages/core/src/a.ts", "package.json"], "feat!: 新增能力"), { currentLabels: [], stewardOwnedRiskFlags: [], stewardOwnedFacets: [] });
    expect(decision.primaryKind).toMatchObject({ id: "feature", source: "deterministic-fallback" });
    expect(decision.riskFlags.map(value => value.id)).toContain("breaking-change");
    expect(decision.facets.map(value => value.id)).toEqual(expect.arrayContaining(["dependencies", "javascript"]));
    expect(decision.areas.map(value => value.id)).toContain("area:source");
  });

  it("不同主类硬规则冲突失败且空事实失败", () => {
    const conflicting = structuredClone(defaultProfile);
    conflicting.rules.primaryKind.push({ id: "all-docs-as-test", primaryKind: "test", match: { type: "all-files", fileSets: ["docs"] } });
    expect(() => evaluateClassificationRules(catalog, conflicting, facts(["README.md"]))).toThrow("primary-hard-rule-conflict");
    expect(() => evaluateClassificationRules(catalog, defaultProfile, { ...facts(["a.ts"]), files: [] })).toThrow("完整文件");
  });

  it("按角色所有权计划标签并保留人工与遗留标签", () => {
    const decision = classifyPullRequest(catalog, layerScape, repository("layerscape"), facts(["src/A.cs"], "refactor: 重命名变量"), { currentLabels: ["manual", "plugin", "security", "bug", "area:docs"], stewardOwnedRiskFlags: [], stewardOwnedFacets: [] });
    const plan = planClassificationLabels(catalog, layerScape, { currentLabels: ["manual", "plugin", "security", "bug", "area:docs"], stewardOwnedRiskFlags: [], stewardOwnedFacets: [] }, decision);
    expect(plan.add).toEqual(expect.arrayContaining(["refactor", "area:runtime"]));
    expect(plan.remove).toEqual(expect.arrayContaining(["bug", "area:docs"]));
    expect(plan.keep).toEqual(expect.arrayContaining(["manual", "plugin", "security"]));
  });

  it("规则消失时只移除上次由Steward拥有的共享风险标签", () => {
    const existing = { currentLabels: ["breaking-change", "security"], stewardOwnedRiskFlags: ["breaking-change"], stewardOwnedFacets: [] };
    const decision = classifyPullRequest(catalog, defaultProfile, repository("default"), facts(["packages/core/src/a.ts"], "chore: 调整实现"), existing);
    const plan = planClassificationLabels(catalog, defaultProfile, existing, decision);
    expect(decision.riskFlags).toEqual([{ id: "security", source: "human" }]);
    expect(plan.remove).toContain("breaking-change");
    expect(plan.keep).toContain("security");
  });

  it("冻结旧四canary的完整事实、人工答案与PR1确定性回归", () => {
    expect(regressionCanaries).toMatchObject({ schemaVersion: 1, fixtureSet: "legacy-canaries-regression", metricEligible: false });
    expect(regressionCanaries.cases).toHaveLength(4);
    const profiles: Record<string, ClassificationProfile> = { default: defaultProfile, layerscape: layerScape };
    for (const fixture of regressionCanaries.cases) {
      expect(fixture.source).toBe("synthetic");
      expect(fixture.humanReason.length).toBeGreaterThan(10);
      expect(fixture.facts.headSha).toMatch(/^[0-9a-f]{40}$/u);
      expect(fixture.facts.baseSha).toMatch(/^[0-9a-f]{40}$/u);
      expect(fixture.facts.files).not.toHaveLength(0);
      expect(fixture.facts.commits).not.toHaveLength(0);
      expect(fixture.facts.files.every(file => file.patchState === "available" && file.patch.length > 0)).toBe(true);
      const decision = classifyPullRequest(catalog, profiles[fixture.profile]!, repository(fixture.profile), fixture.facts as RawClassificationFacts, { currentLabels: [], stewardOwnedRiskFlags: [], stewardOwnedFacets: [] });
      expect({
        primaryKind: decision.primaryKind.id,
        riskFlags: decision.riskFlags.map(value => value.id),
        facets: decision.facets.map(value => value.id),
        areas: decision.areas.map(value => value.id),
      }).toEqual(fixture.expectedPr1Deterministic);
    }
    expect(regressionCanaries.cases.find(value => value.id === "layerscape-150")?.expectedDecision.primaryKind).toBe("refactor");
    expect(regressionCanaries.cases.find(value => value.id === "layerscape-150")?.expectedPr1Deterministic.primaryKind).toBe("chore");
  });
});
