import * as core from '@actions/core';
import { operationDefinitions, parseOperation, type StewardActionInputs } from './contracts.js';
import { createOperationContext, type StewardRuntimeEnvironment } from './context.js';
import { executeOperation } from './operations.js';
import { executeReleaseBuild, executeReleasePlan, parseReleaseAdapterPhase } from './release-adapter.js';
import { createReleasePreflight } from './release-preflight.js';
import { readReleaseStatus } from './release-status.js';
import { publishRelease } from './release-publish.js';

export const STEWARD_VERSION = '0.0.0-development';

export async function run(
  inputs: StewardActionInputs,
  environment: StewardRuntimeEnvironment = process.env,
  fetch?: typeof globalThis.fetch,
): Promise<void> {
  const operation = parseOperation(inputs.operation);
  core.setOutput('steward-version', STEWARD_VERSION);
  if (operation === 'version') {
    core.info(`SPLRAD Steward ${STEWARD_VERSION}`);
    return;
  }
  if (operation === 'release-adapter') {
    const workspace = inputs.releaseWorkspace?.trim() || environment.GITHUB_WORKSPACE?.trim() || '';
    const temporaryDirectory = environment.RUNNER_TEMP?.trim() || '';
    if (!workspace) throw new Error('release-adapter requires release-workspace or GITHUB_WORKSPACE');
    if (!temporaryDirectory) throw new Error('release-adapter requires RUNNER_TEMP');
    const executionInputs = {
      adapterCommand: inputs.releaseAdapterCommand ?? '',
      context: inputs.releaseContext ?? '',
      workspace,
      temporaryDirectory,
    };
    const phase = parseReleaseAdapterPhase(inputs.releaseAdapterPhase);
    core.setOutput('state', 'passed');
    if (phase === 'plan') {
      const plan = await executeReleasePlan(executionInputs);
      core.setOutput('release-plan', JSON.stringify(plan));
      core.setOutput('operation-result', JSON.stringify({
        operation, state: 'passed', summary: 'Release plan validated', details: { plan },
      }));
      core.info('release-adapter plan: plan validated');
    } else {
      const result = await executeReleaseBuild(executionInputs);
      core.setOutput('release-assets', JSON.stringify(result.assets));
      core.setOutput('release-output-directory', result.outputDirectory);
      core.setOutput('operation-result', JSON.stringify({
        operation,
        state: 'passed',
        summary: `${result.assets.assets.length} release assets validated`,
        details: result,
      }));
      core.info(`release-adapter build: ${result.assets.assets.length} assets validated`);
    }
    return;
  }
  if (inputs.token) core.setSecret(inputs.token);
  if (inputs.mutationToken) core.setSecret(inputs.mutationToken);
  if (operationDefinitions[operation].mutationToken && !inputs.mutationToken?.trim()) {
    throw new Error(`${operation} requires an explicit mutation token`);
  }
  if (operation === 'release-preflight') {
    const result = await createReleasePreflight({ inputs, environment, ...(fetch ? { fetch } : {}) });
    core.setOutput('state', result.state);
    core.setOutput('release-needed', String(result.state === 'passed'));
    core.setOutput('release-trigger', JSON.stringify(result.decision));
    if (result.context) core.setOutput('release-context', JSON.stringify(result.context));
    if (result.runner) core.setOutput('release-runner', result.runner);
    if (result.adapterCommand) core.setOutput('release-adapter-command', JSON.stringify(result.adapterCommand));
    core.setOutput('operation-result', JSON.stringify({ operation, ...result }));
    core.info(`release-preflight: ${result.summary}`);
    return;
  }
  if (operation === 'release-status') {
    const result = await readReleaseStatus({ inputs, environment, ...(fetch ? { fetch } : {}) });
    core.setOutput('state', result.decision.state === 'planned' ? 'passed' : 'ignored');
    core.setOutput('release-build-needed', String(result.decision.state === 'planned'));
    core.setOutput('release-publication', JSON.stringify(result.decision));
    core.setOutput('operation-result', JSON.stringify({ operation, ...result }));
    core.info(`release-status: ${result.decision.reason}`);
    return;
  }
  if (operation === 'release-publish') {
    const result = await publishRelease({ inputs, environment, ...(fetch ? { fetch } : {}) });
    core.setOutput('state', result.state);
    if (result.releaseUrl) core.setOutput('release-url', result.releaseUrl);
    core.setOutput('operation-result', JSON.stringify({ operation, ...result }));
    core.info(`release-publish: ${result.summary}`);
    return;
  }
  const context = await createOperationContext({
    inputs,
    environment,
    ...(fetch ? { fetch } : {}),
  });
  core.setOutput('governance-enabled', String(context.manifest.manifest.features.governance));
  core.setOutput('copilot-review-enabled', String(context.manifest.manifest.features.copilotReview));
  const result = await executeOperation(operation, context, inputs);
  core.setOutput('state', result.state);
  core.setOutput('operation-result', JSON.stringify(result));
  core.info(`${operation}: ${result.summary}`);
}
