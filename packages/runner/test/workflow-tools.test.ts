import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect, afterEach, vi } from 'vitest';
import { scanWorkflows } from '../src/workflow-tools.js';

const state = vi.hoisted(() => ({ missing: false, calls: [] as { command: string; args: string[]; env: Record<string, string> }[] }));
// This integration file permits only mise's read-only lookup and the two offline
// scanners from the batch's installed tool directory. All other subprocesses fail.
vi.mock('node:child_process', async importOriginal => {
  const native = await importOriginal<typeof import('node:child_process')>();
  return { ...native, spawnSync(command: string, args: string[], options: any) {
    state.calls.push({ command, args, env: options.env });
    if (state.missing && command === 'mise') return { status: 0, stdout: '{}', stderr: '' };
    const lookup = command === 'mise' && (JSON.stringify(args) === '["ls","--json"]'
      || (args.length === 2 && args[0] === 'which' && ['actionlint','zizmor'].includes(args[1]!)));
    const base = process.env.MISE_DATA_DIR;
    const scanner = !!base && resolve(command).startsWith(resolve(base) + (process.platform === 'win32' ? '\\' : '/'))
      && /(?:actionlint|zizmor)(?:\.exe)?$/.test(command)
      && (args[0] === '-version' || args[0] === '--version' || args[0] === '-no-color' || args[0] === '--offline');
    if (!lookup && !scanner) throw new Error('TEST_SUBPROCESS_DENIED');
    return native.spawnSync(command, args, options);
  } };
});
const roots: string[] = [];
afterEach(async () => {
  state.missing = false; state.calls.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const clean = `name: Test\non: pull_request\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe\n`;
async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-tools-test-')); roots.push(root);
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/workflows/test.yml'), text); return root;
}
it('executes both locked tools without candidate configuration or credentials', async () => {
  const root = await fixture(clean);
  await writeFile(join(root, 'mise.toml'), '[env]\nTOKEN="candidate"\n');
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).resolves.toBeUndefined();
  expect(state.calls.some(call => call.args[0] === '--offline')).toBe(true);
  expect(state.calls.every(call => !Object.keys(call.env).some(name => /TOKEN|SECRET|PRIVATE_KEY/.test(name)))).toBe(true);
  expect(state.calls.every(call => !call.args.includes('-ignore'))).toBe(true);
}, 120000);
it.each(['yaml', 'injection', 'ignored'])('real scanners reject %s', async kind => {
  let text = clean;
  if (kind === 'yaml') text += '  broken: [\n';
  else text = text.replace('echo safe', 'echo "${{ github.event.pull_request.title }}" # zizmor: ignore[template-injection]');
  const root = await fixture(text);
  await writeFile(join(root, 'zizmor.yml'), 'rules:\n  template-injection:\n    ignore: [test.yml]\n');
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).rejects.toThrow(/actionlint.*failed|zizmor.*failed|invalid YAML/);
}, 120000);
it('fails closed without installed locked tools', async () => {
  state.missing = true;
  const root = await fixture(clean);
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).rejects.toThrow('provision');
});
it('refuses traversal before resolving tools', async () => {
  const root = await fixture(clean);
  await expect(scanWorkflows(root, ['../outside.yml'])).rejects.toThrow('outside target');
  expect(state.calls).toHaveLength(0);
});
it('retains max queues at workflow and job level through both real scanners', async () => {
  const root = await fixture(clean.replace('jobs:', 'concurrency:\n  group: workflow\n  queue: max\n  cancel-in-progress: false\njobs:')
    .replace('    runs-on:', '    concurrency:\n      group: job\n      queue: max\n    runs-on:'));
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).resolves.toBeUndefined();
  expect(state.calls.some(call => call.args[0] === '--offline')).toBe(true);
}, 120000);
it('still blocks unrelated actionlint errors alongside a valid queue', async () => {
  const root = await fixture(clean.replace('jobs:', 'concurrency:\n  group: workflow\n  queue: max\njobs:')
    .replace('echo safe', 'echo "${{ unknown.value }}"'));
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).rejects.toThrow('actionlint failed');
}, 120000);
