import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectDeclaredAsset, inspectWorkflowAsset } from '../src/release-native.js';
import { parseDeliveryConfig, type DeliveryUnit } from '../../core/src/delivery-config.js';
import { permitOfflineScript, registerOfflineFixtureRoot } from './offline-fixtures.js';
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'declared-archive-'));
  registerOfflineFixtureRoot(root);
  const builder = resolve('packages/runner/test/fixtures/declared-archive-fixture.py');
  permitOfflineScript(builder);
  permitOfflineScript(resolve('scripts/inspect-python-release.py'));
  const python = resolve('tools/template/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await promisify(execFile)(python, ['-I', builder, root]);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

it.each([
  ['cli.tar.gz', 'tar-gzip', true],
  ['stations.zip', 'zip', true],
  ['large.zip', 'zip', true],
  ['stream.zip', 'zip', true],
  ['stream64.zip', 'zip', true],
  ['seekable64.zip', 'zip', true],
  ['comment.zip', 'zip', true],
  ['application.zip', 'zip', false],
  ['extra.zip', 'zip', false],
  ['short-comment.zip', 'zip', false],
  ['ambiguous.zip', 'zip', false],
  ['historical-zip64.zip', 'zip', false],
  ['buffered-tail.tar.gz', 'tar-gzip', false],
  ['later-tail.tar.gz', 'tar-gzip', false],
  ['broken.tar.gz', 'tar-gzip', false],
  ['bad-font.zip', 'font-zip', false],
] as const)('checks the actual bytes of %s', async (name, inspection, ok) => {
  const asset = { id: 'fixture', name, mediaType: inspection === 'tar-gzip' ? 'application/gzip' : 'application/zip', inspection };
  const result = inspectDeclaredAsset(join(root, name), asset, '1.2.3', process.cwd(), root, join(root, name + '-staged'));
  if (ok) {
    await expect(result).resolves.toBe('1.2.3');
    if (name === 'stations.zip' || name === 'cli.tar.gz') {
      expect(await readFile(join(root, name + '-staged', 'pkg/__init__.py'))).toHaveLength(0);
    }
  } else await expect(result).rejects.toThrow();
});
it('verifies required members, their native type and embedded version', async () => {
  const asset: DeliveryUnit['assets'][number] = { id: 'data', name: 'stations.zip', mediaType: 'application/zip', inspection: 'zip',
    members: [{ path: 'VERSION', format: 'version' }] };
  const inspect = (version: string) => inspectDeclaredAsset(join(root, asset.name), asset, version, process.cwd(), root);
  await expect(inspect('1.2.3')).resolves.toBe('1.2.3');
  await expect(inspect('2.0.0')).rejects.toThrow();
  asset.members = [{ path: 'missing', format: 'text' }];
  await expect(inspect('1.2.3')).rejects.toThrow();
  asset.members = [{ path: 'data.csv', format: 'elf' }];
  await expect(inspect('1.2.3')).rejects.toThrow();
});
it('keeps historical schema closed and requires version evidence for generic archives', () => {
  const data = { schemaVersion: 1, repositoryAuthors: [{ id: 1, evidence: 'fixture' }],
    units: [{ id: 'app', path: '.', notesPath: 'README.md', buildLocks: ['tools/package-lock.json'],
      assets: [{ id: 'data', name: 'stations.zip', mediaType: 'application/zip', inspection: 'zip' }], channels: [] }] };
  expect(() => parseDeliveryConfig(data)).toThrow('DELIVERY_CONFIG_STRUCTURE');
  data.schemaVersion = 2;
  expect(() => parseDeliveryConfig(data)).toThrow('DELIVERY_ARCHIVE_VERSION');
  data.units[0]!.assets[0]!.name = 'stations-${version}.zip';
  data.units[0]!.buildLocks.push('tools/PACKAGE-LOCK.json');
  expect(() => parseDeliveryConfig(data)).toThrow('DELIVERY_DUPLICATE_LOCK');
});

it('preserves an ordinary binary SQLite resource without a member format declaration', async () => {
  const asset: DeliveryUnit['assets'][number] = { id: 'data', name: 'database-${version}.zip', mediaType: 'application/zip', inspection: 'zip' };
  const staging = join(root, 'database-stage');
  await expect(inspectDeclaredAsset(join(root, 'database.zip'), asset, '1.2.3', process.cwd(), root, staging)).resolves.toBe('1.2.3');
  expect(await readFile(join(staging, 'data/stations.db'))).toEqual(await readFile(join(root, 'stations.db')));
});

it('checks the archive release version and retains a DLL dependency with its own version', async () => {
  const check=(version:string)=>inspectWorkflowAsset(join(root,'vendor.zip'),'simple',version,process.cwd(),root);
  await expect(check('2.0.0')).resolves.toBeUndefined();
  await expect(check('1.2.3')).rejects.toThrow('RN_DELIVERY_VERSION');
});

it('reads a valid ZIP Unicode path and rejects a traversal in the effective member name', async () => {
  const check=(file:string)=>inspectWorkflowAsset(join(root,file),'simple','1.2.3',process.cwd(),root);
  await expect(check('unicode-font.zip')).resolves.toBeUndefined();
  await expect(check('unicode-traversal.zip')).rejects.toThrow('RN_DELIVERY_FORMAT');
});

it('reads the embedded version of a format-supported Windows installer', async () => {
  const check=(file:string,version='1.2.3')=>inspectWorkflowAsset(join(root,file),'simple',version,process.cwd(),root);
  await expect(check('application.msix')).resolves.toBeUndefined();
  await expect(check('application.msix','1.2.4')).rejects.toThrow('RN_DELIVERY_VERSION');
  await expect(check('legacy.appx')).resolves.toBeUndefined();
  await expect(check('wrong-schema.msix')).rejects.toThrow('RN_DELIVERY_FORMAT');
  await expect(check('bad-font.zip')).rejects.toThrow('RN_DELIVERY_FORMAT');
});

it('reads an MSIX bundle version with a proven single-disk ZIP64 footer', async () => {
  const check=(file:string,version='1.2.3')=>inspectWorkflowAsset(join(root,file),'simple',version,process.cwd(),root);
  await expect(check('application.msixbundle')).resolves.toBeUndefined();
  await expect(check('application.msixbundle','1.2.4')).rejects.toThrow('RN_DELIVERY_VERSION');
  await expect(check('wrong-schema.appxbundle')).rejects.toThrow('RN_DELIVERY_FORMAT');
  await expect(check('split.appxbundle')).rejects.toThrow('RN_DELIVERY_FORMAT');
  await expect(check('missing-zip64.appxbundle')).rejects.toThrow('RN_DELIVERY_FORMAT');
});
