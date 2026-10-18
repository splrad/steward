import { createAppJwt, GitHubClient, GitHubRequestError } from "../../github/src/index.js";
import repositoryCatalog from "../../../config/repositories.json" with { type: "json" };
import { confirmPullRequestBodyWriteIntent, normalizePullRequestBodyRedrive, PullRequestBodyWriteIntentStore, type PullRequestBodyWriteIntent } from "./pr-body-write-intents.js";
export interface BodyWriteRuntimeEnv {
  ORGANIZATION_ID: string;
  ORGANIZATION_LOGIN: string;
  APP_ID: string;
  INSTALLATION_ID: string;
  POLICY_SHA: string;
  STEWARD_APP_PRIVATE_KEY?: string;
  ISSUE_SNAPSHOTS?: D1Database;
}

const internalPrefix = "/internal/issue-snapshots/";
const maxInternalResponseBytes = 8 * 1024 * 1024;
const shaPattern = /^[0-9a-f]{40}$/u;
function positiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${name}无效`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name}无效`);
  return number;
}

function noStoreResponse(status: number, body?: unknown): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (body !== undefined) headers.set("Content-Type", "application/json; charset=utf-8");
  const serialized = body === undefined ? null : JSON.stringify(body);
  if (serialized !== null && new TextEncoder().encode(serialized).byteLength > maxInternalResponseBytes) return new Response(JSON.stringify({ error: "internal-response-too-large" }), { status: 413, headers });
  return new Response(serialized, { status, headers });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requireEmptyBody(request: Request): Promise<void> {
  const length = request.headers.get("content-length");
  if (length !== null && length !== "0") throw new Error("内部请求正文必须为空");
  if ((await request.arrayBuffer()).byteLength !== 0) throw new Error("内部请求正文必须为空");
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 512 * 1024) throw new Error("内部请求正文过大");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 512 * 1024) throw new Error("内部请求正文过大");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("内部请求正文无效"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("内部请求正文无效");
  return value as Record<string, unknown>;
}

export async function authorizeSingleRepository(request: Request, env: BodyWriteRuntimeEnv, repositoryId: number): Promise<{ repository: any; client: GitHubClient; managed: boolean }> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]{1,4096})$/u);
  if (!match) throw new GitHubRequestError(401, "GET", "/installation/repositories", "missing-bearer");
  const client = new GitHubClient(match[1]!, "https://api.github.com", fetch, env.POLICY_SHA);
  const repositories = await client.listInstallationRepositories();
  if (repositories.length !== 1) throw new GitHubRequestError(403, "GET", "/installation/repositories", "token-repository-scope");
  const repository = repositories[0];
  if (Number(repository?.id) !== repositoryId || typeof repository?.full_name !== "string") throw new GitHubRequestError(403, "GET", "/installation/repositories", "issue-repository-mismatch");
  const [owner, repo, extra] = repository.full_name.split("/");
  if (!owner || !repo || extra || owner.toLowerCase() !== env.ORGANIZATION_LOGIN.toLowerCase() || Number(repository?.owner?.id) !== Number(env.ORGANIZATION_ID)) throw new GitHubRequestError(403, "GET", "/installation/repositories", "repository-scope");
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const appJwt = await createAppJwt(env.APP_ID, env.STEWARD_APP_PRIVATE_KEY);
  const appClient = new GitHubClient(appJwt, "https://api.github.com", fetch, env.POLICY_SHA);
  const [installation, app, viewer] = await Promise.all([
    appClient.request<any>("GET", `/repos/${owner}/${repo}/installation`),
    appClient.request<any>("GET", "/app"),
    client.request<any>("POST", "/graphql", { query: "query InternalTokenViewer { viewer { login } }" }),
  ]);
  if (Number(installation?.id) !== Number(env.INSTALLATION_ID) || Number(installation?.app_id) !== Number(env.APP_ID)) throw new GitHubRequestError(403, "GET", `/repos/${owner}/${repo}/installation`, "installation-mismatch");
  if (Number(app?.id) !== Number(env.APP_ID) || typeof app?.slug !== "string" || viewer?.errors?.length
    || String(viewer?.data?.viewer?.login).toLowerCase() !== `${app.slug}[bot]`.toLowerCase()) throw new GitHubRequestError(403, "POST", "/graphql", "app-identity-mismatch");
  const current = await client.getRepository(owner, repo);
  if (Number(current?.id) !== repositoryId || String(current?.full_name).toLowerCase() !== repository.full_name.toLowerCase()) throw new GitHubRequestError(403, "GET", `/repos/${owner}/${repo}`, "issue-repository-mismatch");
  const override = (repositoryCatalog.repositories as Record<string, any>)[String(repositoryId)];
  if (override?.fullName && override.fullName !== current.full_name) throw new GitHubRequestError(403, "GET", `/repos/${owner}/${repo}`, "repository-catalog-mismatch");
  const configuration = { ...(current.private ? repositoryCatalog.defaults.private : repositoryCatalog.defaults.public), ...(override ?? {}) };
  const managed = configuration.managed === true;
  if (!managed || current.archived === true || current.disabled === true) throw new GitHubRequestError(403, "GET", `/repos/${owner}/${repo}`, "repository-not-managed");
  return { repository: current, client, managed };
}

