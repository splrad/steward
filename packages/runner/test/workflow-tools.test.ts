import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect, afterEach, vi } from 'vitest';
import { discoverWorkflowFiles, scanWorkflows as scanWithPolicyTools } from '../src/workflow-tools.js';
import YAML from 'yaml';
const runtimeRoot = resolve(process.env.STEWARD_TEST_TOOLCHAIN_ROOT ?? '.');
const scanWorkflows = (workspace: string, paths: readonly string[]) => scanWithPolicyTools(workspace, paths, runtimeRoot);

const state = vi.hoisted(() => ({ missing: false, extraEntry: 'none', diagnostic: null as null | {status: number; stdout: string}, calls: [] as { command: string; args: string[]; env: Record<string, string> }[] }));
// This integration file permits only mise's read-only lookup and the offline
// scanners and their version checks from the batch's installed tool directory. All other subprocesses fail.
vi.mock('node:child_process', async importOriginal => {
  const native = await importOriginal<typeof import('node:child_process')>();
  return { ...native, spawnSync(command: string, args: string[], options: any) {
    state.calls.push({ command, args, env: options.env });
    if (state.missing && command === 'mise') return { status: 0, stdout: '{}', stderr: '' };
    const lookup = command === 'mise' && (JSON.stringify(args) === '["ls","--json"]'
      || (args.length === 2 && args[0] === 'which' && ['jactionlint','zizmor','shellcheck','ruff'].includes(args[1]!)));
    const base = process.env.MISE_DATA_DIR;
    const scanner = !!base && resolve(command).startsWith(resolve(base) + (process.platform === 'win32' ? '\\' : '/'))
      && /(?:jactionlint|zizmor|shellcheck|ruff)(?:\.exe)?$/.test(command)
      && (args[0] === '--profile' || args[0] === '--version' || args[0] === '--offline');
    if (!lookup && !scanner) throw new Error('TEST_SUBPROCESS_DENIED');
    if (args[0] === '--offline' && state.diagnostic) return { ...state.diagnostic, stderr: '' };
    const result = native.spawnSync(command, args, options);
    if (command === 'mise' && args[0] === 'ls' && state.extraEntry !== 'none' && result.status === 0) {
      const inventory = JSON.parse(result.stdout as string);
      for (const entries of Object.values(inventory) as any[][]) {
        const active = entries.find(entry => entry.active === true);
        if (active) entries.push({ ...active, active: state.extraEntry === 'active', source: undefined });
      }
      return { ...result, stdout: JSON.stringify(inventory) };
    }
    return result;
  } };
});
const roots: string[] = [];
afterEach(async () => {
  state.missing = false; state.extraEntry = 'none'; state.diagnostic = null; state.calls.length = 0; vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const clean = `name: Test\non: pull_request\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe\n`;
it.each([
  {status: 14, stdout: 'not JSON'}, {status: 14, stdout: '{}'},
  {status: 14, stdout: '[]'}, {status: 0, stdout: '[{"ident":"dangerous-triggers"}]'},
  {status: 1, stdout: '[]'}, {status: 14, stdout: '[{"ident":"dangerous-triggers","ignored":true}]'},
])('fails closed on an invalid native scanner response: $status $stdout', async diagnostic => {
  const root = await fixture(clean);
  state.diagnostic = diagnostic;
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).rejects.toThrow();
}, 120000);
async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-tools-test-')); roots.push(root);
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/workflows/test.yml'), text); return root;
}
it('executes both locked tools without candidate configuration or credentials', async () => {
  const root = await fixture(clean);
  await writeFile(join(root, 'mise.toml'), '[env]\nTOKEN="candidate"\n');
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).resolves.toMatchObject({results: [{status: 0}, {status: 0}]});
  expect(state.calls.some(call => call.args[0] === '--offline')).toBe(true);
  expect(state.calls.some(call => call.args.includes('--ruff'))).toBe(true);
  expect(state.calls.every(call => !call.args.includes('--pyflakes'))).toBe(true);
  expect(state.calls.every(call => !Object.keys(call.env).some(name => /TOKEN|SECRET|PRIVATE_KEY/.test(name)))).toBe(true);
  expect(state.calls.every(call => !call.args.includes('-ignore'))).toBe(true);
}, 120000);
it('binds native lock graph trust to the policy and ignores only inactive installations', async () => {
  const root = await fixture(clean);
  vi.stubEnv('MISE_TRUSTED_CONFIG_PATHS', root);
  state.extraEntry = 'inactive';
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).resolves.toMatchObject({ results: [{status:0},{status:0}] });
  expect(state.calls.every(call => call.env.MISE_TRUSTED_CONFIG_PATHS === runtimeRoot)).toBe(true);
  state.extraEntry = 'active';
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).rejects.toThrow('provision the trusted mise lock');
}, 120000);
it.each(['single', 'max'])('accepts native queue %s and workflow source contexts at both levels', async queue => {
  const d = YAML.parse(clean);
  d.concurrency = { group: '${{ github.workflow_ref }}', queue, 'cancel-in-progress': false };
  d.jobs.test.concurrency = { group: 'job-queue', queue, 'cancel-in-progress': false };
  d.jobs.test.steps = [{ env: { SHA: '${{ job.workflow_sha }}', REF: '${{ job.workflow_ref }}' }, run: 'echo "$SHA $REF"' }];
  const root = await fixture(YAML.stringify(d));
  await expect(scanWorkflows(root, await discoverWorkflowFiles(root))).resolves.toMatchObject({results: [{status: 0}, {status: 0}]});
}, 120000);
it.each(['invalid-queue', 'max-cancel', 'context', 'needs', 'duplicate-yaml', 'shellcheck', 'ruff'])('native diagnostics reject %s', async kind => {
  const d = YAML.parse(clean);
  d.concurrency = { group: 'workflow', queue: 'max', 'cancel-in-progress': false };
  if (kind === 'invalid-queue') d.concurrency.queue = 'all';
  if (kind === 'max-cancel') d.concurrency['cancel-in-progress'] = true;
  if (kind === 'context') d.jobs.test.steps[0].env = { SHA: '${{ job.workflow_shaa }}' };
  if (kind === 'needs') d.jobs.test.needs = 'missing';
  if (kind === 'shellcheck') d.jobs.test.steps = [{ shell: 'bash', run: 'echo $UNQUOTED' }];
  if (kind === 'ruff') d.jobs.test.steps = [{ shell: 'python', run: 'print(undefined_name)' }];
  const root = await fixture(YAML.stringify(d) + (kind === 'duplicate-yaml' ? 'name: duplicate\n' : ''));
  await writeFile(join(root, '.github/jactionlint.yaml'), 'profile: correctness\nignores: [".*"]\n');
  await expect(scanWorkflows(root, await discoverWorkflowFiles(root))).rejects.toThrow(/jactionlint.*failed/);
}, 120000);
it.each(['valid', 'input', 'secret', 'local-action'])('discovers and validates local calls: %s', async kind => {
  const root = await fixture('name: Caller\non: pull_request\npermissions:\n  contents: read\njobs:\n  call:\n    uses: $/.github/workflows/called.yml\n    with:\n      message: hello\n');
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'actions/nested'), { recursive: true });
  await writeFile(join(root, '.github/workflows/called.yml'), `name: Called
on:
  workflow_call:
    inputs:
      message:
        required: true
        type: string
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: $/actions/nested
        with:
          message: hello
`);
  await writeFile(join(root, 'actions/nested/action.yml'), `name: Local
description: Local fixture
inputs:
  message:
    description: Message
    required: true
runs:
  using: composite
  steps:
    - shell: bash
      env:
        MESSAGE: \${{ inputs.message }}
      run: echo "$MESSAGE"
`);
  if (kind === 'input' || kind === 'secret') {
    const path = join(root, '.github/workflows/test.yml'), d = YAML.parse(await readFile(path, 'utf8'));
    if (kind === 'input') d.jobs.call.with.undeclared = 'bad';
    else d.jobs.call.secrets = { undeclared: '${{ secrets.TOKEN }}' };
    await writeFile(path, YAML.stringify(d));
  }
  if (kind === 'local-action') {
    const path = join(root, 'actions/nested/action.yml');
    await writeFile(path, (await readFile(path, 'utf8')).replace('echo "$MESSAGE"', 'echo $MESSAGE'));
  }
  const paths = await discoverWorkflowFiles(root);
  expect(paths).toEqual(['.github/workflows/called.yml', '.github/workflows/test.yml', 'actions/nested/action.yml']);
  if (kind === 'valid') await expect(scanWorkflows(root, paths)).resolves.toMatchObject({results: [{status: 0}, {status: 0}]});
  else await expect(scanWorkflows(root, paths)).rejects.toThrow(/jactionlint.*failed/);
}, 120000);
it('discovers additions, renames and removals independently of candidate catalog data', async () => {
  const root = await fixture(clean);
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config/repositories.json'), '{"allowedWorkflowPaths":[]}');
  expect(await discoverWorkflowFiles(root)).toEqual(['.github/workflows/test.yml']);
  await rename(join(root, '.github/workflows/test.yml'), join(root, '.github/workflows/renamed.yaml'));
  expect(await discoverWorkflowFiles(root)).toEqual(['.github/workflows/renamed.yaml']);
  await rm(join(root, '.github/workflows/renamed.yaml'));
  expect(await discoverWorkflowFiles(root)).toEqual([]);
});
it.each(["github.event['pull_request']['title']", "github['event'].pull_request.title", 'github.event.commits[0].message',
  'github.head_ref', 'toJSON(github.event)', 'inputs.command'])('native security scan rejects shell injection: %s', async expression => {
  const text = clean.replace('on: pull_request', 'on:\n  pull_request:\n  workflow_dispatch:\n    inputs:\n      command:\n        type: string')
    .replace('echo safe', `echo "\${{ ${expression} }}" # zizmor: ignore[template-injection]`);
  const root = await fixture(text);
  await expect(scanWorkflows(root, await discoverWorkflowFiles(root))).rejects.toThrow(/jactionlint.*failed|zizmor.*failed/);
}, 120000);
it.each(['unpinned', 'checkout-credentials', 'excessive-permission'])('native security scan rejects %s', async kind => {
  const d = YAML.parse(clean);
  if (kind === 'excessive-permission') { d.on = 'push'; d.permissions = 'write-all'; d.jobs.other = structuredClone(d.jobs.test); }
  else d.jobs.test.steps = [{ uses: 'actions/checkout@' + (kind === 'unpinned' ? 'main' : '3d3c42e5aac5ba805825da76410c181273ba90b1'),
    ...(kind === 'unpinned' ? { with: { 'persist-credentials': false } } : {}) }];
  const root = await fixture(YAML.stringify(d));
  await expect(scanWorkflows(root, await discoverWorkflowFiles(root))).rejects.toThrow(/zizmor.*failed/);
}, 120000);
it.each(['pull_request_target', 'workflow_run'])('rejects untrusted code under privileged trigger %s', async trigger => {
  const d = YAML.parse(clean);
  d.on = trigger === 'workflow_run' ? { workflow_run: { workflows: ['Build'], types: ['completed'] } } : { pull_request_target: {} };
  const ref = trigger === 'workflow_run' ? '${{ github.event.workflow_run.head_sha }}' : '${{ github.event.pull_request.head.sha }}';
  d.jobs.test.steps = [{ uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', with: { ref, 'persist-credentials': false } },
    { run: 'bash candidate.sh' }];
  const root = await fixture(YAML.stringify(d));
  await expect(scanWorkflows(root, await discoverWorkflowFiles(root))).rejects.toThrow(/zizmor.*failed/);
}, 120000);
it.each(['repositories', 'revocation', 'permissions'])('native App audit rejects token scope regression: %s', async kind => {
  const d = YAML.parse(clean);
  d.on = 'workflow_dispatch';
  d.jobs.test.environment = 'steward-automation';
  const inputs: Record<string, string | boolean> = { 'client-id': 'Iv23liuSr0qd4WLJdZhH', 'private-key': '${{ secrets.STEWARD_APP_PRIVATE_KEY }}',
    owner: 'splrad', repositories: 'steward', 'permission-contents': 'read' };
  if (kind === 'repositories') delete inputs.repositories;
  if (kind === 'revocation') inputs['skip-token-revoke'] = true;
  if (kind === 'permissions') delete inputs['permission-contents'];
  d.jobs.test.steps = [{ uses: 'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510', with: inputs }];
  const root = await fixture(YAML.stringify(d));
  await expect(scanWorkflows(root, await discoverWorkflowFiles(root))).rejects.toThrow(/github-app/);
}, 120000);
it.each(['yaml', 'injection', 'ignored'])('real scanners reject %s', async kind => {
  let text = clean;
  if (kind === 'yaml') text += '  broken: [\n';
  else text = text.replace('echo safe', 'echo "${{ github.event.pull_request.title }}" # zizmor: ignore[template-injection]');
  const root = await fixture(text);
  await writeFile(join(root, 'zizmor.yml'), 'rules:\n  template-injection:\n    ignore: [test.yml]\n');
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).rejects.toThrow(/jactionlint.*failed|zizmor.*failed|invalid YAML/);
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
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).resolves.toMatchObject({results: [{status: 0}, {status: 0}]});
  expect(state.calls.some(call => call.args[0] === '--offline')).toBe(true);
  expect(state.calls.some(call => call.args.includes('--ruff'))).toBe(true);
  expect(state.calls.every(call => !call.args.includes('--pyflakes'))).toBe(true);
}, 120000);
it('still blocks unrelated actionlint errors alongside a valid queue', async () => {
  const root = await fixture(clean.replace('jobs:', 'concurrency:\n  group: workflow\n  queue: max\njobs:')
    .replace('echo safe', 'echo "${{ unknown.value }}"'));
  await expect(scanWorkflows(root, ['.github/workflows/test.yml'])).rejects.toThrow(/jactionlint.*failed/);
}, 120000);

