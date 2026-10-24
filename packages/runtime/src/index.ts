import { isStewardOwnedPullRequest } from "../../core/src/issues.js";
import { createInstallationToken, dispatchWorkflow, GitHubClient } from "../../github/src/index.js";
import repositoryCatalog from "../../../config/repositories.json" with { type: "json" };
import semanticCatalog from "../../../config/labels/pr-semantics.json" with { type: "json" };

export interface Env {
  ORGANIZATION_ID: string; ORGANIZATION_LOGIN: string; APP_ID: string; INSTALLATION_ID: string;
  STEWARDSHIP_REPOSITORY: string; POLICY_SHA: string; STEWARD_APP_PRIVATE_KEY?: string; STEWARD_WEBHOOK_SECRET?: string;
  ISSUE_SNAPSHOTS?: D1Database;
  CF_VERSION_METADATA?: { id: string };
}

const MAX_BODY = 10 * 1024 * 1024;
const ZERO_SHA = "0".repeat(40);

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

function splitRepository(fullName: string): [string, string] {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("仓库完整名称无效");
  return parts as [string, string];
}
function commitSha(value: unknown): string | null {
  const normalized = String(value ?? "").toLowerCase();
  return /^[0-9a-f]{40}$/u.test(normalized) ? normalized : null;
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
    // First adoption requires an explicit reviewed input package and manual managed-sync dispatch.
    if (event === 'installation' || event === 'installation_repositories' || event === 'repository') return response(204);
    if (event === "push") {
      const repository = payload.repository; if (!repository || !isManaged(repository) || repository.fork || repository.archived || repository.disabled || payload.deleted || !String(payload.ref).startsWith("refs/heads/") || payload.after === ZERO_SHA) return response(204);
      if (payload.ref === `refs/heads/${repository.default_branch}`) {
        if (payload.before === ZERO_SHA) return response(204);
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
      if (!isManaged(repository)) return response(204);
      const targetsDefault = pull.base?.ref === repository.default_branch;
      let dispatched = false;
      if (targetsDefault) {
        await send(env, "pr-classification.yml", { deliveryId, repositoryId: String(repository.id), pullRequestNumber: String(pull.number), eventHeadSha: pull.head.sha, policySha: env.POLICY_SHA });
        dispatched = true;
      }
      return response(dispatched ? 202 : 204);
    }
    if (event === "pull_request" && action === "ready_for_review") {
      const repository = payload.repository; const pull = payload.pull_request;
      if (!repository || !isManaged(repository) || !pull || !isStewardOwnedPullRequest(pull, Number(repository.id)) || pull.draft !== false || pull.base?.ref !== repository.default_branch) return response(204);
      return response(await requestMaintainersReview(env, repository, pull) ? 202 : 204);
    }
    if (event === "pull_request" && action === "closed" && payload.pull_request?.merged === false) return response(204);
    return response(204);
  } catch (error) {
    console.error(JSON.stringify({ deliveryId, event, action, repositoryId: payload.repository?.id ?? null, status: "dispatch-failed", policySha: env.POLICY_SHA, error: error instanceof Error ? error.message : "unknown" }));
    return response(503);
  }
}

// Retain the deployed class identity and its stored objects until a separately
// authorized storage retirement. No Gate writer, binding, or scheduler consumes it.
export class ValidationCoordinator {
  async fetch(): Promise<Response> { return response(410); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return response(200, { status: "ok", policySha: env.POLICY_SHA, version: env.CF_VERSION_METADATA?.id ?? "local", organizationId: Number(env.ORGANIZATION_ID), appId: Number(env.APP_ID), secretsReady: Boolean(env.STEWARD_APP_PRIVATE_KEY && env.STEWARD_WEBHOOK_SECRET) });
    if (request.method === "POST" && url.pathname === "/github/webhook") {
      return handleWebhook(request, env);
    }
    return response(404);
  },

};
