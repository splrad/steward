import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  evaluateMatrix,
  isTrustedMatrixCheck,
  legacyProxyExternalId,
  matrixLiveEvidenceDigest,
  matrixCheckState,
  matrixConclusion,
  parseStewardCheckExternalId,
  planMatrixRepairs,
  planProxyCompletions,
  projectMatrixLiveEvidence,
  stewardCheckExternalId,
  validateReviewDispatch,
  type MatrixCheckRun,
  type MatrixConfiguration,
  type MatrixPull,
  type MatrixTargetConfiguration,
  type MatrixTargetResult,
  type MatrixWorkflowRun,
} from '../packages/core/src/index.js';

const config = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/matrix.json', import.meta.url),
  'utf8',
)) as MatrixConfiguration;

const pull: MatrixPull = { number: 121, base: { ref: 'main' }, head: { sha: 'a'.repeat(40) } };
const inputDigest = 'f'.repeat(64);
const configDigest = 'c'.repeat(64);
const appId = 4243096;
const appSlug = 'splrad-steward';

function target(id: string): MatrixTargetConfiguration {
  return config.targets.find((candidate) => candidate.id === id)!;
}

function check(
  name: string,
  status: string,
  conclusion = '',
  overrides: Partial<MatrixCheckRun> = {},
): MatrixCheckRun {
  return {
    id: 1,
    head_sha: pull.head.sha,
    name,
    status,
    conclusion,
    started_at: '2026-07-11T00:00:00Z',
    ...overrides,
  };
}

function result(id: string, state: MatrixTargetResult['state'], checkRun: MatrixCheckRun | null = null): MatrixTargetResult {
  return {
    ...target(id),
    checkRun,
    state,
    conclusion: String(checkRun?.conclusion ?? ''),
    status: String(checkRun?.status ?? ''),
    url: '',
    required: target(id).required !== false,
  };
}

