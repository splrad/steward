import { createHash } from "node:crypto";
import { minimatch } from "minimatch";

export type PrimarySelection = "ai-eligible" | "rule-only" | "fallback-only";
export type AiMode = "shadow" | "draft-canary" | "active";
export type LabelMode = "observe" | "enforce";
export type AiClassificationConfidence = "high" | "medium" | "low";
export interface AiClassificationEvidence { path: string; reason: string }
export interface AiClassificationSuggestion {
  primaryKind: string;
  confidence: AiClassificationConfidence;
  evidence: AiClassificationEvidence[];
}
export interface AiDiffFileObservation {
  path: string;
  patchState: "complete" | "missing" | "truncated";
  shownPatchDigest: string;
}
export interface AiDiffObservation {
  truncated: boolean;
  files: AiDiffFileObservation[];
  excerpt: string;
}
export interface GitHubLabelDefinition { name: string; color: string }
export interface SemanticDefinition {
  id: string; description: string; includes: string; excludes: string; githubLabel: GitHubLabelDefinition | null;
}
export interface PrimaryDefinition extends SemanticDefinition { selection: PrimarySelection }
export interface RoleManagement { metadataOwner: "steward"; assignmentOwner: "steward" | "shared"; reconcile: "exclusive-replace" | "provenance-aware-set" | "authoritative-set" }
export interface SemanticCatalog {
  schemaVersion: 1;
  catalogId: "pr-semantics";
  roles: {
    primaryKind: { cardinality: "exactly-one"; management: RoleManagement; order: string[]; definitions: PrimaryDefinition[] };
    riskFlags: { cardinality: "zero-or-more"; management: RoleManagement; definitions: SemanticDefinition[] };
    areas: { cardinality: "zero-or-more"; management: RoleManagement; definitions: SemanticDefinition[] };
    facets: { cardinality: "zero-or-more"; management: RoleManagement; definitions: SemanticDefinition[] };
  };
  fallback: { defaultPrimaryKind: string; commitTypeToPrimaryKind: Record<string, string> };
}
export type RuleMatch =
  | { type: "all-files" | "any-file"; fileSets: string[] }
  | { type: "commit-text-any"; commitTextSets: string[] };
