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
    expect(Object.keys(metadata.inputs ?? {})).toEqual([
      'operation',
      'github-token',
      'mutation-token',
      'event-path',
      'pr-number',
      'head-sha',
      'request-result',
      'matrix-mode',
      'matrix-scope',
    ]);
    expect(Object.keys(metadata.outputs ?? {})).toEqual([
      'steward-version',
      'state',
      'operation-result',
      'governance-enabled',
      'copilot-review-enabled',
    ]);
  });
});
