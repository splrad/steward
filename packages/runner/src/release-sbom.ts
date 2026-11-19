import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectBuildFile, type NativeVersionInspector } from './build-manifest.js';
import type { DeliveryUnit } from '../../core/src/delivery-config.js';
import type { ProductReleaseManifest } from './release-artifacts.js';
import { inspectDeclaredAsset } from './release-native.js';
import { isolatedBuildEnvironment } from './build-environment.js';
import { localGitSnapshot } from './git-snapshot.js';
import { resolvePolicyTool } from './workflow-tools.js';
export async function generateReleaseSbom(record: ProductReleaseManifest, unit: DeliveryUnit, directory: string, sourceDirectory: string, policyDirectory: string, staging: string, home: string) {
  await mkdir(home, { recursive: false }); await writeFile(join(home, 'empty-gitconfig'), '', { flag: 'wx' });
  const env = { ...isolatedBuildEnvironment(process.env, home), SYFT_CHECK_FOR_APP_UPDATE: 'false' };
  const execute = (command: string, args: string[]) => promisify(execFile)(command, args, { env, cwd: policyDirectory, timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (!unit.buildLocks || unit.id !== record.unitId) throw new Error('SBOM_MISSING_RESTORE_LOCKS');
  await mkdir(staging);
  const rights = new Map<string, { path: string; sha256: string }>();
  for (const artifact of record.artifacts) {
    const asset = unit.assets.find(item => item.id === artifact.id);
    if (!asset) throw new Error('SBOM_UNDECLARED_ASSET');
    const stage: NativeVersionInspector = Object.assign(async () => { throw new Error('PATH_INSPECTOR_REQUIRED'); }, {
      inspectPath: (file: string) => inspectDeclaredAsset(file, asset, record.packageVersion, policyDirectory, home, join(staging, artifact.path)),
    });
    const checked = await inspectBuildFile(directory, artifact.path, stage, 2 ** 31 - 1);
    if (checked.sha256 !== artifact.sha256 || checked.size !== artifact.size) throw new Error('SBOM_ASSET_DIGEST');
    if (asset.rightsSource) {
      const bytes = await localGitSnapshot.file(sourceDirectory, record.sourceSha, asset.rightsSource);
      if (!bytes?.length) throw new Error('SBOM_MISSING_RIGHTS_SOURCE');
      rights.set(artifact.path, { path: asset.rightsSource, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  const locks: { path: string; sha256: string }[] = [];
  for (const path of unit.buildLocks) {
    const bytes = await localGitSnapshot.file(sourceDirectory, record.sourceSha, path); if (!bytes?.length) throw new Error('SBOM_LOCK_DISAPPEARED');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== record.toolLocks['source/' + path]) throw new Error('SBOM_LOCK_DIGEST');
    const target = join(staging, 'build-inputs', path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' });
    locks.push({ path, sha256 });
  }
  const output = join(directory, 'sbom.spdx.json');
  await execute(await resolvePolicyTool('syft', policyDirectory), ['dir:' + staging, '-o', 'spdx-json=' + output]);
  const sbom = JSON.parse(await readFile(output, 'utf8'));
  if (sbom.spdxVersion !== 'SPDX-2.3' || !Array.isArray(sbom.packages) || !sbom.packages.length) throw new Error('SBOM_INCOMPLETE_SCAN');
  sbom.annotations ??= [];
  const timestamp = sbom.creationInfo?.created;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw new Error('SBOM_CREATION_TIME');
  sbom.annotations.push({ annotationDate: timestamp, annotationType: 'OTHER', annotator: 'Tool: splrad-steward', comment: JSON.stringify({
    scope: 'Extracted delivery bytes and separately identified committed build inputs; build-input presence does not imply redistribution.', sourceSha: record.sourceSha, restoreLocks: locks, rightsSources: Object.fromEntries(rights),
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
    if (name.startsWith('./build-inputs/')) continue;
    const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
    const statement = rights.get(name.split('/')[1]!);
    const font = { SPDXID: 'SPDXRef-Font-' + createHash('sha256').update(name).digest('hex'), fileName: name, fileTypes: ['BINARY'],
      checksums: [{ algorithm: 'SHA256', checksumValue: sha256 }], licenseConcluded: 'NOASSERTION', licenseInfoInFiles: ['NOASSERTION'], copyrightText: 'NOASSERTION',
      comment: statement ? 'Product rights statement at source commit: ' + statement.path + ' (SHA256 ' + statement.sha256 + ')' : 'Distributed font resource; rights information not supplied.' };
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
