import * as core from '@actions/core';

export const STEWARD_VERSION = '0.0.0-development';

export function run(operation: string): void {
  if (operation !== 'version') {
    throw new Error(`Unsupported Steward operation: ${operation}`);
  }

  core.setOutput('steward-version', STEWARD_VERSION);
  core.info(`SPLRAD Steward ${STEWARD_VERSION}`);
}
