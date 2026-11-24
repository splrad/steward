import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
import {adaptBuild, renderBuild} from './test/fixtures/legacy-build-workflow.mjs';
import {git} from './validation-input.mjs';
import {verifyLayerScapeControllerPins} from './controller-pin-policy.mjs';

const workflows = ['channel-preflight', 'pages', 'steward-release-channels', 'steward-release-publish'];
const publishPath = '.github/workflows/steward-release-publish.yml';
function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'controller-pin-policy-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  git(dir, ['init', '-q']);
  const commit = message => {
    git(dir, ['add', '--all']);
    git(dir, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--no-gpg-sign', '--allow-empty', '-qm', message]);
    return git(dir, ['rev-parse', 'HEAD']).toString().trim();
  };
  return {dir, commit};
}

function productRepository(t) {
  const product = repository(t);
  const workflowDir = join(product.dir, '.github', 'workflows');
  mkdirSync(workflowDir, {recursive: true});
  function pinFiles(pin, {
    pagePin = pin, reusablePin = pin, pagesJobPin, pagesStepPin, extraCheckout, publishBytes,
    checkoutPath = 'controller', extraReusablePin, extraControllerWorkflowPin, localReference,
    pagesRuntime = true, extraControllerActionPin, extraRun, pagesWorkdir, selectWorkdir,
    omitPagesCheckout, omitWorkflowCheckout, nativePagesBuild = false, version, omitLabelFrom,
  } = {}) {
    for (const name of workflows) {
      const workflow = {jobs: {sample: {steps: [
        {uses: 'actions/checkout@' + '0'.repeat(40), with: {repository: 'splrad/steward', ref: pin, path: checkoutPath}},
      ]}}};
      if (extraCheckout) workflow.jobs.sample.steps.push({
        uses: 'Actions/Checkout@' + '0'.repeat(40),
        with: extraCheckout,
      });
      if (localReference === 'action') workflow.jobs.sample.steps.push({uses: './.github/actions/prepare'});
      if (localReference === 'workflow') workflow.jobs.extra = {uses: './.github/workflows/prepare.yml'};
      if (name === 'pages') {
        if (extraControllerActionPin) workflow.jobs.sample.steps.push({
          uses: 'splrad/steward/.github/actions/check-inputs@' + extraControllerActionPin,
        });
        if (extraRun) workflow.jobs.sample.steps.push(extraRun);
        if (extraControllerWorkflowPin) workflow.jobs.extra = {
          uses: 'splrad/steward/.github/workflows/check-inputs.yml@' + extraControllerWorkflowPin,
        };
        const checkout = workflow.jobs.sample.steps[0];
        const pagesSteps = {
          select: 'node controller/scripts/select-pages-source.mjs',
          build: nativePagesBuild ? 'node product/scripts/build-pages.mjs' : 'node controller/scripts/build-pages.mjs',
          deploy: 'node controller/scripts/pages-runtime.mjs check',
        };
        for (const [job, run] of Object.entries(pagesSteps)) {
          workflow.jobs[job] = {steps: job === omitPagesCheckout ? [] : [structuredClone(checkout)]};
          if (pagesRuntime) workflow.jobs[job].steps.push({run});
        }
        if (pagesWorkdir) workflow.defaults = {run: {'working-directory': pagesWorkdir}};
        if (selectWorkdir) workflow.jobs.select.steps.at(-1)['working-directory'] = selectWorkdir;
        workflow.env = {STEWARD_CONTROLLER_SHA: pagePin};
        if (pagesJobPin !== undefined) workflow.jobs.sample.env = {STEWARD_CONTROLLER_SHA: pagesJobPin};
        if (pagesStepPin !== undefined) workflow.jobs.sample.steps[0].env = {STEWARD_CONTROLLER_SHA: pagesStepPin};
      }
      if (name === 'steward-release-publish') {
        workflow.jobs.build = {uses: 'splrad/steward/.github/workflows/product-release.yml@' + reusablePin};
        if (extraReusablePin) workflow.jobs.extraBuild = {
          uses: 'SPLRAD/Steward/.github/workflows/product-release.yml@' + extraReusablePin,
        };
      }
      if (name === omitWorkflowCheckout) workflow.jobs.sample.steps.shift();
      let bytes = name === 'steward-release-publish' && publishBytes !== undefined
        ? publishBytes : YAML.stringify(workflow);
      if (version && name !== omitLabelFrom) bytes = bytes.replaceAll(pin, pin + ' # ' + version);
      writeFileSync(join(workflowDir, name + '.yml'), bytes);
    }
    return product.commit('product workflow pins');
  }
  return {dir: product.dir, pinFiles};
}

