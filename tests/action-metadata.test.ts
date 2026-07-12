import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('Action metadata', () => {
  it('is valid YAML with the committed Node entrypoint and stable contract fields', async () => {
    const source = await readFile('action/action.yml', 'utf8');
    const metadata = parse(source) as {
      inputs?: Record<string, unknown>;
      outputs?: Record<string, unknown>;
      runs?: { using?: string; main?: string };
    };

    expect(metadata.runs).toEqual({ using: 'node24', main: 'dist/index.js' });
    expect(Object.keys(metadata.inputs ?? {}).sort()).toEqual([
      'operation',
      'github-token',
      'mutation-token',
      'event-path',
      'pr-number',
      'head-sha',
      'request-result',
      'matrix-mode',
      'matrix-scope',
      'release-adapter-command',
      'release-context',
      'release-workspace',
      'release-adapter-phase',
      'release-plan',
    ].sort());
    expect(Object.keys(metadata.outputs ?? {}).sort()).toEqual([
      'steward-version',
      'state',
      'operation-result',
      'governance-enabled',
      'copilot-review-enabled',
      'release-plan',
      'release-assets',
      'release-output-directory',
      'release-needed',
      'release-trigger',
      'release-context',
      'release-runner',
      'release-adapter-command',
      'release-build-needed',
      'release-publication',
    ].sort());
  });
});
