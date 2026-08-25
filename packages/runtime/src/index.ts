import { isIssueCapableRepository, isStewardOwnedPullRequest } from "../../core/src/issues.js";
import { createAppJwt, createInstallationToken, dispatchWorkflow, GitHubClient } from "../../github/src/index.js";
import repositoryCatalog from "../../../config/repositories.json" with { type: "json" };
import { handleIssueSnapshotInternalRequest, IssueSnapshotStore } from "./issue-snapshots.js";
import { confirmPullRequestBodyWriteIntent, processPullRequestBodyEditedDelivery, PullRequestBodyWriteIntentStore, type PullRequestBodyWriteIntent } from "./pr-body-write-intents.js";

export interface Env {
  ORGANIZATION_ID: string; ORGANIZATION_LOGIN: string; APP_ID: string; INSTALLATION_ID: string;
  STEWARDSHIP_REPOSITORY: string; POLICY_SHA: string; STEWARD_APP_PRIVATE_KEY?: string; STEWARD_WEBHOOK_SECRET?: string;
  ISSUE_SNAPSHOTS?: D1Database;
  CF_VERSION_METADATA?: { id: string };
}

const MAX_BODY = 10 * 1024 * 1024;
const ZERO_SHA = "0".repeat(40);
const VALIDATION_WORKFLOW_NAME = "SPLRAD Steward / PR Validation";
const VALIDATION_WORKFLOW_PATH = ".github/workflows/pr-validation.yml";
const VALIDATION_CHECK_NAME = "PR Validation Gate";
const BODY_WRITE_REDRIVE_RETRY_MS = 2 * 60 * 60_000;
const ISSUE_RECONCILIATION_RETRY_MS = 75 * 60_000;
const ISSUE_LINK_WORKFLOW_NAME = "SPLRAD Steward / PR Issue Link";
const ISSUE_LINK_WORKFLOW_FILE = "pr-issue-link.yml";
const ISSUE_LINK_WORKFLOW_PATH = `.github/workflows/${ISSUE_LINK_WORKFLOW_FILE}`;
const ACTIVE_WORKFLOW_RUN_STATUSES = ["queued", "in_progress", "waiting", "pending", "requested"] as const;
const ISSUE_SNAPSHOT_DELETE_ATTEMPTS = 3;

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? undefined : { "Content-Type": "application/json; charset=utf-8" } });
}
function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let result = 0; for (let i = 0; i < left.length; i++) result |= left[i]! ^ right[i]!; return result === 0; }
function hex(value: string): Uint8Array { if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) return new Uint8Array(); return Uint8Array.from(value.match(/../g) ?? [], item => Number.parseInt(item, 16)); }
export async function verifyWebhookSignature(body: ArrayBuffer, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return timingSafeEqual(signature, hex(header.slice(7)));
}

async function dispatcher(env: Env): Promise<GitHubClient> {
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const token = await createInstallationToken({ appId: env.APP_ID, privateKey: env.STEWARD_APP_PRIVATE_KEY, installationId: Number(env.INSTALLATION_ID), repositoryId: 1296724484, permissions: { actions: "write", metadata: "read" }, policySha: env.POLICY_SHA });
  return new GitHubClient(token, "https://api.github.com", fetch, env.POLICY_SHA);
}
async function sendWithClient(env: Env, client: GitHubClient, workflow: string, inputs: Record<string, string>) { const [owner, repo] = env.STEWARDSHIP_REPOSITORY.split("/") as [string, string]; await dispatchWorkflow(client, { owner, repo, workflow, policySha: env.POLICY_SHA, inputs }); }
async function send(env: Env, workflow: string, inputs: Record<string, string>) { await sendWithClient(env, await dispatcher(env), workflow, inputs); }

function issueReconciliationRunName(repositoryId: number, generation: number): string {
  return `PR Issue Link / repository=${repositoryId} / generation=${generation}`;
}

function issueLinkWorkflowRunPath(value: unknown): boolean {
  return value === ISSUE_LINK_WORKFLOW_PATH || (typeof value === "string" && value.startsWith(`${ISSUE_LINK_WORKFLOW_PATH}@`) && value.length > ISSUE_LINK_WORKFLOW_PATH.length + 1);
}

async function activeIssueReconciliationRuns(env: Env, client: GitHubClient): Promise<ReadonlySet<string>> {
  const [owner, repo] = env.STEWARDSHIP_REPOSITORY.split("/") as [string, string];
  const pages = await Promise.all(ACTIVE_WORKFLOW_RUN_STATUSES.map(status => client.paginate<any>(
    `/repos/${owner}/${repo}/actions/workflows/${ISSUE_LINK_WORKFLOW_FILE}/runs?event=workflow_dispatch&status=${status}&per_page=100`,
    value => {
      const runs = (value as any)?.workflow_runs;
      if (!Array.isArray(runs)) throw new Error("议题关联工作流运行列表无效");
      return runs;
    },
    { maxPages: 20, maxItems: 2_000 },
  )));
  const names = new Set<string>();
  for (const run of pages.flat()) {
    if (!Number.isSafeInteger(run?.id) || run.id <= 0 || run?.name !== ISSUE_LINK_WORKFLOW_NAME || run?.event !== "workflow_dispatch"
      || !ACTIVE_WORKFLOW_RUN_STATUSES.includes(run?.status) || run?.conclusion !== null
      || run?.repository?.full_name !== `${owner}/${repo}` || typeof run?.display_title !== "string"
      || !issueLinkWorkflowRunPath(run?.path)) {
      throw new Error("议题关联工作流运行身份无效");
    }
    names.add(run.display_title);
  }
  return names;
}

