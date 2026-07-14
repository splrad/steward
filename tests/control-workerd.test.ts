import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface LocalWorker {
  ready: Promise<void>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

interface WranglerTestApi {
  unstable_startWorker(options: { config: string }): Promise<LocalWorker>;
}

interface WorkerdControlSmokeResult {
  canonicalPlan: string;
  canonicalPlanDigest: string;
  manifestDigest: string;
  first: {
    planId: string;
    snapshotDigest: string;
    pullRequestDigest: string;
    mutations: { key: string; type: string; mode?: string }[];
    receipts: { key: string; state: string; resourceId?: number }[];
  };
  second: {
    planId: string;
    mutationCount: number;
    receiptCount: number;
  };
  dco: {
    state: string;
    mutationKeys: string[];
    receipts: { key: string; state: string }[];
    remainingComments: number;
    trace: { kind: string; value?: string | number }[];
  };
  final: {
    labels: string[];
    bodyUnchanged: boolean;
    checks: { id: number; name: string; status: string; conclusion: string | null; appId: number | null }[];
    trace: { kind: string; value?: string | number }[];
  };
}

const { unstable_startWorker } = createRequire(import.meta.url)('wrangler') as WranglerTestApi;

let worker: LocalWorker | undefined;

beforeAll(async () => {
  worker = await unstable_startWorker({ config: 'tests/workerd/wrangler.jsonc' });
  await worker.ready;
}, 30_000);

afterAll(async () => {
  await worker?.dispose();
}, 30_000);

describe('Control local workerd reconciliation', () => {
  it('executes Classification plan/apply under workerd without taking ownership of the PR body', async () => {
    if (!worker) throw new Error('Local workerd did not start');

    const firstResponse = await worker.fetch('http://steward.test/smoke');
    const first = await firstResponse.text();
    const secondResponse = await worker.fetch('http://steward.test/smoke');
    const second = await secondResponse.text();

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('content-type')).toContain('application/json');
    expect(secondResponse.status).toBe(200);
    expect(second).toBe(first);

    const result = JSON.parse(first) as WorkerdControlSmokeResult;
    expect(result.canonicalPlanDigest).toBe('cbc16ad06692c7480b84c1f6116baccc019137728d7c6d9a60c58d8de0c367c3');
    expect(result.manifestDigest).toBe('92ba61955253b22cef8f5c2ba674fc6884716e5f8257eeb4fbe8f70a738598b2');
    expect(result.first).toMatchObject({
      planId: '0ddafad6fb3fa53926626ef6ded6383c820a534593b849738df963d1ece0b17a',
      snapshotDigest: 'a3c2f88cf46e21dade763892e946da66ec662ea724e8968fe25a848cba3e1086',
      pullRequestDigest: '2b7cc8805c090d5e4982cfe6d1b1183cdd6b5737d8862b1eedca422f949d53b0',
      mutations: [
        { key: 'check-run:pr-classification:start', type: 'check-run.upsert', mode: 'update' },
        { key: 'repository-label:feature', type: 'repository-label.ensure' },
        { key: 'issue-labels:classification', type: 'issue-labels.add' },
        { key: 'issue-label:documentation', type: 'issue-label.remove' },
        { key: 'check-run:pr-classification:complete', type: 'check-run.upsert', mode: 'update' },
      ],
      receipts: [
        { key: 'check-run:pr-classification:start', state: 'applied', resourceId: 100 },
        { key: 'repository-label:feature', state: 'converged' },
        { key: 'issue-labels:classification', state: 'applied' },
        { key: 'issue-label:documentation', state: 'applied' },
        { key: 'check-run:pr-classification:complete', state: 'applied', resourceId: 100 },
      ],
    });
    expect(result.second).toMatchObject({
      planId: '2721869e29ad2a48925227a012a3e647eceb87e70bba07ce31d738f661a593b1',
      mutationCount: 2,
      receiptCount: 2,
    });
    expect(result.dco).toEqual({
      state: 'passed',
      mutationKeys: ['issue-comment:dco-legacy:10'],
      receipts: [{ key: 'issue-comment:dco-legacy:10', state: 'applied' }],
      remainingComments: 0,
      trace: [{ kind: 'issue-comment.delete', value: 10 }],
    });
    expect(result.final).toEqual({
      labels: ['feature'],
      bodyUnchanged: true,
      checks: [
        {
          id: 100,
          name: 'PR Classification Gate',
          status: 'completed',
          conclusion: 'success',
          appId: 4_243_096,
        },
        {
          id: 101,
          name: 'PR Classification Gate',
          status: 'completed',
          conclusion: 'success',
          appId: 4_243_096,
        },
      ],
      trace: [
        { kind: 'check-run.create' },
        { kind: 'check-run.update', value: 100 },
        { kind: 'repository-label.ensure', value: 'feature' },
        { kind: 'issue-labels.add', value: 'feature' },
        { kind: 'issue-label.remove', value: 'documentation' },
        { kind: 'check-run.update', value: 100 },
        { kind: 'check-run.create' },
        { kind: 'check-run.update', value: 101 },
        { kind: 'check-run.update', value: 101 },
      ],
    });

    const plan = JSON.parse(result.canonicalPlan) as {
      contractVersion: number;
      objective: string;
      planId: string;
      pullRequestDigest: string;
      subject: {
        manifest: { configDigest: string };
        platform: { appId: number; clientId: string; appSlug: string };
        pullRequest: { headSha: string; number: number };
      };
      mutations: {
        observedLabelsDigest?: string;
        observedCheckExternalId?: string;
        preconditions: { pullRequestDigest: string };
      }[];
    };
    expect(plan).toMatchObject({
      contractVersion: 1,
      objective: 'classification',
      planId: result.first.planId,
      pullRequestDigest: result.first.pullRequestDigest,
      subject: {
        manifest: { configDigest: result.manifestDigest },
        platform: {
          appId: 4_243_096,
          clientId: 'Iv23liuSr0qd4WLJdZhH',
          appSlug: 'splrad-steward',
        },
        pullRequest: { headSha: 'c'.repeat(40), number: 76 },
      },
    });
    expect(plan.mutations.every((mutation) => (
      mutation.preconditions.pullRequestDigest === result.first.pullRequestDigest
    ))).toBe(true);
    const labelDigests = plan.mutations
      .map((mutation) => mutation.observedLabelsDigest)
      .filter((digest): digest is string => digest !== undefined);
    expect(labelDigests).toHaveLength(4);
    expect(new Set(labelDigests).size).toBe(3);
    const checkExternalIds = plan.mutations
      .map((mutation) => mutation.observedCheckExternalId)
      .filter((externalId): externalId is string => externalId !== undefined);
    expect(checkExternalIds).toHaveLength(2);
    expect(new Set(checkExternalIds).size).toBe(1);
  });
});
