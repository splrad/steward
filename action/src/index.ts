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
    releaseAdapterCommand: core.getInput('release-adapter-command'),
    releaseContext: core.getInput('release-context'),
    releaseWorkspace: core.getInput('release-workspace'),
    releaseAdapterPhase: core.getInput('release-adapter-phase'),
    releasePlan: core.getInput('release-plan'),
  });
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