export interface ClassificationProfile {
  schemaVersion: 2;
  name: string;
  semanticCatalog: { id: "pr-semantics"; schemaVersion: 1 };
  fileSets: Record<string, string[]>;
  commitTextSets: Record<string, string[]>;
  rules: {
    primaryKind: Array<{ id: string; primaryKind: string; match: RuleMatch }>;
    riskFlags: Array<{ id: string; riskFlag: string; match: RuleMatch }>;
    facets: Array<{ id: string; facet: string; match: RuleMatch }>;
  };
  areas: Array<{ id: string; area: string; match: Extract<RuleMatch, { type: "all-files" | "any-file" }> }>;
  ai: { eligiblePrimaryKinds: string[]; minimumConfidence: "high" };
  runtimeRelease: { includeFileSets: string[]; excludeFileSets: string[] };
  installOrPackage: { fileSets: string[] };
  releaseCategories: ReleaseCategory[];
}
export interface RepositoryClassification {
  profile: string;
  labelDefinitionMode: LabelMode;
  labelAssignmentMode: LabelMode;
  ai: {
    mode: AiMode;
    adoptedPrimaryKinds: string[];
    canaries: Array<{ repositoryId: number; pullRequestNumber: number; headSha: string; sourceRepositoryId: number; sourceRef: string }>;
  };
}
export interface ReleaseClause {
  primaryKindsAny?: string[]; riskFlagsAny?: string[]; areasAny?: string[]; facetsAny?: string[];
  runtimeRelease?: boolean; installOrPackage?: boolean;
}
export interface ReleaseCategory { id: string; title: string; icon: string; matchAny?: ReleaseClause[]; fallback: boolean }
export interface RawClassificationFacts {
  repositoryId: number; pullRequestNumber: number; sourceRepositoryId: number; sourceRef: string; targetRef: string;
  author: { login: string; type: "User" | "Bot" | "Organization" | "Mannequin" };
  headSha: string; baseSha: string;
  commits: Array<{ sha: string; message: string }>;
  files: Array<{ path: string; previousPath?: string; status: string; additions: number; deletions: number; patch?: string | null; patchState?: "available" | "missing" }>;
}
export interface RuleEvaluation {
  primaryCandidates: Array<{ id: string; ruleId: string }>;
  riskFlags: Array<{ id: string; ruleId: string }>;
  facets: Array<{ id: string; ruleId: string }>;
  areas: Array<{ id: string; ruleId: string }>;
  runtimeRelease: boolean;
  installOrPackage: boolean;
}
export interface PrimaryDecision {
  id: string;
  source: "hard-rule" | "ai" | "deterministic-fallback";
  reasonCode: string;
  hardRuleId?: string;
}
export interface ClassificationDecision {
  primaryKind: PrimaryDecision;
  riskFlags: Array<{ id: string; source: "rule" | "human"; ruleId?: string }>;
  facets: Array<{ id: string; source: "rule" | "human" | "external"; ruleId?: string }>;
  areas: Array<{ id: string; source: "rule"; ruleId: string }>;
  aiState: "valid" | "abstained" | "missing" | "invalid";
  ai?: AiClassificationAssessment;
  runtimeRelease: boolean;
  installOrPackage: boolean;
}
export interface ExistingClassificationState {
  currentLabels: string[];
  stewardOwnedRiskFlags: string[];
  stewardOwnedFacets: string[];
}
export interface ManagedLabelPlan {
  add: string[];
  remove: string[];
  keep: string[];
  desired: string[];
  ownedRiskFlags: string[];
  ownedFacets: string[];
}
export interface ClassificationDigests {
  catalogDigest: string; profileDigest: string; repositoryClassificationDigest: string; classificationPolicyDigest: string;
}
export interface AiClassificationEnvelopeV2 {
  schemaVersion: 2;
  repositoryId: number;
  pullRequestNumber: number;
  sourceRepositoryId: number;
  sourceRef: string;
  targetRef: string;
  headSha: string;
  baseSha: string;
  policySha: string;
  catalogDigest: string;
  profileDigest: string;
  repositoryClassificationDigest: string;
  classificationPolicyDigest: string;
  inputDigest: string;
  effectiveAiMode: AiMode;
  suggestion: unknown;
}
export interface VerifiedAiSuggestion {
  primaryKind: string;
  adoptable: boolean;
  reused?: boolean;
}
export interface AiClassificationAssessment {
  state: "valid" | "abstained" | "missing" | "invalid";
  status: "accepted" | "rejected" | "stale" | "reused" | "absent";
  reasonCode: string;
  suggestion: AiClassificationSuggestion | null;
  verifiedSuggestion: VerifiedAiSuggestion | null;
  wouldPrimary?: string;
}
export interface AiEnvelopeVerificationContext {
  trustedSource: boolean;
  catalog: SemanticCatalog;
  profile: ClassificationProfile;
  repository: RepositoryClassification;
  facts: RawClassificationFacts;
  policySha: string;
  digests: ClassificationDigests;
}

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name}存在重复值`);
}
function definitionMap(definitions: readonly SemanticDefinition[]): Map<string, SemanticDefinition> {
  return new Map(definitions.map((definition) => [definition.id, definition]));
}
function roleDefinitions(catalog: SemanticCatalog): SemanticDefinition[] {
  return [...catalog.roles.primaryKind.definitions, ...catalog.roles.riskFlags.definitions, ...catalog.roles.areas.definitions, ...catalog.roles.facets.definitions];
}
export function validateSemanticCatalog(catalog: SemanticCatalog): void {
  if (catalog.schemaVersion !== 1 || catalog.catalogId !== "pr-semantics") throw new Error("中央语义目录版本无效");
  const primaryIds = catalog.roles.primaryKind.definitions.map((item) => item.id);
  const exactPrimary = ["feature", "bug", "performance", "refactor", "test", "build", "documentation", "workflow", "chore"];
  const exactRisks = ["security", "breaking-change"];
  const exactAreas = ["area:source", "area:test", "area:workflow", "area:automation", "area:docs", "area:config", "area:runtime", "area:release"];
  const exactFacets = ["dependencies", "github_actions", "javascript", "config", "revert", "style", "localization"];
  if (JSON.stringify(primaryIds) !== JSON.stringify(exactPrimary)
    || JSON.stringify(catalog.roles.riskFlags.definitions.map((item) => item.id)) !== JSON.stringify(exactRisks)
    || JSON.stringify(catalog.roles.areas.definitions.map((item) => item.id)) !== JSON.stringify(exactAreas)
    || JSON.stringify(catalog.roles.facets.definitions.map((item) => item.id)) !== JSON.stringify(exactFacets)) throw new Error("中央语义目录角色集合不是v1固定集合");
  const management = (role: keyof SemanticCatalog["roles"]): string => {
    const value = catalog.roles[role].management; return `${value.metadataOwner}:${value.assignmentOwner}:${value.reconcile}`;
  };
  if (management("primaryKind") !== "steward:steward:exclusive-replace"
    || management("riskFlags") !== "steward:shared:provenance-aware-set"
    || management("areas") !== "steward:steward:authoritative-set"
    || management("facets") !== "steward:shared:provenance-aware-set") throw new Error("中央语义目录角色管理合同无效");
  for (const item of [...catalog.roles.primaryKind.definitions, ...catalog.roles.riskFlags.definitions, ...catalog.roles.areas.definitions]) if (!item.githubLabel) throw new Error(`受管角色缺少物理标签: ${item.id}`);
  for (const item of catalog.roles.facets.definitions) if (["config", "revert", "style", "localization"].includes(item.id) !== (item.githubLabel === null)) throw new Error(`facet物理标签合同无效: ${item.id}`);
  unique(primaryIds, "主类"); unique(catalog.roles.primaryKind.order, "主类顺序");
  if (JSON.stringify(primaryIds) !== JSON.stringify(catalog.roles.primaryKind.order)) throw new Error("主类定义顺序与order不一致");
  const allIds = roleDefinitions(catalog).map((item) => item.id); unique(allIds, "语义定义");
  const labels = roleDefinitions(catalog).flatMap((item) => item.githubLabel ? [item.githubLabel.name.toLowerCase()] : []);
  unique(labels, "物理标签名称");
  if (!primaryIds.includes(catalog.fallback.defaultPrimaryKind)) throw new Error("默认主类不存在");
  for (const value of Object.values(catalog.fallback.commitTypeToPrimaryKind)) if (!primaryIds.includes(value)) throw new Error(`Conventional映射引用未知主类: ${value}`);
  const selections = new Map(catalog.roles.primaryKind.definitions.map((item) => [item.id, item.selection]));
  for (const id of ["feature", "bug", "performance", "refactor", "build"]) if (selections.get(id) !== "ai-eligible") throw new Error(`${id}必须允许AI观察`);
  for (const id of ["test", "documentation", "workflow"]) if (selections.get(id) !== "rule-only") throw new Error(`${id}必须只由规则选择`);
  if (selections.get("chore") !== "fallback-only") throw new Error("chore必须只作回退");
}
function referencedSets(match: RuleMatch): { file: string[]; text: string[] } {
  return "fileSets" in match ? { file: match.fileSets, text: [] } : { file: [], text: match.commitTextSets };
}
export function validateClassificationProfile(catalog: SemanticCatalog, profile: ClassificationProfile): void {
  if (profile.schemaVersion !== 2 || profile.semanticCatalog.id !== catalog.catalogId || profile.semanticCatalog.schemaVersion !== catalog.schemaVersion) throw new Error("分类配置没有绑定中央目录v1");
  const primary = new Set(catalog.roles.primaryKind.definitions.map((item) => item.id));
  const risks = new Set(catalog.roles.riskFlags.definitions.map((item) => item.id));
  const facets = new Set(catalog.roles.facets.definitions.map((item) => item.id));
  const areas = new Set(catalog.roles.areas.definitions.map((item) => item.id));
  const ids = [...profile.rules.primaryKind, ...profile.rules.riskFlags, ...profile.rules.facets, ...profile.areas].map((item) => item.id);
  unique(ids, `${profile.name}规则编号`);
  for (const rule of profile.rules.primaryKind) if (!primary.has(rule.primaryKind)) throw new Error(`主类规则引用未知定义: ${rule.primaryKind}`);
  for (const rule of profile.rules.riskFlags) if (!risks.has(rule.riskFlag)) throw new Error(`风险规则引用未知定义: ${rule.riskFlag}`);
  for (const rule of profile.rules.facets) if (!facets.has(rule.facet)) throw new Error(`facet规则引用未知定义: ${rule.facet}`);
  for (const rule of profile.areas) if (!areas.has(rule.area)) throw new Error(`area规则引用未知定义: ${rule.area}`);
  for (const rule of [...profile.rules.primaryKind, ...profile.rules.riskFlags, ...profile.rules.facets, ...profile.areas]) {
    const references = referencedSets(rule.match);
    for (const name of references.file) if (!profile.fileSets[name]) throw new Error(`规则引用未知fileSet: ${name}`);
    for (const name of references.text) if (!profile.commitTextSets[name]) throw new Error(`规则引用未知commitTextSet: ${name}`);
  }
  for (const name of [...profile.runtimeRelease.includeFileSets, ...profile.runtimeRelease.excludeFileSets, ...profile.installOrPackage.fileSets]) if (!profile.fileSets[name]) throw new Error(`发布事实引用未知fileSet: ${name}`);
  for (const patterns of Object.values(profile.commitTextSets)) for (const pattern of patterns) new RegExp(pattern, "iu");
  const aiEligible = new Set(catalog.roles.primaryKind.definitions.filter((item) => item.selection === "ai-eligible").map((item) => item.id));
  for (const id of profile.ai.eligiblePrimaryKinds) if (!aiEligible.has(id)) throw new Error(`AI资格引用不可选主类: ${id}`);
  if (profile.releaseCategories.filter((item) => item.fallback).length !== (profile.releaseCategories.length ? 1 : 0)) throw new Error("发布回退类别必须恰好一个");
  for (const item of profile.releaseCategories) if (item.fallback === Boolean(item.matchAny)) throw new Error(`发布类别fallback合同无效: ${item.id}`);
}
export function validateRepositoryClassification(profile: ClassificationProfile, value: RepositoryClassification): void {
  if (value.profile !== profile.name) throw new Error("仓库分类配置与profile不一致");
  if (value.labelAssignmentMode === "enforce" && value.labelDefinitionMode !== "enforce") throw new Error("PR标签enforce要求物理定义enforce");
  const eligible = new Set(profile.ai.eligiblePrimaryKinds);
  for (const id of value.ai.adoptedPrimaryKinds) if (!eligible.has(id)) throw new Error(`仓库采用未知AI主类: ${id}`);
  if (value.ai.mode === "shadow" && (value.ai.adoptedPrimaryKinds.length || value.ai.canaries.length)) throw new Error("shadow模式不得配置采用主类或canary");
  if (value.ai.mode !== "shadow" && (!value.ai.adoptedPrimaryKinds.length || value.labelAssignmentMode !== "enforce")) throw new Error("AI采用要求主类集合和PR标签enforce");
  if (value.ai.mode === "draft-canary" && !value.ai.canaries.length) throw new Error("draft-canary必须配置精确canary");
  if (value.ai.mode !== "draft-canary" && value.ai.canaries.length) throw new Error("只有draft-canary允许canary清单");
  unique(value.ai.canaries.map((item) => `${item.repositoryId}:${item.pullRequestNumber}:${item.headSha}:${item.sourceRepositoryId}:${item.sourceRef}`), "canary");
}

export function canonicalize(value: unknown): string {
  const valueType = typeof value;
  if (valueType === "undefined" || valueType === "symbol" || valueType === "function" || valueType === "bigint") throw new TypeError(`规范化输入包含JSON不支持的类型: ${valueType}`);
  if (value === null || valueType !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("规范化输入无法序列化为JSON");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => key !== "$schema").sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}
export function digest(value: unknown): string { return createHash("sha256").update(canonicalize(value), "utf8").digest("hex"); }
export function classificationDigests(catalog: SemanticCatalog, profile: ClassificationProfile, repository: RepositoryClassification): ClassificationDigests {
  const catalogDigest = digest(catalog); const profileDigest = digest(profile); const repositoryClassificationDigest = digest(repository);
  return { catalogDigest, profileDigest, repositoryClassificationDigest, classificationPolicyDigest: digest({ catalogDigest, profileDigest, repositoryClassificationDigest }) };
}
function normalizeLf(value: string): string { return value.replace(/\r\n?/gu, "\n"); }
function sha256Text(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function takeCharacters(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  let count = 0;
  let end = 0;
  for (const character of value) {
    if (count >= maximum) break;
    count += 1;
    end += character.length;
  }
  return value.slice(0, end);
}
export function buildAiDiffObservation(
  files: RawClassificationFacts["files"],
  maximumPatchCharacters = 22_000,
): AiDiffObservation {
  if (!Number.isSafeInteger(maximumPatchCharacters) || maximumPatchCharacters < 0) throw new Error("AI差异字符上限无效");
  let remaining = maximumPatchCharacters;
  const excerpts: string[] = [];
  const observations = [...files]
    .sort((left, right) => compareText(left.path, right.path) || compareText(left.previousPath ?? "", right.previousPath ?? ""))
    .map((file): AiDiffFileObservation => {
      const patch = typeof file.patch === "string" ? normalizeLf(file.patch) : null;
      if (patch === null) {
        excerpts.push(`文件：${file.path}\n补丁：未提供`);
        return { path: file.path, patchState: "missing", shownPatchDigest: sha256Text("") };
      }
      const shown = takeCharacters(patch, remaining);
      remaining -= [...shown].length;
      const patchState = shown.length === patch.length ? "complete" : "truncated";
      excerpts.push(`文件：${file.path}\n补丁状态：${patchState}\n${shown}`);
      return { path: file.path, patchState, shownPatchDigest: sha256Text(shown) };
    });
  return {
    truncated: observations.some((file) => file.patchState !== "complete"),
    files: observations,
    excerpt: excerpts.join("\n\n"),
  };
}
export function classificationInputDigest(facts: RawClassificationFacts, policySha: string, classificationPolicyDigest: string): string {
  if (!/^[0-9a-f]{40}$/u.test(policySha) || !/^[0-9a-f]{64}$/u.test(classificationPolicyDigest)) throw new Error("分类输入摘要的策略标识无效");
  const observation = buildAiDiffObservation(facts.files);
  const files = facts.files.map((file) => ({
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  })).sort((left, right) => compareText(left.path, right.path) || compareText(left.previousPath ?? "", right.previousPath ?? ""));
  return digest({
    schemaVersion: 2,
    repositoryId: facts.repositoryId,
    pullRequestNumber: facts.pullRequestNumber,
    sourceRepositoryId: facts.sourceRepositoryId,
    sourceRef: facts.sourceRef,
    targetRef: facts.targetRef,
    headSha: facts.headSha,
    baseSha: facts.baseSha,
    policySha,
    classificationPolicyDigest,
    commits: facts.commits.map((commit) => ({ sha: commit.sha, message: normalizeLf(commit.message) })),
    files,
    aiObservation: {
      truncated: observation.truncated,
      files: observation.files,
    },
  });
}

export function createAiClassificationEnvelope(input: {
  facts: RawClassificationFacts;
  policySha: string;
  digests: ClassificationDigests;
  effectiveAiMode: AiMode;
  suggestion: unknown;
}): AiClassificationEnvelopeV2 {
  return {
    schemaVersion: 2,
    repositoryId: input.facts.repositoryId,
    pullRequestNumber: input.facts.pullRequestNumber,
    sourceRepositoryId: input.facts.sourceRepositoryId,
    sourceRef: input.facts.sourceRef,
    targetRef: input.facts.targetRef,
    headSha: input.facts.headSha,
    baseSha: input.facts.baseSha,
    policySha: input.policySha,
    catalogDigest: input.digests.catalogDigest,
    profileDigest: input.digests.profileDigest,
    repositoryClassificationDigest: input.digests.repositoryClassificationDigest,
    classificationPolicyDigest: input.digests.classificationPolicyDigest,
    inputDigest: classificationInputDigest(input.facts, input.policySha, input.digests.classificationPolicyDigest),
    effectiveAiMode: input.effectiveAiMode,
    suggestion: input.suggestion,
  };
}

function validSha(value: unknown, length: 40 | 64): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value);
}
function classificationPlainText(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${name}必须是字符串`);
  const result = value.trim();
  const count = [...result].length;
  if (count < minimum || count > maximum || /[\r\n<>]/u.test(result)) throw new Error(`${name}长度或格式无效`);
  return result;
}
function classificationEvidencePath(value: unknown): string {
  const name = "classification.evidence[].path";
  if (typeof value !== "string") throw new TypeError(`${name}必须是字符串`);
  const count = [...value].length;
  if (count < 1 || count > 500 || /[\r\n<>]/u.test(value)) throw new Error(`${name}长度或格式无效`);
  return value;
}
export function validateClassificationSuggestion(
  value: unknown,
  eligiblePrimaryKinds?: readonly string[],
  observation?: AiDiffObservation,
): AiClassificationSuggestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("classification必须是对象");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !["primaryKind", "confidence", "evidence"].includes(key))) throw new Error("classification包含额外字段");
  if (typeof object.primaryKind !== "string" || !/^[a-z][a-z0-9-]{0,39}$/u.test(object.primaryKind)) throw new Error("classification.primaryKind无效");
  if (eligiblePrimaryKinds && !eligiblePrimaryKinds.includes(object.primaryKind)) throw new Error("classification.primaryKind不属于当前分类配置");
  if (!(["high", "medium", "low"] as const).includes(object.confidence as AiClassificationConfidence)) throw new Error("classification.confidence无效");
  if (!Array.isArray(object.evidence) || object.evidence.length < 1 || object.evidence.length > 3) throw new Error("classification.evidence无效");
  const observed = observation ? new Map(observation.files.map((file) => [file.path, file])) : null;
  const uniquePaths = new Set<string>();
  const evidence = object.evidence.map((item): AiClassificationEvidence => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("classification.evidence[]必须是对象");
    const evidenceObject = item as Record<string, unknown>;
    if (Object.keys(evidenceObject).some((key) => !["path", "reason"].includes(key))) throw new Error("classification.evidence[]包含额外字段");
    const path = classificationEvidencePath(evidenceObject.path);
    const reason = classificationPlainText(evidenceObject.reason, "classification.evidence[].reason", 4, 180);
    if (/[\[\]`*_~|]/u.test(reason)) throw new Error("classification.evidence[].reason必须是无Markdown纯文本");
    if (uniquePaths.has(path)) throw new Error("classification.evidence路径重复");
    uniquePaths.add(path);
    if (observed && observed.get(path)?.patchState !== "complete") throw new Error("classification.evidence路径不属于完整已显示差异");
    return { path, reason };
  });
  return { primaryKind: object.primaryKind, confidence: object.confidence as AiClassificationConfidence, evidence };
}

function absentAi(state: AiClassificationAssessment["state"], reasonCode: string): AiClassificationAssessment {
  return { state, status: "absent", reasonCode, suggestion: null, verifiedSuggestion: null };
}
export function verifyAiClassificationEnvelope(
  value: unknown,
  context: AiEnvelopeVerificationContext,
): AiClassificationAssessment {
  if (value === undefined) return absentAi("missing", "primary-ai-missing");
  if (!context.trustedSource) return { ...absentAi("invalid", "primary-ai-untrusted-actor"), status: "rejected" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...absentAi("invalid", "primary-ai-invalid-payload"), status: "rejected" };
  const envelope = value as Record<string, unknown>;
  const expectedKeys = [
    "schemaVersion", "repositoryId", "pullRequestNumber", "sourceRepositoryId", "sourceRef", "targetRef", "headSha", "baseSha", "policySha",
    "catalogDigest", "profileDigest", "repositoryClassificationDigest", "classificationPolicyDigest", "inputDigest", "effectiveAiMode", "suggestion",
  ];
  if (Object.keys(envelope).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(envelope, key))) return { ...absentAi("invalid", "primary-ai-invalid-payload"), status: "rejected" };
  if (envelope.schemaVersion !== 2
    || !Number.isSafeInteger(envelope.repositoryId) || !Number.isSafeInteger(envelope.pullRequestNumber) || !Number.isSafeInteger(envelope.sourceRepositoryId)
    || ![envelope.sourceRef, envelope.targetRef].every((item) => typeof item === "string" && item.startsWith("refs/heads/"))
    || !validSha(envelope.headSha, 40) || !validSha(envelope.baseSha, 40) || !validSha(envelope.policySha, 40)
    || !validSha(envelope.catalogDigest, 64) || !validSha(envelope.profileDigest, 64) || !validSha(envelope.repositoryClassificationDigest, 64)
    || !validSha(envelope.classificationPolicyDigest, 64) || !validSha(envelope.inputDigest, 64)
    || !["shadow", "draft-canary", "active"].includes(String(envelope.effectiveAiMode))) {
    return { ...absentAi("invalid", "primary-ai-invalid-payload"), status: "rejected" };
  }
  const expectedInputDigest = classificationInputDigest(context.facts, context.policySha, context.digests.classificationPolicyDigest);
  const contextMatches = envelope.repositoryId === context.facts.repositoryId
    && envelope.pullRequestNumber === context.facts.pullRequestNumber
    && envelope.sourceRepositoryId === context.facts.sourceRepositoryId
    && envelope.sourceRef === context.facts.sourceRef
    && envelope.targetRef === context.facts.targetRef
    && envelope.headSha === context.facts.headSha
    && envelope.baseSha === context.facts.baseSha
    && envelope.policySha === context.policySha
    && envelope.catalogDigest === context.digests.catalogDigest
    && envelope.profileDigest === context.digests.profileDigest
    && envelope.repositoryClassificationDigest === context.digests.repositoryClassificationDigest
    && envelope.classificationPolicyDigest === context.digests.classificationPolicyDigest
    && envelope.inputDigest === expectedInputDigest
    && envelope.effectiveAiMode === context.repository.ai.mode;
  if (!contextMatches) return { ...absentAi("invalid", "primary-ai-context-mismatch"), status: "stale" };
  if (envelope.suggestion === null) return { state: "abstained", status: "absent", reasonCode: "primary-ai-abstained", suggestion: null, verifiedSuggestion: null };
  const observation = buildAiDiffObservation(context.facts.files);
  let suggestion: AiClassificationSuggestion;
  try {
    suggestion = validateClassificationSuggestion(envelope.suggestion, undefined, observation);
  } catch (error) {
    const evidenceFailure = error instanceof Error && /evidence/u.test(error.message);
    return { ...absentAi("invalid", evidenceFailure ? "primary-ai-evidence-invalid" : "primary-ai-invalid-payload"), status: "rejected" };
  }
  if (!context.profile.ai.eligiblePrimaryKinds.includes(suggestion.primaryKind)) return { state: "valid", status: "rejected", reasonCode: "primary-ai-kind-ineligible", suggestion, verifiedSuggestion: null, wouldPrimary: suggestion.primaryKind };
  if (observation.truncated) return { state: "valid", status: "rejected", reasonCode: "primary-ai-incomplete-diff", suggestion, verifiedSuggestion: null, wouldPrimary: suggestion.primaryKind };
  if (suggestion.confidence !== context.profile.ai.minimumConfidence) return { state: "valid", status: "rejected", reasonCode: "primary-ai-low-confidence", suggestion, verifiedSuggestion: null, wouldPrimary: suggestion.primaryKind };
  let adoptable = false;
  let reasonCode = "primary-ai-mode-shadow";
  if (context.repository.ai.mode === "active") {
    adoptable = context.repository.ai.adoptedPrimaryKinds.includes(suggestion.primaryKind);
    reasonCode = adoptable ? "primary-ai-accepted" : "primary-ai-kind-ineligible";
  } else if (context.repository.ai.mode === "draft-canary") {
    const canary = context.repository.ai.canaries.some((item) => item.repositoryId === context.facts.repositoryId
      && item.pullRequestNumber === context.facts.pullRequestNumber && item.headSha === context.facts.headSha
      && item.sourceRepositoryId === context.facts.sourceRepositoryId && item.sourceRef === context.facts.sourceRef);
    adoptable = canary && context.repository.ai.adoptedPrimaryKinds.includes(suggestion.primaryKind);
    reasonCode = adoptable ? "primary-ai-accepted" : (canary ? "primary-ai-kind-ineligible" : "primary-ai-context-mismatch");
  }
  return {
    state: "valid",
    status: adoptable ? "accepted" : "rejected",
    reasonCode,
    suggestion,
    verifiedSuggestion: { primaryKind: suggestion.primaryKind, adoptable },
    wouldPrimary: suggestion.primaryKind,
  };
}

function paths(facts: RawClassificationFacts): string[] { return facts.files.flatMap((file) => file.previousPath ? [file.path, file.previousPath] : [file.path]); }
function fileSetMatch(profile: ClassificationProfile, fileSetNames: readonly string[], path: string): boolean {
  return fileSetNames.flatMap((name) => profile.fileSets[name] ?? []).some((pattern) => minimatch(path, pattern, { dot: true, nocase: false }));
}
function ruleMatches(profile: ClassificationProfile, facts: RawClassificationFacts, match: RuleMatch): boolean {
  if (match.type === "all-files") return facts.files.length > 0 && facts.files.every((file) => [file.path, file.previousPath].filter((value): value is string => Boolean(value)).every((path) => fileSetMatch(profile, match.fileSets, path)));
  if (match.type === "any-file") return paths(facts).some((path) => fileSetMatch(profile, match.fileSets, path));
  if (!("commitTextSets" in match)) return false;
  const patterns = match.commitTextSets.flatMap((name: string) => profile.commitTextSets[name] ?? []).map((pattern: string) => new RegExp(pattern, "iu"));
  return facts.commits.some((commit) => patterns.some((pattern) => pattern.test(commit.message)));
}
export function evaluateClassificationRules(catalog: SemanticCatalog, profile: ClassificationProfile, facts: RawClassificationFacts): RuleEvaluation {
  if (!facts.files.length || !facts.commits.length) throw new Error("分类需要完整文件和提交集合");
  const primaryCandidates: RuleEvaluation["primaryCandidates"] = [];
  for (const rule of profile.rules.primaryKind) if (ruleMatches(profile, facts, rule.match)) primaryCandidates.push({ id: rule.primaryKind, ruleId: rule.id });
  if (new Set(primaryCandidates.map((item) => item.id)).size > 1) throw new Error("primary-hard-rule-conflict");
  const riskFlags = profile.rules.riskFlags.filter((rule) => ruleMatches(profile, facts, rule.match)).map((rule) => ({ id: rule.riskFlag, ruleId: rule.id }));
  const facets = profile.rules.facets.filter((rule) => ruleMatches(profile, facts, rule.match)).map((rule) => ({ id: rule.facet, ruleId: rule.id }));
  const areas = profile.areas.filter((rule) => ruleMatches(profile, facts, rule.match)).map((rule) => ({ id: rule.area, ruleId: rule.id }));
  const runtimeRelease = paths(facts).some((path) => fileSetMatch(profile, profile.runtimeRelease.includeFileSets, path) && !fileSetMatch(profile, profile.runtimeRelease.excludeFileSets, path));
  const installOrPackage = paths(facts).some((path) => fileSetMatch(profile, profile.installOrPackage.fileSets, path));
  return { primaryCandidates, riskFlags, facets, areas, runtimeRelease, installOrPackage };
}
function fallbackPrimary(catalog: SemanticCatalog, facts: RawClassificationFacts): { id: string; reasonCode: string } {
  const mapped = new Set(facts.commits.flatMap((commit) => {
    const type = /^([a-z]+)(?:\([a-z0-9-]+\))?!?:/iu.exec(commit.message)?.[1]?.toLowerCase();
    const result = type ? catalog.fallback.commitTypeToPrimaryKind[type] : undefined;
    return result ? [result] : [];
  }));
  return mapped.size === 1
    ? { id: [...mapped][0]!, reasonCode: "primary-deterministic-type-selected" }
    : { id: catalog.fallback.defaultPrimaryKind, reasonCode: "primary-fallback-selected" };
}
export function selectPrimaryKind(
  catalog: SemanticCatalog,
  profile: ClassificationProfile,
  repository: RepositoryClassification,
  facts: RawClassificationFacts,
  evaluation: RuleEvaluation,
  verifiedAiSuggestion: VerifiedAiSuggestion | null = null,
): PrimaryDecision {
  const hard = evaluation.primaryCandidates[0];
  if (hard) return { id: hard.id, source: "hard-rule", reasonCode: "primary-hard-rule-selected", hardRuleId: hard.ruleId };
  if (verifiedAiSuggestion && profile.ai.eligiblePrimaryKinds.includes(verifiedAiSuggestion.primaryKind)
    && repository.ai.adoptedPrimaryKinds.includes(verifiedAiSuggestion.primaryKind) && verifiedAiSuggestion.adoptable) {
    return { id: verifiedAiSuggestion.primaryKind, source: "ai", reasonCode: verifiedAiSuggestion.reused ? "primary-ai-reused" : "primary-ai-accepted" };
  }
  const fallback = fallbackPrimary(catalog, facts);
  return { ...fallback, source: "deterministic-fallback" };
}
export function resolveClassificationRoles(
  catalog: SemanticCatalog,
  evaluation: RuleEvaluation,
  primaryKind: PrimaryDecision,
  existing: ExistingClassificationState,
  ai: AiClassificationAssessment = absentAi("missing", "primary-ai-missing"),
): ClassificationDecision {
  const riskDefinitions = definitionMap(catalog.roles.riskFlags.definitions);
  const facetDefinitions = definitionMap(catalog.roles.facets.definitions);
  const labels = new Set(existing.currentLabels);
  const stewardOwnedRiskFlags = new Set(existing.stewardOwnedRiskFlags);
  const stewardOwnedFacets = new Set(existing.stewardOwnedFacets);
  const riskFlags: ClassificationDecision["riskFlags"] = evaluation.riskFlags.map((item) => ({ ...item, source: "rule" }));
  for (const [id, definition] of riskDefinitions) if (definition.githubLabel && labels.has(definition.githubLabel.name) && !stewardOwnedRiskFlags.has(id) && !riskFlags.some((item) => item.id === id)) riskFlags.push({ id, source: "human" });
  const facets: ClassificationDecision["facets"] = evaluation.facets.map((item) => ({ ...item, source: "rule" }));
  for (const [id, definition] of facetDefinitions) if (definition.githubLabel && labels.has(definition.githubLabel.name) && !stewardOwnedFacets.has(id) && !facets.some((item) => item.id === id)) facets.push({ id, source: "external" });
  return { primaryKind, riskFlags, facets, areas: evaluation.areas.map((item) => ({ ...item, source: "rule" })), aiState: ai.state, ai, runtimeRelease: evaluation.runtimeRelease, installOrPackage: evaluation.installOrPackage };
}
function physicalName(definitions: readonly SemanticDefinition[], id: string): string | null {
  return definitions.find((item) => item.id === id)?.githubLabel?.name ?? null;
}
export function planClassificationLabels(catalog: SemanticCatalog, profile: ClassificationProfile, existing: ExistingClassificationState, decision: ClassificationDecision): ManagedLabelPlan {
  const current = new Set(existing.currentLabels);
  const desired = new Set<string>();
  const primaryName = physicalName(catalog.roles.primaryKind.definitions, decision.primaryKind.id);
  if (!primaryName) throw new Error("最终主类缺少物理标签");
  desired.add(primaryName);
  for (const item of decision.riskFlags) { const name = physicalName(catalog.roles.riskFlags.definitions, item.id); if (name) desired.add(name); }
  for (const item of decision.facets) { const name = physicalName(catalog.roles.facets.definitions, item.id); if (name) desired.add(name); }
  for (const item of decision.areas) { const name = physicalName(catalog.roles.areas.definitions, item.id); if (name) desired.add(name); }
  const exclusive = new Set(catalog.roles.primaryKind.definitions.flatMap((item) => item.githubLabel ? [item.githubLabel.name] : []));
  const authoritativeAreas = new Set(profile.areas.flatMap((area) => {
    const name = physicalName(catalog.roles.areas.definitions, area.area); return name ? [name] : [];
  }));
  const ownedShared = new Set([
    ...existing.stewardOwnedRiskFlags.flatMap((id) => { const name = physicalName(catalog.roles.riskFlags.definitions, id); return name ? [name] : []; }),
    ...existing.stewardOwnedFacets.flatMap((id) => { const name = physicalName(catalog.roles.facets.definitions, id); return name ? [name] : []; }),
  ]);
  const managedRemoval = new Set([...exclusive, ...authoritativeAreas, ...ownedShared]);
  return {
    desired: [...desired].sort(),
    add: [...desired].filter((name) => !current.has(name)).sort(),
    remove: [...current].filter((name) => managedRemoval.has(name) && !desired.has(name)).sort(),
    keep: [...current].filter((name) => !managedRemoval.has(name) || desired.has(name)).sort(),
    ownedRiskFlags: decision.riskFlags.filter((item) => item.source === "rule").map((item) => item.id).sort(),
    ownedFacets: decision.facets.filter((item) => item.source === "rule").map((item) => item.id).sort(),
  };
}
export function classifyPullRequest(
  catalog: SemanticCatalog,
  profile: ClassificationProfile,
  repository: RepositoryClassification,
  facts: RawClassificationFacts,
  existing: ExistingClassificationState,
  ai: AiClassificationAssessment = absentAi("missing", "primary-ai-missing"),
): ClassificationDecision {
  const evaluation = evaluateClassificationRules(catalog, profile, facts);
  const hard = evaluation.primaryCandidates[0];
  const effectiveAi = hard && ai.suggestion
    ? { ...ai, status: "rejected" as const, reasonCode: "primary-ai-hard-rule-conflict", verifiedSuggestion: null }
    : ai;
  const primary = selectPrimaryKind(catalog, profile, repository, facts, evaluation, effectiveAi.verifiedSuggestion);
  return resolveClassificationRoles(catalog, evaluation, primary, existing, effectiveAi);
}
export function classifyReleaseDecision(profile: ClassificationProfile, decision: ClassificationDecision): ReleaseCategory | null {
  if (!decision.runtimeRelease) return null;
  const fallback = profile.releaseCategories.find((item) => item.fallback) ?? null;
  const matches = (clause: ReleaseClause): boolean =>
    (!clause.primaryKindsAny || clause.primaryKindsAny.includes(decision.primaryKind.id))
    && (!clause.riskFlagsAny || decision.riskFlags.some((item) => clause.riskFlagsAny!.includes(item.id)))
    && (!clause.areasAny || decision.areas.some((item) => clause.areasAny!.includes(item.id)))
    && (!clause.facetsAny || decision.facets.some((item) => clause.facetsAny!.includes(item.id)))
    && (clause.runtimeRelease === undefined || clause.runtimeRelease === decision.runtimeRelease)
    && (clause.installOrPackage === undefined || clause.installOrPackage === decision.installOrPackage);
  return profile.releaseCategories.find((item) => !item.fallback && item.matchAny?.some(matches)) ?? fallback;
}
