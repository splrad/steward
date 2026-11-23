import { parseRegistration } from './repository-registration-policy.mjs';
import { readProtectedSettings, withStewardSettings } from './steward-settings-read.mjs';

const unavailable = 'REPOSITORY_POLICY_UNAVAILABLE';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

// A missing file is accepted only after verifying both native directory inventories.
export async function readRepositoryPolicy(api, repository, {allowRegisteredRename=false}={}) {
  const { id, full_name: name } = repository;
  if (!Number.isSafeInteger(id) || id < 1 || !/^splrad\/[\w.-]+$/.test(name)) throw Error(unavailable);
  const { commit, value: policy } = await readProtectedSettings(api, async ({ entry, readFile, check }) => {
    const directory = await entry('repositories');
    if (!directory) return null;
    check(directory.type === 'tree' && directory.mode === '040000' && sha(directory.sha));
    const blob = await entry(id + '.json', directory.sha);
    if (!blob) return null;
    const value = parseRegistration(await readFile('repositories/' + id + '.json', blob), id);
    check(allowRegisteredRename || value.repository === name);
    return value;
  }, unavailable);
  return { commit, policy, adoption: policy?.adoption ?? 'legacy' };
}

export async function mergedRepositoryPolicy(app, repository, options) {
  return withStewardSettings(app, api => readRepositoryPolicy(api, repository, options), unavailable);
}
