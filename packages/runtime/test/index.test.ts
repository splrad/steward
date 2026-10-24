import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { handleWebhook, verifyWebhookSignature, type Env } from "../src/index.js";
import semanticCatalog from "../../../config/labels/pr-semantics.json" with { type: "json" };
import repositoryCatalog from "../../../config/repositories.json" with { type: "json" };
const originalRiskDefinitions = semanticCatalog.roles.riskFlags.definitions;
const originalReviewTrigger = repositoryCatalog.repositories["1296724484"].copilotReviewTrigger;

let privateKey = "";
beforeAll(() => {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } }).privateKey;
});
afterEach(() => {
  semanticCatalog.roles.riskFlags.definitions = originalRiskDefinitions;
  repositoryCatalog.repositories["1296724484"].copilotReviewTrigger = originalReviewTrigger;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const baseEnv = (): Env => ({
  ORGANIZATION_ID: "302208797",
  ORGANIZATION_LOGIN: "splrad",
  APP_ID: "4243096",
  INSTALLATION_ID: "145952003",
  STEWARDSHIP_REPOSITORY: "splrad/steward",
  POLICY_SHA: "a".repeat(40),
  CF_VERSION_METADATA: { id: "0831157d-b402-4db7-aea8-40f2a47ab3ed" },
  STEWARD_APP_PRIVATE_KEY: privateKey,
  STEWARD_WEBHOOK_SECRET: "webhook-value-456",
});
const repository = (id = 1296724484, fullName = "splrad/steward", defaultBranch = "main") => ({ id, full_name: fullName, private: false, fork: false, archived: false, disabled: false, has_issues: true, default_branch: defaultBranch, owner: { id: 302208797 } });
const ownerlessRepository = (id = 1296724484, fullName = "splrad/steward") => {
  const { owner: _owner, ...value } = repository(id, fullName);
  return value;
};
function signedRequest(event: string, payload: unknown, secret = "webhook-value-456"): Request {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("https://example.test/github/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": "delivery-1", "x-hub-signature-256": `sha256=${signature}` } });
}
function scoped(payload: Record<string, unknown>): Record<string, unknown> {
  return { organization: { id: 302208797 }, installation: { id: 145952003 }, ...payload };
}
function installationScoped(payload: Record<string, unknown>): Record<string, unknown> {
  return { installation: { id: 145952003, account: { id: 302208797, login: "splrad" } }, ...payload };
}

