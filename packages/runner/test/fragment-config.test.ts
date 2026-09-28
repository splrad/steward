import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateFragmentProfile, type FragmentProfile } from '../../core/src/index.js';

const root = resolve('.');
let fixture: string;
let configuration: Record<string, unknown>;
beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'steward-fragment-config-'));
  await cp(join(root, 'config'), join(fixture, 'config'), { recursive: true });
  await cp(join(root, 'schema'), join(fixture, 'schema'), { recursive: true });
  await mkdir(join(fixture, 'packages/runtime'), { recursive: true });
  await cp(join(root, 'packages/runtime/wrangler.toml'), join(fixture, 'packages/runtime/wrangler.toml'));
  configuration = JSON.parse(await readFile(join(fixture, 'config/profiles/validation/steward.json'), 'utf8'));
});
afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });

async function verify(profile: FragmentProfile) {
  await writeFile(join(fixture, 'config/profiles/validation/steward.json'), JSON.stringify({
    ...configuration, fragmentGate: { repositories: [], profile },
  }));
  return spawnSync(process.execPath, [join(root, 'scripts/verify-config.mjs')], { cwd: fixture, encoding: 'utf8' });
}

describe.each(['fragmentDirectory', 'required', 'reviewRequired', 'ignored'] as const)('fragment config %s', field => {
  function profileWith(value: string): FragmentProfile {
    const profile: FragmentProfile = { fragmentDirectory: 'fragments', required: [], reviewRequired: [], ignored: [] };
    if (field === 'fragmentDirectory') profile.fragmentDirectory = value;
    else profile[field] = [value];
    return profile;
  }

  it.each([0x061c, 0x200e, 0x200f, 0x2028, 0x202e, 0x2066, 0x2069, 0xfeff, 0xd800, 0xdfff])('rejects code point %i in config and runtime', async code => {
    const profile = profileWith(`src/${String.fromCodePoint(code)}notes`);
    expect(() => validateFragmentProfile(profile)).toThrow();
    const result = await verify(profile);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(field === 'fragmentDirectory' ? '片段目录不是字面相对路径' : '片段路径模式无效');
  });

  it('accepts Unicode paths including supplementary characters', async () => {
    const profile = profileWith('发布/📝');
    expect(() => validateFragmentProfile(profile)).not.toThrow();
    const result = await verify(profile);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('configuration verified');
  });
});
