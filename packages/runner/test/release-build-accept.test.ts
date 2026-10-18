import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { frozenFixture } from '../../core/test/release-receipt-fixture.js';
import { releaseBuildCommand } from '../src/release-build-command.js';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../github/src/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../github/src/index.js')>(), createInstallationToken: vi.fn(async () => 'fixture'),
}));
vi.mock('../src/release-lifecycle.js', () => ({ ReleaseReceiptClient: class { request = request; } }));
vi.mock('../src/build-manifest.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/build-manifest.js')>(), collectFileBuildManifest: vi.fn(async () => ({ artifacts: [] })),
}));
let directory: string;
const frozen = frozenFixture();
const state = { request: { key: 'fixture', mode: 'initial', frozen, plans: [{}] }, status: 'running' };
const invoke = () => releaseBuildCommand({ operation: 'accept', 'policy-sha': frozen.policySha, 'repository-id': String(frozen.repositoryId),
  'target-tag': frozen.targetTag, 'request-key': 'fixture', 'run-id': '10', attempt: '2', 'artifact-id': '20', assets: directory, inspector: 'unused.ps1', output: directory });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'steward-accept-test-'));
  for (const [key, value] of Object.entries({ APP_ID: '1', INSTALLATION_ID: '1', STEWARD_APP_PRIVATE_KEY: 'fixture', RUNTIME_URL: 'https://runtime.example/' })) vi.stubEnv(key, value);
  request.mockReset();
  request.mockImplementation(async (_action, body, suffix) => {
    if (suffix) return { total: 1, bytes_base64: Buffer.from('source').toString('base64') };
    if (body.action === 'get') return state;
    if (body.action === 'finish') {
      expect(await readFile(join(directory, 'source.json'), 'utf8')).toBe('source');
      expect(JSON.parse(await readFile(join(directory, 'frozen.json'), 'utf8')).build).toEqual({ runId: 10, artifactId: 20, artifactName: 'release-build-result-2', headSha: frozen.policySha });
      return { ...state, status: 'accepted' };
    }
    throw new Error('unexpected request');
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
it('finishes only after the complete seed has been validated and saved', async () => {
  await invoke(); expect(request.mock.calls.at(-1)?.[1].action).toBe('finish');
});
it('recreates the seed for an accepted request when completion is rerun after delivery failure', async () => {
  await invoke();
  await rm(join(directory, 'source.json')); await rm(join(directory, 'frozen.json'));
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (action, body, suffix) => body?.action === 'get'
    ? { ...state, status: 'accepted' } : original(action, body, suffix));
  await invoke();
  expect(request.mock.calls.filter(call => call[1]?.action === 'finish')).toHaveLength(2);
  expect(await readFile(join(directory, 'source.json'), 'utf8')).toBe('source');
});
it.each(['download', 'digest', 'source.json', 'frozen.json'])('does not accept when seed preparation fails at %s', async failure => {
  if (failure === 'download' || failure === 'digest') {
    request.mockImplementation(async (_action, body, suffix) => {
      if (!suffix) return state;
      if (failure === 'download') throw new Error('download failed');
      return { total: 1, bytes_base64: Buffer.from('corrupt').toString('base64') };
    });
  } else await writeFile(join(directory, failure), 'existing');
  await expect(invoke()).rejects.toThrow();
  expect(request.mock.calls.some(call => call[1]?.action === 'finish')).toBe(false);
});
