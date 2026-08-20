import { describe, expect, it } from "vitest";
import catalogJson from "../../../config/labels/pr-semantics.json" with { type: "json" };
import defaultJson from "../../../config/profiles/classification/default.json" with { type: "json" };
import layerScapeJson from "../../../config/profiles/classification/layerscape.json" with { type: "json" };
import regressionCanaries from "./fixtures/classification/regression-canaries.v1.json" with { type: "json" };
import digestVectors from "./fixtures/classification/digests.v1.json" with { type: "json" };
import {
  buildAiDiffObservation, canonicalize, classificationDigests, classificationInputDigest, classifyPullRequest, createAiClassificationEnvelope, digest, evaluateClassificationRules, planClassificationLabels,
  validateClassificationProfile, validateRepositoryClassification, validateSemanticCatalog, verifyAiClassificationEnvelope,
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

  it("逐文件冻结AI实际可见补丁、覆盖状态和摘要", () => {
    const observation = buildAiDiffObservation([
      { path: "b.ts", status: "modified", additions: 1, deletions: 0, patch: "4567" },
      { path: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "123" },
      { path: "c.ts", status: "modified", additions: 1, deletions: 0, patch: null },
    ], 5);
    expect(observation.files.map(value => [value.path, value.patchState])).toEqual([["a.ts", "complete"], ["b.ts", "truncated"], ["c.ts", "missing"]]);
    expect(observation.files.every(value => /^[0-9a-f]{64}$/u.test(value.shownPatchDigest))).toBe(true);
    expect(observation.truncated).toBe(true);
    expect(observation.excerpt).toContain("文件：a.ts");
    expect(observation.excerpt).toContain("45");
    expect(observation.excerpt).not.toContain("4567");
  });

  it("上下文封装在shadow只展示wouldPrimary并拒绝漂移、缺失差异和不可信来源", () => {
    const raw = facts(["packages/core/src/a.ts"], "chore: 调整内部实现");
    raw.files[0] = { ...raw.files[0]!, patch: "@@ -1 +1 @@\n-old\n+new", patchState: "available" };
    const shadow = repository("default");
    const digests = classificationDigests(catalog, defaultProfile, shadow);
    const suggestion = { primaryKind: "feature", confidence: "high" as const, evidence: [{ path: "packages/core/src/a.ts", reason: "新增一条可见执行路径" }] };
    const envelope = createAiClassificationEnvelope({ facts: raw, policySha: digestVectors.policySha, digests, effectiveAiMode: "shadow", suggestion });
    const context = { trustedSource: true, catalog, profile: defaultProfile, repository: shadow, facts: raw, policySha: digestVectors.policySha, digests };
    expect(verifyAiClassificationEnvelope(envelope, context)).toMatchObject({ state: "valid", status: "rejected", reasonCode: "primary-ai-mode-shadow", wouldPrimary: "feature" });
    expect(classifyPullRequest(catalog, defaultProfile, shadow, raw, { currentLabels: [], stewardOwnedRiskFlags: [], stewardOwnedFacets: [] }, verifyAiClassificationEnvelope(envelope, context))).toMatchObject({ primaryKind: { source: "deterministic-fallback" }, ai: { wouldPrimary: "feature" } });
    expect(verifyAiClassificationEnvelope(envelope, { ...context, trustedSource: false })).toMatchObject({ status: "rejected", reasonCode: "primary-ai-untrusted-actor" });
    expect(verifyAiClassificationEnvelope(envelope, { ...context, facts: { ...raw, headSha: "f".repeat(40) } })).toMatchObject({ status: "stale", reasonCode: "primary-ai-context-mismatch" });
    const missing = structuredClone(raw); missing.files[0]!.patch = null; missing.files[0]!.patchState = "missing";
    const missingDigests = classificationDigests(catalog, defaultProfile, shadow);
    const missingEnvelope = createAiClassificationEnvelope({ facts: missing, policySha: digestVectors.policySha, digests: missingDigests, effectiveAiMode: "shadow", suggestion });
    expect(verifyAiClassificationEnvelope(missingEnvelope, { ...context, facts: missing, digests: missingDigests })).toMatchObject({ reasonCode: "primary-ai-evidence-invalid" });
  });

  it("逐项拒绝封装漂移、低置信度、不可选主类、额外角色和无效证据", () => {
    const raw = facts(["packages/core/src/a.ts"], "chore: 调整内部实现");
    raw.files[0] = { ...raw.files[0]!, patch: "@@ -1 +1 @@\n-old\n+new", patchState: "available" };
    const shadow = repository("default");
    const digests = classificationDigests(catalog, defaultProfile, shadow);
    const suggestion = { primaryKind: "feature", confidence: "high" as const, evidence: [{ path: "packages/core/src/a.ts", reason: "新增一条可见执行路径" }] };
    const envelope = createAiClassificationEnvelope({ facts: raw, policySha: digestVectors.policySha, digests, effectiveAiMode: "shadow", suggestion });
    const context = { trustedSource: true, catalog, profile: defaultProfile, repository: shadow, facts: raw, policySha: digestVectors.policySha, digests };
    for (const changed of [
      { repositoryId: 9 }, { pullRequestNumber: 9 }, { sourceRepositoryId: 9 }, { sourceRef: "refs/heads/other" }, { targetRef: "refs/heads/other" },
      { headSha: "9".repeat(40) }, { baseSha: "8".repeat(40) }, { policySha: "7".repeat(40) }, { catalogDigest: "6".repeat(64) },
      { profileDigest: "5".repeat(64) }, { repositoryClassificationDigest: "4".repeat(64) }, { classificationPolicyDigest: "3".repeat(64) },
      { inputDigest: "2".repeat(64) }, { effectiveAiMode: "active" },
    ]) expect(verifyAiClassificationEnvelope({ ...envelope, ...changed }, context)).toMatchObject({ status: "stale", reasonCode: "primary-ai-context-mismatch" });
    expect(verifyAiClassificationEnvelope({ ...envelope, extra: true }, context)).toMatchObject({ reasonCode: "primary-ai-invalid-payload" });
    expect(verifyAiClassificationEnvelope({ ...envelope, suggestion: { ...suggestion, confidence: "medium" } }, context)).toMatchObject({ reasonCode: "primary-ai-low-confidence" });
    expect(verifyAiClassificationEnvelope({ ...envelope, suggestion: { ...suggestion, primaryKind: "documentation" } }, context)).toMatchObject({ reasonCode: "primary-ai-kind-ineligible" });
    expect(verifyAiClassificationEnvelope({ ...envelope, suggestion: { ...suggestion, riskFlags: ["security"] } }, context)).toMatchObject({ reasonCode: "primary-ai-invalid-payload" });
    expect(verifyAiClassificationEnvelope({ ...envelope, suggestion: { ...suggestion, evidence: [{ path: "not-changed.ts", reason: "引用一个没有显示的文件" }] } }, context)).toMatchObject({ reasonCode: "primary-ai-evidence-invalid" });
    expect(verifyAiClassificationEnvelope({ ...envelope, suggestion: { ...suggestion, evidence: [suggestion.evidence[0], suggestion.evidence[0]] } }, context)).toMatchObject({ reasonCode: "primary-ai-evidence-invalid" });
    const incomplete = structuredClone(raw);
    incomplete.files.push({ path: "packages/core/src/missing.ts", status: "modified", additions: 1, deletions: 0, patch: null, patchState: "missing" });
    const incompleteEnvelope = createAiClassificationEnvelope({ facts: incomplete, policySha: digestVectors.policySha, digests, effectiveAiMode: "shadow", suggestion });
    expect(verifyAiClassificationEnvelope(incompleteEnvelope, { ...context, facts: incomplete })).toMatchObject({ reasonCode: "primary-ai-incomplete-diff" });
  });

  it("active和精确draft-canary采用合格主类，硬规则仍锁定最终主类", () => {
    const raw = facts(["packages/core/src/a.ts"], "chore: 调整内部实现");
    raw.files[0] = { ...raw.files[0]!, patch: "@@ -1 +1 @@\n-old\n+new", patchState: "available" };
    const suggestion = { primaryKind: "feature", confidence: "high" as const, evidence: [{ path: "packages/core/src/a.ts", reason: "新增一条可见执行路径" }] };
    const active: RepositoryClassification = { profile: "default", labelDefinitionMode: "enforce", labelAssignmentMode: "enforce", ai: { mode: "active", adoptedPrimaryKinds: ["feature"], canaries: [] } };
    const activeDigests = classificationDigests(catalog, defaultProfile, active);
    const activeEnvelope = createAiClassificationEnvelope({ facts: raw, policySha: digestVectors.policySha, digests: activeDigests, effectiveAiMode: "active", suggestion });
    const activeAssessment = verifyAiClassificationEnvelope(activeEnvelope, { trustedSource: true, catalog, profile: defaultProfile, repository: active, facts: raw, policySha: digestVectors.policySha, digests: activeDigests });
    expect(activeAssessment).toMatchObject({ status: "accepted", reasonCode: "primary-ai-accepted" });
    expect(classifyPullRequest(catalog, defaultProfile, active, raw, { currentLabels: [], stewardOwnedRiskFlags: [], stewardOwnedFacets: [] }, activeAssessment)).toMatchObject({ primaryKind: { id: "feature", source: "ai" } });

    const canary: RepositoryClassification = { ...active, ai: { mode: "draft-canary", adoptedPrimaryKinds: ["feature"], canaries: [{ repositoryId: raw.repositoryId, pullRequestNumber: raw.pullRequestNumber, headSha: raw.headSha, sourceRepositoryId: raw.sourceRepositoryId, sourceRef: raw.sourceRef }] } };
    const canaryDigests = classificationDigests(catalog, defaultProfile, canary);
    const canaryEnvelope = createAiClassificationEnvelope({ facts: raw, policySha: digestVectors.policySha, digests: canaryDigests, effectiveAiMode: "draft-canary", suggestion });
    expect(verifyAiClassificationEnvelope(canaryEnvelope, { trustedSource: true, catalog, profile: defaultProfile, repository: canary, facts: raw, policySha: digestVectors.policySha, digests: canaryDigests })).toMatchObject({ status: "accepted" });
    const wrongCanary: RepositoryClassification = { ...canary, ai: { ...canary.ai, canaries: [{ ...canary.ai.canaries[0]!, pullRequestNumber: 99 }] } };
    const wrongCanaryDigests = classificationDigests(catalog, defaultProfile, wrongCanary);
    const wrongCanaryEnvelope = createAiClassificationEnvelope({ facts: raw, policySha: digestVectors.policySha, digests: wrongCanaryDigests, effectiveAiMode: "draft-canary", suggestion });
    expect(verifyAiClassificationEnvelope(wrongCanaryEnvelope, { trustedSource: true, catalog, profile: defaultProfile, repository: wrongCanary, facts: raw, policySha: digestVectors.policySha, digests: wrongCanaryDigests })).toMatchObject({ status: "rejected", reasonCode: "primary-ai-context-mismatch" });

    const docs = facts(["README.md"], "chore: 调整说明");
    docs.files[0] = { ...docs.files[0]!, patch: "@@ -1 +1 @@\n-old\n+new", patchState: "available" };
    const docsSuggestion = { ...suggestion, evidence: [{ path: "README.md", reason: "新增一条可见执行路径" }] };
    const docsEnvelope = createAiClassificationEnvelope({ facts: docs, policySha: digestVectors.policySha, digests: activeDigests, effectiveAiMode: "active", suggestion: docsSuggestion });
    const docsAssessment = verifyAiClassificationEnvelope(docsEnvelope, { trustedSource: true, catalog, profile: defaultProfile, repository: active, facts: docs, policySha: digestVectors.policySha, digests: activeDigests });
    expect(classifyPullRequest(catalog, defaultProfile, active, docs, { currentLabels: [], stewardOwnedRiskFlags: [], stewardOwnedFacets: [] }, docsAssessment)).toMatchObject({ primaryKind: { id: "documentation", source: "hard-rule" }, ai: { reasonCode: "primary-ai-hard-rule-conflict" } });
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

  it("all-files要求重命名前后路径同属目标集合且any-file仍观察两端", () => {
    const movedOut = facts(["packages/core/src/a.ts"]);
    movedOut.files[0] = { ...movedOut.files[0]!, previousPath: "docs/a.md", status: "renamed" };
    const movedOutEvaluation = evaluateClassificationRules(catalog, defaultProfile, movedOut);
    expect(movedOutEvaluation.primaryCandidates).not.toContainEqual(expect.objectContaining({ id: "documentation" }));
    expect(movedOutEvaluation.areas.map((area) => area.id)).toEqual(expect.arrayContaining(["area:source", "area:docs"]));

    const movedIn = facts(["docs/a.md"]);
    movedIn.files[0] = { ...movedIn.files[0]!, previousPath: "packages/core/src/a.ts", status: "renamed" };
    expect(evaluateClassificationRules(catalog, defaultProfile, movedIn).primaryCandidates).not.toContainEqual(expect.objectContaining({ id: "documentation" }));

    const renamedWithin = facts(["docs/new.md"]);
    renamedWithin.files[0] = { ...renamedWithin.files[0]!, previousPath: "docs/old.md", status: "renamed" };
    expect(evaluateClassificationRules(catalog, defaultProfile, renamedWithin).primaryCandidates).toContainEqual({ id: "documentation", ruleId: "documentation-only" });
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
