#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildDeterministicSummary, buildPrompt, classifyPullRequest, computePullRequestFingerprint,
  categorizeReleasePullRequests, classifyRemoteReleaseState, collectReleasePullRequests,
  isHumanActor, normalizeContributor,
  organizationPullRequestTemplate,
  parseVersion, planRelease, planRepositorySettings, reconcileManagedLabels, renderCopilotInstructions, renderManagedBody,
  renderOnboardingPullRequest, renderReleaseNotes, renderValidationSummary, runValidationTasks,
  validateGeneratedSummary, validateRepositoryForOnboarding, verifyAssetManifest,
  type AutomationFacts, type ClassificationProfile, type Contributor, type ReleaseManifest, type ValidationProfile,
} from "../../core/src/index.js";
import { createInstallationToken, dispatchWorkflow, GitHubClient, GitHubRequestError, uploadReleaseAsset } from "../../github/src/index.js";
import { minimatch } from "minimatch";
import YAML from "yaml";

const commands = new Set(["onboard-repository", "pr-automation", "pr-classification", "sync-copilot-instructions", "validate", "release-preflight", "release-notes", "release-publish", "release-verify"]);
// Repository configuration and workspace files are runtime inputs, not bundle assets.
// This wrapper keeps their paths opaque to the static asset tracer used by ncc.
const runtimeReadFile = ((path: Parameters<typeof readFile>[0], options?: Parameters<typeof readFile>[1]) =>
  Reflect.apply(readFile, undefined, options === undefined ? [path] : [path, options])) as typeof readFile;
