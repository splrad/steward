import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { verifyDownloadedFileBuild, verifyDownloadedOciBuild } from '../src/build-manifest.js';
import { releaseBuildCommand } from '../src/release-build-command.js';
import { nativeReleaseInspector } from '../src/release-native.js';
import { makeReleaseBuildRequest } from '../../core/src/release-build-request.js';
import { frozenFixture } from '../../core/test/release-receipt-fixture.js';
import { planBuild, type BuildPlan } from '../../core/src/build-manifest.js';
import { buildReleaseAssets, executeBuildCommand, isolatedBuildEnvironment, releaseBuildCommands } from '../src/release-build.js';

let root: string, source: string, output: string, plan: BuildPlan;
const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', source, ...args], { encoding: 'utf8' })).stdout.trim();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'release-executor-')); source = join(root, 'source'); output = join(root, 'output');
  await mkdir(source); await mkdir(output); await mkdir(join(source, 'tools'));
  await writeFile(join(source, 'VERSION'), '1.2.3\n'); await writeFile(join(source, 'tools/build.mjs'), '// fixture\n');
  await git('init'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test');
  await git('add', '.'); await git('commit', '-m', 'fixture');
  plan = await planBuild({ repositoryId: 9001, fullName: 'sample/product', buildId: 'release', profile: 'custom-adapter-v1', targetSha: await git('rev-parse', 'HEAD'), policySha: 'c'.repeat(40), version: '1.2.3' },
    { profile: 'custom-adapter-v1', inputs: { entrypoint: 'tools/build.mjs', runtime: 'node', runnerFamily: 'linux' }, outputs: [{ id: 'asset', kind: 'file', match: 'package.json', count: 1, mediaType: 'application/json' }] });
});
afterEach(async () => { if (resolve(root).startsWith(join(resolve(tmpdir()), 'release-executor-'))) await rm(root, { recursive: true, force: true }); });
it('builds an exact clean source and centrally hashes the actual output', async () => {
  const manifest = await buildReleaseAssets(plan, { sourceDirectory: source, outputDirectory: output, buildRunId: '1' }, async command => {
    expect(command.executable).toBe('node'); expect(command.args).toContain(output);
    await writeFile(join(output, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  }, async bytes => JSON.parse(Buffer.from(bytes).toString()).version);
  expect(manifest.targetSha).toBe(plan.targetSha); expect(manifest.artifacts[0]).toMatchObject({ file: 'package.json', kind: 'file', size: 19 });
});
it('refuses dirty sources before executing product code', async () => {
  await writeFile(join(source, 'VERSION'), '1.2.4\n'); let called = false;
  await expect(buildReleaseAssets(plan, { sourceDirectory: source, outputDirectory: output, buildRunId: '1' }, async () => { called = true; })).rejects.toThrow('BUILD_SOURCE_DIRTY');
  expect(called).toBe(false);
});
it('builds a committed VERSION containing permitted comments and blank lines', async () => {
  await writeFile(join(source, 'VERSION'), '# Public version\n\n1.2.3\n\n');
  await git('add', 'VERSION'); await git('commit', '-m', 'version format');
  plan={...plan,targetSha:await git('rev-parse','HEAD')};
  // Recompute the plan identity from the new immutable source.
  plan=await planBuild(plan,{profile:plan.profile,inputs:plan.inputs,outputs:plan.outputs});
  const manifest=await buildReleaseAssets(plan,{sourceDirectory:source,outputDirectory:output,buildRunId:'1'},async()=>{
    await writeFile(join(output,'package.json'),JSON.stringify({version:'1.2.3'}));
  },async bytes=>JSON.parse(Buffer.from(bytes).toString()).version);
  expect(manifest.version).toBe('1.2.3');
});
it.each(['tracked', 'untracked', 'commit'])('rejects %s source changes made by the build before collecting assets', async kind => {
  let inspected = false;
  await expect(buildReleaseAssets(plan, { sourceDirectory: source, outputDirectory: output, buildRunId: '1' }, async () => {
    if (kind === 'untracked') await writeFile(join(source, 'unexpected.txt'), 'new input');
    else {
      await writeFile(join(source, 'VERSION'), '1.2.4\n');
      if (kind === 'commit') { await git('add', 'VERSION'); await git('commit', '-m', 'changed source'); }
    }
    await writeFile(join(output, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  }, async () => { inspected = true; return '1.2.3'; })).rejects.toThrow('BUILD_SOURCE_CHANGED');
  expect(inspected).toBe(false);
});
it('rejects output extras and missing native version evidence', async () => {
  await expect(buildReleaseAssets(plan, { sourceDirectory: source, outputDirectory: output, buildRunId: '1' }, async () => {
    await writeFile(join(output, 'package.json'), '{}');
  })).rejects.toThrow('RN_BUILD_VERSION');
});
it('keeps command arguments separate and drops all credentials', () => {
  const command = releaseBuildCommands(plan, { sourceDirectory: source, outputDirectory: output, buildRunId: '1' })[0]!;
  expect(command.args[0]).toBe(join(source, 'tools/build.mjs'));
  const env = isolatedBuildEnvironment({ PATH: '/tools', GITHUB_TOKEN: 'secret', STEWARD_APP_PRIVATE_KEY: 'secret', COPILOT_GITHUB_TOKEN: 'secret', NODE_OPTIONS: 'evil' }, output);
  expect(Object.values(env)).not.toContain('secret'); expect(env.NODE_OPTIONS).toBeUndefined();
});
it('executes a neutral Node product from a clean checkout and binds its actual bytes to that repository', async () => {
  await writeFile(join(source, 'tools/build.mjs'), `import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
if(process.env.GITHUB_TOKEN||process.env.STEWARD_APP_PRIVATE_KEY||process.env.COPILOT_GITHUB_TOKEN)throw new Error('credential leak');
await writeFile(join(args['--output-directory'],'package.json'),JSON.stringify({name:'neutral-tool',version:args['--version']}));
`);
  await git('add', 'tools/build.mjs'); await git('commit', '-m', 'neutral fixture build');
  const actualPlan = await planBuild({ ...plan, targetSha: await git('rev-parse', 'HEAD') }, { profile: plan.profile, inputs: plan.inputs, outputs: plan.outputs });
  const home = join(root, 'home'); await mkdir(home);
  const env = isolatedBuildEnvironment({ ...process.env, GITHUB_TOKEN: 'fixture-secret', STEWARD_APP_PRIVATE_KEY: 'fixture-secret' }, home);
  const manifest = await buildReleaseAssets(actualPlan, { sourceDirectory: source, outputDirectory: output, buildRunId: 'neutral-1' }, c => executeBuildCommand(c, env),
    async bytes => JSON.parse(Buffer.from(bytes).toString()).version);
  expect(manifest.repositoryId).toBe(9001); expect(manifest.fullName).toBe('sample/product');
  expect(manifest.targetSha).toBe(actualPlan.targetSha); expect(manifest.artifacts[0]).toMatchObject({ file: 'package.json', size: 41 });
  expect(JSON.stringify(manifest)).not.toMatch(/LayerScape|AFR/);
  if (process.platform === 'win32') {
    const unit = { profile: plan.profile, inputs: { ...plan.inputs, runnerFamily: 'windows' }, outputs: plan.outputs };
    const cliPlan = await planBuild({ ...actualPlan }, unit);
    const bundle = join(root, 'node.bundle'), request = join(root, 'node-plan.json');
    await git('bundle', 'create', bundle, 'HEAD'); await writeFile(request, JSON.stringify(cliPlan));
    const locations = (await promisify(execFile)('where.exe', ['pwsh'], { encoding: 'utf8' })).stdout.trim().split(/\r?\n/).map(p => dirname(p).toLowerCase());
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = originalPath!.split(delimiter).filter(p => !locations.includes(resolve(p).toLowerCase())).join(delimiter);
      await expect(promisify(execFile)('pwsh', ['--version'])).rejects.toThrow();
      await expect(releaseBuildCommand({ operation: 'execute-product', 'policy-sha': cliPlan.policySha, request, 'source-bundle': bundle,
        workspace: join(root, 'fresh-node'), assets: join(root, 'node-assets'), inspector: 'unused.ps1', output: join(root, 'node-manifest.json'), 'run-id': 'node-cli' })).resolves.toBeUndefined();
    } finally { process.env.PATH = originalPath; }
  }
});

it.runIf(process.platform === 'linux')('runs the Node package adapter using npm ci and the registered product task', async () => {
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'neutral-package', version: '1.2.3', scripts: { build: 'node tools/package.mjs' } }));
  await writeFile(join(source, 'package-lock.json'), JSON.stringify({ name: 'neutral-package', version: '1.2.3', lockfileVersion: 3, packages: { '': { name: 'neutral-package', version: '1.2.3' } } }));
  await writeFile(join(source, 'tools/package.mjs'), `import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
if(process.env.GITHUB_TOKEN||process.env.STEWARD_APP_PRIVATE_KEY)throw Error('credentials');
await writeFile(join(process.argv[3],'package.json'),await readFile('package.json'));`);
  await git('add', '.'); await git('commit', '-m', 'node package fixture');
  const unit = { profile: 'node-package-v1' as const, inputs: { directory: '.', lockfile: 'package-lock.json', buildTask: 'build', packageManager: 'npm' }, outputs: plan.outputs };
  const actual = await planBuild({ ...plan, profile: unit.profile, targetSha: await git('rev-parse', 'HEAD') }, unit);
  const f = frozenFixture(); f.repositoryId = actual.repositoryId; f.fullName = actual.fullName; f.productTargetSha = actual.targetSha;
  const request = await makeReleaseBuildRequest(f, { builds: { release: unit }, delivery: { githubRelease: { builds: ['release'] } } }, 'initial', null);
  expect(request.plans[0]!.runnerFamily).toBe('linux');
  for (const match of ['dist/package.json', '**/*.json', '**']) {
    const nested = { ...unit, outputs: [{ id: 'asset', kind: 'file' as const, match, count: 1, mediaType: 'application/json' }] };
    await expect(makeReleaseBuildRequest(f, { builds: { release: nested }, delivery: { githubRelease: { builds: ['release'] } } }, 'initial', null)).rejects.toThrow('BUILD_RELEASE_PATH');
  }
  const budgets: number[] = [];
  const manifest = await buildReleaseAssets(actual, { sourceDirectory: source, outputDirectory: output, buildRunId: 'node-package' }, c => {
    budgets.push(c.timeoutMs!); return executeBuildCommand(c, isolatedBuildEnvironment(process.env, root));
  }, nativeReleaseInspector('unused', root));
  expect(budgets).toHaveLength(2);
  expect(budgets[0]).toBeLessThanOrEqual(45 * 60_000);
  expect(budgets[1]).toBeLessThan(budgets[0]!);
  expect(manifest.profile).toBe('node-package-v1'); expect(manifest.repositoryId).toBe(9001);
  expect(manifest.artifacts[0]).toMatchObject({ file: 'package.json' });
});
it.runIf(process.platform === 'win32')('publishes a neutral .NET library and independently checks its native version', async () => {
  await writeFile(join(source, '.gitignore'), 'obj/\nbin/\n');
  await writeFile(join(source, 'Neutral.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Version>1.2.3</Version><GenerateDependencyFile>false</GenerateDependencyFile><DebugType>none</DebugType><SelfContained>false</SelfContained></PropertyGroup></Project>');
  await writeFile(join(source, 'Neutral.cs'), 'public class Neutral { public static string Value => "neutral"; }');
  await git('add', '.'); await git('commit', '-m', 'dotnet fixture');
  const unit = { profile: 'dotnet-assets-v1' as const, inputs: { project: 'Neutral.csproj', configuration: 'Release', framework: 'net10.0', runtime: 'win-x64' }, outputs: [{ id: 'library', kind: 'file' as const, match: 'Neutral.dll', count: 1, mediaType: 'application/octet-stream' }] };
  const actual = await planBuild({ ...plan, repositoryId: 9002, fullName: 'sample/dotnet-product', profile: unit.profile, targetSha: await git('rev-parse', 'HEAD') }, unit);
  const f = frozenFixture(); f.repositoryId = actual.repositoryId; f.fullName = actual.fullName; f.productTargetSha = actual.targetSha;
  expect((await makeReleaseBuildRequest(f, { builds: { release: unit }, delivery: { githubRelease: { builds: ['release'] } } }, 'initial', null)).plans[0]!.runnerFamily).toBe('windows');
  const manifest = await buildReleaseAssets(actual, { sourceDirectory: source, outputDirectory: output, buildRunId: 'dotnet' }, c => executeBuildCommand(c, isolatedBuildEnvironment(process.env, root)), nativeReleaseInspector(resolve('scripts/inspect-native-release.ps1'), root));
  await expect(verifyDownloadedFileBuild(actual, { ...manifest, repositoryId: 9001 }, output, nativeReleaseInspector(resolve('scripts/inspect-native-release.ps1'), root))).rejects.toThrow('DIGEST');
  expect(manifest.repositoryId).toBe(9002); expect(manifest.artifacts[0]).toMatchObject({ file: 'Neutral.dll' });
  const bundle = join(root, 'source.bundle'), request = join(root, 'plan.json');
  await git('bundle', 'create', bundle, 'HEAD'); await writeFile(request, JSON.stringify(actual));
  await expect(releaseBuildCommand({ operation: 'execute-product', 'policy-sha': actual.policySha, request, 'source-bundle': bundle, workspace: join(root, 'fresh-source'), assets: join(root, 'fresh-assets'), inspector: resolve('scripts/inspect-native-release.ps1'), output: join(root, 'manifest.json'), 'run-id': 'local-product' })).resolves.toBeUndefined();
}, 120000);
it.runIf(process.env.STEWARD_TEST_OCI === '1')('builds a real OCI layout without pushing and binds all blobs to the image digest', async () => {
  if (process.env.STEWARD_TEST_BUILDX_PATH) {
    await mkdir(join(root, '.docker/cli-plugins'), { recursive: true });
    await copyFile(process.env.STEWARD_TEST_BUILDX_PATH, join(root, '.docker/cli-plugins/docker-buildx.exe'));
  }
  await writeFile(join(source, 'Dockerfile'), 'FROM scratch\nCOPY VERSION /VERSION\nLABEL org.opencontainers.image.version="1.2.3"\n');
  await git('add', '.'); await git('commit', '-m', 'oci fixture');
  const unit = { profile: 'oci-image-v1' as const, inputs: { context: '.', dockerfile: 'Dockerfile', platforms: ['linux/amd64'] }, outputs: [{ id: 'image', kind: 'oci-image' as const, count: 1 }] };
  const actual = await planBuild({ ...plan, repositoryId: 9003, fullName: 'sample/oci-product', profile: unit.profile, targetSha: await git('rev-parse', 'HEAD') }, unit);
  const manifest = await buildReleaseAssets(actual, { sourceDirectory: source, outputDirectory: output, buildRunId: 'oci' }, c => executeBuildCommand(c, isolatedBuildEnvironment(process.env, root)));
  await expect(verifyDownloadedOciBuild(actual, { ...manifest, repositoryId: 9001 }, output)).rejects.toThrow('DIGEST');
  expect(manifest.repositoryId).toBe(9003); expect(manifest.artifacts[0]).toMatchObject({ kind: 'oci-image', reference: expect.stringContaining('sample/oci-product@sha256:') });
}, 120000);
