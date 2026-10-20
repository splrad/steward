#!/usr/bin/env node
import { decodeClassificationCheckEnvelope } from "../../core/src/check-envelope.js";
import { verifyWorkflowActivation } from "./workflow-activation.js";
import { selectValidationProfile } from "../../core/src/validation.js";
import { verifyWorkflowPolicy } from "./workflow-policy.js";
export { verifyWorkflowPolicy };
import { readWorkflowContract, contractDigest } from "./workflow-contract.js";
import { selectContractAuthority } from "../../core/src/workflow-contract-authority.js";
import { evaluateRemoteWorkflowContract } from "../../github/src/workflow-contract.js";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  classifyPullRequest, classificationDigests, classificationInputDigest, digest,
  escapeMarkdownText,
  normalizeContributor,
  organizationPullRequestTemplate,
  generateOrganizationReviewInstructions, generateReviewInstructionSet, assertReviewInstructionRetirements, validateReviewInstructionContents, planClassificationLabels, planLabelDefinitions, planRepositorySettings, renderManagedBody,
  renderOnboardingPullRequest, renderValidationSummary, runValidationTasks,
  validateRepositoryForOnboarding, verifyAiClassificationEnvelope,
  type AiClassificationAssessment, type AiClassificationEnvelopeV2, type AiClassificationSuggestion, type ClassificationProfile, type Contributor, type GeneratedReviewInstructionSet, type RawClassificationFacts, type RepositoryClassification, type ReviewProfileRegistry, type ReviewRuleRegistry, type SemanticCatalog, type ValidationProfile,
} from "../../core/src/index.js";
import { createInstallationToken, dispatchWorkflow, GitHubClient, GitHubRequestError, isDependabotReviewEligible } from "../../github/src/index.js";
import { managedRepositoryIds, managedRepositoryTargets, runManagedRepositorySync, type ManagedTarget } from "./managed-repository-sync.js";
import { releaseCandidateCommand } from "./release-command.js";
import { releaseProduceCommand } from "./release-produce-command.js";
import { trustedPolicyCommand } from "./trusted-policy-source.js";
import { releaseBuildCommand } from "./release-build-command.js";
import { freezeReleaseGitInput, type GitReleaseBoundary } from "./release-git-input.js";
import { classificationFacts } from "./classification-facts.js";
import { targetManagedBlock, updatePullRequestBodyDurably, type DurableBodyRedrive } from "./pr-body-writer.js";
import { minimatch } from "minimatch";
import YAML from "yaml";
import { Ajv2020, type AnySchemaObject } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readForkCopilotEvidence } from "./copilot-fork-evidence.js";
import { classifyCopilotReviewState, isCopilotIdentity, copilotReviewTrigger, type CopilotReviewState, type CopilotReviewTrigger } from "./copilot-review-state.js";

const commands = new Set(["review-trigger-mode", "managed-repository-ids", "onboard-repository", "pr-classification", "request-copilot-review", "sync-review-instructions", "sync-managed-labels", "validate", "release-candidate"]);
const stewardRepositoryId = 1296724484;
commands.add("review-sync-targets");
commands.add("observe-copilot-review");
commands.add("render-review-instructions");
commands.add("release-freeze");
commands.add("release-produce");
commands.add("release-build");
commands.add("trusted-policy-source");
commands.add("validation-profile");
commands.add("verify-workflow-activation");
// Repository configuration and workspace files are runtime inputs, not bundle assets.
// This wrapper keeps their paths opaque to the static asset tracer used by ncc.
const runtimeReadFile = ((path: Parameters<typeof readFile>[0], options?: Parameters<typeof readFile>[1]) =>
  Reflect.apply(readFile, undefined, options === undefined ? [path] : [path, options])) as typeof readFile;
const allowedArguments: Record<string, Set<string>> = {
  "trusted-policy-source": new Set(),
  "verify-workflow-activation": new Set(),
  "validation-profile": new Set(["repository-id", "private"]),
  "release-produce": new Set(["bundle", "ticket", "runtime-url", "copilot-loader", "output"]),
  "release-build": new Set(["build-id", "operation", "policy-sha", "repository-id", "target-tag", "target-sha", "author-ids", "request-key", "request", "source-bundle", "workspace", "assets", "inspector", "output", "run-id", "attempt", "artifact-id"]),
  "release-freeze": new Set(["workspace", "repository-id", "default-branch", "target-sha", "policy-sha", "target-tag", "boundary-sha", "boundary-tag", "baseline-reference", "full-tree", "output"]),
  "observe-copilot-review": new Set(["repository-id", "pull-request-number", "event-head-sha", "policy-sha"]),
  "render-review-instructions": new Set(["profile", "policy-sha"]),
  "review-sync-targets": new Set(["repository-id", "policy-sha"]),
  "review-trigger-mode": new Set(["repository-id", "policy-sha"]),
  "request-copilot-review": new Set(["delivery-id", "repository-id", "pull-request-number", "event-head-sha", "policy-sha"]),
  "managed-repository-ids": new Set(["policy-sha"]),
  "onboard-repository": new Set(["repository-id", "repository-full-name", "trigger", "delivery-id", "policy-sha"]),
  "pr-classification": new Set(["delivery-id", "repository-id", "pull-request-number", "event-head-sha", "scan-all", "policy-sha"]),
  "sync-review-instructions": new Set(["repository-id", "policy-sha"]),
  "sync-managed-labels": new Set(["repository-id", "policy-sha"]),
  validate: new Set(["workspace", "repository-id", "profile"]),
  "release-candidate": new Set(["operation", "repository-id", "target-tag", "policy-sha", "bundle", "assets", "output", "revision", "request-key"]),
};

export interface ParsedInvocation { command: string; args: Readonly<Record<string, string>> }

export function parseInvocation(argv: readonly string[]): ParsedInvocation {
  const command = argv[0];
  if (!command || !commands.has(command)) throw new Error(`未知命令: ${command ?? "<空>"}`);
  const args: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`参数格式无效: ${flag ?? "<空>"}`);
    const name = flag.slice(2);
    if (!allowedArguments[command]!.has(name)) throw new Error(`未知参数: --${name}`);
    if (Object.hasOwn(args, name)) throw new Error(`重复参数: --${name}`);
    args[name] = value;
  }
  return { command, args: Object.freeze(args) };
}

