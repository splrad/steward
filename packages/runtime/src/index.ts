import { createInstallationToken, dispatchWorkflow, GitHubClient } from "../../github/src/index.js";
import repositoryCatalog from "../../../config/repositories.json" with { type: "json" };

export interface Env {
  ORGANIZATION_ID: string; ORGANIZATION_LOGIN: string; APP_ID: string; INSTALLATION_ID: string;
  STEWARDSHIP_REPOSITORY: string; POLICY_SHA: string; STEWARD_APP_PRIVATE_KEY?: string; STEWARD_WEBHOOK_SECRET?: string;
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
async function send(env: Env, workflow: string, inputs: Record<string, string>) { const [owner, repo] = env.STEWARDSHIP_REPOSITORY.split("/") as [string, string]; await dispatchWorkflow(await dispatcher(env), { owner, repo, workflow, policySha: env.POLICY_SHA, inputs }); }

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
function isManaged(repository: any): boolean { return repository?.owner?.id === Number(repositoryCatalog.organization.id) && repositoryConfiguration(repository).managed === true; }

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
      await send(env, "pr-classification.yml", { deliveryId, repositoryId: String(repository.id), pullRequestNumber: String(pull.number), eventHeadSha: pull.head.sha, policySha: env.POLICY_SHA });
      if (action === "synchronize" && pull.user?.id === 301115370 && pull.head?.repo?.owner?.id === Number(env.ORGANIZATION_ID) && payload.sender?.type === "User") await send(env, "pr-automation.yml", { deliveryId, repositoryId: String(repository.id), sourceRef: `refs/heads/${pull.head.ref}`, eventAfterSha: pull.head.sha, sourceActorId: String(payload.sender.id), sourceActorLogin: String(payload.sender.login), policySha: env.POLICY_SHA });
      return response(202);
    }
    if (event === "pull_request" && action === "closed" && payload.pull_request?.merged && payload.pull_request?.base?.ref === payload.repository?.default_branch) {
      const repository = payload.repository; if (!isManaged(repository) || repositoryConfiguration(repository).releaseProfile !== "layerscape") return response(204);
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
