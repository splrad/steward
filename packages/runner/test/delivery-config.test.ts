import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AjvModule from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const Ajv = AjvModule as unknown as typeof import('ajv').default;
const addFormats = addFormatsModule as unknown as typeof import('ajv-formats').default;
const root = resolve('.');
const ajv = new Ajv({ allErrors: true, strict: true }); addFormats(ajv);
let catalog: any;
let fixture: string;
let repositoryValidator: ReturnType<typeof ajv.compile>;
beforeAll(async () => {
  catalog = JSON.parse(await readFile('config/repositories.json', 'utf8'));
  repositoryValidator = ajv.compile(JSON.parse(await readFile('schema/repositories.schema.json', 'utf8')));
  fixture = await mkdtemp(join(tmpdir(), 'steward-delivery-config-'));
  await cp('config', join(fixture, 'config'), { recursive: true });
  await cp('schema', join(fixture, 'schema'), { recursive: true });
  await mkdir(join(fixture, 'packages/runtime'), { recursive: true });
  await cp('packages/runtime/wrangler.toml', join(fixture, 'packages/runtime/wrangler.toml'));
});
afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });

describe('catalog schema migration', () => {
  it('accepts current v4 and a complete v3 catalog', () => {
    expect(repositoryValidator(catalog)).toBe(true);
    const legacy = structuredClone(catalog); legacy.schemaVersion = 3;
    for (const config of [...Object.values(legacy.defaults), ...Object.values(legacy.repositories)] as any[]) {
      delete config.builds; delete config.delivery; delete config.copilotReviewTrigger;
    }
    expect(repositoryValidator(legacy), ajv.errorsText(repositoryValidator.errors)).toBe(true);
    legacy.repositories['1296724484'].copilotReviewTrigger = 'native';
    expect(repositoryValidator(legacy)).toBe(false);
  });
  it.each(['version3-with-new-fields', 'version4-without-delivery', 'version5', 'unknown-capability', 'unknown-input', 'unknown-build-profile', 'invalid-build-output', 'disabled-profile', 'disabled-builds', 'bad-trigger', 'root-version-override'])('rejects %s', variant => {
    const value = structuredClone(catalog); const layer = value.repositories['1187527897'];
    switch (variant) {
      case 'version3-with-new-fields': value.schemaVersion = 3; break;
      case 'version4-without-delivery': delete layer.delivery; break;
      case 'version5': value.schemaVersion = 5; break;
      case 'unknown-capability': layer.delivery.publish = {}; break;
      case 'unknown-input': layer.builds['release-assets'].inputs.command = 'echo hello'; break;
      case 'unknown-build-profile': layer.builds['release-assets'].profile = 'unknown'; break;
      case 'invalid-build-output': layer.builds['release-assets'].outputs[0].kind = 'oci-image'; break;
      case 'disabled-profile': Object.assign(layer.delivery.githubRelease, { enabled: false, state: 'disabled' }); break;
      case 'disabled-builds': Object.assign(layer.delivery.githubRelease, { enabled: false, state: 'disabled', profile: null }); break;
      case 'bad-trigger': layer.delivery.packages = [{ id: 'container', state: 'pending', profile: 'ghcr-oci-v1', builds: ['release-assets'], publication: 'versioned', trigger: 'default-branch' }]; break;
      case 'root-version-override': layer.versionFile = 'Version.props'; break;
    }
    expect(repositoryValidator(value)).toBe(false);
  });
  it('keeps all new real capabilities inactive', () => {
    expect(catalog.defaults.public.delivery).toEqual(catalog.defaults.private.delivery);
    for (const config of [...Object.values(catalog.defaults), ...Object.values(catalog.repositories)] as any[]) {
      expect(config.delivery.githubRelease.state).not.toBe('active');
      expect(config.delivery.deployments).toEqual([]); expect(config.delivery.packages).toEqual([]);
    }
  });
});

describe('cross-file delivery verification', () => {
  async function verify(edit: (value: any) => void) {
    const value = structuredClone(catalog); edit(value);
    await writeFile(join(fixture, 'config/repositories.json'), JSON.stringify(value));
    return spawnSync(process.execPath, [join(root, 'scripts/verify-config.mjs')], { cwd: fixture, encoding: 'utf8' });
  }
  it.each([
    ['dangling-build', 'RN_CONFIG_BUILD_REFERENCE'], ['unknown-release', 'RN_CONFIG_PROFILE'],
    ['active-adapter', 'RN_CONFIG_ADAPTER_UNAVAILABLE'], ['default-enabled', 'RN_CONFIG_DEFAULTS'],
    ['repository-mismatch', 'RN_CONFIG_REPOSITORY'], ['entrypoint-escape', 'RN_CONFIG_PATH'],
    ['entrypoint-directory', 'RN_CONFIG_ENTRYPOINT'], ['output-escape', 'RN_CONFIG_PATH'],
  ])('rejects %s through verify:config', async (variant, error) => {
    const result = await verify(value => {
      const layer = value.repositories['1187527897'];
      switch (variant) {
        case 'dangling-build': layer.delivery.githubRelease.builds = ['missing']; break;
        case 'unknown-release': layer.delivery.githubRelease.profile = 'missing'; break;
        case 'active-adapter': layer.delivery.githubRelease.state = 'active'; break;
        case 'default-enabled': value.defaults.public.delivery = layer.delivery; break;
        case 'repository-mismatch': layer.fullName = 'splrad/Other'; break;
        case 'entrypoint-escape': layer.builds['release-assets'].inputs.entrypoint = '../build.ps1'; break;
        case 'entrypoint-directory': layer.builds['release-assets'].inputs.entrypoint = 'scripts/build.ps1'; break;
        case 'output-escape': layer.builds['release-assets'].outputs[0].match = '../archive.zip'; break;
      }
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stderr).toContain(error!);
  });
  it('accepts a source release with no build units', async () => {
    const result = await verify(value => { value.repositories['1187527897'].delivery.githubRelease.builds = []; });
    expect(result.status, result.stderr).toBe(0);
  });
  it.each([
    ['package', 'deployment', 'ghcr-oci-v1'],
    ['deployment', 'package', 'cloud-service-v1'],
  ])('rejects a %s profile registered in the %s directory', async (source, destination, name) => {
    const misplaced = join(fixture, `config/profiles/${destination}/${name}.json`);
    await cp(join(fixture, `config/profiles/${source}/${name}.json`), misplaced);
    try {
      const result = await verify(() => {});
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('RN_CONFIG_CAPABILITY');
    } finally { await rm(misplaced); }
  });
  it('rejects corruption in the legacy profile used by the old runner', async () => {
    const file = join(fixture, 'config/profiles/release-legacy/layerscape.json');
    const bytes = await readFile(file);
    const profile = JSON.parse(bytes.toString()); profile.repository.id = 99;
    await writeFile(file, JSON.stringify(profile));
    try {
      const result = await verify(() => {});
      expect(result.status).toBe(1); expect(result.stderr).toContain('RN_CONFIG_LEGACY_PROFILE');
    } finally { await writeFile(file, bytes); }
  });
  it('rejects an unknown producer in the common policy', async () => {
    const file = join(fixture, 'config/profiles/release-notes/common-v3.json');
    const bytes = await readFile(file);
    const profile = JSON.parse(bytes.toString()); profile.producer.type = 'unknown';
    await writeFile(file, JSON.stringify(profile));
    try {
      const result = await verify(() => {});
      expect(result.status).toBe(1); expect(result.stderr).toContain('不符合结构');
    } finally { await writeFile(file, bytes); }
  });
});