function required(args: Readonly<Record<string, string>>, name: string): string {
  const value = args[name]; if (!value) throw new Error(`缺少参数: --${name}`); return value;
}
export function env(name: string): string { const value = process.env[name]; if (!value) throw new Error(`缺少环境变量: ${name}`); return value; }
function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name}必须是十进制整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name}必须是安全整数`);
  return parsed;
}
function sha(value: string, name: string): string { if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${name}必须是40位提交编号`); return value.toLowerCase(); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
async function json<T>(path: string): Promise<T> { return deepFreeze(JSON.parse(await runtimeReadFile(path, "utf8")) as T); }
function configPath(...segments: string[]): string {
  const executable = process.argv[1];
  if (!executable && !process.env.STEWARD_CONFIG_DIRECTORY) throw new Error("无法确定中央配置目录");
  const root = process.env.STEWARD_CONFIG_DIRECTORY
    ? resolve(process.env.STEWARD_CONFIG_DIRECTORY)
    : resolve(dirname(executable!), "..", "..", "..", "config");
  return join(root, ...segments);
}
function splitRepository(fullName: string): [string, string] { const parts = fullName.split("/"); if (parts.length !== 2 || parts.some(x => !x)) throw new Error("仓库完整名称无效"); return parts as [string, string]; }
async function client(repositoryId: number, permissions: Parameters<typeof createInstallationToken>[0]["permissions"], policySha: string, transport: typeof fetch = fetch): Promise<GitHubClient> {
  return (await clientWithToken(repositoryId, permissions, policySha, transport)).client;
}
async function clientWithToken(repositoryId: number, permissions: Parameters<typeof createInstallationToken>[0]["permissions"], policySha: string, transport: typeof fetch = fetch): Promise<{ token: string; client: GitHubClient }> {
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId, permissions, policySha });
  return { token, client: new GitHubClient(token, "https://api.github.com", transport, policySha) };
}
async function summary(lines: readonly string[]): Promise<void> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) await writeFile(target, `${lines.join("\n")}\n`, { flag: "a" }); else process.stdout.write(`${lines.join("\n")}\n`);
}
async function output(values: Record<string, string | number>): Promise<void> { const target = process.env.GITHUB_OUTPUT; if (!target) return; await writeFile(target, Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}`).join("\n") + "\n", { flag: "a" }); }

interface Catalog { organization: { id: number; login: string }; defaults: { public: any; private: any }; repositories: Record<string, any> }
async function catalog(): Promise<Catalog> { return json(configPath("repositories.json")); }
async function semanticCatalog(): Promise<SemanticCatalog> { return json(configPath("labels", "pr-semantics.json")); }
async function loadReviewInstructions(profile: unknown, paths: { profiles: string; rules: string }): Promise<GeneratedReviewInstructionSet> {
  const profiles = await json<ReviewProfileRegistry & { $schema?: string }>(paths.profiles);
  const rules = await json<ReviewRuleRegistry & { $schema?: string }>(paths.rules);
  const { $schema: _profileSchema, ...profileRegistry } = profiles;
  const { $schema: _ruleSchema, ...ruleRegistry } = rules;
  return generateReviewInstructionSet(profile, profileRegistry, ruleRegistry);
}
async function renderReviewInstructionsCommand(args: Readonly<Record<string, string>>): Promise<void> {
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const { $schema: _profileSchema, ...profiles } = await json<ReviewProfileRegistry & { $schema?: string }>(configPath("review", "profiles.json"));
  const { $schema: _ruleSchema, ...rules } = await json<ReviewRuleRegistry & { $schema?: string }>(configPath("review", "rules.json"));
  const organization = await generateOrganizationReviewInstructions(profiles, rules);
  const repository = args.profile === undefined ? undefined : await generateReviewInstructionSet(required(args, "profile"), profiles, rules);
  process.stdout.write(JSON.stringify({ policySha, organization, repository }, null, 2) + "\n");
}
export function configurationFor(catalogValue: Catalog, repository: any): any {
  const override = catalogValue.repositories[String(repository.id)];
  if (override && override.fullName !== repository.full_name) throw new Error("仓库编号与中央目录名称不一致");
  const configuration = { ...(repository.private ? catalogValue.defaults.private : catalogValue.defaults.public), ...(override ?? {}) };
  return Object.freeze({ ...configuration, copilotReviewTrigger: copilotReviewTrigger(configuration.copilotReviewTrigger) });
}

async function validatedReviewCatalog(): Promise<Catalog> {
  const registry = await catalog();
  const schema = await json<AnySchemaObject>(configPath("..", "schema", "repositories.schema.json"));
  const validator = new Ajv2020({ allErrors: true, strict: false });
  const addFormats = addFormatsModule as unknown as typeof import("ajv-formats").default;
  addFormats(validator);
  if (!validator.validate(schema, registry)) throw new Error("中央目录不符合仓库schema");
  return registry;
}
async function reviewTriggerModeCommand(args: Readonly<Record<string, string>>) {
  env("GITHUB_OUTPUT");
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const registry = await validatedReviewCatalog();
  const gh = await client(repositoryId, { metadata: "read" }, policySha);
  const repository = await gh.getRepositoryById(repositoryId);
  if (repository.id !== repositoryId || repository.owner?.id !== registry.organization.id || repository.owner?.login !== registry.organization.login) throw new Error("模式解析仓库身份不一致");
  await output({ trigger: configurationFor(registry, repository).copilotReviewTrigger });
}
export function reviewSyncMatrix(registry: Catalog, repositories: readonly any[], repositoryId?: number) {
  const targets = managedRepositoryTargets(registry, repositories, repositoryId);
  const include = targets.filter(target => target.managed).map(target => ({ repositoryId: String(target.repository.id), trigger: copilotReviewTrigger(target.configuration.copilotReviewTrigger) }));
  if (!include.length || include.length > 256) throw new Error("审查同步仓库数量无效");
  return { include };
}
async function reviewSyncTargetsCommand(args: Readonly<Record<string, string>>) {
  env("GITHUB_OUTPUT");
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  await assertManualSyncAuthorization(policySha);
  const registry = await validatedReviewCatalog();
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), permissions: { metadata: "read" }, policySha });
  const repositories = await new GitHubClient(token, "https://api.github.com", fetch, policySha).listInstallationRepositories();
  const matrix = reviewSyncMatrix(registry, repositories, args["repository-id"] ? integer(args["repository-id"], "repository-id") : undefined);
  await output({ matrix: JSON.stringify(matrix) });
}

async function optional<T>(operation: () => Promise<T>): Promise<T | null> { try { return await operation(); } catch (error) { if (error instanceof GitHubRequestError && error.status === 404) return null; throw error; } }
function decodeContent(value: any): string | null { return value?.encoding === "base64" && typeof value.content === "string" ? Buffer.from(value.content.replace(/\n/g, ""), "base64").toString("utf8") : null; }
export function encodeAiClassificationPayload(value: AiClassificationEnvelopeV2): string {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (encoded.length > 16_384) throw new Error("AI分类封装超过长度上限");
  return encoded;
}
export function decodeAiClassificationPayload(value: string): unknown {
  if (!value || value.length > 16_384 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("AI分类封装格式无效");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("AI分类封装不是规范编码");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error("AI分类封装格式无效");
  }
  return parsed;
}
export function isTrustedAiClassificationSource(policySha: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.TRIGGER_ACTOR_ID === "301115370"
    && environment.WORKFLOW_REPOSITORY === "splrad/steward"
    && environment.WORKFLOW_EVENT === "workflow_dispatch"
    && typeof environment.WORKFLOW_RUN_REF === "string"
    && environment.WORKFLOW_RUN_REF.startsWith("refs/heads/")
    && environment.WORKFLOW_REF === `${environment.WORKFLOW_REPOSITORY}/.github/workflows/pr-classification.yml@${environment.WORKFLOW_RUN_REF}`
    && environment.WORKFLOW_SHA === policySha;
}
export interface ClassificationCheckStateV4 {
  v: 4;
  repositoryId: number;
  pullRequestNumber: number;
  headSha: string;
  inputDigest: string;
  policy: string;
  policySha: string;
  mode: RepositoryClassification["ai"]["mode"];
  primary: { id: string; source: "hard-rule" | "ai" | "deterministic-fallback"; reasonCode: string };
  acceptedAiPrimaryKind?: string;
  ownedRiskFlags: string[];
  riskFlags: string[];
  facets: string[];
  areas: string[];
  decisionDigest: string;
}
export interface ClassificationCheckStateCodec {
  primaryKinds: string[];
  riskFlags: string[];
  facets: string[];
  areas: string[];
}
const classificationCheckModes = ["shadow", "draft-canary", "active"] as const;
const classificationCheckSources = ["hard-rule", "ai", "deterministic-fallback"] as const;
const classificationCheckReasons = [
  "primary-hard-rule-selected", "primary-ai-accepted", "primary-ai-reused", "primary-ai-missing", "primary-ai-abstained",
  "primary-ai-invalid-payload", "primary-ai-untrusted-actor", "primary-ai-context-mismatch", "primary-ai-incomplete-facts",
  "primary-ai-incomplete-diff", "primary-ai-low-confidence", "primary-ai-kind-ineligible", "primary-ai-evidence-invalid",
  "primary-ai-hard-rule-conflict", "primary-ai-mode-shadow", "primary-deterministic-type-selected", "primary-fallback-selected",
] as const;
const classificationCheckStateBodyBytes = 154;
const classificationCheckStateBytes = classificationCheckStateBodyBytes + 32;
const classificationCheckStateEncodedLength = Math.ceil(classificationCheckStateBytes * 4 / 3);
export function classificationCheckStateCodec(catalog: SemanticCatalog, profile: ClassificationProfile): ClassificationCheckStateCodec {
  return {
    primaryKinds: [...catalog.roles.primaryKind.order],
    riskFlags: catalog.roles.riskFlags.definitions.map((item) => item.id),
    facets: catalog.roles.facets.definitions.map((item) => item.id),
    areas: profile.areas.map((item) => item.area),
  };
}
function validateClassificationCheckCodec(codec: ClassificationCheckStateCodec): void {
  for (const [name, values, maximum] of [["primaryKinds", codec.primaryKinds, 254], ["riskFlags", codec.riskFlags, 8], ["facets", codec.facets, 8], ["areas", codec.areas, 8]] as const) {
    if (!values.length || values.length > maximum || new Set(values).size !== values.length) throw new Error(`分类检查状态位序无效: ${name}`);
  }
}
function encodeStateIndex(value: string, values: readonly string[], name: string): number {
  const index = values.indexOf(value);
  if (index < 0 || index > 254) throw new Error(`分类检查状态包含未知${name}: ${value}`);
  return index;
}
function encodeStateBits(values: readonly string[], order: readonly string[], name: string): number {
  if (new Set(values).size !== values.length) throw new Error(`分类检查状态${name}重复`);
  return values.reduce((bits, value) => bits | (1 << encodeStateIndex(value, order, name)), 0);
}
function decodeStateBits(bits: number, order: readonly string[]): string[] | null {
  if ((bits >>> order.length) !== 0) return null;
  return order.filter((_value, index) => (bits & (1 << index)) !== 0);
}
export function encodeClassificationCheckState(state: ClassificationCheckStateV4, codec: ClassificationCheckStateCodec): string {
  validateClassificationCheckCodec(codec);
  if (!Number.isSafeInteger(state.repositoryId) || state.repositoryId < 1 || state.repositoryId > 0xffff_ffff
    || !Number.isSafeInteger(state.pullRequestNumber) || state.pullRequestNumber < 1 || state.pullRequestNumber > 0xffff_ffff
    || state.v !== 4 || !/^[0-9a-f]{40}$/u.test(state.policySha)
    || !/^[0-9a-f]{40}$/u.test(state.headSha) || !/^[0-9a-f]{64}$/u.test(state.inputDigest)
    || !/^[0-9a-f]{64}$/u.test(state.policy) || !/^[0-9a-f]{64}$/u.test(state.decisionDigest)) throw new Error("分类检查状态上下文无效");
  const buffer = Buffer.alloc(classificationCheckStateBytes);
  buffer[0] = 4;
  buffer.writeUInt32BE(state.repositoryId, 1);
  buffer.writeUInt32BE(state.pullRequestNumber, 5);
  Buffer.from(state.headSha, "hex").copy(buffer, 9);
  Buffer.from(state.inputDigest, "hex").copy(buffer, 29);
  Buffer.from(state.policy, "hex").copy(buffer, 61);
  Buffer.from(state.decisionDigest, "hex").copy(buffer, 93);
  buffer[125] = encodeStateIndex(state.mode, classificationCheckModes, "AI模式");
  buffer[126] = encodeStateIndex(state.primary.id, codec.primaryKinds, "主类");
  buffer[127] = encodeStateIndex(state.primary.source, classificationCheckSources, "主类来源");
  buffer[128] = encodeStateIndex(state.primary.reasonCode, classificationCheckReasons, "主类原因");
  buffer[129] = encodeStateBits(state.ownedRiskFlags, codec.riskFlags, "风险所有权");
  buffer[130] = encodeStateBits(state.facets, codec.facets, "Facet");
  buffer[131] = encodeStateBits(state.areas, codec.areas, "区域");
  buffer[132] = state.acceptedAiPrimaryKind === undefined ? 255 : encodeStateIndex(state.acceptedAiPrimaryKind, codec.primaryKinds, "已采用AI主类");
  Buffer.from(state.policySha, "hex").copy(buffer, 133);
  buffer[153] = encodeStateBits(state.riskFlags, codec.riskFlags, "风险");
  if (state.ownedRiskFlags.some(risk => !state.riskFlags.includes(risk))) throw new Error("分类检查状态的风险所有权超出风险集合");
  if (state.acceptedAiPrimaryKind !== undefined && (state.primary.source !== "ai" || state.primary.id !== state.acceptedAiPrimaryKind || !["primary-ai-accepted", "primary-ai-reused"].includes(state.primary.reasonCode))) throw new Error("分类检查状态的AI主类不一致");
  createHash("sha256").update(buffer.subarray(0, classificationCheckStateBodyBytes)).digest().copy(buffer, classificationCheckStateBodyBytes);
  return `v4:${buffer.toString("base64url")}`;
}
export function decodeClassificationCheckState(value: unknown, codec: ClassificationCheckStateCodec, expected?: { repositoryId: number; pullRequestNumber: number; headSha: string; policySha?: string }): ClassificationCheckStateV4 | null {
  try { validateClassificationCheckCodec(codec); } catch { return null; }
  const envelope = decodeClassificationCheckEnvelope(value);
  if (!envelope) return null;
  const { decoded, repositoryId, pullRequestNumber, headSha, policySha } = envelope;
  if (expected?.policySha !== undefined && policySha !== expected.policySha) return null;
  if (expected && (repositoryId !== expected.repositoryId || pullRequestNumber !== expected.pullRequestNumber || headSha !== expected.headSha)) return null;
  const mode = classificationCheckModes[decoded[125]!];
  const primaryKind = codec.primaryKinds[decoded[126]!];
  const source = classificationCheckSources[decoded[127]!];
  const reasonCode = classificationCheckReasons[decoded[128]!];
  const ownedRiskFlags = decodeStateBits(decoded[129]!, codec.riskFlags);
  const riskFlags = decodeStateBits(decoded[153]!, codec.riskFlags);
  const facets = decodeStateBits(decoded[130]!, codec.facets);
  const areas = decodeStateBits(decoded[131]!, codec.areas);
  const acceptedAiPrimaryKind = decoded[132] === 255 ? undefined : codec.primaryKinds[decoded[132]!];
  if (!mode || !primaryKind || !source || !reasonCode || !ownedRiskFlags || !riskFlags || !facets || !areas) return null;
  if (ownedRiskFlags.some(risk => !riskFlags.includes(risk))) return null;
  if (acceptedAiPrimaryKind !== undefined && (source !== "ai" || primaryKind !== acceptedAiPrimaryKind || !["primary-ai-accepted", "primary-ai-reused"].includes(reasonCode))) return null;
  return {
    v: 4, repositoryId, pullRequestNumber, headSha, policySha,
    inputDigest: decoded.subarray(29, 61).toString("hex"),
    policy: decoded.subarray(61, 93).toString("hex"),
    mode,
    primary: { id: primaryKind, source, reasonCode },
    ...(acceptedAiPrimaryKind ? { acceptedAiPrimaryKind } : {}),
    ownedRiskFlags, riskFlags, facets, areas,
    decisionDigest: decoded.subarray(93, 125).toString("hex"),
  };
}
export function reusedAiClassificationAssessment(state: ClassificationCheckStateV4 | null): AiClassificationAssessment | null {
  if (!state?.acceptedAiPrimaryKind || state.primary.source !== "ai" || state.primary.id !== state.acceptedAiPrimaryKind) return null;
  return {
    state: "valid",
    status: "reused",
    reasonCode: "primary-ai-reused",
    suggestion: null,
    verifiedSuggestion: { primaryKind: state.acceptedAiPrimaryKind, adoptable: true, reused: true },
    wouldPrimary: state.acceptedAiPrimaryKind,
  };
}

function classificationChecksForPull(checks: readonly any[],
  identity: { repositoryId: number; pullRequestNumber: number; headSha: string }): { matching: any[]; unbound: any[] } {
  const matching: any[] = [];
  const unbound: any[] = [];
  for (const check of checks) {
    if (check.name !== "PR Classification Gate" || check.app?.id !== 4243096 || check.head_sha !== identity.headSha) continue;
    const envelope = decodeClassificationCheckEnvelope(check.external_id);
    const marker = typeof check.external_id === "string" ? /^([1-9][0-9]*):([1-9][0-9]*):([0-9a-f]{40}):(pending|failure)$/u.exec(check.external_id) : null;
    const binding = envelope ?? (marker ? { repositoryId: Number(marker[1]), pullRequestNumber: Number(marker[2]), headSha: marker[3] } : null);
    if (!binding || !Number.isSafeInteger(binding.pullRequestNumber) || binding.repositoryId !== identity.repositoryId || binding.headSha !== identity.headSha) {
      unbound.push(check);
    } else if (binding.pullRequestNumber === identity.pullRequestNumber) matching.push(check);
  }
  return { matching, unbound };
}
export function renderAiClassificationEvidence(value: AiClassificationSuggestion | null): string {
  return value ? value.evidence.map((item) => `${escapeMarkdownText(item.path)}：${escapeMarkdownText(item.reason)}`).join("；") : "未提供";
}
async function dispatchClassification(input: { repositoryId: number; pullRequestNumber: number; headSha: string; policySha: string; deliveryId: string; aiClassification?: string }) {
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId: stewardRepositoryId, permissions: { actions: "write", metadata: "read" }, policySha: input.policySha });
  await dispatchWorkflow(new GitHubClient(token, "https://api.github.com", fetch, input.policySha), { owner: "splrad", repo: "steward", workflow: "pr-classification.yml", policySha: input.policySha, inputs: { deliveryId: input.deliveryId, repositoryId: String(input.repositoryId), pullRequestNumber: String(input.pullRequestNumber), eventHeadSha: input.headSha, policySha: input.policySha, ...(input.aiClassification ? { aiClassification: input.aiClassification } : {}) } });
}

const copilotCheckName = "copilot-pull-request-reviewer";
const githubActionsAppId = 15368;
export function isCopilotReviewerIdentity(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\[bot\]$/u, "");
  return normalized === "copilot" || normalized === "copilot-pull-request-reviewer";
}
export function hasRequestedCopilotReviewer(requested: { users?: readonly { login?: unknown }[] }): boolean {
  return (requested.users ?? []).some(value => isCopilotReviewerIdentity(value.login));
}
export function hasNewCopilotRequestEvent(events: readonly any[], afterEventId: number): boolean {
  return events.some(value => Number(value.id) > afterEventId && (
    (value.event === "review_requested" && isCopilotReviewerIdentity(value.requested_reviewer?.login))
    || value.event === "copilot_work_started"
  ));
}
export function hasActiveCopilotCheckRun(checkRuns: readonly any[], pullRequestNumber: number, headSha: string): boolean {
  const expectedHead = headSha.toLowerCase();
  const activeStatuses = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);
  return checkRuns.some(value =>
    value.name === copilotCheckName
    && Number(value.app?.id) === githubActionsAppId
    && String(value.head_sha ?? "").toLowerCase() === expectedHead
    && activeStatuses.has(String(value.status ?? "").toLowerCase())
    && Array.isArray(value.pull_requests)
    && value.pull_requests.some((pull: any) =>
      Number(pull.number) === pullRequestNumber
      && String(pull.head?.sha ?? "").toLowerCase() === expectedHead));
}
export function classificationInstallationPermissions(mode: "observe" | "enforce" = "enforce"): Parameters<typeof createInstallationToken>[0]["permissions"] {
  // GitHub对PR调用issues/labels端点时仍要求pull_requests:write；observe下仅issues/pull_requests保持只读。
  const assignmentPermission = mode === "enforce" ? "write" : "read";
  return { contents: "read", pull_requests: assignmentPermission, issues: assignmentPermission, checks: "write", metadata: "read" } as const;
}
export function reviewInstructionSyncInstallationPermissions(): Parameters<typeof createInstallationToken>[0]["permissions"] {
  return { administration: "read", contents: "write", pull_requests: "write", issues: "read", checks: "read", metadata: "read", members: "read" } as const;
}
export async function readCopilotReviewState(clientValue: GitHubClient, owner: string, repo: string, number: number, headSha: string, afterEventId?: number): Promise<CopilotReviewState> {
  try {
    const [requested, reviews, events, checkRuns] = await Promise.all([
      clientValue.getRequestedReviewers(owner, repo, number),
      clientValue.listPullRequestReviews(owner, repo, number),
      clientValue.listIssueEvents(owner, repo, number),
      clientValue.listAllCheckRuns(owner, repo, headSha, "all"),
    ]);
    const input = { pullRequestNumber: number, headSha, requested, reviews, events, checkRuns, afterEventId };
    const initial = classifyCopilotReviewState(input);
    if (initial.reason !== "review-check-attempt-unverified") return initial;
    const reviewTime = Math.max(...reviews.filter(review => isCopilotIdentity(review.user?.login) && review.commit_id === headSha).map(review => Date.parse(review.submitted_at)));
    const requests = events.filter(event => event.event === "review_requested" && isCopilotIdentity(event.requested_reviewer?.login)
      && (!event.commit_id || event.commit_id === headSha) && Date.parse(event.created_at) <= reviewTime);
    const since = Math.min(...requests.map(event => Date.parse(event.created_at)));
    const requestBoundary = Math.max(...requests.map(event => Date.parse(event.created_at)));
    if (!Number.isFinite(since)) return initial;
    const forkEvidence = await readForkCopilotEvidence(clientValue, owner, repo, number, headSha, new Date(since).toISOString(), requestBoundary);
    if (!forkEvidence.length) return initial;
    const [freshRequested, freshReviews, freshEvents, freshChecks] = await Promise.all([
      clientValue.getRequestedReviewers(owner, repo, number), clientValue.listPullRequestReviews(owner, repo, number),
      clientValue.listIssueEvents(owner, repo, number), clientValue.listAllCheckRuns(owner, repo, headSha, "all"),
    ]);
    if (JSON.stringify([requested, reviews, events, checkRuns]) !== JSON.stringify([freshRequested, freshReviews, freshEvents, freshChecks])) {
      return { state: "unknown", headSha, reason: "review-evidence-changed" };
    }
    return classifyCopilotReviewState({ ...input, forkEvidence });
  } catch {
    return { state: "unknown", headSha, reason: "evidence-read-failed" };
  }
}
export async function ensureCopilotReview(clientValue: GitHubClient, owner: string, repo: string, number: number, headSha: string, policySha: string,
  trigger: CopilotReviewTrigger = "native"): Promise<string> {
  trigger = copilotReviewTrigger(trigger);
  const state = await readCopilotReviewState(clientValue, owner, repo, number, headSha);
  await summary([`Copilot审查：${JSON.stringify({ repository: `${owner}/${repo}`, number, trigger, ...state })}`]);
  return `observed-${state.state}`;
}

export function isTrustedReviewRequestSource(policySha: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.TRIGGER_ACTOR_ID === "301115370"
    && environment.WORKFLOW_REPOSITORY === "splrad/steward"
    && environment.WORKFLOW_EVENT === "workflow_dispatch"
    && typeof environment.WORKFLOW_DEFAULT_BRANCH === "string" && environment.WORKFLOW_DEFAULT_BRANCH.length > 0
    && environment.WORKFLOW_RUN_REF === `refs/heads/${environment.WORKFLOW_DEFAULT_BRANCH}`
    && environment.WORKFLOW_REF === `${environment.WORKFLOW_REPOSITORY}/.github/workflows/native-review.yml@${environment.WORKFLOW_RUN_REF}`
    && environment.WORKFLOW_SHA === policySha;
}

export async function requestDependabotCopilotReview(gh: GitHubClient, repositoryId: number, number: number, headSha: string, policySha: string,
  managed: (repository: any) => boolean, trigger: CopilotReviewTrigger = "native"): Promise<string> {
  const repository = await gh.getRepositoryById(repositoryId);
  if (repository.id !== repositoryId || !managed(repository)) return "ignored";
  const [owner, repo] = splitRepository(repository.full_name);
  const eligible = (pull: any) => pull.number === number && isDependabotReviewEligible(repository, pull, headSha);
  if (!eligible(await gh.getPullRequest(owner, repo, number))) return "ignored-or-stale";
  const result = await ensureCopilotReview(gh, owner, repo, number, headSha, policySha, trigger);
  const refreshedRepository = await gh.getRepositoryById(repositoryId);
  const refreshedPull = await gh.getPullRequest(owner, repo, number);
  if (refreshedRepository.id !== repositoryId || !managed(refreshedRepository)
    || refreshedPull.number !== number || !isDependabotReviewEligible(refreshedRepository, refreshedPull, headSha)) return "changed-during-observation";
  return result;
}

async function observeCopilotReviewCommand(args: Readonly<Record<string, string>>) {
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const number = integer(required(args, "pull-request-number"), "pull-request-number");
  const headSha = sha(required(args, "event-head-sha"), "event-head-sha");
  const registry = await catalog();
  const gh = await client(repositoryId, { contents: "read", pull_requests: "read", issues: "read", checks: "read", actions: "read", metadata: "read" }, policySha);
  const repository = await gh.getRepositoryById(repositoryId);
  const eligibleRepository = (value: any) => {
    const configuration = configurationFor(registry, value);
    return value.id === repositoryId && value.owner?.id === registry.organization.id
      && !value.archived && !value.disabled && configuration.managed === true;
  };
  if (!eligibleRepository(repository)) throw new Error("仓库不在审查观察范围内");
  const [owner, repo] = splitRepository(repository.full_name);
  const eligiblePull = (pull: any) => pull.number === number && pull.state === "open"
    && pull.base?.repo?.id === repositoryId && pull.base?.ref === repository.default_branch && pull.head?.sha === headSha;
  if (!eligiblePull(await gh.getPullRequest(owner, repo, number))) throw new Error("PR不在审查观察范围内或head已变化");
  const state = await readCopilotReviewState(gh, owner, repo, number, headSha);
  const [freshRepository, freshPull] = await Promise.all([gh.getRepositoryById(repositoryId), gh.getPullRequest(owner, repo, number)]);
  if (!eligibleRepository(freshRepository) || freshRepository.full_name !== repository.full_name
    || freshRepository.default_branch !== repository.default_branch || !eligiblePull(freshPull)) throw new Error("审查观察期间PR或仓库状态变化");
  await summary([JSON.stringify({ repository: repository.full_name, number, ...state })]);
  await output({ state: state.state, reason: state.reason, headSha });
}

async function requestCopilotReviewCommand(args: Readonly<Record<string, string>>) {
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  if (!isTrustedReviewRequestSource(policySha)) throw new Error("审查请求工作流来源不可信");
  required(args, "delivery-id");
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const number = integer(required(args, "pull-request-number"), "pull-request-number");
  const headSha = sha(required(args, "event-head-sha"), "event-head-sha");
  const registry = await catalog();
  const gh = await client(repositoryId, { contents: "read", pull_requests: "read", issues: "read", checks: "read", metadata: "read" }, policySha);
  const reviewRepository = await gh.getRepositoryById(repositoryId);
  const trigger = configurationFor(registry, reviewRepository).copilotReviewTrigger;
  const result = await requestDependabotCopilotReview(gh, repositoryId, number, headSha, policySha, repository => {
    const configuration = configurationFor(registry, repository);
    return Boolean(registry.repositories[String(repository.id)]) && configuration.managed === true;
  }, trigger);
  await summary([`仓库编号：${repositoryId}`, `PR：${number}`, `目标提交：${headSha}`, `Copilot观察状态：${result}`]);

}

export async function writeManagedFilesToBranch(input: {
  gh: GitHubClient;
  owner: string;
  repo: string;
  files: readonly { path: string; content: string }[];
  retiredFiles?: readonly { path: string; content: string }[];
  branch: string;
  title: string;
  defaultSha: string;
  branchSha: string | null;
}): Promise<{ changed: boolean; headSha: string }> {
  const retiredFiles = input.retiredFiles ?? [];
  if (retiredFiles.some(file => file.path !== ".github/copilot-instructions.md" || !file.content)) throw new Error("待退役文件范围或原文无效");
  const expectedPaths = [...input.files, ...retiredFiles].map(file => file.path).sort();
  const expectedPathSet = new Set(expectedPaths);
  if (input.files.length === 0 || expectedPathSet.size !== expectedPaths.length || input.files.some(file => !file.path || !file.content)) throw new Error("受管资源集文件无效");
  if (input.branchSha) {
    const comparisonToDefault = await input.gh.compare(input.owner, input.repo, input.defaultSha, input.branchSha);
    const mergeBaseSha = String(comparisonToDefault.merge_base_commit?.sha ?? "");
    if (!/^[0-9a-f]{40}$/iu.test(mergeBaseSha)) throw new Error("受管分支比较结果缺少共同基准提交");
    const comparison = mergeBaseSha === input.defaultSha
      ? comparisonToDefault
      : await input.gh.compare(input.owner, input.repo, mergeBaseSha, input.branchSha);
    if (!Array.isArray(comparison.commits) || !Array.isArray(comparison.files)
      || Number(comparison.total_commits) !== comparison.commits.length || comparison.files.length >= 300) {
      throw new Error("受管分支比较结果不完整");
    }
    const actualPaths: string[] = comparison.files.map((file: any) => String(file.filename)).sort();
    if (Number(comparison.ahead_by) < 1 || actualPaths.length === 0 || actualPaths.some(path => !expectedPathSet.has(path))) {
      throw new Error(`受管分支包含非预期改动: ${input.branch}`);
    }
  }
  const parentSha = input.branchSha ?? input.defaultSha;
  const existing = await Promise.all(input.files.map(async file => ({ file, value: await optional(() => input.gh.getContent(input.owner, input.repo, file.path, parentSha)) })));
  const retiring = await Promise.all(retiredFiles.map(async file => ({ file, value: await optional(async () => {
    const value = await input.gh.getContent(input.owner, input.repo, file.path, parentSha);
    if (value == null) throw new Error("退役文件读取返回空响应: " + file.path);
    return value;
  }) })));
  for (const item of retiring) {
    if (item.value != null && (item.value.type && item.value.type !== "file" || decodeContent(item.value) !== item.file.content)) throw new Error("待退役审查说明含有未知或人工修改的内容: " + item.file.path);
  }
  if (existing.every(item => decodeContent(item.value) === item.file.content) && retiring.every(item => item.value == null)) return { changed: false, headSha: parentSha };
  const parent = await input.gh.getGitCommit(input.owner, input.repo, parentSha);
  const treeSha = String(parent.tree?.sha ?? "");
  if (!/^[0-9a-f]{40}$/iu.test(treeSha)) throw new Error("受管资源集父提交缺少有效tree");
  const deletions = retiring.filter(item => item.value != null);
  if (deletions.length) {
    const originalTree = await input.gh.getGitTree(input.owner, input.repo, treeSha);
    if (originalTree.sha !== treeSha || originalTree.truncated !== false || !Array.isArray(originalTree.tree)) throw new Error("退役文件的Git tree证据不完整");
    for (const item of deletions) {
      const entries = originalTree.tree.filter((entry: any) => entry.path === item.file.path);
      const expectedBlob = createHash("sha1").update("blob " + Buffer.byteLength(item.file.content, "utf8") + "\0" + item.file.content).digest("hex");
      if (entries.length !== 1 || entries[0].mode !== "100644" || entries[0].type !== "blob" || entries[0].sha !== expectedBlob) throw new Error("退役文件不是已核对的普通Git文件: " + item.file.path);
    }
  }
  const blobs = await Promise.all(input.files.map(async file => ({ file, blob: await input.gh.createBlob(input.owner, input.repo, file.content) })));
  if (blobs.some(item => !/^[0-9a-f]{40}$/iu.test(String(item.blob?.sha ?? "")))) throw new Error("受管资源集blob写入结果无效");
  const tree = await input.gh.createTree(input.owner, input.repo, {
    base_tree: treeSha,
    tree: [...blobs.map(item => ({ path: item.file.path, mode: "100644", type: "blob", sha: item.blob.sha })),
      ...deletions.map(item => ({ path: item.file.path, mode: "100644", type: "blob", sha: null }))],
  });
  if (!/^[0-9a-f]{40}$/iu.test(String(tree?.sha ?? ""))) throw new Error("受管资源集tree写入结果无效");
  const commit = await input.gh.createCommit(input.owner, input.repo, { message: input.title, tree: tree.sha, parents: [parentSha] });
  const commitSha = String(commit?.sha ?? "");
  if (!/^[0-9a-f]{40}$/iu.test(commitSha)) throw new Error("受管资源集提交结果无效");
  const readback = await Promise.all(input.files.map(async file => ({ file, value: await input.gh.getContent(input.owner, input.repo, file.path, commitSha) })));
  if (readback.some(item => decodeContent(item.value) !== item.file.content)) throw new Error("受管资源集写入后逐字读回不一致");
  for (const file of retiredFiles) {
    await optional(async () => {
      await input.gh.getContent(input.owner, input.repo, file.path, commitSha);
      throw new Error("退役文件写入后仍然存在或返回异常成功响应: " + file.path);
    });
  }
  if (input.branchSha) await input.gh.updateRef(input.owner, input.repo, `heads/${input.branch}`, commitSha, false);
  else await input.gh.createRef(input.owner, input.repo, `refs/heads/${input.branch}`, commitSha);
  const branchReadback = await input.gh.getRef(input.owner, input.repo, `heads/${input.branch}`);
  if (String(branchReadback.object?.sha ?? "") !== commitSha) throw new Error("受管资源集写入后分支head不一致");
  return { changed: true, headSha: commitSha };
}

export function assertManagedBranchPull(branchExists: boolean, pull: any | undefined, branch: string): void {
  if ((pull && (pull.user?.id !== 301115370 || pull.merged_at)) || (branchExists && !pull)) {
    throw new Error(`受管分支不是Steward拥有的开放拉取请求: ${branch}`);
  }
}

async function reconcileManagedFiles(input: { repository: any; gh: GitHubClient; token: string; instructions: GeneratedReviewInstructionSet; branch: string; title: string; policySha: string; deliveryId: string; redrive: DurableBodyRedrive }): Promise<"unchanged" | "pull-request-created" | "pull-request-updated"> {
  const [owner, repo] = splitRepository(input.repository.full_name); const defaultBranch = input.repository.default_branch;
  const defaultRef = await input.gh.getRef(owner, repo, `heads/${defaultBranch}`);
  const targets = [...input.instructions.files, ...(input.instructions.retiredFiles ?? [])];
  const current = Object.fromEntries(await Promise.all(targets.map(async file => {
    const content = await optional(async () => {
      const value = await input.gh.getContent(owner, repo, file.path, defaultRef.object.sha);
      const decoded = decodeContent(value);
      if (value == null || Array.isArray(value) || (value.type && value.type !== "file") || decoded === null) throw new Error("审查说明不是可读取的普通文件: " + file.path);
      return decoded;
    });
    return [file.path, content];
  })));
  assertReviewInstructionRetirements(current, input.instructions);
  if (input.instructions.files.every(file => current[file.path] === file.content)
    && (input.instructions.retiredFiles ?? []).every(file => current[file.path] == null)) return "unchanged";
  const pulls = await input.gh.listPullRequests(owner, repo, `${owner}:${input.branch}`); if (pulls.length > 1) throw new Error(`受管分支存在多个拉取请求: ${input.branch}`);
  const branchRef = await optional(() => input.gh.getRef(owner, repo, `heads/${input.branch}`));
  assertManagedBranchPull(Boolean(branchRef), pulls[0], input.branch);
  const written = await writeManagedFilesToBranch({ gh: input.gh, owner, repo, files: input.instructions.files, retiredFiles: input.instructions.retiredFiles ?? [], branch: input.branch, title: input.title, defaultSha: defaultRef.object.sha, branchSha: branchRef?.object.sha ?? null });
  const generated = {
    type: "chore" as const,
    scope: "steward",
    title: input.title.replace(/^chore\([^)]*\):\s*/u, ""),
    summary: "由SPLRAD Steward同步中央管理文件并保持仓库规则与中央配置一致。",
    motivation: "中央管理文件需要跟随当前规则更新，避免目标仓库保留已经过期的配置。",
    changes: [
      `按${input.instructions.profile} profile同步审查说明`,
      ...input.instructions.files.map(file => `${file.path}：${file.ruleIds.join("、")}；摘要：${file.digest}`),
      ...(input.instructions.retiredFiles ?? []).map(file => `退役已核对原文的受管文件：${file.path}；原文摘要：${file.digest}`),
      ...(input.instructions.organization ? [`组织公共规则：${input.instructions.organization.ruleIds.join("、")}；采用摘要：${input.instructions.organization.digest}`] : []),
    ],
    impact: ["目标仓库按中央配置使用共享规则和所需的Copilot指令载体"],
    releaseAndMigration: [],
  };
  const body = renderManagedBody({ generated, existingBody: pulls[0]?.body, templateBody: organizationPullRequestTemplate, actor: "splrad-steward[bot]", contributors: [], context: `${input.repository.id}:review-instructions:${input.policySha}` });
  const pull = pulls[0] ? await updatePullRequestBodyDurably({
    client: input.gh,
    token: input.token,
    runtimeUrl: env("RUNTIME_URL"),
    owner,
    repo,
    repositoryId: Number(input.repository.id),
    pullRequestNumber: Number(pulls[0].number),
    headSha: String(written.headSha),
    baseSha: String(defaultRef.object.sha),
    expectedBaseRef: defaultBranch,
    regionKind: "managed-pr",
    targetBlock: targetManagedBlock(body, "managed-pr"),
    redrive: input.redrive,
    additionalPatch: { title: input.title },
  }) : await input.gh.createPullRequest(owner, repo, { title: input.title, body, head: input.branch, base: defaultBranch });
  await ensureCopilotReview(input.gh, owner, repo, pull.number, written.headSha, input.policySha, configurationFor(await catalog(), input.repository).copilotReviewTrigger);
  await dispatchClassification({ repositoryId: input.repository.id, pullRequestNumber: pull.number, headSha: written.headSha, policySha: input.policySha, deliveryId: input.deliveryId });
  return pulls[0] ? "pull-request-updated" : "pull-request-created";
}

async function onboard(args: Readonly<Record<string, string>>) {
  const fullName = required(args, "repository-full-name"); const [owner, repo] = splitRepository(fullName);
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const trigger = required(args, "trigger");
  if (!["installation-created", "installation-repositories-added", "repository-visibility-changed", "repository-unarchived", "default-branch-push", "manual"].includes(trigger)) throw new Error("接入触发来源无效");
  if (trigger !== "manual" && !args["repository-id"]) throw new Error("事件接入必须提供仓库编号");
  let repositoryId = args["repository-id"] ? integer(args["repository-id"], "repository-id") : 0;
  if (!repositoryId) {
    const discoveryToken = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), permissions: { metadata: "read" }, policySha });
    const discovered = await new GitHubClient(discoveryToken, "https://api.github.com", fetch, policySha).getRepository(owner, repo);
    repositoryId = discovered.id;
  }
  const { token, client: gh } = await clientWithToken(repositoryId, { administration: "write", contents: "write", pull_requests: "write", issues: "read", checks: "read", metadata: "read", members: "read" }, policySha);
  const repository = await gh.getRepositoryById(repositoryId); const cfg = configurationFor(await catalog(), repository);
  if (repository.full_name !== fullName) throw new Error("仓库编号与完整名称不一致");
  const state = validateRepositoryForOnboarding({ id: repository.id, fullName: repository.full_name, ownerId: repository.owner.id, visibility: repository.private ? "private" : "public", fork: repository.fork, archived: repository.archived, disabled: repository.disabled, defaultBranch: repository.default_branch }, 302208797, cfg);
  if (trigger === "manual") {
    const actorLogin = env("TRIGGER_ACTOR_LOGIN");
    integer(env("TRIGGER_ACTOR_ID"), "TRIGGER_ACTOR_ID");
    const membership = await gh.getTeamMembership("splrad", "maintainers", actorLogin);
    if (membership.state !== "active") throw new Error("手工接入触发者不是Maintainers当前成员");
  }
  let labelSyncFailure: string | null = null;
  try { await syncManagedLabels({ "policy-sha": policySha, "repository-id": String(repositoryId) }); }
  catch (error) { labelSyncFailure = error instanceof Error ? error.message : "internal-error"; }
  const defaultRef = await optional(() => gh.getRef(owner, repo, `heads/${repository.default_branch}`));
  if (state === "waiting-for-default-branch" || !defaultRef) {
    await summary([`仓库：${fullName}`, "审查说明：waiting-for-default-branch", `标签定义：${labelSyncFailure ? "failed" : "checked"}`]);
    if (labelSyncFailure) throw new Error(labelSyncFailure);
    return;
  }
  const teams = await gh.listRepositoryTeams(owner, repo);
  if (!teams.some((team: any) => team.slug === "maintainers" && ["maintain", "admin"].includes(team.permission))) throw new Error("Maintainers没有获得仓库维护权限");
  const rulesets = await gh.listRepositoryRulesets(owner, repo);
  if (!rulesets.some((ruleset: any) => ruleset.id === 18883080 && ruleset.enforcement === "active")) throw new Error("组织默认分支规则集没有对仓库生效");
  const settings = planRepositorySettings();
  await gh.updateRepository(owner, repo, settings);
  const readback = await gh.getRepositoryById(repositoryId);
  for (const [name, value] of Object.entries(settings)) if (readback[name] !== value) throw new Error(`仓库设置读回不一致: ${name}`);
  const instructions = await loadReviewInstructions(cfg.reviewInstructionsProfile, { profiles: configPath("review", "profiles.json"), rules: configPath("review", "rules.json") });
  const planned = renderOnboardingPullRequest({ template: organizationPullRequestTemplate, configuration: cfg, actor: "splrad-steward[bot]", context: `onboard:${repositoryId}` });
  const deliveryId = required(args, "delivery-id");
  const result = await reconcileManagedFiles({ repository, gh, token, instructions, branch: planned.branch, title: planned.title, policySha, deliveryId,
    redrive: { workflow: "onboard-repository.yml", inputs: { repositoryId: String(repositoryId), repositoryFullName: fullName, trigger, deliveryId, policySha } } });
  await summary([`仓库：${fullName}`, `状态：${result === "unchanged" ? "onboarded" : result}`, `接入分支：${planned.branch}`, `分类配置：${cfg.classification.profile}`, `验证配置：${cfg.validationProfile}`, `审查说明配置：${cfg.reviewInstructionsProfile}`, `发布配置：${cfg.delivery?.githubRelease?.profile ?? "未启用"}`, ...instructions.files.map(file => `${file.path}：${file.ruleIds.join("、")}；${file.digest}`), `标签定义：${labelSyncFailure ? "failed" : "checked"}`]);
  if (labelSyncFailure) throw new Error(labelSyncFailure);
}
async function classify(args: Readonly<Record<string, string>>) {
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  if (args["scan-all"] === "true") {
    if (args["pull-request-number"] || args["event-head-sha"]) throw new Error("全量分类不能同时指定单个拉取请求");
    if (process.env.AI_CLASSIFICATION) throw new Error("全量分类不能携带单个拉取请求的AI影子建议");
    const reader = await client(repositoryId, { pull_requests: "read", metadata: "read" }, policySha);
    const repository = await reader.getRepositoryById(repositoryId); const [owner, repo] = splitRepository(repository.full_name);
    const defaultBranch = repository.default_branch;
    if (typeof defaultBranch !== "string" || !defaultBranch.trim()) throw new Error("仓库没有可用的默认分支");
    const pulls = await reader.listOpenPullRequests(owner, repo, defaultBranch);
    for (const pull of pulls) await classify({ ...args, "scan-all": "false", "pull-request-number": String(pull.number), "event-head-sha": pull.head.sha, "delivery-id": `${required(args, "delivery-id")}:pr-${pull.number}` });
    await summary([`仓库：${repository.full_name}`, `重新分类开放拉取请求：${pulls.length}`]);
    return;
  }
  if (args["scan-all"] && args["scan-all"] !== "false") throw new Error("scan-all只能是true或false");
  const number = integer(required(args, "pull-request-number"), "pull-request-number");
  const expectedHead = sha(required(args, "event-head-sha"), "event-head-sha");
  const discovery = await client(repositoryId, { metadata: "read" }, policySha);
  const repository = await discovery.getRepositoryById(repositoryId); const [owner, repo] = splitRepository(repository.full_name);
  const cfg = configurationFor(await catalog(), repository);
  if (!cfg.managed) throw new Error("仓库没有启用中央分类");
  const repositoryClassification = cfg.classification as RepositoryClassification;
  const semantics = await semanticCatalog();
  const profile = await json<ClassificationProfile>(configPath("profiles", "classification", `${repositoryClassification.profile}.json`));
  const stateCodec = classificationCheckStateCodec(semantics, profile);
  const gh = await client(repositoryId, classificationInstallationPermissions(repositoryClassification.labelAssignmentMode), policySha);
  const { matching: same, unbound } = classificationChecksForPull(await gh.listAllCheckRuns(owner, repo, expectedHead, "all"),
    { repositoryId, pullRequestNumber: number, headSha: expectedHead });
  if (unbound.length) throw new Error("同名分类检查缺少可信归属");
  if (same.length > 1) throw new Error("同名分类检查存在歧义");
  const decodedPreviousState = same[0]?.status === "completed" && same[0]?.conclusion === "success" ? decodeClassificationCheckState(same[0]?.external_id, stateCodec) : null;
  if (decodedPreviousState && (decodedPreviousState.repositoryId !== repositoryId || decodedPreviousState.pullRequestNumber !== number || decodedPreviousState.headSha !== expectedHead)) throw new Error("同名分类检查绑定了不同拉取请求上下文");
  const previousState = decodedPreviousState;
  const started = { name: "PR Classification Gate", head_sha: expectedHead, status: "in_progress", external_id: `${repositoryId}:${number}:${expectedHead}:pending`, output: { title: "正在计算拉取请求分类", summary: `来源提交：${expectedHead}\n中央规则：${policySha}` } };
  const check = same[0]
    ? await gh.updateCheckRun(owner, repo, same[0].id, { name: started.name, status: started.status, external_id: started.external_id, output: started.output })
    : await gh.createCheckRun(owner, repo, started);
  try {
    const pull = await gh.getPullRequest(owner, repo, number);
    if (pull.head.sha !== expectedHead) throw new Error("拉取请求来源提交已经漂移");
    const [files, commits, labels, repositoryLabels] = await Promise.all([
      gh.listPullFiles(owner, repo, number), gh.listPullCommits(owner, repo, number), gh.listLabels(owner, repo, number), gh.listRepositoryLabels(owner, repo),
    ]);
    if (!files.length || !commits.length || Number(pull.changed_files) !== files.length || Number(pull.commits) !== commits.length) throw new Error("pagination-incomplete");
    const currentLabels = labels.map((value: any) => String(value.name));
    const rawFacts = classificationFacts(repositoryId, number, pull, files, commits);
    const policy = classificationDigests(semantics, profile, repositoryClassification);
    const inputDigest = classificationInputDigest(rawFacts, policySha, policy.classificationPolicyDigest);
    const reusablePreviousState = previousState?.policy === policy.classificationPolicyDigest
      && previousState.policySha === policySha
      && previousState.inputDigest === inputDigest
      && previousState.mode === repositoryClassification.ai.mode
      ? previousState
      : null;
    const priorOwnership = reusablePreviousState
      ? { stewardOwnedRiskFlags: reusablePreviousState.ownedRiskFlags, stewardOwnedFacets: reusablePreviousState.facets }
      : { stewardOwnedRiskFlags: [], stewardOwnedFacets: [] };
    const existing = { currentLabels, ...priorOwnership };
    let aiAssessment: AiClassificationAssessment;
    if (process.env.AI_CLASSIFICATION) {
      let decoded: unknown;
      try {
        decoded = decodeAiClassificationPayload(process.env.AI_CLASSIFICATION);
        aiAssessment = verifyAiClassificationEnvelope(decoded, {
          trustedSource: isTrustedAiClassificationSource(policySha),
          catalog: semantics,
          profile,
          repository: repositoryClassification,
          facts: rawFacts,
          policySha,
          digests: policy,
        });
      } catch {
        aiAssessment = { state: "invalid", status: "rejected", reasonCode: "primary-ai-invalid-payload", suggestion: null, verifiedSuggestion: null };
      }
    } else {
      aiAssessment = reusedAiClassificationAssessment(reusablePreviousState)
        ?? { state: "missing", status: "absent", reasonCode: "primary-ai-missing", suggestion: null, verifiedSuggestion: null };
    }
    const result = classifyPullRequest(semantics, profile, repositoryClassification, rawFacts, existing, aiAssessment);
    const labelPlan = planClassificationLabels(semantics, profile, existing, result);
    const definitionPlan = planLabelDefinitions(semantics, profile, repositoryLabels.map((value: any) => ({ name: String(value.name), color: String(value.color), description: value.description == null ? null : String(value.description) })));
    let actualLabels = [...currentLabels].sort();
    if (repositoryClassification.labelAssignmentMode === "enforce") {
      if (repositoryClassification.labelDefinitionMode !== "enforce" || definitionPlan.status !== "in-sync") throw new Error("label-definitions-not-ready");
      const currentBeforeWrite = await gh.getPullRequest(owner, repo, number);
      if (currentBeforeWrite.head.sha !== expectedHead || currentBeforeWrite.base.sha !== pull.base.sha) throw new Error("分类输入在写入期间已经漂移（写入前）");
      if (labelPlan.add.length) await gh.addLabels(owner, repo, number, labelPlan.add);
      for (const label of labelPlan.remove) await gh.removeLabel(owner, repo, number, label);
      const afterLabels = (await gh.listLabels(owner, repo, number)).map((value: any) => String(value.name)).sort();
      actualLabels = afterLabels;
      const expectedLabels = [...new Set([...currentLabels.filter((label: string) => !labelPlan.remove.includes(label)), ...labelPlan.add])].sort();
      const afterSet = new Set(afterLabels);
      const exclusiveLabels = new Set(semantics.roles.primaryKind.definitions.flatMap(value => value.githubLabel ? [value.githubLabel.name] : []));
      for (const area of profile.areas) {
        const label = semantics.roles.areas.definitions.find(value => value.id === area.area)?.githubLabel?.name;
        if (label) exclusiveLabels.add(label);
      }
      const unexpectedExclusive = afterLabels.some(label => !expectedLabels.includes(label) && exclusiveLabels.has(label));
      if (expectedLabels.some(label => !afterSet.has(label)) || labelPlan.remove.some(label => afterSet.has(label)) || unexpectedExclusive) throw new Error("post-write-mismatch");
    }
    const currentAfterWrite = await gh.getPullRequest(owner, repo, number);
    if (currentAfterWrite.head.sha !== expectedHead || currentAfterWrite.base.sha !== pull.base.sha || currentAfterWrite.title !== pull.title || (currentAfterWrite.body ?? "") !== (pull.body ?? "")) throw new Error("分类输入在写入期间已经漂移（写入后）");
    const contributors = commits.map((commit: any) => commit.author ? normalizeContributor({ ...commit.author, name: commit.commit?.author?.name, email: commit.commit?.author?.email, avatarUrl: commit.author.avatar_url }) : null).filter(Boolean) as Contributor[];
    const decisionDigest = digest(result);
    const resultAi = result.ai!;
    const state = encodeClassificationCheckState({
      v: 4,
      repositoryId,
      pullRequestNumber: number,
      headSha: expectedHead,
      inputDigest,
      policy: policy.classificationPolicyDigest,
      policySha,
      mode: repositoryClassification.ai.mode,
      primary: result.primaryKind,
      ...(result.primaryKind.source === "ai" ? { acceptedAiPrimaryKind: result.primaryKind.id } : {}),
      ownedRiskFlags: labelPlan.ownedRiskFlags,
      riskFlags: [...new Set(result.riskFlags.map(value => value.id))],
      facets: labelPlan.ownedFacets,
      areas: result.areas.map(value => value.id),
      decisionDigest,
    }, stateCodec);
    const checkSummary = `主类：${result.primaryKind.id}（${result.primaryKind.source} / ${result.primaryKind.reasonCode}）\n主类硬规则：${result.primaryKind.hardRuleId ?? "无"}\n风险：${result.riskFlags.map(value => `${value.id}(${value.source})`).join("、") || "无"}\nFacet：${result.facets.map(value => `${value.id}(${value.source})`).join("、") || "无"}\n区域：${result.areas.map(value => `${value.id}(${value.source})`).join("、") || "无"}\nAI字段状态：${resultAi.state}\nAI处理状态：${resultAi.status}\nAI原因：${resultAi.reasonCode}\nAI建议：${resultAi.suggestion ? `${resultAi.suggestion.primaryKind}（${resultAi.suggestion.confidence}）` : "未提供"}\nAI证据：${renderAiClassificationEvidence(resultAi.suggestion)}\nAI复用：${resultAi.status === "reused" ? "是" : "否"}\nwouldPrimary：${resultAi.wouldPrimary ?? "无"}\n物理定义模式：${repositoryClassification.labelDefinitionMode}（${definitionPlan.status}）\nPR分配模式：${repositoryClassification.labelAssignmentMode}\nAI模式：${repositoryClassification.ai.mode}\n实际PR标签：${actualLabels.join("、") || "无"}\n目标添加：${labelPlan.add.join("、") || "无"}\n目标删除：${labelPlan.remove.join("、") || "无"}\nSteward风险所有权：${labelPlan.ownedRiskFlags.join("、") || "无"}\nSteward Facet所有权：${labelPlan.ownedFacets.join("、") || "无"}\n目录摘要：${policy.catalogDigest}\n配置摘要：${policy.profileDigest}\n仓库摘要：${policy.repositoryClassificationDigest}\n策略摘要：${policy.classificationPolicyDigest}\n输入摘要：${inputDigest}\n决策摘要：${decisionDigest}`;
    await gh.updateCheckRun(owner, repo, check.id, { name: "PR Classification Gate", status: "completed", conclusion: "success", external_id: state, output: { title: "拉取请求分类完成", summary: checkSummary } });
    await summary([`拉取请求：#${number}`, `来源提交：${expectedHead}`, ...checkSummary.split("\n")]);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 60_000);
    await gh.updateCheckRun(owner, repo, check.id, { name: "PR Classification Gate", status: "completed", conclusion: "failure", external_id: `${repositoryId}:${number}:${expectedHead}:failure`, output: { title: "拉取请求分类失败", summary: message } });
    await summary([`拉取请求：#${number}`, `来源提交：${expectedHead}`, "状态：failure", `原因：${message}`]);
    throw error;
  }
}

