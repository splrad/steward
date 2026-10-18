import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { frozenFixture } from '../../core/test/release-receipt-fixture.js';
import { releaseBuildCommand } from '../src/release-build-command.js';
import { collectFileBuildManifest } from '../src/build-manifest.js';
import { BuildContractError } from '../../core/src/build-manifest.js';
import { createInstallationToken } from '../../github/src/index.js';

const { request, transports } = vi.hoisted(() => ({ request: vi.fn(), transports: [] as typeof fetch[] }));
vi.mock('../../github/src/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../github/src/index.js')>(), createInstallationToken: vi.fn(async () => 'fixture'),
}));
vi.mock('../src/release-lifecycle.js', async original => ({ ...await original<typeof import('../src/release-lifecycle.js')>(), ReleaseReceiptClient: class {
  request = request;
  constructor(_base: string, _token: string, _repo: number, _tag: string, transport: typeof fetch) { transports.push(transport); }
} }));
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
it('refreshes the same repository credentials on the receipt transport after long validation', async () => {
  let now = 1000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const issue = vi.mocked(createInstallationToken); issue.mockClear();
  issue.mockResolvedValueOnce('first').mockResolvedValueOnce('renewed');
  const fetchMock = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  try {
    await invoke();
    const transport = transports.at(-1)!;
    await transport('https://runtime.example/', { headers: { authorization: 'Bearer first' } });
    now += 61 * 60_000;
    await transport('https://runtime.example/', { headers: { authorization: 'Bearer first' } });
    expect(new Headers((fetchMock.mock.calls.at(-1) as any)[1].headers).get('authorization')).toBe('Bearer renewed');
    expect(issue).toHaveBeenCalledTimes(2);
    expect(issue.mock.calls[0]).toEqual(issue.mock.calls[1]);
  } finally { clock.mockRestore(); vi.unstubAllGlobals(); }
});
it('finishes only after the complete seed has been validated and saved', async () => {
  await invoke(); expect(request.mock.calls.at(-1)?.[1].action).toBe('finish');
});
it.each(['source-only', 'finish-failed'])('reuses identical partial or complete seed on retry: %s', async mode => {
  if (mode === 'source-only') await writeFile(join(directory, 'source.json'), 'source');
  else {
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (action, body, suffix) => {
      if (body?.action === 'finish') throw new Error('temporary finish failure');
      return original(action, body, suffix);
    });
    await expect(invoke()).rejects.toThrow('temporary finish failure');
    request.mockImplementation(original);
  }
  await invoke();
  expect(request.mock.calls.at(-1)?.[1].action).toBe('finish');
});
it.each([true, false])('marks only deterministic validation failures for rejection: %s', async deterministic => {
  const result = join(directory, 'step-output');
  vi.stubEnv('GITHUB_OUTPUT', result);
  vi.mocked(collectFileBuildManifest).mockRejectedValueOnce(deterministic
    ? new BuildContractError('RN_BUILD_DIGEST') : new Error('temporary I/O failure'));
  await expect(invoke()).rejects.toThrow();
  const content = await readFile(result, 'utf8').catch(() => '');
  expect(content.includes('verificationFailed=true')).toBe(deterministic);
  expect(request.mock.calls.some(call => call[1]?.action === 'finish')).toBe(false);
});
it.each(['My App.zip', '.hidden.zip', 'a'.repeat(201)])('rejects invalid release asset name before finish: %s', async file => {
  const result = join(directory, 'step-output'); vi.stubEnv('GITHUB_OUTPUT', result);
  vi.mocked(collectFileBuildManifest).mockResolvedValueOnce({ artifacts: [{ kind: 'file', file }] } as any);
  await expect(invoke()).rejects.toThrow('RN_BUILD_OUTPUT');
  expect(await readFile(result, 'utf8')).toContain('verificationFailed=true');
  expect(request.mock.calls.some(call => call[1]?.action === 'finish')).toBe(false);
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
