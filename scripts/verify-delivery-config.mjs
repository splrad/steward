import { readFile, readdir } from 'node:fs/promises';
import { assertDeliveryPath, validateDeliveryConfiguration } from '../packages/core/src/delivery-config.ts';

export async function verifyDeliveryConfig(catalog, ajv) {
  const registry = { builds: {}, releases: {}, notes: {}, deployments: {}, packages: {},
    adapters: { builds: [], releases: [], deployments: [], packages: [] } };
  const groups = [
    ['build', 'build-profile', 'builds'], ['release', 'release-profile', 'releases'],
    ['release-notes', 'release-notes-profile', 'notes'],
    ['deployment', 'delivery-profile', 'deployments', 'deployment'], ['package', 'delivery-profile', 'packages', 'package'],
  ];
  for (const [folder, schemaName, key, capability] of groups) {
    const schema = JSON.parse(await readFile(`schema/${schemaName}.schema.json`, 'utf8'));
    const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
    for (const file of (await readdir(`config/profiles/${folder}`)).sort()) {
      if (!file.endsWith('.json')) continue;
      const profile = JSON.parse(await readFile(`config/profiles/${folder}/${file}`, 'utf8'));
      if (!validate(profile)) throw new Error(`${folder}/${file}不符合结构: ${ajv.errorsText(validate.errors)}`);
      if (capability !== undefined && profile.capability !== capability) throw new Error('RN_CONFIG_CAPABILITY');
      if (file !== `${profile.name}.json` || Object.hasOwn(registry[key], profile.name)) throw new Error('RN_CONFIG_PROFILE_NAME');
      if (key === 'releases') {
        const notes = profile.releaseNotes;
        assertDeliveryPath(notes.fragmentDirectory);
        for (const patterns of Object.values(notes.candidateChanges)) {
          if (Array.isArray(patterns)) for (const pattern of patterns) assertDeliveryPath(pattern, { glob: true });
        }
        const sections = notes.personalization?.sections ?? [];
        if (new Set(sections.map(section => section.id)).size !== sections.length) throw new Error('RN_CONFIG_DUPLICATE_ID');
        // Structured product sections require a separately reviewed renderer contract.
        if (notes.personalization?.enabled) throw new Error('RN_CONFIG_PERSONALIZATION_PENDING');
      }
      registry[key][profile.name] = profile;
    }
  }
  for (const profile of Object.values(registry.releases)) {
    if (!Object.hasOwn(registry.notes, profile.releaseNotes.profile)) throw new Error('RN_CONFIG_PROFILE');
  }
  for (const configuration of Object.values(catalog.defaults)) {
    validateDeliveryConfiguration(configuration, registry);
  }
  const legacySchema = JSON.parse(await readFile('schema/legacy-release-profile.schema.json', 'utf8'));
  const validateLegacy = ajv.compile(legacySchema);
  for (const [id, configuration] of Object.entries(catalog.repositories)) {
    validateDeliveryConfiguration(configuration, registry, { id: Number(id), fullName: configuration.fullName, managed: configuration.managed });
    if (configuration.releaseProfile !== null) {
      assertDeliveryPath(configuration.releaseProfile);
      if (!/^[a-z][a-z0-9-]*$/u.test(configuration.releaseProfile)) throw new Error('RN_CONFIG_PROFILE_NAME');
      const legacy = JSON.parse(await readFile(`config/profiles/release-legacy/${configuration.releaseProfile}.json`, 'utf8'));
      if (!validateLegacy(legacy) || legacy.name !== configuration.releaseProfile || legacy.repository.id !== Number(id) || legacy.repository.fullName !== configuration.fullName) throw new Error('RN_CONFIG_LEGACY_PROFILE');
    }
  }
}
