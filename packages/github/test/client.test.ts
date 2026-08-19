import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallationToken } from "../src/app-auth.js";
import { GitHubClient, GitHubRequestError } from "../src/client.js";
import { dispatchWorkflow } from "../src/workflow-dispatch.js";

afterEach(() => vi.unstubAllGlobals());

describe("代码托管平台客户端", () => {
  it("发送固定版本和规则提交请求头且不重试写入", async () => {
    let calls = 0;
    let receiver: unknown;
    const policySha = "a".repeat(40);
    const transport = async function (this: unknown, _url: any, init?: RequestInit) {
      receiver = this;
      calls += 1;
      const headers = new Headers(init?.headers);
      expect(headers.get("X-GitHub-Api-Version")).toBe("2026-03-10");
      expect(headers.get("User-Agent")).toBe(`splrad-steward/${policySha}`);
      expect(headers.get("Authorization")).toBe("Bearer token");
      expect(JSON.parse(String(init?.body))).toEqual({ a: 1 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const client = new GitHubClient("token", "https://example.test", transport as typeof fetch, policySha);
    await client.request("POST", "/value", { a: 1 });
    expect(calls).toBe(1);
    expect(receiver).toBe(globalThis);
  });

  it("限流和任意非成功响应立即失败且不自动重试", async () => {
    for (const status of [403, 429, 500]) {
      let calls = 0;
      const client = new GitHubClient("token", "https://example.test", (async () => {
        calls += 1;
        return new Response("failure", { status });
      }) as typeof fetch);
      await expect(client.request("PATCH", "/value", {})).rejects.toMatchObject({ status, method: "PATCH", path: "/value" } satisfies Partial<GitHubRequestError>);
      expect(calls).toBe(1);
    }
  });

  it("单仓安装令牌请求只携带一个repository_ids值和精确权限", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    let body: any;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
    });
    await expect(createInstallationToken({ appId: "4243096", privateKey, installationId: 145952003, repositoryId: 1187527897, permissions: { contents: "read", metadata: "read" }, policySha: "a".repeat(40) })).resolves.toBe("installation-token");
    expect(body).toEqual({ permissions: { contents: "read", metadata: "read" }, repository_ids: [1187527897] });
  });

  it("使用拉取请求接口读取待审查人、完整审查、事件分页和工作流运行", async () => {
    const paths: string[] = [];
    const transport = async (url: any) => {
      paths.push(String(url));
      return new Response(JSON.stringify(String(url).includes("requested_reviewers") ? { users: [] } : []), { status: 200 });
    };
    const client = new GitHubClient("token", "https://example.test", transport as typeof fetch);
    await client.getRequestedReviewers("splrad", "steward", 7);
    await client.listPullRequestReviews("splrad", "steward", 7);
    await client.listIssueEvents("splrad", "steward", 7);
    await client.getWorkflowRun("splrad", "steward", 123);
    expect(paths).toEqual([
      "https://example.test/repos/splrad/steward/pulls/7/requested_reviewers",
      "https://example.test/repos/splrad/steward/pulls/7/reviews?per_page=100",
      "https://example.test/repos/splrad/steward/issues/7/events?per_page=100",
      "https://example.test/repos/splrad/steward/actions/runs/123",
    ]);
  });

  it("使用团队审查字段请求Maintainers", async () => {
    let request: { method: string; path: string; body: unknown } | null = null;
    const transport = async (url: any, init?: RequestInit) => {
      request = {
        method: String(init?.method),
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)),
      };
      return new Response(JSON.stringify({ number: 7, requested_teams: [{ slug: "maintainers" }] }), { status: 201 });
    };
    const client = new GitHubClient("token", "https://example.test", transport as typeof fetch);
    const result = await client.requestTeamReviewers("splrad", "steward", 7, ["maintainers"]);
    expect(request).toEqual({
      method: "POST",
      path: "/repos/splrad/steward/pulls/7/requested_reviewers",
      body: { team_reviewers: ["maintainers"] },
    });
    expect(result).toEqual({ number: 7, requested_teams: [{ slug: "maintainers" }] });
  });

  it("对Git引用路径中的特殊字符编码并保留分支层级", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const transport = async (url: any, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: String(init?.method),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      return new Response(JSON.stringify({ object: { sha: "a".repeat(40) } }), { status: 200 });
    };
    const client = new GitHubClient("token", "https://example.test", transport as typeof fetch);
    await client.getRef("splrad", "steward", "heads/release#stable");
    await client.getGitRef("splrad", "steward", "tags/v1%beta");
    await client.updateRef("splrad", "steward", "heads/feature/one#two", "b".repeat(40), true);
    expect(requests).toEqual([
      { url: "https://example.test/repos/splrad/steward/git/ref/heads/release%23stable", method: "GET" },
      { url: "https://example.test/repos/splrad/steward/git/ref/tags/v1%25beta", method: "GET" },
      { url: "https://example.test/repos/splrad/steward/git/refs/heads/feature/one%23two", method: "PATCH", body: { sha: "b".repeat(40), force: true } },
    ]);
  });

  it("以增量标签接口写入并分页读取仓库标签与安装仓库", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const transport = async (url: any, init?: RequestInit) => {
      requests.push({ url: String(url), method: String(init?.method ?? "GET"), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
      if (String(url).includes("/installation/repositories")) return new Response(JSON.stringify({ repositories: [{ id: 1 }] }), { status: 200 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify([]), { status: 200 });
    };
    const client = new GitHubClient("token", "https://example.test", transport as typeof fetch);
    await client.addLabels("splrad", "steward", 7, ["feature"]);
    await client.removeLabel("splrad", "steward", 7, "area:source");
    await client.listRepositoryLabels("splrad", "steward");
    await expect(client.listInstallationRepositories()).resolves.toEqual([{ id: 1 }]);
    expect(requests).toEqual([
      { url: "https://example.test/repos/splrad/steward/issues/7/labels", method: "POST", body: { labels: ["feature"] } },
      { url: "https://example.test/repos/splrad/steward/issues/7/labels/area%3Asource", method: "DELETE" },
      { url: "https://example.test/repos/splrad/steward/labels?per_page=100", method: "GET" },
      { url: "https://example.test/installation/repositories?per_page=100", method: "GET" },
    ]);
  });

  it("只允许四个中央工作流并从中央仓库实时默认分支派发", async () => {
    const requests: unknown[] = [];
    const client = {
      getRepository: async () => ({ default_branch: "trunk" }),
      request: async (...args: unknown[]) => { requests.push(args); },
    } as unknown as GitHubClient;
    for (const workflow of ["onboard-repository.yml", "pr-automation.yml", "pr-classification.yml", "release.yml"]) {
      await dispatchWorkflow(client, { owner: "splrad", repo: "steward", workflow, policySha: "a".repeat(40), inputs: { value: "x" } });
    }
    expect(requests).toHaveLength(4);
    expect(requests[0]).toEqual(["POST", "/repos/splrad/steward/actions/workflows/onboard-repository.yml/dispatches", { ref: "trunk", inputs: { value: "x", policySha: "a".repeat(40) } }]);
    expect(requests[1]).toEqual(["POST", "/repos/splrad/steward/actions/workflows/pr-automation.yml/dispatches", { ref: "trunk", inputs: { value: "x", policySha: "a".repeat(40) } }]);
    expect(requests[2]).toEqual(["POST", "/repos/splrad/steward/actions/workflows/pr-classification.yml/dispatches", { ref: "trunk", inputs: { value: "x", policySha: "a".repeat(40) } }]);
    expect(requests[3]).toEqual(["POST", "/repos/splrad/steward/actions/workflows/release.yml/dispatches", { ref: "trunk", inputs: { value: "x" } }]);
    await expect(dispatchWorkflow(client, { owner: "splrad", repo: "steward", workflow: "unknown.yml", policySha: "a".repeat(40), inputs: {} })).rejects.toThrow("不允许");
    await expect(dispatchWorkflow(client, { owner: "splrad", repo: "steward", workflow: "release.yml", policySha: "short", inputs: {} })).rejects.toThrow("40位");
  });

  it("中央仓库没有默认分支时停止调度", async () => {
    const client = {
      getRepository: async () => ({ default_branch: "" }),
      request: async () => { throw new Error("不应派发"); },
    } as unknown as GitHubClient;
    await expect(dispatchWorkflow(client, { owner: "splrad", repo: "steward", workflow: "release.yml", policySha: "a".repeat(40), inputs: {} })).rejects.toThrow("没有可用的默认分支");
  });
});