async function managedTargets(policySha: string, selectedId?: number): Promise<ManagedTarget[]> {
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), permissions: { metadata: "read" }, policySha });
  const repositories = await new GitHubClient(token, "https://api.github.com", fetch, policySha).listInstallationRepositories();
  return managedRepositoryTargets(await catalog(), repositories, selectedId);
}
async function listManagedRepositoryIds(args: Readonly<Record<string, string>>) {
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  process.stdout.write(`${managedRepositoryIds(await managedTargets(policySha)).join("\n")}\n`);
}
async function assertManualSyncAuthorization(policySha: string): Promise<void> {
  if (process.env.SYNC_TRIGGER !== "workflow_dispatch") return;
  integer(env("TRIGGER_ACTOR_ID"), "TRIGGER_ACTOR_ID");
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), permissions: { metadata: "read", members: "read" }, policySha });
  const membership = await new GitHubClient(token, "https://api.github.com", fetch, policySha).getTeamMembership("splrad", "maintainers", env("TRIGGER_ACTOR_LOGIN"));
  if (membership.state !== "active") throw new Error("手工同步触发者不是Maintainers当前成员");
}
async function syncReviewInstructions(args: Readonly<Record<string, string>>) {
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  await assertManualSyncAuthorization(policySha);
  const targets = await managedTargets(policySha, args["repository-id"] ? integer(args["repository-id"], "repository-id") : undefined);
  const results = await runManagedRepositorySync(targets, async ({ repository, configuration }) => {
    const instructions = await loadReviewInstructions(configuration.reviewInstructionsProfile, { profiles: configPath("review", "profiles.json"), rules: configPath("review", "rules.json") });
    const { token, client: gh } = await clientWithToken(repository.id, reviewInstructionSyncInstallationPermissions(), policySha);
    const owner = String(configuration.reviewGovernance?.owner ?? "splrad/maintainers");
    const [ownerOrganization, ownerTeam] = owner.split("/");
    if (ownerOrganization !== "splrad" || !ownerTeam) throw new Error("审查治理owner无效");
    const teams = await gh.listRepositoryTeams(...splitRepository(repository.full_name));
    if (!teams.some((team: any) => team.slug === ownerTeam && ["maintain", "admin"].includes(team.permission))) throw new Error(`${owner}没有目标仓库的maintain或admin权限`);
    const result = await reconcileManagedFiles({ repository, gh, token, instructions, branch: "steward/review-instructions", title: "chore(review): 同步代码审查说明", policySha, deliveryId: `review-sync:${policySha}:${repository.id}`,
      redrive: { workflow: "sync-review-instructions.yml", inputs: { repositoryId: String(repository.id) } } });
    await summary([`仓库：${repository.full_name}`, `profile：${instructions.profile}`, `状态：${result}`, ...instructions.files.map(file => `${file.path}：${file.ruleIds.join("、")}；${file.digest}`)]);
    return result;
  });
  for (const value of results.filter(item => item.status === "ignored")) await summary([`仓库：${value.target.repository.full_name}`, `登记来源：${value.target.registration}`, "状态：ignored"]);
  const failures = results.filter(value => value.error);
  if (failures.length) throw new Error(`审查说明同步失败: ${failures.map(value => value.target.repository.full_name).join("、")}`);
}
async function syncManagedLabels(args: Readonly<Record<string, string>>) {
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  await assertManualSyncAuthorization(policySha);
  const semantics = await semanticCatalog();
  const targets = await managedTargets(policySha, args["repository-id"] ? integer(args["repository-id"], "repository-id") : undefined);
  const results = await runManagedRepositorySync(targets, async ({ repository, configuration, registration }) => {
    const classification = configuration.classification as RepositoryClassification;
    const profile = await json<ClassificationProfile>(configPath("profiles", "classification", `${classification.profile}.json`));
    const gh = await client(repository.id, { metadata: "read", issues: classification.labelDefinitionMode === "enforce" ? "write" : "read" }, policySha);
    const actual = (await gh.listRepositoryLabels(...splitRepository(repository.full_name))).map((value: any) => ({ name: String(value.name), color: String(value.color), description: value.description == null ? null : String(value.description) }));
    let plan = planLabelDefinitions(semantics, profile, actual);
    if (classification.labelDefinitionMode === "enforce") {
      if (plan.conflicts.length) throw new Error("managed-label-conflict");
      const [owner, repo] = splitRepository(repository.full_name);
      for (const item of plan.missing) await gh.createLabel(owner, repo, { name: item.name, color: item.color, description: item.description });
      for (const item of plan.metadataDrift) await gh.updateLabel(owner, repo, item.desired.name, { new_name: item.desired.name, color: item.desired.color, description: item.desired.description });
      const readback = (await gh.listRepositoryLabels(owner, repo)).map((value: any) => ({ name: String(value.name), color: String(value.color), description: value.description == null ? null : String(value.description) }));
      plan = planLabelDefinitions(semantics, profile, readback);
      if (plan.status !== "in-sync") throw new Error("post-write-mismatch");
    }
    const reportedStatus = registration !== "explicit" && plan.missing.length === plan.desired.length ? "pending-label-activation" : plan.status;
    await summary([`仓库：${repository.full_name}`, `登记来源：${registration}`, `物理定义模式：${classification.labelDefinitionMode}`, `PR分配模式：${classification.labelAssignmentMode}`, `AI模式：${classification.ai.mode}`, `状态：${reportedStatus}`, `缺失：${plan.missing.length}`, `元数据漂移：${plan.metadataDrift.length}`, `冲突：${plan.conflicts.length}`, `Legacy：${plan.legacy.length}`, `定义摘要：${plan.desiredDigest}`, `实际摘要：${plan.actualDigest}`]);
    return reportedStatus;
  });
  for (const value of results.filter(item => item.status === "ignored")) await summary([`仓库：${value.target.repository.full_name}`, `登记来源：${value.target.registration}`, "状态：ignored"]);
  const failures = results.filter(value => value.error);
  if (failures.length) throw new Error(`受管标签同步失败: ${failures.map(value => value.target.repository.full_name).join("、")}`);
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(root)) {
    if ([".git", ".runner-build", ".runner-dist-verify", "node_modules"].includes(name)) continue;
    const path = join(root, name);
    (await stat(path)).isDirectory() ? out.push(...await walk(path)) : out.push(path);
  }
  return out;
}
function run(command: string, args: string[], cwd: string) {
  const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const value = spawnSync(executable, args, { cwd, shell: false, encoding: "utf8" });
  if (value.status !== 0) throw new Error((value.stderr || value.stdout || `${command}失败`).trim());
  return (value.stdout || "").trim();
}