async function bodyWriteClient(env: Env, repositoryId: number): Promise<GitHubClient> {
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const token = await createInstallationToken({ appId: env.APP_ID, privateKey: env.STEWARD_APP_PRIVATE_KEY, installationId: Number(env.INSTALLATION_ID), repositoryId,
    permissions: { issues: "read", metadata: "read", pull_requests: "write" }, policySha: env.POLICY_SHA });
  return new GitHubClient(token, "https://api.github.com", fetch, env.POLICY_SHA);
}

function splitRepository(fullName: string): [string, string] {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("仓库完整名称无效");
  return parts as [string, string];
}
function commitSha(value: unknown): string | null {
  const normalized = String(value ?? "").toLowerCase();
  return /^[0-9a-f]{40}$/u.test(normalized) ? normalized : null;
}
export function validationConclusion(value: unknown): "success" | "failure" | null {
  if (value === "success") return "success";
  if (["action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "timed_out"].includes(String(value))) return "failure";
  return null;
}
type ValidationCheckState = Readonly<{ runId: number | null; attempt: number | null; pending: boolean }>;
type ValidationCheck = Readonly<{ check: any; state: ValidationCheckState }>;

function validationCheckState(externalId: unknown, repositoryId: number, pullRequestNumber: number, headSha: string): ValidationCheckState | null {
  const value = String(externalId ?? "");
  const prefix = `${repositoryId}:${pullRequestNumber}:${headSha}:`;
  if (value === `${prefix}pending`) return { runId: null, attempt: null, pending: true };
  if (!value.startsWith(prefix)) return null;
  const parts = value.slice(prefix.length).split(":");
  if (parts.length !== 2 && !(parts.length === 3 && parts[2] === "pending")) return null;
  const runId = Number(parts[0]); const attempt = Number(parts[1]);
  if (!Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(attempt) || attempt <= 0) return null;
  return { runId, attempt, pending: parts.length === 3 };
}
function validationChecksForPull(checkRuns: readonly any[], headSha: string, appId: number, repositoryId: number, pullRequestNumber: number): ValidationCheck[] {
  const matches: ValidationCheck[] = [];
  for (const check of checkRuns) {
    if (check?.name !== VALIDATION_CHECK_NAME
      || Number(check.app?.id) !== appId
      || commitSha(check.head_sha) !== headSha
      || !Number.isSafeInteger(check.id)
      || check.id <= 0) continue;
    const state = validationCheckState(check.external_id, repositoryId, pullRequestNumber, headSha);
    if (state) matches.push({ check, state });
  }
  return matches;
}
async function validationClient(env: Env, repositoryId: number): Promise<GitHubClient> {
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const token = await createInstallationToken({
    appId: env.APP_ID,
    privateKey: env.STEWARD_APP_PRIVATE_KEY,
    installationId: Number(env.INSTALLATION_ID),
    repositoryId,
    permissions: { actions: "read", checks: "write", metadata: "read", pull_requests: "read" },
    policySha: env.POLICY_SHA,
  });
  return new GitHubClient(token, "https://api.github.com", fetch, env.POLICY_SHA);
}
async function ensureValidationPending(env: Env, repository: any, pull: any): Promise<void> {
  const headSha = commitSha(pull?.head?.sha); const number = Number(pull?.number);
  if (!headSha || !Number.isSafeInteger(number) || number <= 0) throw new Error("拉取请求验证输入无效");
  const [owner, repo] = splitRepository(String(repository.full_name));
  const gh = await validationClient(env, Number(repository.id));
  const current = validationChecksForPull(await gh.listAllCheckRuns(owner, repo, headSha), headSha, Number(env.APP_ID), Number(repository.id), number);
  if (current.length) return;
  await gh.createCheckRun(owner, repo, {
    name: VALIDATION_CHECK_NAME,
    head_sha: headSha,
    status: "in_progress",
    external_id: `${repository.id}:${number}:${headSha}:pending`,
    output: { title: "正在等待中央拉取请求验证", summary: `拉取请求：#${number}\n来源提交：${headSha}` },
  });
}
function trustedValidationRun(run: any, repository: any): boolean {
  const [owner, repo] = splitRepository(String(repository.full_name));
  const status = String(run?.status ?? ""); const conclusion = validationConclusion(run?.conclusion);
  return Number.isSafeInteger(run?.id) && run.id > 0
    && Number.isSafeInteger(run?.workflow_id) && run.workflow_id > 0
    && Number.isSafeInteger(run?.run_attempt) && run.run_attempt > 0
    && run?.repository?.id === repository.id
    && run?.name === VALIDATION_WORKFLOW_NAME
    && run?.path === VALIDATION_WORKFLOW_PATH
    && run?.event === "pull_request"
    && ["queued", "in_progress", "completed"].includes(status)
    && (status === "completed" ? conclusion !== null : run?.conclusion == null)
    && commitSha(run?.head_sha) !== null
    && run?.workflow_url === `https://api.github.com/repos/${owner}/${repo}/actions/required_workflows/${run.workflow_id}`
    && typeof run?.html_url === "string";
}
function completedValidationIdentity(repositoryId: number, pullRequestNumber: number, headSha: string, runId: number, attempt: number): string {
  return `${repositoryId}:${pullRequestNumber}:${headSha}:${runId}:${attempt}`;
}
function compareValidationState(state: ValidationCheckState, runId: number, attempt: number, incomingCompleted: boolean): "older" | "same" | "newer" {
  if (state.runId === null || state.attempt === null) return "older";
  if (state.runId !== runId) return state.runId > runId ? "newer" : "older";
  if (state.attempt !== attempt) return state.attempt > attempt ? "newer" : "older";
  if (!state.pending && !incomingCompleted) return "newer";
  if (state.pending && incomingCompleted) return "older";
  return "same";
}
async function publishValidationState(env: Env, repository: any, workflowRunId: unknown): Promise<boolean> {
  const runId = Number(workflowRunId);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("工作流运行编号无效");
  const [owner, repo] = splitRepository(String(repository.full_name));
  const gh = await validationClient(env, Number(repository.id));
  const run = await gh.getWorkflowRun(owner, repo, runId);
  if (!trustedValidationRun(run, repository)) return false;
  const headSha = commitSha(run.head_sha)!;
  const pulls = (await gh.listPullsForCommit(owner, repo, headSha)).filter((pull: any) =>
    pull?.state === "open" && pull?.base?.ref === repository.default_branch && commitSha(pull?.head?.sha) === headSha);
  if (!pulls.length) return false;
  if (pulls.length > 1) return false;
  const pull = pulls[0]!; const number = Number(pull.number);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("拉取请求编号无效");
  const checks = validationChecksForPull(await gh.listAllCheckRuns(owner, repo, headSha), headSha, Number(env.APP_ID), Number(repository.id), number);
  const conclusion = validationConclusion(run.conclusion); const completed = run.status === "completed";
  const comparisons = checks.map(value => compareValidationState(value.state, run.id, run.run_attempt, completed));
  if (comparisons.includes("newer")) return false;
  const body: Record<string, unknown> = {
    name: VALIDATION_CHECK_NAME,
    head_sha: headSha,
    status: completed ? "completed" : "in_progress",
    details_url: run.html_url,
    external_id: completed ? completedValidationIdentity(Number(repository.id), number, headSha, run.id, run.run_attempt) : `${completedValidationIdentity(Number(repository.id), number, headSha, run.id, run.run_attempt)}:pending`,
    output: completed
      ? { title: conclusion === "success" ? "中央拉取请求验证通过" : "中央拉取请求验证失败", summary: `拉取请求：#${number}\n来源提交：${headSha}\n源工作流运行：${run.id}\n源结论：${run.conclusion}` }
      : { title: "中央拉取请求验证正在运行", summary: `拉取请求：#${number}\n来源提交：${headSha}\n源工作流运行：${run.id}` },
  };
  if (completed) body.conclusion = conclusion;
  const outdatedChecks = checks.filter((_value, index) => comparisons[index] === "older");
  if (!checks.length) await gh.createCheckRun(owner, repo, body);
  else if (!outdatedChecks.length) return false;
  else for (const { check } of outdatedChecks) await gh.updateCheckRun(owner, repo, check.id, body);
  return true;
}

async function pullRequestChangesVersion(env: Env, repository: any, pullRequestNumber: number): Promise<boolean> {
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const [owner, repo] = String(repository.full_name).split("/") as [string, string];
  const token = await createInstallationToken({ appId: env.APP_ID, privateKey: env.STEWARD_APP_PRIVATE_KEY, installationId: Number(env.INSTALLATION_ID), repositoryId: Number(repository.id), permissions: { metadata: "read", pull_requests: "read" }, policySha: env.POLICY_SHA });
  const files = await new GitHubClient(token, "https://api.github.com", fetch, env.POLICY_SHA).listPullFiles(owner, repo, pullRequestNumber);
  return files.some(file => file?.filename === "Version.props");
}

async function requestMaintainersReview(env: Env, repository: any, pull: any): Promise<boolean> {
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const pullNumber = Number(pull?.number);
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error("拉取请求编号无效");
  const [owner, repo] = splitRepository(String(repository.full_name));
  const token = await createInstallationToken({ appId: env.APP_ID, privateKey: env.STEWARD_APP_PRIVATE_KEY, installationId: Number(env.INSTALLATION_ID), repositoryId: Number(repository.id), permissions: { metadata: "read", pull_requests: "write" }, policySha: env.POLICY_SHA });
  const gh = new GitHubClient(token, "https://api.github.com", fetch, env.POLICY_SHA);
  const includesMaintainers = (teams: readonly any[]) => teams.some(team => String(team?.slug ?? "").toLowerCase() === "maintainers");
  if (includesMaintainers((await gh.getRequestedReviewers(owner, repo, pullNumber))?.teams ?? [])) return false;
  const updatedPull = await gh.requestTeamReviewers(owner, repo, pullNumber, ["maintainers"]);
  if (!includesMaintainers(updatedPull?.requested_teams ?? [])) throw new Error("Maintainers审查请求未能通过创建响应确认");
  return true;
}

function validScope(payload: any, env: Env): boolean {
  const organizationId = payload.organization?.id ?? payload.installation?.account?.id ?? payload.repository?.owner?.id;
  const installationId = payload.installation?.id;
  return organizationId === Number(env.ORGANIZATION_ID) && (!installationId || installationId === Number(env.INSTALLATION_ID));
}
function repositoryInputs(repository: any) { return { repositoryId: String(repository.id), repositoryFullName: String(repository.full_name) }; }
function repositoryConfiguration(repository: any): any {
  const override = (repositoryCatalog.repositories as Record<string, any>)[String(repository.id)];
  if (override?.fullName && override.fullName !== repository.full_name) throw new Error("仓库编号与中央目录名称不一致");
  return { ...(repository.private ? repositoryCatalog.defaults.private : repositoryCatalog.defaults.public), ...(override ?? {}) };
}
function belongsToOrganization(repository: any): boolean {
  if (!Number.isSafeInteger(repository?.id) || repository.id <= 0 || typeof repository.full_name !== "string") return false;
  const parts = repository.full_name.split("/");
  if (parts.length !== 2 || !parts[1] || parts[0]!.toLowerCase() !== repositoryCatalog.organization.login.toLowerCase()) return false;
  if (repository.owner?.id !== undefined && repository.owner.id !== Number(repositoryCatalog.organization.id)) return false;
  if (repository.owner?.login !== undefined && String(repository.owner.login).toLowerCase() !== repositoryCatalog.organization.login.toLowerCase()) return false;
  return true;
}
function isManaged(repository: any): boolean { return belongsToOrganization(repository) && repositoryConfiguration(repository).managed === true; }
function isIssueCapable(repository: any): boolean { return isIssueCapableRepository(repository, isManaged(repository)); }

function repositoryBeforeEdit(repository: any, changes: any): any {
  const previousVisibility = changes?.visibility?.from;
  return {
    ...repository,
    ...(["public", "private", "internal"].includes(previousVisibility) ? { private: previousVisibility !== "public" } : {}),
    ...(typeof changes?.has_issues?.from === "boolean" ? { has_issues: changes.has_issues.from } : {}),
    ...(typeof changes?.archived?.from === "boolean" ? { archived: changes.archived.from } : {}),
    ...(typeof changes?.disabled?.from === "boolean" ? { disabled: changes.disabled.from } : {}),
  };
}

async function dispatchIssueInvalidation(env: Env, repository: any, deliveryId: string): Promise<void> {
  await send(env, "pr-issue-link.yml", { deliveryId, repositoryId: String(repository.id), scanAll: "true", invalidateOnly: "true", cleanupUnmanaged: "false", policySha: env.POLICY_SHA });
}

async function dispatchIssueSyncs(env: Env, repository: any, deliveryId: string, issueNumbers: readonly number[] | null): Promise<void> {
  if (issueNumbers === null) {
    await send(env, "issue-sync.yml", { deliveryId, repositoryId: String(repository.id), scanAll: "true", policySha: env.POLICY_SHA });
    return;
  }
  const unique = [...new Set(issueNumbers)].sort((left, right) => left - right);
  if (!unique.length || unique.some(number => !Number.isSafeInteger(number) || number <= 0)) throw new Error("议题事件编号无效");
  for (const issueNumber of unique) await send(env, "issue-sync.yml", { deliveryId, repositoryId: String(repository.id), issueNumber: String(issueNumber), scanAll: "false", policySha: env.POLICY_SHA });
}

function orderedManagedRepositories(repositories: readonly any[]): any[] {
  return [...new Map(repositories.filter(isManaged).map(repository => [Number(repository.id), repository])).values()]
    .sort((left, right) => Number(left.id) - Number(right.id));
}

async function onboardManagedRepositories(env: Env, repositories: readonly any[], deliveryId: string, trigger: string): Promise<void> {
  const ordered = orderedManagedRepositories(repositories);
  let firstFailure: unknown = null;
  for (const repository of ordered.filter(isIssueCapable)) {
    try { await dispatchIssueInvalidation(env, repository, deliveryId); }
    catch (error) { if (firstFailure === null) firstFailure = error; }
  }
  if (firstFailure !== null) throw firstFailure;
  const store = env.ISSUE_SNAPSHOTS ? new IssueSnapshotStore(env.ISSUE_SNAPSHOTS) : null;
  for (const repository of ordered) {
    try {
      if (isIssueCapable(repository)) await store?.activateRepository(Number(repository.id));
      else await store?.deleteRepository(Number(repository.id));
      await send(env, "onboard-repository.yml", { ...repositoryInputs(repository), trigger, deliveryId, policySha: env.POLICY_SHA });
    } catch (error) { if (firstFailure === null) firstFailure = error; }
  }
  if (firstFailure !== null) throw firstFailure;
}

async function installationRepositories(env: Env): Promise<any[]> {
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const token = await createInstallationToken({ appId: env.APP_ID, privateKey: env.STEWARD_APP_PRIVATE_KEY,
    installationId: Number(env.INSTALLATION_ID), permissions: { metadata: "read" }, policySha: env.POLICY_SHA });
  return new GitHubClient(token, "https://api.github.com", fetch, env.POLICY_SHA).listInstallationRepositories();
}

function repositoryFullNameFromApiUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.search || url.hash || !/^\/repos\/[^/]+\/[^/]+$/u.test(url.pathname)) return null;
    return url.pathname.slice("/repos/".length);
  } catch { return null; }
}