describe("中央运行程序", () => {
  it.each([
    { action: "labeled", label: "security", state: "open", base: "main", expected: 202 },
    { action: "unlabeled", label: "security", state: "open", base: "main", expected: 202 },
    { action: "labeled", label: "breaking-change", state: "open", base: "main", expected: 202 },
    { action: "unlabeled", label: "breaking-change", state: "open", base: "main", expected: 202 },
    { action: "labeled", label: "bug", state: "open", base: "main", expected: 204 },
    { action: "labeled", label: "security", state: "closed", base: "main", expected: 204 },
    { action: "labeled", label: "security", state: "open", base: "release", expected: 204 },
  ])("风险标签事件的分类调度 %#", async ({ action, label, state, base, expected }) => {
    semanticCatalog.roles.riskFlags.definitions = [
      ...semanticCatalog.roles.riskFlags.definitions,
      { ...semanticCatalog.roles.riskFlags.definitions[0]!, id: "without-label", githubLabel: null } as any,
    ];
    const dispatched: { workflow: string; inputs: any }[] = [];
    const headSha = "d".repeat(40);
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const endpoint = String(url);
      if (endpoint.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (endpoint.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "main" }));
      const match = /\/actions\/workflows\/([^/]+)\/dispatches/u.exec(endpoint);
      if (match) { dispatched.push({ workflow: match[1]!, inputs: JSON.parse(String(init.body)).inputs }); return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected request ${endpoint}`);
    });
    const payload = scoped({ action, label: { name: label }, repository: repository(),
      pull_request: { number: 8, state, head: { sha: headSha }, base: { ref: base } } });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(expected);
    expect(dispatched).toEqual(expected === 202 ? [{ workflow: "pr-classification.yml", inputs: {
      deliveryId: "delivery-1", repositoryId: "1296724484", pullRequestNumber: "8", eventHeadSha: headSha, policySha: baseEnv().POLICY_SHA,
    } }] : []);
  });
  it("Dependabot默认分支拉取请求只进入平台分类，不派发议题工作流或创建议题检查", async () => {
    const headSha = "d".repeat(40); const dispatched: string[] = []; const checks: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.includes(`/commits/${headSha}/check-runs?per_page=100`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/check-runs")) { checks.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: 101 }), { status: 201 }); }
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      const workflow = /\/actions\/workflows\/([^/]+)\/dispatches/u.exec(value)?.[1];
      if (workflow) { dispatched.push(workflow); return new Response(null, { status: 204 }); }
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({
      action: "opened", repository: repository(),
      pull_request: { number: 160, head: { sha: headSha, repo: { id: 1296724484 } }, base: { ref: "main", repo: { id: 1296724484 } }, user: { id: 49699333 } },
    });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(202);
    expect(dispatched).toEqual(["pr-classification.yml"]);
    expect(checks).toEqual([]);
  });







  it("健康检查不泄露密钥并只返回固定事实", async () => {
    const env = baseEnv();
    const response = await worker.fetch(new Request("https://example.test/health"), env);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(env.STEWARD_WEBHOOK_SECRET);
    expect(text).not.toContain(env.STEWARD_APP_PRIVATE_KEY);
    expect(JSON.parse(text)).toEqual({ status: "ok", policySha: env.POLICY_SHA, version: env.CF_VERSION_METADATA!.id, organizationId: 302208797, appId: 4243096, secretsReady: true });
    expect((await worker.fetch(new Request("https://example.test/unknown"), env)).status).toBe(404);
  });

  it("按原始字节验证HMAC", async () => {
    const body = new TextEncoder().encode("{\"x\":1}");
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(await verifyWebhookSignature(body.buffer, signature, "secret")).toBe(true);
    expect(await verifyWebhookSignature(body.buffer, signature, "other")).toBe(false);
    expect(await verifyWebhookSignature(body.buffer, "sha1=bad", "secret")).toBe(false);
  });















  it("非 Steward PR 即使伪造议题块且关闭未合并也不调度清理", async () => {
    const dispatched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      const name = /\/workflows\/([^/]+)\/dispatches/u.exec(value)?.[1];
      if (name) { dispatched.push(name); return new Response(null, { status: 204 }); }
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({
      action: "closed",
      repository: repository(),
      pull_request: { number: 160, merged: false, merged_at: null, body: "<!-- workflow:issue-links:start repo=1296724484 -->", user: { id: 49699333 }, head: { sha: "d".repeat(40), repo: { id: 1296724484 } }, base: { ref: "main", repo: { id: 1296724484 } } },
    });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(204);
    expect(dispatched).toEqual([]);
  });

  it("草案转为可审查后幂等请求Maintainers团队", async () => {
    const tokenBodies: any[] = []; const reviewBodies: any[] = []; let alreadyRequested = false; let requestedReviewerReads = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url); const method = init?.method ?? "GET";
      if (value.includes("/access_tokens")) {
        tokenBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      }
      if (value.endsWith("/repos/splrad/steward/pulls/8/requested_reviewers") && method === "GET") {
        requestedReviewerReads++;
        return new Response(JSON.stringify({ users: [], teams: alreadyRequested ? [{ slug: "maintainers" }] : [] }), { status: 200 });
      }
      if (value.endsWith("/repos/splrad/steward/pulls/8/requested_reviewers") && method === "POST") {
        reviewBodies.push(JSON.parse(String(init.body))); alreadyRequested = true;
        return new Response(JSON.stringify({ number: 8, requested_teams: [{ slug: "maintainers" }] }), { status: 201 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({
      action: "ready_for_review",
      repository: repository(),
      pull_request: { number: 8, draft: false, user: { id: 301115370 }, head: { sha: "d".repeat(40), repo: { id: 1296724484 } }, base: { ref: "main", repo: { id: 1296724484 } } },
    });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(202);
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(204);
    expect(tokenBodies).toEqual([
      expect.objectContaining({ repository_ids: [1296724484], permissions: { metadata: "read", pull_requests: "write" } }),
      expect.objectContaining({ repository_ids: [1296724484], permissions: { metadata: "read", pull_requests: "write" } }),
    ]);
    expect(reviewBodies).toEqual([{ team_reviewers: ["maintainers"] }]);
    expect(requestedReviewerReads).toBe(2);
  });

  it("团队审查创建响应未确认Maintainers时失败关闭", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url); const method = init?.method ?? "GET";
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/repos/splrad/steward/pulls/8/requested_reviewers") && method === "GET") {
        return new Response(JSON.stringify({ users: [], teams: [] }), { status: 200 });
      }
      if (value.endsWith("/repos/splrad/steward/pulls/8/requested_reviewers") && method === "POST") {
        return new Response(JSON.stringify({ number: 8, requested_teams: [] }), { status: 201 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({
      action: "ready_for_review",
      repository: repository(),
      pull_request: { number: 8, draft: false, user: { id: 301115370 }, head: { sha: "d".repeat(40), repo: { id: 1296724484 } }, base: { ref: "main", repo: { id: 1296724484 } } },
    });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(503);
  });

  it("团队审查编号无效时不签发令牌或调用GitHub API", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      requests++;
      if (String(url).includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({
      action: "ready_for_review",
      repository: repository(),
      pull_request: { number: "invalid", draft: false, user: { id: 301115370 }, head: { sha: "d".repeat(40), repo: { id: 1296724484 } }, base: { ref: "main", repo: { id: 1296724484 } } },
    });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(503);
    expect(requests).toBe(0);
  });

  it("团队审查不会处理外部head上的同作者拉取请求", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => { requests++; return new Response("unexpected", { status: 500 }); });
    const payload = scoped({
      action: "ready_for_review",
      repository: repository(),
      pull_request: { number: 8, draft: false, user: { id: 301115370 }, head: { sha: "d".repeat(40), repo: { id: 987654321 } }, base: { ref: "main", repo: { id: 1296724484 } } },
    });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(204);
    expect(requests).toBe(0);
  });

  it("未绑定候选的普通合并不调度发布，即使涉及版本文件", async () => {
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (String(url).includes("/repos/splrad/LayerScape/pulls/10/files?per_page=100")) return new Response(JSON.stringify([{ filename: "src/Version.props" }, { filename: "src/example.cs" }]), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({ action: "closed", repository: repository(1187527897, "splrad/LayerScape"), pull_request: { number: 10, merged: true, merge_commit_sha: "f".repeat(40), base: { ref: "main" } } });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(204);
    expect(requests).toHaveLength(0);
    expect(requests.some(request => request.url.includes("/actions/workflows/release.yml/dispatches"))).toBe(false);
  });































  it("返回全部拒绝状态并在调度失败时脱敏", async () => {
    const env = baseEnv();
    expect((await handleWebhook(new Request("https://example.test/github/webhook", { method: "POST", headers: { "content-length": String(10 * 1024 * 1024 + 1) } }), env)).status).toBe(413);
    expect((await handleWebhook(new Request("https://example.test/github/webhook", { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256:bad" } }), env)).status).toBe(401);
    const invalidBody = "{";
    const invalidSignature = createHmac("sha256", env.STEWARD_WEBHOOK_SECRET!).update(invalidBody).digest("hex");
    expect((await handleWebhook(new Request("https://example.test/github/webhook", { method: "POST", body: invalidBody, headers: { "x-hub-signature-256": `sha256=${invalidSignature}` } }), env)).status).toBe(400);
    expect((await handleWebhook(signedRequest("push", { organization: { id: 1 }, installation: { id: 145952003 } }), env)).status).toBe(403);
    expect((await handleWebhook(signedRequest("unknown", scoped({ action: "x" })), env)).status).toBe(204);

    vi.stubGlobal("fetch", async (url: string) => String(url).includes("/access_tokens")
      ? new Response(JSON.stringify({ token: "token" }), { status: 201 })
      : new Response("failure", { status: 500 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const payload = scoped({ ref: "refs/heads/main", before: "b".repeat(40), after: "c".repeat(40), deleted: false, repository: repository(), sender: { id: 44151430, login: "axiomoth", type: "User" } });
    expect((await handleWebhook(signedRequest("push", payload), env)).status).toBe(503);
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).not.toContain(env.STEWARD_WEBHOOK_SECRET);
    expect(logged).not.toContain(env.STEWARD_APP_PRIVATE_KEY);
    expect(logged).not.toContain("installation-token");
  });
});

describe("人工 PR 流程与议题自动化退役", () => {
  it.each(["User", "Bot"])("%s 工作分支推送不创建或改写 PR", async type => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await handleWebhook(signedRequest("push", scoped({ repository: repository(), ref: "refs/heads/work", before: "b".repeat(40), after: "c".repeat(40), sender: { id: 44151430, login: "axiomoth", type } })), baseEnv());
    expect(result.status).toBe(204); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["issues", "issue_comment", "sub_issues", "issue_dependencies", "installation", "installation_repositories"])("%s 的旧议题维护事件不请求网络或存储", async event => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const env = { ...baseEnv(), ISSUE_SNAPSHOTS: { prepare: vi.fn(() => { throw new Error("unexpected storage access"); }) } as unknown as D1Database };
    const action = event === "installation_repositories" ? "removed" : "deleted";
    const result = await handleWebhook(signedRequest(event, scoped({ action, repository: repository(), issue: { number: 1 } })), env);
    expect(result.status).toBe(204); expect(fetch).not.toHaveBeenCalled(); expect(env.ISSUE_SNAPSHOTS.prepare).not.toHaveBeenCalled();
  });
  it.each(["opened", "synchronize", "edited", "reopened"])("人工 PR 的 %s 仅派发分类，正文及验证检查不被写入", async action => {
    const workflows: string[] = []; const writes: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "test" }), { status: 201 });
      if (value.includes("/check-runs?")) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      if (value.endsWith("/check-runs")) { writes.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: 1 }), { status: 201 }); }
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      const m = /\/workflows\/([^/]+)\/dispatches$/.exec(value);
      if (m) { workflows.push(m[1]!); return new Response(null, { status: 204 }); }
      throw new Error("unexpected request: " + value);
    });
    const result = await handleWebhook(signedRequest("pull_request", scoped({ action, repository: repository(), pull_request: { number: 8, state: "open", body: "手写内容 Closes #2", user: { id: 44151430, login: "axiomoth", type: "User" }, head: { sha: "d".repeat(40), repo: { id: 1296724484 } }, base: { ref: "main", repo: { id: 1296724484 } } } })), baseEnv());
    expect(result.status).toBe(202); expect(workflows).toEqual(["pr-classification.yml"]);
    expect(writes).toEqual([]);
  });
  it("接入只调度接入工作流，默认分支更新只重新分类", async () => {
    const workflows: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "test" }), { status: 201 });
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      const m = /\/workflows\/([^/]+)\/dispatches$/.exec(value);
      if (m) { workflows.push(m[1]!); return new Response(null, { status: 204 }); }
      throw new Error("unexpected request");
    });
    expect((await handleWebhook(signedRequest("installation", installationScoped({ action: "created", repositories: [ownerlessRepository()] })), baseEnv())).status).toBe(204);
    expect((await handleWebhook(signedRequest("push", scoped({ repository: repository(), ref: "refs/heads/main", before: "b".repeat(40), after: "c".repeat(40) })), baseEnv())).status).toBe(202);
    expect(workflows).toEqual(["pr-classification.yml"]);
  });
  it("公开运行入口拒绝旧快照和关联 API", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const path of ["1296724484", "repositories/reconcile", "1296724484/reconciliation", "1296724484/1/refresh"]) {
      const result = await worker.fetch(new Request("https://runtime.test/internal/issue-snapshots/" + path, { method: "POST" }), baseEnv());
      expect(result.status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('native validation retirement',()=>{
 it.each(['workflow_run','pull_request_review'])('old %s events never write Gate state',async event=>{
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
  for(const action of ['requested','in_progress','completed','submitted','edited','dismissed']) {
   const result=await handleWebhook(signedRequest(event,scoped({action,repository:repository(),workflow_run:{id:123},pull_request:{number:8}})),baseEnv());
   expect(result.status).toBe(204);
  }
  expect(fetchMock).not.toHaveBeenCalled();
 });
 it('public webhook no longer requires a coordinator binding',async()=>{
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
  const result=await worker.fetch(signedRequest('workflow_run',scoped({action:'completed',repository:repository(),workflow_run:{id:123}})),baseEnv());
  expect(result.status).toBe(204);expect(fetchMock).not.toHaveBeenCalled();
 });
});