describe('Matrix Check identities', () => {
  it('round-trips the versioned repository, PR, head, check, config, and input identity', () => {
    const identity = {
      repositoryId: 42,
      prNumber: pull.number,
      headSha: pull.head.sha,
      checkId: 'main-authorization',
      configDigest,
      inputDigest,
    };
    expect(parseStewardCheckExternalId(stewardCheckExternalId(identity))).toEqual(identity);
    expect(parseStewardCheckExternalId(stewardCheckExternalId(identity).replace(
      'check:main-authorization',
      'check:MAIN-AUTHORIZATION',
    ))?.checkId).toBe('main-authorization');
    expect(parseStewardCheckExternalId('matrix-proxy:legacy')).toBeNull();
  });

  it('keeps production Classification identities within the conservative 255-character adapter budget', () => {
    const base = {
      repositoryId: 1_187_527_897,
      prNumber: 128,
      headSha: 'a'.repeat(40),
      configDigest: 'b'.repeat(64),
      inputDigest: 'c'.repeat(64),
    };
    expect(['pr-classification', 'pr-class-lease', 'pr-class-off'].map((checkId) => (
      stewardCheckExternalId({ ...base, checkId }).length
    ))).toEqual([253, 250, 248]);
  });

  it('canonically binds the full Matrix gate to current trusted child evidence and excludes itself', async () => {
    const child = result('main-authorization', 'passed', check('Main Authorization Gate', 'completed', 'success', {
      id: 82,
      head_sha: pull.head.sha,
      app: { id: appId, slug: appSlug },
      external_id: stewardCheckExternalId({
        repositoryId: 42,
        prNumber: pull.number,
        headSha: pull.head.sha,
        checkId: 'main-authorization',
        configDigest,
        inputDigest,
      }),
    }));
    const advisory = result('dco-signoff', 'missing');
    const finalGate: MatrixTargetResult = {
      ...child,
      id: 'validation-matrix',
      checkRun: check('PR Validation Matrix Gate', 'completed', 'success', {
        id: 99,
        head_sha: pull.head.sha,
        app: { id: appId, slug: appSlug },
        external_id: stewardCheckExternalId({
          repositoryId: 42,
          prNumber: pull.number,
          headSha: pull.head.sha,
          checkId: 'validation-matrix',
          configDigest,
          inputDigest,
        }),
      }),
    };
    const digestInput = {
      repositoryId: 42,
      pull: {
        ...pull,
        state: 'open',
        base: { ref: 'main', sha: 'b'.repeat(40) },
        head: { ref: 'feature/matrix', sha: pull.head.sha },
      },
      configDigest,
      pullFingerprintDigest: inputDigest,
    };

    const projection = projectMatrixLiveEvidence({
      ...digestInput,
      targets: [finalGate, child, advisory],
    });
    expect(projection).toMatchObject({
      repository_id: 42,
      scope: 'full',
      pull_request: {
        number: pull.number,
        state: 'open',
        base: { ref: 'main', sha: 'b'.repeat(40) },
        head: { ref: 'feature/matrix', sha: pull.head.sha },
      },
      pull_fingerprint_digest: inputDigest,
    });
    expect(projection.targets.map((candidate) => candidate.id)).toEqual(['dco-signoff', 'main-authorization']);
    expect(projection.targets[1]).toMatchObject({
      state: 'passed',
      required: true,
      check: {
        id: 82,
        name: 'Main Authorization Gate',
        head_sha: pull.head.sha,
        app: { id: appId, slug: appSlug },
        status: 'completed',
        conclusion: 'success',
      },
    });

    const ordered = await matrixLiveEvidenceDigest({ ...digestInput, targets: [advisory, child] });
    const reversed = await matrixLiveEvidenceDigest({ ...digestInput, targets: [child, advisory, finalGate] });
    const changed = await matrixLiveEvidenceDigest({
      ...digestInput,
      targets: [{ ...child, state: 'pending', status: 'in_progress' }, advisory],
    });
    expect(reversed.value).toBe(ordered.value);
    expect(changed.value).not.toBe(ordered.value);
  });

  it('accepts exact App identities, reads legacy identities, and rejects stale configuration', () => {
    const matrixTarget = target('pr-classification');
    const trust = { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: true };
    const run = check('PR Classification Gate', 'completed', 'success', {
      app: { id: appId, slug: appSlug },
      external_id: stewardCheckExternalId({
        repositoryId: 42,
        prNumber: pull.number,
        headSha: pull.head.sha,
        checkId: matrixTarget.id,
        configDigest,
        inputDigest,
      }),
    });
    expect(isTrustedMatrixCheck({ run, target: matrixTarget, pull, trust })).toBe(true);
    expect(isTrustedMatrixCheck({
      run: { ...run, external_id: stewardCheckExternalId({
        repositoryId: 42,
        prNumber: pull.number,
        headSha: pull.head.sha,
        checkId: matrixTarget.id,
        configDigest: 'd'.repeat(64),
        inputDigest,
      }) },
      target: matrixTarget,
      pull,
      trust,
    })).toBe(false);
    expect(isTrustedMatrixCheck({
      run: { ...run, app: { id: appId + 1, slug: appSlug } },
      target: matrixTarget,
      pull,
      trust,
    })).toBe(false);
    expect(isTrustedMatrixCheck({
      run: { ...run, head_sha: 'b'.repeat(40) },
      target: matrixTarget,
      pull,
      trust,
    })).toBe(false);
    expect(isTrustedMatrixCheck({
      run: { ...run, external_id: `classification:pr:${pull.number}:fingerprint:${inputDigest}` },
      target: matrixTarget,
      pull,
      trust,
    })).toBe(true);
    expect(isTrustedMatrixCheck({
      run: { ...run, external_id: `classification:pr:${pull.number}:fingerprint:${inputDigest}` },
      target: matrixTarget,
      pull,
      trust: { ...trust, allowLegacy: false },
    })).toBe(false);
    expect(isTrustedMatrixCheck({
      run: { ...run, name: 'Main Authorization Gate', external_id: '' },
      target: target('main-authorization'),
      pull,
      trust,
    })).toBe(false);
  });

  it('treats the newest trusted Classification lease as a fail-closed barrier over older exact success', () => {
    const matrixTarget = target('pr-classification');
    const trust = { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: false };
    const exactSuccess = check(matrixTarget.checkNames[0]!, 'completed', 'success', {
      id: 80,
      app: { id: appId, slug: appSlug },
      external_id: stewardCheckExternalId({
        repositoryId: 42,
        prNumber: pull.number,
        headSha: pull.head.sha,
        checkId: matrixTarget.id,
        configDigest,
        inputDigest,
      }),
    });
    const leaseExternalId = stewardCheckExternalId({
      repositoryId: 42,
      prNumber: pull.number,
      headSha: pull.head.sha,
      checkId: 'pr-class-lease',
      configDigest: '0'.repeat(64),
      inputDigest: 'b'.repeat(64),
    });
    const evaluate = (lease: MatrixCheckRun) => evaluateMatrix({
      config,
      checkRuns: [exactSuccess, lease],
      scope: 'full',
      pull,
      trust,
    }).targets.find((candidate) => candidate.id === matrixTarget.id);

    const pending = evaluate(check(matrixTarget.checkNames[0]!, 'in_progress', '', {
      id: 90,
      app: { id: appId, slug: appSlug },
      external_id: leaseExternalId,
    }));
    expect(pending).toMatchObject({ state: 'pending', checkRun: { id: 90 } });

    const failed = evaluate(check(matrixTarget.checkNames[0]!, 'completed', 'failure', {
      id: 90,
      app: { id: appId, slug: appSlug },
      external_id: leaseExternalId,
    }));
    expect(failed).toMatchObject({ state: 'failed', checkRun: { id: 90 } });

    const invalidSuccess = evaluate(check(matrixTarget.checkNames[0]!, 'completed', 'success', {
      id: 90,
      app: { id: appId, slug: appSlug },
      external_id: leaseExternalId,
    }));
    expect(invalidSuccess).toMatchObject({ state: 'failed', checkRun: { id: 90 } });

    const newerExactSuccess = evaluateMatrix({
      config,
      checkRuns: [
        check(matrixTarget.checkNames[0]!, 'in_progress', '', {
          id: 80,
          started_at: '2026-07-12T00:00:00Z',
      app: { id: appId, slug: appSlug },
          external_id: leaseExternalId,
        }),
        { ...exactSuccess, id: 90, started_at: '2026-07-11T00:00:00Z' },
      ],
      scope: 'full',
      pull,
      trust,
    }).targets.find((candidate) => candidate.id === matrixTarget.id);
    expect(newerExactSuccess).toMatchObject({ state: 'passed', checkRun: { id: 90 } });

    const lease = check(matrixTarget.checkNames[0]!, 'in_progress', '', {
      id: 90,
      app: { id: appId, slug: appSlug },
      external_id: leaseExternalId,
    });
    expect(planProxyCompletions({
      workflowRuns: [{
        id: 77,
        name: `PR Validation Target #${pull.number} / ${pull.head.sha}`,
        path: '.github/workflows/pr-classification.yml',
        event: 'workflow_dispatch',
        jobs: [{ id: 88, name: matrixTarget.jobName, status: 'completed', conclusion: 'success' }],
      }],
      targets: [result(matrixTarget.id, 'pending', lease)],
      checkRuns: [lease],
      pull,
      trust,
    })).toEqual([]);
  });

  it('selects the latest trusted generation by numeric Check ID regardless of started_at order', () => {
    const matrixTarget = target('pr-classification');
    const trust = { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: false };
    const trustedCheck = (
      id: number,
      started_at: string,
      conclusion: 'success' | 'failure',
    ): MatrixCheckRun => check(matrixTarget.checkNames[0]!, 'completed', conclusion, {
      id,
      started_at,
      app: { id: appId, slug: appSlug },
      external_id: stewardCheckExternalId({
        repositoryId: 42,
        prNumber: pull.number,
        headSha: pull.head.sha,
        checkId: matrixTarget.id,
        configDigest,
        inputDigest,
      }),
    });
    const matrix = evaluateMatrix({
      config,
      scope: 'full',
      pull,
      trust,
      checkRuns: [
        trustedCheck(100, '2026-07-10T00:00:00Z', 'failure'),
        trustedCheck(99, '2026-07-12T00:00:00Z', 'success'),
      ],
    });

    expect(matrix.targets.find((candidate) => candidate.id === matrixTarget.id))
      .toMatchObject({ state: 'failed', checkRun: { id: 100 } });
  });

  it('does not fall back to an older success when trusted generation evidence has an invalid or duplicate ID', () => {
    const matrixTarget = target('pr-classification');
    const externalId = stewardCheckExternalId({
      repositoryId: 42,
      prNumber: pull.number,
      headSha: pull.head.sha,
      checkId: matrixTarget.id,
      configDigest,
      inputDigest,
    });
    const trusted = (id: number | undefined): MatrixCheckRun => {
      const run = check(matrixTarget.checkNames[0]!, 'completed', 'success', {
        ...(id === undefined ? {} : { id }),
        app: { id: appId, slug: appSlug },
        external_id: externalId,
      });
      if (id === undefined) delete run.id;
      return run;
    };
    const evaluate = (checkRuns: MatrixCheckRun[]) => evaluateMatrix({
      config,
      scope: 'full',
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: false },
      checkRuns,
    });

    const missingId = evaluate([trusted(80), trusted(undefined)]);
    expect(missingId).toMatchObject({ state: 'pending', passed: false });
    const missingIdTarget = missingId.targets.find((candidate) => candidate.id === matrixTarget.id);
    expect(missingIdTarget).toMatchObject({ state: 'invalid' });
    expect(missingIdTarget?.checkRun).not.toHaveProperty('id');

    const duplicateId = evaluate([trusted(80), trusted(80)]);
    expect(duplicateId).toMatchObject({ state: 'pending', passed: false });
    expect(duplicateId.targets.find((candidate) => candidate.id === matrixTarget.id))
      .toMatchObject({ state: 'invalid', checkRun: { id: 80 } });
  });

  it('requires matching workflow evidence for GitHub Actions checks', () => {
    const matrixTarget = target('main-authorization');
    const workflowRun = {
      id: 77,
      name: `PR Validation Target #${pull.number} / ${pull.head.sha}`,
      path: '.github/workflows/pr-governance.yml@refs/heads/main',
      event: 'workflow_dispatch',
      pull_requests: [],
    };
    const run = check('Main Authorization Gate', 'completed', 'success', {
      app: { slug: 'github-actions' },
      details_url: 'https://github.com/splrad/steward/actions/runs/77/job/88',
    });
    expect(isTrustedMatrixCheck({
      run,
      target: matrixTarget,
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, workflowRuns: [workflowRun] },
    })).toBe(true);
    expect(isTrustedMatrixCheck({
      run,
      target: matrixTarget,
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, workflowRuns: [workflowRun], allowLegacy: false },
    })).toBe(false);
    expect(isTrustedMatrixCheck({
      run,
      target: matrixTarget,
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, workflowRuns: [{ ...workflowRun, path: '.github/workflows/untrusted.yml' }] },
    })).toBe(false);
  });

  it('accepts an explicitly versioned legacy workflow path without changing the canonical writer path', () => {
    const matrixTarget = {
      ...target('dco-signoff'),
      workflowFile: 'dco-advisory.yml',
      legacyWorkflowFiles: ['dco-check.yml'],
    };
    const run = check('DCO Sign-off Advisory', 'completed', 'success', {
      app: { slug: 'github-actions' },
      details_url: 'https://github.com/splrad/steward/actions/runs/77/job/88',
    });
    const evidence = {
      id: 77,
      name: `PR Validation Target #${pull.number} / ${pull.head.sha}`,
      path: '.github/workflows/dco-check.yml@refs/heads/main',
      event: 'workflow_dispatch',
      pull_requests: [],
    };
    expect(isTrustedMatrixCheck({
      run,
      target: matrixTarget,
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, workflowRuns: [evidence] },
    })).toBe(true);
  });
});

