import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
import {git} from './validation-input.mjs';
import {verifyLayerScapeControllerPins} from './controller-pin-policy.mjs';

const workflows = ['channel-preflight', 'pages', 'steward-release-channels', 'steward-release-publish'];
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

test('requires forward promotion and consistent Steward references when LayerScape pins change', t => {
  const upstream = repository(t);
  const older = upstream.commit('older');
  const promoted = upstream.commit('promoted');
  const unpromoted = upstream.commit('unpromoted');
  const product = repository(t);
  const workflowDir = join(product.dir, '.github', 'workflows');
  mkdirSync(workflowDir, {recursive: true});
  function pinFiles(pin, {
    pagePin = pin, reusablePin = pin, pagesJobPin, pagesStepPin, extraCheckout,
  } = {}) {
    for (const name of workflows) {
      const workflow = {jobs: {sample: {steps: [
        {uses: 'actions/checkout@' + '0'.repeat(40), with: {repository: 'splrad/steward', ref: pin}},
      ]}}};
      if (extraCheckout) workflow.jobs.sample.steps.push({
        uses: 'Actions/Checkout@' + '0'.repeat(40),
        with: extraCheckout,
      });
      if (name === 'pages') {
        workflow.env = {STEWARD_CONTROLLER_SHA: pagePin};
        if (pagesJobPin !== undefined) workflow.jobs.sample.env = {STEWARD_CONTROLLER_SHA: pagesJobPin};
        if (pagesStepPin !== undefined) workflow.jobs.sample.steps[0].env = {STEWARD_CONTROLLER_SHA: pagesStepPin};
      }
      if (name === 'steward-release-publish') {
        workflow.jobs.build = {uses: 'splrad/steward/.github/workflows/product-release.yml@' + reusablePin};
      }
      writeFileSync(join(workflowDir, name + '.yml'), YAML.stringify(workflow));
    }
    return product.commit('product workflow pins');
  }
  const prior = pinFiles(older);
  const updated = pinFiles(promoted);
  const next = pinFiles(unpromoted);
  const mixedPages = pinFiles(promoted, {pagePin: older});
  const mixedReusable = pinFiles(promoted, {reusablePin: older});
  const mixedCheckout = pinFiles(promoted, {
    extraCheckout: {repository: 'SPLRAD/Steward', ref: older},
  });
  const expressionCheckout = pinFiles(promoted, {
    extraCheckout: {repository: '${{ github.repository }}', ref: promoted},
  });
  const mixedPagesJob = pinFiles(promoted, {pagesJobPin: older});
  const mixedPagesStep = pinFiles(promoted, {pagesStepPin: unpromoted});
  const consistentPagesEnv = pinFiles(promoted, {pagesJobPin: promoted, pagesStepPin: promoted});
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
  assert.throws(() => validate(prior, mixedCheckout), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.throws(() => validate(prior, expressionCheckout), /VALIDATION_CONTROLLER_CHECKOUT_REPOSITORY_EXPRESSION/);
  assert.throws(() => validate(prior, mixedPagesJob), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.throws(() => validate(prior, mixedPagesStep), /VALIDATION_CONTROLLER_PIN_MISMATCH/);
  assert.doesNotThrow(() => validate(prior, consistentPagesEnv));
  assert.doesNotThrow(() => verifyLayerScapeControllerPins(
    product.dir, {...inputs(updated, prior), repositoryId: 1296724484}, upstream.dir, promoted,
  ));
});
