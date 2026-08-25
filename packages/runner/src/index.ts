#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildAiDiffObservation, buildCopilotRepairPrompt, buildDeterministicSummary, buildPrompt, classifyPullRequest, classificationDigests, classificationInputDigest, computePullRequestFingerprint, createAiClassificationEnvelope, digest,
  categorizeReleasePullRequests, classifyRemoteReleaseState, collectReleasePullRequests,
  escapeMarkdownText,
  isHumanActor, isIssueCapableRepository, normalizeContributor,
  organizationPullRequestTemplate,
  copilotInstructionSyncContract, parseVersion, planClassificationLabels, planLabelDefinitions, planRelease, planRepositorySettings, renderCopilotInstructions, renderManagedBody,
  renderOnboardingPullRequest, renderReleaseNotes, renderValidationSummary, runValidationTasks,
  inspectAiClassificationField, validateGeneratedSummary, validateRepositoryForOnboarding, verifyAiClassificationEnvelope, verifyAssetManifest,
  type AiClassificationAssessment, type AiClassificationEnvelopeV2, type AiClassificationFieldInspection, type AiClassificationSuggestion, type AutomationFacts, type ClassificationProfile, type ClassifiedReleasePullRequest, type Contributor, type RawClassificationFacts, type ReleaseManifest, type RepositoryClassification, type SemanticCatalog, type ValidationProfile,
} from "../../core/src/index.js";
import { createInstallationToken, dispatchWorkflow, GitHubClient, GitHubRequestError, uploadReleaseAsset } from "../../github/src/index.js";
import { managedRepositoryIds, managedRepositoryTargets, runManagedRepositorySync, type ManagedTarget } from "./managed-repository-sync.js";
import { runPrIssueLink } from "./pr-issue-link.js";
import { targetManagedBlock, updatePullRequestBodyDurably, type DurableBodyRedrive } from "./pr-body-writer.js";
import { minimatch } from "minimatch";
import YAML from "yaml";

const commands = new Set(["issue-sync", "managed-repository-ids", "reconcile-repository-lifecycle", "onboard-repository", "pr-automation", "pr-classification", "pr-issue-link", "sync-copilot-instructions", "sync-managed-labels", "validate", "release-preflight", "release-notes", "release-publish", "release-verify"]);
const stewardRepositoryId = 1296724484;
// Repository configuration and workspace files are runtime inputs, not bundle assets.
// This wrapper keeps their paths opaque to the static asset tracer used by ncc.
const runtimeReadFile = ((path: Parameters<typeof readFile>[0], options?: Parameters<typeof readFile>[1]) =>
  Reflect.apply(readFile, undefined, options === undefined ? [path] : [path, options])) as typeof readFile;
const allowedArguments: Record<string, Set<string>> = {
  "issue-sync": new Set(["delivery-id", "repository-id", "issue-number", "scan-all", "policy-sha"]),
  "managed-repository-ids": new Set(["policy-sha"]),
  "reconcile-repository-lifecycle": new Set(["delivery-id", "policy-sha"]),
  "onboard-repository": new Set(["repository-id", "repository-full-name", "trigger", "delivery-id", "policy-sha"]),
  "pr-automation": new Set(["delivery-id", "repository-id", "source-ref", "event-after-sha", "source-actor-id", "source-actor-login", "policy-sha"]),
  "pr-classification": new Set(["delivery-id", "repository-id", "pull-request-number", "event-head-sha", "scan-all", "policy-sha"]),
  "pr-issue-link": new Set(["delivery-id", "repository-id", "pull-request-number", "scan-all", "invalidate-only", "cleanup-unmanaged", "reconciliation-generation", "policy-sha"]),
  "sync-copilot-instructions": new Set(["repository-id", "policy-sha"]),
  "sync-managed-labels": new Set(["repository-id", "policy-sha"]),
  validate: new Set(["workspace", "repository-id", "profile"]),
  "release-preflight": new Set(["workspace", "repository-id", "pull-request-number", "target-sha", "policy-sha", "trigger", "manifest"]),
  "release-notes": new Set(["repository-id", "pull-request-number", "target-sha", "policy-sha", "display-version", "output"]),
  "release-publish": new Set(["manifest", "notes", "repository"]),
  "release-verify": new Set(["manifest", "repository"]),
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
async function client(repositoryId: number, permissions: Parameters<typeof createInstallationToken>[0]["permissions"], policySha: string): Promise<GitHubClient> {
  return (await clientWithToken(repositoryId, permissions, policySha)).client;
}
async function clientWithToken(repositoryId: number, permissions: Parameters<typeof createInstallationToken>[0]["permissions"], policySha: string): Promise<{ token: string; client: GitHubClient }> {
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId, permissions, policySha });
  return { token, client: new GitHubClient(token, "https://api.github.com", fetch, policySha) };
}
async function summary(lines: readonly string[]): Promise<void> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) await writeFile(target, `${lines.join("\n")}\n`, { flag: "a" }); else process.stdout.write(`${lines.join("\n")}\n`);
}
async function output(values: Record<string, string | number>): Promise<void> { const target = process.env.GITHUB_OUTPUT; if (!target) return; await writeFile(target, Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}`).join("\n") + "\n", { flag: "a" }); }

type CopilotFallbackStage = "copilot-step" | "prepared-facts-read" | "prepared-facts-parse" | "prepared-facts-check" | "copilot-output-read" | "copilot-output-envelope" | "copilot-output-parse" | "copilot-output-validate";
const safeGeneratedSummaryValidationMessage = /^(?:Copilot结果必须是对象|Copilot结果包含额外字段|classification字段缺失|type无效|scope无效|title格式无效|changes无效|(?:title|summary|motivation|changes\[\]|impact|impact\[\]|releaseAndMigration|releaseAndMigration\[\])(?:必须是字符串|长度或格式无效|无效))$/u;
const maximumCopilotJsonlBytes = 2_097_152;
const maximumCopilotJsonlLines = 256;
const maximumCopilotContentBytes = 65_536;
// JSON mode emits transport events; the business JSON remains inside the final root message.
export function extractCopilotAssistantContent(value: string): string {
  const size = Buffer.byteLength(value, "utf8");
  if (size === 0 || size > maximumCopilotJsonlBytes) throw new Error("Copilot JSONL输出大小无效");
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maximumCopilotJsonlLines || lines.some(line => line === "" || line === "\r")) throw new Error("Copilot JSONL输出格式无效");
  const events = lines.map(line => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
    } catch {
      throw new Error("Copilot JSONL输出格式无效");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).type !== "string") throw new Error("Copilot JSONL输出格式无效");
    const event = parsed as Record<string, unknown>;
    if (event.agentId !== undefined && typeof event.agentId !== "string") throw new Error("Copilot JSONL输出格式无效");
    return event;
  });
  const results = events.filter(event => event.type === "result");
  if (results.length !== 1 || events.at(-1) !== results[0] || results[0]?.exitCode !== 0) throw new Error("Copilot JSONL结果无效");
  if (events.some(event => event.agentId === undefined && String(event.type).startsWith("tool."))) throw new Error("Copilot JSONL消息无效");
  const rootContents: string[] = [];
  for (const event of events.filter(candidate => candidate.type === "assistant.message")) {
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Copilot JSONL消息无效");
    const message = data as Record<string, unknown>;
    if (message.parentToolCallId !== undefined && typeof message.parentToolCallId !== "string") throw new Error("Copilot JSONL消息无效");
    if (event.agentId !== undefined || message.parentToolCallId !== undefined) continue;
    const toolRequests = message.toolRequests;
    if ((toolRequests !== undefined && (!Array.isArray(toolRequests) || toolRequests.length !== 0)) || message.serverTools !== undefined) throw new Error("Copilot JSONL消息无效");
    if (typeof message.content !== "string") throw new Error("Copilot JSONL消息无效");
    if (message.content.trim()) rootContents.push(message.content);
  }
  const content = rootContents.at(-1);
  if (!content || Buffer.byteLength(content, "utf8") > maximumCopilotContentBytes) throw new Error("Copilot JSONL消息无效");
  return content;
}
export function describeCopilotFallback(stage: CopilotFallbackStage, error: unknown): string {
  if (stage === "copilot-output-parse") {
    const position = error instanceof Error ? /\bposition (\d{1,9})\b/u.exec(error.message)?.[1] : undefined;
    return position ? `Copilot输出不是有效JSON（位置${position}）` : "Copilot输出不是有效JSON";
  }
  if (stage === "copilot-output-validate") {
    const message = error instanceof Error ? error.message : "";
    return safeGeneratedSummaryValidationMessage.test(message) ? `Copilot输出字段校验失败：${message}` : "Copilot输出字段校验失败";
  }
  return {
    "copilot-step": "Copilot命令执行失败",
    "prepared-facts-read": "人工智能输入文件无法读取",
    "prepared-facts-parse": "人工智能输入文件不是有效JSON",
    "prepared-facts-check": "人工智能输入对应的分支事实已经漂移",
    "copilot-output-read": "Copilot输出文件无法读取",
    "copilot-output-envelope": "Copilot输出传输封装无效",
  }[stage];
}

export type CopilotJsonNormalization = "none" | "single-json-fence";

export function normalizeCopilotJsonCandidate(value: string): { candidate: string; normalization: CopilotJsonNormalization } {
  const trimmed = value.trim();
  const lines = trimmed.split(/\r?\n/u);
  if (lines.length >= 3 && /^```json$/iu.test(lines[0] ?? "") && lines.at(-1) === "```" && lines.slice(1, -1).every(line => !line.trimStart().startsWith("```"))) {
    return { candidate: lines.slice(1, -1).join("\n").trim(), normalization: "single-json-fence" };
  }
  return { candidate: trimmed, normalization: "none" };
}

function describeCopilotJsonParseFailure(value: string, normalization: CopilotJsonNormalization, error: unknown): string {
  return normalization === "none" && value.includes("```") ? "Copilot输出JSON代码围栏无效" : describeCopilotFallback("copilot-output-parse", error);
}

export type CopilotGeneratedSummaryInspection =
  | { state: "valid"; generated: ReturnType<typeof validateGeneratedSummary>; classification: AiClassificationFieldInspection; normalization: CopilotJsonNormalization }
  | { state: "repairable"; stage: "copilot-output-parse" | "copilot-output-validate"; reason: string; assistantContent: string; normalization: CopilotJsonNormalization }
  | { state: "rejected"; stage: "copilot-output-envelope"; reason: string };

export function inspectCopilotGeneratedSummary(value: string): CopilotGeneratedSummaryInspection {
  let assistantContent: string;
  try {
    assistantContent = extractCopilotAssistantContent(value);
  } catch (error) {
    return { state: "rejected", stage: "copilot-output-envelope", reason: describeCopilotFallback("copilot-output-envelope", error) };
  }
  const normalized = normalizeCopilotJsonCandidate(assistantContent);
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized.candidate);
  } catch (error) {
    return { state: "repairable", stage: "copilot-output-parse", reason: describeCopilotJsonParseFailure(assistantContent, normalized.normalization, error), assistantContent: normalized.candidate, normalization: normalized.normalization };
  }
  try {
    const generated = validateGeneratedSummary(parsed);
    const classification = inspectAiClassificationField(parsed as Record<string, unknown>);
    return { state: "valid", generated, classification, normalization: normalized.normalization };
  } catch (error) {
    return { state: "repairable", stage: "copilot-output-validate", reason: describeCopilotFallback("copilot-output-validate", error), assistantContent: normalized.candidate, normalization: normalized.normalization };
  }
}

