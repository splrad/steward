import { describe, expect, it } from 'vitest';
import {
  canonicalStewardRuntimeScopeWorkItemJson,
  canonicalStewardRuntimeWorkItemJson,
  type StewardRuntimeScopeWorkItemV1,
  type StewardRuntimeWorkItemV2,
} from '../packages/core/src/index.js';
import {
  classifyDeadLetterBody,
  maximumCapturedDeadLetterBodyBytes,
} from '../packages/recovery/src/capture.js';

const workItem: StewardRuntimeWorkItemV2 = {
  schemaVersion: 2,
  operation: 'pull-request-reconcile',
  installationId: 145_952_003,
  subject: {
    repositoryId: 1_298_587_318,
    repositoryFullName: 'splrad/steward-sandbox-install-e2e',
    pullRequestNumber: 6,
  },
  cause: {
    kind: 'github-webhook',
    deliveryId: '33f08dc0-7caf-11f1-8d3a-340f601f41b1',
    event: 'pull_request',
    action: 'synchronize',
    receivedAt: '2026-07-27T12:00:00.000Z',
  },
};

const scopeItem: StewardRuntimeScopeWorkItemV1 = {
  schemaVersion: 1,
  operation: 'scope-reconcile',
  target: {
    scope: 'repository',
    mode: 'refresh',
    installationId: 145_952_003,
    repositoryId: 1_298_587_318,
    pullRequests: 'all-open',
  },
  cause: {
    kind: 'github-webhook',
    deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
    event: 'repository',
    action: 'renamed',
    receivedAt: '2026-07-27T12:00:00.000Z',
  },
};

describe('dead-letter capture classification', () => {
  it('accepts exact canonical PR and repository envelopes for replay', async () => {
    const workBody = canonicalStewardRuntimeWorkItemJson(workItem);
    const work = await classifyDeadLetterBody(workBody);
    expect(work).toMatchObject({
      eligible: true,
      envelopeKind: 'work-item-v2',
      body: workBody,
      deliveryId: workItem.cause.deliveryId,
      repositoryId: workItem.subject.repositoryId,
      pullRequestNumber: workItem.subject.pullRequestNumber,
    });
    expect(work.entryId).toBe(work.bodyDigest);

    const scopeBody = canonicalStewardRuntimeScopeWorkItemJson(scopeItem);
    await expect(classifyDeadLetterBody(scopeBody)).resolves.toMatchObject({
      eligible: true,
      envelopeKind: 'scope-work-item-v1',
      deliveryId: scopeItem.cause.deliveryId,
      repositoryId: scopeItem.target.repositoryId,
      pullRequestNumber: null,
    });
  });

  it('quarantines noncanonical, malformed, non-text, and unsupported bodies', async () => {
    const noncanonical = JSON.stringify(
      JSON.parse(canonicalStewardRuntimeWorkItemJson(workItem)),
      null,
      2,
    );
    await expect(classifyDeadLetterBody(noncanonical)).resolves.toMatchObject({
      eligible: false,
      envelopeKind: 'quarantined',
      quarantineReason: 'work-item-noncanonical',
    });
    await expect(classifyDeadLetterBody('{')).resolves.toMatchObject({
      eligible: false,
      quarantineReason: 'queue-body-invalid-json',
    });
    await expect(classifyDeadLetterBody({ body: 'unexpected' })).resolves
      .toMatchObject({
        eligible: false,
        quarantineReason: 'queue-body-not-text',
      });
    await expect(classifyDeadLetterBody('{"schemaVersion":99}')).resolves
      .toMatchObject({
        eligible: false,
        quarantineReason: 'unsupported-queue-envelope',
      });
  });

  it('stores bounded metadata rather than an oversized poison body', async () => {
    const oversized = 'x'.repeat(maximumCapturedDeadLetterBodyBytes + 1);
    const classified = await classifyDeadLetterBody(oversized);
    expect(classified).toMatchObject({
      eligible: false,
      quarantineReason: 'queue-body-too-large',
    });
    expect(classified.body).not.toContain(oversized);
    expect(classified.byteLength).toBeLessThan(1_024);
    expect(classified.entryId).toBe(classified.bodyDigest);
  });
});
