import { expect, it } from 'vitest';
import { parseDeliveryConfig, deliveryAssetNames } from '../src/delivery-config.js';
const config = { schemaVersion: 1, repositoryAuthors: [{ id: 7, evidence: 'Test fixture: confirmed repository author; not a production identity.' }], units: [
  { id: 'app', path: '.', notesPath: '.release-notes/app.md', assets: [{ id: 'app', name: 'app-${packageVersion}.zip', mediaType: 'application/zip' }], channels: [] },
] };
it('accepts finite version substitution and channels=[] without inventing a channel', () => {
  const parsed = parseDeliveryConfig(config);
  expect(parsed.repositoryAuthors[0]!.id).toBe(7);
  expect(deliveryAssetNames(parsed.units[0]!, '1.2.3-rc.1', '1.2.3rc1').get('app')).toBe('app-1.2.3rc1.zip');
  expect(parsed.units[0]!.channels).toEqual([]);
});
it.each([['.','packages/other'],['packages/app','packages/app/child'],['Packages/App','packages/app/child']])('rejects overlapping unit roots %s and %s', (first,second)=>{
  const input=structuredClone(config);input.units[0]!.path=first;
  input.units.push({...structuredClone(input.units[0]!),id:'other',path:second});
  expect(()=>parseDeliveryConfig(input)).toThrow('DELIVERY_NESTED_UNIT_PATH');
});
it.each(['missing', 'empty', 'null', 'wrong-type', 'missing-evidence', 'empty-evidence', 'blank-evidence'])('reports unverified authors at the configuration entry: %s', kind => {
  const input: any = structuredClone(config);
  if (kind === 'missing') delete input.repositoryAuthors;
  if (kind === 'empty') input.repositoryAuthors = [];
  if (kind === 'null') input.repositoryAuthors = null;
  if (kind === 'wrong-type') input.repositoryAuthors = 'unverified';
  if (kind === 'missing-evidence') delete input.repositoryAuthors[0].evidence;
  if (kind === 'empty-evidence') input.repositoryAuthors[0].evidence = '';
  if (kind === 'blank-evidence') input.repositoryAuthors[0].evidence = ' \t\n';
  expect(() => parseDeliveryConfig(input)).toThrow('AUTHOR_IDENTITY_UNVERIFIED');
});
it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])('continues to reject invalid author numeric ID %s', id => {
  const input = structuredClone(config); input.repositoryAuthors[0]!.id = id;
  expect(() => parseDeliveryConfig(input)).toThrow('DELIVERY_CONFIG_STRUCTURE');
});
it.each(['recipe', 'command', 'author-duplicate', 'unit-duplicate', 'path', 'git-path', 'reserved', 'unsafe-name', 'unknown-placeholder', 'case-collision'])('rejects %s in finite delivery input', kind => {
  const input: any = structuredClone(config), unit = input.units[0];
  if (kind === 'recipe') unit.builds = [{ entrypoint: 'build.ps1' }];
  if (kind === 'command') input.command = 'shell';
  if (kind === 'author-duplicate') input.repositoryAuthors.push(input.repositoryAuthors[0]);
  if (kind === 'unit-duplicate') input.units.push(unit);
  if (kind === 'path') unit.notesPath = '../secret';
  if (kind === 'git-path') unit.notesPath = '.git/config';
  if (kind === 'reserved') unit.assets[0].name = 'SHA256SUMS';
  if (kind === 'unsafe-name') unit.assets[0].name = 'CON.zip';
  if (kind === 'unknown-placeholder') unit.assets[0].name = 'app-${command}.zip';
  if (kind === 'case-collision') unit.assets.push({ ...unit.assets[0], id: 'other', name: 'APP-${packageVersion}.zip' });
  expect(() => parseDeliveryConfig(input)).toThrow();
});