export async function handleBodyWriteInternalRequest(request: Request, env: BodyWriteRuntimeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!/^\/internal\/issue-snapshots\/[^/]+\/body-write-intents(?:\/|$)/u.test(url.pathname)) return null;
  if (url.search) return noStoreResponse(400, { error: "internal-query-not-allowed" });
  if (!env.ISSUE_SNAPSHOTS) return noStoreResponse(503, { error: "issue-snapshot-storage-unavailable" });
  const parts = url.pathname.slice(internalPrefix.length).split("/").filter(Boolean);
  let repositoryId: number;
  try { repositoryId = positiveInteger(parts[0] ?? "", "repositoryId"); }
  catch { return noStoreResponse(400, { error: "invalid-repository-id" }); }
  try {
    const { repository, client } = await authorizeSingleRepository(request, env, repositoryId);
    if (parts[1] === "body-write-intents") {
      if (parts.length < 4 || parts.length > 5) return noStoreResponse(404, { error: "internal-route-not-found" });
      let pullRequestNumber: number;
      try { pullRequestNumber = positiveInteger(parts[2]!, "pullRequestNumber"); }
      catch { return noStoreResponse(400, { error: "invalid-pull-request-number" }); }
      const intentStore = new PullRequestBodyWriteIntentStore(env.ISSUE_SNAPSHOTS);
      const now = new Date().toISOString();
      const requireCleanupIntent = async (): Promise<PullRequestBodyWriteIntent | null> => {
        const current = await intentStore.get(repositoryId, pullRequestNumber);
        if (current && (current.regionKind !== "managed-pr" || !["onboard-repository.yml", "sync-review-instructions.yml"].includes(current.redrive?.workflow ?? ""))) throw new GitHubRequestError(403, "POST", url.pathname, "automation-retired");
        return current;
      };
      if (request.method === "POST" && parts.length === 4 && parts[3] === "prepare") {
        const body = await readJsonObject(request);
        if ((body.regionKind !== "managed-pr" || !["onboard-repository.yml", "sync-review-instructions.yml"].includes((body.redrive as any)?.workflow ?? ""))) return noStoreResponse(400, { error: "unsupported-body-write-origin" });
        const regionKind = String(body.regionKind ?? "") as "managed-pr" | "issue-links";
        const redrive = normalizePullRequestBodyRedrive(body.redrive, { repositoryId, pullRequestNumber, regionKind });
        if (redrive.workflow === "onboard-repository.yml" && redrive.inputs.repositoryFullName !== repository.full_name) return noStoreResponse(400, { error: "invalid-internal-request" });
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        return noStoreResponse(200, await intentStore.prepare({
          repositoryId,
          pullRequestNumber,
          writeId: String(body.writeId ?? ""),
          regionKind,
          baseSha: String(body.baseSha ?? ""),
          pullBaseSha: String(body.pullBaseSha ?? body.baseSha ?? ""),
          headSha: String(body.headSha ?? ""),
          issueGeneration: Number(body.issueGeneration ?? 0),
          beforeBodyDigest: String(body.beforeBodyDigest ?? ""),
          outsideBodyDigest: String(body.outsideBodyDigest ?? ""),
          targetBlock: body.targetBlock === null ? null : String(body.targetBlock ?? ""),
          targetBodyDigest: String(body.targetBodyDigest ?? ""),
          now,
          expiresAt,
          redrive,
        }));
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "active") {
        return noStoreResponse(200, await requireCleanupIntent());
      }
      if (parts.length === 4 && request.method === "GET") {
        const current = await requireCleanupIntent();
        if (!current || current.writeId !== parts[3]) return noStoreResponse(404, { error: "body-write-intent-not-found" });
        return noStoreResponse(200, current);
      }
      if (parts.length === 5 && request.method === "POST") {
        const writeId = parts[3]!;
        const current = await requireCleanupIntent();
        if (!current || current.writeId !== writeId) return noStoreResponse(404, { error: "body-write-intent-not-found" });
        if (parts[4] === "pull-base") {
          const body = await readJsonObject(request);
          if (typeof body.pullBaseSha !== "string" || !shaPattern.test(body.pullBaseSha)) return noStoreResponse(400, { error: "invalid-internal-request" });
          return noStoreResponse(200, await intentStore.bindPullBaseSha(repositoryId, pullRequestNumber, writeId, body.pullBaseSha, now));
        }
        if (parts[4] === "patched") {
          await requireEmptyBody(request);
          return noStoreResponse(200, await intentStore.markPatched(repositoryId, pullRequestNumber, writeId, now));
        }
        if (parts[4] === "block") {
          const body = await readJsonObject(request);
          return noStoreResponse(200, await intentStore.block(repositoryId, pullRequestNumber, writeId, String(body.reason ?? "invalid"), now));
        }
        if (parts[4] === "confirm") {
          await requireEmptyBody(request);
          const confirmed = await confirmPullRequestBodyWriteIntent({ store: intentStore, client, repository, pullRequestNumber, writeId, now });
          if (confirmed.writeId !== writeId) return noStoreResponse(404, { error: "body-write-intent-not-found" });
          return noStoreResponse(200, confirmed);
        }
        if (parts[4] === "redrive-completed") {
          await requireEmptyBody(request);
          return noStoreResponse(200, await intentStore.completeRedrive(repositoryId, pullRequestNumber, writeId));
        }
        if (parts[4] === "wait") {
          const body = await readJsonObject(request);
          const attempts = Number(body.attempts);
          if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) return noStoreResponse(400, { error: "invalid-confirmation-attempts" });
          let current = await intentStore.get(repositoryId, pullRequestNumber);
          if (!current || current.writeId !== writeId) return noStoreResponse(404, { error: "body-write-intent-not-found" });
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (["confirmed", "blocked"].includes(current.status)) return noStoreResponse(200, current);
            if (current.status === "patched" && current.deliveryProven && (attempt === 0 || (attempt + 1) % 10 === 0 || attempt + 1 === attempts)) {
              current = await confirmPullRequestBodyWriteIntent({ store: intentStore, client, repository, pullRequestNumber, writeId, now: new Date().toISOString() });
              if (current.writeId !== writeId) return noStoreResponse(404, { error: "body-write-intent-not-found" });
              if (["confirmed", "blocked"].includes(current.status)) return noStoreResponse(200, current);
            }
            if (attempt + 1 < attempts) await delay(500);
            const refreshed = await intentStore.get(repositoryId, pullRequestNumber);
            if (!refreshed || refreshed.writeId !== writeId) return noStoreResponse(404, { error: "body-write-intent-not-found" });
            current = refreshed;
          }
          return noStoreResponse(200, current);
        }
      }
      return noStoreResponse(404, { error: "internal-route-not-found" });
    }
    return noStoreResponse(404, { error: "internal-route-not-found" });
  } catch (error) {
    if (error instanceof GitHubRequestError) {
      if (error.status === 401) return noStoreResponse(401, { error: "internal-token-rejected" });
      if (error.status === 403 || error.status === 404) return noStoreResponse(403, { error: "internal-scope-rejected" });
      return noStoreResponse(502, { error: "github-read-failed" });
    }
    if (error instanceof Error && error.message === "body-write-intent-conflict") return noStoreResponse(409, { error: error.message });
    if (error instanceof Error && (["内部请求正文必须为空", "内部请求正文过大", "内部请求正文无效", "issueNumber无效"].includes(error.message)
      || error.message.startsWith("正文写重调度"))) return noStoreResponse(400, { error: "invalid-internal-request" });
    return noStoreResponse(503, { error: "body-write-operation-failed" });
  }
}
