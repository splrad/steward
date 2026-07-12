import { describe, expect, it } from 'vitest';
import {
  automationCreatedNoticeMarker,
  automationSummaryEndMarker,
  automationSummaryStartMarker,
  evaluatePullRequestAutomation,
} from '../packages/core/src/index.js';

function facts(overrides: Partial<Parameters<typeof evaluatePullRequestAutomation>[0]> = {}) {
  return {
    sourceBranch: 'feature/shared-automation',
    targetBranch: 'main',
    headSha: 'c'.repeat(40),
    actor: 'external-dev',
    compareStatus: 'ahead',
    aheadBy: 2,
    totalCommits: 2,
    commits: [
      {
        sha: 'b'.repeat(40),
        message: 'prepare automation',
        authorLogin: 'external-dev',
        authorName: 'External Dev',
        authorEmail: 'dev@example.test',
      },
      {
        sha: 'c'.repeat(40),
        message: 'feat(workflow): 发布共享自动化',
        authorLogin: 'helper',
        authorName: 'Helper',
        authorEmail: 'helper@example.test',
      },
    ],
    files: [
      { filename: '.github/workflows/pr-automation.yml', status: 'modified', additions: 12, deletions: 3 },
      { filename: 'packages/core/src/automation.ts', status: 'added', additions: 90, deletions: 0 },
    ],
    maintainers: ['core'],
    botLogins: ['splrad-steward'],
    ...overrides,
  };
}

describe('PR Automation policy', () => {
  it('builds a bounded cross-project PR plan from complete compare evidence', () => {
    const result = evaluatePullRequestAutomation(facts());
    expect(result).toMatchObject({
      state: 'planned',
      title: 'feat(workflow): 发布共享自动化',
      contributors: ['external-dev', 'helper'],
      changedFiles: 2,
      commits: 2,
    });
    if (result.state !== 'planned') throw new Error('expected a plan');
    expect(result.body).toContain(automationSummaryStartMarker);
    expect(result.body).toContain(automationSummaryEndMarker);
    expect(result.body).toContain('<!-- workflow:source-actor:external-dev -->');
    expect(result.body).toContain('<!-- workflow:source-contributors:external-dev,helper -->');
    expect(result.body).toContain('`packages/core/src/automation.ts`（+90/-0）');
    expect(result.body).toContain('Co-authored-by: External Dev <dev@example.test>');
    expect(result.noticeBody).toContain(automationCreatedNoticeMarker);
    expect(result.noticeBody).toContain('@external-dev');
    expect(result.noticeBody).toContain('@core');
    expect(result.noticeBody).toContain('__PR_NUMBER__');
  });

  it('preserves manual body content while replacing only managed blocks', () => {
    const existingBody = [
      '人工说明',
      automationSummaryStartMarker,
      '旧摘要',
      automationSummaryEndMarker,
      '<!-- workflow:co-authored-by -->',
      '<details>旧 trailer</details>',
    ].join('\n');
    const result = evaluatePullRequestAutomation(facts({ existingBody }));
    if (result.state !== 'planned') throw new Error('expected a plan');
    expect(result.body).toContain('人工说明');
    expect(result.body).not.toContain('旧摘要');
    expect(result.body).not.toContain('旧 trailer');
    expect(result.body.match(/workflow:auto-summary:start/g)).toHaveLength(1);
    expect(result.body.match(/workflow:co-authored-by/g)).toHaveLength(1);
  });

  it('uses the trusted default-branch template only for a bodyless PR', () => {
    const templateBody = ['## 审查', '', automationSummaryStartMarker, '等待', automationSummaryEndMarker].join('\n');
    const planned = evaluatePullRequestAutomation(facts({ templateBody }));
    if (planned.state !== 'planned') throw new Error('expected a plan');
    expect(planned.body).toContain('## 审查');
    expect(planned.body).not.toContain('等待');

    const existing = evaluatePullRequestAutomation(facts({ existingBody: '人工正文', templateBody }));
    if (existing.state !== 'planned') throw new Error('expected a plan');
    expect(existing.body).toContain('人工正文');
    expect(existing.body).not.toContain('## 审查');
  });

  it('does not expose mentions or bot contributors from untrusted presentation fields', () => {
    const result = evaluatePullRequestAutomation(facts({
      sourceBranch: 'feature/@maintainer',
      commits: [
        facts().commits[0]!,
        {
          sha: 'c'.repeat(40),
          message: 'mention @maintainer <script>',
          authorLogin: 'splrad-steward[bot]',
          authorName: 'splrad-steward[bot]',
          authorEmail: '1+splrad-steward[bot]@users.noreply.github.com',
        },
      ],
    }));
    if (result.state !== 'planned') throw new Error('expected a plan');
    expect(result.title).toBe('chore: 更新 2 个文件');
    expect(result.body).toContain('@\u200bmaintainer');
    expect(result.body).toContain('&lt;script&gt;');
    expect(result.body).not.toContain('Co-authored-by: splrad-steward');
    expect(result.contributors).toEqual(['external-dev']);
  });

  it('rebuilds contributor metadata without trusting editable PR-body identities', () => {
    const result = evaluatePullRequestAutomation(facts({
      existingBody: [
        '<!-- workflow:source-actor:forged-core -->',
        '<!-- workflow:source-contributors:forged-core,external-dev -->',
      ].join('\n'),
    }));
    if (result.state !== 'planned') throw new Error('expected a plan');
    expect(result.contributors).toEqual(['external-dev', 'helper']);
    expect(result.body).not.toContain('workflow:source-actor:forged-core');
    expect(result.body).not.toContain('workflow:source-contributors:forged-core');
  });

  it('ignores default-branch, bot, and no-ahead pushes without a mutation plan', () => {
    expect(evaluatePullRequestAutomation(facts({ sourceBranch: 'main' }))).toEqual({
      state: 'ignored', reason: 'default-branch',
    });
    expect(evaluatePullRequestAutomation(facts({ actor: 'dependabot[bot]' }))).toEqual({
      state: 'ignored', reason: 'bot-actor',
    });
    expect(evaluatePullRequestAutomation(facts({ aheadBy: 0, totalCommits: 0, commits: [], files: [] }))).toEqual({
      state: 'ignored', reason: 'no-ahead-commits',
    });
  });

  it('fails closed on incomplete compare evidence before presenting a plan', () => {
    expect(() => evaluatePullRequestAutomation(facts({ commits: [facts().commits[1]!] })))
      .toThrow('commit evidence is incomplete');
    expect(() => evaluatePullRequestAutomation(facts({ files: [] })))
      .toThrow('file evidence is empty');
    expect(() => evaluatePullRequestAutomation(facts({ files: Array.from({ length: 300 }, (_, index) => ({
      filename: `src/${index}.ts`, status: 'modified', additions: 1, deletions: 0,
    })) }))).toThrow('may be truncated');
    expect(() => evaluatePullRequestAutomation(facts({ headSha: 'short' }))).toThrow('valid head SHA');
  });
});
