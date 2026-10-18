import { freezePersonalization } from '../packages/core/src/release-personalization.ts';
import { releaseProfiles } from '../config/release-profiles.ts';
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
        const sections = notes.personalization?.sections ?? [];
        if (new Set(sections.map(section => section.id)).size !== sections.length) throw new Error('RN_CONFIG_DUPLICATE_ID');
        freezePersonalization(profile.repository.id, profile.repository.fullName, profile);
      }
      registry[key][profile.name] = profile;
    }
  }
  for (const profile of Object.values(registry.releases)) {
    if (JSON.stringify(releaseProfiles[profile.name]) !== JSON.stringify(profile)) throw new Error('RN_CONFIG_RELEASE_REGISTRY');
    if (!Object.hasOwn(registry.notes, profile.releaseNotes.profile)) throw new Error('RN_CONFIG_PROFILE');
  }
  if (Object.keys(releaseProfiles).sort().join() !== Object.keys(registry.releases).sort().join()) throw new Error('RN_CONFIG_RELEASE_REGISTRY');
  for (const configuration of Object.values(catalog.defaults)) {
    validateDeliveryConfiguration(configuration, registry);
  }
  for (const [id, configuration] of Object.entries(catalog.repositories)) {
    validateDeliveryConfiguration(configuration, registry, { id: Number(id), fullName: configuration.fullName, managed: configuration.managed });

  }
}
