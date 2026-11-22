import {posix} from 'node:path';
import YAML from 'yaml';
import {git} from './validation-input.mjs';

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

const controllerAction = /^splrad\/steward(?:\/|@)/i;
const isCheckout = uses => typeof uses === 'string' && uses.toLowerCase().startsWith('actions/checkout@');
const gitMutation = /\bgit(?:\.exe)?\b[^;&|]*?\b(?:clone|checkout|switch|reset|restore|worktree|pull|update-ref|merge|rebase|fetch)\b/i;
const fileMutation = /\b(?:rm|cp|mv|rmdir|del|remove-item|move-item|copy-item|rsync|set-content|add-content|out-file|ln|tar|unzip|expand-archive)\b/i;
const fileWriteCall = /\b(?:write|append)all(?:text|bytes|lines)\b|\bopen\s*\([^)]*,\s*['"][wax][+bt]*['"]/i;
const mountMention = /(?:^|[\s"'=:/(\\])(?:configuration-)?controller(?=$|[\s"'/:)\\;|&])/i;
const mountRedirect = />>?\s*["']?(?:\.[/\\])?(?:configuration-)?controller(?=$|[/\\\s"';|&])/i;
const controllerInvocation = /\bnode(?:\.exe)?\s+['"]?(?:\.\/)?controller[/\\]/i;
// The protected working directories admit the existing locked setup and archive-reader commands.
const controllerWorkdirCommands = new Set([
  'npm ci --ignore-scripts --no-audit --no-fund',
  'mise bin-paths node >> "$GITHUB_PATH"',
  '$toolPaths = mise bin-paths\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\n$toolPaths | Add-Content -LiteralPath $env:GITHUB_PATH',
  '$toolPaths = mise bin-paths\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\n$toolPaths | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8',
  'uv sync --project tools/template --frozen --only-group release-inspection --no-build\nif ($LASTEXITCODE) { exit $LASTEXITCODE }',
  archiveReaderCommand,
]);

function isControllerMount(value) {
  if (typeof value !== 'string') return false;
  const normalized = posix.resolve('/', value.replaceAll('\\', '/')).slice(1).toLowerCase();
  return controllerMounts.some(mount => normalized === mount || normalized.startsWith(mount + '/'));
}

function workspaceDirectory(value) {
  if (value === undefined || value === null) return '.';
  if (typeof value !== 'string') return null;
  const relative = value.replaceAll('\\', '/').replace(/^\$\{\{\s*github\.workspace\s*\}\}(?:\/+|$)/, '');
  const path = posix.normalize(relative);
  if (relative.includes('${{') || /^(?:\/|[a-z]:)/i.test(relative) || path === '..' || path.startsWith('../')) return null;
  return path.replace(/\/$/, '');
}

function violatesControllerMountPolicy(run, directory) {
  if (isControllerMount(directory)) {
    const command = run.replaceAll('\r\n', '\n').trimEnd();
    return !controllerWorkdirCommands.has(command) && !/^git status(?: --short| --porcelain)?$/.test(command);
  }
  return run.split(/\r?\n/).some(line =>
    mountRedirect.test(line)
    || (mountMention.test(line) && (gitMutation.test(line) || fileMutation.test(line) || fileWriteCall.test(line))));
}

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
  const workflow = YAML.parse(value);
  const jobs = Object.entries(workflow?.jobs ?? {});
  const controllerPins = [];
  const primaryCheckoutJobs = new Set();
  for (const [jobId, job] of jobs) {
    const steps = job.steps ?? [];
    const mountsController = steps.some(step => isCheckout(step.uses) && isControllerMount(step.with?.path));
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
      if (typeof step.run === 'string') {
        const runDirectory = workspaceDirectory(step['working-directory'] ?? job.defaults?.run?.['working-directory']
          ?? workflow.defaults?.run?.['working-directory']);
        const fromWorkspace = controllerInvocation.test(step.run);
        if ((mountsController && runDirectory === null) || (fromWorkspace && runDirectory !== '.')) {
          throw Error('VALIDATION_CONTROLLER_RUN_DIRECTORY ' + path);
        }
        if (!jobController && (fromWorkspace
          || (runDirectory?.toLowerCase() === controllerPath
            && /\bnode(?:\.exe)?\s+['"]?(?:\.\/)?scripts[/\\]/i.test(step.run)))) {
          throw Error('VALIDATION_CONTROLLER_CHECKOUT_MISSING ' + path);
        }
        if (violatesControllerMountPolicy(step.run, runDirectory)) {
          throw Error('VALIDATION_CONTROLLER_MOUNT_MUTATION ' + path);
        }
      }
      if (typeof step.uses !== 'string') continue;
      if (controllerAction.test(step.uses)) controllerPins.push(step.uses.slice(step.uses.lastIndexOf('@') + 1));
      if (!isCheckout(step.uses)) continue;
      const repository = step.with?.repository;
      if (typeof repository === 'string' && repository.includes('${{')) {
        throw Error('VALIDATION_CONTROLLER_CHECKOUT_REPOSITORY_EXPRESSION ' + path);
      }
      const mount = step.with?.path;
      if (typeof mount === 'string' && mount.includes('${{')) {
        throw Error('VALIDATION_CONTROLLER_CHECKOUT_MOUNT ' + path);
      }
      if (typeof repository !== 'string' || repository.toLowerCase() !== controllerRepository) {
        if (isControllerMount(mount)) {
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
        primaryCheckoutJobs.add(jobId);
        controllerPins.push(jobController);
      }
    }
  }
  if (!primaryCheckoutJobs.size) throw Error('VALIDATION_CONTROLLER_CHECKOUT_MISSING ' + path);
  const jobValues = jobs.map(([, job]) => job);
  if (path.endsWith('/pages.yml')) {
    if (!['select', 'deploy'].every(job => primaryCheckoutJobs.has(job))) {
      throw Error('VALIDATION_CONTROLLER_CHECKOUT_MISSING ' + path);
    }
    if (!workflow.jobs?.select?.steps?.some(step => step.run === 'node controller/scripts/select-pages-source.mjs')
      || !workflow.jobs?.deploy?.steps?.some(step => step.run === 'node controller/scripts/pages-runtime.mjs check')) {
      throw Error('VALIDATION_CONTROLLER_PAGES_RUNTIME_CHECKS');
    }
    const variable = 'STEWARD_CONTROLLER_SHA';
    controllerPins.push(workflow.env?.[variable]);
    for (const {env} of [...jobValues, ...jobValues.flatMap(job => job.steps ?? [])]) {
      if (env && Object.hasOwn(env, variable)) controllerPins.push(env[variable]);
    }
  }
  const reusable = jobValues.filter(job => typeof job.uses === 'string'
    && job.uses.toLowerCase().startsWith(controllerWorkflowPrefix));
  if (path === publishWorkflow && !reusable.some(job =>
    job.uses.toLowerCase().startsWith(controllerWorkflowPrefix + 'product-release.yml@'))) {
    throw Error('VALIDATION_CONTROLLER_REUSABLE_WORKFLOW_MISSING ' + path);
  }
  controllerPins.push(...reusable.map(job => job.uses.slice(job.uses.lastIndexOf('@') + 1)));
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
