import { describe, expect, it } from 'vitest';
import {
  classificationInputBody,
  decodeBlockingState,
  effectiveAuthorFromBody,
  encodeBlockingState,
  fingerprintForPull,
  formatMentions,
  isBotLogin,
  nextBlockingFailuresState,
  normalizeBlockingFailure,
  normalizeGitHubLogin,
  orderedBlockingFailures,
  realContributorLoginsFromBody,
  uniqueHumanLogins,
} from '../packages/core/src/index.js';
import {
  fetchGitHubLinkPages,
  fetchPullRequestPages,
  maxPullRequestPages,
  pullRequestPageSize,
  nextPageUrl,
} from '../packages/github/src/index.js';

describe('GitHub identities', () => {
  it('normalizes valid logins and rejects invalid values', () => {
    expect(normalizeGitHubLogin('@@Axiomoth')).toBe('Axiomoth');
    expect(normalizeGitHubLogin('-invalid')).toBe('');
    expect(normalizeGitHubLogin('ends-')).toBe('');
  });

  it('filters built-in and configured automation identities', () => {
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(isBotLogin('SPLRAD-Steward[bot]')).toBe(true);
    expect(isBotLogin('github-actions')).toBe(true);
    expect(isBotLogin('splrad-steward', ['splrad-steward'])).toBe(true);
    expect(uniqueHumanLogins(
      ['Axiomoth', '@axiomoth', 'external-dev', 'splrad-steward'],
      { botLogins: ['splrad-steward'] },
    )).toEqual(['Axiomoth', 'external-dev']);
  });

  it('uses hidden contributor metadata without attributing bots', () => {
    const body = [
      '<!-- workflow:source-actor:splrad-steward -->',
      '<!-- workflow:source-contributors:external-dev, Axiomoth -->',
    ].join('\n');
    expect(realContributorLoginsFromBody({
      body,
      prAuthor: 'splrad-steward',
      botLogins: ['splrad-steward'],
    })).toEqual(['external-dev', 'Axiomoth']);
    expect(effectiveAuthorFromBody({
      body,
      prAuthor: 'splrad-steward',
      botLogins: ['splrad-steward'],
    })).toBe('external-dev');
    expect(formatMentions(['splrad-steward'], {
      botLogins: ['splrad-steward'],
      emptyText: '(none)',
    })).toBe('(none)');
    expect(formatMentions(['Axiomoth', 'external-dev'], { separator: '；' }))
      .toBe('@Axiomoth；@external-dev');
  });
});

describe('validation fingerprints', () => {
  const classificationMetadata = '\n<!-- workflow:pr-classification:start\nlabels: bug\nworkflow:pr-classification:end -->';
  const createFingerprint = (overrides: { title?: string; body?: string } = {}) => fingerprintForPull({
    pull: {
      title: overrides.title ?? 'fix: correct gate',
      body: overrides.body ?? `Contributor context${classificationMetadata}`,
      user: { login: 'splrad-steward' },
      head: { sha: 'head1' },
      base: { ref: 'main', sha: 'base1' },
    },
    commits: [
      { sha: 'b', author: { login: 'external-dev' } },
      { sha: 'a', author: { login: 'Axiomoth' } },
    ],
    files: [
      { filename: '.\\src\\A.cs', status: 'modified', sha: 'file1', additions: 1, deletions: 0 },
    ],
    botLogins: ['splrad-steward'],
  });

  it('preserves the existing classification metadata exclusion contract', () => {
    expect(classificationInputBody(`Contributor context${classificationMetadata}`)).toBe('Contributor context');
    expect(createFingerprint().value).toBe(createFingerprint({
      body: 'Contributor context\n<!-- workflow:pr-classification:start\nlabels: docs\nworkflow:pr-classification:end -->',
    }).value);
    expect(createFingerprint().value).not.toBe(createFingerprint({ title: 'docs: correct gate' }).value);
  });

  it('is stable across collection order and excludes configured bots', () => {
    const fingerprint = createFingerprint();
    expect(fingerprint.commits).toEqual(['a', 'b']);
    expect(fingerprint.contributors).toEqual(['axiomoth', 'external-dev']);
    expect(fingerprint.value).toBe('f82feb3d5e9ed5d3d0cd82376479c89c10f2d9e7bbf8c9067c1858f8d2ee71ae');
  });

  it('normalizes identity casing independently of API collection order', () => {
    const first = createFingerprint();
    const second = fingerprintForPull({
      pull: {
        title: 'fix: correct gate',
        body: `Contributor context${classificationMetadata}`,
        user: { login: 'SPLRAD-STEWARD' },
        head: { sha: 'head1' },
        base: { ref: 'main', sha: 'base1' },
      },
      commits: [
        { sha: 'a', author: { login: 'axiomoth' } },
        { sha: 'b', author: { login: 'EXTERNAL-DEV' } },
      ],
      files: [
        { filename: 'src/A.cs', status: 'modified', sha: 'file1', additions: 1, deletions: 0 },
      ],
      botLogins: ['splrad-steward'],
    });
    expect(second).toEqual(first);
  });
});

