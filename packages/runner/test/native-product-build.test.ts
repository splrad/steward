import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { buildNativeProduct, executeNativeProduct } from '../src/native-product-build.js';
import { nativeReleaseInspector } from '../src/release-native.js';
import { registerOfflineFixtureRoot, permitOfflineCommand, permitOfflineScript } from './offline-fixtures.js';
import type { AdmittedUnit } from '../src/release-admission.js';
it.skipIf(process.platform !== 'win32')('builds a clean native source with isolated credentials and independently reads the PE version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-product-')); registerOfflineFixtureRoot(root);
  const source = join(root, 'source'); await mkdir(source);
  const run = promisify(execFile), git = async (...args: string[]) => (await run('git', ['-C', source, ...args], { encoding: 'utf8' })).stdout.trim();
  try {
    permitOfflineCommand('dotnet', ['--version']);
    permitOfflineCommand('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    const sdk = (await run('dotnet', ['--version'], { encoding: 'utf8' })).stdout.trim();
    await writeFile(join(source, 'global.json'), JSON.stringify({ sdk: { version: sdk, rollForward: 'disable', allowPrerelease: false } }));
    await writeFile(join(source, '.gitignore'), 'bin/\nobj/\n');
    await writeFile(join(source, 'Fixture.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Version>1.2.3</Version><FileVersion>1.2.3.0</FileVersion><InformationalVersion>1.2.3</InformationalVersion></PropertyGroup></Project>');
    await writeFile(join(source, 'Fixture.cs'), 'public class Fixture {}');
    const script = join(source, 'build.ps1');
    await writeFile(script, `param([string]$OutputDirectory,[string]$Version)
$ErrorActionPreference='Stop'
if($Version -cne '1.2.3') { throw 'Unexpected fixture version' }
if($env:GH_TOKEN -or $env:GITHUB_TOKEN -or $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN) { throw 'Leaked build credential' }
dotnet build Fixture.csproj --configuration Release
if($LASTEXITCODE -ne 0) { throw 'Fixture build failed' }
[IO.File]::Copy((Join-Path $PSScriptRoot 'bin/Release/net10.0/Fixture.dll'),(Join-Path $OutputDirectory 'fixture.dll'),$false)
`);
    permitOfflineScript(script); permitOfflineScript(resolve('scripts/inspect-native-release.ps1'));
    await git('init'); await git('config', 'user.name', 'Offline Fixture'); await git('config', 'user.email', 'fixture@example.invalid'); await git('add', '.'); await git('commit', '-m', 'offline native source');
    const sourceSha = await git('rev-parse', 'HEAD');
    const admitted: AdmittedUnit = { version: '1.2.3', packageVersion: '1.2.3', tag: 'v1.2.3', descriptorSha256: 'a'.repeat(64), templateSha256: 'b'.repeat(64), assets: [{ id: 'library', name: 'fixture.dll' }],
      unit: { id: 'fixture', displayName: 'Fixture', path: '.', releasePleasePath: '.', ecosystem: 'native', versionFile: 'VERSION', changelogPath: 'CHANGELOG.md', notesPath: '.release-notes/fixture.md', signingPolicy: 'none', channels: [], builds: [{ id: 'windows', os: 'windows', arch: 'x64', entrypoint: 'build.ps1', args: [], expectedArtifacts: ['library'] }], artifacts: [{ id: 'library', file: 'fixture.dll', kind: 'executable', mediaType: 'application/octet-stream', platform: 'windows', architecture: 'x64', build: 'windows', required: true }] } };
    const input = { admitted, sourceSha, buildId: 'windows', sourceDirectory: source, outputDirectory: join(root, 'assets'), home: join(root, 'home') };
    const report = await buildNativeProduct(input, async invocation => {
      expect(Object.keys(invocation.env).some(key => /TOKEN|SECRET|PRIVATE_KEY/.test(key))).toBe(false);
      await executeNativeProduct(invocation);
    });
    expect(report.artifacts[0]!.path).toBe('fixture.dll');
    expect(await nativeReleaseInspector(resolve('scripts/inspect-native-release.ps1'), input.home).inspectPath!(join(input.outputDirectory, 'fixture.dll'))).toBe('1.2.3');
    admitted.unit.builds[0]!.args = ['-Out', join(source, 'overwrite')];
    await expect(buildNativeProduct({ ...input, home: join(root, 'bad-home'), outputDirectory: join(root, 'bad-output') })).rejects.toThrow('PRODUCT_BUILD_ARGUMENTS');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
