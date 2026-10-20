import { SerialTaskQueue } from './serial-task-queue.js';
import { settledPool } from "./settled-pool.js";
import { evaluatorSha, trustedContractAuthorities } from './workflow-evaluator.js';
import { isStewardOwnedPullRequest } from "../../core/src/issues.js";
import {selectContractAuthority} from "../../core/src/workflow-contract-authority.js";
import {evaluateRemoteWorkflowContract} from "../../github/src/workflow-contract.js";
import { createAppJwt, createInstallationToken, dispatchWorkflow, GitHubClient, GitHubRequestError, isDependabotReviewEligible } from "../../github/src/index.js";
import repositoryCatalog from "../../../config/repositories.json" with { type: "json" };
import semanticCatalog from "../../../config/labels/pr-semantics.json" with { type: "json" };
import { handleBodyWriteInternalRequest } from "./pr-body-api.js";
import { handleReleaseRequest } from "./release-api.js";
import { ReleaseReceiptStore } from "./release-note-receipts.js";
import { confirmPullRequestBodyWriteIntent, processPullRequestBodyEditedDelivery, PullRequestBodyWriteIntentStore, type PullRequestBodyWriteIntent } from "./pr-body-write-intents.js";

export interface Env {
  ORGANIZATION_ID: string; ORGANIZATION_LOGIN: string; APP_ID: string; INSTALLATION_ID: string;
  STEWARDSHIP_REPOSITORY: string; POLICY_SHA: string; WORKFLOW_EVALUATOR_SHA?: string; STEWARD_APP_PRIVATE_KEY?: string; STEWARD_WEBHOOK_SECRET?: string;
  ISSUE_SNAPSHOTS?: D1Database;
  VALIDATION_COORDINATOR?: DurableObjectNamespace;
  CF_VERSION_METADATA?: { id: string };
}

