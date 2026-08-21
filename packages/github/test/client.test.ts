import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallationToken } from "../src/app-auth.js";
import { closingIssuesReferencesQuery, GitHubClient, GitHubRequestError } from "../src/client.js";
import { dispatchWorkflow } from "../src/workflow-dispatch.js";

afterEach(() => vi.unstubAllGlobals());

describe("代码托管平台客户端", () => {
  it("列出所有开放拉取请求时不添加基础分支过滤", async () => {
    let requested = "";
    const transport = async (url: string) => {
      requested = String(url);
      return new Response(JSON.stringify([{ number: 1 }]), { status: 200 });
    };
    const client = new GitHubClient("token", "https://example.test", transport as typeof fetch);
    await expect(client.listAllOpenPullRequests("splrad", "steward")).resolves.toEqual([{ number: 1 }]);
    expect(new URL(requested).pathname).toBe("/repos/splrad/steward/pulls");
    expect(new URL(requested).searchParams.get("state")).toBe("open");
    expect(new URL(requested).searchParams.has("base")).toBe(false);
  });

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

  it("完整读取议题各类事实、逐页保存验证器并把无父议题404保留为不可条件验证", async () => {
    const requests: string[] = [];
    const issue = { id: 1, number: 7, repository_url: "https://api.github.com/repos/splrad/steward" };
    const transport = async (urlValue: any) => {
      const url = String(urlValue);
      requests.push(url);
      if (url.endsWith("/issues/7")) return new Response(JSON.stringify(issue), { status: 200, headers: { ETag: '"issue"' } });
      if (url.endsWith("/issues/7/parent")) return new Response("not found", { status: 404 });
      if (url.includes("/comments?per_page=100") && !url.includes("page=2")) return new Response(JSON.stringify([{ id: 10 }]), { status: 200, headers: { ETag: '"comments-1"', Link: '<https://example.test/repos/splrad/steward/issues/7/comments?per_page=100&page=2>; rel="next"' } });
      if (url.includes("/comments?per_page=100&page=2")) return new Response(JSON.stringify([{ id: 20 }]), { status: 200, headers: { ETag: '"comments-2"' } });
      if (url.includes("issue-field-values")) return new Response(JSON.stringify([{ issue_field_id: 1 }]), { status: 200 });
      if (url.includes("sub_issues")) return new Response(JSON.stringify([{ number: 8 }]), { status: 200, headers: { ETag: '"sub"' } });
      if (url.includes("dependencies/blocked_by")) return new Response(JSON.stringify([{ number: 6 }]), { status: 200, headers: { ETag: '"blocked"' } });
      if (url.includes("dependencies/blocking")) return new Response(JSON.stringify([{ number: 9 }]), { status: 200, headers: { ETag: '"blocking"' } });
      throw new Error(`unexpected ${url}`);
    };
    const result = await new GitHubClient("token", "https://example.test", transport as typeof fetch).readIssueFacts("splrad", "steward", 7);
    expect(result.issue).toEqual(issue);
    expect(result.comments).toEqual([{ id: 10 }, { id: 20 }]);
    expect(result.fieldValues).toEqual([{ issue_field_id: 1 }]);
    expect(result.parent).toBeNull();
    expect(result.subIssues).toEqual([{ number: 8 }]);
    expect(result.blockedBy).toEqual([{ number: 6 }]);
    expect(result.blocking).toEqual([{ number: 9 }]);
    expect(result.validators.map(({ resource, status, etag }) => ({ resource, status, etag }))).toEqual([
      { resource: "issue", status: 200, etag: '"issue"' },
      { resource: "comments", status: 200, etag: '"comments-1"' },
      { resource: "comments", status: 200, etag: '"comments-2"' },
      { resource: "field-values", status: 200, etag: null },
      { resource: "parent", status: 404, etag: null },
      { resource: "sub-issues", status: 200, etag: '"sub"' },
      { resource: "blocked-by", status: 200, etag: '"blocked"' },
      { resource: "blocking", status: 200, etag: '"blocking"' },
    ]);
    expect(requests).toContain("https://example.test/repos/splrad/steward/issues/7/issue-field-values?per_page=100");
  });

  it("完整议题读取拒绝主议题仓库或编号漂移", async () => {
    const transport = async (urlValue: any) => {
      const url = String(urlValue);
      if (url.endsWith("/issues/7")) return new Response(JSON.stringify({ number: 7, repository_url: "https://api.github.com/repos/splrad/LayerScape" }), { status: 200 });
      if (url.endsWith("/issues/7/parent")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify([]), { status: 200 });
    };
    await expect(new GitHubClient("token", "https://example.test", transport as typeof fetch).readIssueFacts("splrad", "steward", 7)).rejects.toThrow("issue-repository-mismatch");
  });

  it("逐页条件复核只在全部ETag返回304且页边界不变时判定未修改", async () => {
    const validators = [
      { resource: "comments" as const, url: "https://example.test/page/1", etag: '"one"', next: "https://example.test/page/2", status: 200 as const },
      { resource: "comments" as const, url: "https://example.test/page/2", etag: '"two"', next: null, status: 200 as const },
    ];
    const headers: string[] = [];
    const unchanged = new GitHubClient("token", "https://example.test", (async (_url: any, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get("If-None-Match") ?? "");
      return new Response(null, { status: 304 });
    }) as typeof fetch);
    await expect(unchanged.revalidatePageValidators(validators)).resolves.toEqual({ state: "not-modified" });
    expect(headers).toEqual(['"one"', '"two"']);
    await expect(unchanged.revalidatePageValidators([
      { resource: "issue", url: "https://example.test/issue", etag: '"issue"', next: null, status: 200 },
      { resource: "comments", url: "https://example.test/comments", etag: '"comments"', next: null, status: 200 },
    ])).resolves.toEqual({ state: "not-modified" });
    const changed = new GitHubClient("token", "https://example.test", (async () => new Response(JSON.stringify([]), { status: 200, headers: { ETag: '"new"' } })) as typeof fetch);
    await expect(changed.revalidatePageValidators(validators)).resolves.toEqual({ state: "modified", resource: "comments", url: "https://example.test/page/1" });
    let calls = 0;
    const unverifiable = new GitHubClient("token", "https://example.test", (async () => { calls += 1; return new Response(null, { status: 304 }); }) as typeof fetch);
    await expect(unverifiable.revalidatePageValidators([{ ...validators[0]!, etag: null }])).resolves.toEqual({ state: "unverifiable", resource: "comments", url: "https://example.test/page/1" });
    expect(calls).toBe(0);
  });

  it("分页拒绝跨API来源并保留404与权限错误的精确端点", async () => {
    const crossOrigin = new GitHubClient("token", "https://example.test", (async () => new Response(JSON.stringify([]), { status: 200, headers: { Link: '<https://evil.test/page/2>; rel="next"' } })) as typeof fetch);
    await expect(crossOrigin.listIssueCommentsWithValidators("splrad", "steward", 7)).rejects.toThrow("来源");
    for (const [status, path] of [[404, "/repos/splrad/steward/issues/7"], [403, "/repos/splrad/steward/issues/7/comments?per_page=100"]] as const) {
      const client = new GitHubClient("token", "https://example.test", (async (url: any) => new Response("failure", { status: String(url).endsWith(path) ? status : 500 })) as typeof fetch);
      const operation = status === 404 ? client.getIssueWithValidator("splrad", "steward", 7) : client.listIssueCommentsWithValidators("splrad", "steward", 7);
      await expect(operation).rejects.toMatchObject({ status, method: "GET", path } satisfies Partial<GitHubRequestError>);
    }
  });

  it("GraphQL完整分页并分别返回全部、人工和自动关闭议题集合", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const transport = async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      calls.push(body);
      const manual = body.variables.userLinkedOnly === true;
      const automatic = body.variables.excludeUserLinked === true;
      const after = body.variables.cursor;
      const nodes = manual ? [{ number: 2, repository: { databaseId: 1296724484 } }]
        : automatic ? [{ number: after ? 3 : 1, repository: { databaseId: 1296724484 } }]
          : [{ number: 1, repository: { databaseId: 1296724484 } }, { number: 2, repository: { databaseId: 1296724484 } }, { number: 3, repository: { databaseId: 1296724484 } }];
      return new Response(JSON.stringify({ data: { repository: { databaseId: 1296724484, pullRequest: { closingIssuesReferences: { nodes, pageInfo: { hasNextPage: automatic && !after, endCursor: automatic && !after ? "next" : null } } } } } }), { status: 200 });
    };
    const client = new GitHubClient("token", "https://example.test", transport as typeof fetch);
    await expect(client.listPullRequestClosingIssueSets("splrad", "steward", 42, 1296724484)).resolves.toEqual({
      all: [{ repositoryId: 1296724484, number: 1 }, { repositoryId: 1296724484, number: 2 }, { repositoryId: 1296724484, number: 3 }],
      manual: [{ repositoryId: 1296724484, number: 2 }],
      automatic: [{ repositoryId: 1296724484, number: 1 }, { repositoryId: 1296724484, number: 3 }],
    });
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.query === closingIssuesReferencesQuery)).toBe(true);
    expect(closingIssuesReferencesQuery).toContain("userLinkedOnly: $userLinkedOnly");
    expect(closingIssuesReferencesQuery).toContain("excludeUserLinked: $excludeUserLinked");
    const mismatch = new GitHubClient("token", "https://example.test", transport as typeof fetch);
    await expect(mismatch.listPullRequestClosingIssueSets("splrad", "steward", 42, 1)).rejects.toThrow("issue-repository-mismatch");
  });

  it("只允许六个中央工作流并从中央仓库实时默认分支派发", async () => {
    const requests: unknown[] = [];
    const client = {
      getRepository: async () => ({ default_branch: "trunk" }),
      request: async (...args: unknown[]) => { requests.push(args); },
    } as unknown as GitHubClient;
    for (const workflow of ["issue-sync.yml", "onboard-repository.yml", "pr-automation.yml", "pr-classification.yml", "pr-issue-link.yml", "release.yml"]) {
      await dispatchWorkflow(client, { owner: "splrad", repo: "steward", workflow, policySha: "a".repeat(40), inputs: { value: "x" } });
    }
    expect(requests).toHaveLength(6);
    expect(requests[0]).toEqual(["POST", "/repos/splrad/steward/actions/workflows/issue-sync.yml/dispatches", { ref: "trunk", inputs: { value: "x", policySha: "a".repeat(40) } }]);
    expect(requests[1]).toEqual(["POST", "/repos/splrad/steward/actions/workflows/onboard-repository.yml/dispatches", { ref: "trunk", inputs: { value: "x", policySha: "a".repeat(40) } }]);
    expect(requests[2]).toEqual(["POST", "/repos/splrad/steward/actions/workflows/pr-automation.yml/dispatches", { ref: "trunk", inputs: { value: "x", policySha: "a".repeat(40) } }]);
    expect(requests[3]).toEqual(["POST", "/repos/splrad/steward/actions/workflows/pr-classification.yml/dispatches", { ref: "trunk", inputs: { value: "x", policySha: "a".repeat(40) } }]);
    expect(requests[4]).toEqual(["POST", "/repos/splrad/steward/actions/workflows/pr-issue-link.yml/dispatches", { ref: "trunk", inputs: { value: "x", policySha: "a".repeat(40) } }]);
    expect(requests[5]).toEqual(["POST", "/repos/splrad/steward/actions/workflows/release.yml/dispatches", { ref: "trunk", inputs: { value: "x" } }]);
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
