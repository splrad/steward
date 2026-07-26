import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeControlMutationReceiptV2,
  buildStewardRuntimeControlPreparedReceiptV2,
  buildStewardRuntimeControlRecoveryReceiptV2,
  type StewardRuntimeControlBindingV2,
  type StewardRuntimeControlMutationBindingV2,
  type StewardRuntimeControlPreparedReceiptV2,
  type StewardRuntimeControlResolvedContextV2,
  type StewardRuntimeControlRevisionV1,
  type StewardRuntimeControlTerminalOutcomeV2,
} from '../packages/core/src/index.js';
import {
  coordinatorMaximumCanonicalPlanBytes,
  coordinatorMutationPlanRetentionLimit,
  CoordinatorMutationPlanStateMachine,
  createCoordinatorMutationPlanState,
  parseCoordinatorMutationResult,
  parseCoordinatorMutationRecoveryResult,
  parseCoordinatorNonAttemptedMutationResult,
  parseCoordinatorPreparedMutationPlan,
} from '../packages/coordinator/src/mutation-ledger.js';

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

const repositoryId = 1_298_587_318;
const repositoryFullName = 'splrad/steward-sandbox-install-e2e';
const pullRequestNumber = 6;
const headSha = 'b'.repeat(40);
const manifestBlobSha = 'c'.repeat(40);
const configDigest = 'd'.repeat(64);
const pullRequestDigest = 'e'.repeat(64);
const planId = 'f'.repeat(64);
const deliveryId = '33f08dc0-7caf-11f1-8d3a-340f601f41b1';

function canonicalValue(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function utf8Base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + 0x8000),
    );
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new Uint8Array(bytes).buffer,
    ),
  );
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function binding(generation = 7): StewardRuntimeControlBindingV2 {
  return {
    workItem: {
      schemaVersion: 1,
      operation: 'pull-request-reconcile',
      installationId: 145_952_003,
      subject: {
        repositoryId,
        repositoryFullName,
        pullRequestNumber,
      },
      cause: {
        kind: 'github-webhook',
        deliveryId,
        event: 'pull_request',
        action: 'synchronize',
        receivedAt: '2026-07-23T16:00:00.000Z',
      },
    },
    generation,
    objective: 'classification',
  };
}

function resolvedContext(): StewardRuntimeControlResolvedContextV2 {
  return {
    repositoryId,
    repositoryFullName,
    pullRequestNumber,
    headSha,
    defaultBranch: 'main',
    manifestBlobSha,
    configDigest,
    pullRequestDigest,
  };
}

function revision(): StewardRuntimeControlRevisionV1 {
  return {
    stewardCommit: 'a'.repeat(40),
    workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
    workerVersionTag: `steward-${'a'.repeat(40)}`,
    workerVersionCreatedAt: '2026-07-23T16:00:00.000Z',
  };
}

function mutation(
  ordinal: number,
  recoveryPolicy: StewardRuntimeControlMutationBindingV2['recoveryPolicy'] =
    'live-evidence',
  principal: StewardRuntimeControlMutationBindingV2['principal'] =
    'installation',
): StewardRuntimeControlMutationBindingV2 {
  return {
    ordinal,
    key: `classification-check.${ordinal}`,
    mutationType: 'check-run.upsert',
    principal,
    recoveryPolicy,
    desiredDigest: (ordinal % 16).toString(16).repeat(64),
  };
}

function canonicalPlan(
  context: StewardRuntimeControlResolvedContextV2,
  mutations: readonly StewardRuntimeControlMutationBindingV2[],
  terminalOutcome: StewardRuntimeControlTerminalOutcomeV2,
): Json {
  return {
    contractVersion: 1,
    planId,
    snapshotDigest: '9'.repeat(64),
    pullRequestDigest: context.pullRequestDigest,
    objective: 'classification',
    subject: {
      repository: {
        id: context.repositoryId,
        owner: 'splrad',
        name: 'steward-sandbox-install-e2e',
        defaultBranch: context.defaultBranch,
      },
      pullRequest: {
        number: context.pullRequestNumber,
        headSha: context.headSha,
      },
      manifest: {
        blobSha: context.manifestBlobSha,
        configDigest: context.configDigest,
      },
      platform: {
        appId: 4_243_096,
        clientId: 'Iv23liSteward',
        appSlug: 'splrad-steward',
      },
    },
    outcome: {
      state: terminalOutcome === 'settled'
        ? 'passed'
        : terminalOutcome === 'pending-external'
          ? 'pending'
          : terminalOutcome === 'ignored'
            ? 'ignored'
            : 'action_required',
      summary: 'External review remains pending.',
    },
    mutations: mutations.map((intent) => ({
      type: intent.mutationType,
      key: intent.key,
      principal: intent.principal,
      desiredDigest: intent.desiredDigest,
      preconditions: {
        repositoryId: context.repositoryId,
        defaultBranch: context.defaultBranch,
        pullNumber: context.pullRequestNumber,
        headSha: context.headSha,
        manifestBlobSha: context.manifestBlobSha,
        configDigest: context.configDigest,
        pullRequestDigest: context.pullRequestDigest,
      },
    })),
  };
}

