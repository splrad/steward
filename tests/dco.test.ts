import { describe, expect, it } from 'vitest';
import { evaluateDcoAdvisory, parseDcoSignOffs, type DcoCommitInput } from '../packages/core/src/index.js';

function commit(input: Partial<DcoCommitInput> & Pick<DcoCommitInput, 'sha' | 'message'>): DcoCommitInput {
  return {
    author: { login: '', type: 'User', name: 'Alice', email: 'Alice@Example.com' },
    ...input,
  };
}

describe('DCO advisory evaluator', () => {
  it('accepts a matching trailer case-insensitively and ignores other invalid trailers', () => {
    const result = evaluateDcoAdvisory([commit({
      sha: 'a'.repeat(40),
      message: [
        'feat: add feature',
        '',
        'Signed-off-by: invalid',
        'signed-OFF-BY: Alice <alice@example.COM>',
      ].join('\n'),
    })]);
    expect(result).toEqual({ total: 1, passed: 1, skipped: 0, issues: [] });
    expect(parseDcoSignOffs('Signed-off-by: Alice <alice@example.com>')).toEqual([{
      raw: 'Signed-off-by: Alice <alice@example.com>',
      valid: true,
      name: 'Alice',
      email: 'alice@example.com',
    }]);
  });

  it('distinguishes missing, malformed, and mismatched sign-offs without making policy decisions', () => {
    const result = evaluateDcoAdvisory([
      commit({ sha: 'a'.repeat(40), message: 'fix: missing' }),
      commit({ sha: 'b'.repeat(40), message: 'fix: malformed\n\nSigned-off-by: Alice' }),
      commit({ sha: 'c'.repeat(40), message: 'fix: mismatch\n\nSigned-off-by: Alice <other@example.com>' }),
    ]);
    expect(result).toMatchObject({ total: 3, passed: 0, skipped: 0 });
    expect(result.issues.map((issue) => issue.reason)).toEqual([
      'missing',
      'invalid-format',
      'email-mismatch',
    ]);
    expect(result.issues[2]?.signedEmails).toEqual(['other@example.com']);
    expect(result.issues[2]?.signedEmailsTruncated).toBe(0);
  });

  it('deduplicates and bounds reported mismatch emails without changing the advisory decision', () => {
    const trailers = Array.from({ length: 25 }, (_, index) => (
      `Signed-off-by: Other <other-${index}@example.com>`
    ));
    const result = evaluateDcoAdvisory([commit({
      sha: 'a'.repeat(40),
      message: ['fix: many trailers', '', ...trailers, trailers[0]!].join('\n'),
    })]);
    expect(result.issues[0]?.reason).toBe('email-mismatch');
    expect(result.issues[0]?.signedEmails).toHaveLength(20);
    expect(result.issues[0]?.signedEmailsTruncated).toBe(5);
  });

  it('skips bot-authored commits but does not mistake an unlinked human for a bot', () => {
    const result = evaluateDcoAdvisory([
      commit({
        sha: 'a'.repeat(40),
        message: 'chore: bump',
        author: {
          login: 'dependabot[bot]', type: 'Bot', name: 'dependabot[bot]',
          email: '49699333+dependabot[bot]@users.noreply.github.com',
        },
      }),
      commit({
        sha: 'b'.repeat(40),
        message: 'chore: generated',
        author: { login: 'splrad-steward[bot]', type: 'User', name: 'Steward', email: 'steward@example.com' },
      }),
      commit({
        sha: 'c'.repeat(40),
        message: 'docs: human without linked account',
        author: { login: '', type: '', name: 'Human', email: 'human@example.com' },
      }),
    ], { botLogins: ['splrad-steward'] });
    expect(result).toMatchObject({ total: 3, passed: 0, skipped: 2 });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ sha: 'c'.repeat(40), reason: 'missing' });
  });

  it('uses author identity ahead of a bot committer, matching the established consumer behavior', () => {
    const result = evaluateDcoAdvisory([commit({
      sha: 'a'.repeat(40),
      message: 'feat: web edit',
      author: { login: 'alice', type: 'User', name: 'Alice', email: 'alice@example.com' },
      committer: { login: 'github-actions[bot]', type: 'Bot', name: 'github-actions', email: 'bot@example.com' },
    })]);
    expect(result).toMatchObject({ total: 1, passed: 0, skipped: 0 });
    expect(result.issues[0]?.reason).toBe('missing');
  });
});
