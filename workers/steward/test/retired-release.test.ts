import { expect, it } from 'vitest';
import worker, { type Env } from '../src/index.js';
import { assertLegacyReleaseDispatchActive } from '../src/release-retirement.js';

it.each([undefined, 'false', 'true'])('旧发行入口在退役变量为 %s 时保持关闭', async flag => {
  const url = 'https://worker.test/internal/releases/candidates';
  const response = await worker.fetch(new Request(url, { method: 'POST' }), { LEGACY_RELEASE_RETIRED: flag } as Env);
  expect(response.status).toBe(410);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'LEGACY_RELEASE_RETIRED' });
});

it.each(['release.yml', 'release-build.yml', 'release-build-complete.yml'])('拒绝向退役入口 %s 派发', name => {
  expect(() => assertLegacyReleaseDispatchActive(name)).toThrow('LEGACY_RELEASE_RETIRED');
});