async function transferredIssueRepository(env: Env, issue: any): Promise<any | null> {
  const fullName = repositoryFullNameFromApiUrl(issue?.repository_url);
  if (!fullName) return null;
  const matches = (await installationRepositories(env)).filter(repository => belongsToOrganization(repository) && String(repository.full_name).toLowerCase() === fullName.toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

async function dispatchAllManagedIssueScans(
  env: Env,
  deliveryId: string,
  currentRepository?: any,
  afterInvalidation?: () => Promise<void>,
): Promise<void> {
  const installed = await installationRepositories(env);
  const repositories = new Map(installed.filter(isIssueCapable).map(repository => [Number(repository.id), repository]));
  if (currentRepository && isIssueCapable(currentRepository)) repositories.set(Number(currentRepository.id), currentRepository);
  const ordered = [...repositories.values()].sort((left, right) => Number(left.id) - Number(right.id));
  let firstFailure: unknown = null;
  for (const repository of ordered) {
    try { await dispatchIssueInvalidation(env, repository, deliveryId); }
    catch (error) { if (firstFailure === null) firstFailure = error; }
  }
  if (firstFailure !== null) throw firstFailure;
  if (afterInvalidation) await afterInvalidation();
  for (const repository of ordered) {
    try { await dispatchIssueSyncs(env, repository, deliveryId, null); }
    catch (error) { if (firstFailure === null) firstFailure = error; }
  }
  if (firstFailure !== null) throw firstFailure;
}

async function dispatchRelationRefreshes(env: Env, deliveryId: string, payload: any, targets: readonly { repository: any; issueNumber: unknown }[]): Promise<void> {
  const grouped = new Map<number, { repository: any; issueNumbers: number[] | null }>();
  let incomplete = false;
  for (const target of targets) {
    if (!target.repository || !isIssueCapable(target.repository)) { incomplete = true; continue; }
    const repositoryId = Number(target.repository.id);
    const issueNumber = Number(target.issueNumber);
    const existing = grouped.get(repositoryId) ?? { repository: target.repository, issueNumbers: [] };
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) existing.issueNumbers = null;
    else if (existing.issueNumbers) existing.issueNumbers.push(issueNumber);
    grouped.set(repositoryId, existing);
  }
  if (incomplete && payload.repository && isIssueCapable(payload.repository)) {
    const repositoryId = Number(payload.repository.id);
    const existing = grouped.get(repositoryId) ?? { repository: payload.repository, issueNumbers: [] };
    existing.issueNumbers = null;
    grouped.set(repositoryId, existing);
  }
  if (!grouped.size && payload.repository && isIssueCapable(payload.repository)) grouped.set(Number(payload.repository.id), { repository: payload.repository, issueNumbers: null });
  const ordered = [...grouped.values()].sort((left, right) => Number(left.repository.id) - Number(right.repository.id));
  let firstFailure: unknown = null;
  for (const target of ordered) {
    try { await dispatchIssueInvalidation(env, target.repository, deliveryId); }
    catch (error) { if (firstFailure === null) firstFailure = error; }
  }
  if (firstFailure !== null) throw firstFailure;
  for (const target of ordered) {
    try { await dispatchIssueSyncs(env, target.repository, deliveryId, target.issueNumbers); }
    catch (error) { if (firstFailure === null) firstFailure = error; }
  }
  if (firstFailure !== null) throw firstFailure;
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0"); if (declared > MAX_BODY) return response(413);
  const bytes = await request.arrayBuffer(); if (bytes.byteLength > MAX_BODY) return response(413);
  if (!env.STEWARD_WEBHOOK_SECRET || !await verifyWebhookSignature(bytes, request.headers.get("x-hub-signature-256"), env.STEWARD_WEBHOOK_SECRET)) return response(401);
  let payload: any; try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { return response(400); }
  if (!validScope(payload, env)) return response(403);
  const event = request.headers.get("x-github-event") ?? ""; const deliveryId = request.headers.get("x-github-delivery") ?? ""; const action = payload.action ?? "";
  try {
    if (event === "pull_request" && action === "edited" && env.ISSUE_SNAPSHOTS && payload.repository && payload.pull_request) {
      const store = new PullRequestBodyWriteIntentStore(env.ISSUE_SNAPSHOTS);
      const current = await store.get(Number(payload.repository.id), Number(payload.pull_request.number));
      if (current && ["prepared", "patched", "compensating"].includes(current.status)) {
        const outcome = await processPullRequestBodyEditedDelivery({
          store,
          client: await bodyWriteClient(env, Number(payload.repository.id)),
          repository: payload.repository,
          payload,
          deliveryId,
          now: new Date().toISOString(),
        });
        if (["proven", "compensated", "duplicate", "blocked"].includes(outcome)) return response(202);
      }
    }
    if (event === "installation" && action === "deleted") {
      if (!env.ISSUE_SNAPSHOTS) throw new Error("议题快照存储不可用");
      const repositoryIds = (payload.repositories ?? []).filter(belongsToOrganization).map((repository: any) => Number(repository.id));
      await new IssueSnapshotStore(env.ISSUE_SNAPSHOTS).deleteAllRepositories(repositoryIds);
      return response(202);
    }
    if (event === "installation_repositories" && action === "removed") {
      if (!env.ISSUE_SNAPSHOTS) throw new Error("议题快照存储不可用");
      for (const repository of payload.repositories_removed ?? []) if (belongsToOrganization(repository)) await new IssueSnapshotStore(env.ISSUE_SNAPSHOTS).deleteRepository(Number(repository.id));
      return response(202);
    }
    if (event === "issues" && ["deleted", "transferred"].includes(action)) {
      const repository = payload.repository; const issueNumber = Number(payload.issue?.number);
      const sourceManaged = Boolean(repository && isManaged(repository) && Number.isSafeInteger(issueNumber) && issueNumber > 0);
      const destinationIssueNumber = Number(payload.changes?.new_issue?.number);
      const destinationRepository = action === "transferred" && Number.isSafeInteger(destinationIssueNumber) && destinationIssueNumber > 0
        ? await transferredIssueRepository(env, payload.changes?.new_issue) : null;
      const destinationManaged = Boolean(destinationRepository && isManaged(destinationRepository));
      if (!sourceManaged && !destinationManaged) return response(204);
      await dispatchAllManagedIssueScans(env, deliveryId, sourceManaged ? repository : destinationRepository, sourceManaged ? async () => {
        if (!env.ISSUE_SNAPSHOTS) throw new Error("议题快照存储不可用");
        const store = new IssueSnapshotStore(env.ISSUE_SNAPSHOTS);
        await deleteIssueSnapshotWithRetry(store, Number(repository.id), issueNumber, new Date().toISOString());
      } : undefined);
      return response(202);
    }
    if (event === "issues") {
      const repository = payload.repository; const issueNumber = Number(payload.issue?.number);
      if (!repository || !isIssueCapable(repository) || payload.issue?.pull_request || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) return response(204);
      await dispatchAllManagedIssueScans(env, deliveryId, repository);
      return response(202);
    }
    if (event === "issue_comment" && ["created", "edited", "deleted"].includes(action)) {
      const repository = payload.repository; const issueNumber = Number(payload.issue?.number);
      if (!repository || !isIssueCapable(repository) || payload.issue?.pull_request || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) return response(204);
      await dispatchAllManagedIssueScans(env, deliveryId, repository);
      return response(202);
    }
    if (event === "sub_issues") {
      const parentRepository = String(action).startsWith("parent_issue_") ? payload.parent_issue_repo : payload.repository;
      const subIssueRepository = String(action).startsWith("sub_issue_") ? payload.sub_issue_repo : payload.repository;
      await dispatchRelationRefreshes(env, deliveryId, payload, [
        { repository: parentRepository, issueNumber: payload.parent_issue?.number },
        { repository: subIssueRepository, issueNumber: payload.sub_issue?.number },
      ]);
      return response(202);
    }
    if (event === "issue_dependencies") {
      const blockedRepository = String(action).startsWith("blocking_") ? payload.blocked_issue_repo : payload.repository;
      const blockingRepository = String(action).startsWith("blocked_by_") ? payload.blocking_issue_repo : payload.repository;
      await dispatchRelationRefreshes(env, deliveryId, payload, [
        { repository: blockedRepository, issueNumber: payload.blocked_issue?.number },
        { repository: blockingRepository, issueNumber: payload.blocking_issue?.number },
      ]);
      return response(202);
    }
    if (event === "installation" && action === "created") {
      await onboardManagedRepositories(env, payload.repositories ?? [], deliveryId, "installation-created");
      return response(202);
    }
    if (event === "installation_repositories" && action === "added") {
      await onboardManagedRepositories(env, payload.repositories_added ?? [], deliveryId, "installation-repositories-added");
      return response(202);
    }
    if (event === "repository" && action === "edited") {
      const repository = payload.repository; if (!repository || !belongsToOrganization(repository)) return response(204);
      const managed = isManaged(repository);
      const capable = isIssueCapable(repository);
      const previousRepository = repositoryBeforeEdit(repository, payload.changes);
      const previouslyManaged = isManaged(previousRepository);
      const previouslyCapable = isIssueCapable(previousRepository);
      if ((previouslyManaged && !managed) || (previouslyCapable && !capable)) {
        if (!env.ISSUE_SNAPSHOTS) throw new Error("议题快照存储不可用");
        await new IssueSnapshotStore(env.ISSUE_SNAPSHOTS).deleteRepository(Number(repository.id));
        await send(env, "pr-issue-link.yml", { deliveryId, repositoryId: String(repository.id), scanAll: "true", invalidateOnly: "false", cleanupUnmanaged: "true", policySha: env.POLICY_SHA });
        return response(202);
      }
      if ((!previouslyManaged && managed) || (!previouslyCapable && capable)) {
        if (!env.ISSUE_SNAPSHOTS) throw new Error("议题快照存储不可用");
        await onboardManagedRepositories(env, [repository], deliveryId, "repository-visibility-changed");
        return response(202);
      }
      if (!capable) return response(204);
      await send(env, "pr-issue-link.yml", { deliveryId, repositoryId: String(repository.id), scanAll: "true", invalidateOnly: "true", cleanupUnmanaged: "false", policySha: env.POLICY_SHA });
      await send(env, "pr-issue-link.yml", { deliveryId, repositoryId: String(repository.id), scanAll: "true", invalidateOnly: "false", cleanupUnmanaged: "false", policySha: env.POLICY_SHA });
      return response(202);
    }
    if (event === "push") {
      const repository = payload.repository; if (!repository || !isManaged(repository) || repository.fork || repository.archived || repository.disabled || payload.deleted || !String(payload.ref).startsWith("refs/heads/") || payload.after === ZERO_SHA) return response(204);
      if (payload.ref === `refs/heads/${repository.default_branch}`) {
        if (payload.before === ZERO_SHA) await send(env, "onboard-repository.yml", { ...repositoryInputs(repository), trigger: "default-branch-push", deliveryId, policySha: env.POLICY_SHA });
        else {
          if (isIssueCapable(repository)) await send(env, "pr-issue-link.yml", { deliveryId, repositoryId: String(repository.id), scanAll: "true", invalidateOnly: "true", cleanupUnmanaged: "false", policySha: env.POLICY_SHA });
          await send(env, "pr-classification.yml", { deliveryId, repositoryId: String(repository.id), scanAll: "true", policySha: env.POLICY_SHA });
          if (isIssueCapable(repository)) await send(env, "pr-issue-link.yml", { deliveryId, repositoryId: String(repository.id), scanAll: "true", invalidateOnly: "false", cleanupUnmanaged: "false", policySha: env.POLICY_SHA });
        }
        return response(202);
      }
      const sender = payload.sender; if (!sender || sender.type !== "User" || String(sender.login).endsWith("[bot]")) return response(204);
      await send(env, "pr-automation.yml", { deliveryId, repositoryId: String(repository.id), sourceRef: payload.ref, eventAfterSha: payload.after, sourceActorId: String(sender.id), sourceActorLogin: String(sender.login), policySha: env.POLICY_SHA }); return response(202);
    }
    if (event === "pull_request" && ["opened", "synchronize", "reopened", "edited"].includes(action)) {
      const repository = payload.repository; const pull = payload.pull_request;
      if (!repository || !isManaged(repository) || !pull) return response(204);
      const stewardOwned = isStewardOwnedPullRequest(pull, Number(repository.id));
      const capable = isIssueCapable(repository);
      const targetsDefault = pull.base?.ref === repository.default_branch;
      const leftDefault = action === "edited" && payload.changes?.base?.ref?.from === repository.default_branch;
      const shouldInvalidateIssueGate = stewardOwned && capable && action === "edited" && (targetsDefault || leftDefault);
      const hasManagedIssueBlock = stewardOwned && String(pull.body ?? "").includes("<!-- workflow:issue-links:start ");
      let dispatched = false;
      if (shouldInvalidateIssueGate) {
        await send(env, "pr-issue-link.yml", { deliveryId, repositoryId: String(repository.id), pullRequestNumber: String(pull.number), scanAll: "false", invalidateOnly: "true", cleanupUnmanaged: "false", policySha: env.POLICY_SHA });
      }
      if (targetsDefault) {
        await ensureValidationPending(env, repository, pull);
        await send(env, "pr-classification.yml", { deliveryId, repositoryId: String(repository.id), pullRequestNumber: String(pull.number), eventHeadSha: pull.head.sha, policySha: env.POLICY_SHA });
        dispatched = true;
      }
      if ((stewardOwned && capable && (targetsDefault || leftDefault)) || hasManagedIssueBlock) {
        await send(env, "pr-issue-link.yml", { deliveryId, repositoryId: String(repository.id), pullRequestNumber: String(pull.number), scanAll: "false", invalidateOnly: "false", cleanupUnmanaged: String(!capable), policySha: env.POLICY_SHA });
        dispatched = true;
      }
      return response(dispatched ? 202 : 204);
    }
    if (event === "pull_request" && action === "ready_for_review") {
      const repository = payload.repository; const pull = payload.pull_request;
      if (!repository || !isManaged(repository) || !pull || pull.user?.id !== 301115370 || pull.draft !== false || pull.base?.ref !== repository.default_branch) return response(204);
      return response(await requestMaintainersReview(env, repository, pull) ? 202 : 204);
    }
    if (event === "pull_request" && action === "closed" && payload.pull_request?.merged === false) {
      const repository = payload.repository; const pull = payload.pull_request;
      if (!repository || !isManaged(repository) || !isStewardOwnedPullRequest(pull, Number(repository.id))
        || !String(pull?.body ?? "").includes("<!-- workflow:issue-links:start ")) return response(204);
      await send(env, "pr-issue-link.yml", { deliveryId, repositoryId: String(repository.id), pullRequestNumber: String(pull.number), scanAll: "false", invalidateOnly: "false", cleanupUnmanaged: String(!isIssueCapable(repository)), policySha: env.POLICY_SHA });
      return response(202);
    }
    if (event === "workflow_run" && ["requested", "in_progress", "completed"].includes(action)) {
      const repository = payload.repository; if (!repository || !isManaged(repository)) return response(204);
      return response(await publishValidationState(env, repository, payload.workflow_run?.id) ? 202 : 204);
    }
    if (event === "pull_request" && action === "closed" && payload.pull_request?.merged && payload.pull_request?.base?.ref === payload.repository?.default_branch) {
      const repository = payload.repository; if (!isManaged(repository) || repositoryConfiguration(repository).releaseProfile !== "layerscape") return response(204);
      if (!await pullRequestChangesVersion(env, repository, Number(payload.pull_request.number))) return response(204);
      await send(env, "release.yml", { repositoryId: String(repository.id), pullRequestNumber: String(payload.pull_request.number), targetSha: payload.pull_request.merge_commit_sha }); return response(202);
    }
    return response(204);
  } catch (error) {
    console.error(JSON.stringify({ deliveryId, event, action, repositoryId: payload.repository?.id ?? null, status: "dispatch-failed", policySha: env.POLICY_SHA, error: error instanceof Error ? error.message : "unknown" }));
    return response(503);
  }
}

function deliveryHeader(headers: Record<string, unknown> | undefined, name: string): string {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof entry?.[1] === "string" ? entry[1] : "";
}

async function deleteIssueSnapshotWithRetry(store: IssueSnapshotStore, repositoryId: number, issueNumber: number, now: string): Promise<void> {
  for (let attempt = 1; attempt <= ISSUE_SNAPSHOT_DELETE_ATTEMPTS; attempt += 1) {
    const state = await store.getRepositoryState(repositoryId);
    try {
      await store.deleteSnapshot(repositoryId, issueNumber, state?.generation ?? 0, state?.stateRevision ?? 0, now);
      return;
    } catch (error) {
      if (!(error instanceof Error && error.message === "issue-snapshot-generation-conflict") || attempt === ISSUE_SNAPSHOT_DELETE_ATTEMPTS) throw error;
    }
  }
}

export async function recoverPullRequestBodyWriteIntents(env: Env, now = new Date()): Promise<number> {
  if (!env.ISSUE_SNAPSHOTS) return 0;
  const store = new PullRequestBodyWriteIntentStore(env.ISSUE_SNAPSHOTS);
  const nowIso = now.toISOString();
  const redriveRetryBefore = new Date(now.getTime() - BODY_WRITE_REDRIVE_RETRY_MS).toISOString();
  const expired = await store.blockExpired(nowIso, 20);
  const pending = await store.listRecoverable(nowIso, 20);
  const queuedRedrives = await store.listPendingRedrives(20, redriveRetryBefore);
  if (!pending.length && !queuedRedrives.length) return expired;
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const dispatchRedrives = async (redrives: readonly PullRequestBodyWriteIntent[]) => {
    for (const current of redrives) {
      const claimed = await store.claimRedrive(current.repositoryId, current.pullRequestNumber, current.writeId, nowIso, redriveRetryBefore);
      if (!claimed) continue;
      if (!current.redrive) {
        console.warn(JSON.stringify({ repositoryId: current.repositoryId, pullRequestNumber: current.pullRequestNumber, writeId: current.writeId,
          status: "body-write-redrive-abandoned", reason: "missing-redrive-origin" }));
        await store.abandonClaimedRedrive(current.repositoryId, current.pullRequestNumber, current.writeId, nowIso);
        continue;
      }
      const inputs = { ...current.redrive.inputs };
      if (Object.hasOwn(inputs, "deliveryId")) inputs.deliveryId = `body-write-recovery:${current.writeId}`;
      if (Object.hasOwn(inputs, "policySha")) inputs.policySha = env.POLICY_SHA;
      try {
        await send(env, current.redrive.workflow, inputs);
      } catch (error) {
        await store.releaseRedrive(current.repositoryId, current.pullRequestNumber, current.writeId, nowIso);
        throw error;
      }
    }
  };
  await dispatchRedrives(queuedRedrives);
  if (!pending.length) return expired;
  const app = new GitHubClient(await createAppJwt(env.APP_ID, env.STEWARD_APP_PRIVATE_KEY), "https://api.github.com", fetch, env.POLICY_SHA);
  const deliveries = await app.request<any[]>("GET", "/app/hook/deliveries?per_page=100");
  if (!Array.isArray(deliveries) || deliveries.length > 100) throw new Error("GitHub App交付列表无效");
  let recovered = expired;
  const clients = new Map<number, GitHubClient>();
  for (const current of pending) {
    const client = clients.get(current.repositoryId) ?? await bodyWriteClient(env, current.repositoryId);
    clients.set(current.repositoryId, client);
    const repository = await client.getRepositoryById(current.repositoryId);
    if (current.deliveryProven) {
      try {
        const confirmed = await confirmPullRequestBodyWriteIntent({ store, client, repository, pullRequestNumber: current.pullRequestNumber, writeId: current.writeId, now: nowIso });
        if (["confirmed", "blocked"].includes(confirmed.status)) {
          await store.requestRedrive(confirmed.repositoryId, confirmed.pullRequestNumber, confirmed.writeId, nowIso);
          recovered += 1;
        }
      } catch { /* keep the durable intent pending for the next bounded scan */ }
      continue;
    }
    const candidates = deliveries.filter((delivery) => Number(delivery?.repository_id) === current.repositoryId && delivery?.event === "pull_request" && delivery?.action === "edited").slice(0, 20);
    for (const candidate of candidates) {
      if (!Number.isSafeInteger(candidate?.id) || candidate.id <= 0) continue;
      const detail = await app.request<any>("GET", `/app/hook/deliveries/${candidate.id}`);
      const deliveryId = deliveryHeader(detail?.request?.headers, "x-github-delivery") || String(detail?.guid ?? candidate?.guid ?? "");
      const payload = detail?.request?.payload;
      if (!deliveryId || !payload || Number(payload?.repository?.id) !== current.repositoryId || Number(payload?.pull_request?.number) !== current.pullRequestNumber) continue;
      const outcome = await processPullRequestBodyEditedDelivery({ store, client, repository, payload, deliveryId, now: nowIso });
      if (["proven", "compensated", "blocked"].includes(outcome)) { recovered += 1; break; }
    }
  }
  await dispatchRedrives(await store.listPendingRedrives(20, redriveRetryBefore));
  return recovered;
}

export async function recoverIssueSnapshotReconciliations(env: Env, now = new Date()): Promise<number> {
  if (!env.ISSUE_SNAPSHOTS) return 0;
  const store = new IssueSnapshotStore(env.ISSUE_SNAPSHOTS);
  const nowIso = now.toISOString();
  const retryBefore = new Date(now.getTime() - ISSUE_RECONCILIATION_RETRY_MS).toISOString();
  const candidates = await store.listReconciliationDispatchCandidates(retryBefore, 20);
  if (!candidates.length) return 0;
  const client = await dispatcher(env);
  const activeRuns = await activeIssueReconciliationRuns(env, client);
  let dispatched = 0;
  let firstError: unknown;
  for (const current of candidates) {
    if (activeRuns.has(issueReconciliationRunName(current.repositoryId, current.generation))) {
      await store.claimReconciliationDispatch(current.repositoryId, current.generation, current.stateRevision, nowIso, retryBefore);
      continue;
    }
    if (!await store.claimReconciliationDispatch(current.repositoryId, current.generation, current.stateRevision, nowIso, retryBefore)) continue;
    try {
      await sendWithClient(env, client, ISSUE_LINK_WORKFLOW_FILE, {
        deliveryId: `issue-reconciliation-recovery:${current.repositoryId}:${current.generation}:${current.stateRevision}`,
        repositoryId: String(current.repositoryId),
        scanAll: "true",
        invalidateOnly: "false",
        cleanupUnmanaged: "false",
        reconciliationGeneration: String(current.generation),
        policySha: env.POLICY_SHA,
      });
      dispatched += 1;
    } catch (error) {
      await store.releaseReconciliationDispatch(current.repositoryId, current.generation, current.stateRevision, nowIso, current.lastDispatchedAt);
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  return dispatched;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return response(200, { status: "ok", policySha: env.POLICY_SHA, version: env.CF_VERSION_METADATA?.id ?? "local", organizationId: Number(env.ORGANIZATION_ID), appId: Number(env.APP_ID), secretsReady: Boolean(env.STEWARD_APP_PRIVATE_KEY && env.STEWARD_WEBHOOK_SECRET) });
    if (request.method === "POST" && url.pathname === "/github/webhook") return handleWebhook(request, env);
    const internal = await handleIssueSnapshotInternalRequest(request, env);
    if (internal) return internal;
    return response(404);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const results = await Promise.allSettled([
      recoverPullRequestBodyWriteIntents(env),
      recoverIssueSnapshotReconciliations(env),
    ]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  },
};
