import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { artifactNames } from '../../core/src/release-descriptor.js';
import { isolatedBuildEnvironment } from './build-environment.js';
import type { AdmittedUnit } from './release-admission.js';
import { fileDigest } from './release-artifacts.js';

interface BuildInvocation { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export type ProductExecutor = (invocation: BuildInvocation) => Promise<void>;
export const executeNativeProduct: ProductExecutor = invocation => new Promise((accept, reject) => {
  const child = spawn(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300 * 60_000 });
  let bytes = 0, exceeded = false;
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { exceeded = true; child.kill(); } else process.stdout.write(chunk); });
  child.on('error', reject); child.on('close', (code, signal) => code === 0 && !exceeded ? accept() : reject(new Error(`PRODUCT_BUILD_FAILED: ${code ?? signal}`)));
});
export async function buildNativeProduct(input: { admitted: AdmittedUnit; buildId: string; sourceSha: string; sourceDirectory: string; outputDirectory: string; home: string },
  execute: ProductExecutor = executeNativeProduct) {
  const build = input.admitted.unit.builds.find(build => build.id === input.buildId);
  if (!build || build.os !== 'windows' || build.arch !== 'x64' || input.admitted.unit.ecosystem !== 'native' || !build.entrypoint.endsWith('.ps1')) throw new Error('PRODUCT_BUILD_ADAPTER');
  // The admitted adapter owns invocation parameters. PowerShell accepts parameter
  // abbreviations, so an arbitrary tail could override even a differently spelled flag.
  if (build.args.length) throw new Error('PRODUCT_BUILD_ARGUMENTS');
  const source = resolve(input.sourceDirectory), output = resolve(input.outputDirectory), home = resolve(input.home);
  for (const path of [output, home]) { const rel = relative(source, path); if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('PRODUCT_BUILD_OUTPUT_IN_SOURCE'); }
  await mkdir(home, { recursive: false }); await writeFile(join(home, 'empty-gitconfig'), '', { flag: 'wx' });
  const env = isolatedBuildEnvironment(process.env, home);
  const run = async (executable: string, args: string[]) => (await promisify(execFile)(executable, args, { cwd: source, env, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout.trim();
  const git = (args: string[]) => run('git', ['--no-replace-objects', '--no-optional-locks', ...args]);
  const clean = async (initial: boolean) => {
    if (await git(['rev-parse', 'HEAD']) !== input.sourceSha || await git(['status', '--porcelain', '--untracked-files=all']) !== ''
      || initial && await git(['ls-files', '--others', '--ignored', '--exclude-standard']) !== '') throw new Error('PRODUCT_BUILD_DIRTY_SOURCE');
  };
  await clean(true);
  const sdk = JSON.parse(await readFile(join(source, 'global.json'), 'utf8')).sdk;
  if (!sdk || sdk.rollForward !== 'disable' || sdk.allowPrerelease !== false || await run('dotnet', ['--version']) !== sdk.version) throw new Error('PRODUCT_BUILD_SDK');
  const powershell = await run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  if (!/^7\.\d+\.\d+$/.test(powershell)) throw new Error('PRODUCT_BUILD_POWERSHELL');
  await mkdir(output, { recursive: false });
  const entry = resolve(source, build.entrypoint);
  let cursor = source;
  for (const part of build.entrypoint.split('/')) { cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new Error('PRODUCT_BUILD_SYMLINK'); }
  await execute({ executable: 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', entry,
    '-OutputDirectory', output, '-Version', input.admitted.version, ...build.args], cwd: source, env });
  await clean(false);
  const names = artifactNames(input.admitted.unit, input.admitted.version, input.admitted.packageVersion);
  const expected = build.expectedArtifacts.map(id => names.get(id)!).sort();
  if (JSON.stringify((await readdir(output)).sort()) !== JSON.stringify(expected)) throw new Error('PRODUCT_BUILD_ASSET_SET');
  return { buildId: build.id, sourceSha: input.sourceSha, toolVersions: { dotnet: sdk.version, powershell },
    artifacts: await Promise.all(expected.map(name => fileDigest(output, name))) };
}