test('requires forward promotion and consistent Steward references when LayerScape pins change', t => {
  const upstream = repository(t);
  const older = upstream.commit('older');
  const promoted = upstream.commit('promoted');
  const unpromoted = upstream.commit('unpromoted');
  const tags = new Map([[older, 'controller-v1'], [promoted, 'controller-v2'], [unpromoted, 'controller-v3']]);
  for (const [sha, tag] of tags) git(upstream.dir, ['tag', tag, sha]);
  const product = productRepository(t);
  const pinFiles = (sha, options) => product.pinFiles(sha, {version: tags.get(sha), ...options});
  const prior = pinFiles(older);
  const updated = pinFiles(promoted);
  const next = pinFiles(unpromoted);
  const mixedPages = pinFiles(promoted, {pagePin: older});
  const mixedReusable = pinFiles(promoted, {reusablePin: older});
  const mixedReusableCase = pinFiles(promoted, {extraReusablePin: older});
  const extraReusable = pinFiles(promoted, {extraControllerWorkflowPin: promoted});
  const mixedOtherWorkflow = pinFiles(promoted, {extraControllerWorkflowPin: older});
  const extraAction = pinFiles(promoted, {extraControllerActionPin: promoted});
  const mixedAction = pinFiles(promoted, {extraControllerActionPin: older});
  const checkoutMutation = pinFiles(promoted, {extraRun: {'working-directory': 'controller', run: 'git restore -- package.json'}});
  const directFileMutation = pinFiles(promoted, {extraRun: {run: 'Remove-Item controller/build.cache'}});
  const readOnlyRun = pinFiles(promoted, {extraRun: {'working-directory': 'controller', run: 'git status --short'}});
  const safeWorkspaceRoot = pinFiles(promoted, {selectWorkdir: '${{ github.workspace }}'});
  const wrongPagesDirectory = pinFiles(promoted, {selectWorkdir: 'product'});
  const inheritedPagesDirectory = pinFiles(promoted, {pagesWorkdir: 'product'});
  const unresolvedDirectory = pinFiles(promoted, {
    extraRun: {'working-directory': '${{ inputs.workdir }}', run: 'git status --short'},
  });
  const declaredMutations = [
    {run: 'echo unexpected > ./controller/build.cache'},
    {run: 'tar -xf fixture.tar -C controller'},
    {run: '[IO.File]::WriteAllText("controller/build.cache", "unexpected")'},
    {'working-directory': 'controller', run: 'Remove-Item build.cache'},
    {'working-directory': '${{ github.workspace }}/controller', run: 'git restore -- package.json'},
  ].map(extraRun => pinFiles(promoted, {extraRun}));
  const missingPagesCheckout = pinFiles(promoted, {omitPagesCheckout: 'select'});
  const nativeBuildWithoutController = pinFiles(promoted, {omitPagesCheckout: 'build', nativePagesBuild: true});
  const controllerBuildWithoutCheckout = pinFiles(promoted, {omitPagesCheckout: 'build'});
  const reusableWithoutCheckout = pinFiles(promoted, {omitWorkflowCheckout: 'steward-release-publish'});
  const invalidMount = pinFiles(promoted, {checkoutPath: 'elsewhere'});
  const missingMount = pinFiles(promoted, {checkoutPath: null});
  const expressionMount = pinFiles(promoted, {extraCheckout: {path: '${{ inputs.checkout_path }}'}});
  const invalidNestedMount = pinFiles(promoted, {extraCheckout: {path: './Controller/nested'}});
  const mixedCheckout = pinFiles(promoted, {
    extraCheckout: {repository: 'SPLRAD/Steward', ref: older, path: 'controller'},
  });
  const expressionCheckout = pinFiles(promoted, {
    extraCheckout: {repository: '${{ github.repository }}', ref: promoted},
  });
  const mixedPagesJob = pinFiles(promoted, {pagesJobPin: older});
  const mixedPagesStep = pinFiles(promoted, {pagesStepPin: unpromoted});
  const consistentPagesEnv = pinFiles(promoted, {pagesJobPin: promoted, pagesStepPin: promoted});
  const localAction = pinFiles(promoted, {localReference: 'action'});
  const localWorkflow = pinFiles(promoted, {localReference: 'workflow'});
  const pagesWithoutChecks = pinFiles(promoted, {pagesRuntime: false});
  const inputs = (base, head) => ({
    repositoryId: 1187527897, base, head, changedPaths: ['.github/workflows/pages.yml'],
  });
  const validate = (base, head, current = promoted) =>
    verifyLayerScapeControllerPins(product.dir, inputs(base, head), upstream.dir, current);

  assert.doesNotThrow(() => validate(prior, updated));
  assert.doesNotThrow(() => validate(updated, updated, unpromoted));
  assert.throws(() => validate(updated, prior), /VALIDATION_CONTROLLER_VERSION_DOWNGRADE/);
  assert.throws(() => validate(updated, next), /VALIDATION_CONTROLLER_NOT_PROMOTED/);
  assert.throws(() => validate(prior, mixedPages), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.throws(() => validate(prior, mixedReusable), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.throws(() => validate(prior, mixedReusableCase), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.doesNotThrow(() => validate(prior, extraReusable));
  assert.throws(() => validate(prior, mixedOtherWorkflow), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.doesNotThrow(() => validate(prior, extraAction));
  assert.throws(() => validate(prior, mixedAction), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.throws(() => validate(prior, checkoutMutation), /VALIDATION_CONTROLLER_MOUNT_MUTATION/);
  assert.throws(() => validate(prior, directFileMutation), /VALIDATION_CONTROLLER_MOUNT_MUTATION/);
  for (const head of declaredMutations) assert.throws(() => validate(prior, head), /VALIDATION_CONTROLLER_MOUNT_MUTATION/);
  assert.doesNotThrow(() => validate(prior, readOnlyRun));
  assert.doesNotThrow(() => validate(prior, safeWorkspaceRoot));
  for (const head of [wrongPagesDirectory, inheritedPagesDirectory, unresolvedDirectory]) {
    assert.throws(() => validate(prior, head), /VALIDATION_CONTROLLER_RUN_DIRECTORY/);
  }
  assert.throws(() => validate(prior, missingPagesCheckout), /VALIDATION_CONTROLLER_CHECKOUT_MISSING/);
  assert.doesNotThrow(() => validate(prior, nativeBuildWithoutController));
  assert.throws(() => validate(prior, controllerBuildWithoutCheckout), /VALIDATION_CONTROLLER_CHECKOUT_MISSING/);
  assert.throws(() => validate(prior, reusableWithoutCheckout), /VALIDATION_CONTROLLER_CHECKOUT_MISSING/);
  assert.throws(() => validate(prior, invalidMount), /VALIDATION_CONTROLLER_CHECKOUT_MOUNT/);
  assert.throws(() => validate(prior, missingMount), /VALIDATION_CONTROLLER_CHECKOUT_MOUNT/);
  assert.throws(() => validate(prior, expressionMount), /VALIDATION_CONTROLLER_CHECKOUT_MOUNT/);
  assert.throws(() => validate(prior, invalidNestedMount), /VALIDATION_CONTROLLER_CHECKOUT_MOUNT/);
  assert.throws(() => validate(prior, mixedCheckout), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.throws(() => validate(prior, expressionCheckout), /VALIDATION_CONTROLLER_CHECKOUT_REPOSITORY_EXPRESSION/);
  assert.throws(() => validate(prior, mixedPagesJob), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.throws(() => validate(prior, mixedPagesStep), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.doesNotThrow(() => validate(prior, consistentPagesEnv));
  assert.throws(() => validate(prior, localAction), /VALIDATION_CONTROLLER_LOCAL_USES/);
  assert.throws(() => validate(prior, localWorkflow), /VALIDATION_CONTROLLER_LOCAL_USES/);
  assert.throws(() => validate(prior, pagesWithoutChecks), /VALIDATION_CONTROLLER_PAGES_RUNTIME_CHECKS/);
  assert.doesNotThrow(() => verifyLayerScapeControllerPins(
    product.dir, {...inputs(updated, prior), repositoryId: 1296724484}, upstream.dir, promoted,
  ));
});

test('checks independently promoted archive reader revisions from the configuration producer', t => {
  const upstream = repository(t);
  const controller = upstream.commit('release controller');
  const older = upstream.commit('first archive reader');
  const promoted = upstream.commit('current archive reader');
  const product = productRepository(t);
  const seed = readFileSync(new URL('../templates/release/steward-release-publish.yml', import.meta.url), 'utf8');
  const target = unit => ({
    unit, target: 'native', files: [{id: unit, path: unit + '.zip'}],
    recipe: {runner: 'ubuntu-24.04', output: 'out', steps: [{run: 'node product/.github/actions/configuration/' + unit + '/native/run.mjs',
      name: 'Run reviewed packaging entry', shell: 'pwsh'}]},
  });
  const native = unit => ({
    ...target(unit),
    recipe: {runner: 'ubuntu-24.04', native: {workflow: '.github/workflows/build.yml', job: 'pack', archive: 'dist'}},
  });
  const generated = renderBuild(seed, [target('one'), target('two')], {signing: 'not-applicable', controllerSha: controller});
  const first = adaptBuild(generated, seed, [native('one')], older);
  const second = adaptBuild(first, seed, [native('two')], promoted);
  const bothCurrent = adaptBuild(second, seed, [native('one')], promoted);
  const commit = publishBytes => product.pinFiles(controller, {publishBytes});
  const base = commit(generated);
  const firstReader = commit(first);
  const secondReader = commit(second);
  const currentReaders = commit(bothCurrent);
  const invalidWiring = commit(first.replace('Install native archive reader dependencies', 'Install dependencies'));
  const sharedController = commit(adaptBuild(generated, seed, [native('one')], controller));
  const withoutCheckout = YAML.parse(first);
  withoutCheckout.jobs.build.steps = withoutCheckout.jobs.build.steps.filter(step =>
    !['Check out native archive reader', 'Install native archive reader dependencies'].includes(step.name));
  const orphanedReader = commit(YAML.stringify(withoutCheckout));

  const verify = (base, head, current) => verifyLayerScapeControllerPins(product.dir, {
    repositoryId: 1187527897, base, head, changedPaths: [publishPath],
  }, upstream.dir, current);
  assert.doesNotThrow(() => verify(base, firstReader, older));
  assert.doesNotThrow(() => verify(base, sharedController, controller));
  assert.throws(() => verify(firstReader, sharedController, older), /VALIDATION_CONTROLLER_DOWNGRADE/);
  assert.throws(() => verify(base, firstReader, promoted), /VALIDATION_CONTROLLER_NOT_PROMOTED/);
  assert.doesNotThrow(() => verify(firstReader, secondReader, promoted));
  assert.doesNotThrow(() => verify(secondReader, currentReaders, promoted));
  assert.throws(() => verify(currentReaders, secondReader, promoted), /VALIDATION_CONTROLLER_DOWNGRADE/);
  assert.throws(() => verify(base, invalidWiring, older), /VALIDATION_CONTROLLER_ARCHIVE_READER_WIRING/);
  assert.throws(() => verify(base, orphanedReader, older), /VALIDATION_CONTROLLER_ARCHIVE_READER_WIRING/);
});

test('binds the visible controller version to its protected tag at the four-digit boundary', t => {
  const upstream = repository(t);
  const older = upstream.commit('controller version 999');
  const promoted = upstream.commit('controller version 1000');
  git(upstream.dir, ['tag', 'controller-v999', older]);
  git(upstream.dir, ['tag', 'controller-v1000', promoted]);
  const product = productRepository(t);
  const initial = product.pinFiles(older);
  const versioned = product.pinFiles(older, {version: 'controller-v999'});
  const unlabeledAdvance = product.pinFiles(promoted);
  const upgraded = product.pinFiles(promoted, {version: 'controller-v1000'});
  const missing = product.pinFiles(promoted, {version: 'controller-v1000', omitLabelFrom: 'pages'});
  const wrong = product.pinFiles(promoted, {version: 'controller-v999'});
  const unknown = product.pinFiles(promoted, {version: 'controller-v1001'});
  const verify = (base, head, current = promoted) => verifyLayerScapeControllerPins(product.dir, {
    repositoryId: 1187527897, base, head, changedPaths: ['.github/workflows/pages.yml'],
  }, upstream.dir, current);
  assert.doesNotThrow(() => verify(initial, versioned));
  assert.throws(() => verify(initial, unlabeledAdvance), /VALIDATION_CONTROLLER_VERSION_LABELS/);
  assert.doesNotThrow(() => verify(versioned, upgraded));
  assert.throws(() => verify(upgraded, versioned), /VALIDATION_CONTROLLER_VERSION_DOWNGRADE/);
  assert.throws(() => verify(versioned, missing), /VALIDATION_CONTROLLER_VERSION_LABELS/);
  assert.throws(() => verify(versioned, initial), /VALIDATION_CONTROLLER_VERSION_LABELS/);
  assert.throws(() => verify(versioned, wrong), /VALIDATION_CONTROLLER_VERSION_SHA_MISMATCH/);
  assert.throws(() => verify(versioned, unknown), /VALIDATION_CONTROLLER_VERSION_TAG_MISSING/);
});

test('accepts a native v3 publisher only with admitted, attested GitHub delivery', t => {
  const upstream = repository(t);
  const pin = upstream.commit('promoted controller');
  const product = productRepository(t);
  const before = product.pinFiles(pin);
  const checkout = (path, ref, repository) => ({
    uses: 'actions/checkout@' + '0'.repeat(40),
    with: {path, ref, repository, 'persist-credentials': false},
  });
  const inputs = ['cycle_id', 'operation_key', 'source_sha', 'controller_sha'];
  const shippedPaths = '${{ runner.temp }}/delivery/*';
  const workflow = {
    'run-name': 'Build ${{ inputs.operation_key }}',
    on: {workflow_dispatch: {inputs: Object.fromEntries(inputs.map(key => [key, {type: 'string', required: true}]))}},
    jobs: {
      admit: {steps: [
        checkout('product', '${{ github.sha }}'),
        checkout('controller', pin, 'splrad/steward'),
        checkout('state', 'steward/release-state'),
        {shell: 'pwsh', env: Object.fromEntries(inputs.map(key => [key.toUpperCase(), '${{ inputs.' + key + ' }}'])),
          run: 'node controller/packages/runner/dist/index.js release-pipeline identity ' +
            inputs.map(key => '--' + key.replaceAll('_', '-') + ' "$env:' + key.toUpperCase() + '"').join(' ') +
            ' --source-dir product --controller-dir controller --state-dir state --output identity.json\n' +
            'if ($LASTEXITCODE) { exit $LASTEXITCODE }'},
      ]},
      delivery: {
        name: 'delivery/root',
        needs: 'admit',
        permissions: {'id-token': 'write', attestations: 'write'},
        steps: [
          {uses: 'actions/attest@' + '0'.repeat(40), with: {'subject-path': shippedPaths}},
          {id: 'upload-github-release', name: 'Upload GitHub release delivery',
            uses: 'actions/upload-artifact@' + '0'.repeat(40), with: {
              name: 'delivery-github-release-${{ github.repository_id }}-root-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
              path: shippedPaths,
            }},
        ],
      },
    },
  };
  function revision(change = () => {}, delivery = {schemaVersion: 3}, settings = {packages:{'.':{}}}) {
    const candidate = structuredClone(workflow);
    change(candidate);
    writeFileSync(join(product.dir, '.github/delivery.json'), JSON.stringify(delivery));
    writeFileSync(join(product.dir, 'release-please-config.json'), JSON.stringify(settings));
    const bytes = YAML.stringify(candidate);
    if (delivery.buildWorkflow) writeFileSync(join(product.dir, delivery.buildWorkflow), bytes);
    return product.pinFiles(pin, {publishBytes: delivery.buildWorkflow ? undefined : bytes});
  }
  function verify(head, changedPaths = [publishPath, '.github/delivery.json']) {
    verifyLayerScapeControllerPins(product.dir, {repositoryId: 1187527897, base: before, head, changedPaths}, upstream.dir, pin);
  }

  const releaseConfig='release-please-config.json';
  const adopted=revision(undefined,{schemaVersion:3},{packages:{'.':{draft:true,'force-tag-creation':true}}});
  function verifyOfficialDraft(head,changedPaths=[releaseConfig],repositoryId=1187527897) {
    verifyLayerScapeControllerPins(product.dir,{repositoryId,base:adopted,head,changedPaths},upstream.dir,pin);
  }
  const inherited={draft:true,'force-tag-creation':true,packages:{'.':{}}};
  assert.doesNotThrow(()=>verifyOfficialDraft(revision(undefined,{schemaVersion:3},inherited)));
  for(const setting of ['draft','force-tag-creation']) {
    const head=revision(undefined,{schemaVersion:3},{...inherited,packages:{'.':{[setting]:false}}});
    assert.throws(()=>verifyOfficialDraft(head),/VALIDATION_CONTROLLER_OFFICIAL_DRAFT_REQUIRED/);
    assert.doesNotThrow(()=>verifyOfficialDraft(head,['src/widget.cs']));
    assert.doesNotThrow(()=>verifyOfficialDraft(head,[releaseConfig],123));
  }
  const downgraded=revision(undefined,{schemaVersion:2},{packages:{'.':{draft:false}}});
  assert.throws(()=>verifyOfficialDraft(downgraded,[releaseConfig,'.github/delivery.json']),/VALIDATION_CONTROLLER_OFFICIAL_DRAFT_REQUIRED/);
  const additional=revision(undefined,{schemaVersion:3},{packages:{'.':{draft:true,'force-tag-creation':true},tools:{draft:false}}});
  assert.throws(()=>verifyOfficialDraft(additional),/VALIDATION_CONTROLLER_OFFICIAL_DRAFT_REQUIRED/);

  assert.doesNotThrow(() => verify(revision()));
  assert.throws(() => verify(revision(undefined, {schemaVersion: 2})), /REUSABLE_WORKFLOW_MISSING/);
  assert.throws(() => verify(revision(doc => delete doc.on.workflow_dispatch.inputs.cycle_id)), /dispatch workflow interface/);
  assert.throws(() => verify(revision(doc => doc.jobs.delivery.steps.length = 1)), /NATIVE_DELIVERY/);
  assert.throws(() => verify(revision(doc => {
    doc.jobs.delivery.steps.shift();
    doc.jobs.delivery.steps[0].env = {STEWARD_DELIVERY_ATTESTED: true};
  })), /NATIVE_ATTESTATION/);
  assert.throws(() => verify(revision(doc => doc.jobs.delivery.steps[0].with['subject-path'] = 'other/*')), /NATIVE_ATTESTATION/);
  assert.throws(() => verify(revision(doc => delete doc.jobs.delivery.permissions.attestations)), /NATIVE_ATTESTATION/);
  assert.throws(() => verify(revision(doc => doc.jobs.admit.steps[3].env.CONTROLLER_SHA = pin)), /NATIVE_ADMISSION/);
  assert.throws(() => verify(revision(doc => doc.jobs.admit.steps[3]['continue-on-error'] = true)), /NATIVE_ADMISSION/);
  assert.throws(() => verify(revision(doc => {
    const identity = doc.jobs.admit.steps[3];
    identity.run = 'if ($false) {\n' + identity.run + '\n}';
  })), /NATIVE_ADMISSION/);
  assert.throws(() => verify(revision(doc => doc.jobs.admit.steps[3].run += '\nexit 0')), /NATIVE_ADMISSION/);
  assert.throws(() => verify(revision(doc => doc.jobs.admit.steps[3].shell = 'bash')), /NATIVE_ADMISSION/);
  assert.throws(() => verify(revision(doc => doc.jobs.admit.steps[1].with['persist-credentials'] = true)), /NATIVE_ADMISSION/);
  assert.throws(() => verify(revision(doc => delete doc.jobs.delivery.needs)), /NATIVE_ADMISSION/);
  assert.throws(() => verify(revision(doc => doc.jobs.delivery.if = 'always()')), /NATIVE_ADMISSION/);
  assert.doesNotThrow(() => verify(revision(doc => {
    doc.jobs.prepare = {needs: 'admit', steps: [{run: 'prepare'}]};
    doc.jobs.delivery.needs = ['admit', 'prepare'];
  })));
  assert.throws(() => verify(revision(doc => {
    doc.jobs.prepare = {steps: [{run: 'unadmitted build'}]};
    doc.jobs.delivery.needs = ['admit', 'prepare'];
  })), /NATIVE_ADMISSION/);
  assert.throws(() => verify(revision(doc => {
    doc.jobs.prepare = {needs: 'admit', if: 'always()', steps: [{run: 'unadmitted build'}]};
    doc.jobs.delivery.needs = ['prepare'];
  })), /NATIVE_ADMISSION/);
  assert.throws(() => verify(revision(doc => delete doc.jobs.delivery.needs), ['.github/delivery.json']), /NATIVE_ADMISSION/);
  for (const [channel, name, location] of [
    ['ghcr-assets', 'Upload GHCR assets delivery', 'ghcr.io/splrad/fixture'],
    ['winget', 'Upload WinGet delivery', 'Fixture.Tool'],
  ]) {
    const paths = '${{ runner.temp }}/' + channel + '/*';
    const deliveryStep = {
      id: 'upload-' + channel, name, uses: 'actions/upload-artifact@' + '0'.repeat(40),
      env: {STEWARD_CHANNEL_LOCATION: location},
      with: {
        name: 'delivery-' + channel + '-${{ github.repository_id }}-root-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
        path: paths,
      },
    };
    const attest = {uses: 'actions/attest@' + '0'.repeat(40), with: {'subject-path': paths}};
    assert.doesNotThrow(() => verify(revision(doc => doc.jobs.delivery.steps.push(attest, deliveryStep))));
    assert.throws(() => verify(revision(doc => doc.jobs.delivery.steps.push({
      ...deliveryStep, env: {...deliveryStep.env, STEWARD_DELIVERY_ATTESTED: true},
    }))), /NATIVE_ATTESTATION/);
    assert.throws(() => verify(revision(doc => {
      doc.jobs.unadmitted = {
        name: 'delivery/root', permissions: {...doc.jobs.delivery.permissions}, steps: [attest, deliveryStep],
      };
    })), /NATIVE_ADMISSION/);
  }
  const buildWorkflow = '.github/workflows/native-product-build.yml';
  assert.doesNotThrow(() => verify(revision(undefined, {schemaVersion: 3, buildWorkflow}), [buildWorkflow, '.github/delivery.json']));
  assert.throws(() => verify(revision(doc => delete doc.jobs.delivery.needs, {schemaVersion: 3, buildWorkflow}), [buildWorkflow]), /NATIVE_ADMISSION/);
  const legacy = {schemaVersion: 2, buildWorkflow, units: [{
    id: 'layerscape', path: '.', notesPath: '.release-notes/layerscape.md',
    assets: [{id: 'installer', name: 'Setup.exe', mediaType: 'application/vnd.microsoft.portable-executable'}],
    channels: [{id: 'github-release', required: true, location: 'github', artifactIds: ['installer']}],
  }]};
  assert.throws(() => verify(revision(undefined, legacy), [buildWorkflow]), /REUSABLE_WORKFLOW_MISSING/);
  const setLegacyReusable = ref => {
    writeFileSync(join(product.dir, buildWorkflow), YAML.stringify({
      jobs: {
        select: {steps: [checkout('controller', pin, 'splrad/steward')]},
        build: {uses: 'splrad/steward/.github/workflows/product-release.yml@' + ref},
      },
    }));
    return product.pinFiles(pin);
  };
  assert.doesNotThrow(() => verify(setLegacyReusable(pin), [buildWorkflow]));
  assert.throws(() => verify(setLegacyReusable('x'.repeat(40)), [buildWorkflow]), /VALIDATION_CONTROLLER_PIN_INVALID/);
});
