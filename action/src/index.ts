import * as core from '@actions/core';
import { run } from './main.js';

try {
  await run({
    operation: core.getInput('operation', { required: true }),
    token: core.getInput('github-token'),
    mutationToken: core.getInput('mutation-token'),
    eventPath: core.getInput('event-path'),
    prNumber: core.getInput('pr-number'),
    headSha: core.getInput('head-sha'),
    requestResult: core.getInput('request-result'),
    matrixMode: core.getInput('matrix-mode'),
    matrixScope: core.getInput('matrix-scope'),
  });
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