export type CopilotGeneratedSummaryResolution =
  | { state: "adopted"; mode: "copilot" | "copilot-repaired"; generated: ReturnType<typeof validateGeneratedSummary>; classification: AiClassificationFieldInspection; normalization: CopilotJsonNormalization; primaryFailureReason?: string }
  | { state: "repair-required"; primaryFailureReason: string; assistantContent: string }
  | { state: "fallback"; fallbackReason: string; primaryFailureReason?: string; repairFailureReason?: string };

export function resolveCopilotGeneratedSummary(primaryValue: string, repairValue?: string): CopilotGeneratedSummaryResolution {
  const primary = inspectCopilotGeneratedSummary(primaryValue);
  if (primary.state === "valid") return { state: "adopted", mode: "copilot", generated: primary.generated, classification: primary.classification, normalization: primary.normalization };
  if (primary.state === "rejected") return { state: "fallback", fallbackReason: primary.reason };
  if (repairValue === undefined) return { state: "repair-required", primaryFailureReason: primary.reason, assistantContent: primary.assistantContent };
  const repair = inspectCopilotGeneratedSummary(repairValue);
  if (repair.state === "valid") return { state: "adopted", mode: "copilot-repaired", generated: repair.generated, classification: repair.classification, normalization: repair.normalization, primaryFailureReason: primary.reason };
  return {
    state: "fallback",
    fallbackReason: primary.reason,
    primaryFailureReason: primary.reason,
    repairFailureReason: repair.reason.replace(/^Copilot输出/u, "Copilot修复输出"),
  };
}

export function assertPreparedCopilotFacts(prepared: unknown, expected: { repositoryId: number; sourceRef: string; headSha: string; baseSha: string; policySha: string }): void {
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) throw new Error("人工智能输入对应的分支事实已经漂移");
  const value = prepared as Record<string, unknown>;
  if (value.repositoryId !== expected.repositoryId || value.sourceRef !== expected.sourceRef || value.headSha !== expected.headSha || value.baseSha !== expected.baseSha || value.policySha !== expected.policySha) throw new Error("人工智能输入对应的分支事实已经漂移");
}

export function describeCopilotRepairAvailability(outcome: string | undefined, outputPath: string | undefined): string | null {
  if (outcome === "success") return outputPath ? null : "失败（Copilot修复输出路径缺失）";
  if (outcome === undefined || outcome === "") return "未运行（未收到Copilot修复步骤结果）";
  if (outcome === "skipped") return "未运行（Copilot修复步骤已跳过）";
  if (outcome === "cancelled") return "未完成（Copilot修复步骤已取消）";
  if (outcome === "failure") return "失败（Copilot修复命令执行失败）";
  return "未完成（Copilot修复步骤结果无效）";
}

export function describeCopilotRepairOutputFailure(stage: "read" | "envelope"): string {
  return stage === "read" ? "失败（Copilot修复输出文件无法读取）" : "失败（Copilot修复输出传输封装无效）";
}

async function readCopilotOutput(path: string): Promise<{ evidence: string; inspection: CopilotGeneratedSummaryInspection }> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > maximumCopilotJsonlBytes) throw new Error("Copilot JSONL输出大小无效");
  const text = await runtimeReadFile(path, "utf8");
  const evidence = `${Buffer.byteLength(text, "utf8")}字节，SHA-256 ${createHash("sha256").update(text, "utf8").digest("hex")}`;
  return { evidence, inspection: inspectCopilotGeneratedSummary(text) };
}

async function prepareCopilotRepair(): Promise<void> {
  const primary = await readCopilotOutput(env("COPILOT_OUTPUT_PATH"));
  if (primary.inspection.state === "valid") {
    await output({ "repair-required": "false" });
    await summary(["人工智能修复：不需要", ...(primary.inspection.normalization === "single-json-fence" ? ["人工智能JSON规范化：首次输出已剥离单一json代码围栏"] : []), `人工智能首次输出证据：${primary.evidence}`]);
    return;
  }
  if (primary.inspection.state === "rejected") {
    await output({ "repair-required": "false" });
    await summary(["人工智能修复：协议层失败，不允许修复", `人工智能回退原因：${primary.inspection.reason}`, `人工智能首次输出证据：${primary.evidence}`]);
    return;
  }
  const promptPath = env("PR_COPILOT_REPAIR_PROMPT_PATH");
  await writeFile(promptPath, buildCopilotRepairPrompt(primary.inspection.assistantContent, primary.inspection.reason));
  await output({ "repair-required": "true" });
  await summary(["人工智能修复：已准备", `人工智能首次失败原因：${primary.inspection.reason}`, `人工智能首次输出证据：${primary.evidence}`]);
}

interface Catalog { organization: { id: number; login: string }; defaults: { public: any; private: any }; repositories: Record<string, any> }
async function catalog(): Promise<Catalog> { return json(configPath("repositories.json")); }
async function semanticCatalog(): Promise<SemanticCatalog> { return json(configPath("labels", "pr-semantics.json")); }
type CopilotInstructionSourceFile = "common.md" | "layerscape.md";
async function loadCopilotInstructions(profile: unknown, sourcePath: (sourceFile: CopilotInstructionSourceFile) => string): Promise<{ targetPath: string; content: string }> {
  const contract = copilotInstructionSyncContract(profile);
  const sources = await Promise.all(contract.sourceFiles.map((sourceFile) => runtimeReadFile(sourcePath(sourceFile), "utf8")));
  return { targetPath: contract.targetPath, content: renderCopilotInstructions(sources[0]!, sources[1] ?? null) };
}
function configurationFor(catalogValue: Catalog, repository: any): any {
  const override = catalogValue.repositories[String(repository.id)];
  if (override && override.fullName !== repository.full_name) throw new Error("仓库编号与中央目录名称不一致");
  return Object.freeze({ ...(repository.private ? catalogValue.defaults.private : catalogValue.defaults.public), ...(override ?? {}) });
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
export function prepareAiClassificationPayload(
  classificationField: AiClassificationFieldInspection,
  envelope: AiClassificationEnvelopeV2,
): { state: "missing" } | { state: "encoded"; payload: string } | { state: "encoding-failed" } {
  if (classificationField.state === "missing") return { state: "missing" };
  const suggestion = classificationField.state === "valid"
    ? classificationField.suggestion
    : classificationField.state === "abstained"
      ? null
      : { invalid: true };
  try {
    return { state: "encoded", payload: encodeAiClassificationPayload({ ...envelope, suggestion }) };
  } catch {
    return { state: "encoding-failed" };
  }
}
export function inspectAutomationPullRequestBinding(
  pull: { head: { repo: { id: unknown }; ref: unknown; sha: unknown }; base: { ref: unknown; sha: unknown } },
  expected: { repositoryId: number; sourceBranch: string; headSha: string; baseBranch: string; baseSha: string },
): "matched" | "base-sha-drifted" {
  if (Number(pull.head.repo.id) !== expected.repositoryId || pull.head.ref !== expected.sourceBranch || pull.head.sha !== expected.headSha
    || pull.base.ref !== expected.baseBranch) throw new Error("AI分类封装对应的拉取请求事实已经漂移");
  return pull.base.sha === expected.baseSha ? "matched" : "base-sha-drifted";
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
export interface ClassificationCheckStateV3 {
  v: 3;
  repositoryId: number;
  pullRequestNumber: number;
  headSha: string;
  inputDigest: string;
  policy: string;
  mode: RepositoryClassification["ai"]["mode"];
  primary: { id: string; source: "hard-rule" | "ai" | "deterministic-fallback"; reasonCode: string };
  acceptedAiPrimaryKind?: string;
  risks: string[];
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
const classificationCheckStateBodyBytes = 133;
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
export function encodeClassificationCheckState(state: ClassificationCheckStateV3, codec: ClassificationCheckStateCodec): string {
  validateClassificationCheckCodec(codec);
  if (!Number.isSafeInteger(state.repositoryId) || state.repositoryId < 1 || state.repositoryId > 0xffff_ffff
    || !Number.isSafeInteger(state.pullRequestNumber) || state.pullRequestNumber < 1 || state.pullRequestNumber > 0xffff_ffff
    || !/^[0-9a-f]{40}$/u.test(state.headSha) || !/^[0-9a-f]{64}$/u.test(state.inputDigest)
    || !/^[0-9a-f]{64}$/u.test(state.policy) || !/^[0-9a-f]{64}$/u.test(state.decisionDigest)) throw new Error("分类检查状态上下文无效");
  const buffer = Buffer.alloc(classificationCheckStateBytes);
  buffer[0] = 3;
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
  buffer[129] = encodeStateBits(state.risks, codec.riskFlags, "风险");
  buffer[130] = encodeStateBits(state.facets, codec.facets, "Facet");
  buffer[131] = encodeStateBits(state.areas, codec.areas, "区域");
  buffer[132] = state.acceptedAiPrimaryKind === undefined ? 255 : encodeStateIndex(state.acceptedAiPrimaryKind, codec.primaryKinds, "已采用AI主类");
  if (state.acceptedAiPrimaryKind !== undefined && (state.primary.source !== "ai" || state.primary.id !== state.acceptedAiPrimaryKind || !["primary-ai-accepted", "primary-ai-reused"].includes(state.primary.reasonCode))) throw new Error("分类检查状态的AI主类不一致");
  createHash("sha256").update(buffer.subarray(0, classificationCheckStateBodyBytes)).digest().copy(buffer, classificationCheckStateBodyBytes);
  return `v3:${buffer.toString("base64url")}`;
}
export function decodeClassificationCheckState(value: unknown, codec: ClassificationCheckStateCodec, expected?: { repositoryId: number; pullRequestNumber: number; headSha: string }): ClassificationCheckStateV3 | null {
  try { validateClassificationCheckCodec(codec); } catch { return null; }
  if (typeof value !== "string" || !value.startsWith("v3:")) return null;
  const encoded = value.slice(3);
  if (encoded.length !== classificationCheckStateEncodedLength || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== classificationCheckStateBytes || decoded.toString("base64url") !== encoded || decoded[0] !== 3) return null;
  const checksum = createHash("sha256").update(decoded.subarray(0, classificationCheckStateBodyBytes)).digest();
  if (!checksum.equals(decoded.subarray(classificationCheckStateBodyBytes))) return null;
  const repositoryId = decoded.readUInt32BE(1);
  const pullRequestNumber = decoded.readUInt32BE(5);
  const headSha = decoded.subarray(9, 29).toString("hex");
  if (!repositoryId || !pullRequestNumber || (expected && (repositoryId !== expected.repositoryId || pullRequestNumber !== expected.pullRequestNumber || headSha !== expected.headSha))) return null;
  const mode = classificationCheckModes[decoded[125]!];
  const primaryKind = codec.primaryKinds[decoded[126]!];
  const source = classificationCheckSources[decoded[127]!];
  const reasonCode = classificationCheckReasons[decoded[128]!];
  const risks = decodeStateBits(decoded[129]!, codec.riskFlags);
  const facets = decodeStateBits(decoded[130]!, codec.facets);
  const areas = decodeStateBits(decoded[131]!, codec.areas);
  const acceptedAiPrimaryKind = decoded[132] === 255 ? undefined : codec.primaryKinds[decoded[132]!];
  if (!mode || !primaryKind || !source || !reasonCode || !risks || !facets || !areas) return null;
  if (acceptedAiPrimaryKind !== undefined && (source !== "ai" || primaryKind !== acceptedAiPrimaryKind || !["primary-ai-accepted", "primary-ai-reused"].includes(reasonCode))) return null;
  return {
    v: 3, repositoryId, pullRequestNumber, headSha,
    inputDigest: decoded.subarray(29, 61).toString("hex"),
    policy: decoded.subarray(61, 93).toString("hex"),
    mode,
    primary: { id: primaryKind, source, reasonCode },
    ...(acceptedAiPrimaryKind ? { acceptedAiPrimaryKind } : {}),
    risks, facets, areas,
    decisionDigest: decoded.subarray(93, 125).toString("hex"),
  };
}
export function reusedAiClassificationAssessment(state: ClassificationCheckStateV3 | null): AiClassificationAssessment | null {
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
export function renderAiClassificationEvidence(value: AiClassificationSuggestion | null): string {
  return value ? value.evidence.map((item) => `${escapeMarkdownText(item.path)}：${escapeMarkdownText(item.reason)}`).join("；") : "未提供";
}
async function dispatchClassification(input: { repositoryId: number; pullRequestNumber: number; headSha: string; policySha: string; deliveryId: string; aiClassification?: string }) {
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId: stewardRepositoryId, permissions: { actions: "write", metadata: "read" }, policySha: input.policySha });
  await dispatchWorkflow(new GitHubClient(token, "https://api.github.com", fetch, input.policySha), { owner: "splrad", repo: "steward", workflow: "pr-classification.yml", policySha: input.policySha, inputs: { deliveryId: input.deliveryId, repositoryId: String(input.repositoryId), pullRequestNumber: String(input.pullRequestNumber), eventHeadSha: input.headSha, policySha: input.policySha, ...(input.aiClassification ? { aiClassification: input.aiClassification } : {}) } });
}

async function dispatchCentralWorkflow(workflow: "issue-sync.yml" | "pr-issue-link.yml", policySha: string, inputs: Record<string, string>): Promise<void> {
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId: stewardRepositoryId, permissions: { actions: "write", metadata: "read" }, policySha });
  await dispatchWorkflow(new GitHubClient(token, "https://api.github.com", fetch, policySha), { owner: "splrad", repo: "steward", workflow, policySha, inputs });
}