it.each(['adopted', 'native-sha-update'])('accepts only the trusted metadata title exception: %s', async kind => {
  let text = await readFile('templates/repository/.github/workflows/pr-title.yml', 'utf8');
  if (kind === 'native-sha-update') text = text.replace(/(amannn\/action-semantic-pull-request@)[a-f0-9]{40}/, '$1' + 'a'.repeat(40));
  const root = await fixture(text);
  await rename(join(root, '.github/workflows/test.yml'), join(root, '.github/workflows/pr-title.yml'));
  const result = await scanWorkflows(root, await discoverWorkflowFiles(root));
  expect(result.results.at(-1)?.status).toBe(14);
  expect(result.exceptions).toHaveLength(1);
}, 120000);

it.each(['adopted','action-sha','mise-release'])('accepts the approved central promotion trigger and retains native findings: %s',async kind=>{
  const document=YAML.parse(await readFile('.github/workflows/governance-promotion.yml','utf8'));
  if(kind==='action-sha')document.jobs.promote.steps[0].uses='actions/checkout@'+'a'.repeat(40);
  if(kind==='mise-release')document.jobs.promote.steps[1].with.version='2026.11.1';
  const root=await fixture(YAML.stringify(document));
  await rename(join(root,'.github/workflows/test.yml'),join(root,'.github/workflows/governance-promotion.yml'));
  const result=await scanWorkflows(root,await discoverWorkflowFiles(root));
  expect(result.results.at(-1)?.status).toBe(14);
  expect(result.exceptions).toHaveLength(1);
  expect(result.exceptions![0]).toMatchObject({decision:'E07-PROMOTION-WORKFLOW-RUN-20261031',finding:{ident:'dangerous-triggers',ignored:false}});
  expect(result.results.at(-1)?.stdout).toContain('workflow_run');
},120000);