describe('Matrix state and repair planning', () => {
  it('maps check states and keeps advisory targets out of blocking', () => {
    expect(matrixCheckState(null, target('pr-classification'))).toBe('missing');
    expect(matrixCheckState(check('x', 'in_progress'), target('pr-classification'))).toBe('pending');
    expect(matrixCheckState(check('x', 'waiting'), target('pr-classification'))).toBe('pending');
    expect(matrixCheckState(check('x', 'completed', 'success'), target('pr-classification'))).toBe('passed');
    expect(matrixCheckState(check('x', 'completed', 'cancelled'), target('pr-classification'))).toBe('recoverable');
    expect(matrixCheckState(check('x', 'completed', 'failure'), target('pr-classification'))).toBe('failed');
    expect(matrixCheckState(check('x', 'unknown', 'success'), target('pr-classification'))).toBe('invalid');
    expect(matrixCheckState(check('x', 'in_progress', 'success'), target('pr-classification'))).toBe('invalid');
    expect(matrixCheckState(check('x', 'completed', ''), target('pr-classification'))).toBe('invalid');
    expect(matrixCheckState(check('x', 'completed', 'success', { id: 0 }), target('pr-classification')))
      .toBe('invalid');

    const matrix = evaluateMatrix({
      config,
      scope: 'full',
      pull,
      checkRuns: [
        check('PR Classification Gate', 'completed', 'success'),
        check('DCO Sign-off Advisory', 'completed', 'failure'),
        check('Main Authorization Gate', 'completed', 'success'),
        check('Copilot Code Review Gate', 'in_progress'),
      ],
    });
    expect(matrix.state).toBe('pending');
    expect(matrix.pending.map((item) => item.id)).toEqual(['copilot-review-gate']);
    expect(matrix.blocking).toEqual([]);
    expect(matrixConclusion(matrix)).toMatchObject({ status: 'in_progress', presentation: 'matrix.waiting' });
  });

  it('does not prefer an active proxy for a different target', () => {
    const sharedTarget = { ...target('main-authorization'), checkNames: ['Shared Gate'] };
    const matrix = evaluateMatrix({
      config: { gateName: 'Matrix', targets: [sharedTarget] },
      scope: 'full',
      pull,
      checkRuns: [
        check('Shared Gate', 'completed', 'success', { started_at: '2026-07-11T00:00:00Z' }),
        check('Shared Gate', 'in_progress', '', {
          started_at: '2026-07-11T00:01:00Z',
          external_id: legacyProxyExternalId(target('copilot-review-gate'), pull, inputDigest),
        }),
      ],
    });
    expect(matrix.state).toBe('passed');
    expect(matrix.targets[0]?.checkRun?.status).toBe('completed');
  });

  it('prefers a waiting proxy for the current target over a completed run', () => {
    const matrixTarget = { ...target('main-authorization'), checkNames: ['Shared Gate'] };
    const matrix = evaluateMatrix({
      config: { gateName: 'Matrix', targets: [matrixTarget] },
      scope: 'full',
      pull,
      checkRuns: [
        check('Shared Gate', 'completed', 'success', { started_at: '2026-07-11T00:01:00Z' }),
        check('Shared Gate', 'waiting', '', {
          id: 2,
          started_at: '2026-07-11T00:00:00Z',
          external_id: legacyProxyExternalId(matrixTarget, pull, inputDigest),
        }),
      ],
    });
    expect(matrix.state).toBe('pending');
    expect(matrix.targets[0]?.checkRun?.status).toBe('waiting');
  });

  it('groups missing Governance targets into one dispatch and creates one-shot proxy identities', () => {
    const plans = planMatrixRepairs({
      targets: [result('main-authorization', 'missing'), result('copilot-review-gate', 'missing')],
      workflowRuns: [],
      mode: 'enforce',
      pull,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      action: 'dispatch-workflow',
      workflowFile: 'pr-governance.yml',
      inputs: { governanceScope: 'all' },
    });
    expect(plans[0]?.action === 'dispatch-workflow' ? plans[0].targets.map((item) => item.id) : []).toEqual([
      'main-authorization',
      'copilot-review-gate',
    ]);
    expect(legacyProxyExternalId(target('main-authorization'), pull, inputDigest)).toContain(`head:${pull.head.sha}`);
  });

  it('repairs a missing advisory target without making it a Matrix blocker', () => {
    const advisory = result('dco-signoff', 'missing');
    expect(advisory.required).toBe(false);
    expect(planMatrixRepairs({
      targets: [advisory],
      workflowRuns: [],
      mode: 'enforce',
      pull,
    })).toEqual([expect.objectContaining({
      action: 'dispatch-workflow',
      workflowFile: 'dco-check.yml',
      targets: [expect.objectContaining({ id: 'dco-signoff' })],
    })]);
    expect(planMatrixRepairs({
      targets: [advisory],
      workflowRuns: [],
      mode: 'observe',
      pull,
    })).toEqual([]);
  });

  it('refreshes Governance once for trusted review signals and suppresses active proxies', () => {
    const active = check('Copilot Code Review Gate', 'waiting', '', {
      external_id: legacyProxyExternalId(target('copilot-review-gate'), pull, inputDigest),
    });
    expect(planMatrixRepairs({
      targets: [result('main-authorization', 'passed'), result('copilot-review-gate', 'pending', active)],
      workflowRuns: [],
      mode: 'enforce',
      pull,
      eventSignal: 'review-state',
    })).toHaveLength(1);
    expect(planMatrixRepairs({
      targets: [result('copilot-review-gate', 'pending', active)],
      workflowRuns: [],
      mode: 'enforce',
      pull,
      eventSignal: 'copilot-review',
    })).toEqual([]);
  });

  it('plans one rerun for recoverable jobs and manual recovery when no job exists', () => {
    const workflowRun = {
      id: 77,
      name: `PR Validation Target #${pull.number} / ${pull.head.sha}`,
      path: '.github/workflows/pr-classification.yml',
      event: 'workflow_dispatch',
      created_at: '2026-07-11T00:00:00Z',
      jobs: [{ id: 88, name: 'Classify Pull Request' }],
    };
    expect(planMatrixRepairs({
      targets: [result('pr-classification', 'recoverable')],
      workflowRuns: [workflowRun],
      mode: 'enforce',
      pull,
    })).toEqual([{ target: 'pr-classification', action: 'rerun-job', jobId: 88, reason: 'recoverable' }]);
    expect(planMatrixRepairs({
      targets: [result('pr-classification', 'recoverable')],
      workflowRuns: [],
      mode: 'enforce',
      pull,
    })).toEqual([{ target: 'pr-classification', action: 'manual', reason: 'workflow-job-not-found' }]);
  });

  it('completes only active proxies bound to the completed workflow and current pull', () => {
    const proxy = check('Main Authorization Gate', 'waiting', '', {
      id: 901,
      app: { id: appId, slug: appSlug },
      external_id: stewardCheckExternalId({
        repositoryId: 42,
        prNumber: pull.number,
        headSha: pull.head.sha,
        checkId: 'main-authorization',
        configDigest,
        inputDigest,
      }),
    });
    const workflowRun = {
      id: 77,
      name: `PR Validation Target #${pull.number} / ${pull.head.sha}`,
      path: '.github/workflows/pr-governance.yml',
      event: 'workflow_dispatch',
      html_url: 'https://example.test/run/77',
      jobs: [{ id: 88, name: 'Main Authorization Gate', status: 'completed', conclusion: 'success', html_url: 'https://example.test/job/88' }],
    };
    expect(planProxyCompletions({
      workflowRuns: [workflowRun],
      targets: [result('main-authorization', 'pending', proxy)],
      checkRuns: [proxy],
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: false },
    })).toEqual([{
      target: 'main-authorization',
      action: 'complete-proxy-check',
      checkRunId: 901,
      conclusion: 'success',
      sourceJobId: 88,
      sourceUrl: 'https://example.test/job/88',
    }]);
    expect(planProxyCompletions({
      workflowRuns: [{ ...workflowRun, name: `PR Validation Target #122 / ${pull.head.sha}` }],
      targets: [result('main-authorization', 'pending', proxy)],
      checkRuns: [proxy],
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: false },
    })).toEqual([]);
    expect(planProxyCompletions({
      workflowRuns: [workflowRun],
      targets: [result('main-authorization', 'pending', {
        ...proxy,
        external_id: legacyProxyExternalId(target('copilot-review-gate'), pull, inputDigest),
      })],
      checkRuns: [proxy],
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: true },
    })).toEqual([]);
    expect(planProxyCompletions({
      workflowRuns: [workflowRun],
      targets: [{ ...result('main-authorization', 'pending', proxy), acceptableConclusions: [] }],
      checkRuns: [proxy],
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: false },
    })[0]?.conclusion).toBe('success');
  });

  it('matches the exact reusable-workflow job suffix and completes every identical active proxy', () => {
    const external_id = stewardCheckExternalId({
      repositoryId: 42,
      prNumber: pull.number,
      headSha: pull.head.sha,
      checkId: 'main-authorization',
      configDigest,
      inputDigest,
    });
    const proxies = [901, 902].map((id) => check('Main Authorization Gate', 'waiting', '', {
      id, external_id, app: { id: appId, slug: appSlug },
    }));
    const baseWorkflowRun = {
      id: 77,
      name: `PR Validation Target #${pull.number} / ${pull.head.sha}`,
      path: '.github/workflows/pr-governance.yml',
      event: 'workflow_dispatch',
    };
    const plans = planProxyCompletions({
      workflowRuns: [{
        ...baseWorkflowRun,
        jobs: [{ id: 88, name: 'govern / Main Authorization Gate', status: 'completed', conclusion: 'success' }],
      }],
      targets: [result('main-authorization', 'pending', proxies[1])],
      checkRuns: proxies,
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: false },
    });
    expect(plans.map((plan) => plan.checkRunId)).toEqual([901, 902]);

    for (const name of [
      'malicious Main Authorization Gate',
      'govern / nested / Main Authorization Gate',
      'govern / Main Authorization Gate / injected',
    ]) {
      expect(planProxyCompletions({
        workflowRuns: [{
          ...baseWorkflowRun,
          jobs: [{ id: 88, name, status: 'completed', conclusion: 'success' }],
        }],
        targets: [result('main-authorization', 'pending', proxies[1])],
        checkRuns: proxies,
        pull,
        trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: false },
      })).toEqual([]);
    }
  });

  it('uses the newest trusted source run so later Matrix events can finish an interrupted proxy convergence', () => {
    const proxy = check('Main Authorization Gate', 'waiting', '', {
      id: 901,
      app: { id: appId, slug: appSlug },
      external_id: stewardCheckExternalId({
        repositoryId: 42,
        prNumber: pull.number,
        headSha: pull.head.sha,
        checkId: 'main-authorization',
        configDigest,
        inputDigest,
      }),
    });
    const sourceRun = (id: number, created_at: string, status: string): MatrixWorkflowRun => ({
      id,
      name: `PR Validation Target #${pull.number} / ${pull.head.sha}`,
      path: '.github/workflows/pr-governance.yml',
      event: 'workflow_dispatch',
      created_at,
      jobs: [{
        id: id * 10,
        name: 'govern / Main Authorization Gate',
        status,
        ...(status === 'completed' ? { conclusion: 'success' } : {}),
      }],
    });
    const input = {
      targets: [result('main-authorization', 'pending', proxy)],
      checkRuns: [proxy],
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: false },
    };
    expect(planProxyCompletions({
      ...input,
      workflowRuns: [sourceRun(77, '2026-07-11T00:00:00Z', 'completed')],
    })).toHaveLength(1);
    expect(planProxyCompletions({
      ...input,
      workflowRuns: [
        sourceRun(77, '2026-07-11T00:00:00Z', 'completed'),
        sourceRun(78, '2026-07-11T00:01:00Z', 'in_progress'),
      ],
    })).toEqual([]);
  });

  it('binds an identified proxy to its recorded dispatch run without falling back to another matching run', () => {
    const proxy = check('Main Authorization Gate', 'waiting', '', {
      id: 901,
      app: { id: appId, slug: appSlug },
      details_url: `https://github.com/splrad/steward/actions/runs/77`,
      external_id: stewardCheckExternalId({
        repositoryId: 42,
        prNumber: pull.number,
        headSha: pull.head.sha,
        checkId: 'main-authorization',
        configDigest,
        inputDigest,
      }),
    });
    const sourceRun = (
      id: number,
      created_at: string,
      conclusion: 'success' | 'failure',
      overrides: Partial<MatrixWorkflowRun> = {},
    ): MatrixWorkflowRun => ({
      id,
      name: 'PR Governance',
      display_title: `PR Validation Target #${pull.number} / ${pull.head.sha}`,
      path: '.github/workflows/pr-governance.yml',
      event: 'workflow_dispatch',
      created_at,
      jobs: [{
        id: id * 10,
        name: 'govern / Main Authorization Gate',
        status: 'completed',
        conclusion,
      }],
      ...overrides,
    });
    const input = {
      targets: [result('main-authorization', 'pending', proxy)],
      checkRuns: [proxy],
      pull,
      trust: { appId, appSlug, repositoryId: 42, configDigest, inputDigest, allowLegacy: false },
    };
    const recorded = sourceRun(77, '2026-07-11T00:00:00Z', 'success');
    const newer = sourceRun(78, '2026-07-11T00:01:00Z', 'failure');

    expect(planProxyCompletions({ ...input, workflowRuns: [recorded, newer] })).toEqual([
      expect.objectContaining({ sourceJobId: 770, conclusion: 'success' }),
    ]);
    const newerProxy = { ...proxy, id: 902, details_url: 'https://github.com/splrad/steward/actions/runs/78' };
    expect(planProxyCompletions({
      ...input,
      workflowRuns: [recorded, newer],
      targets: [result('main-authorization', 'pending', newerProxy)],
      checkRuns: [proxy, newerProxy],
    })).toEqual([
      expect.objectContaining({ checkRunId: 901, sourceJobId: 770, conclusion: 'success' }),
      expect.objectContaining({ checkRunId: 902, sourceJobId: 780, conclusion: 'failure' }),
    ]);
    expect(planProxyCompletions({ ...input, workflowRuns: [newer] })).toEqual([]);
    expect(planProxyCompletions({
      ...input,
      workflowRuns: [
        sourceRun(77, '2026-07-11T00:00:00Z', 'success', { path: '.github/workflows/untrusted.yml' }),
        newer,
      ],
    })).toEqual([]);
  });
});

