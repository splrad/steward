import {posix} from 'node:path';
import YAML from 'yaml';
import {git} from './validation-input.mjs';

const layerScapeId = 1187527897;
const controllerRepository = 'splrad/steward';
const publishWorkflow = '.github/workflows/steward-release-publish.yml';
const controllerPath = 'controller';
const archiveReaderPath = 'configuration-controller';
const controllerMounts = [controllerPath, archiveReaderPath];
const managedWorkflows = [
  '.github/workflows/channel-preflight.yml',
  '.github/workflows/pages.yml',
  '.github/workflows/steward-release-channels.yml',
  publishWorkflow,
];
const isPin = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

function archiveReaderKey(checkout, install, collect) {
  const guard = checkout.if;
  if (checkout.name !== 'Check out native archive reader' || typeof guard !== 'string' || !guard
    || checkout.with['persist-credentials'] !== false
    || install?.name !== 'Install native archive reader dependencies' || install.if !== guard
    || install['working-directory'] !== archiveReaderPath
    || install.run !== 'npm ci --ignore-scripts --no-audit --no-fund'
    || collect?.name !== 'Collect verified product workflow archive' || collect.if !== guard
    || collect['working-directory'] !== archiveReaderPath
    || collect.run !== 'node scripts/configuration-native-artifact.mjs') {
    throw Error('VALIDATION_CONTROLLER_ARCHIVE_READER_WIRING');
  }
  return guard;
}

function readWorkflowPins(repo, revision, path, archiveReaders) {
  const value = git(repo, ['cat-file', 'blob', revision + ':' + path]).toString('utf8');
  const workflow = YAML.parse(value);
  const jobs = Object.entries(workflow?.jobs ?? {});
  const controllerPins = [];
  for (const [jobId, job] of jobs) {
    const steps = job.steps ?? [];
    for (const [index, step] of steps.entries()) {
      if (typeof step.uses !== 'string' || !step.uses.toLowerCase().startsWith('actions/checkout@')) continue;
      const repository = step.with?.repository;
      if (typeof repository === 'string' && repository.includes('${{')) {
        throw Error('VALIDATION_CONTROLLER_CHECKOUT_REPOSITORY_EXPRESSION ' + path);
      }
      const mount = step.with?.path;
      if (typeof mount === 'string' && mount.includes('${{')) {
        throw Error('VALIDATION_CONTROLLER_CHECKOUT_MOUNT ' + path);
      }
      const normalizedMount = typeof mount === 'string'
        ? posix.resolve('/', mount.replaceAll('\\', '/')).slice(1).toLowerCase() : '';
      if (typeof repository !== 'string' || repository.toLowerCase() !== controllerRepository) {
        if (controllerMounts.some(reserved => normalizedMount === reserved || normalizedMount.startsWith(reserved + '/'))) {
          throw Error('VALIDATION_CONTROLLER_CHECKOUT_MOUNT ' + path);
        }
        continue;
      }
      const archiveReader = path === publishWorkflow && jobId === 'build' && mount === archiveReaderPath;
      if (!archiveReader && mount !== controllerPath) throw Error('VALIDATION_CONTROLLER_CHECKOUT_MOUNT ' + path);
      if (!isPin(step.with.ref)) throw Error('VALIDATION_CONTROLLER_PIN_INVALID ' + path);
      if (archiveReader) {
        // The configuration panel can update one archive producer while preserving the others.
        const key = archiveReaderKey(step, steps[index + 1], steps[index + 2]);
        if (archiveReaders.has(key)) throw Error('VALIDATION_CONTROLLER_ARCHIVE_READER_WIRING');
        archiveReaders.set(key, step.with.ref);
      } else {
        controllerPins.push(step.with.ref);
      }
    }
  }
  if (!controllerPins.length) throw Error('VALIDATION_CONTROLLER_CHECKOUT_MISSING ' + path);
  const jobValues = jobs.map(([, job]) => job);
  if (path.endsWith('/pages.yml')) {
    const variable = 'STEWARD_CONTROLLER_SHA';
    controllerPins.push(workflow.env?.[variable]);
    for (const {env} of [...jobValues, ...jobValues.flatMap(job => job.steps ?? [])]) {
      if (env && Object.hasOwn(env, variable)) controllerPins.push(env[variable]);
    }
  }
  if (path === publishWorkflow) {
    const prefix = controllerRepository + '/.github/workflows/product-release.yml@';
    const builds = jobValues.filter(job => typeof job.uses === 'string' && job.uses.toLowerCase().startsWith(prefix));
    if (!builds.length) throw Error('VALIDATION_CONTROLLER_REUSABLE_WORKFLOW_MISSING ' + path);
    controllerPins.push(...builds.map(job => job.uses.slice(prefix.length)));
  }
  if (!controllerPins.every(isPin)) throw Error('VALIDATION_CONTROLLER_PIN_INVALID ' + path);
  return controllerPins;
}

function readRevisionPins(workspace, revision) {
  const archiveReaders = new Map();
  const controller = new Set(managedWorkflows.flatMap(path => readWorkflowPins(workspace, revision, path, archiveReaders)));
  return {controller, archiveReaders};
}

function verifyPromotion(policy, previousPins, candidate, promotedController) {
  for (const previous of previousPins) {
    try {
      git(policy, ['merge-base', '--is-ancestor', previous, candidate]);
    } catch (error) {
      if (error.status === 1) throw Error('VALIDATION_CONTROLLER_DOWNGRADE ' + previous + ' -> ' + candidate);
      throw error;
    }
  }
  if (candidate !== promotedController) throw Error('VALIDATION_CONTROLLER_NOT_PROMOTED ' + candidate);
}

export function verifyLayerScapeControllerPins(workspace, input, policy, promotedController) {
  if (input.repositoryId !== layerScapeId
    || !managedWorkflows.some(path => input.changedPaths.includes(path))) return;

  const before = readRevisionPins(workspace, input.base);
  const after = readRevisionPins(workspace, input.head);
  if (after.controller.size !== 1) throw Error('VALIDATION_CONTROLLER_PIN_MISMATCH');
  const [candidate] = after.controller;
  if (before.controller.size !== 1 || !before.controller.has(candidate)) {
    verifyPromotion(policy, before.controller, candidate, promotedController);
  }
  for (const [key, reader] of after.archiveReaders) {
    const previous = before.archiveReaders.get(key);
    if (reader !== previous) verifyPromotion(policy, previous ? [previous] : [], reader, promotedController);
  }
}
