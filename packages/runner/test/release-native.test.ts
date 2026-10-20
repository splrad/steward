import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, copyFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeReleaseInspector } from '../src/release-native.js';
import { collectFileBuildManifest } from '../src/build-manifest.js';
import { BuildContractError, planBuild } from '../../core/src/build-manifest.js';
import { isolatedBuildEnvironment } from '../src/release-build.js';

it('rejects unsupported Linux native formats before starting any PowerShell process', async () => {
  const inspector = nativeReleaseInspector('does-not-exist.ps1', 'unused', 'linux');
  await expect(inspector.inspectPath!('artifact.zip')).rejects.toThrow('NATIVE_FORMAT_UNSUPPORTED');
  await expect(inspector.inspectPath!('artifact.dll')).rejects.toThrow('NATIVE_FORMAT_UNSUPPORTED');
});

describe.skipIf(process.platform !== 'win32')('native Windows versions and bounded archive inspection', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'native-release-test-'));
    await writeFile(join(root, 'NativeFixture.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Version>1.2.3</Version><FileVersion>1.2.3.0</FileVersion><InformationalVersion>1.2.3+fixture</InformationalVersion></PropertyGroup></Project>');
    await writeFile(join(root, 'NativeFixture.cs'), 'public class NativeFixture {}');
    await promisify(execFile)('dotnet', ['build', join(root, 'NativeFixture.csproj'), '-o', join(root, 'compiled')], { env: isolatedBuildEnvironment(process.env, root), timeout: 60000, windowsHide: true });
    await copyFile(join(root, 'compiled/NativeFixture.dll'), join(root, 'fixture.dll'));
    for (const revision of [0, 4]) {
      const output = join(root, `compiled-${revision}`);
      await promisify(execFile)('dotnet', ['build', join(root, 'NativeFixture.csproj'), `-p:InformationalVersion=1.2.3.${revision}`, '-o', output], { env: isolatedBuildEnvironment(process.env, root), timeout: 60000, windowsHide: true });
      await copyFile(join(output, 'NativeFixture.dll'), join(root, `fixture-${revision}.dll`));
    }
    await writeFile(join(root, 'fixture.ps1'), `param($Root)
$ErrorActionPreference='Stop'
function Archive($Name,$Entry,$Bytes) {
 $zip=[IO.Compression.ZipFile]::Open((Join-Path $Root $Name),'Create')
 try { $stream=$zip.CreateEntry($Entry).Open(); try { $stream.Write($Bytes,0,$Bytes.Length) } finally { $stream.Dispose() } } finally { $zip.Dispose() }
}
Archive 'plugin.zip' 'plugin.dll' ([IO.File]::ReadAllBytes((Join-Path $Root 'fixture.dll')))
Archive 'fonts.zip' 'font.shx' ([Text.Encoding]::ASCII.GetBytes('AutoCAD-86 shapes 1.0'))
Archive 'invalid-font.zip' 'font.shx' ([Text.Encoding]::ASCII.GetBytes('not-a-font'))
Archive 'traversal.zip' '../plugin.dll' ([IO.File]::ReadAllBytes((Join-Path $Root 'fixture.dll')))
Archive 'script.zip' 'run.ps1' ([Text.Encoding]::ASCII.GetBytes('exit 0'))
`);
    await promisify(execFile)('pwsh', ['-NoProfile', '-File', join(root, 'fixture.ps1'), root], { env: isolatedBuildEnvironment(process.env, root), timeout: 30000, windowsHide: true });
  }, 90000);
  afterAll(async () => { if (root && resolve(root).startsWith(join(resolve(tmpdir()), 'native-release-test-'))) await rm(root, { recursive: true }); });
  const inspect = () => nativeReleaseInspector(resolve('scripts/inspect-native-release.ps1'), root);
  it('reads the public PE version and each DLL inside the archive', async () => {
    expect(await inspect().inspectPath!(join(root, 'fixture.dll'))).toBe('1.2.3');
    expect(await inspect().inspectPath!(join(root, 'plugin.zip'))).toBe('1.2.3');
    expect(await inspect().inspectPath!(join(root, 'fonts.zip'))).toEqual({ resourceOnly: 'font-archive' });
  }, 30000);
  it('accepts a zero product revision and rejects a nonzero revision', async () => {
    expect(await inspect().inspectPath!(join(root, 'fixture-0.dll'))).toBe('1.2.3');
    await expect(inspect().inspectPath!(join(root, 'fixture-4.dll'))).rejects.toBeInstanceOf(BuildContractError);
  }, 30000);
  it.each(['invalid-font.zip', 'traversal.zip', 'script.zip'])('rejects %s without executing archive contents', async file => {
    await expect(inspect().inspectPath!(join(root, file))).rejects.toBeInstanceOf(BuildContractError);
  }, 30000);
  it('streams large PE files and rejects a source/native version mismatch', async () => {
    const output = join(root, 'large'); await mkdir(output); const file = join(output, 'app.dll'); await copyFile(join(root, 'fixture.dll'), file);
    const handle = await open(file, 'r+'); try { await handle.truncate(33 * 1024 * 1024); } finally { await handle.close(); }
    const unit = { profile: 'custom-adapter-v1' as const, inputs: { runtime: 'pwsh', entrypoint: 'tools/build.ps1', runnerFamily: 'windows' }, outputs: [{ id: 'app', kind: 'file' as const, match: 'app.dll', count: 1, mediaType: 'application/x-msdownload' }] };
    const identity = { repositoryId: 9001, fullName: 'sample/product', buildId: 'release', profile: unit.profile, targetSha: 'a'.repeat(40), policySha: 'b'.repeat(40), version: '1.2.3' };
    expect((await collectFileBuildManifest(await planBuild(identity, unit), output, inspect())).artifacts[0]).toMatchObject({ size: 33 * 1024 * 1024 });
    await expect(collectFileBuildManifest(await planBuild({ ...identity, version: '1.2.4' }, unit), output, inspect())).rejects.toThrow('RN_BUILD_VERSION');
  }, 30000);
});
it('classifies invalid package metadata as deterministic but preserves missing-file errors', async () => {
 const root = await mkdtemp(join(tmpdir(), 'native-metadata-'));
 try {
  const path = join(root, 'package.json'), inspector = nativeReleaseInspector('unused', root);
  await writeFile(path, '{"name":"pkg"}'); await expect(inspector.inspectPath!(path)).rejects.toBeInstanceOf(BuildContractError);
  await writeFile(path, '{bad'); await expect(inspector.inspectPath!(path)).rejects.toBeInstanceOf(BuildContractError);
  await expect(inspector.inspectPath!(join(root,'missing','package.json'))).rejects.toMatchObject({code:'ENOENT'});
 } finally { await rm(root, {recursive:true}); }
});
it.skipIf(process.platform !== 'win32')('classifies successful malformed output without treating an unknown process failure as deterministic', async () => {
 const root = await mkdtemp(join(tmpdir(), 'native-process-'));
 try {
  const script = join(root,'inspect.ps1'); await writeFile(script, 'Write-Output "not-json"');
  await expect(nativeReleaseInspector(script, root).inspectPath!('fixture.zip')).rejects.toBeInstanceOf(BuildContractError);
  await writeFile(script, 'Write-Error "infrastructure"; exit 3');
  const error = await nativeReleaseInspector(script, root).inspectPath!('fixture.zip').catch(e => e);
  expect(error).not.toBeInstanceOf(BuildContractError); expect(error.code).toBe(3);
 } finally { await rm(root, {recursive:true}); }
});
