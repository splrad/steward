import { createInstallationToken, dispatchWorkflow, GitHubClient } from "../../github/src/index.js";
import repositoryCatalog from "../../../config/repositories.json" with { type: "json" };

export interface Env {
  ORGANIZATION_ID: string; ORGANIZATION_LOGIN: string; APP_ID: string; INSTALLATION_ID: string;
  STEWARDSHIP_REPOSITORY: string; POLICY_SHA: string; STEWARD_APP_PRIVATE_KEY?: string; STEWARD_WEBHOOK_SECRET?: string;
  CF_VERSION_METADATA?: { id: string };
}

const MAX_BODY = 10 * 1024 * 1024;
const ZERO_SHA = "0".repeat(40);
const VALIDATION_WORKFLOW_NAME = "SPLRAD Steward / PR Validation";
const VALIDATION_WORKFLOW_PATH = ".github/workflows/pr-validation.yml";
const VALIDATION_CHECK_NAME = "PR Validation Gate";

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
async function send(env: Env, workflow: string, inputs: Record<string, string>) { const [owner, repo] = env.STEWARDSHIP_REPOSITORY.split("/") as [string, string]; await dispatchWorkflow(await dispatcher(env), { owner, repo, workflow, policySha: env.POLICY_SHA, inputs }); }

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
function selectValidationCheck(checkRuns: readonly any[], headSha: string, appId: number): any | null {
  const matches = checkRuns.filter(value => value?.name === VALIDATION_CHECK_NAME
    && Number(value.app?.id) === appId
    && commitSha(value.head_sha) === headSha);
  if (matches.length > 1) throw new Error("同名拉取请求验证检查存在歧义");
  return matches[0] ?? null;
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
  const current = selectValidationCheck(await gh.listAllCheckRuns(owner, repo, headSha), headSha, Number(env.APP_ID));
  if (current) return;
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
function existingValidationBlocksUpdate(externalId: unknown, repositoryId: number, pullRequestNumber: number, headSha: string, runId: number, attempt: number, incomingCompleted: boolean): boolean {
  const value = String(externalId ?? "");
  if (value === `${repositoryId}:${pullRequestNumber}:${headSha}:pending`) return false;
  const match = new RegExp(`^${repositoryId}:${pullRequestNumber}:${headSha}:(\\d+):(\\d+)(:pending)?$`, "u").exec(value);
  if (!match) throw new Error("现有拉取请求验证检查上下文无效");
  const existingRunId = Number(match[1]); const existingAttempt = Number(match[2]);
  if (existingRunId !== runId) return existingRunId > runId;
  if (existingAttempt !== attempt) return existingAttempt > attempt;
  const existingPending = Boolean(match[3]);
  return !existingPending || !incomingCompleted;
}
async function publishValidationState(env: Env, repository: any, workflowRunId: unknown): Promise<boolean> {
  const runId = Number(workflowRunId);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("工作流运行编号无效");
  const [owner, repo] = splitRepository(String(repository.full_name));
  const gh = await validationClient(env, Number(repository.id));
  const run = await gh.getWorkflowRun(owner, repo, runId);
  if (!trustedValidationRun(run, repository)) return false;
  const headSha = commitSha(run.head_sha)!;
  const pulls = (await gh.listOpenPullRequests(owner, repo, String(repository.default_branch))).filter((pull: any) =>
    pull?.base?.ref === repository.default_branch && commitSha(pull?.head?.sha) === headSha);
  if (!pulls.length) return false;
  if (pulls.length > 1) throw new Error("工作流运行对应多个当前拉取请求");
  const pull = pulls[0]!; const number = Number(pull.number);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("拉取请求编号无效");
  const check = selectValidationCheck(await gh.listAllCheckRuns(owner, repo, headSha), headSha, Number(env.APP_ID));
  const conclusion = validationConclusion(run.conclusion); const completed = run.status === "completed";
  if (check && existingValidationBlocksUpdate(check.external_id, Number(repository.id), number, headSha, run.id, run.run_attempt, completed)) return false;
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
  if (check) await gh.updateCheckRun(owner, repo, check.id, body);
  else await gh.createCheckRun(owner, repo, body);
  return true;
}

async function pullRequestChangesVersion(env: Env, repository: any, pullRequestNumber: number): Promise<boolean> {
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const [owner, repo] = String(repository.full_name).split("/") as [string, string];
  const token = await createInstallationToken({ appId: env.APP_ID, privateKey: env.STEWARD_APP_PRIVATE_KEY, installationId: Number(env.INSTALLATION_ID), repositoryId: Number(repository.id), permissions: { metadata: "read", pull_requests: "read" }, policySha: env.POLICY_SHA });
  const files = await new GitHubClient(token, "https://api.github.com", fetch, env.POLICY_SHA).listPullFiles(owner, repo, pullRequestNumber);
  return files.some(file => file?.filename === "Version.props");
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

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0"); if (declared > MAX_BODY) return response(413);
  const bytes = await request.arrayBuffer(); if (bytes.byteLength > MAX_BODY) return response(413);
  if (!env.STEWARD_WEBHOOK_SECRET || !await verifyWebhookSignature(bytes, request.headers.get("x-hub-signature-256"), env.STEWARD_WEBHOOK_SECRET)) return response(401);
  let payload: any; try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { return response(400); }
  if (!validScope(payload, env)) return response(403);
  const event = request.headers.get("x-github-event") ?? ""; const deliveryId = request.headers.get("x-github-delivery") ?? ""; const action = payload.action ?? "";
  try {
    if (event === "installation" && action === "created") {
      for (const repository of payload.repositories ?? []) if (isManaged(repository)) await send(env, "onboard-repository.yml", { ...repositoryInputs(repository), trigger: "installation-created", deliveryId, policySha: env.POLICY_SHA });
      return response(202);
    }
    if (event === "installation_repositories" && action === "added") {
      for (const repository of payload.repositories_added ?? []) if (isManaged(repository)) await send(env, "onboard-repository.yml", { ...repositoryInputs(repository), trigger: "installation-repositories-added", deliveryId, policySha: env.POLICY_SHA });
      return response(202);
    }
    if (event === "push") {
      const repository = payload.repository; if (!repository || !isManaged(repository) || repository.fork || repository.archived || repository.disabled || payload.deleted || !String(payload.ref).startsWith("refs/heads/") || payload.after === ZERO_SHA) return response(204);
      if (payload.ref === `refs/heads/${repository.default_branch}`) {
        if (payload.before === ZERO_SHA) await send(env, "onboard-repository.yml", { ...repositoryInputs(repository), trigger: "default-branch-push", deliveryId, policySha: env.POLICY_SHA });
        else await send(env, "pr-classification.yml", { deliveryId, repositoryId: String(repository.id), scanAll: "true", policySha: env.POLICY_SHA });
        return response(202);
      }
      const sender = payload.sender; if (!sender || sender.type !== "User" || String(sender.login).endsWith("[bot]")) return response(204);
      await send(env, "pr-automation.yml", { deliveryId, repositoryId: String(repository.id), sourceRef: payload.ref, eventAfterSha: payload.after, sourceActorId: String(sender.id), sourceActorLogin: String(sender.login), policySha: env.POLICY_SHA }); return response(202);
    }
    if (event === "pull_request" && ["opened", "synchronize", "reopened", "edited"].includes(action)) {
      const repository = payload.repository; const pull = payload.pull_request; if (!repository || !isManaged(repository) || !pull || pull.base?.ref !== repository.default_branch) return response(204);
      if (action !== "edited") await ensureValidationPending(env, repository, pull);
      await send(env, "pr-classification.yml", { deliveryId, repositoryId: String(repository.id), pullRequestNumber: String(pull.number), eventHeadSha: pull.head.sha, policySha: env.POLICY_SHA });
      if (action === "synchronize" && pull.user?.id === 301115370 && pull.head?.repo?.owner?.id === Number(env.ORGANIZATION_ID) && payload.sender?.type === "User") await send(env, "pr-automation.yml", { deliveryId, repositoryId: String(repository.id), sourceRef: `refs/heads/${pull.head.ref}`, eventAfterSha: pull.head.sha, sourceActorId: String(payload.sender.id), sourceActorLogin: String(payload.sender.login), policySha: env.POLICY_SHA });
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return response(200, { status: "ok", policySha: env.POLICY_SHA, version: env.CF_VERSION_METADATA?.id ?? "local", organizationId: Number(env.ORGANIZATION_ID), appId: Number(env.APP_ID), secretsReady: Boolean(env.STEWARD_APP_PRIVATE_KEY && env.STEWARD_WEBHOOK_SECRET) });
    if (request.method === "POST" && url.pathname === "/github/webhook") return handleWebhook(request, env);
    return response(404);
  },
};
