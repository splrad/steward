import {posix} from 'node:path';
import YAML from 'yaml';
import {git} from './validation-input.mjs';
import {controllerTagPrefix,controllerVersionNumber} from './controller-version.mjs';
import {applyWorkflowDelivery,assertProductDelivery,decodeBuildJson,defaultBuildWorkflow,
  parseDeliveryConfig,verifyDispatchWorkflow} from '../packages/runner/dist/index.js';

const layerScapeId = 1187527897;
const controllerRepository = 'splrad/steward';
const controllerWorkflowPrefix = controllerRepository + '/.github/workflows/';
const deliveryFile = '.github/delivery.json';
const releasePleaseFile = 'release-please-config.json';
const controllerPath = 'controller';
const archiveReaderPath = 'configuration-controller';
const archiveReaderCommand = 'node scripts/configuration-native-artifact.mjs';
const controllerMounts = [controllerPath, archiveReaderPath];
const managedWorkflows = [
  '.github/workflows/channel-preflight.yml',
  '.github/workflows/pages.yml',
  '.github/workflows/steward-release-channels.yml',
  defaultBuildWorkflow,
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

function publisherAt(repo, revision) {
  const entry = git(repo, ['ls-tree', revision, '--', deliveryFile]);
  if (!entry.length) return {path: defaultBuildWorkflow};
  if (!entry.toString().startsWith('100644 blob ')) throw Error('VALIDATION_CONTROLLER_DELIVERY_DECLARATION');
  const raw = decodeBuildJson(git(repo, ['cat-file', 'blob', revision + ':' + deliveryFile]));
  if (raw?.schemaVersion !== 3) {
    const path = raw?.schemaVersion === 2 && raw.buildWorkflow !== undefined
      ? parseDeliveryConfig(raw).buildWorkflow : defaultBuildWorkflow;
    return {path};
  }
  const settings = decodeBuildJson(git(repo, ['cat-file', 'blob', revision + ':' + releasePleaseFile]));
  const delivery = parseDeliveryConfig(raw, settings);
  return {path: delivery.buildWorkflow, delivery, settings};
}

function hasOfficialDraftSettings(settings) {
  const packages=settings?.packages,root=packages?.['.'];
  return Boolean(root && Object.keys(packages).length===1
    && (root.draft??settings.draft)===true
    && (root['force-tag-creation']??settings['force-tag-creation'])===true);
}

const successOnly = entry => !entry['continue-on-error'] &&
  (entry.if === undefined || entry.if === true ||
    /^(?:success\(\)|\$\{\{\s*success\(\)\s*\}\})$/.test(entry.if));
const artifactPaths = input => typeof input === 'string' ? input.split(/\r?\n/).map(path => path.trim()).filter(Boolean).sort().join('\n') : '';
const buildInputs = {cycle_id: '', operation_key: '', source_sha: '', controller_sha: ''};
const jobNeeds = job => typeof job.needs === 'string' ? [job.needs] : job.needs ?? [];
const admissionCommand = 'node controller/packages/runner/dist/index.js release-pipeline identity ' +
  Object.keys(buildInputs).map(input => '--' + input.replaceAll('_', '-') + ' "$env:' + input.toUpperCase() + '"').join(' ') +
  ' --source-dir product --controller-dir controller --state-dir state --output ';
// Match the supported PowerShell forms end to end so an identity-looking line cannot authorize a job.
const guardedRetry = String.raw`
  for ($n = 0; $n -lt 20; $n++) {
  ${admissionCommand}"identity-$n.json"
  if ($LASTEXITCODE -eq 0) {
  $identity = Get-Content -LiteralPath "identity-$n.json" -Raw | ConvertFrom-Json
  $units = @($identity.units)
  if ($identity.status -cne 'SOURCE_VERIFIED' -or $units.Count -ne 1 -or $units[0].unit -cne 'root') {
  throw 'Expected an admitted root release unit.'
  }
  $version = $units[0].version
  if ($version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or
  $units[0].tag -cne "v$version" -or $units[0].packageVersion -cne $version) {
  throw 'Admitted version, package version and tag must agree.'
  }
  "version=$version" >> $env:GITHUB_OUTPUT
  exit 0
  }
  if ($LASTEXITCODE -ne 75) { exit $LASTEXITCODE }
  Start-Sleep -Seconds 30
  git -C state fetch --no-tags origin refs/heads/steward/release-state
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  git -C state update-ref refs/heads/steward/release-state FETCH_HEAD
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  }
  exit 75
`;
const normalizedScript = run => run.trim().split(/\r?\n/).map(line => line.trim()).join('\n');
const identityScripts = new Set([
  normalizedScript(guardedRetry),
  admissionCommand + 'identity.json\nif ($LASTEXITCODE) { exit $LASTEXITCODE }',
]);

function verifyNativePublisher(workflow, bytes, {path, delivery}) {
  verifyDispatchWorkflow(bytes, {purpose: 'build', inputs: buildInputs, buildWorkflow: path});
  const handoff = applyWorkflowDelivery(delivery, bytes);
  if (delivery.units.some(unit => !handoff.units.get(unit.id)?.has('github-release'))) {
    throw Error('VALIDATION_CONTROLLER_NATIVE_DELIVERY ' + path);
  }
  assertProductDelivery(delivery);
  const jobs = new Map(Object.entries(workflow.jobs));
  const admission = [...jobs].find(([, job]) => successOnly(job) && jobNeeds(job).length === 0 && job.steps?.some((step, index) => {
    const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
    if (shell !== 'pwsh' || typeof step.run !== 'string' || !identityScripts.has(normalizedScript(step.run)) ||
        !successOnly(step)) return false;
    const binds = Object.keys(buildInputs).every(input =>
      new RegExp('^\\x24{{\\s*inputs\\.' + input + '\\s*}}$').test(step.env?.[input.toUpperCase()] ?? ''));
    const checkout = (mount, repository, ref) => job.steps.slice(0, index).some(step =>
      isCheckout(step.uses) && isPin(step.uses.split('@')[1]) && successOnly(step)
      && step.with?.path === mount && step.with.repository === repository
      && step.with['persist-credentials'] === false && ref(step.with.ref));
    return binds && checkout('controller', controllerRepository, isPin)
      && checkout('product', undefined, ref => ref === '${{ github.sha }}')
      && checkout('state', undefined, ref => ref === 'steward/release-state');
  }));
  if (!admission) throw Error('VALIDATION_CONTROLLER_NATIVE_ADMISSION ' + path);
  const admitted = new Map([[admission[0], true]]);
  const passesAdmission = id => {
    if (admitted.has(id)) return admitted.get(id);
    admitted.set(id, false);
    const job = jobs.get(id), needs = job && jobNeeds(job);
    const result = Boolean(job && successOnly(job) && Array.isArray(needs) && needs.length && needs.every(passesAdmission));
    admitted.set(id, result);
    return result;
  };
  const uploads = new Set([...handoff.units.values()].flatMap(channels =>
    [...channels.keys()].map(channel => 'upload-' + channel)));
  for (const [jobId, job] of jobs) {
    for (const [index, upload] of (job.steps ?? []).entries()) {
      if (!uploads.has(upload.id)) continue;
      const uploadPaths = artifactPaths(upload.with.path);
      const permissions = job.permissions ?? workflow.permissions;
      const attests = job.steps.slice(0, index).some(step => successOnly(step)
        && /^actions\/attest(?:-build-provenance)?@[a-f0-9]{40}$/.test(step.uses ?? '')
        && artifactPaths(step.with?.['subject-path']) === uploadPaths);
      if (!attests || permissions?.['id-token'] !== 'write' || permissions.attestations !== 'write') {
        throw Error('VALIDATION_CONTROLLER_NATIVE_ATTESTATION ' + path);
      }
      if (!successOnly(upload) || jobId === admission[0] || !passesAdmission(jobId)) {
        throw Error('VALIDATION_CONTROLLER_NATIVE_ADMISSION ' + path);
      }
    }
  }
}

function readWorkflowPins(repo, revision, path, archiveReaders, publisher) {
  const bytes = git(repo, ['cat-file', 'blob', revision + ':' + path]);
  const document = YAML.parseDocument(bytes.toString('utf8'));
  if (document.errors.length) throw document.errors[0];
  const workflow = document.toJS();
  const jobs = Object.entries(workflow?.jobs ?? {});
  const controllerPins = [];
  const primaryCheckoutJobs = new Set();
  const pin = (sha, location) => {
    const comment = document.getIn(location, true)?.comment?.trim();
    controllerPins.push({sha, version: comment?.startsWith('controller-v') ? comment : null});
  };
  for (const [jobId, job] of jobs) {
    const steps = job.steps ?? [];
    const mountsController = steps.some(step => isCheckout(step.uses) && isControllerMount(step.with?.path));
    let jobController;
    // The managed workflows declare controller entry points directly.
    if ([job, ...steps].some(entry => typeof entry.uses === 'string' && entry.uses.startsWith('./'))) {
      throw Error('VALIDATION_CONTROLLER_LOCAL_USES ' + path);
    }
    for (const [index, step] of steps.entries()) {
      if (path === defaultBuildWorkflow && jobId === 'build' && step.run === archiveReaderCommand) {
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
      if (controllerAction.test(step.uses)) {
        pin(step.uses.slice(step.uses.lastIndexOf('@') + 1), ['jobs', jobId, 'steps', index, 'uses']);
      }
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
      const archiveReader = path === defaultBuildWorkflow && jobId === 'build' && mount === archiveReaderPath;
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
        pin(jobController, ['jobs', jobId, 'steps', index, 'with', 'ref']);
      }
    }
  }
  if (!primaryCheckoutJobs.size) throw Error('VALIDATION_CONTROLLER_CHECKOUT_MISSING ' + path);
  if (path.endsWith('/pages.yml')) {
    if (!['select', 'deploy'].every(job => primaryCheckoutJobs.has(job))) {
      throw Error('VALIDATION_CONTROLLER_CHECKOUT_MISSING ' + path);
    }
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
  if (path === publisher.path && publisher.delivery) {
    verifyNativePublisher(workflow, bytes, publisher);
  } else if ((path === publisher.path || path === defaultBuildWorkflow) && !reusable.some(([, job]) =>
    job.uses.toLowerCase().startsWith(controllerWorkflowPrefix + 'product-release.yml@'))) {
    throw Error('VALIDATION_CONTROLLER_REUSABLE_WORKFLOW_MISSING ' + path);
  }
  for (const [jobId, job] of reusable) pin(job.uses.slice(job.uses.lastIndexOf('@') + 1), ['jobs', jobId, 'uses']);
  if (!controllerPins.every(({sha}) => isPin(sha))) throw Error('VALIDATION_CONTROLLER_PIN_INVALID ' + path);
  return controllerPins;
}

function readRevisionPins(workspace, revision, publisher) {
  const archiveReaders = new Map();
  const paths = new Set([...managedWorkflows, publisher.path]);
  if (publisher.path !== defaultBuildWorkflow
    && !git(workspace, ['ls-tree', revision, '--', defaultBuildWorkflow]).length) paths.delete(defaultBuildWorkflow);
  const pins = [...paths].flatMap(path => readWorkflowPins(workspace, revision, path, archiveReaders, publisher));
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
  if (input.repositoryId !== layerScapeId || !input.changedPaths.some(path =>
    path === deliveryFile || path === releasePleaseFile || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))) return;
  const priorPublisher = publisherAt(workspace, input.base);
  const nextPublisher = publisherAt(workspace, input.head);
  // Release Please reads the target branch again when the draft Action starts.
  // Keep these settings true even if a configuration PR merges during that window.
  if (priorPublisher.delivery && hasOfficialDraftSettings(priorPublisher.settings)
    && input.changedPaths.some(path=>path===releasePleaseFile||path===deliveryFile)
    && (!nextPublisher.delivery || !hasOfficialDraftSettings(nextPublisher.settings))) {
    throw Error('VALIDATION_CONTROLLER_OFFICIAL_DRAFT_REQUIRED');
  }
  const watched = [...managedWorkflows, priorPublisher.path, nextPublisher.path];
  if (priorPublisher.delivery || nextPublisher.delivery) watched.push(deliveryFile, releasePleaseFile);
  if (!input.changedPaths.some(path => watched.includes(path))) return;

  const before = readRevisionPins(workspace, input.base, priorPublisher);
  const after = readRevisionPins(workspace, input.head, nextPublisher);
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
