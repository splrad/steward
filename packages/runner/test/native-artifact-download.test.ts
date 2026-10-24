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
it.each(['valid', 'digest', 'traversal', 'duplicate', 'link', 'extra'])('verifies actual ZIP bytes before extracting: %s', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-zip-')); roots.push(root); registerOfflineFixtureRoot(root);
  const creator = join(root, 'create.ps1'), archive = join(root, 'artifact.zip'), names = join(root, 'names.json'), output = join(root, 'out');
  const entries = kind === 'traversal' ? ['../app.exe'] : kind === 'duplicate' ? ['app.exe', 'app.exe'] : kind === 'extra' ? ['app.exe', 'extra.exe'] : ['app.exe'];
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
    '-ExpectedSha256', kind === 'digest' ? '0'.repeat(64) : digest, '-ExpectedNames', names, '-OutputDirectory', output]);
  if (kind === 'valid') { await invoke(); expect(await readFile(join(output, 'app.exe'), 'utf8')).toBe('fixture bytes'); await expect(invoke()).rejects.toThrow(); }
  else { await expect(invoke()).rejects.toThrow(); await expect(stat(output)).rejects.toThrow(); }
}, 30_000);
