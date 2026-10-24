import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, basename } from 'node:path';

const key = Symbol.for('steward.offline-fixtures');
interface Registry { roots: Set<string>; commands: Set<string>; scripts: Set<string> }
const registry = () => ((globalThis as any)[key] ??= { roots: new Set(), commands: new Set(), scripts: new Set() }) as Registry;
function inside(root: string, path: string) { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')); }
export function registerOfflineFixtureRoot(path: string) {
  const root = realpathSync(path);
  if (root === realpathSync(tmpdir()) || !inside(realpathSync(tmpdir()), root)) throw new Error('fixture root must be a dedicated temporary directory');
  registry().roots.add(root);
}
export function permitOfflineCommand(command: string, args: readonly string[]) {
  if (!['node', 'node.exe', 'pwsh', 'bash', 'dotnet', 'where.exe', 'mise'].includes(basename(command))) throw new Error('unapproved fixture executable');
  if (command === 'mise' && JSON.stringify(args) !== '["ls","--json"]') throw new Error('only read-only mise inventory is allowed');
  registry().commands.add(JSON.stringify([command, ...args]));
}
export function permitOfflineScript(path: string) {
  registry().scripts.add(createHash('sha256').update(readFileSync(path)).digest('hex'));
  registry().scripts.add(resolve(path));
}
export function resetOfflineFixtures() { delete (globalThis as any)[key]; }

/** Only local test repositories and explicitly reviewed script bytes may execute. */
export function offlineProcessArguments(command: string, args: string[], options: any): string[] | null {
  if (options?.shell) return null;
  const state = registry();
  if (state.commands.has(JSON.stringify([command, ...args]))) return args;
  const local = (path: string) => [...state.roots].some(root => inside(root, resolve(path)));
  if (command === 'mkfifo' && args.length === 1 && isAbsolute(args[0]!) && local(args[0]!) && args[0]!.endsWith('.json')) return args;
  if (command === 'git') {
    let cwd = options?.cwd ? resolve(options.cwd) : process.cwd();
    let index = 0;
    while (args[index]?.startsWith('-')) {
      const option = args[index++];
      if (option === '-C') cwd = resolve(cwd, args[index++]!);
      else if (option === '-c') {
        if (!/^(?:core\.fsmonitor=false|diff\.renames=false|core\.whitespace=[a-z,-]+|init\.templateDir=|core\.hooksPath=)$/.test(args[index++] ?? '')) return null;
      } else if (!['--no-replace-objects', '--no-optional-locks'].includes(option!)) return null;
    }
    const verb = args[index++];
    if (verb === 'clone' && args.slice(index).length === 3 && args[index] === '--no-checkout'
      && args[index + 1]?.endsWith('.bundle') && local(args[index + 1]!) && local(args[index + 2]!)) {
      return ['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args];
    }
    if (!local(cwd) || !['init', 'config', 'add', 'commit', 'tag', 'rev-parse', 'status', 'ls-files', 'diff', 'log', 'show',
      'ls-tree', 'cat-file', 'diff-tree', 'for-each-ref', 'check-ref-format', 'merge-base', 'rev-list', 'checkout', 'switch', 'branch', 'merge', 'rm', 'update-ref', 'bundle'].includes(verb ?? '')) return null;
    if (verb === 'config' && !['user.name', 'user.email', 'commit.gpgsign', 'core.autocrlf'].includes(args[index] ?? '')) return null;
    if (args.some(arg => /^(?:--exec|--upload-pack|--receive-pack|--ext-diff|--textconv|--config-env)(?:=|$)/.test(arg))) return null;
    return ['-c', 'core.hooksPath=' + resolve(cwd, '.offline-no-hooks'), '-c', 'protocol.allow=never',
      '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args];
  }
  const executable = basename(command).replace(/\.exe$/, '');
  if (executable === 'dotnet' && ['build', 'publish'].includes(args[0] ?? '') && args[1]?.endsWith('.csproj')) {
    const project = resolve(options?.cwd ?? process.cwd(), args[1]);
    if (!local(project)) return null;
    try {
      if (!state.scripts.has(createHash('sha256').update(readFileSync(project)).digest('hex'))) return null;
      const flags = args.slice(2);
      for (let i = 0; i < flags.length; i++) {
        const flag = flags[i]!;
        if (['-o', '--output'].includes(flag)) { if (!local(flags[++i]!)) return null; }
        else if (['--configuration', '--framework', '--runtime'].includes(flag)) { if (!/^[\w.-]+$/.test(flags[++i] ?? '')) return null; }
        else if (!/^-p:(?:ContinuousIntegrationBuild=true|InformationalVersion=[0-9.+-]+)$/.test(flag)) return null;
      }
      return args;
    } catch { return null; }
  }
  if (!['node', 'pwsh'].includes(executable)) return null;
  const script = executable === 'node' ? args[0] : args[args.indexOf('-File') + 1];
  if (!script || (executable === 'pwsh' && (!args.includes('-NoProfile') || !args.includes('-File')))) return null;
  const path = resolve(options?.cwd ?? process.cwd(), script);
  if (!local(path) && !state.scripts.has(path)) return null;
  try { return state.scripts.has(createHash('sha256').update(readFileSync(path)).digest('hex')) ? args : null; }
  catch { return null; }
}
