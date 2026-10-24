import { expect, it } from 'vitest';
import { acceptActionlintResult, validateQueueSyntax } from '../src/workflow-queue-compat.js';

const source = 'concurrency:\n  group: release\n  queue: max\n  cancel-in-progress: false\n';
const locations = validateQueueSyntax('/test.yml', source);
const diagnostic = { filepath: '/test.yml', line: 3, column: 3, kind: 'syntax-check',
  message: 'unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"' };
it('accepts only a diagnostic at the validated queue key', () => {
  expect(locations).toEqual([{ filepath: '/test.yml', line: 3, column: 3 }]);
  expect(acceptActionlintResult(1, JSON.stringify([diagnostic]), '', locations, '/')).toBe(true);
  expect(acceptActionlintResult(0, 'null', '', locations, '/')).toBe(true);
  expect(acceptActionlintResult(0, '[]', '', locations, '/')).toBe(true);
});
it.each([
  { ...diagnostic, filepath: '/other.yml' }, { ...diagnostic, line: 4 },
  { ...diagnostic, column: 4 }, { ...diagnostic, kind: 'expression' },
  { ...diagnostic, message: 'unexpected key "other"' },
])('blocks another diagnostic %j', item => {
  expect(acceptActionlintResult(1, JSON.stringify([diagnostic, item]), '', locations, '/')).toBe(false);
});
it.each([[null, 'null', ''], [2, 'null', ''], [1, '[]', ''], [0, 'garbage', ''],
  [0, 'null', 'unexpected stderr'], [0, '{}', ''], [0, JSON.stringify([diagnostic]), ''],
  [1, JSON.stringify([diagnostic, diagnostic]), '']] as const)('blocks malformed process result %j', (status, out, err) => {
  expect(acceptActionlintResult(status, out, err, locations, '/')).toBe(false);
});
it.each(['true', '"false"', '${{ inputs.cancel }}', 'null', '{}'])('rejects max with cancel %s', cancel => {
  expect(() => validateQueueSyntax('/test.yml', source.replace('false', cancel))).toThrow('max requires');
});
it.each(['MAX', 'all', '100', 'null', '${{ inputs.queue }}', '[max]'])('rejects queue %s', queue => {
  expect(() => validateQueueSyntax('/test.yml', source.replace('queue: max', `queue: ${queue}`))).toThrow('literal');
});
it('supports both concurrency levels, but cannot exempt keys in other sections', () => {
  const job = 'jobs:\n  release:\n    concurrency:\n      group: release\n      queue: max\n';
  expect(validateQueueSyntax('/test.yml', source + job)).toHaveLength(2);
  expect(validateQueueSyntax('/test.yml', 'env:\n  queue: max\n')).toHaveLength(0);
  expect(validateQueueSyntax('/test.yml', source.replace('max', 'single').replace('false', 'true'))).toHaveLength(1);
});
it('rejects duplicate keys and broken YAML', () => {
  expect(() => validateQueueSyntax('/test.yml', source + '  queue: single\n')).toThrow('invalid YAML');
  expect(() => validateQueueSyntax('/test.yml', 'jobs: [')).toThrow('invalid YAML');
});