const allowedArguments: Record<string, Set<string>> = {
  "onboard-repository": new Set(["repository-id", "repository-full-name", "trigger", "delivery-id", "policy-sha"]),
  "pr-automation": new Set(["delivery-id", "repository-id", "source-ref", "event-after-sha", "source-actor-id", "source-actor-login", "policy-sha"]),
  "pr-classification": new Set(["delivery-id", "repository-id", "pull-request-number", "event-head-sha", "scan-all", "policy-sha"]),
  "sync-copilot-instructions": new Set(["repository-id", "policy-sha"]),
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
function integer(value: string, name: string): number { if (!/^\d+$/.test(value)) throw new Error(`${name}必须是十进制整数`); return Number(value); }
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
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId, permissions, policySha });
  return new GitHubClient(token, "https://api.github.com", fetch, policySha);
}
async function summary(lines: readonly string[]): Promise<void> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) await writeFile(target, `${lines.join("\n")}\n`, { flag: "a" }); else process.stdout.write(`${lines.join("\n")}\n`);
}
async function output(values: Record<string, string | number>): Promise<void> { const target = process.env.GITHUB_OUTPUT; if (!target) return; await writeFile(target, Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}`).join("\n") + "\n", { flag: "a" }); }

interface Catalog { organization: { id: number; login: string }; defaults: { public: any; private: any }; repositories: Record<string, any> }
async function catalog(): Promise<Catalog> { return json(configPath("repositories.json")); }
function configurationFor(catalogValue: Catalog, repository: any): any {
  const override = catalogValue.repositories[String(repository.id)];
  if (override && override.fullName !== repository.full_name) throw new Error("仓库编号与中央目录名称不一致");
  return Object.freeze({ ...(repository.private ? catalogValue.defaults.private : catalogValue.defaults.public), ...(override ?? {}) });
}

async function optional<T>(operation: () => Promise<T>): Promise<T | null> { try { return await operation(); } catch (error) { if (error instanceof GitHubRequestError && error.status === 404) return null; throw error; } }
function decodeContent(value: any): string | null { return value?.encoding === "base64" && typeof value.content === "string" ? Buffer.from(value.content.replace(/\n/g, ""), "base64").toString("utf8") : null; }
async function dispatchClassification(input: { repositoryId: number; pullRequestNumber: number; headSha: string; policySha: string; deliveryId: string }) {
  const token = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), repositoryId: 1296724484, permissions: { actions: "write", metadata: "read" }, policySha: input.policySha });
  await dispatchWorkflow(new GitHubClient(token, "https://api.github.com", fetch, input.policySha), { owner: "splrad", repo: "steward", workflow: "pr-classification.yml", policySha: input.policySha, inputs: { deliveryId: input.deliveryId, repositoryId: String(input.repositoryId), pullRequestNumber: String(input.pullRequestNumber), eventHeadSha: input.headSha, policySha: input.policySha } });
}

const copilotReviewer = "copilot-pull-request-reviewer[bot]";
export function isCopilotReviewerIdentity(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\[bot\]$/u, "");
  return normalized === "copilot" || normalized === "copilot-pull-request-reviewer";
}
export function hasRequestedCopilotReviewer(requested: { users?: readonly { login?: unknown }[] }): boolean {
  return (requested.users ?? []).some(value => isCopilotReviewerIdentity(value.login));
}
export function classificationInstallationPermissions(): Parameters<typeof createInstallationToken>[0]["permissions"] {
  return { contents: "read", pull_requests: "write", issues: "write", checks: "write", metadata: "read" } as const;
}
async function hasCurrentCopilotReview(clientValue: GitHubClient, owner: string, repo: string, number: number, headSha: string): Promise<boolean> {
  const [requested, reviews] = await Promise.all([
    clientValue.getRequestedReviewers(owner, repo, number),
    clientValue.listPullRequestReviews(owner, repo, number),
  ]);
  const pending = hasRequestedCopilotReviewer(requested);
  const completed = reviews.some((value: any) =>
    isCopilotReviewerIdentity(value.user?.login)
    && String(value.commit_id ?? "").toLowerCase() === headSha.toLowerCase()
    && String(value.state ?? "").toUpperCase() !== "DISMISSED");
  return pending || completed;
}
async function ensureCopilotReview(clientValue: GitHubClient, owner: string, repo: string, number: number, headSha: string, policySha: string): Promise<"already-present" | "requested-and-confirmed"> {
  if (await hasCurrentCopilotReview(clientValue, owner, repo, number, headSha)) return "already-present";
  const reviewerClient = new GitHubClient(env("COPILOT_REVIEW_REQUEST_TOKEN"), "https://api.github.com", fetch, policySha);
  await reviewerClient.requestReviewers(owner, repo, number, [copilotReviewer]);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await hasCurrentCopilotReview(reviewerClient, owner, repo, number, headSha)) return "requested-and-confirmed";
    if (attempt < 4) await delay(2_000);
  }
  throw new Error("Copilot审查请求未能通过实时读取确认");
}
async function reconcileManagedFile(input: { repository: any; gh: GitHubClient; path: string; content: string; branch: string; title: string; policySha: string; deliveryId: string }): Promise<"unchanged" | "pull-request-created" | "pull-request-updated"> {
  const [owner, repo] = splitRepository(input.repository.full_name); const defaultBranch = input.repository.default_branch;
  const current = await optional(() => input.gh.getContent(owner, repo, input.path, defaultBranch)); if (decodeContent(current) === input.content) return "unchanged";
  const pulls = await input.gh.listPullRequests(owner, repo, `${owner}:${input.branch}`); if (pulls.length > 1) throw new Error(`受管分支存在多个拉取请求: ${input.branch}`);
  const defaultRef = await input.gh.getRef(owner, repo, `heads/${defaultBranch}`); const branchRef = await optional(() => input.gh.getRef(owner, repo, `heads/${input.branch}`));
  if (!branchRef) await input.gh.createRef(owner, repo, `refs/heads/${input.branch}`, defaultRef.object.sha);
  else if (!pulls[0] || pulls[0].user?.id !== 301115370 || pulls[0].merged_at) throw new Error(`受管分支不是Steward拥有的开放拉取请求: ${input.branch}`);
  else await input.gh.updateRef(owner, repo, `heads/${input.branch}`, defaultRef.object.sha, true);
  const existing = await optional(() => input.gh.getContent(owner, repo, input.path, input.branch));
  const put: Record<string, unknown> = { message: input.title, content: Buffer.from(input.content, "utf8").toString("base64"), branch: input.branch };
  if (existing?.sha) put.sha = existing.sha;
  const written = await input.gh.putContent(owner, repo, input.path, put);
  const generated = { type: "chore" as const, scope: "steward", title: input.title.replace(/^chore\([^)]*\):\s*/u, ""), summary: "由SPLRAD Steward同步中央管理文件并保持仓库规则与中央配置一致。", changes: [`更新${input.path}并保持中央配置为唯一人工维护来源`], reviewNotes: ["确认生成文件逐字等于中央模板并且没有仓库专用手工改动"] };
  const body = renderManagedBody({ generated, existingBody: pulls[0]?.body, templateBody: organizationPullRequestTemplate, actor: "splrad-steward[bot]", contributors: [], context: `${input.repository.id}:${input.path}:${input.policySha}` });
  const pull = pulls[0] ? await input.gh.updatePullRequest(owner, repo, pulls[0].number, { title: input.title, body }) : await input.gh.createPullRequest(owner, repo, { title: input.title, body, head: input.branch, base: defaultBranch });
  await ensureCopilotReview(input.gh, owner, repo, pull.number, written.commit.sha, input.policySha);
  await dispatchClassification({ repositoryId: input.repository.id, pullRequestNumber: pull.number, headSha: written.commit.sha, policySha: input.policySha, deliveryId: input.deliveryId });
  return pulls[0] ? "pull-request-updated" : "pull-request-created";
}

async function onboard(args: Readonly<Record<string, string>>) {
  const fullName = required(args, "repository-full-name"); const [owner, repo] = splitRepository(fullName);
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const trigger = required(args, "trigger");
  if (!["installation-created", "installation-repositories-added", "default-branch-push", "manual"].includes(trigger)) throw new Error("接入触发来源无效");
  if (trigger !== "manual" && !args["repository-id"]) throw new Error("事件接入必须提供仓库编号");
  let repositoryId = args["repository-id"] ? integer(args["repository-id"], "repository-id") : 0;
  if (!repositoryId) {
    const discoveryToken = await createInstallationToken({ appId: env("APP_ID"), privateKey: env("STEWARD_APP_PRIVATE_KEY"), installationId: integer(env("INSTALLATION_ID"), "INSTALLATION_ID"), permissions: { metadata: "read" }, policySha });
    const discovered = await new GitHubClient(discoveryToken, "https://api.github.com", fetch, policySha).getRepository(owner, repo);
    repositoryId = discovered.id;
  }
  const gh = await client(repositoryId, { administration: "write", contents: "write", pull_requests: "write", metadata: "read", members: "read" }, policySha);
  const repository = await gh.getRepositoryById(repositoryId); const cfg = configurationFor(await catalog(), repository);
  if (repository.full_name !== fullName) throw new Error("仓库编号与完整名称不一致");
  const state = validateRepositoryForOnboarding({ id: repository.id, fullName: repository.full_name, ownerId: repository.owner.id, visibility: repository.private ? "private" : "public", fork: repository.fork, archived: repository.archived, disabled: repository.disabled, defaultBranch: repository.default_branch }, 302208797, cfg);
  const defaultRef = await optional(() => gh.getRef(owner, repo, `heads/${repository.default_branch}`));
  if (state === "waiting-for-default-branch" || !defaultRef) return summary([`仓库：${fullName}`, "状态：等待首次默认分支推送"]);
  if (trigger === "manual") {
    const actorLogin = env("TRIGGER_ACTOR_LOGIN");
    integer(env("TRIGGER_ACTOR_ID"), "TRIGGER_ACTOR_ID");
    const membership = await gh.getTeamMembership("splrad", "maintainers", actorLogin);
    if (membership.state !== "active") throw new Error("手工接入触发者不是Maintainers当前成员");
  }
  const teams = await gh.listRepositoryTeams(owner, repo);
  if (!teams.some((team: any) => team.slug === "maintainers" && ["maintain", "admin"].includes(team.permission))) throw new Error("Maintainers没有获得仓库维护权限");
  const rulesets = await gh.listRepositoryRulesets(owner, repo);
  if (!rulesets.some((ruleset: any) => ruleset.id === 18883080 && ruleset.enforcement === "active")) throw new Error("组织默认分支规则集没有对仓库生效");
  const settings = planRepositorySettings();
  await gh.updateRepository(owner, repo, settings);
  const readback = await gh.getRepositoryById(repositoryId);
  for (const [name, value] of Object.entries(settings)) if (readback[name] !== value) throw new Error(`仓库设置读回不一致: ${name}`);
  const common = await runtimeReadFile(configPath("copilot", "common.md"), "utf8");
  const project = cfg.copilotInstructionsProfile === "layerscape" ? await runtimeReadFile(configPath("copilot", "layerscape.md"), "utf8") : null;
  const rendered = renderCopilotInstructions(common, project);
  const planned = renderOnboardingPullRequest({ template: organizationPullRequestTemplate, configuration: cfg, actor: "splrad-steward[bot]", context: `onboard:${repositoryId}` });
  const result = await reconcileManagedFile({ repository, gh, path: ".github/copilot-instructions.md", content: rendered, branch: planned.branch, title: planned.title, policySha, deliveryId: required(args, "delivery-id") });
  await summary([`仓库：${fullName}`, `状态：${result === "unchanged" ? "onboarded" : result}`, `接入分支：${planned.branch}`, `分类配置：${cfg.classificationProfile}`, `验证配置：${cfg.validationProfile}`, `Copilot说明配置：${cfg.copilotInstructionsProfile}`, `发布配置：${cfg.releaseProfile ?? "未启用"}`, `Copilot说明字符数：${[...rendered].length}`]);
}
function summaryStartTemplate() { return "<!-- workflow:auto-summary:start -->"; }
function summaryEndTemplate() { return "<!-- workflow:auto-summary:end -->"; }

async function automate(args: Readonly<Record<string, string>>) {
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const sourceRef = required(args, "source-ref"); if (!sourceRef.startsWith("refs/heads/")) throw new Error("source-ref必须使用refs/heads/格式");
  const eventAfterSha = sha(required(args, "event-after-sha"), "event-after-sha");
  const sourceActor = { id: integer(required(args, "source-actor-id"), "source-actor-id"), login: required(args, "source-actor-login"), type: "User" };
  if (!isHumanActor(sourceActor)) throw new Error("来源推送者不是有效真人账号");
  const gh = await client(repositoryId, { contents: "read", pull_requests: "write", metadata: "read" }, policySha);
  const repository = await gh.getRepositoryById(repositoryId); const [owner, repo] = splitRepository(repository.full_name);
  const repositoryConfiguration = configurationFor(await catalog(), repository);
  if (!repositoryConfiguration.managed || !repositoryConfiguration.prAutomation) return summary(["状态：ignored", "原因：仓库没有启用中央拉取请求创建"]);
  const sourceBranch = sourceRef.slice("refs/heads/".length); if (sourceBranch === repository.default_branch) return summary(["状态：ignored", "原因：默认分支推送不创建拉取请求"]);
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
    const normalized = commit.author ? normalizeContributor({ ...commit.author, name: commit.commit?.author?.name, email: commit.commit?.author?.email }) : null;
    if (normalized) contributorMap.set(normalized.id, normalized);
  }
  const contributors = [...contributorMap.values()];
  const files = (compare.files ?? []).map((file: any) => file.filename);
  const facts: AutomationFacts = { sourceRef, targetRef: `refs/heads/${repository.default_branch}`, headSha: sourceBefore.object.sha, baseSha: baseBefore.object.sha, commitSubjects: (compare.commits ?? []).map((c: any) => c.commit.message.split("\n")[0]), files, diffStat: `${files.length}个文件`, diffExcerpt: (compare.files ?? []).map((file: any) => file.patch ?? "").join("\n"), areas: [], contributors };
  const fallback = buildDeterministicSummary(facts); let generated = fallback; let mode = "deterministic";
  if (process.env.PREPARE_ONLY === "true") {
    const promptPath = env("PR_COPILOT_PROMPT_PATH");
    const preparedFactsPath = env("PR_PREPARED_FACTS_PATH");
    await writeFile(promptPath, buildPrompt(facts, fallback));
    await writeFile(preparedFactsPath, JSON.stringify({ repositoryId, sourceRef, headSha: facts.headSha, baseSha: facts.baseSha, policySha }) + "\n");
    await summary(["状态：prepared", `来源提交：${facts.headSha}`, `提示文件：${basename(promptPath)}`]);
    return;
  }
  const copilotOutput = process.env.COPILOT_OUTPUT_PATH;
  if (copilotOutput && process.env.PR_PREPARED_FACTS_PATH) {
    try {
      const prepared = JSON.parse(await runtimeReadFile(process.env.PR_PREPARED_FACTS_PATH, "utf8"));
      if (prepared.repositoryId !== repositoryId || prepared.sourceRef !== sourceRef || prepared.headSha !== facts.headSha || prepared.baseSha !== facts.baseSha || prepared.policySha !== policySha) throw new Error("人工智能输入对应的分支事实已经漂移");
      generated = validateGeneratedSummary(JSON.parse(await runtimeReadFile(copilotOutput, "utf8")));
      mode = "copilot";
    } catch { generated = fallback; }
  }
  const template = process.env.PR_TEMPLATE_PATH ? await runtimeReadFile(process.env.PR_TEMPLATE_PATH, "utf8") : organizationPullRequestTemplate;
  const title = `${generated.type}(${generated.scope}): ${generated.title}`;
  const context = await computePullRequestFingerprint({ repositoryId, pullRequestNumber: pulls[0]?.number ?? 0, headSha: facts.headSha, baseSha: facts.baseSha, commits: (compare.commits ?? []).map((c: any) => c.sha), files: (compare.files ?? []).map((f: any) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })), title, body: "", contributors });
  const body = renderManagedBody({ generated, existingBody: pulls[0]?.body, templateBody: template, actor: sourceActor.login, contributors, context });
  const pull = pulls[0] ? await gh.updatePullRequest(owner, repo, pulls[0].number, { title, body }) : await gh.createPullRequest(owner, repo, { title, body, head: sourceBranch, base: repository.default_branch });
  await output({ pullRequestNumber: pull.number, headSha: facts.headSha, repositoryFullName: repository.full_name });
  const copilot = await ensureCopilotReview(gh, owner, repo, pull.number, facts.headSha, policySha);
  await dispatchClassification({ repositoryId, pullRequestNumber: pull.number, headSha: facts.headSha, policySha, deliveryId: required(args, "delivery-id") });
  await summary([`状态：${pulls[0] ? "updated" : "created"}`, `拉取请求：#${pull.number}`, `来源提交：${facts.headSha}`, `事件提交：${eventAfterSha}`, `标题生成：${mode}`, `Copilot审查：${copilot}`]);
  if (process.env.PR_COPILOT_PROMPT_PATH) await writeFile(process.env.PR_COPILOT_PROMPT_PATH, buildPrompt(facts, fallback));
}

