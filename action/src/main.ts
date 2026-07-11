import * as core from '@actions/core';
import { parseOperation, type StewardActionInputs } from './contracts.js';
import { createOperationContext, type StewardRuntimeEnvironment } from './context.js';
import { executeOperation } from './operations.js';

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
  if (inputs.token) core.setSecret(inputs.token);
  const context = await createOperationContext({
    inputs,
    environment,
    ...(fetch ? { fetch } : {}),
  });
  const result = await executeOperation(operation, context, inputs);
  core.setOutput('state', result.state);
  core.setOutput('operation-result', JSON.stringify(result));
  core.info(`${operation}: ${result.summary}`);
}