export function gitDiffCheckArguments(base?: string): string[] {
  return [
    "-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol",
    "diff", "--check", ...(base ? [`${base}...HEAD`] : []),
  ];
}

export function assertFreshValidationBase(workspace: string, eventBaseSha: string, baseRef: string): string {
  const expectedBase = sha(eventBaseSha, "VALIDATION_BASE_SHA");
  try {
    run("git", ["check-ref-format", "--branch", baseRef], workspace);
  } catch {
    throw new Error("基础分支引用无效");
  }
  let currentBase: string;
  try {
    currentBase = sha(run("git", ["rev-parse", "--verify", `refs/remotes/origin/${baseRef}^{commit}`], workspace), "当前基础分支提交");
  } catch {
    throw new Error(`无法解析当前基础分支：${baseRef}`);
  }
  if (currentBase !== expectedBase) {
    throw new Error(`基础分支已更新；当前运行基于${expectedBase}，${baseRef}现为${currentBase}，请更新拉取请求分支后重新验证`);
  }
  return currentBase;
}

export async function throwFreshValidationBaseFailure(error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : "基础分支新鲜度检查失败";
  try {
    await summary(["# SPLRAD Steward / PR Validation", "", `- ❌ verify-base-freshness: ${message}`]);
  } catch {
    // 摘要仅用于诊断，写入失败不能覆盖实际的基础分支校验错误。
  }
  throw error;
}

