import {posix} from 'node:path';
import YAML from 'yaml';
import {git} from './validation-input.mjs';
import {controllerTagPrefix,controllerVersionNumber} from './controller-version.mjs';

const layerScapeId = 1187527897;
const controllerRepository = 'splrad/steward';
const controllerWorkflowPrefix = controllerRepository + '/.github/workflows/';
const publishWorkflow = '.github/workflows/steward-release-publish.yml';
const controllerPath = 'controller';
const archiveReaderPath = 'configuration-controller';
const archiveReaderCommand = 'node scripts/configuration-native-artifact.mjs';
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
    || collect.run !== archiveReaderCommand) {
    throw Error('VALIDATION_CONTROLLER_ARCHIVE_READER_WIRING');
  }
  return guard;
}

function readWorkflowPins(repo, revision, path, archiveReaders) {
  const value = git(repo, ['cat-file', 'blob', revision + ':' + path]).toString('utf8');
  const document = YAML.parseDocument(value);
  if (document.errors.length) throw document.errors[0];
  const workflow = document.toJS();
  const jobs = Object.entries(workflow?.jobs ?? {});
  const controllerPins = [];
  const pin = (sha, location) => {
    const comment = document.getIn(location, true)?.comment?.trim();
    controllerPins.push({sha, version: comment?.startsWith('controller-v') ? comment : null});
  };
  for (const [jobId, job] of jobs) {
    const steps = job.steps ?? [];
    let jobController;
    // The managed workflows declare controller entry points directly.
    if ([job, ...steps].some(entry => typeof entry.uses === 'string' && entry.uses.startsWith('./'))) {
      throw Error('VALIDATION_CONTROLLER_LOCAL_USES ' + path);
    }
    for (const [index, step] of steps.entries()) {
      if (path === publishWorkflow && jobId === 'build' && step.run === archiveReaderCommand) {
        const guard = step.if;
        const directory = step['working-directory'];
        if (directory === controllerPath && jobController && typeof guard === 'string' && guard && !archiveReaders.has(guard)) {
          archiveReaders.set(guard, jobController);
        } else {
          const checkout = steps[index - 2];
          if (directory !== archiveReaderPath || checkout?.with?.path !== archiveReaderPath
            || !archiveReaders.has(guard) || archiveReaders.get(guard) !== checkout.with.ref) {
            throw Error('VALIDATION_CONTROLLER_ARCHIVE_READER_WIRING');
          }
        }
      }
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
        jobController = step.with.ref;
        pin(jobController, ['jobs', jobId, 'steps', index, 'with', 'ref']);
      }
    }
  }
  if (!controllerPins.length) throw Error('VALIDATION_CONTROLLER_CHECKOUT_MISSING ' + path);
  if (path.endsWith('/pages.yml')) {
    if (!workflow.jobs?.select?.steps?.some(step => step.run === 'node controller/scripts/select-pages-source.mjs')
      || !workflow.jobs?.deploy?.steps?.some(step => step.run === 'node controller/scripts/pages-runtime.mjs check')) {
      throw Error('VALIDATION_CONTROLLER_PAGES_RUNTIME_CHECKS');
    }
    const variable = 'STEWARD_CONTROLLER_SHA';
    pin(workflow.env?.[variable], ['env', variable]);
    for (const [jobId, job] of jobs) {
      if (job.env && Object.hasOwn(job.env, variable)) pin(job.env[variable], ['jobs', jobId, 'env', variable]);
      for (const [index, {env}] of (job.steps ?? []).entries()) {
        if (env && Object.hasOwn(env, variable)) pin(env[variable], ['jobs', jobId, 'steps', index, 'env', variable]);
      }
    }
  }
  const reusable = jobs.filter(([, job]) => typeof job.uses === 'string'
    && job.uses.toLowerCase().startsWith(controllerWorkflowPrefix));
  if (path === publishWorkflow && !reusable.some(([, job]) =>
    job.uses.toLowerCase().startsWith(controllerWorkflowPrefix + 'product-release.yml@'))) {
    throw Error('VALIDATION_CONTROLLER_REUSABLE_WORKFLOW_MISSING ' + path);
  }
  for (const [jobId, job] of reusable) pin(job.uses.slice(job.uses.lastIndexOf('@') + 1), ['jobs', jobId, 'uses']);
  if (!controllerPins.every(({sha}) => isPin(sha))) throw Error('VALIDATION_CONTROLLER_PIN_INVALID ' + path);
  return controllerPins;
}

function readRevisionPins(workspace, revision) {
  const archiveReaders = new Map();
  const pins = managedWorkflows.flatMap(path => readWorkflowPins(workspace, revision, path, archiveReaders));
  return {controller: new Set(pins.map(pin => pin.sha)), versions: new Set(pins.map(pin => pin.version)), archiveReaders};
}

function verifyVersionLabels(policy, before, after, sha, controllerChanged) {
  if (!controllerChanged && before.size === 1 && before.has(null) && after.size === 1 && after.has(null)) return;
  const [version] = after;
  const number = controllerVersionNumber(version);
  if (after.size !== 1 || !number) throw Error('VALIDATION_CONTROLLER_VERSION_LABELS');
  const ref = controllerTagPrefix + number;
  let published;
  try {
    published = git(policy, ['rev-parse', '--verify', '--quiet', ref]).toString().trim();
  } catch (error) {
    if (error.status === 128 || error.status === 1) throw Error('VALIDATION_CONTROLLER_VERSION_TAG_MISSING ' + version);
    throw error;
  }
  if (published !== sha) throw Error('VALIDATION_CONTROLLER_VERSION_SHA_MISMATCH ' + version);
  const [previous] = before;
  const previousNumber = controllerVersionNumber(previous);
  if (before.size !== 1 || previous !== null && !previousNumber) throw Error('VALIDATION_CONTROLLER_VERSION_LABELS');
  if (previousNumber && previousNumber > number) throw Error('VALIDATION_CONTROLLER_VERSION_DOWNGRADE ' + previous + ' -> ' + version);
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
  const controllerChanged = before.controller.size !== 1 || !before.controller.has(candidate);
  verifyVersionLabels(policy, before.versions, after.versions, candidate, controllerChanged);
  if (controllerChanged) {
    verifyPromotion(policy, before.controller, candidate, promotedController);
  }
  for (const [key, reader] of after.archiveReaders) {
    const previous = before.archiveReaders.get(key);
    if (reader !== previous) verifyPromotion(policy, previous ? [previous] : [], reader, promotedController);
  }
}