const MAX_BODY = 10 * 1024 * 1024;
const ZERO_SHA = "0".repeat(40);
const VALIDATION_WORKFLOW_NAME = "SPLRAD Steward / PR Validation";
const VALIDATION_WORKFLOW_PATH = ".github/workflows/pr-validation.yml";
const VALIDATION_CHECK_NAME = "PR Validation Gate";
const BODY_WRITE_REDRIVE_RETRY_MS = 2 * 60 * 60_000;

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
    permissions: { actions: "read", checks: "write", metadata: "read", pull_requests: "read",
      ...(env.WORKFLOW_EVALUATOR_SHA !== undefined ? {contents: "read" as const} : {}) },
    policySha: env.POLICY_SHA,
  });
  return new GitHubClient(token, "https://api.github.com", fetch, env.POLICY_SHA);
}
async function ensureValidationPending(env: Env, repository: any, pull: any): Promise<void> {
  if (env.VALIDATION_COORDINATOR) { await coordinatedValidation(env, repository.id, {operation:"pending", repository, pull}); return; }
  const headSha = commitSha(pull?.head?.sha); const number = Number(pull?.number);
  if (!headSha || !Number.isSafeInteger(number) || number <= 0) throw new Error("拉取请求验证输入无效");
  const [owner, repo] = splitRepository(String(repository.full_name));
  const gh = await validationClient(env, Number(repository.id));
  const current = validationChecksForPull(await gh.listAllCheckRuns(owner, repo, headSha, "all"), headSha, Number(env.APP_ID), Number(repository.id), number);
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
type AuthoritySnapshot = { value?: Awaited<ReturnType<typeof trustedContractAuthorities>>; error?: unknown };
async function authoritySnapshot(env: Env): Promise<AuthoritySnapshot> {
  try { return { value: await trustedContractAuthorities(env) }; } catch (error) { return { error }; }
}
async function publishValidationState(env: Env, repository: any, workflowRunId: unknown, context?: { gh: GitHubClient; authority: AuthoritySnapshot }): Promise<boolean> {
  if (env.VALIDATION_COORDINATOR) return (await coordinatedValidation(env, repository.id, {operation:"run", repository, workflowRunId})).changed;
  const runId = Number(workflowRunId);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("工作流运行编号无效");
  const [owner, repo] = splitRepository(String(repository.full_name));
  const gh = context?.gh ?? await validationClient(env, Number(repository.id));
  const run = await gh.getWorkflowRun(owner, repo, runId);
  if (!trustedValidationRun(run, repository) || run.id !== runId
    || !Number.isSafeInteger(run.head_repository?.id) || run.head_repository.id <= 0
    || typeof run.head_branch !== "string" || !run.head_branch
    || !Array.isArray(run.pull_requests)) return false;
  const headSha = commitSha(run.head_sha)!;
  const matchesRun = (pull: any): boolean =>
    pull?.state === "open"
      && pull?.base?.repo?.id === repository.id
      && pull?.base?.ref === repository.default_branch
      && pull?.head?.repo?.id === run.head_repository.id
      && pull?.head?.ref === run.head_branch
      && commitSha(pull?.head?.sha) === headSha
      && (run.pull_requests.length === 0 || run.pull_requests.some((linked: any) => linked?.number === pull.number));
  let pulls = (await gh.listPullsForCommit(owner, repo, headSha)).filter(matchesRun);
  if (!pulls.length && run.head_repository.id !== repository.id) {
    pulls = (await gh.listOpenPullRequests(owner, repo, repository.default_branch)).filter(matchesRun);
  }
  if (!pulls.length) return false;
  if (pulls.length > 1) return false;
  const pull = pulls[0]!; const number = Number(pull.number);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("拉取请求编号无效");
  const checks = validationChecksForPull(await gh.listAllCheckRuns(owner, repo, headSha, "all"), headSha, Number(env.APP_ID), Number(repository.id), number);
  let conclusion = validationConclusion(run.conclusion); const completed = run.status === "completed";
  const comparisons = checks.map(value => compareValidationState(value.state, run.id, run.run_attempt, completed));
  if (comparisons.includes("newer")) return false;
  let contractDetail = "";
  let authority: ReturnType<typeof selectContractAuthority> = null; let authorityError:unknown;
  try {const snapshot=context?.authority ?? await authoritySnapshot(env); if(snapshot.error)throw snapshot.error; authority=selectContractAuthority(snapshot.value!,Number(repository.id));if(env.WORKFLOW_EVALUATOR_SHA!==undefined && !authority)throw new Error('CONTRACT_AUTHORITY_REQUIRED');}
  catch(error){authorityError=error;}
  if ((authority || authorityError) && completed) {
    try {
      if(authorityError)throw authorityError;
      const policy=evaluatorSha(env);
      const jobs = await gh.listWorkflowAttemptJobs(owner, repo, run.id, run.run_attempt);
      if (!jobs.some(job => job.status === "completed" && job.conclusion === "success"
        && job.steps?.some((step: any) => step.name === `workflow-contract-policy:${policy}`
          && step.status === "completed" && step.conclusion === "success")))
        throw new Error("CONTRACT_POLICY_MISMATCH: trusted evaluator version not confirmed");
      const verified = await evaluateRemoteWorkflowContract(gh, authority!, number, policy);
      if (verified.binding.headSha !== headSha) throw new Error("CONTRACT_SOURCE_STALE");
      contractDetail = `\n合同：${verified.binding.contractDigest}\n批准：${verified.reviewId ?? "trusted baseline"}`;
    } catch (error) {
      conclusion = "failure";
      contractDetail = `\n合同验证失败：${error instanceof Error ? error.message : "unavailable"}`;
    }
  }

  const body: Record<string, unknown> = {
    name: VALIDATION_CHECK_NAME,
    head_sha: headSha,
    status: completed ? "completed" : "in_progress",
    details_url: run.html_url,
    external_id: completed ? completedValidationIdentity(Number(repository.id), number, headSha, run.id, run.run_attempt) : `${completedValidationIdentity(Number(repository.id), number, headSha, run.id, run.run_attempt)}:pending`,
    output: completed
      ? { title: conclusion === "success" ? "中央拉取请求验证通过" : "中央拉取请求验证失败", summary: `拉取请求：#${number}\n来源提交：${headSha}\n源工作流运行：${run.id}\n源结论：${run.conclusion}${contractDetail}` }
      : { title: "中央拉取请求验证正在运行", summary: `拉取请求：#${number}\n来源提交：${headSha}\n源工作流运行：${run.id}` },
  };
  if (completed) body.conclusion = conclusion;
  const outdatedChecks = checks.filter((value, index) => comparisons[index] === "older"
    || ((authority || authorityError) && completed && comparisons[index] === "same" && value.check.conclusion !== conclusion));
  if (!checks.length) await gh.createCheckRun(owner, repo, body);
  else if (!outdatedChecks.length) return false;
  else for (const { check } of outdatedChecks) await gh.updateCheckRun(owner, repo, check.id, body);
  return true;
}

export async function refreshWorkflowContractChecks(env: Env, repositoryId: number, pullNumber?: number, snapshot?: AuthoritySnapshot): Promise<void> {
  if (env.WORKFLOW_EVALUATOR_SHA===undefined) return;
  if (env.VALIDATION_COORDINATOR) { await coordinatedValidation(env, repositoryId, {operation:"refresh", repositoryId, pullNumber}); return; }
  const gh = await validationClient(env, repositoryId);
  const repository = await gh.getRepositoryById(repositoryId);
  if (repository.id !== repositoryId || !belongsToOrganization(repository)) throw new Error("CONTRACT_REPOSITORY: identity mismatch");
  // Authority coverage includes private repositories that catalog defaults leave unmanaged.
  // The explicitly enabled contract gate fails closed for installed organization repositories,
  // including private repositories outside the business-automation catalog.
  const [owner, repo] = splitRepository(repository.full_name);
  const pulls = pullNumber === undefined ? await gh.listOpenPullRequests(owner, repo, repository.default_branch)
    : [await gh.getPullRequest(owner, repo, pullNumber)];
  let sharedAuthority = snapshot;
  for (const pull of pulls) {
    const head = commitSha(pull.head?.sha);
    if (!head || pull.state !== "open" || pull.base?.ref !== repository.default_branch) continue;
    const checks = validationChecksForPull(await gh.listAllCheckRuns(owner, repo, head, "all"), head, Number(env.APP_ID), repositoryId, pull.number);
    let run = checks.reduce<number | null>((latest, check) => check.state.runId !== null && (latest === null || check.state.runId > latest) ? check.state.runId : latest, null);
    const discoveredIds = new Set<number>();
    try { // Discover runs even when every webhook was lost and no Gate exists.
      let total: number | undefined;
      const candidates = await gh.paginate<any>(`/repos/${owner}/${repo}/actions/runs?event=pull_request&head_sha=${head}&per_page=100`, value => {
        const page = value as any;
        if (!Number.isSafeInteger(page.total_count) || page.total_count < 0 || page.total_count >= 1000
          || (total !== undefined && total !== page.total_count))
          throw new Error('CONTRACT_RUN_DISCOVERY: incomplete run history');
        total = page.total_count;
        return page.workflow_runs;
      }, { maxPages: 10, maxItems: 999 });
      if (candidates.length !== total || new Set(candidates.map(candidate => candidate.id)).size !== candidates.length)
        throw new Error('CONTRACT_RUN_DISCOVERY: incomplete run history');
      for (const candidate of candidates) {
        discoveredIds.add(candidate.id);
        if (trustedValidationRun(candidate, repository) && candidate.head_sha === head
          && candidate.head_repository?.id === pull.head?.repo?.id && candidate.head_branch === pull.head?.ref
          && Array.isArray(candidate.pull_requests)
          && (candidate.pull_requests.length === 0 || candidate.pull_requests.some((linked: any) => linked?.number === pull.number))
          && (run === null || candidate.id > run)) run = candidate.id;
      }
    } catch (error) {
      // Discovery failure cannot preserve a stale successful gate.
      const current = await gh.getPullRequest(owner, repo, pull.number);
      if (current.state === 'open' && current.base?.repo?.id === repositoryId
        && current.base?.ref === repository.default_branch && current.head?.sha === head) {
        const bound = validationChecksForPull(await gh.listAllCheckRuns(owner, repo, head, 'all'), head, Number(env.APP_ID), repositoryId, pull.number);
        const failure = {
          name:VALIDATION_CHECK_NAME,head_sha:head,status:'completed',conclusion:'failure',
          output:{title:'中央验证运行历史不可确认',summary:`PR #${pull.number} / ${head}: CONTRACT_RUN_DISCOVERY`},
        };
        if (!bound.length) await gh.createCheckRun(owner, repo, {
          ...failure, external_id:`${repositoryId}:${pull.number}:${head}:pending`,
        });
        else for (const {check} of bound) await gh.updateCheckRun(owner, repo, check.id, failure);
      }
      throw error;
    }
    if (run !== null) {
      sharedAuthority ??= await authoritySnapshot(env);
      try { await publishValidationState(env, repository, run, { gh, authority: sharedAuthority }); }
      catch (error) {
        if (!(error instanceof GitHubRequestError) || error.status !== 404
          || error.path !== `/repos/${owner}/${repo}/actions/runs/${run}` || discoveredIds.has(run)) throw error;
        const current = await gh.getPullRequest(owner, repo, pull.number);
        if (current.state !== 'open' || current.base?.repo?.id !== repositoryId
          || current.base?.ref !== repository.default_branch || current.head?.sha !== head) continue;
        const latestChecks = validationChecksForPull(await gh.listAllCheckRuns(owner, repo, head, 'all'), head, Number(env.APP_ID), repositoryId, pull.number);
        for (const {check,state} of latestChecks) if (state.runId === run) await gh.updateCheckRun(owner, repo, check.id, {
          name: VALIDATION_CHECK_NAME, head_sha: head, status: 'completed', conclusion: 'failure',
          output: {title:'中央验证来源已不可用',summary:`PR #${pull.number} / ${head}: CONTRACT_RUN_MISSING (${run})`},
        });
      }
    }
  }
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
async function dispatchDependabotReview(env: Env, repository: any, pull: any, action: string, deliveryId: string, previousBaseRef?: unknown): Promise<boolean> {
  const enteredDefault = action === "edited" && typeof previousBaseRef === "string" && previousBaseRef.length > 0
    && previousBaseRef !== repository?.default_branch && pull?.base?.ref === repository?.default_branch;
  if ((!enteredDefault && !["opened", "synchronize", "reopened", "ready_for_review"].includes(action))
    || !repository || !isManaged(repository) || repositoryConfiguration(repository).managed !== true
    || !isDependabotReviewEligible(repository, pull, String(pull?.head?.sha ?? ""))
    || typeof pull.head.ref !== "string" || !pull.head.ref) return false;
  await send(env, "native-review.yml", { deliveryId, repositoryId: String(repository.id), pullRequestNumber: String(pull.number), eventAfterSha: pull.head.sha, policySha: env.POLICY_SHA });
  return true;
}
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

function orderedManagedRepositories(repositories: readonly any[]): any[] {
  return [...new Map(repositories.filter(isManaged).map(repository => [Number(repository.id), repository])).values()]
    .sort((left, right) => Number(left.id) - Number(right.id));
}

async function onboardManagedRepositories(env: Env, repositories: readonly any[], deliveryId: string, trigger: string): Promise<void> {
  const ordered = orderedManagedRepositories(repositories);
  let firstFailure: unknown = null;

  for (const repository of ordered) {
    try {
      await send(env, "onboard-repository.yml", { ...repositoryInputs(repository), trigger, deliveryId, policySha: env.POLICY_SHA });
    } catch (error) { if (firstFailure === null) firstFailure = error; }
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
    if (["issues", "issue_comment", "sub_issues", "issue_dependencies"].includes(event)
      || (event === "installation" && action === "deleted")
      || (event === "installation_repositories" && action === "removed")) return response(204);
    // Only centrally bound candidates can schedule the release lifecycle. Review is observation only.
    if (env.ISSUE_SNAPSHOTS && ["pull_request", "pull_request_review"].includes(event)
      && payload.repository && isManaged(payload.repository) && payload.pull_request?.number) {
      const candidate = await new ReleaseReceiptStore(env.ISSUE_SNAPSHOTS).findByPull(Number(payload.repository.id), Number(payload.pull_request.number));
      if (candidate && candidate.frozen.policySha === env.POLICY_SHA) {
        const operation = event === "pull_request" && action === "closed" && payload.pull_request.merged === true ? "reconcile" : "inspect";
        await send(env, "release.yml", { repositoryId: String(payload.repository.id), targetTag: candidate.frozen.targetTag, operation });
        if (event === "pull_request_review" || action === "closed") return response(202);
      }
    }
    if (event === "pull_request" && action === "edited" && env.ISSUE_SNAPSHOTS && payload.repository && payload.pull_request) {
      const store = new PullRequestBodyWriteIntentStore(env.ISSUE_SNAPSHOTS);
      const current = await store.get(Number(payload.repository.id), Number(payload.pull_request.number));
      if (current && current.regionKind === "managed-pr" && ["onboard-repository.yml", "sync-review-instructions.yml"].includes(current.redrive?.workflow ?? "") && ["prepared", "patched", "compensating"].includes(current.status)) {
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
    if (event === "installation" && action === "created") {
      await onboardManagedRepositories(env, payload.repositories ?? [], deliveryId, "installation-created");
      return response(202);
    }
    if (event === "installation_repositories" && action === "added") {
      await onboardManagedRepositories(env, payload.repositories_added ?? [], deliveryId, "installation-repositories-added");
      return response(202);
    }
    if (event === "repository" && ["edited", "archived", "unarchived"].includes(action)) {
      const repository = payload.repository;
      if (!repository || !isManaged(repository) || repository.archived || repository.disabled) return response(204);
      const previous = repositoryBeforeEdit(repository, payload.changes);
      if (action === "unarchived" || !isManaged(previous)) {
        await onboardManagedRepositories(env, [repository], deliveryId, action === "unarchived" ? "repository-unarchived" : "repository-visibility-changed");
        return response(202);
      }
      return response(204);
    }
    if (event === "push") {
      const repository = payload.repository; if (!repository || !isManaged(repository) || repository.fork || repository.archived || repository.disabled || payload.deleted || !String(payload.ref).startsWith("refs/heads/") || payload.after === ZERO_SHA) return response(204);
      if (payload.ref === `refs/heads/${repository.default_branch}`) {
        if (payload.before === ZERO_SHA) await send(env, "onboard-repository.yml", { ...repositoryInputs(repository), trigger: "default-branch-push", deliveryId, policySha: env.POLICY_SHA });
        else {
          await send(env, "pr-classification.yml", { deliveryId, repositoryId: String(repository.id), scanAll: "true", policySha: env.POLICY_SHA });
        }
        return response(202);
      }
      return response(204);
    }
    if (event === "pull_request" && ["labeled", "unlabeled"].includes(action)) {
      const repository = payload.repository; const pull = payload.pull_request;
      const riskLabels = semanticCatalog.roles.riskFlags.definitions.flatMap(definition => definition.githubLabel ? [definition.githubLabel.name] : []);
      if (!repository || !isManaged(repository) || !pull || pull.state !== "open" || pull.base?.ref !== repository.default_branch
        || !riskLabels.includes(payload.label?.name)) return response(204);
      await send(env, "pr-classification.yml", { deliveryId, repositoryId: String(repository.id), pullRequestNumber: String(pull.number), eventHeadSha: pull.head.sha, policySha: env.POLICY_SHA });
      return response(202);
    }
    if (event === "pull_request" && ["opened", "synchronize", "reopened", "edited"].includes(action)) {
      const repository = payload.repository; const pull = payload.pull_request;
      if (!repository || !belongsToOrganization(repository) || !pull) return response(204);
      if (Number.isSafeInteger(pull.number))
        await refreshWorkflowContractChecks(env, Number(repository.id), pull.number);
      if (!isManaged(repository)) return response(env.WORKFLOW_EVALUATOR_SHA === undefined ? 204 : 202);
      const targetsDefault = pull.base?.ref === repository.default_branch;
      let dispatched = false;
      if (targetsDefault) {
        await ensureValidationPending(env, repository, pull);
        await send(env, "pr-classification.yml", { deliveryId, repositoryId: String(repository.id), pullRequestNumber: String(pull.number), eventHeadSha: pull.head.sha, policySha: env.POLICY_SHA });
        dispatched = true;
      }
      const reviewDispatched = await dispatchDependabotReview(env, repository, pull, action, deliveryId, payload.changes?.base?.ref?.from);
      return response(dispatched || reviewDispatched ? 202 : 204);
    }
    if (event === "pull_request" && action === "ready_for_review") {
      const repository = payload.repository; const pull = payload.pull_request;
      if (!repository || !isManaged(repository) || !pull || !isStewardOwnedPullRequest(pull, Number(repository.id)) || pull.draft !== false || pull.base?.ref !== repository.default_branch) return response(await dispatchDependabotReview(env, repository, pull, action, deliveryId) ? 202 : 204);
      return response(await requestMaintainersReview(env, repository, pull) ? 202 : 204);
    }
    if (event === "pull_request" && action === "closed" && payload.pull_request?.merged === false) return response(204);
    if (event === "pull_request_review" && ["submitted", "edited", "dismissed"].includes(action)) {
      const repository = payload.repository;
      if (!repository || !belongsToOrganization(repository) || env.WORKFLOW_EVALUATOR_SHA === undefined) return response(204);
      const number = Number(payload.pull_request?.number);
      if (!Number.isSafeInteger(number) || number <= 0) return response(204);
      await refreshWorkflowContractChecks(env, repository.id, number);
      return response(202);
    }
    if (event === "workflow_run" && ["requested", "in_progress", "completed"].includes(action)) {
      const repository = payload.repository; if (!repository || !(isManaged(repository) || (env.WORKFLOW_EVALUATOR_SHA !== undefined && belongsToOrganization(repository)))) return response(204);
      return response(await publishValidationState(env, repository, payload.workflow_run?.id) ? 202 : 204);
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

export async function recoverReleaseReceipts(env: Env, now = Date.now()): Promise<number> {
  if (!env.ISSUE_SNAPSHOTS) return 0;
  const receipts = await new ReleaseReceiptStore(env.ISSUE_SNAPSHOTS).takeRecoveryBatch(now);
  let sent = 0;
  for (const receipt of receipts) {
    const capability = (repositoryCatalog.repositories as Record<string, any>)[String(receipt.frozen.repositoryId)]?.delivery?.githubRelease;
    if (receipt.frozen.policySha !== env.POLICY_SHA || capability?.enabled !== true || !["pending", "active"].includes(capability.state)) continue;
    if (receipt.rebuildRequestKey && (receipt.error === 'rebuild-changed-review-required' || receipt.phase === 'prepared')) {
      await send(env, "release.yml", { repositoryId: String(receipt.frozen.repositoryId), targetTag: receipt.frozen.targetTag, operation: 'revise-rebuild', requestKey: receipt.rebuildRequestKey });
    } else if (receipt.phase === 'prepared') {
      await send(env, "release.yml", { repositoryId: String(receipt.frozen.repositoryId), targetTag: receipt.frozen.targetTag, operation: 'recover-candidate' });
    } else {
      await send(env, "release.yml", { repositoryId: String(receipt.frozen.repositoryId), targetTag: receipt.frozen.targetTag, operation: capability.state === "active" ? "reconcile" : "inspect" });
    }
    sent++;
  }
  return sent;
}

export async function recoverPullRequestBodyWriteIntents(env: Env, now = new Date()): Promise<number> {
  if (!env.ISSUE_SNAPSHOTS) return 0;
  const store = new PullRequestBodyWriteIntentStore(env.ISSUE_SNAPSHOTS);
  const nowIso = now.toISOString();
  const redriveRetryBefore = new Date(now.getTime() - BODY_WRITE_REDRIVE_RETRY_MS).toISOString();
  const retired = await store.retireUnsupportedAutomation(nowIso, 20);
  const expired = retired + await store.blockExpired(nowIso, 20);
  const pending = (await store.listRecoverable(nowIso, 20)).filter(current => current.regionKind === "managed-pr" && ["onboard-repository.yml", "sync-review-instructions.yml"].includes(current.redrive?.workflow ?? ""));
  const queuedRedrives = await store.listPendingRedrives(20, redriveRetryBefore);
  if (!pending.length && !queuedRedrives.length) return expired;
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const dispatchRedrives = async (redrives: readonly PullRequestBodyWriteIntent[]) => {
    for (const current of redrives) {
      if (current.regionKind !== "managed-pr" || !["onboard-repository.yml", "sync-review-instructions.yml"].includes(current.redrive?.workflow ?? "")) continue;
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

async function coordinatedValidation(env: Env, repositoryId: number, payload: Record<string, unknown>): Promise<{changed:boolean}> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new Error('CONTRACT_REPOSITORY');
  const namespace = env.VALIDATION_COORDINATOR!;
  const result = await namespace.get(namespace.idFromName(String(repositoryId))).fetch('https://validation.internal/', {
    method:'POST', body:JSON.stringify(payload), headers:{'content-type':'application/json'},
  });
  if (!result.ok) throw new Error('CONTRACT_COORDINATOR_FAILED');
  return result.json();
}

// Queue all check writers by repository; reread authority and approval after
// entering the queue, and retain ownership through the awaited GitHub write.
export class ValidationCoordinator {
  private readonly queue = new SerialTaskQueue();
  private readonly env: Env;
  constructor(_state: DurableObjectState, env: Env) {
    const {VALIDATION_COORDINATOR: _binding, ...local} = env;
    this.env = local;
  }
  async fetch(request: Request): Promise<Response> {
    return this.queue.run(async () => {
      const value = await request.json() as any;
      if (value.operation === 'refresh') {
        await refreshWorkflowContractChecks(this.env, value.repositoryId, value.pullNumber);
        return response(200, {changed:true});
      }
      if (value.operation === 'run') return response(200, {changed:await publishValidationState(this.env, value.repository, value.workflowRunId)});
      if (value.operation === 'pending') {
        const [owner, repo] = splitRepository(value.repository.full_name);
        const gh = await validationClient(this.env, value.repository.id);
        const pull = await gh.getPullRequest(owner, repo, value.pull.number);
        if (pull.state === 'open') await ensureValidationPending(this.env, value.repository, pull);
        return response(200, {changed:true});
      }
      return response(400);
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return response(200, { status: "ok", policySha: env.POLICY_SHA, evaluatorSha: env.WORKFLOW_EVALUATOR_SHA ?? null, version: env.CF_VERSION_METADATA?.id ?? "local", organizationId: Number(env.ORGANIZATION_ID), appId: Number(env.APP_ID), secretsReady: Boolean(env.STEWARD_APP_PRIVATE_KEY && env.STEWARD_WEBHOOK_SECRET) });
    if (request.method === "POST" && url.pathname === "/github/webhook") {
      if (!env.VALIDATION_COORDINATOR) return response(503, {error:"VALIDATION_COORDINATOR_REQUIRED"});
      return handleWebhook(request, env);
    }
    const internal = await handleBodyWriteInternalRequest(request, env);
    if (internal) return internal;
    const release = await handleReleaseRequest(request, env);
    if (release) return release;
    return response(404);
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const results = await Promise.allSettled([
      recoverPullRequestBodyWriteIntents(env),
      recoverReleaseReceipts(env),
      (async () => {
        // Review webhooks recheck immediately; the full safety sweep runs every 15 minutes.
        if (env.WORKFLOW_EVALUATOR_SHA === undefined || Math.floor(controller.scheduledTime / 60_000) % 15 !== 0) return;
        if (!env.VALIDATION_COORDINATOR) throw new Error('VALIDATION_COORDINATOR_REQUIRED');
        const snapshot = await authoritySnapshot(env);
        // The trusted catalog remains available even when evaluator contents cannot be read.
        const ids = new Set(Object.entries(repositoryCatalog.repositories).filter(([, config]) => config.managed).map(([id]) => id));
        for (const id of Object.keys(snapshot.value?.repositories ?? {})) ids.add(id);
        // Installation metadata also covers repositories governed by catalog defaults.
        // A listing failure must not prevent invalidating known catalog repositories.
        let inventoryError: unknown;
        try {
          if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
          const token = await createInstallationToken({ appId: env.APP_ID, privateKey: env.STEWARD_APP_PRIVATE_KEY, installationId: Number(env.INSTALLATION_ID), permissions: { metadata: "read" }, policySha: env.POLICY_SHA });
          const installed = await new GitHubClient(token, "https://api.github.com", fetch, env.POLICY_SHA).listInstallationRepositories();
          for (const repository of installed.filter(belongsToOrganization)) ids.add(String(repository.id));
        } catch (error) { inventoryError = error; }

        const results = await settledPool([...ids], 4, id => refreshWorkflowContractChecks(env, Number(id), undefined, snapshot));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
        if (inventoryError) throw inventoryError;
      })(),
    ]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  },
};
