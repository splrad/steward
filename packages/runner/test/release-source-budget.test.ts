import { describe, expect, it, vi } from 'vitest';
import { budgetReleaseSourceTransport, releaseSourceBudget } from '../src/release-source-budget.js';
import { GitHubClient } from '../../github/src/index.js';

const limits = { ...releaseSourceBudget, intervalMs: 0, requests: 3, timeoutMs: 10_000 };
describe('发布来源共享 API 预算', () => {
  it('真实分页请求及第二轮读取共同计数，达到上限不再调用网络', async () => {
    let calls = 0;
    const transport = budgetReleaseSourceTransport(async input => {
      calls++; const url = String(input);
      return Response.json([calls], { headers: url.includes('page=2') ? {} : { link: `<https://api.github.com/repos/o/r/releases?page=2>; rel="next"` } });
    }, limits);
    const gh = new GitHubClient('test', 'https://api.github.com', transport);
    expect(await gh.listReleases('o', 'r')).toEqual([1, 2]);
    await expect(gh.listReleases('o', 'r')).rejects.toThrow('release API budget');
    expect(calls).toBe(3);
  });
  it('限制并发直到响应体读完，并保留请求头', async () => {
    let active = 0, peak = 0;
    const transport = budgetReleaseSourceTransport(async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('test');
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return Response.json({ ok: true });
    }, { ...limits, requests: 10, concurrency: 2 });
    await Promise.all(Array.from({ length: 10 }, () => transport('https://api.github.com/x', { headers: { authorization: 'test' } })));
    expect(peak).toBe(2);
  });
  it.each([403, 429])('HTTP %s 后终止排队请求，不自动重试', async status => {
    let calls = 0;
    const transport = budgetReleaseSourceTransport(async () => { calls++; return new Response('limited', { status }); }, { ...limits, concurrency: 1 });
    const results = await Promise.allSettled([transport('https://api.github.com/x'), transport('https://api.github.com/y')]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(calls).toBe(1);
  });
  it('保留配额余量且禁止写操作', async () => {
    let calls = 0;
    const transport = budgetReleaseSourceTransport(async () => { calls++; return Response.json({}, { headers: { 'x-ratelimit-remaining': '100' } }); }, limits);
    await transport('https://api.github.com/x');
    await expect(transport('https://api.github.com/x')).rejects.toThrow('remaining quota');
    expect(calls).toBe(1);
    await expect(budgetReleaseSourceTransport(fetch, limits)('https://api.github.com/x', { method: 'POST' })).rejects.toThrow('read-only');
  });
  it('请求开始间隔受控；等待超时在发请求前失败', async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      const transport = budgetReleaseSourceTransport(async () => { starts.push(Date.now()); return Response.json({}); }, { ...limits, intervalMs: 200, timeoutMs: 250 });
      const done = Promise.allSettled([transport('https://api.github.com/x'), transport('https://api.github.com/x'), transport('https://api.github.com/x')]);
      await vi.runAllTimersAsync();
      expect((await done).map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
      expect(starts[1]! - starts[0]!).toBe(200);
    } finally { vi.useRealTimers(); }
  });
});
