import { permitOfflineCommand } from './offline-fixtures.js';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const root = resolve('.');
permitOfflineCommand(process.execPath, [join(root, 'scripts/verify-config.mjs')]);
let catalog: any;
let fixture: string;
beforeAll(async () => {
  catalog = JSON.parse(await readFile('config/repositories.json', 'utf8'));
  fixture = await mkdtemp(join(tmpdir(), 'steward-delivery-config-'));
  for (const path of ['config', 'schema', 'mise.toml', 'mise.lock', '.mise', 'package.json', 'package-lock.json']) await cp(path, join(fixture, path), { recursive: true });
  await mkdir(join(fixture, 'packages/runtime'), { recursive: true });
  await cp('packages/runtime/wrangler.toml', join(fixture, 'packages/runtime/wrangler.toml'));
});
afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });
describe('schema 5 through the actual verify:config entrypoint', () => {
  async function verify(edit: (value: any) => void) {
    const value = structuredClone(catalog); edit(value);
    await writeFile(join(fixture, 'config/repositories.json'), JSON.stringify(value));
    return spawnSync(process.execPath, [join(root, 'scripts/verify-config.mjs')], { cwd: fixture, encoding: 'utf8', timeout: 60_000 });
  }
  it('accepts the inactive catalog and keeps native product contracts outside the central catalog', async () => {
    const result = await verify(() => {});
    expect(result.status, result.stderr).toBe(0);
    expect(catalog.schemaVersion).toBe(5);
    for (const config of [...Object.values(catalog.defaults), ...Object.values(catalog.repositories)] as any[]) {
      expect(config.builds).toBeUndefined(); expect(config.delivery).toBeUndefined();
      expect(config.release.enabled).toBe(false); expect(config.pages.enabled).toBe(false);
      expect(config.automation.managedSync.enabled).toBe(false); expect(config.automation.dependencyUpdates.enabled).toBe(false);
    }
  });
  it.each(['v3', 'v4', 'delivery', 'builds', 'ai', 'unknown-unit-field', 'missing-switch', 'id-mismatch', 'duplicate-repository', 'sync-null', 'revoked-policy', 'unit-without-release', 'no-adoption', 'two-adoptions', 'channel-target', 'unknown-channel-field', 'winget-without-fork'])('rejects %s through production validation', async variant => {
    const result = await verify(value => {
      const layer = value.repositories['1187527897'], unit = layer.release.units.layerscape;
      if (variant === 'v3') value.schemaVersion = 3;
      if (variant === 'v4') value.schemaVersion = 4;
      if (variant === 'delivery') layer.delivery = {};
      if (variant === 'builds') layer.builds = {};
      if (variant === 'ai') layer.classification.ai = {};
      if (variant === 'unknown-unit-field') unit.command = 'arbitrary';
      if (variant === 'missing-switch') delete layer.automation.dependencyUpdates;
      if (variant === 'id-mismatch') layer.repositoryId++;
      if (variant === 'duplicate-repository') layer.fullName = value.repositories['1296724484'].fullName;
      if (variant === 'sync-null') layer.automation.managedSync.enabled = true;
      if (variant === 'revoked-policy') { layer.automation.managedSync = { enabled: true, policySha: 'a'.repeat(40) }; layer.revokedPolicyShas = ['a'.repeat(40)]; }
      if (variant === 'unit-without-release') unit.enabled = true;
      if (['no-adoption', 'two-adoptions', 'winget-without-fork'].includes(variant)) { layer.release.enabled = true; unit.enabled = true; }
      if (variant === 'no-adoption') unit.adoptedAfterTag = null;
      if (variant === 'two-adoptions') unit.adoptedFromSha = 'a'.repeat(40);
      if (variant === 'channel-target') unit.channels['ghcr-assets'].destination = 'https://untrusted.invalid';
      if (variant === 'unknown-channel-field') unit.channels['ghcr-assets'].nugetUser = 'other';
      if (variant === 'winget-without-fork') unit.channels.winget.enabled = true;
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/REPOSITORY_POLICY|不符合结构/);
  });
});