export function issueSyncInstallationPermissions(): Parameters<typeof createInstallationToken>[0]["permissions"] {
  return { issues: "read", metadata: "read" };
}

interface IssueSyncRepositoryState {
  repositoryId: number;
  generation: number;
  syncState: "uninitialized" | "scanning" | "ready" | "degraded";
  snapshots?: readonly { issueNumber: number }[];
  reconciliationGeneration?: number | null;
  reconciliationStateRevision?: number | null;
}

interface IssueSyncRefreshResult {
  repositoryId: number;
  issueNumber: number;
  generation: number;
  changed?: boolean;
  deleted?: boolean;
}

export interface IssueSyncResult {
  repositoryId: number;
  issueNumber: number | null;
  refreshed: number;
  skipped: number;
  changed: number;
  generation: number;
  dispatched: boolean;
}

export interface IssueSyncDependencies {
  listLiveOpenIssues(): Promise<{ numbers: readonly number[]; skipped: number }>;
  getState(): Promise<IssueSyncRepositoryState>;
  setScanState(state: "scanning" | "ready" | "degraded"): Promise<IssueSyncRepositoryState>;
  refresh(issueNumber: number): Promise<IssueSyncRefreshResult>;
  dispatchFormalReconciliation(generation: number): Promise<void>;
  releaseFormalReconciliation(generation: number, stateRevision: number): Promise<void>;
}

function uniqueIssueNumbers(values: readonly number[], name: string): number[] {
  const numbers = [...values];
  if (numbers.some(value => !Number.isSafeInteger(value) || value <= 0) || new Set(numbers).size !== numbers.length) throw new Error(`${name}无效`);
  return numbers.sort((left, right) => left - right);
}

function assertIssueSyncState(value: IssueSyncRepositoryState, repositoryId: number, expectedState?: IssueSyncRepositoryState["syncState"], snapshotsRequired = false): void {
  if (value.repositoryId !== repositoryId || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !["uninitialized", "scanning", "ready", "degraded"].includes(value.syncState)
    || (expectedState !== undefined && value.syncState !== expectedState)
    || (value.reconciliationGeneration !== undefined && value.reconciliationGeneration !== null
      && (!Number.isSafeInteger(value.reconciliationGeneration) || value.reconciliationGeneration < 0))
    || (value.reconciliationStateRevision !== undefined && value.reconciliationStateRevision !== null
      && (!Number.isSafeInteger(value.reconciliationStateRevision) || value.reconciliationStateRevision < 0))
    || ((value.reconciliationGeneration ?? null) === null) !== ((value.reconciliationStateRevision ?? null) === null)
    || (snapshotsRequired && !Array.isArray(value.snapshots))) throw new Error("议题同步仓库状态响应无效");
}

async function dispatchPendingReconciliation(repositoryId: number, dependencies: IssueSyncDependencies): Promise<boolean> {
  const state = await dependencies.getState();
  assertIssueSyncState(state, repositoryId);
  const generation = state.reconciliationGeneration;
  if (generation === undefined || generation === null) return false;
  const stateRevision = state.reconciliationStateRevision!;
  try {
    await dependencies.dispatchFormalReconciliation(generation);
  } catch (error) {
    try { await dependencies.releaseFormalReconciliation(generation, stateRevision); } catch { /* preserve the dispatch failure */ }
    throw error;
  }
  return true;
}

export async function reconcileIssueSnapshots(
  input: { repositoryId: number; issueNumber?: number; scanAll: boolean },
  dependencies: IssueSyncDependencies,
): Promise<IssueSyncResult> {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) throw new Error("repositoryId无效");
  if (input.scanAll === (input.issueNumber !== undefined)) throw new Error("全量同步与单议题同步参数不一致");
  if (input.issueNumber !== undefined && (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0)) throw new Error("issueNumber无效");
  if (!input.scanAll) {
    const state = await dependencies.getState();
    assertIssueSyncState(state, input.repositoryId);
    if (state.syncState !== "ready") return reconcileIssueSnapshots({ repositoryId: input.repositoryId, scanAll: true }, dependencies);
    let completed: Omit<IssueSyncResult, "dispatched">;
    try {
      const scanning = await dependencies.setScanState("scanning");
      assertIssueSyncState(scanning, input.repositoryId, "scanning");
      const refreshed = await dependencies.refresh(input.issueNumber!);
      if (refreshed.repositoryId !== input.repositoryId || refreshed.issueNumber !== input.issueNumber || !Number.isSafeInteger(refreshed.generation) || refreshed.generation < 0) throw new Error("议题刷新响应无效");
      const live = await dependencies.listLiveOpenIssues();
      if (!Number.isSafeInteger(live.skipped) || live.skipped < 0) throw new Error("GitHub开放议题集合无效");
      uniqueIssueNumbers(live.numbers, "GitHub开放议题集合");
      const ready = await dependencies.setScanState("ready");
      assertIssueSyncState(ready, input.repositoryId, "ready");
      if (ready.generation < refreshed.generation) throw new Error("扫描就绪响应无效");
      const changed = refreshed.changed === true || refreshed.deleted === true;
      completed = { repositoryId: input.repositoryId, issueNumber: input.issueNumber!, refreshed: 1, skipped: live.skipped, changed: changed ? 1 : 0, generation: ready.generation };
    } catch (error) {
      try { await dependencies.setScanState("degraded"); } catch { /* preserve the original failure */ }
      throw error;
    }
    const dispatched = await dispatchPendingReconciliation(input.repositoryId, dependencies);
    return { ...completed, dispatched };
  }
  let completed: Omit<IssueSyncResult, "dispatched">;
  try {
    const scanning = await dependencies.setScanState("scanning");
    assertIssueSyncState(scanning, input.repositoryId, "scanning");
    const [live, stored] = await Promise.all([dependencies.listLiveOpenIssues(), dependencies.getState()]);
    assertIssueSyncState(stored, input.repositoryId, undefined, true);
    if (!Number.isSafeInteger(live.skipped) || live.skipped < 0) throw new Error("GitHub开放议题集合无效");
    const liveNumbers = uniqueIssueNumbers(live.numbers, "GitHub开放议题集合");
    const storedNumbers = uniqueIssueNumbers(stored.snapshots!.map(item => item.issueNumber), "D1开放议题集合");
    const union = [...new Set([...liveNumbers, ...storedNumbers])].sort((left, right) => left - right);
    let changed = 0;
    let generation = stored.generation;
    for (const issueNumber of union) {
      const refreshed = await dependencies.refresh(issueNumber);
      if (refreshed.repositoryId !== input.repositoryId || refreshed.issueNumber !== issueNumber || !Number.isSafeInteger(refreshed.generation) || refreshed.generation < generation) throw new Error("议题刷新响应无效");
      generation = refreshed.generation;
      if (refreshed.changed === true || refreshed.deleted === true) changed++;
    }
    const ready = await dependencies.setScanState("ready");
    assertIssueSyncState(ready, input.repositoryId, "ready");
    if (ready.generation < generation) throw new Error("扫描就绪响应无效");
    completed = { repositoryId: input.repositoryId, issueNumber: null, refreshed: union.length, skipped: live.skipped, changed, generation: ready.generation };
  } catch (error) {
    try { await dependencies.setScanState("degraded"); } catch { /* preserve the original failure */ }
    throw error;
  }
  const dispatched = await dispatchPendingReconciliation(input.repositoryId, dependencies);
  return { ...completed, dispatched };
}

function runtimeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("RUNTIME_URL无效");
  return url.origin;
}

