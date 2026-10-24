import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ calls: [] as any[][] }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for('nodejs.util.promisify.custom')]: async (...args: any[]) => { state.calls.push(args); return { stdout: '{}' }; },
}) }));
import { nativeGhCommand } from '../src/gh-release.js';
afterEach(() => { state.calls.length = 0; vi.unstubAllEnvs(); });
it.each([
  ['repos/splrad/steward', true], ['repos/splrad/steward/commits/main', true],
  ['repos/splrad/steward/contents/config/repositories.json?ref=' + 'a'.repeat(40), true],
  ['repos/splrad/steward/contents/config/release/defaults.json?ref=' + 'a'.repeat(40), true],
  ['repos/splrad/steward/contents/config/release/bootstrap.json?ref=' + 'a'.repeat(40), true],
  ['repos/splrad/LayerScape/contents/release-please-config.json?ref=' + 'a'.repeat(40), false],
  ['repos/splrad/steward/compare/' + 'a'.repeat(40) + '...' + 'b'.repeat(40), true],
  ['repos/splrad/steward/releases?per_page=100', false], ['repos/splrad/steward/releases/42', false],
  ['repos/splrad/LayerScape/releases?per_page=100', false], ['repos/splrad/LayerScape/rulesets/1', false],
] as const)('routes %s without replacing target draft credentials', async (path, policy) => {
  vi.stubEnv('GH_TOKEN', 'fixture-target'); vi.stubEnv('POLICY_READ_TOKEN', 'fixture-policy');
  await nativeGhCommand(['api', path]);
  expect(state.calls[0]![2].env.GH_TOKEN).toBe(policy ? 'fixture-policy' : 'fixture-target');
  expect(state.calls[0]![1]).toEqual(['api', path]);
});

it.each(['missing', 'foreign', 'invalid-id'])('rejects isolated rules credential: %s', async kind => {
  vi.stubEnv('RULES_READ_TOKEN', kind === 'missing' ? '' : 'fixture-rules');
  vi.stubEnv('RULES_READ_REPOSITORY', kind === 'foreign' ? 'splrad/steward' : 'splrad/LayerScape');
  const { nativeRulesRead } = await import('../src/gh-release.js');
  await expect(nativeRulesRead('splrad/LayerScape', kind === 'invalid-id' ? -1 : 1)).rejects.toThrow('RULES_READ');
  expect(state.calls).toHaveLength(0);
});
it.each([undefined, 123])('routes scoped rule read %s without exposing other credentials', async ruleId => {
  vi.stubEnv('RULES_READ_TOKEN', 'fixture-rules'); vi.stubEnv('RULES_READ_REPOSITORY', 'splrad/LayerScape');
  vi.stubEnv('GH_TOKEN', 'fixture-writer'); vi.stubEnv('POLICY_READ_TOKEN', 'fixture-policy'); vi.stubEnv('GITHUB_TOKEN', 'fixture-github');
  const { nativeRulesRead } = await import('../src/gh-release.js');
  await nativeRulesRead('splrad/LayerScape', ruleId);
  const [binary, args, options] = state.calls[0]!;
  expect(binary).toBe('gh'); expect(args[0]).toBe('api'); expect(args).not.toContain('--method');
  expect(args.at(-1)).toBe(ruleId === undefined ? 'repos/splrad/LayerScape/rulesets?includes_parents=true&per_page=100' : 'repos/splrad/LayerScape/rulesets/123');
  expect(options.env.GH_TOKEN).toBe('fixture-rules');
  for (const key of ['RULES_READ_TOKEN', 'POLICY_READ_TOKEN', 'GITHUB_TOKEN']) expect(options.env[key]).toBeUndefined();
  await nativeGhCommand(['label', 'create', 'auto/test', '--repo', 'splrad/LayerScape']);
  expect(state.calls[1]![2].env.GH_TOKEN).toBe('fixture-writer');
  expect(state.calls[1]![2].env.RULES_READ_TOKEN).toBeUndefined();
});
