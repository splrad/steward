import {readFile} from 'node:fs/promises';
import {describe,it,expect} from 'vitest';
import {parseLegacyRepositoryCatalog} from '../../core/src/legacy-repository-policy.js';
const catalog=JSON.parse(await readFile('packages/core/test/fixtures/legacy-repositories-v5.json','utf8'));
describe('frozen schema 5 history decoding',()=>{
  it('reads original channel obligations',()=>{expect(parseLegacyRepositoryCatalog(catalog).schemaVersion).toBe(5);});
  it.each(['v3', 'v4', 'delivery', 'builds', 'ai', 'unknown-unit-field', 'missing-pages', 'id-mismatch', 'duplicate-repository', 'legacy-automation', 'legacy-policy', 'unit-without-release', 'no-adoption', 'two-adoptions', 'channel-target', 'unknown-channel-field', 'winget-without-fork'])('rejects %s through production validation', async variant => {
    const value=structuredClone(catalog); const edit=(value:any)=>{
      const layer = value.repositories['1187527897'], unit = layer.release.units.layerscape;
      if (variant === 'v3') value.schemaVersion = 3;
      if (variant === 'v4') value.schemaVersion = 4;
      if (variant === 'delivery') layer.delivery = {};
      if (variant === 'builds') layer.builds = {};
      if (variant === 'ai') layer.classification.ai = {};
      if (variant === 'unknown-unit-field') unit.command = 'arbitrary';
      if (variant === 'missing-pages') delete layer.pages;
      if (variant === 'id-mismatch') layer.repositoryId++;
      if (variant === 'duplicate-repository') layer.fullName = value.repositories['1296724484'].fullName;
      if (variant === 'legacy-automation') layer.automation = { managedSync: { enabled: true } };
      if (variant === 'legacy-policy') { layer.automation = { managedSync: { enabled: true, policySha: 'a'.repeat(40) } }; layer.revokedPolicyShas = ['a'.repeat(40)]; }
      if (variant === 'unit-without-release') unit.enabled = true;
      if (['no-adoption', 'two-adoptions', 'winget-without-fork'].includes(variant)) { layer.release.enabled = true; unit.enabled = true; }
      if (variant === 'no-adoption') unit.adoptedAfterTag = null;
      if (variant === 'two-adoptions') unit.adoptedFromSha = 'a'.repeat(40);
      if (variant === 'channel-target') unit.channels['ghcr-assets'].destination = 'https://untrusted.invalid';
      if (variant === 'unknown-channel-field') unit.channels['ghcr-assets'].nugetUser = 'other';
      if (variant === 'winget-without-fork') unit.channels.winget.enabled = true;
    };edit(value);
    expect(()=>parseLegacyRepositoryCatalog(value)).toThrow('REPOSITORY_POLICY');
  });
});
