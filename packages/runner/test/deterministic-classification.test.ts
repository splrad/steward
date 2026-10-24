import { expect, it } from 'vitest';
import { classifyDeterministically } from '../../core/src/classification.js';
import semantics from '../../../config/labels/pr-semantics.json' with { type: 'json' };
import profile from '../../../config/profiles/classification/default.json' with { type: 'json' };
import catalog from '../../../config/repositories.json' with { type: 'json' };
it('schema5 classification accepts only deterministic policy fields', () => {
  const repository = catalog.repositories['1296724484'].classification;
  const facts = { repositoryId: 1296724484, pullRequestNumber: 1, sourceRepositoryId: 1296724484, sourceRef: 'change', targetRef: 'main', author: { login: 'fixture', type: 'User' }, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), commits: [{ sha: 'a'.repeat(40), message: 'fix: correct handling' }], files: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, patch: '-old\n+new' }] };
  const existing = { currentLabels: [], stewardOwnedRiskFlags: [], stewardOwnedFacets: [] };
  const result = classifyDeterministically(semantics as any, profile as any, repository as any, facts as any, existing);
  expect(result.primaryKind.source).not.toBe('ai');
  expect(() => classifyDeterministically(semantics as any, profile as any, { ...repository, ai: {} } as any, facts as any, existing)).toThrow('deterministic');
});
