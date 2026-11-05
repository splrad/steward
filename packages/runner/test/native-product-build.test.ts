import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { isolatedBuildEnvironment } from '../src/build-environment.js';
import { assertBuildDirectoriesSeparate } from '../src/build-manifest.js';
import { fileDigest } from '../src/release-artifacts.js';
import { nativeReleaseInspector } from '../src/release-native.js';
import { registerOfflineFixtureRoot, permitOfflineCommand, permitOfflineScript } from './offline-fixtures.js';
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
    await git('init'); await git('config', 'user.name', 'Offline Fixture'); await git('config', 'user.email', 'fixture@example.invalid'); await git('add', '.'); await git('commit', '--signoff', '-m', 'offline native source');
    const sourceSha = await git('rev-parse', 'HEAD');
    const output = join(root, 'assets'), home = join(root, 'home');
    assertBuildDirectoriesSeparate(source, output); await mkdir(output); await mkdir(home);
    const env = isolatedBuildEnvironment(process.env, home);
    expect(isolatedBuildEnvironment({ GH_TOKEN: 'fixture-credential-must-not-reach-build' }, home).GH_TOKEN).toBeUndefined();
    expect(Object.keys(env).some(key => /TOKEN|SECRET|PRIVATE_KEY/.test(key))).toBe(false);
    await run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-OutputDirectory', output, '-Version', '1.2.3'],
      { cwd: source, env, windowsHide: true, timeout: 90_000 }).catch(error => { throw new Error(String(error.stdout) + String(error.stderr)); });
    expect((await fileDigest(output, 'fixture.dll')).size).toBeGreaterThan(0);
    expect(await nativeReleaseInspector(resolve('scripts/inspect-native-release.ps1'), home).inspectPath!(join(output, 'fixture.dll'))).toBe('1.2.3');
    expect(await git('rev-parse', 'HEAD')).toBe(sourceSha);
    expect(await git('status', '--porcelain')).toBe('');
    expect(() => assertBuildDirectoriesSeparate(source, join(source, 'overwrite'))).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
