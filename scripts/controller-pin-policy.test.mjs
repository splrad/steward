import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
import {adaptBuild, renderBuild} from './configuration-build.mjs';
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
    checkoutPath = 'controller', extraReusablePin, extraControllerWorkflowPin, localReference, pagesRuntime = true,
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
        if (extraControllerWorkflowPin) workflow.jobs.extra = {
          uses: 'splrad/steward/.github/workflows/check-inputs.yml@' + extraControllerWorkflowPin,
        };
        if (pagesRuntime) {
          workflow.jobs.select = {steps: [{run: 'node controller/scripts/select-pages-source.mjs'}]};
          workflow.jobs.deploy = {steps: [{run: 'node controller/scripts/pages-runtime.mjs check'}]};
        }
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
      const bytes = name === 'steward-release-publish' && publishBytes !== undefined
        ? publishBytes : YAML.stringify(workflow);
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
  const product = productRepository(t);
  const {pinFiles} = product;
  const prior = pinFiles(older);
  const updated = pinFiles(promoted);
  const next = pinFiles(unpromoted);
  const mixedPages = pinFiles(promoted, {pagePin: older});
  const mixedReusable = pinFiles(promoted, {reusablePin: older});
  const mixedReusableCase = pinFiles(promoted, {extraReusablePin: older});
  const extraReusable = pinFiles(promoted, {extraControllerWorkflowPin: promoted});
  const mixedOtherWorkflow = pinFiles(promoted, {extraControllerWorkflowPin: older});
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
  assert.throws(() => validate(updated, prior), /VALIDATION_CONTROLLER_DOWNGRADE/);
  assert.throws(() => validate(updated, next), /VALIDATION_CONTROLLER_NOT_PROMOTED/);
  assert.throws(() => validate(prior, mixedPages), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.throws(() => validate(prior, mixedReusable), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.throws(() => validate(prior, mixedReusableCase), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.doesNotThrow(() => validate(prior, extraReusable));
  assert.throws(() => validate(prior, mixedOtherWorkflow), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
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
