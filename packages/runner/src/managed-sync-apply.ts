import { createHash } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { localGitSnapshot, safeManagedPath, gitBlob } from './managed-sync-preview.js';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(reason: string): never { throw new Error(`MANAGED_APPLY: ${reason}`); }
async function regular(root: string, path: string, allowAbsent: boolean) {
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) fail('unsafe root');
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    try { const item = await lstat(cursor); if (item.isSymbolicLink()) fail('symlink'); }
    catch (error: any) { if (allowAbsent && error.code === 'ENOENT') continue; throw error; }
  }
}
/** Install only a fully checked local preview. create-pull-request owns all Git writes. */
export async function applyManagedPreview(previewDirectory: string, targetDirectory: string, repositoryId: number, policySha: string) {
  const preview = resolve(previewDirectory), target = resolve(targetDirectory);
  await regular(preview, 'preview.json', false);
  await regular(target, '', false);
  const report = JSON.parse(await readFile(join(preview, 'preview.json'), 'utf8'));
  if (report.schemaVersion !== 1 || report.repositoryId !== repositoryId || report.policySha !== policySha || report.remoteWrites !== 0 || !Array.isArray(report.files)
    || !/^[a-f0-9]{40}$/.test(policySha) || await localGitSnapshot.head(target) !== report.expectedBaseSha) fail('preview identity');
  const seen = new Set<string>(), checked: { path: string; bytes: Buffer }[] = [];
  for (const file of report.files) {
    safeManagedPath(file.path);
    if (seen.has(file.path.toLowerCase())) fail('duplicate path'); seen.add(file.path.toLowerCase());
    await regular(join(preview, 'files'), file.path, false); await regular(target, file.path, true);
    const bytes = await readFile(join(preview, 'files', file.path));
    if (hash(bytes) !== file.afterSha256 || gitBlob(bytes) !== file.afterBlob) fail('preview bytes changed');
    let current: Buffer | null = null;
    try { current = await readFile(join(target, file.path)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const committed = await localGitSnapshot.file(target, report.expectedBaseSha, file.path);
    if ((current ? hash(current) : null) !== file.beforeSha256 || (current ? gitBlob(current) : null) !== file.beforeBlob || (committed ? gitBlob(committed) : null) !== file.beforeBlob) fail('target bytes changed');
    checked.push({ path: file.path, bytes });
  }
  for (const file of checked) { const destination = join(target, file.path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, file.bytes); }
  return checked.map(file => file.path);
}
