import { mkdtemp, readFile, readdir, lstat, rm, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const policyRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const toolIds = { jactionlint: 'github:jdx/jactionlint', zizmor: 'aqua:zizmorcore/zizmor',
  shellcheck: 'aqua:koalaman/shellcheck', ruff: 'aqua:astral-sh/ruff' } as const;

export async function assertPolicyNodeVersion(runtimeRoot = policyRoot): Promise<void> {
  runtimeRoot = resolve(runtimeRoot);
  const inventory = JSON.parse(run('mise', ['ls', '--json'], runtimeRoot, toolEnvironment(runtimeRoot)));
  const node = inventory.node?.filter((entry: any) => entry.active === true);
  if (!Array.isArray(node) || node.length !== 1 || !node[0].installed || !node[0].active
    || resolve(node[0].source?.path ?? '') !== join(runtimeRoot, 'mise.toml') || node[0].version !== process.versions.node) {
    throw new Error('Node does not match trusted mise lock');
  }
  const rel = relative(await realpath(node[0].install_path), await realpath(process.execPath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Node executable outside trusted installation');
}

function toolEnvironment(runtimeRoot = policyRoot): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { MISE_SAFE: '1', MISE_LOCKED: '1', MISE_NODE_COMPILE: 'false',
    MISE_TRUSTED_CONFIG_PATHS: runtimeRoot };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG',
    'MISE_DATA_DIR', 'MISE_CONFIG_DIR', 'MISE_CACHE_DIR', 'MISE_STATE_DIR', 'MISE_SYSTEM_CONFIG_DIR', 'MISE_GLOBAL_CONFIG_FILE']) {
    if (process.env[key]) clean[key] = process.env[key];
  }
  return clean;
}