describe('review dispatch trust', () => {
  const dispatch = {
    repository: { id: 42, fullName: 'axiomoth/CADFontAutoReplace', defaultBranch: 'main' },
    payload: {
      repositoryId: 42,
      repositoryFullName: 'axiomoth/CADFontAutoReplace',
      prNumber: pull.number,
      headSha: pull.head.sha,
      sourceEvent: 'pull_request_review_thread',
      action: 'resolved',
      deliveryId: 'delivery-1',
    },
    pull: { ...pull, state: 'open' },
  };

  it('accepts current open default-branch review signals', () => {
    expect(validateReviewDispatch(dispatch)).toEqual({
      state: 'passed', signal: 'review-state', reason: 'trusted-review-signal',
    });
    expect(validateReviewDispatch({
      ...dispatch,
      payload: { ...dispatch.payload, repositoryFullName: 'AXIOMOTH/cadfontautoreplace' },
    })).toMatchObject({ state: 'passed', reason: 'trusted-review-signal' });
  });

  it('fails closed on repository identity and ignores stale or unsupported events', () => {
    expect(validateReviewDispatch({
      ...dispatch,
      payload: { ...dispatch.payload, repositoryId: 99 },
    })).toMatchObject({ state: 'failed', reason: 'repository-id-mismatch' });
    expect(validateReviewDispatch({
      ...dispatch,
      payload: { ...dispatch.payload, headSha: 'b'.repeat(40) },
    })).toMatchObject({ state: 'ignored', reason: 'stale-head' });
    expect(validateReviewDispatch({
      ...dispatch,
      payload: { ...dispatch.payload, action: 'submitted' },
    })).toMatchObject({ state: 'ignored', reason: 'unsupported-review-signal' });
  });
});
