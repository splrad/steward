import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptActionlintResult, validateQueueSyntax } from './workflow-queue-compat.js';

const policyRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const toolIds = { actionlint: 'aqua:rhysd/actionlint', zizmor: 'aqua:zizmorcore/zizmor' } as const;

export async function assertPolicyNodeVersion(): Promise<void> {
  const inventory = JSON.parse(run('mise', ['ls', '--json'], policyRoot, toolEnvironment()));
  const node = inventory.node;
  if (!Array.isArray(node) || node.length !== 1 || !node[0].installed || !node[0].active
    || resolve(node[0].source?.path ?? '') !== join(policyRoot, 'mise.toml') || node[0].version !== process.versions.node) {
    throw new Error('Node does not match trusted mise lock');
  }
  const rel = relative(await realpath(node[0].install_path), await realpath(process.execPath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Node executable outside trusted installation');
}

function toolEnvironment(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { MISE_SAFE: '1', MISE_LOCKED: '1', MISE_NODE_COMPILE: 'false' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG',
    'MISE_DATA_DIR', 'MISE_CONFIG_DIR', 'MISE_CACHE_DIR', 'MISE_STATE_DIR', 'MISE_SYSTEM_CONFIG_DIR', 'MISE_GLOBAL_CONFIG_FILE']) {
    if (process.env[key]) clean[key] = process.env[key];
  }
  return clean;
}

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(executable, args, { cwd, env, shell: false, windowsHide: true,
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} failed (${result.status ?? result.signal}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout;
}
export async function resolvePolicyTool(name: 'syft' | 'gh' | 'lychee' | 'oras'): Promise<string> {
  const ids = { syft: 'aqua:anchore/syft', gh: 'aqua:cli/cli', lychee: 'aqua:lycheeverse/lychee', oras: 'aqua:oras-project/oras' };
  const env = toolEnvironment(), inventory = JSON.parse(run('mise', ['ls', '--json'], policyRoot, env));
  const entries = inventory[ids[name]];
  if (!Array.isArray(entries) || entries.length !== 1 || !entries[0].installed || !entries[0].active
    || resolve(entries[0].source?.path ?? '') !== join(policyRoot, 'mise.toml')) throw new Error(`${name}: missing trusted locked tool`);
  const executable = await realpath(run('mise', ['which', name], policyRoot, env).trim());
  const rel = relative(await realpath(entries[0].install_path), executable);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${name}: outside trusted installation`);
  if (!run(executable, ['--version'], policyRoot, env).split(/\s+/).includes(entries[0].version)) throw new Error(`${name}: locked version mismatch`);
  return executable;
}

/** Resolve only the trusted policy's installed lock; never load the scanned repository's config. */
export async function resolveWorkflowTools() {
  const env = toolEnvironment();
  const inventory = JSON.parse(run('mise', ['ls', '--json'], policyRoot, env));
  const tools = {} as Record<keyof typeof toolIds, string>;
  for (const [name, id] of Object.entries(toolIds) as [keyof typeof toolIds, string][]) {
    const entries = inventory[id];
    if (!Array.isArray(entries) || entries.length !== 1 || !entries[0].installed || !entries[0].active
      || resolve(entries[0].source?.path ?? '') !== join(policyRoot, 'mise.toml')) {
      throw new Error(`${name}: provision the trusted mise lock before validation`);
    }
    const executable = await realpath(run('mise', ['which', name], policyRoot, env).trim());
    const installation = await realpath(entries[0].install_path);
    const rel = relative(installation, executable);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${name}: executable outside locked installation`);
    const version = run(executable, [name === 'actionlint' ? '-version' : '--version'], policyRoot, env);
    if (!version.split(/\s+/).includes(entries[0].version)) throw new Error(`${name}: installed version differs from mise lock`);
    tools[name] = executable;
  }
  return { tools, env };
}

export async function scanWorkflows(workspace: string, paths: readonly string[]): Promise<void> {
  if (!paths.length) return;
  const root = await realpath(workspace);
  const files = await Promise.all(paths.map(async path => {
    if (!/^(?:\.github\/workflows|templates\/release)\/[\w.-]+\.ya?ml$/.test(path)) throw new Error('workflow path outside target');
    const full = await realpath(resolve(root, path));
    const rel = relative(root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('workflow path outside target');
    return full;
  }));
  const { tools, env } = await resolveWorkflowTools();
  const queueLocations = (await Promise.all(files.map(async file =>
    validateQueueSyntax(file, await readFile(file, 'utf8'))))).flat();
  const temporary = await mkdtemp(join(tmpdir(), 'steward-workflow-scan-'));
  try {
    await writeFile(join(temporary, 'actionlint.yaml'), '{}\n');
    const lint = spawnSync(tools.actionlint, ['-no-color', '-format', '{{json .}}', '-config-file', join(temporary, 'actionlint.yaml'),
      '-shellcheck', '', '-pyflakes', '', ...files], { cwd: temporary, env, shell: false, windowsHide: true,
      encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    if (lint.error || !acceptActionlintResult(lint.status, lint.stdout ?? '', lint.stderr ?? '', queueLocations, temporary)) {
      throw new Error(`actionlint failed (${lint.status ?? lint.signal}): ${lint.error?.message ?? ''}\n${lint.stdout ?? ''}${lint.stderr ?? ''}`);
    }
    run(tools.zizmor, ['--offline', '--no-config', '--no-ignores', '--strict-collection', '--no-progress', '--color', 'never', ...files], temporary, env);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
