import { expect, it } from 'vitest';
import worker, { type Env } from '../src/index.js';
import { dispatchWorkflow, type GitHubClient } from '../support/github/index.js';

it('旧发行入口始终返回 410', async () => {
  const url = 'https://worker.test/internal/releases/candidates';
  const response = await worker.fetch(new Request(url, { method: 'POST' }), {} as Env);
  expect(response.status).toBe(410);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'LEGACY_RELEASE_RETIRED' });
});

it.each(['release.yml', 'release-build.yml', 'release-build-complete.yml'])('拒绝向退役入口 %s 派发', async name => {
  await expect(dispatchWorkflow({} as GitHubClient,{owner:'splrad',repo:'steward',workflow:name,policySha:'a'.repeat(40),inputs:{}})).rejects.toThrow('LEGACY_RELEASE_RETIRED');
});