it.each(['title-path','promotion-path','wrong-trigger','other-finding'])('rejects diagnostics outside the exact adopted trigger locations: %s',async kind=>{
  const title=kind==='title-path';
  const document=YAML.parse(await readFile(title?'templates/repository/.github/workflows/pr-title.yml':'.github/workflows/governance-promotion.yml','utf8'));
  if(kind==='wrong-trigger')document.on.pull_request_target={};
  const root=await fixture(YAML.stringify(document));
  if(!kind.endsWith('-path'))await rename(join(root,'.github/workflows/test.yml'),join(root,'.github/workflows/governance-promotion.yml'));
  if(kind==='other-finding')await writeFile(join(root,'.github/workflows/unsafe.yml'),clean.replace('echo safe','echo "${{ github.head_ref }}"'));
  await expect(scanWorkflows(root,await discoverWorkflowFiles(root))).rejects.toThrow(/zizmor.*failed|jactionlint.*failed/);
},120000);

it.each(['title','promotion'])('accepts a normal additional job without a duplicate YAML contract: %s',async kind=>{
  const path=kind==='title'?'.github/workflows/pr-title.yml':'.github/workflows/governance-promotion.yml';
  const document=YAML.parse(await readFile(kind==='title'?'templates/repository/'+path:path,'utf8'));
  document.jobs.documentation={name:'Reviewed documentation', 'runs-on':'ubuntu-24.04',permissions:{contents:'read'},steps:[{run:'echo documentation'}]};
  const root=await fixture(YAML.stringify(document));await rename(join(root,'.github/workflows/test.yml'),join(root,path));
  const result=await scanWorkflows(root,await discoverWorkflowFiles(root));
  expect(result.exceptions).toHaveLength(1);
},120000);

