import { expect, it } from 'vitest';
import list from '../../../config/managed-files.json' with { type: 'json' };
import { parseManagedFileConfig } from '../src/managed-file-config.js';
it('accepts the registered production file owners', () => {
  expect(parseManagedFileConfig(list, ['1187527897', '1296724484', '1296725317'])).toEqual(list);
});
it.each(['unknown-root', 'unknown-rule', 'repository', 'path', 'duplicate', 'adoption', 'source-sha', 'foreign-source', 'unknown-renderer', 'profile', 'section', 'fields', 'duplicate-field', 'unsafe-field'])('rejects %s before rendering or writing', variant => {
  const value: any = structuredClone(list), rules = value.repositories['1187527897'], rule = rules[0];
  if (variant === 'unknown-root') value.skipValidation = true;
  if (variant === 'unknown-rule') rule.command = 'script';
  if (variant === 'repository') value.repositories['999'] = rules;
  if (variant === 'path') rule.destination = '../AGENTS.md';
  if (variant === 'duplicate') rules.push({ ...rule, destination: 'agents.md' });
  if (variant === 'adoption') rule.destination = '.github/steward-adoption.json';
  if (variant === 'source-sha') rule.sourceSha = 'a'.repeat(40);
  if (variant === 'foreign-source') rule.sourceRepository = 'other/repo';
  if (variant === 'unknown-renderer') rule.renderer = 'exec';
  if (variant === 'profile') rule.profile = 'unreviewed';
  if (variant === 'section') delete rule.endMarker;
  if (variant === 'fields') rule.dependencyFields = [{ jobId: 'title', stepId: 'semantic-title', path: ['env', 'TOKEN'] }];
  if (variant === 'duplicate-field') rules.find((r: any) => r.destination.endsWith('steward-pr-title.yml')).dependencyFields.push(rules.find((r: any) => r.destination.endsWith('steward-pr-title.yml')).dependencyFields[0]);
  if (variant === 'unsafe-field') rules.find((r: any) => r.destination.endsWith('steward-pr-title.yml')).dependencyFields[0].path = ['with', '__proto__'];
  expect(() => parseManagedFileConfig(value, Object.keys(list.repositories))).toThrow();
});