async function issueSync(args: Readonly<Record<string, string>>): Promise<void> {
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const deliveryId = required(args, "delivery-id");
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(deliveryId)) throw new Error("delivery-id无效");
  const scanAllValue = required(args, "scan-all");
  if (scanAllValue !== "true" && scanAllValue !== "false") throw new Error("scan-all必须是true或false");
  const scanAll = scanAllValue === "true";
  const issueNumber = args["issue-number"] === undefined ? undefined : integer(args["issue-number"], "issue-number");
  if (scanAll === (issueNumber !== undefined)) throw new Error("全量同步与单议题同步参数不一致");
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId, permissions: issueSyncInstallationPermissions(), policySha });
  const gh = new GitHubClient(token, "https://api.github.com", fetch, policySha);
  const repositories = await gh.listInstallationRepositories();
  if (repositories.length !== 1 || Number(repositories[0]?.id) !== repositoryId || typeof repositories[0]?.full_name !== "string") throw new Error("同步令牌仓库范围无效");
  const repository = repositories[0];
  const issueConfiguration = configurationFor(await catalog(), repository);
  if (!isIssueCapableRepository(repository, issueConfiguration.managed === true)) throw new Error("仓库未启用议题同步");
  const [owner, repo] = splitRepository(repository.full_name);
  const baseUrl = runtimeBaseUrl(env("RUNTIME_URL"));
  const requestRuntime = async <T>(method: "GET" | "POST", path: string, headers: Record<string, string> = {}): Promise<T> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers } });
      if (response.status === 409 && attempt < 3) continue;
      if (!response.ok) throw new Error(`议题同步运行时请求失败:${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 8 * 1024 * 1024) throw new Error("议题同步运行时响应过大");
      try { return JSON.parse(text) as T; } catch { throw new Error("议题同步运行时响应无效"); }
    }
    throw new Error("议题同步运行时冲突重试失败");
  };
  const result = await reconcileIssueSnapshots({ repositoryId, ...(issueNumber === undefined ? {} : { issueNumber }), scanAll }, {
    async listLiveOpenIssues() {
      const result = await gh.listOpenIssuesWithValidators(owner, repo);
      const issues = result.items.filter((item: any) => !Object.hasOwn(item ?? {}, "pull_request"));
      const numbers = issues.map((item: any) => {
        const number = Number(item?.number);
        let path = "";
        try { path = new URL(String(item?.repository_url)).pathname.toLowerCase(); } catch { /* checked below */ }
        if (!Number.isSafeInteger(number) || number <= 0 || path !== `/repos/${owner}/${repo}`.toLowerCase()) throw new Error("GitHub开放议题仓库身份无效");
        return number;
      });
      return { numbers, skipped: result.items.length - issues.length };
    },
    getState: () => requestRuntime<IssueSyncRepositoryState>("GET", `/internal/issue-snapshots/${repositoryId}`),
    setScanState: (state) => requestRuntime<IssueSyncRepositoryState>("POST", `/internal/issue-snapshots/${repositoryId}/scan-state`, { "x-steward-scan-state": state }),
    refresh: (number) => requestRuntime<IssueSyncRefreshResult>("POST", `/internal/issue-snapshots/${repositoryId}/${number}/refresh`, { "x-github-delivery": deliveryId }),
    dispatchFormalReconciliation: (generation) => dispatchCentralWorkflow("pr-issue-link.yml", policySha, {
      deliveryId,
      repositoryId: String(repositoryId),
      scanAll: "true",
      invalidateOnly: "false",
      cleanupUnmanaged: "false",
      reconciliationGeneration: String(generation),
      policySha,
    }),
    async releaseFormalReconciliation(generation, stateRevision) {
      const released = await requestRuntime<{ repositoryId: number; generation: number; stateRevision: number; released: boolean }>("POST", `/internal/issue-snapshots/${repositoryId}/reconciliation/release`, {
        "x-steward-reconciliation-generation": String(generation),
        "x-steward-reconciliation-state-revision": String(stateRevision),
      });
      if (released.repositoryId !== repositoryId || released.generation !== generation || released.stateRevision !== stateRevision || typeof released.released !== "boolean") throw new Error("议题重算首次派发释放响应无效");
    },
  });
  await summary([`仓库编号：${result.repositoryId}`, `议题编号：${result.issueNumber ?? "all"}`, `刷新数量：${result.refreshed}`, `跳过数量：${result.skipped}`, `变更数量：${result.changed}`, `仓库代次：${result.generation}`, `全拉取请求重算：${result.dispatched ? "scheduled" : "unchanged"}`]);
}

const copilotReviewer = "copilot-pull-request-reviewer[bot]";
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
export function prAutomationInstallationPermissions(): Parameters<typeof createInstallationToken>[0]["permissions"] {
  return { contents: "read", pull_requests: "write", issues: "read", checks: "read", metadata: "read" } as const;
}
export function humanPushPullRequestCreateInput(input: { title: string; body: string; head: string; base: string }) {
  return { ...input, draft: true } as const;
}
async function hasCurrentCopilotReview(clientValue: GitHubClient, owner: string, repo: string, number: number, headSha: string, afterEventId?: number, checkClientValue: GitHubClient = clientValue): Promise<boolean> {
  const [requested, reviews, events, checkRuns] = await Promise.all([
    clientValue.getRequestedReviewers(owner, repo, number),
    clientValue.listPullRequestReviews(owner, repo, number),
    afterEventId === undefined ? Promise.resolve([]) : clientValue.listIssueEvents(owner, repo, number),
    checkClientValue.listAllCheckRuns(owner, repo, headSha),
  ]);
  const pending = hasRequestedCopilotReviewer(requested);
  const completed = reviews.some((value: any) =>
    isCopilotReviewerIdentity(value.user?.login)
    && String(value.commit_id ?? "").toLowerCase() === headSha.toLowerCase()
    && String(value.state ?? "").toUpperCase() !== "DISMISSED");
  const activeCheck = hasActiveCopilotCheckRun(checkRuns, number, headSha);
  return pending || completed || activeCheck || (afterEventId !== undefined && hasNewCopilotRequestEvent(events, afterEventId));
}
async function ensureCopilotReview(clientValue: GitHubClient, owner: string, repo: string, number: number, headSha: string, policySha: string): Promise<"already-present" | "requested-and-confirmed"> {
  if (await hasCurrentCopilotReview(clientValue, owner, repo, number, headSha)) return "already-present";
  const reviewerClient = new GitHubClient(env("COPILOT_REVIEW_REQUEST_TOKEN"), "https://api.github.com", fetch, policySha);
  const eventsBefore = await reviewerClient.listIssueEvents(owner, repo, number);
  const eventCursor = eventsBefore.reduce((maximum: number, value: any) => Math.max(maximum, Number(value.id) || 0), 0);
  await reviewerClient.requestReviewers(owner, repo, number, [copilotReviewer]);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await hasCurrentCopilotReview(reviewerClient, owner, repo, number, headSha, eventCursor, clientValue)) return "requested-and-confirmed";
    if (attempt < 4) await delay(2_000);
  }
  throw new Error("Copilot审查请求未能通过实时读取确认");
}

export async function writeManagedFileToBranch(input: {
  gh: GitHubClient;
  owner: string;
  repo: string;
  path: string;
  content: string;
  branch: string;
  title: string;
  defaultSha: string;
  branchSha: string | null;
}): Promise<{ changed: boolean; headSha: string }> {
  if (!input.branchSha) {
    await input.gh.createRef(input.owner, input.repo, `refs/heads/${input.branch}`, input.defaultSha);
  } else {
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
    if (Number(comparison.ahead_by) < 1 || comparison.files.length !== 1 || comparison.files[0]?.filename !== input.path) {
      throw new Error(`受管分支包含非预期改动: ${input.branch}`);
    }
  }
  const existing = await optional(() => input.gh.getContent(input.owner, input.repo, input.path, input.branch));
  if (decodeContent(existing) === input.content) return { changed: false, headSha: input.branchSha ?? input.defaultSha };
  const put: Record<string, unknown> = { message: input.title, content: Buffer.from(input.content, "utf8").toString("base64"), branch: input.branch };
  if (existing?.sha) put.sha = existing.sha;
  const written = await input.gh.putContent(input.owner, input.repo, input.path, put);
  return { changed: true, headSha: written.commit.sha };
}

export function assertManagedBranchPull(branchExists: boolean, pull: any | undefined, branch: string): void {
  if ((pull && (pull.user?.id !== 301115370 || pull.merged_at)) || (branchExists && !pull)) {
    throw new Error(`受管分支不是Steward拥有的开放拉取请求: ${branch}`);
  }
}

async function reconcileManagedFile(input: { repository: any; gh: GitHubClient; token: string; path: string; content: string; branch: string; title: string; policySha: string; deliveryId: string; redrive: DurableBodyRedrive; dispatchIssueLink?: boolean }): Promise<"unchanged" | "pull-request-created" | "pull-request-updated"> {
  const [owner, repo] = splitRepository(input.repository.full_name); const defaultBranch = input.repository.default_branch;
  const current = await optional(() => input.gh.getContent(owner, repo, input.path, defaultBranch)); if (decodeContent(current) === input.content) return "unchanged";
  const pulls = await input.gh.listPullRequests(owner, repo, `${owner}:${input.branch}`); if (pulls.length > 1) throw new Error(`受管分支存在多个拉取请求: ${input.branch}`);
  const defaultRef = await input.gh.getRef(owner, repo, `heads/${defaultBranch}`); const branchRef = await optional(() => input.gh.getRef(owner, repo, `heads/${input.branch}`));
  assertManagedBranchPull(Boolean(branchRef), pulls[0], input.branch);
  const written = await writeManagedFileToBranch({ gh: input.gh, owner, repo, path: input.path, content: input.content, branch: input.branch, title: input.title, defaultSha: defaultRef.object.sha, branchSha: branchRef?.object.sha ?? null });
  const generated = {
    type: "chore" as const,
    scope: "steward",
    title: input.title.replace(/^chore\([^)]*\):\s*/u, ""),
    summary: "由SPLRAD Steward同步中央管理文件并保持仓库规则与中央配置一致。",
    motivation: "中央管理文件需要跟随当前规则更新，避免目标仓库保留已经过期的配置。",
    changes: [`更新${input.path}并保持中央配置为唯一人工维护来源`],
    impact: ["目标仓库后续使用更新后的中央管理规则"],
    releaseAndMigration: [],
  };
  const body = renderManagedBody({ generated, existingBody: pulls[0]?.body, templateBody: organizationPullRequestTemplate, actor: "splrad-steward[bot]", contributors: [], context: `${input.repository.id}:${input.path}:${input.policySha}` });
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
    regionKind: "managed-pr",
    targetBlock: targetManagedBlock(body, "managed-pr"),
    redrive: input.redrive,
    additionalPatch: { title: input.title },
  }) : await input.gh.createPullRequest(owner, repo, { title: input.title, body, head: input.branch, base: defaultBranch });
  await ensureCopilotReview(input.gh, owner, repo, pull.number, written.headSha, input.policySha);
  await dispatchClassification({ repositoryId: input.repository.id, pullRequestNumber: pull.number, headSha: written.headSha, policySha: input.policySha, deliveryId: input.deliveryId });
  if ((input.dispatchIssueLink ?? isIssueCapableRepository(input.repository, true)) === true) {
    await dispatchCentralWorkflow("pr-issue-link.yml", input.policySha, {
      deliveryId: input.deliveryId,
      repositoryId: String(input.repository.id),
      pullRequestNumber: String(pull.number),
      scanAll: "false",
      invalidateOnly: "false",
      cleanupUnmanaged: "false",
      policySha: input.policySha,
    });
  }
  return pulls[0] ? "pull-request-updated" : "pull-request-created";
}

async function onboard(args: Readonly<Record<string, string>>) {
  const fullName = required(args, "repository-full-name"); const [owner, repo] = splitRepository(fullName);
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const trigger = required(args, "trigger");
  if (!["installation-created", "installation-repositories-added", "repository-visibility-changed", "default-branch-push", "manual"].includes(trigger)) throw new Error("接入触发来源无效");
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
    await summary([`仓库：${fullName}`, "Copilot说明：waiting-for-default-branch", `标签定义：${labelSyncFailure ? "failed" : "checked"}`]);
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
  const instructions = await loadCopilotInstructions(cfg.copilotInstructionsProfile, (sourceFile) => configPath("copilot", sourceFile));
  const planned = renderOnboardingPullRequest({ template: organizationPullRequestTemplate, configuration: cfg, actor: "splrad-steward[bot]", context: `onboard:${repositoryId}` });
  const deliveryId = required(args, "delivery-id");
  const result = await reconcileManagedFile({ repository, gh, token, path: instructions.targetPath, content: instructions.content, branch: planned.branch, title: planned.title, policySha, deliveryId, dispatchIssueLink: false,
    redrive: { workflow: "onboard-repository.yml", inputs: { repositoryId: String(repositoryId), repositoryFullName: fullName, trigger, deliveryId, policySha } } });
  await summary([`仓库：${fullName}`, `状态：${result === "unchanged" ? "onboarded" : result}`, `接入分支：${planned.branch}`, `分类配置：${cfg.classification.profile}`, `验证配置：${cfg.validationProfile}`, `Copilot说明配置：${cfg.copilotInstructionsProfile}`, `发布配置：${cfg.releaseProfile ?? "未启用"}`, `Copilot说明字符数：${[...instructions.content].length}`, `标签定义：${labelSyncFailure ? "failed" : "checked"}`]);
  if (isIssueCapableRepository(repository, cfg.managed === true)) {
    await dispatchCentralWorkflow("issue-sync.yml", policySha, { deliveryId, repositoryId: String(repositoryId), scanAll: "true", policySha });
  }
  if (labelSyncFailure) throw new Error(labelSyncFailure);
}
async function automate(args: Readonly<Record<string, string>>) {
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const sourceRef = required(args, "source-ref"); if (!sourceRef.startsWith("refs/heads/")) throw new Error("source-ref必须使用refs/heads/格式");
  const eventAfterSha = sha(required(args, "event-after-sha"), "event-after-sha");
  const sourceActor = { id: integer(required(args, "source-actor-id"), "source-actor-id"), login: required(args, "source-actor-login"), type: "User" };
  if (!isHumanActor(sourceActor)) throw new Error("来源推送者不是有效真人账号");
  const { token, client: gh } = await clientWithToken(repositoryId, prAutomationInstallationPermissions(), policySha);
  const repository = await gh.getRepositoryById(repositoryId); const [owner, repo] = splitRepository(repository.full_name);
  const repositoryConfiguration = configurationFor(await catalog(), repository);
  if (!repositoryConfiguration.managed || !repositoryConfiguration.prAutomation) return summary(["状态：ignored", "原因：仓库没有启用中央拉取请求创建"]);
  const sourceBranch = sourceRef.slice("refs/heads/".length); if (sourceBranch === repository.default_branch) return summary(["状态：ignored", "原因：默认分支推送不创建拉取请求"]);
  const classificationProfile = await json<ClassificationProfile>(configPath("profiles", "classification", `${repositoryConfiguration.classification.profile}.json`));
  const semantics = await semanticCatalog();
  const repositoryClassification = repositoryConfiguration.classification as RepositoryClassification;
  const [baseBefore, sourceBefore] = await Promise.all([
    gh.getRef(owner, repo, `heads/${repository.default_branch}`),
    gh.getRef(owner, repo, `heads/${sourceBranch}`),
  ]);
  const compare = await gh.compare(owner, repo, baseBefore.object.sha, sourceBefore.object.sha);
  if (!Array.isArray(compare.commits) || !Array.isArray(compare.files)) throw new Error("提交或文件比较结果不完整");
  if (Number(compare.total_commits) !== compare.commits.length) throw new Error("提交比较结果未完整返回");
  if (compare.files.length >= 300) throw new Error("文件比较达到接口上限，不能证明结果完整");
  if (!compare.ahead_by) return summary(["状态：ignored", "原因：来源分支没有待合并提交"]);
  const pulls = await gh.listPullRequests(owner, repo, `${owner}:${sourceBranch}`); if (pulls.length > 1) throw new Error("同一来源分支存在多个匹配拉取请求");
  const [baseAfter, sourceAfter] = await Promise.all([
    gh.getRef(owner, repo, `heads/${repository.default_branch}`),
    gh.getRef(owner, repo, `heads/${sourceBranch}`),
  ]);
  if (baseAfter.object.sha !== baseBefore.object.sha || sourceAfter.object.sha !== sourceBefore.object.sha) throw new Error("读取期间来源或目标分支已经漂移");
  const contributorMap = new Map<number, Contributor>();
  contributorMap.set(sourceActor.id, { id: sourceActor.id, login: sourceActor.login });
  for (const commit of compare.commits) {
    const normalized = commit.author ? normalizeContributor({ ...commit.author, name: commit.commit?.author?.name, email: commit.commit?.author?.email, avatarUrl: commit.author.avatar_url }) : null;
    if (normalized) contributorMap.set(normalized.id, normalized);
  }
  const contributors = [...contributorMap.values()];
  const files = (compare.files ?? []).map((file: any) => file.filename);
  const rawFactsBase: Omit<RawClassificationFacts, "pullRequestNumber"> = {
    repositoryId,
    sourceRepositoryId: repositoryId,
    sourceRef,
    targetRef: `refs/heads/${repository.default_branch}`,
    author: { login: sourceActor.login, type: sourceActor.type as RawClassificationFacts["author"]["type"] },
    headSha: sourceBefore.object.sha,
    baseSha: baseBefore.object.sha,
    commits: (compare.commits ?? []).map((commit: any) => ({ sha: String(commit.sha), message: String(commit.commit?.message ?? "") })),
    files: (compare.files ?? []).map((file: any) => ({
      path: String(file.filename),
      ...(file.previous_filename ? { previousPath: String(file.previous_filename) } : {}),
      status: String(file.status),
      additions: Number(file.additions),
      deletions: Number(file.deletions),
      patch: typeof file.patch === "string" ? file.patch : null,
      patchState: typeof file.patch === "string" ? "available" as const : "missing" as const,
    })),
  };
  const aiObservation = buildAiDiffObservation(rawFactsBase.files);
  const facts: AutomationFacts = {
    sourceRef,
    targetRef: rawFactsBase.targetRef,
    headSha: rawFactsBase.headSha,
    baseSha: rawFactsBase.baseSha,
    commitSubjects: rawFactsBase.commits.map((commit) => commit.message.split("\n")[0]!),
    files,
    diffStat: `${files.length}个文件`,
    diffExcerpt: aiObservation.excerpt,
    areas: [],
    contributors,
  };
  const fallback = buildDeterministicSummary(facts); let generated = fallback; let mode = "deterministic";
  let fallbackReason: string | null = null;
  let primaryFailureReason: string | null = null;
  let repairSummary: string | null = null;
  let copilotNormalizationSummary: string | null = null;
  let copilotOutputEvidence: string | null = null;
  let copilotRepairOutputEvidence: string | null = null;
  let classificationField: AiClassificationFieldInspection = { state: "missing" };
  if (process.env.PREPARE_REPAIR_ONLY === "true") {
    const preparedText = await runtimeReadFile(env("PR_PREPARED_FACTS_PATH"), "utf8");
    const prepared = JSON.parse(preparedText);
    assertPreparedCopilotFacts(prepared, { repositoryId, sourceRef, headSha: facts.headSha, baseSha: facts.baseSha, policySha });
    await prepareCopilotRepair();
    return;
  }
  if (process.env.PREPARE_ONLY === "true") {
    const promptPath = env("PR_COPILOT_PROMPT_PATH");
    const preparedFactsPath = env("PR_PREPARED_FACTS_PATH");
    await writeFile(promptPath, buildPrompt(facts, fallback, semantics, classificationProfile, aiObservation));
    await writeFile(preparedFactsPath, JSON.stringify({ repositoryId, sourceRef, headSha: facts.headSha, baseSha: facts.baseSha, policySha }) + "\n");
    await summary(["状态：prepared", `来源提交：${facts.headSha}`, `提示文件：${basename(promptPath)}`]);
    return;
  }
  const copilotOutput = process.env.COPILOT_OUTPUT_PATH;
  if (process.env.COPILOT_STEP_OUTCOME && process.env.COPILOT_STEP_OUTCOME !== "success") {
    fallbackReason = describeCopilotFallback("copilot-step", null);
  } else if (copilotOutput && process.env.PR_PREPARED_FACTS_PATH) {
    let stage: CopilotFallbackStage = "prepared-facts-read";
    try {
      const preparedText = await runtimeReadFile(process.env.PR_PREPARED_FACTS_PATH, "utf8");
      stage = "prepared-facts-parse";
      const prepared = JSON.parse(preparedText);
      stage = "prepared-facts-check";
      assertPreparedCopilotFacts(prepared, { repositoryId, sourceRef, headSha: facts.headSha, baseSha: facts.baseSha, policySha });
      stage = "copilot-output-read";
      const copilotOutputMetadata = await stat(copilotOutput);
      if (!copilotOutputMetadata.isFile() || copilotOutputMetadata.size === 0 || copilotOutputMetadata.size > maximumCopilotJsonlBytes) {
        stage = "copilot-output-envelope";
        throw new Error("Copilot JSONL输出大小无效");
      }
      const copilotOutputText = await runtimeReadFile(copilotOutput, "utf8");
      copilotOutputEvidence = `${Buffer.byteLength(copilotOutputText, "utf8")}字节，SHA-256 ${createHash("sha256").update(copilotOutputText, "utf8").digest("hex")}`;
      stage = "copilot-output-envelope";
      const primaryResolution = resolveCopilotGeneratedSummary(copilotOutputText);
      if (primaryResolution.state === "adopted") {
        generated = primaryResolution.generated;
        classificationField = primaryResolution.classification;
        mode = primaryResolution.mode;
        if (primaryResolution.normalization === "single-json-fence") copilotNormalizationSummary = "首次输出已剥离单一json代码围栏";
      } else if (primaryResolution.state === "fallback") {
        fallbackReason = primaryResolution.fallbackReason;
      } else {
        primaryFailureReason = primaryResolution.primaryFailureReason;
        fallbackReason = primaryResolution.primaryFailureReason;
        const repairOutput = process.env.COPILOT_REPAIR_OUTPUT_PATH;
        const repairAvailability = describeCopilotRepairAvailability(process.env.COPILOT_REPAIR_STEP_OUTCOME, repairOutput);
        if (repairAvailability) {
          repairSummary = repairAvailability;
        } else {
          let repairStage: "read" | "envelope" = "read";
          try {
            const repairMetadata = await stat(repairOutput!);
            if (!repairMetadata.isFile() || repairMetadata.size === 0 || repairMetadata.size > maximumCopilotJsonlBytes) {
              repairStage = "envelope";
              throw new Error("Copilot修复JSONL输出大小无效");
            }
            const repairText = await runtimeReadFile(repairOutput!, "utf8");
            copilotRepairOutputEvidence = `${Buffer.byteLength(repairText, "utf8")}字节，SHA-256 ${createHash("sha256").update(repairText, "utf8").digest("hex")}`;
            repairStage = "envelope";
            const repairedResolution = resolveCopilotGeneratedSummary(copilotOutputText, repairText);
            if (repairedResolution.state === "adopted" && repairedResolution.mode === "copilot-repaired") {
              generated = repairedResolution.generated;
              classificationField = repairedResolution.classification;
              mode = repairedResolution.mode;
              if (repairedResolution.normalization === "single-json-fence") copilotNormalizationSummary = "修复输出已剥离单一json代码围栏";
              fallbackReason = null;
              repairSummary = "已采用";
            } else {
              const reason = repairedResolution.state === "fallback" ? repairedResolution.repairFailureReason : undefined;
              repairSummary = `失败（${reason ?? "Copilot修复输出无效"}）`;
            }
          } catch {
            repairSummary = describeCopilotRepairOutputFailure(repairStage);
          }
        }
      }
    } catch (error) {
      generated = fallback;
      fallbackReason = describeCopilotFallback(stage, error);
    }
  }
  let aiClassification: string | undefined;
  let aiClassificationSummary = mode !== "deterministic" ? "未提供" : "Copilot不可用，未提供";
  if (classificationField.state === "valid") aiClassificationSummary = `${classificationField.suggestion.primaryKind}（${classificationField.suggestion.confidence}）`;
  else if (classificationField.state === "abstained") aiClassificationSummary = "弃权";
  else if (classificationField.state === "invalid") aiClassificationSummary = `无效（${classificationField.reason}）`;
  const template = process.env.PR_TEMPLATE_PATH ? await runtimeReadFile(process.env.PR_TEMPLATE_PATH, "utf8") : organizationPullRequestTemplate;
  const title = `${generated.type}(${generated.scope}): ${generated.title}`;
  const context = await computePullRequestFingerprint({ repositoryId, pullRequestNumber: pulls[0]?.number ?? 0, headSha: facts.headSha, baseSha: facts.baseSha, commits: (compare.commits ?? []).map((c: any) => c.sha), files: (compare.files ?? []).map((f: any) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })), title, body: "", contributors });
  const body = renderManagedBody({ generated, existingBody: pulls[0]?.body, templateBody: template, actor: sourceActor.login, contributors, context });
  const pull = pulls[0] ? await updatePullRequestBodyDurably({
    client: gh,
    token,
    runtimeUrl: env("RUNTIME_URL"),
    owner,
    repo,
    repositoryId,
    pullRequestNumber: Number(pulls[0].number),
    headSha: facts.headSha,
    baseSha: facts.baseSha,
    regionKind: "managed-pr",
    targetBlock: targetManagedBlock(body, "managed-pr"),
    redrive: { workflow: "pr-automation.yml", inputs: {
      deliveryId: required(args, "delivery-id"), repositoryId: String(repositoryId), sourceRef, eventAfterSha,
      sourceActorId: String(sourceActor.id), sourceActorLogin: sourceActor.login, policySha,
    } },
    additionalPatch: { title },
  }) : await gh.createPullRequest(owner, repo, humanPushPullRequestCreateInput({ title, body, head: sourceBranch, base: repository.default_branch }));
  const boundPull = await gh.getPullRequest(owner, repo, pull.number);
  const pullBinding = inspectAutomationPullRequestBinding(boundPull, { repositoryId, sourceBranch, headSha: facts.headSha, baseBranch: repository.default_branch, baseSha: facts.baseSha });
  if (isIssueCapableRepository(repository, repositoryConfiguration.managed === true)) {
    await dispatchCentralWorkflow("pr-issue-link.yml", policySha, {
      deliveryId: required(args, "delivery-id"),
      repositoryId: String(repositoryId),
      pullRequestNumber: String(pull.number),
      scanAll: "false",
      invalidateOnly: "false",
      cleanupUnmanaged: "false",
      policySha,
    });
  }
  if (pullBinding === "base-sha-drifted") aiClassificationSummary = `${aiClassificationSummary}；目标分支已前进，未传递`;
  else if (classificationField.state !== "missing") {
    const rawFacts: RawClassificationFacts = { ...rawFactsBase, pullRequestNumber: pull.number };
    const policy = classificationDigests(semantics, classificationProfile, repositoryClassification);
    const envelope = createAiClassificationEnvelope({ facts: rawFacts, policySha, digests: policy, effectiveAiMode: repositoryClassification.ai.mode, suggestion: null });
    const payload = prepareAiClassificationPayload(classificationField, envelope);
    if (payload.state === "encoded") aiClassification = payload.payload;
    else if (payload.state === "encoding-failed") aiClassificationSummary = `${aiClassificationSummary}；封装失败，未传递`;
  }
  await output({ pullRequestNumber: pull.number, headSha: facts.headSha, repositoryFullName: repository.full_name });
  const copilot = await ensureCopilotReview(gh, owner, repo, pull.number, facts.headSha, policySha);
  await dispatchClassification({ repositoryId, pullRequestNumber: pull.number, headSha: facts.headSha, policySha, deliveryId: required(args, "delivery-id"), ...(aiClassification ? { aiClassification } : {}) });
  await summary([
    `状态：${pulls[0] ? "updated" : "draft-created"}`,
    `拉取请求：#${pull.number}`,
    `来源提交：${facts.headSha}`,
    `事件提交：${eventAfterSha}`,
    `标题生成：${mode}`,
    ...(copilotNormalizationSummary ? [`人工智能JSON规范化：${copilotNormalizationSummary}`] : []),
    ...(fallbackReason ? [`人工智能回退原因：${fallbackReason}`] : []),
    ...(primaryFailureReason ? [`人工智能首次失败原因：${primaryFailureReason}`] : []),
    ...(repairSummary ? [`人工智能修复：${repairSummary}`] : []),
    ...(fallbackReason && !primaryFailureReason && copilotOutputEvidence ? [`人工智能输出证据：${copilotOutputEvidence}`] : []),
    ...(primaryFailureReason && copilotOutputEvidence ? [`人工智能首次输出证据：${copilotOutputEvidence}`] : []),
    ...(copilotRepairOutputEvidence ? [`人工智能修复输出证据：${copilotRepairOutputEvidence}`] : []),
    `AI分类建议：${aiClassificationSummary}`,
    `Copilot审查：${copilot}`,
  ]);
  if (process.env.PR_COPILOT_PROMPT_PATH) await writeFile(process.env.PR_COPILOT_PROMPT_PATH, buildPrompt(facts, fallback, semantics, classificationProfile, aiObservation));
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
  const same = (await gh.listAllCheckRuns(owner, repo, expectedHead)).filter((value: any) => value.name === "PR Classification Gate" && value.app?.id === 4243096);
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
    const rawFacts = {
      repositoryId, pullRequestNumber: number, sourceRepositoryId: Number(pull.head.repo.id), sourceRef: `refs/heads/${pull.head.ref}`,
      targetRef: `refs/heads/${pull.base.ref}`, author: { login: String(pull.user.login), type: pull.user.type as "User" | "Bot" | "Organization" | "Mannequin" },
      headSha: expectedHead, baseSha: String(pull.base.sha),
      commits: commits.map((value: any) => ({ sha: String(value.sha), message: String(value.commit?.message ?? "") })),
      files: files.map((value: any) => ({ path: String(value.filename), ...(value.previous_filename ? { previousPath: String(value.previous_filename) } : {}), status: String(value.status), additions: Number(value.additions), deletions: Number(value.deletions), patch: typeof value.patch === "string" ? value.patch : null, patchState: typeof value.patch === "string" ? "available" as const : "missing" as const })),
    };
    const policy = classificationDigests(semantics, profile, repositoryClassification);
    const inputDigest = classificationInputDigest(rawFacts, policySha, policy.classificationPolicyDigest);
    const reusablePreviousState = previousState?.policy === policy.classificationPolicyDigest
      && previousState.inputDigest === inputDigest
      && previousState.mode === repositoryClassification.ai.mode
      ? previousState
      : null;
    const priorOwnership = reusablePreviousState
      ? { stewardOwnedRiskFlags: reusablePreviousState.risks, stewardOwnedFacets: reusablePreviousState.facets }
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
      v: 3,
      repositoryId,
      pullRequestNumber: number,
      headSha: expectedHead,
      inputDigest,
      policy: policy.classificationPolicyDigest,
      mode: repositoryClassification.ai.mode,
      primary: result.primaryKind,
      ...(result.primaryKind.source === "ai" ? { acceptedAiPrimaryKind: result.primaryKind.id } : {}),
      risks: labelPlan.ownedRiskFlags,
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
async function reconcileRepositoryLifecycle(args: Readonly<Record<string, string>>) {
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const deliveryId = required(args, "delivery-id");
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(deliveryId)) throw new Error("delivery-id无效");
  const targets = await managedTargets(policySha);
  const installedRepositoryIds = targets.map(target => integer(String(target.repository.id), "repository-id")).sort((left, right) => left - right);
  const stewardshipToken = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId: stewardRepositoryId, permissions: { metadata: "read" }, policySha });
  const reconciliationResponse = await fetch(`${runtimeBaseUrl(env("RUNTIME_URL"))}/internal/issue-snapshots/${stewardRepositoryId}/lifecycle/reconcile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${stewardshipToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryIds: installedRepositoryIds }),
  });
  if (!reconciliationResponse.ok) throw new Error(`安装仓库生命周期运行时请求失败:${reconciliationResponse.status}`);
  const reconciliationText = await reconciliationResponse.text();
  if (Buffer.byteLength(reconciliationText, "utf8") > 16 * 1024) throw new Error("安装仓库生命周期运行时响应过大");
  let reconciliation: any;
  try { reconciliation = JSON.parse(reconciliationText); } catch { throw new Error("安装仓库生命周期运行时响应无效"); }
  if (reconciliation?.repositoryId !== stewardRepositoryId || !Array.isArray(reconciliation?.removedRepositoryIds)
    || reconciliation.removedRepositoryIds.some((value: unknown) => typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || installedRepositoryIds.includes(value))
    || new Set(reconciliation.removedRepositoryIds).size !== reconciliation.removedRepositoryIds.length) throw new Error("安装仓库生命周期运行时读回不一致");

  let firstFailure: unknown = null;
  for (const target of targets.filter(target => target.issueCapable)) {
    const repositoryId = integer(String(target.repository.id), "repository-id");
    try {
      await dispatchCentralWorkflow("pr-issue-link.yml", policySha, {
        deliveryId: `${deliveryId}:${repositoryId}`,
        repositoryId: String(repositoryId),
        scanAll: "true",
        invalidateOnly: "true",
        cleanupUnmanaged: "false",
        policySha,
      });
    } catch (error) { if (firstFailure === null) firstFailure = error; }
  }
  if (firstFailure !== null) throw firstFailure;

  const reconciled: ManagedTarget[] = [];
  for (const target of targets) {
    const repositoryId = integer(String(target.repository.id), "repository-id");
    try {
      const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId, permissions: { metadata: "read" }, policySha });
      const response = await fetch(`${runtimeBaseUrl(env("RUNTIME_URL"))}/internal/issue-snapshots/${repositoryId}/lifecycle`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`仓库生命周期运行时请求失败:${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new Error("仓库生命周期运行时响应过大");
      let state: any;
      try { state = JSON.parse(text); } catch { throw new Error("仓库生命周期运行时响应无效"); }
      if (state?.repositoryId !== repositoryId || state?.managed !== target.managed || state?.issueCapable !== target.issueCapable) throw new Error("仓库生命周期运行时读回不一致");
      reconciled.push(target);
    } catch (error) { if (firstFailure === null) firstFailure = error; }
  }

  for (const target of reconciled) {
    const repositoryId = integer(String(target.repository.id), "repository-id");
    try {
      if (target.issueCapable) {
        await dispatchCentralWorkflow("issue-sync.yml", policySha, {
          deliveryId: `${deliveryId}:${repositoryId}`,
          repositoryId: String(repositoryId),
          scanAll: "true",
          policySha,
        });
      } else {
        await dispatchCentralWorkflow("pr-issue-link.yml", policySha, {
          deliveryId: `${deliveryId}:${repositoryId}`,
          repositoryId: String(repositoryId),
          scanAll: "true",
          invalidateOnly: "false",
          cleanupUnmanaged: "true",
          policySha,
        });
      }
      await summary([`仓库编号：${repositoryId}`, `平台纳管：${target.managed ? "managed" : "unmanaged"}`, `议题能力：${target.issueCapable ? "enabled" : "disabled"}`, `登记来源：${target.registration}`]);
    } catch (error) { if (firstFailure === null) firstFailure = error; }
  }
  if (firstFailure !== null) throw firstFailure;
}
async function assertManualSyncAuthorization(policySha: string): Promise<void> {
  if (process.env.SYNC_TRIGGER !== "workflow_dispatch") return;
  integer(env("TRIGGER_ACTOR_ID"), "TRIGGER_ACTOR_ID");
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), permissions: { metadata: "read", members: "read" }, policySha });
  const membership = await new GitHubClient(token, "https://api.github.com", fetch, policySha).getTeamMembership("splrad", "maintainers", env("TRIGGER_ACTOR_LOGIN"));
  if (membership.state !== "active") throw new Error("手工同步触发者不是Maintainers当前成员");
}
async function syncInstructions(args: Readonly<Record<string, string>>) {
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  await assertManualSyncAuthorization(policySha);
  const targets = await managedTargets(policySha, args["repository-id"] ? integer(args["repository-id"], "repository-id") : undefined);
  const results = await runManagedRepositorySync(targets, async ({ repository, configuration }) => {
    const instructions = await loadCopilotInstructions(configuration.copilotInstructionsProfile, (sourceFile) => configPath("copilot", sourceFile));
    const { token, client: gh } = await clientWithToken(repository.id, { contents: "write", pull_requests: "write", issues: "read", checks: "read", metadata: "read" }, policySha);
    const result = await reconcileManagedFile({ repository, gh, token, path: instructions.targetPath, content: instructions.content, branch: "steward/copilot-instructions", title: "chore(copilot): 同步代码审查说明", policySha, deliveryId: `copilot-sync:${policySha}:${repository.id}`,
      redrive: { workflow: "sync-copilot-instructions.yml", inputs: { repositoryId: String(repository.id) } } });
    await summary([`仓库：${repository.full_name}`, `目标文件：${instructions.targetPath}`, `状态：${result}`, `字符数：${[...instructions.content].length}`]);
    return result;
  });
  for (const value of results.filter(item => item.status === "ignored")) await summary([`仓库：${value.target.repository.full_name}`, `登记来源：${value.target.registration}`, "状态：ignored"]);
  const failures = results.filter(value => value.error);
  if (failures.length) throw new Error(`Copilot说明同步失败: ${failures.map(value => value.target.repository.full_name).join("、")}`);
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

export function matchesGeneratedCopilotInstructions(actual: string, generated: string): boolean {
  const normalizeCheckoutLineEndings = (value: string) => value.replace(/\r\n/gu, "\n");
  return normalizeCheckoutLineEndings(actual) === normalizeCheckoutLineEndings(generated);
}

export function copilotInstructionSourcePath(repositoryId: number, workspace: string, file: "common.md" | "layerscape.md"): string {
  return repositoryId === stewardRepositoryId
    ? join(workspace, "config", "copilot", file)
    : configPath("copilot", file);
}

export function assertWorkflowPaths(actual: readonly string[], allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const actualSet = new Set(actual);
  const missing = allowed.filter(path => !actualSet.has(path));
  const unexpected = actual.filter(path => !allowedSet.has(path));
  if (missing.length || unexpected.length) {
    throw new Error(`仓库工作流超出中央允许范围；缺少：${missing.join(", ") || "无"}；未允许：${unexpected.join(", ") || "无"}`);
  }
}

async function validate(args: Readonly<Record<string, string>>) {
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
  const allowedWorkflows = [...configuration.allowedWorkflowPaths].sort();
  assertWorkflowPaths(actualWorkflows, allowedWorkflows);
  const results = await runValidationTasks(profile, async task => {
    if (task === "git-diff-check") {
      run("git", gitDiffCheckArguments(validationBaseSha ? sha(validationBaseSha, "VALIDATION_BASE_SHA") : undefined), workspace);
      return { state: "success" as const, detail: "未发现空白错误" };
    }
    if (task === "parse-json") { for (const file of files.filter(path => path.endsWith(".json"))) JSON.parse(await runtimeReadFile(file, "utf8")); return { state: "success" as const, detail: "JSON有效" }; }
    if (task === "parse-yaml") { for (const file of files.filter(path => /\.ya?ml$/.test(path))) YAML.parse(await runtimeReadFile(file, "utf8")); return { state: "success" as const, detail: "YAML有效" }; }
    if (task === "verify-copilot-instructions") {
      const instructions = await loadCopilotInstructions(configuration.copilotInstructionsProfile, (sourceFile) => copilotInstructionSourcePath(repositoryId, workspace, sourceFile));
      const file = join(workspace, instructions.targetPath);
      if (!files.includes(file)) throw new Error("缺少中央生成的Copilot说明");
      if (!matchesGeneratedCopilotInstructions(await runtimeReadFile(file, "utf8"), instructions.content)) throw new Error("Copilot说明不等于中央生成结果");
      return { state: "success" as const, detail: "Copilot说明与中央配置一致" };
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

async function resolveTagCommit(gh: GitHubClient, owner: string, repo: string, tag: string): Promise<string | null> {
  const reference = await optional(() => gh.getGitRef(owner, repo, `tags/${tag}`));
  if (!reference) return null;
  let object = reference.object;
  for (let depth = 0; depth < 5; depth++) {
    if (object.type === "commit") return sha(object.sha, "标签提交");
    if (object.type !== "tag") throw new Error(`标签对象类型无效: ${object.type}`);
    object = (await gh.getGitTag(owner, repo, object.sha)).object;
  }
  throw new Error("标签嵌套层数超过允许上限");
}

async function collectFirstParentRange(gh: GitHubClient, owner: string, repo: string, targetSha: string, releases: readonly any[], excludeTag: string): Promise<{ commits: any[]; previousRelease: any | null }> {
  const releaseByCommit = new Map<string, any>();
  for (const release of releases.filter(value => !value.draft && !value.prerelease && value.tag_name !== excludeTag)) {
    const commit = await resolveTagCommit(gh, owner, repo, release.tag_name);
    if (commit && !releaseByCommit.has(commit)) releaseByCommit.set(commit, release);
  }
  const commits: any[] = [];
  let current = targetSha;
  const seen = new Set<string>();
  for (let count = 0; count < 10_000; count++) {
    if (seen.has(current)) throw new Error("第一父提交链出现循环");
    seen.add(current);
    if (current !== targetSha && releaseByCommit.has(current)) return { commits, previousRelease: releaseByCommit.get(current) };
    const commit = await gh.getCommit(owner, repo, current);
    if (commit.sha !== current) throw new Error("提交读取结果与请求编号不一致");
    commits.push(commit);
    const parent = commit.parents?.[0]?.sha;
    if (!parent) return { commits, previousRelease: null };
    current = parent;
  }
  throw new Error("第一父提交链超过10000条，停止发布");
}

async function isFirstParentAncestor(gh: GitHubClient, owner: string, repo: string, ancestor: string, descendant: string): Promise<boolean> {
  let current = descendant;
  const seen = new Set<string>();
  for (let count = 0; count < 10_000; count++) {
    if (current === ancestor) return true;
    if (seen.has(current)) throw new Error("第一父提交链出现循环");
    seen.add(current);
    const commit = await gh.getCommit(owner, repo, current);
    const parent = commit.parents?.[0]?.sha;
    if (!parent) return false;
    current = parent;
  }
  throw new Error("第一父提交链超过10000条，停止发布");
}

async function releasePreflight(args: Readonly<Record<string, string>>) {
  const targetSha = sha(required(args, "target-sha"), "target-sha");
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  if (repositoryId !== 1187527897) throw new Error("中央发布只允许LayerScape仓库");
  const workspace = resolve(required(args, "workspace"));
  const checkedOutSha = run("git", ["rev-parse", "HEAD"], workspace).toLowerCase();
  if (checkedOutSha !== targetSha) throw new Error("工作区检出的提交与目标提交不一致");
  const profile = await json<any>(configPath("profiles", "release", "layerscape.json"));
  const versionText = await runtimeReadFile(join(workspace, profile.version.file), "utf8");
  const displayMatches = [...versionText.matchAll(new RegExp(`<${profile.version.displayElement}>([^<]+)</${profile.version.displayElement}>`, "g"))];
  const buildMatches = [...versionText.matchAll(new RegExp(`<${profile.version.buildElement}>([^<]+)</${profile.version.buildElement}>`, "g"))];
  if (displayMatches.length !== 1 || buildMatches.length !== 1) throw new Error("Version.props版本节点必须各出现一次");
  const parsed = parseVersion(displayMatches[0]![1]!, buildMatches[0]![1]!);
  const plan = planRelease({ next: parsed, targetSha });
  const globalJson = JSON.parse(await runtimeReadFile(join(workspace, "global.json"), "utf8"));
  if (globalJson.sdk?.version !== profile.build.sdkVersion || globalJson.sdk?.rollForward !== profile.build.sdkRollForward) throw new Error("global.json与中央发布配置不一致");
  for (const project of [...profile.build.projects, profile.build.deployer]) {
    try { if (!(await stat(join(workspace, project.path))).isFile()) throw new Error("不是文件"); }
    catch { throw new Error(`发布项目不存在: ${project.path}`); }
  }
  let previousTag = "无";
  let remoteState = "尚未读取";
  if (process.env.STEWARD_APP_PRIVATE_KEY) {
    const trigger = required(args, "trigger");
    if (!['app', 'manual'].includes(trigger)) throw new Error("发布触发来源无效");
    const gh = await client(repositoryId, { contents: "read", pull_requests: "read", metadata: "read", members: "read" }, policySha);
    if (trigger === "manual") {
      integer(env("TRIGGER_ACTOR_ID"), "TRIGGER_ACTOR_ID");
      const membership = await gh.getTeamMembership("splrad", "maintainers", env("TRIGGER_ACTOR_LOGIN"));
      if (membership.state !== "active") throw new Error("手工发布触发者不是Maintainers当前成员");
    }
    const repository = await gh.getRepositoryById(repositoryId);
    if (repository.full_name !== profile.repository.fullName) throw new Error("发布仓库身份不匹配");
    const defaultBranch = repository.default_branch;
    if (typeof defaultBranch !== "string" || !defaultBranch.trim()) throw new Error("发布仓库没有可用的默认分支");
    const [owner, repo] = splitRepository(repository.full_name);
    const number = integer(required(args, "pull-request-number"), "pull-request-number");
    const pull = await gh.getPullRequest(owner, repo, number);
    if (!pull.merged || pull.base.ref !== defaultBranch || pull.merge_commit_sha !== targetSha) throw new Error("发布拉取请求与目标提交不一致");
    const files = await gh.listPullFiles(owner, repo, number);
    if (!files.some((file: any) => file.filename === profile.version.file)) {
      await output({ shouldRelease: "false", targetSha, policySha });
      await summary(["状态：not-applicable", "原因：本次合并没有修改Version.props", `目标提交：${targetSha}`]);
      return;
    }
    const defaultRef = await gh.getRef(owner, repo, `heads/${defaultBranch}`);
    if (!await isFirstParentAncestor(gh, owner, repo, targetSha, defaultRef.object.sha)) throw new Error("目标提交不在当前默认分支第一父提交链中");
    const immutable = await gh.getImmutableReleaseStatus(owner, repo);
    if (immutable.enabled !== true) throw new Error("LayerScape不可变发布尚未启用");
    const releases = await gh.listReleases(owner, repo);
    const history = await collectFirstParentRange(gh, owner, repo, targetSha, releases, plan.tag);
    if (history.previousRelease) {
      previousTag = history.previousRelease.tag_name;
      const version = /^v(\d+\.\d+\.\d+)$/.exec(history.previousRelease.tag_name)?.[1];
      const priorBuild = /\((\d{8}\.\d+)\)$/.exec(history.previousRelease.name ?? "")?.[1];
      if (!version || !priorBuild) throw new Error("上一稳定发布的版本字段无效");
      planRelease({ next: parsed, previous: parseVersion(version, priorBuild), targetSha });
    }
    const tagCommit = await resolveTagCommit(gh, owner, repo, plan.tag);
    const release = releases.find((value: any) => value.tag_name === plan.tag) ?? null;
    if (Boolean(tagCommit) !== Boolean(release)) throw new Error(tagCommit ? "标签存在但发布不存在" : "发布存在但标签不存在");
    remoteState = release ? (release.draft ? "matching-state-pending-publish-check" : "published-state-pending-content-check") : "create-draft";
  }
  const assets: any[] = [];
  const expectedNames = profile.assets.map((definition: any) => definition.nameTemplate.replace("{displayVersion}", parsed.displayVersion)).sort();
  for (const definition of profile.assets) {
    const name = definition.nameTemplate.replace("{displayVersion}", parsed.displayVersion);
    const path = join(workspace, definition.pathTemplate.replace("{displayVersion}", parsed.displayVersion));
    const bytes = await optional(async () => runtimeReadFile(path));
    if (bytes) {
      if (!bytes.byteLength) throw new Error(`发布资产为空: ${name}`);
      assets.push({ name, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  if (assets.length !== 0) {
    if (assets.length !== profile.assets.length) throw new Error("发布资产只生成了部分文件");
    const assetDirectory = join(workspace, "artifacts", "ReleaseAssets");
    const actualNames = (await readdir(assetDirectory)).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error("发布资产目录不是恰好三项预期文件");
  }
  assets.sort((left, right) => left.name.localeCompare(right.name));
  const manifest = { schemaVersion: 1, repositoryId, targetSha, policySha, displayVersion: parsed.displayVersion, buildId: parsed.buildId, assets };
  await writeFile(resolve(required(args, "manifest")), JSON.stringify(manifest, null, 2) + "\n");
  await summary([`标签：${plan.tag}`, `标题：${plan.title}`, `目标提交：${targetSha}`, `上一稳定发布：${previousTag}`, `远程状态：${remoteState}`]);
  await output({ shouldRelease: "true", displayVersion: parsed.displayVersion, buildId: parsed.buildId, tag: plan.tag, title: plan.title, targetSha, policySha });
}
async function releaseNotesCommand(args: Readonly<Record<string, string>>) {
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const triggerPullRequest = integer(required(args, "pull-request-number"), "pull-request-number");
  const targetSha = sha(required(args, "target-sha"), "target-sha");
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const displayVersion = required(args, "display-version");
  parseVersion(displayVersion, "20000101.1");
  const gh = await client(repositoryId, { contents: "read", pull_requests: "read", metadata: "read" }, policySha);
  const repository = await gh.getRepositoryById(repositoryId); const [owner, repo] = splitRepository(repository.full_name);
  if (repositoryId !== 1187527897 || repository.full_name !== "splrad/LayerScape") throw new Error("发布说明仓库身份不匹配");
  if (typeof repository.default_branch !== "string" || !repository.default_branch.trim()) throw new Error("发布仓库没有可用的默认分支");
  const releases = await gh.listReleases(owner, repo);
  const history = await collectFirstParentRange(gh, owner, repo, targetSha, releases, `v${displayVersion}`);
  const range = new Set(history.commits.map(commit => commit.sha));
  const numbers = new Set<number>();
  for (const commit of history.commits) {
    for (const pull of await gh.listPullsForCommit(owner, repo, commit.sha)) {
      if (pull.merged_at && pull.base?.ref === repository.default_branch && range.has(pull.merge_commit_sha)) numbers.add(pull.number);
    }
  }
  if (!numbers.has(triggerPullRequest)) throw new Error("触发发布的拉取请求不在第一父提交范围中");
  const semantics = await semanticCatalog();
  const repositoryConfiguration = configurationFor(await catalog(), repository);
  const repositoryClassification = repositoryConfiguration.classification as RepositoryClassification;
  const profile = await json<ClassificationProfile>(configPath("profiles", "classification", `${repositoryClassification.profile}.json`));
  const rich: ClassifiedReleasePullRequest[] = [];
  for (const number of numbers) {
    const pull = await gh.getPullRequest(owner, repo, number);
    if (!pull.merged || pull.base?.ref !== repository.default_branch || !range.has(pull.merge_commit_sha)) throw new Error(`拉取请求事实与提交范围不一致: #${number}`);
    const [files, commits, labels] = await Promise.all([gh.listPullFiles(owner, repo, number), gh.listPullCommits(owner, repo, number), gh.listLabels(owner, repo, number)]);
    if (!files.length || !commits.length || Number(pull.changed_files) !== files.length || Number(pull.commits) !== commits.length) throw new Error(`拉取请求事实分页不完整: #${number}`);
    const currentLabels = labels.map((value: any) => String(value.name));
    const decision = classifyPullRequest(semantics, profile, repositoryClassification, {
      repositoryId, pullRequestNumber: number, sourceRepositoryId: Number(pull.head.repo.id), sourceRef: `refs/heads/${pull.head.ref}`, targetRef: `refs/heads/${pull.base.ref}`,
      author: { login: String(pull.user.login), type: pull.user.type as "User" | "Bot" | "Organization" | "Mannequin" }, headSha: String(pull.head.sha), baseSha: String(pull.base.sha),
      commits: commits.map((value: any) => ({ sha: String(value.sha), message: String(value.commit?.message ?? "") })),
      files: files.map((value: any) => ({ path: String(value.filename), ...(value.previous_filename ? { previousPath: String(value.previous_filename) } : {}), status: String(value.status), additions: Number(value.additions), deletions: Number(value.deletions) })),
    }, { currentLabels, stewardOwnedRiskFlags: [], stewardOwnedFacets: [] });
    rich.push({ number, title: pull.title, body: pull.body ?? "", labels: currentLabels, files: files.map((value: any) => value.filename), author: { login: pull.user.login, type: pull.user.type }, mergedAt: pull.merged_at, mergeSha: pull.merge_commit_sha, decision });
  }
  const releaseProfile = await json<any>(configPath("profiles", "release", "layerscape.json"));
  const eligible = collectReleasePullRequests(rich, releaseProfile.releaseNotes.excludedLabels);
  const categorized = categorizeReleasePullRequests(profile, eligible);
  const notes = renderReleaseNotes({ repositoryId, targetSha, policySha, displayVersion, categorized, emptyRuntimeText: releaseProfile.releaseNotes.emptyRuntimeText });
  const outputPath = resolve(required(args, "output"));
  await writeFile(outputPath, notes, "utf8");
  await summary([`发布说明：${outputPath}`, `第一父提交：${history.commits.length}`, `关联拉取请求：${rich.length}`, `纳入更新内容：${categorized.length}`, `字符数：${notes.length}`]);
}
async function releasePublish(args: Readonly<Record<string, string>>) {
  const manifest = await json<ReleaseManifest>(resolve(required(args, "manifest")));
  const profile = await json<any>(configPath("profiles", "release", "layerscape.json"));
  verifyAssetManifest(manifest, profile.assets.map((value: any) => value.nameTemplate.replace("{displayVersion}", manifest.displayVersion)));
  const [owner, repo] = splitRepository(required(args, "repository"));
  if (manifest.repositoryId !== profile.repository.id || `${owner}/${repo}` !== profile.repository.fullName) throw new Error("发布仓库与中央配置不一致");
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId: manifest.repositoryId, permissions: { contents: "write", metadata: "read" }, policySha: manifest.policySha });
  const gh = new GitHubClient(token, "https://api.github.com", fetch, manifest.policySha);
  const immutable = await gh.getImmutableReleaseStatus(owner, repo);
  if (immutable.enabled !== true) throw new Error("仓库不可变发布尚未启用");
  const tag = `v${manifest.displayVersion}`;
  const title = `AFR v${manifest.displayVersion} (${manifest.buildId})`;
  const notes = await runtimeReadFile(resolve(required(args, "notes")), "utf8");
  const marker = `<!-- steward:release-notes:v1 repository=${manifest.repositoryId} target=${manifest.targetSha} policy=${manifest.policySha} -->`;
  if (!notes.startsWith(`${marker}\n`)) throw new Error("发布说明缺少与清单一致的首行标记");
  const releases = await gh.listReleases(owner, repo);
  let release = releases.find((value: any) => value.tag_name === tag) ?? null;
  const tagCommit = await resolveTagCommit(gh, owner, repo, tag);
  const expectedNames = new Set(manifest.assets.map(asset => asset.name));
  const assetsMatch = (assets: readonly any[]) => assets.length === manifest.assets.length && manifest.assets.every(expected => {
    const actual = assets.find(value => value.name === expected.name);
    return actual?.size === expected.size && actual?.digest === `sha256:${expected.sha256}`;
  });
  const state = classifyRemoteReleaseState({
    tagExists: tagCommit !== null,
    release: release ? {
      id: release.id,
      draft: release.draft,
      prerelease: release.prerelease,
      targetMatches: tagCommit === manifest.targetSha && release.target_commitish === manifest.targetSha,
      titleMatches: release.name === title,
      markerMatches: release.body === notes,
      assetsMatch: assetsMatch(release.assets ?? []),
      hasUnexpectedAssets: (release.assets ?? []).some((asset: any) => !expectedNames.has(asset.name)),
    } : null,
  });
  if (state.state === "conflict") throw new Error(state.reason);
  if (state.state === "already-complete") {
    await output({ releaseId: release.id, releaseUrl: release.html_url });
    await summary([`发布：${release.html_url}`, `资产：${manifest.assets.length}`, "状态：already-complete"]);
    return;
  }
  if (state.state === "create-draft") release = await gh.createRelease(owner, repo, { tag_name: tag, target_commitish: manifest.targetSha, name: title, body: notes, draft: true, prerelease: false, make_latest: "true" });
  if (!release?.draft) throw new Error("没有可写入的匹配发布草稿");
  for (const asset of release.assets ?? []) await gh.deleteReleaseAsset(owner, repo, asset.id);
  for (const asset of manifest.assets) await uploadReleaseAsset({ token, policySha: manifest.policySha, uploadUrl: release.upload_url, filePath: join("release", asset.name), fileName: asset.name, expectedSha256: asset.sha256 });
  const refreshed = (await gh.listReleases(owner, repo)).find((value: any) => value.id === release.id);
  const refreshedTag = await resolveTagCommit(gh, owner, repo, tag);
  if (!refreshed?.draft || refreshed.prerelease || refreshedTag !== manifest.targetSha || refreshed.target_commitish !== manifest.targetSha || refreshed.name !== title || refreshed.body !== notes || !assetsMatch(refreshed.assets ?? [])) throw new Error("草稿上传后的远程读回与发布清单不一致");
  const published = await gh.updateRelease(owner, repo, release.id, { draft: false, prerelease: false, make_latest: "true" });
  await output({ releaseId: published.id, releaseUrl: published.html_url });
  await summary([`发布：${published.html_url}`, `资产：${manifest.assets.length}`, "状态：published"]);
}
async function releaseVerify(args: Readonly<Record<string, string>>) {
  const manifest = await json<ReleaseManifest>(resolve(required(args, "manifest")));
  const profile = await json<any>(configPath("profiles", "release", "layerscape.json"));
  verifyAssetManifest(manifest, profile.assets.map((value: any) => value.nameTemplate.replace("{displayVersion}", manifest.displayVersion)));
  const [owner, repo] = splitRepository(required(args, "repository"));
  if (manifest.repositoryId !== profile.repository.id || `${owner}/${repo}` !== profile.repository.fullName) throw new Error("发布仓库与中央配置不一致");
  const gh = await client(manifest.repositoryId, { contents: "read", metadata: "read" }, manifest.policySha);
  const tag = `v${manifest.displayVersion}`;
  const [release, latest, immutable, tagCommit] = await Promise.all([gh.getReleaseByTag(owner, repo, tag), gh.getLatestRelease(owner, repo), gh.getImmutableReleaseStatus(owner, repo), resolveTagCommit(gh, owner, repo, tag)]);
  const marker = `<!-- steward:release-notes:v1 repository=${manifest.repositoryId} target=${manifest.targetSha} policy=${manifest.policySha} -->`;
  if (immutable.enabled !== true || release.draft || release.prerelease || release.immutable !== true || tagCommit !== manifest.targetSha || release.target_commitish !== manifest.targetSha || release.name !== `AFR v${manifest.displayVersion} (${manifest.buildId})` || !String(release.body).startsWith(`${marker}\n`) || latest.id !== release.id || release.assets?.length !== manifest.assets.length) throw new Error("远程发布复核失败");
  const assetLines: string[] = [];
  for (const expected of manifest.assets) {
    const actual = release.assets.find((value: any) => value.name === expected.name);
    if (!actual || actual.size !== expected.size || actual.digest !== `sha256:${expected.sha256}`) throw new Error(`远程资产不一致: ${expected.name}`);
    assetLines.push(`资产：${expected.name}；${expected.size}字节；sha256:${expected.sha256}`);
  }
  await summary(["状态：verified", `发布：${release.html_url}`, `标签目标：${tagCommit}`, `目标提交：${manifest.targetSha}`, ...assetLines]);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const invocation = parseInvocation(argv);
  const handlers: Record<string, (args: Readonly<Record<string, string>>) => Promise<void>> = { "issue-sync": issueSync, "managed-repository-ids": listManagedRepositoryIds, "reconcile-repository-lifecycle": reconcileRepositoryLifecycle, "onboard-repository": onboard, "pr-automation": automate, "pr-classification": classify, "pr-issue-link": runPrIssueLink, "sync-copilot-instructions": syncInstructions, "sync-managed-labels": syncManagedLabels, validate, "release-preflight": releasePreflight, "release-notes": releaseNotesCommand, "release-publish": releasePublish, "release-verify": releaseVerify };
  await handlers[invocation.command]!(invocation.args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
