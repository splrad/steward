import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isolatedBuildEnvironment } from './build-environment.js';
import { localGitSnapshot } from './managed-sync-preview.js';
import type { PipelineRecord } from './release-pipeline.js';
import { resolvePolicyTool } from './workflow-tools.js';
export async function generateReleaseSbom(record: PipelineRecord, directory: string, sourceDirectory: string, policyDirectory: string, staging: string, home: string) {
  await mkdir(home, { recursive: false }); await writeFile(join(home, 'empty-gitconfig'), '', { flag: 'wx' });
  const env = { ...isolatedBuildEnvironment(process.env, home), SYFT_CHECK_FOR_APP_UPDATE: 'false' };
  const execute = (command: string, args: string[]) => promisify(execFile)(command, args, { env, cwd: policyDirectory, timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  await execute('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(policyDirectory, 'scripts/stage-release-sbom.ps1'), '-AssetsDirectory', directory, '-StagingDirectory', staging]);
  // Syft reads the exact committed restoration locks as build-input evidence.
  const paths = (await execute('git', ['--no-replace-objects', '-C', sourceDirectory, 'ls-tree', '-r', '--name-only', record.sourceSha])).stdout.split(/\r?\n/).filter(path => /(?:^|\/)packages\.lock\.json$/.test(path));
  if (!paths.length) throw new Error('SBOM_MISSING_RESTORE_LOCKS');
  const locks: { path: string; sha256: string }[] = [];
  for (const path of paths) {
    const bytes = await localGitSnapshot.file(sourceDirectory, record.sourceSha, path); if (!bytes) throw new Error('SBOM_LOCK_DISAPPEARED');
    const target = join(staging, 'build-inputs', path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' });
    locks.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const output = join(directory, 'sbom.spdx.json');
  await execute(await resolvePolicyTool('syft'), ['dir:' + staging, '-o', 'spdx-json=' + output]);
  const sbom = JSON.parse(await readFile(output, 'utf8'));
  if (sbom.spdxVersion !== 'SPDX-2.3' || !Array.isArray(sbom.packages) || !sbom.packages.length) throw new Error('SBOM_INCOMPLETE_SCAN');
  sbom.annotations ??= [];
  const timestamp = sbom.creationInfo?.created;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw new Error('SBOM_CREATION_TIME');
  sbom.annotations.push({ annotationDate: timestamp, annotationType: 'OTHER', annotator: 'Tool: splrad-steward', comment: JSON.stringify({
    scope: 'Extracted delivery bytes and separately identified committed build inputs; build-input presence does not imply redistribution.', sourceSha: record.sourceSha, restoreLocks: locks,
  }) });
  const walk = async (root: string): Promise<string[]> => {
    const files: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name); if (entry.isSymbolicLink()) throw new Error('SBOM_STAGING_LINK');
      if (entry.isDirectory()) files.push(...await walk(path)); else if (entry.isFile()) files.push(path); else throw new Error('SBOM_STAGING_TYPE');
    }
    return files;
  };
  sbom.files ??= [];
  const existing = new Map(sbom.files.map((file: any) => [file.fileName, file]));
  for (const file of await walk(staging)) {
    if (!/\.(?:shx|ttf|otf)$/i.test(file)) continue;
    const name = './' + relative(staging, file).replaceAll('\\', '/');
    const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
    const font = { SPDXID: 'SPDXRef-Font-' + createHash('sha256').update(name).digest('hex'), fileName: name, fileTypes: ['BINARY'],
      checksums: [{ algorithm: 'SHA256', checksumValue: sha256 }], licenseConcluded: 'NOASSERTION', licenseInfoInFiles: ['NOASSERTION'], copyrightText: 'NOASSERTION',
      comment: 'Distributed font resource from the product archive. Source statement: docs/autodesk-fonts.md. Individual copyright and redistribution terms require the original rights holder evidence; no license inferred from the filename.' };
    const scanned: any = existing.get(name);
    if (scanned) {
      if (scanned.checksums?.some((check: any) => check.algorithm === 'SHA256' && check.checksumValue !== sha256)) throw new Error('SBOM_FONT_DIGEST');
      scanned.checksums ??= []; if (!scanned.checksums.some((check: any) => check.algorithm === 'SHA256')) scanned.checksums.push(font.checksums[0]);
      scanned.comment = [scanned.comment, font.comment].filter(Boolean).join('\n');
    } else sbom.files.push(font);
  }
  await writeFile(output, JSON.stringify(sbom, null, 2) + '\n');
  return { packages: sbom.packages.length, files: sbom.files.length, restoreLocks: locks };
}
