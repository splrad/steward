import { expect, it } from 'vitest';
import catalog from '../../../config/repositories.json' with { type: 'json' };
import { NativeControlPlane, assertManagedBranchRule } from '../src/native-control-plane.js';
const rule = { id: 1, name: 'SPLRAD Managed Branch', enforcement: 'active', target: 'branch', conditions: { ref_name: { include: ['refs/heads/steward/managed-sync'], exclude: [] } }, rules: ['creation', 'update', 'deletion'].map(type => ({ type })), bypass_actors: [{ actor_type: 'Integration', actor_id: 4243096, bypass_mode: 'always' }] };
function fixture(enabled = false) {
  const config = structuredClone(catalog), P = 'a'.repeat(40), Q = 'b'.repeat(40), S = 'c'.repeat(40);
  config.repositories['1187527897'].automation.managedSync.enabled = enabled;
  (config.repositories['1187527897'].automation.managedSync as any).policySha = enabled ? P : null;
  const routes: Record<string, any> = { 'repos/splrad/steward': { id: 1296724484, full_name: 'splrad/steward', default_branch: 'main' },
    'repos/splrad/steward/commits/main': { sha: Q }, [`repos/splrad/steward/contents/config/repositories.json?ref=${Q}`]: () => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(config)).toString('base64') }),
    [`repos/splrad/steward/compare/${P}...${Q}`]: { status: 'ahead', merge_base_commit: { sha: P } },
    'repos/splrad/LayerScape': { id: 1187527897, full_name: 'splrad/LayerScape', default_branch: 'main' },
    'repos/splrad/LayerScape/commits/main': { sha: S }, 'repos/splrad/LayerScape/rulesets?includes_parents=true&per_page=100': [[rule]],
    'repos/splrad/LayerScape/rulesets/1': rule, 'repos/splrad/LayerScape/git/matching-refs/heads/steward/managed-sync': [] };
  const calls: string[][] = [];
  const plane = new NativeControlPlane(async args => { calls.push([...args]); expect(args[0]).toBe('api'); expect(args).not.toContain('--method');
    const value = routes[args.at(-1)!]; if (!value) throw new Error('unexpected read'); return JSON.stringify(typeof value === 'function' ? value() : value); });
  return { config, P, Q, S, routes, calls, plane };
}
it('disabled capabilities stop after current-Q reads without any target or token request', async () => {
  const f = fixture();
  expect((await f.plane.targets('managedSync')).include).toEqual([]);
  expect((await f.plane.syncPreflight(1187527897, f.P)).mode).toBe('not-enabled');
  expect((await f.plane.dependencyPreflight(1187527897, f.P)).mode).toBe('not-enabled');
  expect(f.calls.every(args => args.at(-1)!.startsWith('repos/splrad/steward'))).toBe(true);
  await expect(f.plane.targets('release', 'foreign/repo')).rejects.toThrow('unregistered');
});
it('dependency updates require their own current switch, exact repository and nonrevoked main policy', async () => {
  const f = fixture(); f.config.repositories['1187527897'].automation.dependencyUpdates.enabled = true;
  expect((await f.plane.dependencyPreflight(1187527897, f.P)).mode).toBe('enabled');
  expect(f.calls.some(args => args.at(-1)?.includes('rulesets'))).toBe(false);
  f.routes['repos/splrad/LayerScape'].id = 1;
  await expect(f.plane.dependencyPreflight(1187527897, f.P)).rejects.toThrow('target identity');
  f.routes['repos/splrad/LayerScape'].id = 1187527897;
  (f.config.repositories['1187527897'].revokedPolicyShas as string[]).push(f.P);
  await expect(f.plane.dependencyPreflight(1187527897, f.P)).rejects.toThrow('revoked');
});
it('binds Q to adopted P, exact target main and single-writer branch rules', async () => {
  const f = fixture(true);
  expect((await f.plane.syncPreflight(1187527897, f.P, f.S)).mode).toBe('enabled');
  expect((await f.plane.targets('managedSync')).include[0]!.policySha).toBe(f.P);
  await expect(f.plane.syncPreflight(1187527897, f.P, 'd'.repeat(40))).rejects.toThrow('main changed');
});
it.each(['actor', 'wildcard', 'exclude', 'inactive', 'missing-rule'])('rejects branch protection %s', kind => {
  const value = structuredClone(rule);
  if (kind === 'actor') value.bypass_actors.push({ ...value.bypass_actors[0]!, actor_id: 1 });
  if (kind === 'wildcard') value.conditions.ref_name.include = ['refs/heads/*'];
  if (kind === 'exclude') (value.conditions.ref_name.exclude as string[]).push('refs/heads/steward/managed-sync');
  if (kind === 'inactive') value.enforcement = 'evaluate';
  if (kind === 'missing-rule') value.rules.pop();
  expect(() => assertManagedBranchRule(value)).toThrow('single writer');
});
it('stops when a policy was replaced or a human commit exists on the managed branch', async () => {
  const f = fixture(true);
  await expect(f.plane.syncPreflight(1187527897, 'e'.repeat(40))).rejects.toThrow('policy changed');
  f.routes['repos/splrad/LayerScape/git/matching-refs/heads/steward/managed-sync'] = [{ ref: 'refs/heads/steward/managed-sync', object: { sha: 'd'.repeat(40) } }];
  f.routes[`repos/splrad/LayerScape/compare/${f.S}...${'d'.repeat(40)}`] = { status: 'ahead', ahead_by: 1, total_commits: 1, commits: [{ author: { id: 1 }, committer: { id: 301115370 }, commit: { verification: { verified: true } } }] };
  await expect(f.plane.syncPreflight(1187527897, f.P)).rejects.toThrow('human');
});
