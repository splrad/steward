import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/client.js";

describe("动态审查日志读取", () => {
  it("只向API发送令牌，签名下载不带认证头", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new GitHubClient("private-test-token", "https://api.github.com", (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://logs.blob.core.windows.net/log?sig=test" } }) : new Response("审查日志");
    }) as typeof fetch);
    await expect(client.getWorkflowJobLog("splrad", "steward", 1)).resolves.toBe("审查日志");
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toContain('private-test-token');
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(calls[1]?.init).toEqual({ redirect: 'error' });
  });
  it.each(['https://evil.test/log', 'http://logs.blob.core.windows.net/log', 'https://logs.blob.core.windows.net.evil.test/log', 'https://user:password@logs.blob.core.windows.net/log', 'https://logs.blob.core.windows.net:444/log', 'https://logs.blob.core.windows.net/log#fragment'])("拒绝不可信跳转：%s", async location => {
    let calls = 0;
    const client = new GitHubClient("token", "https://api.github.com", (async () => { calls++; return new Response(null, { status: 302, headers: { location } }); }) as typeof fetch);
    await expect(client.getWorkflowJobLog('splrad', 'steward', 1)).rejects.toThrow('下载地址无效');
    expect(calls).toBe(1);
  });
  it.each([true, false])("限制日志大小，声明长度=%s", async declared => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
    const client = new GitHubClient('token', 'https://api.github.com', (async () => new Response(stream, { headers: declared ? { 'content-length': String(9 * 1024 * 1024) } : {} })) as typeof fetch);
    await expect(client.getWorkflowJobLog('splrad', 'steward', 1)).rejects.toThrow('超过读取上限');
    expect(cancelled).toBe(true);
  });
  it("下载错误不把响应体或签名地址放入异常", async () => {
    const client = new GitHubClient('token', 'https://api.github.com', (async () => new Response('secret-server-response', { status: 403 })) as typeof fetch);
    await expect(client.getWorkflowJobLog('splrad', 'steward', 1)).rejects.toThrow(/^运行日志读取失败$/u);
  });
  it("动态运行翻页保留完整结果", async () => {
    const client = new GitHubClient('token', 'https://api.github.com', (async (url: string) => {
      const parsed = new URL(url), second = parsed.searchParams.get('page') === '2';
      const next = new URL(url); next.searchParams.set('page', '2');
      return new Response(JSON.stringify({ total_count: 2, workflow_runs: [{ id: second ? 2 : 1 }] }), { headers: second ? {} : { link: `<${next}>; rel="next"` } });
    }) as typeof fetch);
    await expect(client.listDynamicWorkflowRuns('splrad', 'steward')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });
});