async function classify(args: Readonly<Record<string, string>>) {
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  if (args["scan-all"] === "true") {
    if (args["pull-request-number"] || args["event-head-sha"]) throw new Error("全量分类不能同时指定单个拉取请求");
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
  const expectedHead = sha(required(args, "event-head-sha"), "event-head-sha"); const gh = await client(repositoryId, classificationInstallationPermissions(), policySha);
  const repository = await gh.getRepositoryById(repositoryId); const [owner, repo] = splitRepository(repository.full_name);
  const same = (await gh.listAllCheckRuns(owner, repo, expectedHead)).filter((value: any) => value.name === "PR Classification Gate" && value.app?.id === 4243096);
  if (same.length > 1) throw new Error("同名分类检查存在歧义");
  const started = { name: "PR Classification Gate", head_sha: expectedHead, status: "in_progress", external_id: `${repositoryId}:${number}:${expectedHead}:pending`, output: { title: "正在计算拉取请求分类", summary: `来源提交：${expectedHead}\n中央规则：${policySha}` } };
  const check = same[0]
    ? await gh.updateCheckRun(owner, repo, same[0].id, { name: started.name, status: started.status, external_id: started.external_id, output: started.output })
    : await gh.createCheckRun(owner, repo, started);
  try {
    const pull = await gh.getPullRequest(owner, repo, number);
    if (pull.head.sha !== expectedHead) throw new Error("拉取请求来源提交已经漂移");
    const cfg = configurationFor(await catalog(), repository);
    if (!cfg.managed) throw new Error("仓库没有启用中央分类");
    const profile = await json<ClassificationProfile>(configPath("profiles", "classification", `${cfg.classificationProfile}.json`));
    const [files, commits, labels] = await Promise.all([gh.listPullFiles(owner, repo, number), gh.listPullCommits(owner, repo, number), gh.listLabels(owner, repo, number)]);
    if (!files.length || !commits.length) throw new Error("提交或文件分页结果为空");
    const result = classifyPullRequest(profile, { title: pull.title, body: pull.body ?? "", files: files.map((value: any) => value.filename), currentLabels: labels.map((value: any) => value.name) });
    const plan = reconcileManagedLabels(profile, labels.map((value: any) => value.name), result);
    const currentBeforeWrite = await gh.getPullRequest(owner, repo, number);
    if (currentBeforeWrite.head.sha !== expectedHead) throw new Error("写入标签前来源提交已经漂移");
    for (const definition of plan.ensure) {
      const existing = await optional(() => gh.getLabel(owner, repo, definition.name));
      if (!existing) await gh.createLabel(owner, repo, definition);
      else if (existing.color.toLowerCase() !== definition.color.toLowerCase() || existing.description !== definition.description) await gh.updateLabel(owner, repo, definition.name, definition);
    }
    await gh.setLabels(owner, repo, number, [...plan.keep, ...result.publicLabels]);
    const currentAfterWrite = await gh.getPullRequest(owner, repo, number);
    if (currentAfterWrite.head.sha !== expectedHead || currentAfterWrite.base.sha !== pull.base.sha || currentAfterWrite.title !== pull.title || (currentAfterWrite.body ?? "") !== (pull.body ?? "")) throw new Error("分类输入在写入期间已经漂移");
    const contributors = commits.map((commit: any) => commit.author ? normalizeContributor({ ...commit.author, name: commit.commit?.author?.name, email: commit.commit?.author?.email }) : null).filter(Boolean) as Contributor[];
    const fingerprint = await computePullRequestFingerprint({ repositoryId, pullRequestNumber: number, headSha: expectedHead, baseSha: pull.base.sha, commits: commits.map((value: any) => value.sha), files: files.map((value: any) => ({ path: value.filename, status: value.status, additions: value.additions, deletions: value.deletions })), title: pull.title, body: pull.body ?? "", contributors });
    await gh.updateCheckRun(owner, repo, check.id, { name: "PR Classification Gate", status: "completed", conclusion: "success", external_id: `${repositoryId}:${number}:${expectedHead}:${fingerprint}`, output: { title: "拉取请求分类完成", summary: `区域：${result.areas.join("、") || "无"}\n类型：${result.kind}\n标签：${result.publicLabels.join("、")}\n输入摘要：${fingerprint}` } });
    await summary([`拉取请求：#${number}`, `来源提交：${expectedHead}`, `分类：${result.kind}`, `标签：${result.publicLabels.join("、")}`, `输入摘要：${fingerprint}`]);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 60_000);
    await gh.updateCheckRun(owner, repo, check.id, { name: "PR Classification Gate", status: "completed", conclusion: "failure", external_id: `${repositoryId}:${number}:${expectedHead}:failure`, output: { title: "拉取请求分类失败", summary: message } });
    await summary([`拉取请求：#${number}`, `来源提交：${expectedHead}`, "状态：failure", `原因：${message}`]);
    throw error;
  }
}