export function matchesGeneratedReviewInstructions(actual: string, generated: string): boolean {
  const normalizeCheckoutLineEndings = (value: string) => value.replace(/\r\n/gu, "\n");
  return normalizeCheckoutLineEndings(actual) === normalizeCheckoutLineEndings(generated);
}

export function reviewRegistryPaths(_repositoryId: number, _workspace: string): { profiles: string; rules: string } {
  const root = configPath("review");
  return { profiles: join(root, "profiles.json"), rules: join(root, "rules.json") };
}

async function validationProfileCommand(args: Readonly<Record<string, string>>) {
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  if (!['true', 'false'].includes(required(args, "private"))) throw new Error("仓库可见性无效");
  const trusted = await catalog();
  const configuration = trusted.repositories[String(repositoryId)] ?? (args.private === 'false' ? trusted.defaults.public : null);
  if (!configuration?.managed) throw new Error("仓库没有启用中央验证");
  const name = selectValidationProfile(repositoryId, { repositories: trusted.repositories, defaultPublicProfile: trusted.defaults.public.validationProfile }, args.private === 'true');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("验证配置名称无效");
  await output({ name });
}

async function validate(args: Readonly<Record<string, string>>) {
  const workflowContractReadToken = process.env.WORKFLOW_CONTRACT_READ_TOKEN;
  delete process.env.WORKFLOW_CONTRACT_READ_TOKEN;
  const workspace = resolve(required(args, "workspace"));
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const catalogValue = await catalog();
  const configuration = catalogValue.repositories[String(repositoryId)] ?? catalogValue.defaults.public;
  if (!configuration?.managed) throw new Error("仓库没有启用中央验证");
  const profileName = required(args, "profile");
  if (profileName !== configuration.validationProfile) throw new Error("验证配置与中央仓库目录不一致");
  const profile = await json<ValidationProfile>(configPath("profiles", "validation", `${profileName}.json`));
  const validationBaseSha = process.env.VALIDATION_BASE_SHA;
  const validationBaseRef = process.env.VALIDATION_BASE_REF;
  if (Boolean(validationBaseSha) !== Boolean(validationBaseRef)) throw new Error("基础分支验证参数不完整");
  if (validationBaseSha && validationBaseRef) {
    try {
      assertFreshValidationBase(workspace, validationBaseSha, validationBaseRef);
    } catch (error) {
      await throwFreshValidationBaseFailure(error);
    }
  }
  const files = await walk(workspace);
  const relative = files.map(path => path.slice(workspace.length + 1).replace(/\\/g, "/"));
  const actualWorkflows = relative.filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)).sort();
  const localContract = await readWorkflowContract(workspace);
  const authority = selectContractAuthority(await json(configPath("workflow-contract-authority.json")), repositoryId);
  let approvedContract;
  if (workflowContractReadToken && !authority && configuration.allowedWorkflowPaths.includes(".github/workflows/pr-validation.yml")) throw new Error("CONTRACT_AUTHORITY_REQUIRED: activate the reviewed repository authority before the v2 entry");
  if (authority) {
    if (!workflowContractReadToken) throw new Error("CONTRACT_TOKEN: trusted read token missing");
    const contractToken = workflowContractReadToken;
    // The read token is consumed before any candidate task starts.
    delete process.env.WORKFLOW_CONTRACT_READ_TOKEN;
    const policySha = sha(env("VALIDATION_POLICY_SHA"), "VALIDATION_POLICY_SHA");
    const result = await evaluateRemoteWorkflowContract(new GitHubClient(contractToken, "https://api.github.com", fetch, policySha),
      authority, integer(env("VALIDATION_PR_NUMBER"), "VALIDATION_PR_NUMBER"), policySha);
    if (result.binding.headSha !== sha(env("VALIDATION_HEAD_SHA"), "VALIDATION_HEAD_SHA")
      || result.binding.baseSha !== sha(env("VALIDATION_BASE_SHA"), "VALIDATION_BASE_SHA")
      || contractDigest(localContract ?? authority.baseline) !== result.binding.contractDigest) throw new Error("CONTRACT_SOURCE_STALE: checkout binding mismatch");
    if (result.contract.fragments === "required") throw new Error("CONTRACT_CAPABILITY_UNAVAILABLE: this evaluator requires explicit fragment retirement; retain the legacy evaluator until migration is approved");
    approvedContract = result.contract;
    await summary([`Workflow contract: ${result.binding.contractDigest}`, `Contract approval: ${result.reviewId ?? "trusted baseline"}`]);
  } else if (localContract) throw new Error("CONTRACT_AUTHORITY_REQUIRED: repository not activated in trusted policy");
  await verifyWorkflowPolicy(workspace, repositoryId, configuration.allowedWorkflowPaths.filter((path: string) => path === ".github/workflows/pr-validation.yml"), approvedContract);
  const results = await runValidationTasks(profile, async task => {
    if (task === "git-diff-check") {
      run("git", gitDiffCheckArguments(validationBaseSha ? sha(validationBaseSha, "VALIDATION_BASE_SHA") : undefined), workspace);
      return { state: "success" as const, detail: "未发现空白错误" };
    }
    if (task === "parse-json") { for (const file of files.filter(path => path.endsWith(".json"))) JSON.parse(await runtimeReadFile(file, "utf8")); return { state: "success" as const, detail: "JSON有效" }; }
    if (task === "parse-yaml") { for (const file of files.filter(path => /\.ya?ml$/.test(path))) YAML.parse(await runtimeReadFile(file, "utf8")); return { state: "success" as const, detail: "YAML有效" }; }
    if (task === "verify-review-instructions") {
      const instructions = await loadReviewInstructions(configuration.reviewInstructionsProfile, reviewRegistryPaths(repositoryId, workspace));
      const current = Object.fromEntries(await Promise.all([...instructions.files, ...(instructions.retiredFiles ?? [])].map(async expected => {
        const parts = expected.path.split("/");
        let file = workspace;
        for (const [index, part] of parts.entries()) {
          file = join(file, part);
          let metadata;
          try { metadata = await lstat(file); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [expected.path, null];
            throw error;
          }
          if (index < parts.length - 1 ? !metadata.isDirectory() : !metadata.isFile()) throw new Error("审查说明路径类型无效: " + expected.path);
        }
        return [expected.path, await runtimeReadFile(file, "utf8")];
      })));
      validateReviewInstructionContents(current, instructions);
      return { state: "success" as const, detail: "审查说明载体与中央配置一致" };
    }
    if (task === "actionlint-if-present") return { state: actualWorkflows.length ? "success" as const : "not-applicable" as const, detail: actualWorkflows.length ? "工作流属于中央允许范围" : "未配置本地工作流" };
    if (task === "actionlint") return { state: "success" as const, detail: "工作流由中央校验脚本验证" };
    if (task === "parse-powershell") {
      const selected = [...new Set((profile.powershellFiles ?? []).flatMap(pattern => relative.filter(path => minimatch(path, pattern, { dot: true }))))];
      if (!selected.length) throw new Error("没有命中需要解析的PowerShell文件");
      for (const path of selected) { const escaped = join(workspace, path).replace(/'/g, "''"); run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) > $null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`], workspace); }
      return { state: "success" as const, detail: `已解析${selected.length}个PowerShell文件` };
    }
    if (task === "parse-msbuild-xml") {
      const patterns = profile.msbuildFiles ?? [];
      if (patterns.some(pattern => !relative.some(path => minimatch(path, pattern, { dot: true })))) throw new Error("一个或多个MSBuild文件模式没有命中");
      const selected = [...new Set(patterns.flatMap(pattern => relative.filter(path => minimatch(path, pattern, { dot: true }))))];
      for (const path of selected) { const escaped = join(workspace, path).replace(/'/g, "''"); run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `try { [xml](Get-Content -LiteralPath '${escaped}' -Raw) > $null } catch { Write-Error $_; exit 1 }`], workspace); }
      return { state: "success" as const, detail: `已解析${selected.length}个MSBuild XML文件` };
    }
    const npmMap: Record<string, string[]> = { "npm-ci": ["ci", "--ignore-scripts"], "npm-test": ["test"], "npm-typecheck": ["run", "typecheck"], "npm-verify-dist": ["run", "verify:dist"], "npm-verify-workflows": ["run", "verify:workflows"] };
    if (npmMap[task]) { run("npm", npmMap[task]!, workspace); return { state: "success" as const, detail: `${task}成功` }; }
    throw new Error(`未实现验证任务: ${task}`);
  });
  const rendered = renderValidationSummary(profile, results);
  await summary(rendered.trimEnd().split("\n"));
  if (results.some(result => result.state === "failure")) throw new Error("一个或多个验证任务失败");
}

async function releaseFreezeCommand(args: Readonly<Record<string, string>>): Promise<void> {
  let boundary: GitReleaseBoundary;
  if (args["full-tree"] !== undefined) {
    if (args["full-tree"] !== "true" || args["boundary-sha"] || args["boundary-tag"] || args["baseline-reference"]) throw new Error("首次发布完整树与区间边界不能混用");
    boundary = { kind: "full-tree" };
  } else {
    if (Boolean(args["boundary-tag"]) === Boolean(args["baseline-reference"])) throw new Error("必须选择一个已核验标签或明确基线");
    boundary = { kind: args["boundary-tag"] ? "tag" : "baseline", sha: sha(required(args, "boundary-sha"), "boundary-sha"), reference: args["boundary-tag"] ?? args["baseline-reference"]! };
  }
  const source = freezeReleaseGitInput({ workspace: required(args, "workspace"),
    identity: { repositoryId: integer(required(args, "repository-id"), "repository-id"), defaultBranch: required(args, "default-branch"),
      targetSha: sha(required(args, "target-sha"), "target-sha"), policySha: sha(required(args, "policy-sha"), "policy-sha") },
    targetTag: required(args, "target-tag"), boundary });
  const outputPath = resolve(required(args, "output"));
  try { await writeFile(outputPath, source.bytes, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await runtimeReadFile(outputPath, "utf8") !== source.bytes) throw new Error("输出已存在且内容不同，请指定新文件");
  }
  await summary([`Git 来源：${outputPath}`, `来源摘要：${source.inputSha256}`, `完整提交：${source.input.coverage.commits}`,
    `净差异文件：${source.input.coverage.changedFiles}`, `读取缺口：${source.input.gaps.length}`]);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const invocation = parseInvocation(argv);
  if (invocation.command === "trusted-policy-source") return trustedPolicyCommand();
  if (invocation.command === "release-candidate") return releaseCandidateCommand(invocation.args);
  if (invocation.command === "verify-workflow-activation") {
    const evaluator = env("WORKFLOW_EVALUATOR_SHA");
    return verifyWorkflowActivation(new GitHubClient(env("WORKFLOW_ACTIVATION_READ_TOKEN")), evaluator, await catalog());
  }
  if (invocation.command === "release-produce") return releaseProduceCommand(invocation.args);
  if (invocation.command === "release-build") return releaseBuildCommand(invocation.args);
  if (invocation.command === "release-freeze") return releaseFreezeCommand(invocation.args);
  if (invocation.command === "observe-copilot-review") return observeCopilotReviewCommand(invocation.args);
  if (invocation.command === "render-review-instructions") return renderReviewInstructionsCommand(invocation.args);
  if (invocation.command === "request-copilot-review") return requestCopilotReviewCommand(invocation.args);
  if (invocation.command === "review-trigger-mode") return reviewTriggerModeCommand(invocation.args);
  if (invocation.command === "review-sync-targets") return reviewSyncTargetsCommand(invocation.args);
  const handlers: Record<string, (args: Readonly<Record<string, string>>) => Promise<void>> = { "validation-profile": validationProfileCommand, "managed-repository-ids": listManagedRepositoryIds, "onboard-repository": onboard, "pr-classification": classify, "sync-review-instructions": syncReviewInstructions, "sync-managed-labels": syncManagedLabels, validate };
  await handlers[invocation.command]!(invocation.args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