async function preparedReceipt(
  mutations: readonly StewardRuntimeControlMutationBindingV2[] = [
    mutation(0),
    mutation(1, 'live-evidence-or-action-required', 'human'),
  ],
  terminalOutcome: StewardRuntimeControlTerminalOutcomeV2 =
    'pending-external',
): Promise<StewardRuntimeControlPreparedReceiptV2> {
  const context = resolvedContext();
  const boundMutations = await Promise.all(
    mutations.map(async (intent) => ({
      ...intent,
      desiredDigest: await sha256(
        new TextEncoder().encode(
          JSON.stringify(canonicalValue({
            key: intent.key,
            principal: intent.principal,
            type: intent.mutationType,
          })),
        ),
      ),
    })),
  );
  const planValue = canonicalPlan(
    context,
    boundMutations,
    terminalOutcome,
  ) as { [key: string]: Json };
  const identityValue = { ...planValue };
  delete identityValue.planId;
  const computedPlanId = await sha256(
    new TextEncoder().encode(
      JSON.stringify(canonicalValue(identityValue)),
    ),
  );
  planValue.planId = computedPlanId;
  const text = JSON.stringify(canonicalValue(planValue));
  const bytes = new TextEncoder().encode(text);
  return buildStewardRuntimeControlPreparedReceiptV2({
    binding: binding(),
    resolvedContext: context,
    plan: {
      contractVersion: 1,
      planId: computedPlanId,
      planDigest: await sha256(bytes),
      preparedGeneration: 7,
      terminalOutcome,
      canonicalPlanByteLength: bytes.byteLength,
      canonicalPlanBase64: utf8Base64(bytes),
      mutationCount: boundMutations.length,
      mutations: boundMutations,
    },
    controlRevision: revision(),
  });
}

async function createMachine(
  mutations?: readonly StewardRuntimeControlMutationBindingV2[],
  terminalOutcome?: StewardRuntimeControlTerminalOutcomeV2,
): Promise<{
  machine: CoordinatorMutationPlanStateMachine;
  prepared: StewardRuntimeControlPreparedReceiptV2;
}> {
  const prepared = await preparedReceipt(mutations, terminalOutcome);
  const normalized = await parseCoordinatorPreparedMutationPlan(prepared);
  return {
    machine: new CoordinatorMutationPlanStateMachine(
      createCoordinatorMutationPlanState(normalized, 7, 1_000),
    ),
    prepared,
  };
}

async function mutationReceipt(
  prepared: StewardRuntimeControlPreparedReceiptV2,
  ordinal: number,
  state: 'applied' | 'not-attempted' | 'stale-plan' = 'applied',
) {
  return buildStewardRuntimeControlMutationReceiptV2({
    binding: prepared.binding,
    resolvedContext: prepared.resolvedContext,
    planId: prepared.plan.planId,
    planDigest: prepared.plan.planDigest,
    mutation: prepared.plan.mutations[ordinal]!,
    result: {
      state,
      resourceId: state === 'applied' ? 10_000 + ordinal : null,
      retryAfterSeconds: state === 'not-attempted' ? 30 : null,
    },
    controlRevision: prepared.controlRevision,
  });
}

async function recoveryReceipt(
  prepared: StewardRuntimeControlPreparedReceiptV2,
  ordinal: number,
  state: 'converged' | 'action-required' | 'unknown',
) {
  return buildStewardRuntimeControlRecoveryReceiptV2({
    binding: binding(8),
    resolvedContext: prepared.resolvedContext,
    planId: prepared.plan.planId,
    planDigest: prepared.plan.planDigest,
    mutation: prepared.plan.mutations[ordinal]!,
    result: {
      state,
      resourceId: state === 'converged' ? 10_000 + ordinal : null,
    },
    controlRevision: prepared.controlRevision,
  });
}

