import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalBuildManifest, planBuild, type BuildManifest, type BuildPlan } from '../../core/src/build-manifest.js';
import { canonicalReleaseJson, receiptDigest, releaseAssert } from '../../core/src/release-note-receipt.js';
import { parseVersionFile } from '../../core/src/release-version.js';
import { collectFileBuildManifest, collectOciBuildManifest, validateBuildInputs, type BuildExecutionContext, type NativeVersionInspector } from './build-manifest.js';

export interface BuildCommand { executable: string; args: string[]; cwd: string; timeoutMs?: number }
export function releaseBuildCommands(plan: BuildPlan, context: BuildExecutionContext): BuildCommand[] {
  const source = context.sourceDirectory, output = context.outputDirectory, i = plan.inputs;
  switch (plan.profile) {
    case 'dotnet-assets-v1': return [{ executable: 'dotnet', args: ['publish', String(i.project), '--configuration', String(i.configuration), '--framework', String(i.framework), '--runtime', String(i.runtime), '--output', output, '-p:ContinuousIntegrationBuild=true'], cwd: source }];
    case 'node-package-v1': return [
      { executable: 'npm', args: ['ci'], cwd: join(source, String(i.directory)) },
      { executable: 'npm', args: ['run', String(i.buildTask), '--', '--output', output], cwd: join(source, String(i.directory)) },
    ];
    case 'oci-image-v1': return [{ executable: 'docker', args: ['buildx', 'build', '--file', join(source, String(i.dockerfile)), '--platform', (i.platforms as string[]).join(','), '--tag', `${plan.fullName.toLowerCase()}:${plan.outputs[0]!.id}`, '--provenance=false', '--sbom=false', '--output', `type=oci,dest=${output},tar=false`, join(source, String(i.context))], cwd: source }];
    case 'custom-adapter-v1': return [{ executable: String(i.runtime), args: [...(i.runtime === 'pwsh' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File'] : i.runtime === 'bash' ? ['--noprofile', '--norc'] : []), join(source, String(i.entrypoint)), i.runtime === 'pwsh' ? '-OutputDirectory' : '--output-directory', output, i.runtime === 'pwsh' ? '-Version' : '--version', plan.version ?? ''], cwd: source }];
  }
}
export function isolatedBuildEnvironment(system: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, CI: 'true', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'empty-gitconfig') };
  for (const key of ['PATH', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'DOTNET_ROOT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) if (system[key]) result[key] = system[key];
  return result;
}
export async function executeBuildCommand(command: BuildCommand, environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd: command.cwd, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0;
    const consume = (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) child.kill(); };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    const timer = setTimeout(() => child.kill(), command.timeoutMs ?? 45 * 60_000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('RN_BUILD_PROCESS')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && size <= 8 * 1024 * 1024 ? resolve() : reject(new Error('RN_BUILD_PROCESS')); });
  });
}
/** The executor must run in a credential-free build job; collectors remain centrally controlled. */
export async function buildReleaseAssets(plan: BuildPlan, context: BuildExecutionContext, execute: (command: BuildCommand) => Promise<void>, inspect?: NativeVersionInspector): Promise<BuildManifest> {
  const expected = await planBuild(plan, { profile: plan.profile, inputs: plan.inputs, outputs: plan.outputs });
  releaseAssert(canonicalReleaseJson(expected) === canonicalReleaseJson(plan), 'BUILD_PLAN');
  releaseAssert(plan.profile !== 'oci-image-v1' || plan.outputs.length === 1, 'BUILD_OCI_OUTPUT');
  if (plan.profile !== 'oci-image-v1') for (const rule of plan.outputs) assertReleaseAssetName(rule.match!.replaceAll('{version}', plan.version ?? ''), true);
  await validateBuildInputs(plan, context);
  const git = async (args: string[]) => (await promisify(execFile)('git', ['--no-optional-locks', '-C', context.sourceDirectory, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...isolatedBuildEnvironment(process.env, context.outputDirectory), GIT_NO_LAZY_FETCH: '1' } })).stdout.trim();
  releaseAssert(await git(['rev-parse', 'HEAD']) === plan.targetSha && await git(['status', '--porcelain', '--untracked-files=all']) === ''
    && await git(['ls-files', '--others', '--ignored', '--exclude-standard']) === '', 'BUILD_SOURCE_DIRTY');
  releaseAssert((await readdir(context.outputDirectory)).length === 0, 'BUILD_OUTPUT_OCCUPIED');
  if (plan.version !== null) releaseAssert(parseVersionFile(await readFile(join(context.sourceDirectory, 'VERSION'))).value === plan.version, 'BUILD_VERSION');
  const deadline = performance.now() + plan.timeoutMinutes * 60_000;
  for (const command of releaseBuildCommands(plan, context)) {
    const timeoutMs = Math.ceil(deadline - performance.now());
    releaseAssert(timeoutMs > 0, 'BUILD_TIMEOUT');
    await execute({ ...command, timeoutMs });
  }
  // Build caches (node_modules, obj/bin) may be ignored outputs, but the frozen
  // commit and non-ignored source tree must still be intact before collection.
  releaseAssert(await git(['rev-parse', 'HEAD']) === plan.targetSha
    && await git(['status', '--porcelain', '--untracked-files=all']) === '', 'BUILD_SOURCE_CHANGED');
  const manifest = plan.profile === 'oci-image-v1' ? await collectOciBuildManifest(plan, context.outputDirectory) : await collectFileBuildManifest(plan, context.outputDirectory, inspect);
  for (const artifact of manifest.artifacts) if (artifact.kind === 'file') assertReleaseAssetName(artifact.file);
  canonicalBuildManifest(manifest); return manifest;
}
export function buildToolchainDigest(versions: Record<string, string>): string {
  releaseAssert(Object.keys(versions).length > 0 && Object.entries(versions).every(([k, v]) => /^[a-z][a-z0-9-]*$/.test(k) && typeof v === 'string' && v.length > 0 && v.length < 200), 'BUILD_TOOLCHAIN');
  return receiptDigest(canonicalReleaseJson(versions));
}
import { assertReleaseAssetName } from '../../core/src/release-asset-name.js';
