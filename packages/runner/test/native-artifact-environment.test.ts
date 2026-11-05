import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ download: [] as any[][], extract: [] as any[][], exitCode: 0 }));
vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => {
    state.download.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    });
    setImmediate(() => { child.stdout.end('fixture archive'); child.stderr.end(); child.emit('close', state.exitCode); });
    return child;
  },
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async (...args: any[]) => { state.extract.push(args); return { stdout: '' }; },
  }),
}));
import { downloadNativeArtifact } from '../src/native-artifact-download.js';
const roots: string[] = [];
afterEach(async () => {
  state.download.length = 0; state.extract.length = 0; state.exitCode = 0; vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function input() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-environment-')); roots.push(root);
  return { fullName: 'splrad/LayerScape', artifactId: 42, digest: `sha256:${'a'.repeat(64)}`,
    names: ['app.exe'], directory: join(root, 'output'), policyDirectory: process.cwd(), home: join(root, 'home') };
}
it('uses the exact artifact ID with only its selected token and extracts without credentials', async () => {
  vi.stubEnv('GH_TOKEN', 'fixture-target');
  for (const key of ['STEWARD_APP_PRIVATE_KEY', 'GITHUB_TOKEN', 'POLICY_READ_TOKEN', 'COPILOT_GITHUB_TOKEN', 'HTTPS_PROXY']) {
    vi.stubEnv(key, 'sentinel-parent');
  }
  const request = await input();
  await downloadNativeArtifact(request);
  const [command, args, options] = state.download[0]!;
  expect(command).toBe('gh');
  expect(args).toEqual(['api', 'repos/splrad/LayerScape/actions/artifacts/42/zip']);
  expect(options.env.GH_TOKEN).toBe('fixture-target');
  expect(options.env.GH_CONFIG_DIR).toBe(request.home);
  expect(Object.values(options.env)).not.toContain('sentinel-parent');
  expect(Object.keys(options.env).filter(key => /TOKEN|SECRET|PRIVATE_KEY/.test(key))).toEqual(['GH_TOKEN']);
  expect(state.extract).toHaveLength(1);
  expect(state.extract[0]![1]).toContain(request.digest.slice(7));
  expect(Object.keys(state.extract[0]![2].env).some(key => /TOKEN|SECRET|PRIVATE_KEY/.test(key))).toBe(false);
});
it('rejects missing credentials before creating the download directory', async () => {
  vi.stubEnv('GH_TOKEN', ''); vi.stubEnv('GITHUB_TOKEN', 'ambient-login');
  const request = await input();
  await expect(downloadNativeArtifact(request)).rejects.toThrow('GH_CREDENTIAL_REQUIRED');
  expect(state.download).toHaveLength(0);
  await expect(stat(request.home)).rejects.toThrow();
});
it('does not extract a failed download', async () => {
  vi.stubEnv('GH_TOKEN', 'fixture-target'); state.exitCode = 1;
  await expect(downloadNativeArtifact(await input())).rejects.toThrow('ARTIFACT_DOWNLOAD_FAILED');
  expect(state.extract).toHaveLength(0);
});
