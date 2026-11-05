import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { isolatedGitHubEnvironment } from '../src/build-environment.js';
import { permitOfflineScript, registerOfflineFixtureRoot } from './offline-fixtures.js';

it('passes only the selected credential to an actual child process with an isolated gh profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gh-environment-'));
  registerOfflineFixtureRoot(home);
  try {
    const parent = { ...process.env, STEWARD_APP_PRIVATE_KEY: 'sentinel-private', POLICY_READ_TOKEN: 'sentinel-policy',
      RULES_READ_TOKEN: 'sentinel-rules', GITHUB_TOKEN: 'sentinel-github', COPILOT_GITHUB_TOKEN: 'sentinel-model',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'sentinel-oidc', HTTPS_PROXY: 'https://sentinel.invalid', NODE_OPTIONS: '--inspect',
      GH_TOKEN: 'sentinel-other-repository', GH_HOST: 'sentinel.invalid', GH_CONFIG_DIR: '/other/profile', GH_DEBUG: 'api' };
    const probe = join(home, 'environment.mjs');
    await writeFile(probe, 'process.stdout.write(JSON.stringify(process.env));');
    permitOfflineScript(probe);
    const environment = isolatedGitHubEnvironment(parent, home, 'fixture-target');
    const { stdout } = await promisify(execFile)(process.execPath, [probe], { env: environment, encoding: 'utf8' });
    const received = JSON.parse(stdout);
    expect(received.GH_TOKEN).toBe('fixture-target');
    expect(received.GH_CONFIG_DIR).toBe(home);
    expect(received.HOME).toBe(home);
    expect(received.GH_HOST).toBe('github.com');
    expect(Object.values(received).some(value => String(value).includes('sentinel'))).toBe(false);
    expect(Object.keys(received).filter(key => /TOKEN|SECRET|PRIVATE_KEY/.test(key))).toEqual(['GH_TOKEN']);
    expect(parent.GH_TOKEN).toBe('sentinel-other-repository');
  } finally { await rm(home, { recursive: true, force: true }); }
});

it.each([undefined, '', ' ', 'token\nother', 'token\0other'])('rejects absent or malformed explicit credentials', token => {
  expect(() => isolatedGitHubEnvironment({ GITHUB_TOKEN: 'ambient-login' }, '/isolated', token)).toThrow('GH_CREDENTIAL_REQUIRED');
});