it.each(['.github/workflows/pr-labeler.yml','templates/repository/.github/workflows/pr-labeler.yml'])('accepts the approved label metadata trigger at %s',async path=>{
  const text=clean.replace('on: pull_request','on:\n  workflow_run:\n    workflows: [SPLRAD PR Title]\n    types: [completed]');
  const root=await fixture(text);
  await mkdir(join(root,path,'..'),{recursive:true});
  await rename(join(root,'.github/workflows/test.yml'),join(root,path));
  const result=await scanWorkflows(root,[path]);
  expect(result.results.at(-1)?.status).toBe(14);
  expect(result.exceptions).toHaveLength(1);
  expect(result.exceptions![0]).toMatchObject({decision:'E08-LABELER-TITLE-WORKFLOW-RUN-20261103',finding:{ident:'dangerous-triggers',ignored:false}});
},120000);

it.each(['other-path','pull_request_target','other-finding'])('retains native labeler scan rejection: %s',async kind=>{
  const trigger=kind==='pull_request_target'?'pull_request_target: {}':'workflow_run:\n    workflows: [SPLRAD PR Title]\n    types: [completed]';
  const text=clean.replace('on: pull_request','on:\n  '+trigger);
  const root=await fixture(text),path=kind==='other-path'?'.github/workflows/test.yml':'.github/workflows/pr-labeler.yml';
  if(kind!=='other-path')await rename(join(root,'.github/workflows/test.yml'),join(root,path));
  if(kind==='other-finding')await writeFile(join(root,'.github/workflows/unsafe.yml'),clean.replace('echo safe','echo "${{ github.head_ref }}"'));
  await expect(scanWorkflows(root,await discoverWorkflowFiles(root))).rejects.toThrow(/zizmor.*failed|jactionlint.*failed/);
},120000);
