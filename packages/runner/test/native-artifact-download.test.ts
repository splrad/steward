import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { permitOfflineScript, registerOfflineFixtureRoot } from './offline-fixtures.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const run = promisify(execFile);
it.each(['valid', 'digest', 'traversal', 'duplicate', 'link', 'extra', 'workflow-flat', 'workflow-nested'])('verifies actual ZIP bytes before extracting: %s', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-zip-')); roots.push(root); registerOfflineFixtureRoot(root);
  const creator = join(root, 'create.ps1'), archive = join(root, 'artifact.zip'), names = join(root, 'names.json'), output = join(root, 'out');
  const entries = kind === 'traversal' ? ['../app.exe'] : kind === 'duplicate' ? ['app.exe', 'app.exe'] : kind === 'extra' ? ['app.exe', 'extra.exe'] :
    kind === 'workflow-nested' ? ['dist/app.exe'] : ['app.exe'];
  await writeFile(join(root, 'entries.json'), JSON.stringify(entries));
  await writeFile(creator, `param([string]$Archive,[string]$Entries,[bool]$Link=$false)
$ErrorActionPreference='Stop'
$z=[IO.Compression.ZipFile]::Open($Archive,[IO.Compression.ZipArchiveMode]::Create)
try { foreach($name in (Get-Content -LiteralPath $Entries -Raw | ConvertFrom-Json)) {
  $e=$z.CreateEntry($name)
  if($Link) { $e.ExternalAttributes = -1610612736 }
  $s=$e.Open(); try { $s.Write([Text.Encoding]::UTF8.GetBytes('fixture bytes')) } finally { $s.Dispose() }
} } finally { $z.Dispose() }
`);
  permitOfflineScript(creator);
  // Link mode is supplied as an explicit script switch through a separate fixture.
  if (kind === 'link') { await writeFile(creator, (await readFile(creator, 'utf8')).replace('$Link=$false', '$Link=$true')); permitOfflineScript(creator); }
  await run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', creator, '-Archive', archive, '-Entries', join(root, 'entries.json')]);
  await writeFile(names, JSON.stringify(['app.exe']));
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  const extractor = resolve('scripts/expand-release-artifact.ps1'); permitOfflineScript(extractor);
  const invoke = () => run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', extractor, '-Archive', archive,
    '-ExpectedSha256', kind === 'digest' ? '0'.repeat(64) : digest, '-ExpectedNames', names, '-OutputDirectory', output,
    ...(kind.startsWith('workflow-')?['-DiscoverNames']:[])]);
  if (kind === 'valid'||kind==='workflow-flat') { await invoke(); expect(await readFile(join(output, 'app.exe'), 'utf8')).toBe('fixture bytes'); await expect(invoke()).rejects.toThrow(); }
  else {
    if(kind==='workflow-nested')await expect(invoke()).rejects.toMatchObject({stderr:expect.stringContaining('Unsafe file name')});
    else await expect(invoke()).rejects.toThrow();
    await expect(stat(output)).rejects.toThrow();
  }
}, 30_000);
import { vi } from 'vitest';
import { zip } from './fixtures/artifact-envelope.js';
import { downloadNativeArtifact, expandWorkflowArtifactArchive } from '../src/native-artifact-download.js';

it('verifies the original Action ZIP and only copies its original files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'action-archive-'));roots.push(root);registerOfflineFixtureRoot(root);
  permitOfflineScript(resolve('scripts/expand-release-artifact.ps1'));
  const archive=join(root,'download.zip'),bytes=zip(),digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
  await writeFile(archive,bytes);
  const input={fullName:'fixture/product',artifactId:19,digest,directory:join(root,'output'),policyDirectory:resolve('.'),home:join(root,'home')};
  await expect(expandWorkflowArtifactArchive({...input,digest:'sha256:'+'0'.repeat(64)},archive)).rejects.toThrow();
  await expect(stat(input.directory)).rejects.toThrow();
  await expandWorkflowArtifactArchive(input,archive);
  expect(await readFile(join(input.directory,'product.exe'),'utf8')).toBe('example');
  expect(await readFile(archive)).toEqual(bytes);
});

it('reuses the collect destination after a failed signed download and keeps credentials on the API host',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-archive-')); roots.push(root); registerOfflineFixtureRoot(root);
  permitOfflineScript(resolve('scripts/expand-release-artifact.ps1'));
  const bytes=zip(),digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
  const input={fullName:'fixture/product',artifactId:9,digest,names:['product.exe'],directory:join(root,'output'),policyDirectory:resolve('.'),home:join(root,'home')};
  const storage='https://storage.blob.core.windows.net/artifact';
  let status=503;
  vi.stubGlobal('fetch',async(url:string|URL, options:RequestInit)=>{
    if(String(url)===storage) {
      expect(options.headers).toBeUndefined(); expect(options.redirect).toBe('error');
      return status===200?new Response(bytes):new Response(null,{status});
    }
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer fixture');
    if(String(url).endsWith('/zip')) {
      expect(options.redirect).toBe('manual');
      return new Response(null,{status:302,headers:{location:storage}});
    }
    expect(String(url)).toBe('https://api.github.com/repos/fixture/product/actions/artifacts/9');
    return Response.json({id:9,expired:false,size_in_bytes:bytes.length,digest});
  });
  try {
    await expect(downloadNativeArtifact(input,'fixture')).rejects.toThrow('HTTP_503');
    await expect(stat(input.directory)).rejects.toThrow();
    status=200; await downloadNativeArtifact(input,'fixture');
    expect(await readFile(join(input.directory,'product.exe'),'utf8')).toBe('example');
    await expect(downloadNativeArtifact(input,'fixture')).rejects.toMatchObject({code:'EEXIST'});
  } finally {vi.unstubAllGlobals();}
});

it('rejects expired metadata before following a download URL', async () => {
  const bytes = zip(), digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const metadata = vi.fn(async () => Response.json({id: 9, expired: true, size_in_bytes: bytes.length, digest}));
  vi.stubGlobal('fetch', metadata);
  try {
    await expect(downloadNativeArtifact({fullName:'fixture/product',artifactId:9,digest,names:[],directory:'unused',
      policyDirectory:'.',home:'unused'},'fixture')).rejects.toThrow('ARTIFACT_DOWNLOAD_IDENTITY');
    expect(metadata).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