async function syncInstructions(args: Readonly<Record<string, string>>) {
  const policySha = sha(required(args, "policy-sha"), "policy-sha");
  const selected = args["repository-id"] ? [integer(args["repository-id"], "repository-id")] : Object.keys((await catalog()).repositories).map(Number);
  const common = await runtimeReadFile(configPath("copilot", "common.md"), "utf8");
  for (const id of selected) { const cat = await catalog(); const cfg = cat.repositories[String(id)]; if (!cfg) throw new Error(`未知仓库编号: ${id}`); const project = cfg.copilotInstructionsProfile === "layerscape" ? await runtimeReadFile(configPath("copilot", "layerscape.md"), "utf8") : null; const rendered = renderCopilotInstructions(common, project); const gh = await client(id, { contents: "write", pull_requests: "write", metadata: "read" }, policySha); const repository = await gh.getRepositoryById(id); const result = await reconcileManagedFile({ repository, gh, path: ".github/copilot-instructions.md", content: rendered, branch: "steward/copilot-instructions", title: "chore(copilot): 同步中文代码审查说明", policySha, deliveryId: `manual-sync:${id}` }); await summary([`仓库：${cfg.fullName}`, `状态：${result}`, `字符数：${[...rendered].length}`]); }
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
async function validate(args: Readonly<Record<string, string>>) {
  const workspace = resolve(required(args, "workspace"));
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const catalogValue = await catalog();
  const configuration = catalogValue.repositories[String(repositoryId)] ?? catalogValue.defaults.public;
  if (!configuration?.managed) throw new Error("仓库没有启用中央验证");
  const profileName = required(args, "profile");
  if (profileName !== configuration.validationProfile) throw new Error("验证配置与中央仓库目录不一致");
  const profile = await json<ValidationProfile>(configPath("profiles", "validation", `${profileName}.json`));
  const files = await walk(workspace);
  const relative = files.map(path => path.slice(workspace.length + 1).replace(/\\/g, "/"));
  const actualWorkflows = relative.filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)).sort();
  const allowedWorkflows = [...configuration.allowedWorkflowPaths].sort();
  if (JSON.stringify(actualWorkflows) !== JSON.stringify(allowedWorkflows)) throw new Error(`仓库工作流超出中央允许范围: ${actualWorkflows.join(", ") || "无"}`);
  const results = await runValidationTasks(profile, async task => {
    if (task === "git-diff-check") {
      const base = process.env.VALIDATION_BASE_SHA;
      run("git", base ? ["diff", "--check", `${sha(base, "VALIDATION_BASE_SHA")}...HEAD`] : ["diff", "--check"], workspace);
      return { state: "success" as const, detail: "未发现空白错误" };
    }
    if (task === "parse-json") { for (const file of files.filter(path => path.endsWith(".json"))) JSON.parse(await runtimeReadFile(file, "utf8")); return { state: "success" as const, detail: "JSON有效" }; }
    if (task === "parse-yaml") { for (const file of files.filter(path => /\.ya?ml$/.test(path))) YAML.parse(await runtimeReadFile(file, "utf8")); return { state: "success" as const, detail: "YAML有效" }; }
    if (task === "verify-copilot-instructions") {
      const file = join(workspace, ".github/copilot-instructions.md");
      if (!files.includes(file)) throw new Error("缺少中央生成的Copilot说明");
      const common = await runtimeReadFile(configPath("copilot", "common.md"), "utf8");
      const project = configuration.copilotInstructionsProfile === "layerscape" ? await runtimeReadFile(configPath("copilot", "layerscape.md"), "utf8") : null;
      if (await runtimeReadFile(file, "utf8") !== renderCopilotInstructions(common, project)) throw new Error("Copilot说明不等于中央生成结果");
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
  const rich: any[] = [];
  for (const number of numbers) {
    const pull = await gh.getPullRequest(owner, repo, number);
    if (!pull.merged || pull.base?.ref !== repository.default_branch || !range.has(pull.merge_commit_sha)) throw new Error(`拉取请求事实与提交范围不一致: #${number}`);
    const [files, labels] = await Promise.all([gh.listPullFiles(owner, repo, number), gh.listLabels(owner, repo, number)]);
    if (!files.length) throw new Error(`拉取请求文件读取为空: #${number}`);
    rich.push({ number, title: pull.title, body: pull.body ?? "", labels: labels.map((value: any) => value.name), files: files.map((value: any) => value.filename), author: { login: pull.user.login, type: pull.user.type }, mergedBy: pull.merged_by?.login ?? null, mergedAt: pull.merged_at, mergeSha: pull.merge_commit_sha });
  }
  const profile = await json<ClassificationProfile>(configPath("profiles", "classification", "layerscape.json"));
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
  const handlers: Record<string, (args: Readonly<Record<string, string>>) => Promise<void>> = { "onboard-repository": onboard, "pr-automation": automate, "pr-classification": classify, "sync-copilot-instructions": syncInstructions, validate, "release-preflight": releasePreflight, "release-notes": releaseNotesCommand, "release-publish": releasePublish, "release-verify": releaseVerify };
  await handlers[invocation.command]!(invocation.args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
