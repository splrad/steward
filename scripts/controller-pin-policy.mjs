import YAML from 'yaml';
import {git} from './validation-input.mjs';

const layerScapeId = 1187527897;
const controllerRepository = 'splrad/steward';
const managedWorkflows = [
  '.github/workflows/channel-preflight.yml',
  '.github/workflows/pages.yml',
  '.github/workflows/steward-release-channels.yml',
  '.github/workflows/steward-release-publish.yml',
];

function readWorkflowPins(repo, revision, path) {
  const value = git(repo, ['cat-file', 'blob', revision + ':' + path]).toString('utf8');
  const workflow = YAML.parse(value);
  const jobs = Object.values(workflow?.jobs ?? {});
  const steps = jobs.flatMap(job => job.steps ?? []);
  const checkouts = steps.filter(step =>
    typeof step.uses === 'string' && step.uses.toLowerCase().startsWith('actions/checkout@'));
  const pins = [];
  for (const checkout of checkouts) {
    const repository = checkout.with?.repository;
    if (typeof repository !== 'string') continue;
    if (repository.includes('${{')) {
      throw Error('VALIDATION_CONTROLLER_CHECKOUT_REPOSITORY_EXPRESSION ' + path);
    }
    if (repository.toLowerCase() === controllerRepository) pins.push(checkout.with.ref);
  }
  if (!pins.length) throw Error('VALIDATION_CONTROLLER_CHECKOUT_MISSING ' + path);
  if (path.endsWith('/pages.yml')) {
    const variable = 'STEWARD_CONTROLLER_SHA';
    pins.push(workflow.env?.[variable]);
    for (const {env} of [...jobs, ...steps]) {
      if (env && Object.hasOwn(env, variable)) pins.push(env[variable]);
    }
  }
  if (path.endsWith('/steward-release-publish.yml')) {
    const prefix = controllerRepository + '/.github/workflows/product-release.yml@';
    const builds = jobs.filter(job => typeof job.uses === 'string' && job.uses.toLowerCase().startsWith(prefix));
    if (!builds.length) throw Error('VALIDATION_CONTROLLER_REUSABLE_WORKFLOW_MISSING ' + path);
    pins.push(...builds.map(job => job.uses.slice(prefix.length)));
  }
  if (!pins.every(pin => typeof pin === 'string' && /^[0-9a-f]{40}$/.test(pin))) {
    throw Error('VALIDATION_CONTROLLER_PIN_INVALID ' + path);
  }
  return pins;
}

export function verifyLayerScapeControllerPins(workspace, input, policy, promotedController) {
  if (input.repositoryId !== layerScapeId
    || !managedWorkflows.some(path => input.changedPaths.includes(path))) return;

  const before = new Set(managedWorkflows.flatMap(path => readWorkflowPins(workspace, input.base, path)));
  const after = new Set(managedWorkflows.flatMap(path => readWorkflowPins(workspace, input.head, path)));
  if (after.size !== 1) throw Error('VALIDATION_CONTROLLER_PIN_MISMATCH');
  const [candidate] = after;
  if (before.size === 1 && before.has(candidate)) return;

  for (const previous of before) {
    try {
      git(policy, ['merge-base', '--is-ancestor', previous, candidate]);
    } catch (error) {
      if (error.status === 1) throw Error('VALIDATION_CONTROLLER_DOWNGRADE ' + previous + ' -> ' + candidate);
      throw error;
    }
  }
  if (candidate !== promotedController) throw Error('VALIDATION_CONTROLLER_NOT_PROMOTED ' + candidate);
}