describe('CoordinatorMutationPlanStateMachine', () => {
  it('persists the complete v2 identity without a lease credential', async () => {
    const { machine, prepared } = await createMachine();
    const state = machine.exportState();

    expect(coordinatorMaximumCanonicalPlanBytes).toBe(64 * 1_024);
    expect(state).toMatchObject({
      deliveryId: prepared.binding.workItem.cause.deliveryId,
      generation: 7,
      installationId: prepared.binding.workItem.installationId,
      objective: 'classification',
      operation: 'pull-request-reconcile',
      planDigest: prepared.plan.planDigest,
      planId: prepared.plan.planId,
      resolvedContext: prepared.resolvedContext,
      terminalOutcome: 'pending-external',
    });
    expect(state.workItemDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(state.controlRevision).toEqual(prepared.controlRevision);
    expect(JSON.stringify(state)).not.toContain('lease-token');
  });

  it('dispatches each ordered intent at most once and records idempotently', async () => {
    const { machine, prepared } = await createMachine();
    const preview = machine.nextPlannedMutation();
    expect(preview).toMatchObject({
      ordinal: 0,
      dispatchCount: 0,
      state: 'planned',
    });
    if (preview === null) {
      throw new Error('Expected the first planned mutation preview.');
    }
    preview.state = 'unknown';
    expect(machine.exportState().intents[0]).toMatchObject({
      dispatchCount: 0,
      state: 'planned',
    });

    const first = machine.beginNextMutation(1_100);
    expect(first).toMatchObject({
      status: 'ready',
      generation: 7,
      intent: { ordinal: 0, dispatchCount: 1, state: 'applying' },
    });
    expect(machine.beginNextMutation(1_101)).toEqual({
      status: 'already-started',
    });

    const receipt = await parseCoordinatorMutationResult(
      await mutationReceipt(prepared, 0),
    );
    expect(machine.recordMutationResult(receipt, 1_200)).toBe('recorded');
    expect(machine.recordMutationResult(receipt, 1_201)).toBe('duplicate');
    expect(machine.beginNextMutation(1_300)).toMatchObject({
      status: 'ready',
      intent: { ordinal: 1, dispatchCount: 1, state: 'applying' },
    });
  });

  it('rejects mutation receipts with any mismatched persisted identity', async () => {
    const { machine, prepared } = await createMachine();
    machine.beginNextMutation(1_100);
    const valid = await mutationReceipt(prepared, 0);
    const changedRevision = {
      ...valid,
      controlRevision: {
        ...valid.controlRevision,
        stewardCommit: '1'.repeat(40),
        workerVersionTag: `steward-${'1'.repeat(40)}`,
      },
    };
    const candidates = [
      { ...valid, planDigest: '0'.repeat(64) },
      { ...valid, binding: binding(8) },
      { ...valid, mutation: prepared.plan.mutations[1]! },
      changedRevision,
    ];

    for (const candidate of candidates) {
      const parsed = await parseCoordinatorMutationResult(candidate);
      expect(() => machine.recordMutationResult(parsed, 1_200)).toThrow(
        /persisted|applying/,
      );
    }
    expect(machine.exportState()).toMatchObject({
      state: 'applying',
      intents: [{ state: 'applying' }, { state: 'planned' }],
      receipts: [],
    });
  });

  it('enforces settled, pending, and ignored terminal invariants', async () => {
    for (const outcome of ['settled', 'pending-external'] as const) {
      const current = await createMachine([mutation(0)], outcome);
      expect(() => current.machine.complete(1_050)).toThrow(
        /requires all intents/,
      );
      current.machine.beginNextMutation(1_100);
      current.machine.recordMutationResult(
        await parseCoordinatorMutationResult(
          await mutationReceipt(current.prepared, 0),
        ),
        1_200,
      );
      current.machine.complete(1_300);
      expect(current.machine.exportState().state).toBe(outcome);
    }

    const ignored = await createMachine([], 'ignored');
    ignored.machine.complete(1_100);
    expect(ignored.machine.exportState()).toMatchObject({
      state: 'ignored',
      intents: [],
      receipts: [],
    });
  });

  it('abandons an undispatched plan but makes an in-flight mutation unknown', async () => {
    const fresh = await createMachine();
    fresh.machine.markLeaseLost(1_100);
    expect(fresh.machine.exportState()).toMatchObject({
      state: 'abandoned',
      terminalAt: 1_100,
    });

    const active = await createMachine();
    active.machine.beginNextMutation(1_100);
    active.machine.markLeaseLost(1_200);
    expect(active.machine.exportState()).toMatchObject({
      state: 'unknown',
      intents: [{ state: 'unknown' }, { state: 'planned' }],
      terminalAt: null,
    });
    expect(active.machine.beginRecovery(8, 1_300)).toMatchObject({
      status: 'ready',
      planGeneration: 7,
      intent: { ordinal: 0, state: 'unknown' },
    });
    expect(active.machine.beginRecovery(8, 1_301)).toMatchObject({
      status: 'ready',
      planGeneration: 7,
      intent: { ordinal: 0, state: 'unknown' },
    });
    expect(() => active.machine.beginRecovery(9, 1_302)).toThrow(
      /fenced by another generation/,
    );
  });

  it('records proven non-attempts without manufacturing unknown state', async () => {
    const abandoned = await createMachine();
    abandoned.machine.beginNextMutation(1_100);
    const nonAttempted = await parseCoordinatorNonAttemptedMutationResult(
      await mutationReceipt(abandoned.prepared, 0, 'not-attempted'),
    );
    abandoned.machine.recordNonAttempted(nonAttempted, 1_200);
    expect(abandoned.machine.exportState()).toMatchObject({
      state: 'abandoned',
      intents: [
        {
          state: 'cancelled',
          cancelReason: 'not-attempted',
          dispatchCount: 1,
          startedAt: 1_100,
        },
        {
          state: 'cancelled',
          cancelReason: 'superseded-by-replan',
          dispatchCount: 0,
          startedAt: null,
        },
      ],
    });

    const superseded = await createMachine();
    superseded.machine.beginNextMutation(1_100);
    superseded.machine.recordMutationResult(
      await parseCoordinatorMutationResult(
        await mutationReceipt(superseded.prepared, 0),
      ),
      1_200,
    );
    superseded.machine.beginNextMutation(1_300);
    superseded.machine.recordNonAttempted(
      await parseCoordinatorNonAttemptedMutationResult(
        await mutationReceipt(superseded.prepared, 1, 'stale-plan'),
      ),
      1_400,
    );
    expect(superseded.machine.exportState()).toMatchObject({
      state: 'superseded',
      intents: [
        { state: 'settled' },
        { state: 'cancelled', cancelReason: 'stale-plan' },
      ],
    });
  });

  it('supersedes remaining intents after converged recovery and requests replan', async () => {
    const { machine, prepared } = await createMachine();
    machine.beginNextMutation(1_100);
    machine.markLeaseLost(1_200);
    machine.beginRecovery(8, 1_300);

    const receipt = await parseCoordinatorMutationRecoveryResult(
      await recoveryReceipt(prepared, 0, 'converged'),
    );
    expect(
      machine.recordRecoveryResult(8, deliveryId, receipt, 1_400),
    ).toBe('followup');
    expect(machine.exportState()).toMatchObject({
      state: 'superseded',
      intents: [
        { state: 'settled' },
        {
          state: 'cancelled',
          cancelReason: 'superseded-by-replan',
          dispatchCount: 0,
        },
      ],
      receipts: [{ ordinal: 0, source: 'recovery', result: 'converged' }],
    });
  });

  it('rejects recovery evidence that does not bind the current claim and plan context', async () => {
    const { machine, prepared } = await createMachine([mutation(0)]);
    machine.beginNextMutation(1_100);
    machine.markLeaseLost(1_200);
    machine.beginRecovery(8, 1_300);
    const valid = await recoveryReceipt(prepared, 0, 'converged');
    const protocolCandidates = [
      {
        ...valid,
        binding: {
          ...valid.binding,
          workItem: {
            ...valid.binding.workItem,
            subject: {
              ...valid.binding.workItem.subject,
              repositoryId:
                valid.binding.workItem.subject.repositoryId + 1,
            },
          },
        },
      },
      {
        ...valid,
        binding: {
          ...valid.binding,
          workItem: {
            ...valid.binding.workItem,
            subject: {
              ...valid.binding.workItem.subject,
              pullRequestNumber:
                valid.binding.workItem.subject.pullRequestNumber + 1,
            },
          },
        },
      },
    ];
    for (const candidate of protocolCandidates) {
      await expect(
        parseCoordinatorMutationRecoveryResult(candidate),
      ).rejects.toThrow(/repository and pull request identifiers/);
    }

    const persistedBindingCandidates = [
      {
        ...valid,
        binding: {
          ...valid.binding,
          workItem: {
            ...valid.binding.workItem,
            cause: {
              ...valid.binding.workItem.cause,
              deliveryId: 'different-recovery-delivery',
            },
          },
        },
      },
      {
        ...valid,
        resolvedContext: {
          ...valid.resolvedContext,
          headSha: '1'.repeat(40),
        },
      },
      {
        ...valid,
        resolvedContext: {
          ...valid.resolvedContext,
          configDigest: '2'.repeat(64),
        },
      },
    ];

    for (const candidate of persistedBindingCandidates) {
      const parsed = await parseCoordinatorMutationRecoveryResult(candidate);
      expect(() =>
        machine.recordRecoveryResult(
          8,
          deliveryId,
          parsed,
          1_400,
        )).toThrow(/persisted plan/);
    }
    expect(machine.exportState()).toMatchObject({
      state: 'recovering',
      recoveryGeneration: 8,
      intents: [{ state: 'unknown' }],
    });
  });

  it('accepts a renamed repository and replacement installation during recovery', async () => {
    const { machine, prepared } = await createMachine([mutation(0)]);
    machine.beginNextMutation(1_100);
    machine.markLeaseLost(1_200);
    machine.beginRecovery(8, 1_300);
    const valid = await recoveryReceipt(prepared, 0, 'converged');
    const renamed = await parseCoordinatorMutationRecoveryResult({
      ...valid,
      binding: {
        ...valid.binding,
        workItem: {
          ...valid.binding.workItem,
          installationId: valid.binding.workItem.installationId + 1,
          subject: {
            ...valid.binding.workItem.subject,
            repositoryFullName: 'SPLRAD/layerscape-renamed',
          },
        },
      },
    });

    expect(
      machine.recordRecoveryResult(8, deliveryId, renamed, 1_400),
    ).toBe('complete');
    expect(machine.exportState()).toMatchObject({
      state: 'pending-external',
      resolvedContext: {
        repositoryFullName,
      },
      intents: [{ state: 'settled' }],
    });
  });

  it('records known action-required evidence and cancels only the suffix', async () => {
    const { machine, prepared } = await createMachine([
      mutation(0, 'live-evidence-or-action-required', 'human'),
      mutation(1),
    ]);
    machine.beginNextMutation(1_100);
    machine.markLeaseLost(1_200);
    machine.beginRecovery(8, 1_300);

    const receipt = await parseCoordinatorMutationRecoveryResult(
      await recoveryReceipt(prepared, 0, 'action-required'),
    );
    expect(
      machine.recordRecoveryResult(8, deliveryId, receipt, 1_400),
    ).toBe('complete');
    expect(machine.exportState()).toMatchObject({
      state: 'action-required',
      intents: [
        { state: 'action-required' },
        {
          state: 'cancelled',
          cancelReason: 'blocked-by-action-required',
        },
      ],
    });
  });

  it('records a fenced human intent as action-required before dispatch', async () => {
    const { machine } = await createMachine([
      mutation(0, 'live-evidence-or-action-required', 'human'),
      mutation(1),
    ]);

    machine.recordHumanMutationActionRequired(1_100);
    const stored = machine.exportState();
    expect(stored).toMatchObject({
      state: 'action-required',
      intents: [
        {
          state: 'action-required',
          dispatchCount: 0,
          startedAt: null,
        },
        {
          state: 'cancelled',
          cancelReason: 'blocked-by-action-required',
          dispatchCount: 0,
          startedAt: null,
        },
      ],
    });
    expect(
      new CoordinatorMutationPlanStateMachine(stored).exportState(),
    ).toEqual(stored);
  });

  it('keeps unreadable recovery unknown and non-terminal', async () => {
    const { machine, prepared } = await createMachine([mutation(0)]);
    machine.beginNextMutation(1_100);
    machine.markLeaseLost(1_200);
    machine.beginRecovery(8, 1_300);

    const receipt = await parseCoordinatorMutationRecoveryResult(
      await recoveryReceipt(prepared, 0, 'unknown'),
    );
    expect(
      machine.recordRecoveryResult(8, deliveryId, receipt, 1_400),
    ).toBe('retry');
    expect(machine.exportState()).toMatchObject({
      state: 'unknown',
      intents: [{ state: 'unknown' }],
      recoveryGeneration: null,
      terminalAt: null,
    });
  });

  it('accepts the 64-intent protocol bound and rejects impossible stored state', async () => {
    expect(coordinatorMutationPlanRetentionLimit).toBe(128);
    const maximum = Array.from({ length: 64 }, (_, ordinal) =>
      mutation(ordinal));
    const { machine } = await createMachine(maximum);
    expect(machine.exportState().intents).toHaveLength(64);

    const impossible = machine.exportState();
    impossible.state = 'settled';
    impossible.terminalAt = 1_100;
    expect(
      () => new CoordinatorMutationPlanStateMachine(impossible),
    ).toThrow(/terminal plan skipped/);

    const inconsistentRecovery = machine.exportState();
    inconsistentRecovery.intents[0]!.principal = 'human';
    expect(
      () => new CoordinatorMutationPlanStateMachine(inconsistentRecovery),
    ).toThrow(/principal and recovery policy/);
  });
});
