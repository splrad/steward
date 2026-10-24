import { expect, it } from 'vitest';
import catalog from '../../../config/repositories.json' with { type: 'json' };
import { parseRepositoryCatalog, releaseWriteAuthority } from '../src/repository-policy.js';
it('loads schema5 with every initial capability disabled', () => {
  const parsed = parseRepositoryCatalog(catalog);
  for (const repository of Object.values(parsed.repositories)) {
    expect(repository.automation.managedSync.enabled).toBe(false); expect(repository.automation.dependencyUpdates.enabled).toBe(false);
    expect(repository.release.enabled).toBe(false); expect(repository.pages.enabled).toBe(false);
    expect(() => releaseWriteAuthority(parsed, repository.repositoryId, repository.fullName, 'layerscape', 'a'.repeat(40))).toThrow('not enabled');
  }
});
it.each(['v4', 'missing-switch', 'legacy-delivery', 'legacy-ai', 'id', 'no-adoption', 'two-adoptions', 'sync-null', 'revoked', 'channel-target', 'channel-field', 'fork-null'])('rejects %s catalog', kind => {
  const value: any = structuredClone(catalog), repository = value.repositories['1187527897'], unit = repository.release.units.layerscape;
  if (kind === 'v4') value.schemaVersion = 4;
  if (kind === 'missing-switch') delete repository.automation.dependencyUpdates;
  if (kind === 'legacy-delivery') repository.delivery = {};
  if (kind === 'legacy-ai') repository.classification.ai = {};
  if (kind === 'id') repository.repositoryId++;
  if (['no-adoption', 'two-adoptions', 'fork-null'].includes(kind)) { repository.release.enabled = true; unit.enabled = true; }
  if (kind === 'no-adoption') unit.adoptedAfterTag = null;
  if (kind === 'two-adoptions') unit.adoptedFromSha = 'a'.repeat(40);
  if (kind === 'sync-null') repository.automation.managedSync.enabled = true;
  if (kind === 'revoked') { repository.automation.managedSync = { enabled: true, policySha: 'a'.repeat(40) }; repository.revokedPolicyShas = ['a'.repeat(40)]; }
  if (kind === 'channel-target') unit.channels['ghcr-assets'].destination = 'https://untrusted.invalid';
  if (kind === 'channel-field') unit.channels['ghcr-assets'].nugetUser = 'other';
  if (kind === 'fork-null') unit.channels.winget.enabled = true;
  expect(() => parseRepositoryCatalog(value)).toThrow('REPOSITORY_POLICY');
});
it('requires current repository/unit authority and blocks revoked historical policy', () => {
  const value = structuredClone(catalog); value.repositories['1187527897'].release.enabled = true; value.repositories['1187527897'].release.units.layerscape.enabled = true;
  const parsed = parseRepositoryCatalog(value);
  expect(releaseWriteAuthority(parsed, 1187527897, 'splrad/LayerScape', 'layerscape', 'a'.repeat(40)).unit.enabled).toBe(true);
  parsed.repositories['1187527897']!.revokedPolicyShas.push('a'.repeat(40));
  expect(() => releaseWriteAuthority(parsed, 1187527897, 'splrad/LayerScape', 'layerscape', 'a'.repeat(40))).toThrow('revoked');
});