export interface WorkflowToolResult { executable: string; args: string[]; status: number | null; stdout: string; stderr: string }
function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, evidence?: WorkflowToolResult[], acceptedStatuses: number[] = [0]): string {
  const result = spawnSync(executable, args, { cwd, env, shell: false, windowsHide: true,
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  evidence?.push({ executable, args, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  if (result.error || result.status === null || !acceptedStatuses.includes(result.status)) {
    throw new Error(`${executable} failed (${result.status ?? result.signal}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout;
}

/** Select only the three adopted native trigger diagnostics; workflow behavior stays under normal review. */
function acceptedTrigger(root: string, finding: any, files: readonly string[]): string | null {
  if (finding?.ident !== 'dangerous-triggers' || finding.ignored !== false || !Array.isArray(finding.locations)) return null;
  const primary = finding.locations.filter((location: any) => location?.symbolic?.kind === 'Primary');
  if (primary.length !== 1) return null;
  const path = primary[0].symbolic?.key?.Local?.verbatim_path;
  if (typeof path !== 'string' || !isAbsolute(path) || !files.includes(resolve(path))) return null;
  const local = relative(root, path).replaceAll('\\', '/');
  const route = JSON.stringify(primary[0].symbolic?.route?.route);
  if (['.github/workflows/pr-title.yml', 'templates/repository/.github/workflows/pr-title.yml'].includes(local)
    && route === JSON.stringify([{ Key: 'on' }, { Key: 'pull_request_target' }])) return 'E07-TITLE-METADATA-20261028';
  if (local === '.github/workflows/governance-promotion.yml'
    && route === JSON.stringify([{ Key: 'on' }, { Key: 'workflow_run' }])) return 'E07-PROMOTION-WORKFLOW-RUN-20261031';
  if (['.github/workflows/pr-labeler.yml', 'templates/repository/.github/workflows/pr-labeler.yml'].includes(local)
    && route === JSON.stringify([{ Key: 'on' }, { Key: 'workflow_run' }])) return 'E08-LABELER-TITLE-WORKFLOW-RUN-20261103';
  return null;
}
export async function resolvePolicyTool(name: 'syft' | 'gh' | 'lychee' | 'oras' | 'uv', runtimeRoot = policyRoot): Promise<string> {
  runtimeRoot = resolve(runtimeRoot);
  const ids = { syft: 'aqua:anchore/syft', gh: 'aqua:cli/cli', lychee: 'aqua:lycheeverse/lychee', oras: 'aqua:oras-project/oras', uv: 'aqua:astral-sh/uv' };
  const env = toolEnvironment(runtimeRoot), inventory = JSON.parse(run('mise', ['ls', '--json'], runtimeRoot, env));
  const entries = inventory[ids[name]]?.filter((entry: any) => entry.active === true);
  if (!Array.isArray(entries) || entries.length !== 1 || !entries[0].installed || !entries[0].active
    || resolve(entries[0].source?.path ?? '') !== join(runtimeRoot, 'mise.toml')) throw new Error(`${name}: missing trusted locked tool`);
  const executable = await realpath(run('mise', ['which', name], runtimeRoot, env).trim());
  const rel = relative(await realpath(entries[0].install_path), executable);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${name}: outside trusted installation`);
  if (!run(executable, ['--version'], runtimeRoot, env).split(/\s+/).includes(entries[0].version)) throw new Error(`${name}: locked version mismatch`);
  return executable;
}

/** Resolve only the trusted policy's installed lock; never load the scanned repository's config. */
export async function resolveWorkflowTools(runtimeRoot = policyRoot) {
  runtimeRoot = resolve(runtimeRoot);
  const env = toolEnvironment(runtimeRoot);
  const inventory = JSON.parse(run('mise', ['ls', '--json'], runtimeRoot, env));
  const tools = {} as Record<keyof typeof toolIds, string>;
  const versions = {} as Record<keyof typeof toolIds, string>;
  for (const [name, id] of Object.entries(toolIds) as [keyof typeof toolIds, string][]) {
    const entries = inventory[id]?.filter((entry: any) => entry.active === true);
    if (!Array.isArray(entries) || entries.length !== 1 || !entries[0].installed || !entries[0].active
      || resolve(entries[0].source?.path ?? '') !== join(runtimeRoot, 'mise.toml')) {
      throw new Error(`${name}: provision the trusted mise lock before validation`);
    }
    const executable = await realpath(run('mise', ['which', name], runtimeRoot, env).trim());
    const installation = await realpath(entries[0].install_path);
    const rel = relative(installation, executable);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${name}: executable outside locked installation`);
    const version = run(executable, ['--version'], runtimeRoot, env);
    if (!version.split(/\s+/).includes(entries[0].version)) throw new Error(`${name}: installed version differs from mise lock`);
    tools[name] = executable;
    versions[name] = entries[0].version;
  }
  return { tools, versions, env };
}

async function targetFile(root: string, path: string): Promise<string> {
  const rel = relative(root, resolve(root, path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/\.ya?ml$/.test(path)) throw new Error('workflow path outside target');
  let parent = root;
  for (const segment of rel.split(/[\\/]/)) {
    parent = join(parent, segment);
    if ((await lstat(parent)).isSymbolicLink()) throw new Error('workflow path must not traverse symlinks');
  }
  const full = await realpath(parent);
  if (!(await lstat(full)).isFile()) throw new Error('workflow must be a regular file');
  return full;
}

/** Inventory comes from candidate files, never its config or a catalog whitelist. */
export async function discoverWorkflowFiles(workspace: string, includeTemplates = false): Promise<string[]> {
  const root = await realpath(workspace), pending: string[] = [], visited = new Set<string>();
  async function collect(directory: string, recursive: boolean) {
    let entries;
    try {
      let parent = root;
      for (const segment of directory.split('/')) {
        parent = join(parent, segment);
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('workflow directory must be a regular directory');
      }
      entries = await readdir(parent, { withFileTypes: true });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (/\.ya?ml$/.test(entry.name)) pending.push(path);
      else if (recursive && entry.isDirectory()) await collect(path, true);
    }
  }
  await collect('.github/workflows', false);
  if (includeTemplates) await collect('templates', true);
  while (pending.length) {
    const path = pending.shift()!;
    if (visited.has(path)) continue;
    const full = await targetFile(root, path);
    // Native scanners own YAML and expression diagnostics. Parsing here only finds
    // local dependencies; malformed documents still reach the native scanners.
    const parsed = YAML.parseDocument(await readFile(full, 'utf8'));
    if (parsed.errors.length) { visited.add(path); continue; }
    const document = parsed.toJS({ maxAliasCount: 100 });
    if (path.startsWith('templates/') && !document?.on && !document?.jobs && !document?.runs) continue;
    visited.add(path);
    const uses: string[] = [];
    for (const job of Object.values(document?.jobs ?? {}) as any[]) {
      if (typeof job?.uses === 'string') uses.push(job.uses);
      for (const step of job?.steps ?? []) if (typeof step?.uses === 'string') uses.push(step.uses);
    }
    for (const step of document?.runs?.steps ?? []) if (typeof step?.uses === 'string') uses.push(step.uses);
    for (const use of uses.filter(use => use.startsWith('./') || use.startsWith('$/'))) {
      const local = relative(root, resolve(root, use.slice(2))).replace(/\\/g, '/');
      if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('workflow dependency outside target');
      if (/\.ya?ml$/.test(local)) pending.push(local);
      else {
        let found = false;
        for (const name of ['action.yml', 'action.yaml']) {
          try { await targetFile(root, `${local}/${name}`); pending.push(`${local}/${name}`); found = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (!found) throw new Error(`missing local action: ${local}`);
      }
    }
  }
  return [...visited].sort();
}

export async function scanWorkflows(workspace: string, paths: readonly string[], runtimeRoot = policyRoot) {
  const results: WorkflowToolResult[] = [];
  if (!paths.length) return { files: [], versions: {}, results };
  const root = await realpath(workspace);
  const files = await Promise.all(paths.map(path => targetFile(root, path)));
  const { tools, versions, env } = await resolveWorkflowTools(runtimeRoot);
  const temporary = await mkdtemp(join(tmpdir(), 'steward-workflow-scan-'));
  try {
    const isolated: NodeJS.ProcessEnv = { ...env, PATH: [...new Set(Object.values(tools).map(tool => dirname(tool)))].join(delimiter),
      HOME: temporary, USERPROFILE: temporary, XDG_CONFIG_HOME: temporary, APPDATA: temporary, LOCALAPPDATA: temporary,
      PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1' };
    delete isolated.Path;
    run(tools.jactionlint, ['--profile', 'correctness', '--strict-exit', '--no-ignores', '--no-online', '--no-color',
      '--config-file', join(policyRoot, '.github/jactionlint.yaml'), '--shellcheck', tools.shellcheck,
      '--ruff', tools.ruff, '--', ...files], temporary, isolated, results);
    const output = run(tools.zizmor, ['--offline', '--no-config', '--no-ignores', '--strict-collection', '--no-progress', '--color', 'never', '--format=json-v1', ...files], temporary, isolated, results, [0, 14]);
    const findings = JSON.parse(output);
    if (!Array.isArray(findings) || (results.at(-1)!.status === 0 && findings.length !== 0)) throw new Error('zizmor failed: unknown JSON result');
    const exceptions = [];
    if (results.at(-1)!.status !== 0) {
      for (const finding of findings) {
        const decision = acceptedTrigger(root, finding, files);
        if (!decision) throw new Error(`zizmor failed: ${JSON.stringify(finding)}`);
        exceptions.push({ decision, finding });
      }
      if (!exceptions.length) throw new Error('zizmor failed: nonzero result without an accepted finding');
    }
    return { files: [...paths], versions, results, exceptions };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
