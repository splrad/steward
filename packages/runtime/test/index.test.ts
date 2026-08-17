import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { handleWebhook, validationConclusion, verifyWebhookSignature, type Env } from "../src/index.js";

let privateKey = "";
beforeAll(() => {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } }).privateKey;
});
afterEach(() => {
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
const repository = (id = 1296724484, fullName = "splrad/steward", defaultBranch = "main") => ({ id, full_name: fullName, private: false, fork: false, archived: false, disabled: false, default_branch: defaultBranch, owner: { id: 302208797 } });
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

  it("四个允许事件逐仓调度固定中央工作流", async () => {
    const dispatched: { workflow: string; body: any }[] = [];
    const validationChecks: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (String(url).endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 });
      if (String(url).includes("/repos/splrad/LayerScape/pulls/9/files?per_page=100")) return new Response(JSON.stringify([{ filename: "Version.props" }]), { status: 200 });
      if (String(url).includes(`/commits/${"d".repeat(40)}/check-runs?per_page=100`)) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      if (String(url).endsWith("/repos/splrad/steward/check-runs")) {
        validationChecks.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: 101 }), { status: 201 });
      }
      const match = /\/actions\/workflows\/([^/]+)\/dispatches/.exec(String(url));
      if (match) {
        dispatched.push({ workflow: match[1]!, body: JSON.parse(String(init.body)) });
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const env = baseEnv();
    const cases: [string, Record<string, unknown>][] = [
      ["installation", installationScoped({ action: "created", repositories: [ownerlessRepository()] })],
      ["installation_repositories", installationScoped({ action: "added", repositories_added: [ownerlessRepository()] })],
      ["push", scoped({ ref: "refs/heads/feature/a", before: "b".repeat(40), after: "c".repeat(40), deleted: false, repository: repository(), sender: { id: 44151430, login: "axiomoth", type: "User" } })],
      ["pull_request", scoped({ action: "opened", repository: repository(), pull_request: { number: 8, head: { sha: "d".repeat(40) }, base: { ref: "main" }, user: { id: 44151430 } } })],
      ["pull_request", scoped({ action: "closed", repository: repository(1187527897, "splrad/LayerScape"), pull_request: { number: 9, merged: true, merge_commit_sha: "e".repeat(40), base: { ref: "main" } } })],
    ];
    for (const [event, payload] of cases) expect((await handleWebhook(signedRequest(event, payload), env)).status).toBe(202);
    expect(dispatched.map(value => value.workflow)).toEqual(["onboard-repository.yml", "onboard-repository.yml", "pr-automation.yml", "pr-classification.yml", "release.yml"]);
    expect(validationChecks).toEqual([expect.objectContaining({ name: "PR Validation Gate", head_sha: "d".repeat(40), status: "in_progress", external_id: `1296724484:8:${"d".repeat(40)}:pending` })]);
    for (const dispatch of dispatched) {
      expect(dispatch.body.ref).toBe("trunk");
      if (dispatch.workflow !== "release.yml") expect(dispatch.body.inputs.policySha).toBe(env.POLICY_SHA);
    }
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
        head_sha: headSha,
        html_url: `https://github.com/splrad/steward/actions/runs/${runId}`,
      }), { status: 200 });
      if (value.includes("/repos/splrad/steward/pulls?state=open&base=main&per_page=100")) return new Response(JSON.stringify([
        { number: 8, base: { ref: "main" }, head: { sha: headSha } },
        { number: 9, base: { ref: "main" }, head: { sha: "e".repeat(40) } },
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
        head_sha: headSha,
        html_url: `https://github.com/splrad/steward/actions/runs/${runId}`,
      }), { status: 200 });
      if (value.includes("/pulls?state=open&base=main&per_page=100")) return new Response(JSON.stringify([{ number: 8, base: { ref: "main" }, head: { sha: headSha } }]), { status: 200 });
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
      if (value.includes("/actions/runs/778")) return new Response(JSON.stringify({ id: 778, workflow_id: 335795406, workflow_url: workflowUrl, run_attempt: 1, repository: { id: 1296724484 }, name: "SPLRAD Steward / PR Validation", path: ".github/workflows/pr-validation.yml", event: "pull_request", status: "completed", conclusion: "success", head_sha: headSha, html_url: "https://github.com/splrad/steward/actions/runs/778" }), { status: 200 });
      if (value.includes("/pulls?state=open&base=main&per_page=100")) return new Response(JSON.stringify([{ number: 8, base: { ref: "main" }, head: { sha: "e".repeat(40) } }]), { status: 200 });
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
        head_sha: headSha,
        html_url: `https://github.com/splrad/steward/actions/runs/${runId}`,
      }), { status: 200 });
      if (value.includes("/pulls?state=open&base=main&per_page=100")) return new Response(JSON.stringify([
        { number: 8, base: { ref: "main" }, head: { sha: headSha } },
        { number: 9, base: { ref: "main" }, head: { sha: headSha } },
      ]), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({ action: "completed", repository: repository(), workflow_run: { id: runId } });
    expect((await handleWebhook(signedRequest("workflow_run", payload), baseEnv())).status).toBe(204);
    expect(requests.some(value => value.includes("/check-runs"))).toBe(false);
  });

  it("验证运行只有成功可以生成通过结论", () => {
    expect(validationConclusion("success")).toBe("success");
    for (const value of ["action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "timed_out"]) expect(validationConclusion(value)).toBe("failure");
    for (const value of ["", "queued", "in_progress", null]) expect(validationConclusion(value)).toBeNull();
  });

  it("普通合并不调度发布，只有Version.props合并才调度", async () => {
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (String(url).includes("/repos/splrad/LayerScape/pulls/10/files?per_page=100")) return new Response(JSON.stringify([{ filename: "src/Version.props" }, { filename: "src/example.cs" }]), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const payload = scoped({ action: "closed", repository: repository(1187527897, "splrad/LayerScape"), pull_request: { number: 10, merged: true, merge_commit_sha: "f".repeat(40), base: { ref: "main" } } });
    expect((await handleWebhook(signedRequest("pull_request", payload), baseEnv())).status).toBe(204);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toEqual(expect.objectContaining({ repository_ids: [1187527897], permissions: { metadata: "read", pull_requests: "read" } }));
    expect(requests.some(request => request.url.includes("/actions/workflows/release.yml/dispatches"))).toBe(false);
  });

  it("安装事件使用已验证的安装账户并接受省略owner的组织仓库", async () => {
    const dispatched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (String(url).endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 });
      const workflow = /\/actions\/workflows\/([^/]+)\/dispatches/.exec(String(url))?.[1];
      if (workflow) { dispatched.push(workflow); return new Response(null, { status: 204 }); }
      return new Response("unexpected", { status: 500 });
    });
    const env = baseEnv();
    const accepted = installationScoped({ action: "added", repositories_added: [ownerlessRepository(1187527897, "splrad/LayerScape"), ownerlessRepository(1296725317, "splrad/.github")] });
    expect((await handleWebhook(signedRequest("installation_repositories", accepted), env)).status).toBe(202);
    expect(dispatched).toEqual(["onboard-repository.yml", "onboard-repository.yml"]);

    const foreign = installationScoped({ action: "added", repositories_added: [ownerlessRepository(987654321, "someone/example"), { ...ownerlessRepository(987654322, "splrad/example"), owner: { id: 1, login: "someone" } }] });
    expect((await handleWebhook(signedRequest("installation_repositories", foreign), env)).status).toBe(202);
    expect(dispatched).toHaveLength(2);
  });

  it("默认分支首次推送补接入，后续推送扫描全部拉取请求", async () => {
    const workflows: { name: string; inputs: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("/access_tokens")) return new Response(JSON.stringify({ token: "token" }), { status: 201 });
      if (String(url).endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 });
      const name = /\/workflows\/([^/]+)\/dispatches/.exec(String(url))?.[1];
      workflows.push({ name: name!, inputs: JSON.parse(String(init.body)).inputs });
      return new Response(null, { status: 204 });
    });
    const env = baseEnv();
    for (const before of ["0".repeat(40), "1".repeat(40)]) {
      const payload = scoped({ ref: "refs/heads/trunk", before, after: "2".repeat(40), deleted: false, repository: repository(1296724484, "splrad/steward", "trunk"), sender: { id: 44151430, login: "axiomoth", type: "User" } });
      expect((await handleWebhook(signedRequest("push", payload), env)).status).toBe(202);
    }
    expect(workflows).toEqual([
      { name: "onboard-repository.yml", inputs: expect.objectContaining({ trigger: "default-branch-push" }) },
      { name: "pr-classification.yml", inputs: expect.objectContaining({ scanAll: "true" }) },
    ]);
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
    const payload = scoped({ ref: "refs/heads/feature/a", before: "b".repeat(40), after: "c".repeat(40), deleted: false, repository: repository(), sender: { id: 44151430, login: "axiomoth", type: "User" } });
    expect((await handleWebhook(signedRequest("push", payload), env)).status).toBe(503);
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).not.toContain(env.STEWARD_WEBHOOK_SECRET);
    expect(logged).not.toContain(env.STEWARD_APP_PRIVATE_KEY);
    expect(logged).not.toContain("installation-token");
  });
});
