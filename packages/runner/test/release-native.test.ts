import { registerOfflineFixtureRoot, permitOfflineScript } from './offline-fixtures.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, copyFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nativeInspectionTimeoutMs, nativeReleaseInspector } from '../src/release-native.js';
import { collectFileBuildManifest } from '../src/build-manifest.js';
import { BuildContractError, type BuildArtifactInput } from '../../core/src/build-manifest.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';

it('rejects unsupported Linux native formats before starting any PowerShell process', async () => {
  const inspector = nativeReleaseInspector('does-not-exist.ps1', 'unused', 'linux');
  await expect(inspector.inspectPath!('artifact.zip')).rejects.toThrow('NATIVE_FORMAT_UNSUPPORTED');
  await expect(inspector.inspectPath!('artifact.dll')).rejects.toThrow('NATIVE_FORMAT_UNSUPPORTED');
});

describe.skipIf(process.platform !== 'win32')('native Windows versions and bounded archive inspection', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'native-release-test-')); registerOfflineFixtureRoot(root); permitOfflineScript(resolve('scripts/inspect-native-release.ps1'));
    for (const file of ['fixture.dll', 'fixture-0.dll', 'fixture-4.dll']) {
      await copyFile(resolve('packages/runner/test/fixtures/native-release', file), join(root, file));
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
    permitOfflineScript(join(root, 'fixture.ps1'));
    await promisify(execFile)('pwsh', ['-NoProfile', '-File', join(root, 'fixture.ps1'), root], { env: isolatedBuildEnvironment(process.env, root), timeout: 30000, windowsHide: true });
  }, 30_000 + 30_000); // Bounded archive creation and a 30-second copy/completion margin.
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
    const input: BuildArtifactInput = { repositoryId: 9001, fullName: 'sample/product', buildId: 'release', kind: 'file',
      sourceSha: 'a'.repeat(40), controllerSha: 'b'.repeat(40), version: '1.2.3', packageVersion: '1.2.3', inputsSha256: 'c'.repeat(64),
      platforms: [], outputs: [{ id: 'app', kind: 'file', match: 'app.dll', count: 1, mediaType: 'application/x-msdownload' }] };
    expect((await collectFileBuildManifest(input, output, inspect())).artifacts[0]).toMatchObject({ size: 33 * 1024 * 1024 });
    await expect(collectFileBuildManifest({ ...input, version: '1.2.4', packageVersion: '1.2.4' }, output, inspect())).rejects.toThrow('RN_BUILD_VERSION');
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
it('bounds package metadata even when the opened file grows after its size check', async () => {
 const root = await mkdtemp(join(tmpdir(), 'native-growing-metadata-'));
 const path = join(root, 'package.json');
 try {
  await writeFile(path, '{"name":"pkg","version":"1.2.3"}');
  const probe = await open(path), prototype = Object.getPrototypeOf(probe), stat = prototype.stat;
  await probe.close();
  vi.spyOn(prototype, 'stat').mockImplementationOnce(async function(this: Awaited<ReturnType<typeof open>>) {
   const before = await stat.call(this);
   await writeFile(path, JSON.stringify({name:'pkg',version:'1.2.3',padding:'x'.repeat(512*1024)}));
   return before;
  });
  await expect(nativeReleaseInspector('unused',root).inspectPath!(path)).rejects.toThrow('RN_BUILD_LIMIT');
 } finally { vi.restoreAllMocks(); await rm(root,{recursive:true}); }
});
it.skipIf(process.platform !== 'win32')('classifies successful malformed output without treating an unknown process failure as deterministic', async () => {
 const root = await mkdtemp(join(tmpdir(), 'native-process-'));
 registerOfflineFixtureRoot(root);
 try {
  const script = join(root,'inspect.ps1'); await writeFile(script, 'Write-Output "not-json"');
  permitOfflineScript(script);
  await expect(nativeReleaseInspector(script, root).inspectPath!('fixture.zip')).rejects.toBeInstanceOf(BuildContractError);
  await writeFile(script, 'Write-Error "infrastructure"; exit 3');
  permitOfflineScript(script);
  const error = await nativeReleaseInspector(script, root).inspectPath!('fixture.zip').catch(e => e);
  expect(error).not.toBeInstanceOf(BuildContractError); expect(error.code).toBe(3);
 } finally { await rm(root, {recursive:true}); }
}, 2 * nativeInspectionTimeoutMs + 30_000); // Both bounded inspections plus a 30-second cleanup margin.
