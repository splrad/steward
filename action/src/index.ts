import * as core from '@actions/core';
import { run } from './main.js';

try {
  run(core.getInput('operation', { required: true }));
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
