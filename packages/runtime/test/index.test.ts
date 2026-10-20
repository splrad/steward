import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { handleWebhook, validationConclusion, verifyWebhookSignature, type Env } from "../src/index.js";
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
  it.each(['opened','synchronize','reopened','edited'])('ignores unmanaged private PR %s before contract refresh',async action=>{
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    const repo={...repository(987654321,'splrad/private-other'),private:true};
    const request=signedRequest('pull_request',scoped({action,repository:repo,pull_request:{number:7}}));
    expect((await handleWebhook(request,{...baseEnv(),WORKFLOW_EVALUATOR_SHA:'b'.repeat(40)})).status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });
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
    expect(checks.map(check => check.name)).toEqual(["PR Validation Gate"]);
  });







  it("健康检查不泄露密钥并只返回固定事实", async () => {
    const env = baseEnv();
    const response = await worker.fetch(new Request("https://example.test/health"), env);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(env.STEWARD_WEBHOOK_SECRET);
    expect(text).not.toContain(env.STEWARD_APP_PRIVATE_KEY);
    expect(JSON.parse(text)).toEqual({ status: "ok", policySha: env.POLICY_SHA, evaluatorSha: null, version: env.CF_VERSION_METADATA!.id, organizationId: 302208797, appId: 4243096, secretsReady: true });
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

  it("只把GitHub API核实的当前PR验证运行同步到来源提交的全部有效重复检查", async () => {
    const headSha = "d".repeat(40); const runId = 777; const writes: Array<{ url: string; body: any }> = []; const tokenBodies: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url);
      if (value.includes("/access_tokens")) {
        tokenBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      }
      if (value.endsWith(`/repos/splrad/steward/actions/runs/${runId}`)) return new Response(JSON.stringify({
        id: runId,
        workflow_id: 335795406,
        workflow_url: "https://api.github.com/repos/splrad/steward/actions/required_workflows/335795406",
        run_attempt: 2,
        repository: { id: 1296724484 },
        name: "SPLRAD Steward / PR Validation",
        path: ".github/workflows/pr-validation.yml",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        head_sha: headSha, head_repository: { id: 1296724484 }, head_branch: "feature", pull_requests: [],
        html_url: `https://github.com/splrad/steward/actions/runs/${runId}`,
      }), { status: 200 });
      if (value.includes(`/commits/${headSha}/pulls?per_page=100`)) return new Response(JSON.stringify([
        { number: 8, state: "open", base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: headSha, ref: "feature", repo: { id: 1296724484 } } },
        { number: 9, state: "closed", base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: headSha, ref: "feature", repo: { id: 1296724484 } } },
        { number: 10, state: "open", base: { ref: "release", repo: { id: 1296724484 } }, head: { sha: headSha, ref: "feature", repo: { id: 1296724484 } } },
        { number: 11, state: "open", base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: "e".repeat(40), ref: "feature", repo: { id: 1296724484 } } },
      ]), { status: 200 });
      if (value.includes(`/commits/${headSha}/check-runs?per_page=100`)) return new Response(JSON.stringify({ check_runs: [
        { id: 91, name: "PR Validation Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `1296724484:8:${headSha}:pending` },
        { id: 92, name: "PR Validation Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `1296724484:8:${headSha}:${runId}:2:pending` },
        { id: 93, name: "PR Validation Gate", app: { id: 4243096 }, head_sha: headSha, external_id: "malformed-context" },
      ] }), { status: 200 });
      if (/\/repos\/splrad\/steward\/check-runs\/(91|92)$/u.test(value)) {
        writes.push({ url: value, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ id: Number(value.split("/").at(-1)) }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({ action: "completed", repository: repository(), workflow_run: { id: runId, conclusion: "failure", head_sha: "f".repeat(40) } });
    expect((await handleWebhook(signedRequest("workflow_run", payload), baseEnv())).status).toBe(202);
    expect(tokenBodies).toEqual([expect.objectContaining({
      repository_ids: [1296724484],
      permissions: { actions: "read", checks: "write", metadata: "read", pull_requests: "read" },
    })]);
    expect(writes.map(value => value.url)).toEqual([
      "https://api.github.com/repos/splrad/steward/check-runs/91",
      "https://api.github.com/repos/splrad/steward/check-runs/92",
    ]);
    for (const write of writes) expect(write.body).toEqual(expect.objectContaining({
      name: "PR Validation Gate",
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      details_url: `https://github.com/splrad/steward/actions/runs/${runId}`,
      external_id: `1296724484:8:${headSha}:${runId}:2`,
    }));
  });

  it.each(["pending", "777:2"])("同名检查遮蔽已有 %s 状态时不重复创建等待门禁", async previous => {
    const headSha = "d".repeat(40); const writes: unknown[] = [];
    const own = { id: 91, name: "PR Validation Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `1296724484:8:${headSha}:${previous}` };
    const other = { ...own, id: 92, external_id: `1296724484:9:${headSha}:pending` };
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url); const parsed = new URL(value);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (parsed.pathname.endsWith(`/commits/${headSha}/check-runs`)) {
        if (parsed.searchParams.get("filter") !== "all") return Response.json({ check_runs: [other] });
        if (parsed.searchParams.get("page") === "2") return Response.json({ check_runs: [own] });
        return Response.json({ check_runs: [other] }, { headers: { link: `<${value}&page=2>; rel="next"` } });
      }
      if (value.endsWith("/check-runs")) { writes.push(JSON.parse(String(init.body))); return Response.json({ id: 93 }, { status: 201 }); }
      if (value.endsWith("/repos/splrad/steward")) return Response.json({ default_branch: "main" });
      if (value.endsWith("/dispatches")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${value}`);
    });
    const payload = scoped({ action: "opened", repository: repository(),
      pull_request: { number: 8, head: { sha: headSha, repo: { id: 1296724484 } }, base: { ref: "main", repo: { id: 1296724484 } }, user: { id: 301115370 } } });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(202);
    expect(writes).toEqual([]);
  });

  it.each([
    { name: "成功结果收敛全部等待记录", previous: "pending", status: "completed", conclusion: "success", update: true },
    { name: "失败结果收敛全部等待记录", previous: "pending", status: "completed", conclusion: "failure", update: true },
    { name: "新运行撤销旧成功记录", previous: "776:1", status: "in_progress", conclusion: null, update: true },
    { name: "重复完成仍补齐遗漏的等待记录", previous: "777:2", status: "completed", conclusion: "success", update: true },
    { name: "较新运行被遮蔽时拒绝旧运行", previous: "778:1", status: "completed", conclusion: "success", update: false },
    { name: "较新尝试被遮蔽时拒绝旧尝试", previous: "777:3", status: "completed", conclusion: "success", update: false },
    { name: "完成状态被遮蔽时拒绝迟到的进行中事件", previous: "777:2", status: "in_progress", conclusion: null, update: false },
  ])("完整检查历史：$name", async scenario => {
    const headSha = "d".repeat(40); const writes: Array<{ url: string; body: any }> = [];
    const run = { id: 777, workflow_id: 335795406,
      workflow_url: "https://api.github.com/repos/splrad/steward/actions/required_workflows/335795406",
      run_attempt: 2, repository: { id: 1296724484 }, name: "SPLRAD Steward / PR Validation",
      path: ".github/workflows/pr-validation.yml", event: "pull_request", status: scenario.status, conclusion: scenario.conclusion,
      head_sha: headSha, head_repository: { id: 987654321 }, head_branch: "fork-feature", pull_requests: [],
      html_url: "https://github.com/splrad/steward/actions/runs/777" };
    const pull = { number: 8, state: "open", base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: headSha, ref: "fork-feature", repo: { id: 987654321 } } };
    const own = { id: 91, name: "PR Validation Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `1296724484:8:${headSha}:${scenario.previous}` };
    const pending = { ...own, id: 92, external_id: `1296724484:8:${headSha}:pending` };
    const other = { ...own, id: 93, external_id: `1296724484:9:${headSha}:pending` };
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url); const parsed = new URL(value);
      if (value.includes("/access_tokens")) return Response.json({ token: "installation-token" }, { status: 201 });
      if (value.endsWith("/actions/runs/777")) return Response.json(run);
      if (parsed.pathname.endsWith(`/commits/${headSha}/pulls`)) return Response.json([]);
      if (value.includes("/pulls?state=open&base=main&per_page=100")) return Response.json([pull]);
      if (parsed.pathname.endsWith(`/commits/${headSha}/check-runs`)) {
        if (parsed.searchParams.get("filter") !== "all") return Response.json({ check_runs: [other] });
        if (parsed.searchParams.get("page") === "2") return Response.json({ check_runs: [own, pending,
          { ...own, id: 94, app: { id: 42 } }, { ...own, id: 95, head_sha: "e".repeat(40) }] });
        return Response.json({ check_runs: [other] }, { headers: { link: `<${value}&page=2>; rel="next"` } });
      }
      if (value.includes("/check-runs") && ["POST", "PATCH"].includes(init.method ?? "")) {
        writes.push({ url: value, body: JSON.parse(String(init.body)) }); return Response.json({ id: 91 });
      }
      throw new Error(`Unexpected request ${value}`);
    });
    const payload = scoped({ action: scenario.status, repository: repository(), workflow_run: { id: 777 } });
    expect((await handleWebhook(signedRequest("workflow_run", payload), baseEnv())).status).toBe(scenario.update ? 202 : 204);
    const ids = !scenario.update ? [] : scenario.previous === "777:2" ? [92] : [91, 92];
    expect(writes.map(write => write.url)).toEqual(ids.map(id => `https://api.github.com/repos/splrad/steward/check-runs/${id}`));
    for (const write of writes) {
      expect(write.body).toEqual(expect.objectContaining({ status: scenario.status,
        external_id: `1296724484:8:${headSha}:777:2${scenario.status === "in_progress" ? ":pending" : ""}` }));
      if (scenario.status === "completed") expect(write.body.conclusion).toBe(scenario.conclusion);
      else expect(write.body).not.toHaveProperty("conclusion");
    }
  });

  it("默认分支变化产生新运行时立即撤销旧的成功门禁", async () => {
    const headSha = "d".repeat(40); const runId = 779; let written: any = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith(`/actions/runs/${runId}`)) return new Response(JSON.stringify({
        id: runId,
        workflow_id: 335795406,
        workflow_url: "https://api.github.com/repos/splrad/steward/actions/required_workflows/335795406",
        run_attempt: 1,
        repository: { id: 1296724484 },
        name: "SPLRAD Steward / PR Validation",
        path: ".github/workflows/pr-validation.yml",
        event: "pull_request",
        status: "in_progress",
        conclusion: null,
        head_sha: headSha, head_repository: { id: 1296724484 }, head_branch: "feature", pull_requests: [],
        html_url: `https://github.com/splrad/steward/actions/runs/${runId}`,
      }), { status: 200 });
      if (value.includes(`/commits/${headSha}/pulls?per_page=100`)) return new Response(JSON.stringify([{ number: 8, state: "open", base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: headSha, ref: "feature", repo: { id: 1296724484 } } }]), { status: 200 });
      if (value.includes(`/commits/${headSha}/check-runs?per_page=100`)) return new Response(JSON.stringify({ check_runs: [{ id: 91, name: "PR Validation Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `1296724484:8:${headSha}:778:1` }] }), { status: 200 });
      if (value.endsWith("/check-runs/91")) { written = JSON.parse(String(init.body)); return new Response(JSON.stringify({ id: 91 }), { status: 200 }); }
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({ action: "in_progress", repository: repository(), workflow_run: { id: runId } });
    expect((await handleWebhook(signedRequest("workflow_run", payload), baseEnv())).status).toBe(202);
    expect(written).toEqual(expect.objectContaining({
      name: "PR Validation Gate",
      head_sha: headSha,
      status: "in_progress",
      external_id: `1296724484:8:${headSha}:${runId}:1:pending`,
    }));
    expect(written).not.toHaveProperty("conclusion");
  });

  it("忽略同名本地工作流和已经漂移的来源提交", async () => {
    const headSha = "d".repeat(40); const requests: string[] = []; let workflowUrl = "https://api.github.com/repos/splrad/steward/actions/workflows/335795406";
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url); requests.push(value);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.includes("/actions/runs/778")) return new Response(JSON.stringify({ id: 778, workflow_id: 335795406, workflow_url: workflowUrl, run_attempt: 1, repository: { id: 1296724484 }, name: "SPLRAD Steward / PR Validation", path: ".github/workflows/pr-validation.yml", event: "pull_request", status: "completed", conclusion: "success", head_sha: headSha, head_repository: { id: 1296724484 }, head_branch: "feature", pull_requests: [], html_url: "https://github.com/splrad/steward/actions/runs/778" }), { status: 200 });
      if (value.includes(`/commits/${headSha}/pulls?per_page=100`)) return new Response(JSON.stringify([{ number: 8, state: "open", base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: "e".repeat(40), ref: "feature", repo: { id: 1296724484 } } }]), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({ action: "completed", repository: repository(), workflow_run: { id: 778 } });
    expect((await handleWebhook(signedRequest("workflow_run", payload), baseEnv())).status).toBe(204);
    expect(requests.some(value => value.includes("/pulls?"))).toBe(false);
    workflowUrl = "https://api.github.com/repos/splrad/steward/actions/required_workflows/335795406";
    requests.length = 0;
    expect((await handleWebhook(signedRequest("workflow_run", payload), baseEnv())).status).toBe(204);
    expect(requests.some(value => value.includes("/check-runs"))).toBe(false);
  });

  it("同一来源提交对应多个开放拉取请求时安静地保持失败关闭", async () => {
    const headSha = "d".repeat(40); const runId = 780; const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url); requests.push(value);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith(`/actions/runs/${runId}`)) return new Response(JSON.stringify({
        id: runId,
        workflow_id: 335795406,
        workflow_url: "https://api.github.com/repos/splrad/steward/actions/required_workflows/335795406",
        run_attempt: 1,
        repository: { id: 1296724484 },
        name: "SPLRAD Steward / PR Validation",
        path: ".github/workflows/pr-validation.yml",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        head_sha: headSha, head_repository: { id: 1296724484 }, head_branch: "feature", pull_requests: [],
        html_url: `https://github.com/splrad/steward/actions/runs/${runId}`,
      }), { status: 200 });
      if (value.includes(`/commits/${headSha}/pulls?per_page=100`)) return new Response(JSON.stringify([
        { number: 8, state: "open", base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: headSha, ref: "feature", repo: { id: 1296724484 } } },
        { number: 9, state: "open", base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: headSha, ref: "feature", repo: { id: 1296724484 } } },
      ]), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({ action: "completed", repository: repository(), workflow_run: { id: runId } });
    expect((await handleWebhook(signedRequest("workflow_run", payload), baseEnv())).status).toBe(204);
    expect(requests.some(value => value.includes("/check-runs"))).toBe(false);
  });

  it.each([
    { name: "fork等待批准不能覆盖同SHA的上游PR", run: { head_repository: { id: 987654321 }, conclusion: "action_required" }, expected: false },
    { name: "同仓其他分支不能借用同SHA结果", run: { head_branch: "other" }, expected: false },
    { name: "缺少来源仓库时不发布", run: { head_repository: null }, expected: false },
    { name: "来源仓库ID无效时不发布", run: { head_repository: { id: 0 } }, expected: false },
    { name: "来源仓库ID类型无效时不发布", run: { head_repository: { id: "1296724484" } }, expected: false },
    { name: "缺少来源分支时不发布", run: { head_branch: null }, expected: false },
    { name: "来源分支为空时不发布", run: { head_branch: "" }, expected: false },
    { name: "缺少PR关联字段时不发布", run: { pull_requests: null }, expected: false },
    { name: "运行关联其他PR时不发布", run: { pull_requests: [{ number: 9 }] }, expected: false },
    { name: "回读运行编号不一致时不发布", run: { id: 999 }, expected: false },
    { name: "目标仓库不同不发布", pull: { base: { ref: "main", repo: { id: 987654321 } } }, expected: false },
    { name: "当前PR已更新时不发布旧head", pull: { head: { sha: "e".repeat(40), ref: "feature", repo: { id: 1296724484 } } }, expected: false },
    { name: "候选PR缺少来源仓库时不发布", pull: { head: { sha: "d".repeat(40), ref: "feature", repo: null } }, expected: false },
    { name: "来源相同但多个PR未消歧时不发布", duplicate: true, expected: false },
    { name: "同SHA不同仓库的PR只更新匹配者", otherRepository: true, expected: true },
    { name: "同SHA不同分支的PR只更新匹配者", otherBranch: true, expected: true },
    { name: "显式PR编号在相同来源候选中消歧", duplicate: true, run: { pull_requests: [{ number: 8 }] }, expected: true },
    { name: "空PR列表且来源唯一时保持合法同仓验证", expected: true },
    { name: "明确关联的合法运行正常发布", run: { pull_requests: [{ number: 8 }] }, expected: true },
    { name: "合法fork候选存在时发布其真实失败", run: { head_repository: { id: 987654321 }, conclusion: "action_required" }, pull: { head: { sha: "d".repeat(40), ref: "feature", repo: { id: 987654321 } } }, expected: true },
    { name: "旧运行不能覆盖较新运行", previous: "781:1", expected: false },
    { name: "旧尝试不能覆盖较新尝试", previous: "780:2", expected: false },
    { name: "同次运行重复完成不写入", previous: "780:1", expected: false },
    { name: "同次运行迟到的进行中事件不撤销完成", previous: "780:1", run: { status: "in_progress", conclusion: null }, expected: false },
  ])("验证运行归属：$name", async scenario => {
    const options = scenario as { run?: Record<string, unknown>; pull?: Record<string, unknown>; duplicate?: boolean; otherRepository?: boolean; otherBranch?: boolean; previous?: string; expected: boolean };
    const headSha = "d".repeat(40); const runId = 780;
    const run = {
      id: runId, workflow_id: 335795406,
      workflow_url: "https://api.github.com/repos/splrad/steward/actions/required_workflows/335795406",
      run_attempt: 1, repository: { id: 1296724484 }, name: "SPLRAD Steward / PR Validation",
      path: ".github/workflows/pr-validation.yml", event: "pull_request", status: "completed", conclusion: "success",
      head_sha: headSha, head_repository: { id: 1296724484 }, head_branch: "feature", pull_requests: [],
      html_url: `https://github.com/splrad/steward/actions/runs/${runId}`, ...options.run,
    };
    const pull = { number: 8, state: "open", base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: headSha, ref: "feature", repo: { id: 1296724484 } }, ...options.pull };
    const candidates = [pull];
    if (options.duplicate) candidates.push({ ...pull, number: 9 });
    if (options.otherRepository) candidates.push({ ...pull, number: 9, head: { sha: headSha, ref: "feature", repo: { id: 987654321 } } });
    if (options.otherBranch) candidates.push({ ...pull, number: 9, head: { sha: headSha, ref: "other", repo: { id: 1296724484 } } });
    const writes: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith(`/actions/runs/${runId}`)) return new Response(JSON.stringify(run));
      if (value.includes(`/commits/${headSha}/pulls?per_page=100`)) return new Response(JSON.stringify(candidates));
      if (value.includes("/pulls?state=open&base=main&per_page=100")) return new Response(JSON.stringify([]));
      if (value.includes(`/commits/${headSha}/check-runs?per_page=100`)) return new Response(JSON.stringify({ check_runs: [
        { id: 91, name: "PR Validation Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `1296724484:8:${headSha}:${options.previous ?? "pending"}` },
        { id: 92, name: "PR Validation Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `1296724484:9:${headSha}:pending` },
      ] }));
      if (value.includes("/check-runs") && ["POST", "PATCH"].includes(init.method ?? "")) {
        writes.push({ url: value, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ id: 91 }));
      }
      throw new Error(`Unexpected request ${value}`);
    });
    const payload = scoped({ action: run.status, repository: repository(), workflow_run: { id: runId } });
    expect((await handleWebhook(signedRequest("workflow_run", payload), baseEnv())).status).toBe(options.expected ? 202 : 204);
    expect(writes).toHaveLength(options.expected ? 1 : 0);
    if (options.expected) expect(writes[0]).toEqual({
      url: "https://api.github.com/repos/splrad/steward/check-runs/91",
      body: expect.objectContaining({ external_id: `1296724484:8:${headSha}:${runId}:1`, conclusion: run.conclusion === "success" ? "success" : "failure" }),
    });
  });

  it.each([
    { name: "关联接口只返回上游PR时补全fork候选", expected: true },
    { name: "关联接口为空时补全fork候选", empty: true, expected: true },
    { name: "等待批准时只写fork失败", conclusion: "action_required", expected: true },
    { name: "来源分支不同不写入", patch: { head: { sha: "d".repeat(40), ref: "other", repo: { id: 987654321 } } }, expected: false },
    { name: "来源仓库不同不写入", patch: { head: { sha: "d".repeat(40), ref: "fork-feature", repo: { id: 1296724484 } } }, expected: false },
    { name: "fork当前head已变化不写入", patch: { head: { sha: "e".repeat(40), ref: "fork-feature", repo: { id: 987654321 } } }, expected: false },
    { name: "非默认目标不写入", patch: { base: { ref: "release", repo: { id: 1296724484 } } }, expected: false },
    { name: "目标仓库不同不写入", patch: { base: { ref: "main", repo: { id: 987654321 } } }, expected: false },
    { name: "已关闭候选不写入", patch: { state: "closed" }, expected: false },
    { name: "多个匹配fork候选不写入", duplicate: true, expected: false },
    { name: "显式关联其他PR不写入", linked: [{ number: 8 }], expected: false },
    { name: "补全接口失败不写入", apiFailure: true, expected: false },
    { name: "匹配fork已有较新结果不覆盖", previous: "781:1", expected: false },
  ])("fork候选补全：$name", async scenario => {
    const options = scenario as { empty?: boolean; conclusion?: string; patch?: Record<string, unknown>; duplicate?: boolean; linked?: { number: number }[]; apiFailure?: boolean; previous?: string; expected: boolean };
    const headSha = "d".repeat(40);
    const upstream = { number: 8, state: "open", base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: headSha, ref: "feature", repo: { id: 1296724484 } } };
    const fork = { ...upstream, number: 9, head: { sha: headSha, ref: "fork-feature", repo: { id: 987654321 } }, ...options.patch };
    const candidates = [upstream, fork, ...(options.duplicate ? [{ ...fork, number: 10 }] : [])];
    const writes: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/actions/runs/780")) return new Response(JSON.stringify({
        id: 780, workflow_id: 335795406, workflow_url: "https://api.github.com/repos/splrad/steward/actions/required_workflows/335795406",
        run_attempt: 1, repository: { id: 1296724484 }, name: "SPLRAD Steward / PR Validation", path: ".github/workflows/pr-validation.yml",
        event: "pull_request", status: "completed", conclusion: options.conclusion ?? "success", head_sha: headSha,
        head_repository: { id: 987654321 }, head_branch: "fork-feature", pull_requests: options.linked ?? [], html_url: "https://github.com/splrad/steward/actions/runs/780",
      }));
      if (value.includes(`/commits/${headSha}/pulls?per_page=100`)) return new Response(JSON.stringify(options.empty ? [] : [upstream]));
      if (value.includes("/pulls?state=open&base=main&per_page=100")) return options.apiFailure ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify(candidates));
      if (value.includes(`/commits/${headSha}/check-runs?per_page=100`)) return new Response(JSON.stringify({ check_runs: [
        { id: 91, name: "PR Validation Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `1296724484:8:${headSha}:779:1` },
        { id: 92, name: "PR Validation Gate", app: { id: 4243096 }, head_sha: headSha, external_id: `1296724484:9:${headSha}:${options.previous ?? "pending"}` },
      ] }));
      if (value.includes("/check-runs") && ["POST", "PATCH"].includes(init.method ?? "")) {
        writes.push({ url: value, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ id: 92 }));
      }
      throw new Error(`Unexpected request ${value}`);
    });
    const payload = scoped({ action: "completed", repository: repository(), workflow_run: { id: 780 } });
    expect((await handleWebhook(signedRequest("workflow_run", payload), baseEnv())).status).toBe(options.apiFailure ? 503 : options.expected ? 202 : 204);
    expect(writes).toHaveLength(options.expected ? 1 : 0);
    if (options.expected) expect(writes[0]).toEqual({ url: "https://api.github.com/repos/splrad/steward/check-runs/92", body: expect.objectContaining({
      external_id: `1296724484:9:${headSha}:780:1`, conclusion: options.conclusion === "action_required" ? "failure" : "success",
    }) });
  });

  it("验证运行只有成功可以生成通过结论", () => {
    expect(validationConclusion("success")).toBe("success");
    for (const value of ["action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "timed_out"]) expect(validationConclusion(value)).toBe("failure");
    for (const value of ["", "queued", "in_progress", null]) expect(validationConclusion(value)).toBeNull();
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

describe("Dependabot独立审查派发", () => {
  it("缺少来源分支时不派发审查任务", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const payload = scoped({ action: "ready_for_review", repository: repository(), pull_request: {
      number: 187, state: "open", draft: false,
      head: { sha: "d".repeat(40), repo: { id: 1296724484 } }, base: { ref: "main", repo: { id: 1296724484 } },
      user: { id: 49699333, login: "dependabot[bot]", type: "Bot" },
    } });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const reviewCases: Array<{ name: string; action: string; changes?: object; base?: string; draft?: boolean; workflows: string[] }> = [
    ...["opened", "synchronize", "reopened"].map(action => ({ name: action, action, workflows: ["pr-classification.yml", "native-review.yml"] })),
    ...["opened", "synchronize"].map(action => ({ name: `Draft ${action}`, action, draft: true, workflows: ["pr-classification.yml"] })),
    { name: "ready_for_review", action: "ready_for_review", workflows: ["native-review.yml"] },
    { name: "切换到默认分支", action: "edited", changes: { base: { ref: { from: "release" } } }, workflows: ["pr-classification.yml", "native-review.yml"] },
    { name: "仅编辑标题", action: "edited", changes: { title: { from: "old title" } }, workflows: ["pr-classification.yml"] },
    { name: "仅编辑正文", action: "edited", changes: { body: { from: "old body" } }, workflows: ["pr-classification.yml"] },
    { name: "离开默认分支", action: "edited", changes: { base: { ref: { from: "main" } } }, base: "release", workflows: [] },
    { name: "Draft切换到默认分支", action: "edited", changes: { base: { ref: { from: "release" } } }, draft: true, workflows: ["pr-classification.yml"] },
    { name: "两个非默认分支间切换", action: "edited", changes: { base: { ref: { from: "release" } } }, base: "develop", workflows: [] },
  ];
  it.each(reviewCases.flatMap(value => ["native"].map(trigger => ({ ...value, trigger }))))("$name/$trigger保留适用的分类与审查派发", async ({ action, changes, base = "main", draft = false, workflows, trigger }) => {
    repositoryCatalog.repositories["1296724484"].copilotReviewTrigger = trigger;
    const headSha = "d".repeat(40); const sent: { workflow: string; body: any }[] = [];
    const checks: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.includes(`/commits/${headSha}/check-runs?per_page=100`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/check-runs")) {
        checks.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: 101 }), { status: 201 });
      }
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      const workflow = /\/actions\/workflows\/([^/]+)\/dispatches/u.exec(value)?.[1];
      if (workflow) { sent.push({ workflow, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }
      throw new Error(`unexpected: ${value}`);
    });
    const payload = scoped({ action, changes, repository: repository(), pull_request: {
      number: 187, state: "open", draft,
      head: { sha: headSha, ref: "dependabot/npm", repo: { id: 1296724484 } }, base: { ref: base, repo: { id: 1296724484 } },
      user: { id: 49699333, login: "dependabot[bot]", type: "Bot" },
    } });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(workflows.length ? 202 : 204);
    expect(sent.map(item => item.workflow)).toEqual(workflows);
    if (draft && ["opened", "synchronize"].includes(action)) {
      expect(checks).toEqual([expect.objectContaining({ head_sha: headSha, status: "in_progress", external_id: `1296724484:187:${headSha}:pending` })]);
      expect(sent[0]?.body.inputs).toMatchObject({ repositoryId: "1296724484", pullRequestNumber: "187", eventHeadSha: headSha });
    }
    if (workflows.includes("native-review.yml")) expect(sent.find(item => item.workflow === "native-review.yml")?.body).toEqual({ ref: "main", inputs: { deliveryId: "delivery-1", repositoryId: "1296724484", pullRequestNumber: "187", eventAfterSha: headSha, policySha: "a".repeat(40) } });
  });

  it("机器人push仍不创建受管PR", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const result = await handleWebhook(signedRequest("push", scoped({ repository: repository(), ref: "refs/heads/dependabot/npm", before: "a".repeat(40), after: "d".repeat(40), sender: { id: 49699333, login: "dependabot[bot]", type: "Bot" } })), baseEnv());
    expect(result.status).toBe(204); expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Dependabot派发故障隔离", () => {
  it("新增审查请求失败仍先完成原验证和分类派发", async () => {
    const headSha = "d".repeat(40); const effects: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.includes(`/commits/${headSha}/check-runs?per_page=100`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/check-runs")) { effects.push("validation"); return new Response(JSON.stringify({ id: 101 }), { status: 201 }); }
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      const workflow = /\/actions\/workflows\/([^/]+)\/dispatches/u.exec(value)?.[1];
      if (workflow) { effects.push(workflow); return workflow === "native-review.yml" ? new Response("denied", { status: 403 }) : new Response(null, { status: 204 }); }
      throw new Error(`unexpected: ${value}`);
    });
    const result = await handleWebhook(signedRequest("pull_request", scoped({ action: "synchronize", repository: repository(), pull_request: {
      number: 187, state: "open", draft: false,
      head: { sha: headSha, ref: "dependabot/npm", repo: { id: 1296724484 } }, base: { ref: "main", repo: { id: 1296724484 } },
      user: { id: 49699333, login: "dependabot[bot]", type: "Bot" },
    } })), baseEnv());
    expect(result.status).toBe(503);
    expect(effects).toEqual(["validation", "pr-classification.yml", "native-review.yml"]);
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
  it.each(["opened", "synchronize", "edited", "reopened"])("人工 PR 的 %s 保留分类和验证，正文不被写入", async action => {
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
    expect(writes).toEqual([expect.objectContaining({ name: "PR Validation Gate", status: "in_progress", head_sha: "d".repeat(40) })]);
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
    expect((await handleWebhook(signedRequest("installation", installationScoped({ action: "created", repositories: [ownerlessRepository()] })), baseEnv())).status).toBe(202);
    expect((await handleWebhook(signedRequest("push", scoped({ repository: repository(), ref: "refs/heads/main", before: "b".repeat(40), after: "c".repeat(40) })), baseEnv())).status).toBe(202);
    expect(workflows).toEqual(["onboard-repository.yml", "pr-classification.yml"]);
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