describe('blocking comment state', () => {
  it('decodes the legacy hidden-state shape without requiring handlers', () => {
    const legacy = {
      head: 'head-legacy',
      failures: [{ source: 'copilot-review', title: 'Legacy', details: ['Detail'] }],
    };
    const body = `<!-- workflow:pr-blocking-failures-state:${encodeBlockingState(legacy)} -->`;
    expect(decodeBlockingState(body)).toEqual(legacy);
    expect(decodeBlockingState('<!-- workflow:pr-blocking-failures-state:not-json -->')).toBeNull();
  });

  it('replaces one source family, preserves others, and resets on a new head', () => {
    const existing = {
      head: 'head-a',
      failures: [
        { source: 'main-authorization', title: 'Approval' },
        { source: 'copilot-review', title: 'Old Copilot' },
      ],
    };
    const updated = nextBlockingFailuresState(existing, 'head-a', {
      sourcePrefix: 'copilot-review',
      failures: [
        { source: 'copilot-review:blocking-comments', title: 'Comments' },
        { source: 'copilot-review:comment-protocol', title: 'Protocol' },
      ],
    });
    expect(updated.failures.map((failure) => failure.source)).toEqual([
      'main-authorization',
      'copilot-review:blocking-comments',
      'copilot-review:comment-protocol',
    ]);
    expect(nextBlockingFailuresState(updated, 'head-b', {
      sourcePrefix: 'copilot-review',
      failures: [{ source: 'copilot-review', title: 'New head' }],
    }).failures).toHaveLength(1);
  });

  it('keeps the established contributor-facing source order', () => {
    expect(orderedBlockingFailures([
      { source: 'copilot-review', title: 'Copilot' },
      { source: 'main-authorization', title: 'Approval' },
    ]).map((failure) => failure.source)).toEqual(['main-authorization', 'copilot-review']);
  });

  it('tolerates malformed legacy failure entries without trusting their shape', () => {
    const malformed = {
      head: 'head-a',
      failures: [
        null,
        'invalid',
        { source: 'main-authorization', handlers: 'Axiomoth' },
      ] as unknown as { source?: unknown }[],
    };
    const next = nextBlockingFailuresState(malformed, 'head-a', {
      sourcePrefix: 'copilot-review',
      failures: [],
    });
    expect(next.failures).toHaveLength(3);
    expect(normalizeBlockingFailure({
      source: 'main-authorization',
      handlers: 'Axiomoth' as unknown as string[],
    }).handlers).toEqual([]);
  });
});

describe('GitHub pagination', () => {
  it('reads at most the established 30 pages of 100 items', async () => {
    const requested: number[] = [];
    const items = await fetchPullRequestPages((page, pageSize) => {
      requested.push(page);
      return Array.from({ length: pageSize }, (_, index) => `${page}:${index}`);
    });
    expect(items).toHaveLength(maxPullRequestPages * pullRequestPageSize);
    expect(requested).toEqual(Array.from({ length: maxPullRequestPages }, (_, index) => index + 1));
  });

  it('stops immediately after a partial page and supports async adapters', async () => {
    const requested: number[] = [];
    const items = await fetchPullRequestPages(async (page, pageSize) => {
      requested.push(page);
      return Array.from({ length: page === 1 ? pageSize : 7 }, (_, index) => index);
    });
    expect(items).toHaveLength(107);
    expect(requested).toEqual([1, 2]);
  });

  it('fails closed on invalid adapter responses and bounds', async () => {
    await expect(fetchPullRequestPages(() => null as never)).rejects.toThrow('must be an array');
    await expect(fetchPullRequestPages(() => [], { maxPages: 0 })).rejects.toThrow('positive integer');
    await expect(fetchPullRequestPages(() => [], { maxPages: 31 })).rejects.toThrow('must not exceed 30');
    await expect(fetchPullRequestPages(() => [], { pageSize: 101 })).rejects.toThrow('must not exceed 100');
  });

  it('parses and follows same-origin GitHub Link headers', async () => {
    expect(nextPageUrl([
      '<https://api.github.test/items?page=1>; rel="prev"',
      '<https://api.github.test/items?page=3>; rel="next"',
    ].join(', '))).toBe('https://api.github.test/items?page=3');
    const requested: string[] = [];
    const items = await fetchGitHubLinkPages('https://api.github.test/items?page=1', (url) => {
      requested.push(url);
      return url.endsWith('page=1')
        ? { items: ['first'], link: '<https://api.github.test/items?page=2>; rel="next"' }
        : { items: ['second'] };
    });
    expect(items).toEqual(['first', 'second']);
    expect(requested).toEqual([
      'https://api.github.test/items?page=1',
      'https://api.github.test/items?page=2',
    ]);
  });

  it('rejects cross-origin and cyclic pagination links', async () => {
    await expect(fetchGitHubLinkPages('https://api.github.test/items', () => ({
      items: [],
      link: '<https://attacker.test/items>; rel="next"',
    }))).rejects.toThrow('changed origin');
    await expect(fetchGitHubLinkPages('https://api.github.test/items', () => ({
      items: [],
      link: '<https://api.github.test/items>; rel="next"',
    }))).rejects.toThrow('cycle');
  });
});
