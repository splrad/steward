import {
  createExecutionContext,
  createMessageBatch,
  evictDurableObject,
  getQueueResult,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeControlMutationReceiptV2,
  buildStewardRuntimeControlPreparedReceiptV2,
  buildStewardRuntimeControlRecoveryReceiptV2,
  buildStewardRuntimeControlReceipt,
  canonicalStewardRuntimeControlPreparedReceiptV2Json,
  canonicalStewardRuntimeControlRecoveryReceiptV2Json,
  canonicalStewardRuntimeControlReceiptJson,
  canonicalStewardRuntimeWorkItemJson,
  parseStewardRuntimeWorkItem,
  type StewardRuntimeWorkItem,
  type StewardRuntimeWorkItemV1,
  type StewardRuntimeWorkItemV2,
  type StewardRuntimeControlMutationBindingV2,
  type StewardRuntimeControlMutationResultV2,
  type StewardRuntimeControlPreparedReceiptV2,
  type StewardRuntimeControlRecoveryResultV2,
  type StewardRuntimeControlResolvedContextV2,
} from '../packages/core/src/index.js';
import {
  coordinatorHumanMutationFenceLimit,
  pullRequestCoordinatorName,
  PullRequestCoordinator,
  type CoordinatorEnv,
} from '../packages/coordinator/src/index.js';
import coordinatorWorker from '../packages/coordinator/src/worker.js';

interface WorkerdEnv {
  PR_COORDINATOR: DurableObjectNamespace<PullRequestCoordinator>;
}

const workerdEnv = env as unknown as WorkerdEnv;

function coordinator(
  repositoryId = 1_298_587_318,
  pullRequestNumber = 6,
): DurableObjectStub<PullRequestCoordinator> {
  return workerdEnv.PR_COORDINATOR.getByName(
    pullRequestCoordinatorName(repositoryId, pullRequestNumber),
  );
}

function workItem(
  deliveryId: string,
  repositoryId = 1_298_587_318,
  pullRequestNumber = 6,
): StewardRuntimeWorkItemV1 {
  return {
    schemaVersion: 1,
    operation: 'runtime-probe',
    installationId: 145_952_003,
    subject: {
      repositoryId,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      pullRequestNumber,
    },
    cause: {
      kind: 'internal-probe',
      deliveryId,
      receivedAt: '2026-07-23T18:00:00.000Z',
    },
  };
}

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

const v2Revision = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-23T18:00:00.000Z',
} as const;

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
    await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer),
  );
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function v2ResolvedContext(
  pullRequestNumber: number,
  repositoryId = 1_298_587_318,
): StewardRuntimeControlResolvedContextV2 {
  return {
    repositoryId,
    repositoryFullName: 'splrad/steward-sandbox-install-e2e',
    pullRequestNumber,
    headSha: 'b'.repeat(40),
    defaultBranch: 'main',
    manifestBlobSha: 'c'.repeat(40),
    configDigest: 'd'.repeat(64),
    pullRequestDigest: 'e'.repeat(64),
  };
}

function v2Mutation(
  variant = 1,
): StewardRuntimeControlMutationBindingV2 {
  return {
    ordinal: 0,
    key: `classification-check.${variant}`,
    mutationType: 'check-run.upsert',
    principal: 'installation',
    recoveryPolicy: 'live-evidence',
    desiredDigest: (variant % 16).toString(16).repeat(64),
  };
}

function v2HumanMutation(
  mutationType = 'copilot-review.request',
  key = 'copilot-review.current-head',
): Partial<StewardRuntimeControlMutationBindingV2> {
  return {
    key,
    mutationType,
    principal: 'human',
    recoveryPolicy: 'live-evidence-or-action-required',
  };
}

async function v2PreparedReceipt(
  generation: number,
  deliveryId: string,
  pullRequestNumber: number,
  variant = 15,
  mutationOverrides:
    | Partial<StewardRuntimeControlMutationBindingV2>
    | readonly Partial<StewardRuntimeControlMutationBindingV2>[] = {},
  contextOverrides: Partial<StewardRuntimeControlResolvedContextV2> = {},
): Promise<StewardRuntimeControlPreparedReceiptV2> {
  const context = {
    ...v2ResolvedContext(pullRequestNumber),
    ...contextOverrides,
  };
  const mutationOverrideList:
    readonly Partial<StewardRuntimeControlMutationBindingV2>[] =
      Array.isArray(mutationOverrides)
        ? mutationOverrides
        : [mutationOverrides];
  const mutations = await Promise.all(
    mutationOverrideList.map(async (overrides, ordinal) => {
      const initialMutation = {
        ...v2Mutation(variant + ordinal),
        ...overrides,
        ordinal,
      };
      return {
        ...initialMutation,
        desiredDigest: await sha256(
          new TextEncoder().encode(
            JSON.stringify(canonicalValue({
              key: initialMutation.key,
              principal: initialMutation.principal,
              type: initialMutation.mutationType,
            })),
          ),
        ),
      };
    }),
  );
  const workItem: StewardRuntimeWorkItemV1 = {
    schemaVersion: 1,
    operation: 'pull-request-reconcile',
    installationId: 145_952_003,
    subject: {
      repositoryId: context.repositoryId,
      repositoryFullName: context.repositoryFullName,
      pullRequestNumber,
    },
    cause: {
      kind: 'github-webhook',
      deliveryId,
      event: 'pull_request',
      action: 'synchronize',
      receivedAt: '2026-07-23T18:00:00.000Z',
    },
  };
  const planValue: Json = {
    contractVersion: 1,
    planId: '0'.repeat(64),
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
      state: 'pending',
      summary: 'External review remains pending.',
    },
    mutations: mutations.map((mutation) => ({
      type: mutation.mutationType,
      key: mutation.key,
      principal: mutation.principal,
      desiredDigest: mutation.desiredDigest,
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
  const identityValue = {
    ...(planValue as { [key: string]: Json }),
  };
  delete identityValue.planId;
  const planId = await sha256(
    new TextEncoder().encode(
      JSON.stringify(canonicalValue(identityValue)),
    ),
  );
  (planValue as { [key: string]: Json }).planId = planId;
  const bytes = new TextEncoder().encode(
    JSON.stringify(canonicalValue(planValue)),
  );
  return buildStewardRuntimeControlPreparedReceiptV2({
    binding: {
      workItem,
      generation,
      objective: 'classification',
    },
    resolvedContext: context,
    plan: {
      contractVersion: 1,
      planId,
      planDigest: await sha256(bytes),
      preparedGeneration: generation,
      terminalOutcome: 'pending-external',
      canonicalPlanByteLength: bytes.byteLength,
      canonicalPlanBase64: utf8Base64(bytes),
      mutationCount: mutations.length,
      mutations,
    },
    controlRevision: v2Revision,
  });
}

async function v2GovernancePreparedReceipt(
  workItem: StewardRuntimeWorkItemV2,
  generation: number,
  withMutation: boolean,
): Promise<StewardRuntimeControlPreparedReceiptV2> {
  const context = v2ResolvedContext(
    workItem.subject.pullRequestNumber,
    workItem.subject.repositoryId,
  );
  const intent = {
    type: 'copilot-review.request',
    key: 'copilot-review:request',
    principal: 'human',
    observedEvidenceDigest: 'f'.repeat(64),
  } as const;
  const desiredDigest = await sha256(
    new TextEncoder().encode(
      JSON.stringify(canonicalValue(intent)),
    ),
  );
  const mutation: StewardRuntimeControlMutationBindingV2 = {
    ordinal: 0,
    key: intent.key,
    mutationType: intent.type,
    principal: intent.principal,
    recoveryPolicy: 'live-evidence-or-action-required',
    desiredDigest,
  };
  const planWithoutId: Json = {
    contractVersion: 1,
    snapshotDigest: '9'.repeat(64),
    pullRequestDigest: context.pullRequestDigest,
    objective: 'governance',
    subject: {
      repository: {
        id: context.repositoryId,
        owner: context.repositoryFullName.split('/')[0]!,
        name: context.repositoryFullName.split('/')[1]!,
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
    outcome: withMutation
      ? { state: 'pending', summary: 'Copilot review remains pending.' }
      : { state: 'ignored', summary: 'No governance mutation is required.' },
    mutations: withMutation
      ? [{
          ...intent,
          desiredDigest,
          preconditions: {
            repositoryId: context.repositoryId,
            defaultBranch: context.defaultBranch,
            pullNumber: context.pullRequestNumber,
            headSha: context.headSha,
            manifestBlobSha: context.manifestBlobSha,
            configDigest: context.configDigest,
            pullRequestDigest: context.pullRequestDigest,
          },
        }]
      : [],
  };
  const planId = await sha256(
    new TextEncoder().encode(
      JSON.stringify(canonicalValue(planWithoutId)),
    ),
  );
  const plan = {
    ...(planWithoutId as { [key: string]: Json }),
    planId,
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify(canonicalValue(plan)),
  );
  return await buildStewardRuntimeControlPreparedReceiptV2({
    binding: {
      workItem,
      generation,
      objective: 'governance',
    },
    resolvedContext: context,
    plan: {
      contractVersion: 1,
      planId,
      planDigest: await sha256(bytes),
      preparedGeneration: generation,
      terminalOutcome: withMutation ? 'pending-external' : 'ignored',
      canonicalPlanByteLength: bytes.byteLength,
      canonicalPlanBase64: utf8Base64(bytes),
      mutationCount: withMutation ? 1 : 0,
      mutations: withMutation ? [mutation] : [],
    },
    controlRevision: v2Revision,
  });
}

async function v2MutationReceipt(
  prepared: StewardRuntimeControlPreparedReceiptV2,
  result: StewardRuntimeControlMutationResultV2 = {
    state: 'applied',
    resourceId: 9_876,
    retryAfterSeconds: null,
  },
  ordinal = 0,
) {
  return buildStewardRuntimeControlMutationReceiptV2({
    binding: prepared.binding,
    resolvedContext: prepared.resolvedContext,
    planId: prepared.plan.planId,
    planDigest: prepared.plan.planDigest,
    mutation: prepared.plan.mutations[ordinal]!,
    result,
    controlRevision: prepared.controlRevision,
  });
}

async function v2RecoveryReceipt(
  prepared: StewardRuntimeControlPreparedReceiptV2,
  recoveryGeneration: number,
  recoveryDeliveryId: string,
  result: StewardRuntimeControlRecoveryResultV2 = {
    state: 'converged',
    resourceId: 9_876,
  },
) {
  return buildStewardRuntimeControlRecoveryReceiptV2({
    binding: {
      ...prepared.binding,
      generation: recoveryGeneration,
      workItem: parseStewardRuntimeWorkItem({
        ...prepared.binding.workItem,
        cause: {
          ...prepared.binding.workItem.cause,
          deliveryId: recoveryDeliveryId,
        },
      }),
    },
    resolvedContext: prepared.resolvedContext,
    planId: prepared.plan.planId,
    planDigest: prepared.plan.planDigest,
    mutation: prepared.plan.mutations[0]!,
    result,
    controlRevision: prepared.controlRevision,
  });
}

async function seedV2MutationLedger(
  stub: DurableObjectStub<PullRequestCoordinator>,
  pullRequestNumber: number,
  count: number,
  state: 'pending-external' | 'unknown',
  terminalAt: number | null,
): Promise<void> {
  const seeds = await Promise.all(
    Array.from({ length: count }, async (_, offset) => {
      const generation = offset + 1;
      const receipt = await v2PreparedReceipt(
        generation,
        `delivery-sidecar-seed-${generation}`,
        pullRequestNumber,
        8,
      );
      const workItemJson = canonicalStewardRuntimeWorkItemJson(
        receipt.binding.workItem,
      );
      return {
        generation,
        receipt,
        preparedReceiptJson:
          await canonicalStewardRuntimeControlPreparedReceiptV2Json(receipt),
        workItemJson,
        workItemDigest: await sha256(
          new TextEncoder().encode(workItemJson),
        ),
      };
    }),
  );

  await runInDurableObject(stub, (_instance, durableState) => {
    const sql = durableState.storage.sql;
    for (const seed of seeds) {
      const { receipt } = seed;
      const context = receipt.resolvedContext;
      const revision = receipt.controlRevision;
      const intent = receipt.plan.mutations[0]!;
      const timestamp = terminalAt ?? 0;
      sql.exec(
        `INSERT INTO coordinator_mutation_plans (
           generation,
           installation_id,
           delivery_id,
           work_item_json,
           work_item_digest,
           prepared_receipt_json,
           plan_id,
           plan_digest,
           operation,
           objective,
           repository_id,
           repository_full_name,
           pull_number,
           head_sha,
           default_branch,
           manifest_blob_sha,
           config_digest,
           pull_request_digest,
           terminal_outcome,
           canonical_plan_byte_length,
           canonical_plan_base64,
           control_steward_commit,
           control_worker_version_id,
           control_worker_version_tag,
           control_worker_version_created_at,
           state,
           recovery_generation,
           created_at,
           updated_at,
           terminal_at
         )
         VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
         )`,
        seed.generation,
        receipt.binding.workItem.installationId,
        receipt.binding.workItem.cause.deliveryId,
        seed.workItemJson,
        seed.workItemDigest,
        seed.preparedReceiptJson,
        receipt.plan.planId,
        receipt.plan.planDigest,
        receipt.binding.workItem.operation,
        receipt.binding.objective,
        String(context.repositoryId),
        context.repositoryFullName,
        context.pullRequestNumber,
        context.headSha,
        context.defaultBranch,
        context.manifestBlobSha,
        context.configDigest,
        context.pullRequestDigest,
        receipt.plan.terminalOutcome,
        receipt.plan.canonicalPlanByteLength,
        receipt.plan.canonicalPlanBase64,
        revision.stewardCommit,
        revision.workerVersionId,
        revision.workerVersionTag,
        revision.workerVersionCreatedAt,
        state,
        timestamp,
        timestamp,
        terminalAt,
      );
      sql.exec(
        `INSERT INTO coordinator_mutation_intents (
           generation,
           ordinal,
           intent_key,
           mutation_type,
           principal,
           desired_digest,
           recovery_policy,
           state,
           cancel_reason,
           dispatch_count,
           started_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
        seed.generation,
        intent.ordinal,
        intent.key,
        intent.mutationType,
        intent.principal,
        intent.desiredDigest,
        intent.recoveryPolicy,
        state === 'unknown' ? 'unknown' : 'settled',
        timestamp,
      );
      if (state === 'pending-external') {
        sql.exec(
          `INSERT INTO coordinator_mutation_receipts (
             generation,
             ordinal,
             intent_key,
             desired_digest,
             result,
             source,
             resource_id,
             recorded_at
           )
           VALUES (?, ?, ?, ?, 'applied', 'apply', ?, ?)`,
          seed.generation,
          intent.ordinal,
          intent.key,
          intent.desiredDigest,
          10_000 + seed.generation,
          timestamp,
        );
      }
    }

    sql.exec(
      `UPDATE coordinator_state
       SET
         generation = ?,
         phase = ?,
         dirty = ?,
         lease_delivery_id = NULL,
         lease_generation = NULL,
         lease_kind = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         failure_code = ?
       WHERE singleton = 1`,
      count,
      state === 'unknown' ? 'followup' : 'idle',
      state === 'unknown' ? 1 : 0,
      state === 'unknown' ? 'control-error' : null,
    );
    sql.exec('DELETE FROM coordinator_deliveries');
  });
}

describe('PullRequestCoordinator in workerd', () => {
  it('persists SQLite-backed completion state across an object eviction', async () => {
    const stub = coordinator(1_298_587_318, 101);
    const claim = await stub.claim('delivery-persisted', 60_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected the initial delivery to be claimed.');
    }

    expect(await stub.complete(claim.generation, claim.leaseToken)).toEqual({
      generation: 1,
      status: 'completed',
    });
    expect(await stub.snapshot()).toMatchObject({
      completedDeliveryCount: 1,
      generation: 1,
      pendingDeliveryCount: 0,
      phase: 'idle',
      subject: {
        pullNumber: 101,
        repositoryId: '1298587318',
      },
    });

    const schemaVersion = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.sql
        .exec<{ version: number }>(
          'SELECT version FROM coordinator_schema WHERE singleton = 1',
        )
        .one().version,
    );
    expect(schemaVersion).toBe(1);

    await evictDurableObject(stub);

    expect(await stub.snapshot()).toMatchObject({
      completedDeliveryCount: 1,
      generation: 1,
      pendingDeliveryCount: 0,
      phase: 'idle',
    });
    expect(await stub.claim('delivery-persisted', 60_000)).toEqual({
      status: 'duplicate',
    });
  });

  it('persists the additive mutation ledger across eviction without credentials', async () => {
    const pullRequestNumber = 201;
    const deliveryId = 'delivery-sidecar-persisted';
    const leaseTokenMarker = 'lease-token-must-not-enter-sidecar';
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const claim = await stub.claim(deliveryId, 60_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected the sidecar delivery to be claimed.');
    }
    const prepared = await v2PreparedReceipt(
      claim.generation,
      deliveryId,
      pullRequestNumber,
    );

    await expect(
      stub.persistPreparedPlan(
        claim.generation,
        claim.leaseToken,
        60_000,
        prepared,
      ),
    ).resolves.toMatchObject({
      status: 'persisted',
      generation: 1,
      planId: prepared.plan.planId,
      planDigest: prepared.plan.planDigest,
    });
    await expect(
      stub.persistPreparedPlan(
        claim.generation,
        claim.leaseToken,
        60_000,
        prepared,
      ),
    ).resolves.toMatchObject({ status: 'duplicate' });
    await expect(
      stub.persistPreparedPlan(
        claim.generation,
        claim.leaseToken,
        60_000,
        await v2PreparedReceipt(
          claim.generation,
          deliveryId,
          pullRequestNumber,
          14,
        ),
      ),
    ).resolves.toMatchObject({
      status: 'conflict',
      generation: 1,
      persistedPlanId: prepared.plan.planId,
      persistedPlanDigest: prepared.plan.planDigest,
    });
    const schema = await runInDurableObject(
      stub,
      (_instance, state) => {
        const sql = state.storage.sql;
        return {
          baseVersion: sql
            .exec<{ version: number }>(
              'SELECT version FROM coordinator_schema WHERE singleton = 1',
            )
            .one().version,
          mutationVersion: sql
            .exec<{ version: number }>(
              'SELECT version FROM coordinator_mutation_schema WHERE singleton = 1',
            )
            .one().version,
          baseColumns: sql
            .exec<{ name: string }>('PRAGMA table_info(coordinator_state)')
            .toArray()
            .map((column) => column.name),
          mutationColumns: sql
            .exec<{ name: string }>(
              'PRAGMA table_info(coordinator_mutation_plans)',
            )
            .toArray()
            .map((column) => column.name),
          humanFenceColumns: sql
            .exec<{ name: string }>(
              'PRAGMA table_info(coordinator_human_mutation_fences)',
            )
            .toArray()
            .map((column) => column.name),
          sidecar: sql
            .exec<{
              canonical_plan_base64: string;
              prepared_receipt_json: string;
              work_item_json: string;
            }>(
              `SELECT
                 canonical_plan_base64,
                 prepared_receipt_json,
                 work_item_json
               FROM coordinator_mutation_plans
               WHERE generation = 1`,
            )
            .one(),
        };
      },
    );
    expect(schema).toMatchObject({
      baseVersion: 1,
      mutationVersion: 1,
    });
    expect(schema.baseColumns).toEqual([
      'singleton',
      'repository_id',
      'pull_number',
      'generation',
      'phase',
      'dirty',
      'lease_delivery_id',
      'lease_generation',
      'lease_kind',
      'lease_token',
      'lease_expires_at',
      'failure_code',
    ]);
    expect(schema.mutationColumns).not.toContain('lease_token');
    expect(schema.humanFenceColumns).toEqual([
      'head_sha',
      'mutation_type',
      'source_generation',
      'source_plan_id',
      'source_plan_digest',
      'intent_key',
      'desired_digest',
      'created_at',
    ]);
    expect(schema.humanFenceColumns).not.toContain('lease_token');
    expect(schema.humanFenceColumns).not.toContain('canonical_plan_base64');
    expect(JSON.stringify(schema.sidecar)).not.toContain(claim.leaseToken);
    expect(JSON.stringify(schema.sidecar)).not.toContain(leaseTokenMarker);
    await expect(
      runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE coordinator_mutation_intents
           SET recovery_policy = 'live-evidence-or-action-required'
           WHERE generation = 1 AND ordinal = 0`,
        );
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(await stub.snapshot())).not.toContain(
      prepared.plan.planId,
    );

    await runInDurableObject(
      stub,
      async (_instance, state) => state.storage.deleteAlarm(),
    );
    await evictDurableObject(stub);
    const ledgerSnapshot = await stub.mutationLedgerSnapshot();
    expect(ledgerSnapshot).toEqual({
      schemaVersion: 1,
      planCount: 1,
      humanMutationFenceCount: 0,
      unresolvedUnknownCount: 0,
      latest: {
        generation: 1,
        planId: prepared.plan.planId,
        planDigest: prepared.plan.planDigest,
        objective: 'classification',
        state: 'prepared',
        intentCounts: {
          total: 1,
          planned: 1,
          applying: 0,
          settled: 0,
          unknown: 0,
          actionRequired: 0,
          cancelled: 0,
        },
        controlVersionId: prepared.controlRevision.workerVersionId,
      },
    });
    expect(JSON.stringify(ledgerSnapshot)).not.toContain(
      prepared.plan.canonicalPlanBase64,
    );
    expect(JSON.stringify(ledgerSnapshot)).not.toContain(
      claim.leaseToken,
    );
    expect(JSON.stringify(ledgerSnapshot)).not.toContain(
      'preparedReceipt',
    );
    expect(JSON.stringify(ledgerSnapshot)).not.toContain(
      'workItem',
    );
    await expect(
      stub.beginNextMutation(
        claim.generation,
        claim.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      intent: { ordinal: 0, state: 'applying' },
    });
    await expect(
      stub.recordMutationResult(
        claim.generation,
        claim.leaseToken,
        await v2MutationReceipt(prepared),
      ),
    ).resolves.toEqual({ status: 'recorded' });
    await expect(
      stub.completeMutationPlan(claim.generation, claim.leaseToken),
    ).resolves.toEqual({ generation: 1, status: 'completed' });

    const terminal = await runInDurableObject(
      stub,
      (_instance, state) => ({
        base: state.storage.sql
          .exec<{ phase: string; lease_token: string | null }>(
            `SELECT phase, lease_token
             FROM coordinator_state
             WHERE singleton = 1`,
          )
          .one(),
        sidecar: state.storage.sql
          .exec<{ state: string; terminal_at: number | null }>(
            `SELECT state, terminal_at
             FROM coordinator_mutation_plans
             WHERE generation = 1`,
          )
          .one(),
      }),
    );
    expect(terminal).toMatchObject({
      base: { phase: 'idle', lease_token: null },
      sidecar: { state: 'pending-external' },
    });
    expect(terminal.sidecar.terminal_at).not.toBeNull();
  });

  it('returns non-attempted retry metadata without changing stale fencing', async () => {
    const cases = [
      {
        pullRequestNumber: 209,
        deliveryId: 'delivery-sidecar-not-attempted',
        result: {
          state: 'not-attempted',
          resourceId: null,
          retryAfterSeconds: 37,
        },
        expected: {
          status: 'followup',
          generation: 1,
          mutationResult: 'not-attempted',
          retryAfterSeconds: 37,
        },
      },
      {
        pullRequestNumber: 210,
        deliveryId: 'delivery-sidecar-stale-plan',
        result: {
          state: 'stale-plan',
          resourceId: null,
          retryAfterSeconds: null,
        },
        expected: {
          status: 'followup',
          generation: 1,
          mutationResult: 'stale-plan',
          retryAfterSeconds: null,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const stub = coordinator(
        1_298_587_318,
        testCase.pullRequestNumber,
      );
      const claim = await stub.claim(testCase.deliveryId, 60_000);
      expect(claim.status).toBe('claimed');
      if (claim.status !== 'claimed') {
        throw new Error('Expected the mutation delivery to be claimed.');
      }
      const prepared = await v2PreparedReceipt(
        claim.generation,
        testCase.deliveryId,
        testCase.pullRequestNumber,
      );
      await stub.persistPreparedPlan(
        claim.generation,
        claim.leaseToken,
        60_000,
        prepared,
      );
      await stub.beginNextMutation(
        claim.generation,
        claim.leaseToken,
        60_000,
      );
      const receipt = await v2MutationReceipt(prepared, testCase.result);

      await expect(
        stub.recordNonAttemptedAndFollowup(
          claim.generation,
          claim.leaseToken,
          receipt,
        ),
      ).resolves.toEqual(testCase.expected);
      await expect(
        stub.recordNonAttemptedAndFollowup(
          claim.generation,
          claim.leaseToken,
          receipt,
        ),
      ).resolves.toEqual({ status: 'stale' });
    }
  });

  it('persists one human dispatch per head and mutation type across eviction', async () => {
    const pullRequestNumber = 211;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const firstDeliveryId = 'delivery-human-fence-first';
    const first = await stub.claim(firstDeliveryId, 60_000);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') {
      throw new Error('Expected the first human mutation claim.');
    }
    const firstPrepared = await v2PreparedReceipt(
      first.generation,
      firstDeliveryId,
      pullRequestNumber,
      12,
      v2HumanMutation(),
    );
    await stub.persistPreparedPlan(
      first.generation,
      first.leaseToken,
      60_000,
      firstPrepared,
    );
    await expect(
      stub.beginNextMutation(
        first.generation,
        first.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      intent: {
        mutationType: 'copilot-review.request',
        principal: 'human',
      },
    });
    await expect(
      stub.recordMutationResult(
        first.generation,
        first.leaseToken,
        await v2MutationReceipt(firstPrepared),
      ),
    ).resolves.toEqual({ status: 'recorded' });
    await expect(
      stub.completeMutationPlan(first.generation, first.leaseToken),
    ).resolves.toEqual({
      generation: first.generation,
      status: 'completed',
    });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 1,
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE coordinator_mutation_plans
         SET terminal_at = 0
         WHERE generation = ?`,
        first.generation,
      );
    });

    await evictDurableObject(stub);
    const blockedDeliveryId = 'delivery-human-fence-blocked';
    const blocked = await stub.claim(blockedDeliveryId, 60_000);
    expect(blocked.status).toBe('claimed');
    if (blocked.status !== 'claimed') {
      throw new Error('Expected the repeated human mutation claim.');
    }
    const blockedPrepared = await v2PreparedReceipt(
      blocked.generation,
      blockedDeliveryId,
      pullRequestNumber,
      13,
      v2HumanMutation(
        'copilot-review.request',
        'copilot-review.same-head-replanned',
      ),
    );
    await stub.persistPreparedPlan(
      blocked.generation,
      blocked.leaseToken,
      60_000,
      blockedPrepared,
    );
    await expect(
      stub.beginNextMutation(
        blocked.generation,
        blocked.leaseToken,
        60_000,
      ),
    ).resolves.toEqual({
      status: 'human-mutation-fenced',
      headSha: 'b'.repeat(40),
      mutationType: 'copilot-review.request',
      sourceGeneration: first.generation,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM coordinator_mutation_plans
           WHERE generation = ?`,
          first.generation,
        )
        .one().count),
    ).resolves.toBe(0);
    await expect(
      stub.fail(
        blocked.generation,
        blocked.leaseToken,
        'control-error',
      ),
    ).resolves.toEqual({
      generation: blocked.generation,
      status: 'followup',
    });

    const otherTypeDeliveryId = 'delivery-human-fence-other-type';
    const otherType = await stub.claim(otherTypeDeliveryId, 60_000);
    expect(otherType.status).toBe('claimed');
    if (otherType.status !== 'claimed') {
      throw new Error('Expected the different human mutation claim.');
    }
    const otherTypePrepared = await v2PreparedReceipt(
      otherType.generation,
      otherTypeDeliveryId,
      pullRequestNumber,
      14,
      v2HumanMutation(
        'reviewer-assignment.request',
        'reviewer-assignment.current-head',
      ),
    );
    await stub.persistPreparedPlan(
      otherType.generation,
      otherType.leaseToken,
      60_000,
      otherTypePrepared,
    );
    await expect(
      stub.beginNextMutation(
        otherType.generation,
        otherType.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      intent: { mutationType: 'reviewer-assignment.request' },
    });
    await expect(
      stub.recordNonAttemptedAndFollowup(
        otherType.generation,
        otherType.leaseToken,
        await v2MutationReceipt(otherTypePrepared, {
          state: 'not-attempted',
          resourceId: null,
          retryAfterSeconds: 30,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'followup',
      mutationResult: 'not-attempted',
    });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 1,
    });

    const newHeadDeliveryId = 'delivery-human-fence-new-head';
    const newHead = await stub.claim(newHeadDeliveryId, 60_000);
    expect(newHead.status).toBe('claimed');
    if (newHead.status !== 'claimed') {
      throw new Error('Expected the new-head human mutation claim.');
    }
    const newHeadPrepared = await v2PreparedReceipt(
      newHead.generation,
      newHeadDeliveryId,
      pullRequestNumber,
      15,
      v2HumanMutation(),
      { headSha: '1'.repeat(40) },
    );
    await stub.persistPreparedPlan(
      newHead.generation,
      newHead.leaseToken,
      60_000,
      newHeadPrepared,
    );
    await expect(
      stub.beginNextMutation(
        newHead.generation,
        newHead.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      intent: { mutationType: 'copilot-review.request' },
    });
    await stub.recordMutationResult(
      newHead.generation,
      newHead.leaseToken,
      await v2MutationReceipt(newHeadPrepared),
    );
    await stub.completeMutationPlan(
      newHead.generation,
      newHead.leaseToken,
    );
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 2,
    });
  });

  it('releases a human fence only when apply proves no write occurred', async () => {
    const pullRequestNumber = 212;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const firstDeliveryId = 'delivery-human-converged-first';
    const first = await stub.claim(firstDeliveryId, 60_000);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') {
      throw new Error('Expected the converged human mutation claim.');
    }
    const firstPrepared = await v2PreparedReceipt(
      first.generation,
      firstDeliveryId,
      pullRequestNumber,
      1,
      v2HumanMutation(),
    );
    await stub.persistPreparedPlan(
      first.generation,
      first.leaseToken,
      60_000,
      firstPrepared,
    );
    await stub.beginNextMutation(
      first.generation,
      first.leaseToken,
      60_000,
    );
    await stub.recordMutationResult(
      first.generation,
      first.leaseToken,
      await v2MutationReceipt(firstPrepared, {
        state: 'converged',
        resourceId: 9_876,
        retryAfterSeconds: null,
      }),
    );
    await stub.completeMutationPlan(first.generation, first.leaseToken);
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 0,
    });

    const secondDeliveryId = 'delivery-human-converged-second';
    const second = await stub.claim(secondDeliveryId, 60_000);
    expect(second.status).toBe('claimed');
    if (second.status !== 'claimed') {
      throw new Error('Expected the post-convergence human mutation claim.');
    }
    const secondPrepared = await v2PreparedReceipt(
      second.generation,
      secondDeliveryId,
      pullRequestNumber,
      2,
      v2HumanMutation(),
    );
    await stub.persistPreparedPlan(
      second.generation,
      second.leaseToken,
      60_000,
      secondPrepared,
    );
    await expect(
      stub.beginNextMutation(
        second.generation,
        second.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      intent: { mutationType: 'copilot-review.request' },
    });
    await stub.recordNonAttemptedAndFollowup(
      second.generation,
      second.leaseToken,
      await v2MutationReceipt(secondPrepared, {
        state: 'stale-plan',
        resourceId: null,
        retryAfterSeconds: null,
      }),
    );
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 0,
    });
  });

  it('does not let a late duplicate receipt release another human intent fence', async () => {
    const pullRequestNumber = 215;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const deliveryId = 'delivery-human-late-duplicate';
    const claim = await stub.claim(deliveryId, 60_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected the multi-intent human mutation claim.');
    }
    const prepared = await v2PreparedReceipt(
      claim.generation,
      deliveryId,
      pullRequestNumber,
      6,
      [
        v2HumanMutation(
          'copilot-review.request',
          'copilot-review.first-proof',
        ),
        v2HumanMutation(
          'copilot-review.request',
          'copilot-review.second-proof',
        ),
      ],
    );
    await stub.persistPreparedPlan(
      claim.generation,
      claim.leaseToken,
      60_000,
      prepared,
    );
    await expect(
      stub.beginNextMutation(
        claim.generation,
        claim.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      intent: { ordinal: 0 },
    });
    const firstConverged = await v2MutationReceipt(
      prepared,
      {
        state: 'converged',
        resourceId: 9_876,
        retryAfterSeconds: null,
      },
      0,
    );
    await expect(
      stub.recordMutationResult(
        claim.generation,
        claim.leaseToken,
        firstConverged,
      ),
    ).resolves.toEqual({ status: 'recorded' });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 0,
    });

    await expect(
      stub.beginNextMutation(
        claim.generation,
        claim.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      intent: { ordinal: 1 },
    });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 1,
      latest: { state: 'applying' },
    });
    await expect(
      stub.recordMutationResult(
        claim.generation,
        claim.leaseToken,
        firstConverged,
      ),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 1,
      latest: { state: 'applying' },
    });

    await stub.recordMutationResult(
      claim.generation,
      claim.leaseToken,
      await v2MutationReceipt(prepared, {
        state: 'applied',
        resourceId: 9_877,
        retryAfterSeconds: null,
      }, 1),
    );
    await stub.completeMutationPlan(
      claim.generation,
      claim.leaseToken,
    );
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 1,
    });

    const repeatedDeliveryId = 'delivery-human-late-duplicate-replan';
    const repeated = await stub.claim(repeatedDeliveryId, 60_000);
    expect(repeated.status).toBe('claimed');
    if (repeated.status !== 'claimed') {
      throw new Error('Expected the post-duplicate replan claim.');
    }
    const repeatedPrepared = await v2PreparedReceipt(
      repeated.generation,
      repeatedDeliveryId,
      pullRequestNumber,
      7,
      v2HumanMutation(),
    );
    await stub.persistPreparedPlan(
      repeated.generation,
      repeated.leaseToken,
      60_000,
      repeatedPrepared,
    );
    await expect(
      stub.beginNextMutation(
        repeated.generation,
        repeated.leaseToken,
        60_000,
      ),
    ).resolves.toEqual({
      status: 'human-mutation-fenced',
      headSha: 'b'.repeat(40),
      mutationType: 'copilot-review.request',
      sourceGeneration: claim.generation,
    });
  });

  it('retains the human fence after unknown recovery converges', async () => {
    const pullRequestNumber = 213;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const firstDeliveryId = 'delivery-human-recovery-first';
    const first = await stub.claim(firstDeliveryId, 60_000);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') {
      throw new Error('Expected the unknown human mutation claim.');
    }
    const prepared = await v2PreparedReceipt(
      first.generation,
      firstDeliveryId,
      pullRequestNumber,
      3,
      v2HumanMutation(),
    );
    await stub.persistPreparedPlan(
      first.generation,
      first.leaseToken,
      60_000,
      prepared,
    );
    await stub.beginNextMutation(
      first.generation,
      first.leaseToken,
      60_000,
    );
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE coordinator_state
        SET
          phase = 'followup',
          dirty = 1,
          lease_delivery_id = NULL,
          lease_generation = NULL,
          lease_kind = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          failure_code = 'lease-expired'
        WHERE singleton = 1
      `);
      state.storage.sql.exec(`
        UPDATE coordinator_deliveries
        SET covered_generation = NULL
        WHERE status = 'pending'
      `);
    });
    await evictDurableObject(stub);
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 1,
      unresolvedUnknownCount: 1,
      latest: {
        generation: first.generation,
        state: 'unknown',
      },
    });

    const recoveryDeliveryId = 'delivery-human-recovery-readback';
    const recovery = await stub.claim(recoveryDeliveryId, 60_000);
    expect(recovery.status).toBe('claimed');
    if (recovery.status !== 'claimed') {
      throw new Error('Expected the human recovery claim.');
    }
    await expect(
      stub.beginRecovery(
        recovery.generation,
        recovery.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      planGeneration: first.generation,
      intent: { principal: 'human', state: 'unknown' },
    });
    await expect(
      stub.recordRecoveryResultAndComplete(
        recovery.generation,
        recovery.leaseToken,
        first.generation,
        await v2RecoveryReceipt(
          prepared,
          recovery.generation,
          recoveryDeliveryId,
        ),
      ),
    ).resolves.toEqual({
      generation: recovery.generation,
      status: 'followup',
    });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 1,
      unresolvedUnknownCount: 0,
    });

    await evictDurableObject(stub);
    const repeatedDeliveryId = 'delivery-human-recovery-repeated';
    const repeated = await stub.claim(repeatedDeliveryId, 60_000);
    expect(repeated.status).toBe('claimed');
    if (repeated.status !== 'claimed') {
      throw new Error('Expected the recovered human replay claim.');
    }
    const repeatedPrepared = await v2PreparedReceipt(
      repeated.generation,
      repeatedDeliveryId,
      pullRequestNumber,
      4,
      v2HumanMutation(),
    );
    await stub.persistPreparedPlan(
      repeated.generation,
      repeated.leaseToken,
      60_000,
      repeatedPrepared,
    );
    await expect(
      stub.beginNextMutation(
        repeated.generation,
        repeated.leaseToken,
        60_000,
      ),
    ).resolves.toEqual({
      status: 'human-mutation-fenced',
      headSha: 'b'.repeat(40),
      mutationType: 'copilot-review.request',
      sourceGeneration: first.generation,
    });
  });

  it('retains the human fence when recovery requires owner action', async () => {
    const pullRequestNumber = 216;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const firstDeliveryId = 'delivery-human-action-first';
    const first = await stub.claim(firstDeliveryId, 60_000);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') {
      throw new Error('Expected the action-required human mutation claim.');
    }
    const prepared = await v2PreparedReceipt(
      first.generation,
      firstDeliveryId,
      pullRequestNumber,
      8,
      v2HumanMutation(),
    );
    await stub.persistPreparedPlan(
      first.generation,
      first.leaseToken,
      60_000,
      prepared,
    );
    await stub.beginNextMutation(
      first.generation,
      first.leaseToken,
      60_000,
    );
    await stub.recordUnknownAndFail(
      first.generation,
      first.leaseToken,
      prepared.plan.mutations[0]!,
    );

    const recoveryDeliveryId = 'delivery-human-action-recovery';
    const recovery = await stub.claim(recoveryDeliveryId, 60_000);
    expect(recovery.status).toBe('claimed');
    if (recovery.status !== 'claimed') {
      throw new Error('Expected the action-required recovery claim.');
    }
    await stub.beginRecovery(
      recovery.generation,
      recovery.leaseToken,
      60_000,
    );
    await expect(
      stub.recordRecoveryResultAndComplete(
        recovery.generation,
        recovery.leaseToken,
        first.generation,
        await v2RecoveryReceipt(
          prepared,
          recovery.generation,
          recoveryDeliveryId,
          { state: 'action-required', resourceId: null },
        ),
      ),
    ).resolves.toEqual({
      generation: recovery.generation,
      status: 'followup',
    });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 1,
      unresolvedUnknownCount: 0,
      latest: {
        generation: first.generation,
        state: 'action-required',
      },
    });

    const repeatedDeliveryId = 'delivery-human-action-repeated';
    const repeated = await stub.claim(repeatedDeliveryId, 60_000);
    expect(repeated.status).toBe('claimed');
    if (repeated.status !== 'claimed') {
      throw new Error('Expected the action-required replay claim.');
    }
    const repeatedPrepared = await v2PreparedReceipt(
      repeated.generation,
      repeatedDeliveryId,
      pullRequestNumber,
      9,
      v2HumanMutation(),
    );
    await stub.persistPreparedPlan(
      repeated.generation,
      repeated.leaseToken,
      60_000,
      repeatedPrepared,
    );
    await expect(
      stub.beginNextMutation(
        repeated.generation,
        repeated.leaseToken,
        60_000,
      ),
    ).resolves.toEqual({
      status: 'human-mutation-fenced',
      headSha: 'b'.repeat(40),
      mutationType: 'copilot-review.request',
      sourceGeneration: first.generation,
    });
  });

  it('fails human dispatch closed when its independent fence ledger is full', async () => {
    const pullRequestNumber = 214;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    await stub.snapshot();
    await runInDurableObject(stub, (_instance, state) => {
      for (
        let offset = 0;
        offset < coordinatorHumanMutationFenceLimit;
        offset += 1
      ) {
        state.storage.sql.exec(
          `INSERT INTO coordinator_human_mutation_fences (
             head_sha,
             mutation_type,
             source_generation,
             source_plan_id,
             source_plan_digest,
             intent_key,
             desired_digest,
             created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          offset.toString(16).padStart(40, '0'),
          'copilot-review.request',
          offset + 1,
          offset.toString(16).padStart(64, '0'),
          (offset + 256).toString(16).padStart(64, '0'),
          `copilot-review.seed-${offset}`,
          (offset + 512).toString(16).padStart(64, '0'),
          offset,
        );
      }
    });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: coordinatorHumanMutationFenceLimit,
    });

    const deliveryId = 'delivery-human-fence-capacity';
    const claim = await stub.claim(deliveryId, 60_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected the human fence capacity claim.');
    }
    const prepared = await v2PreparedReceipt(
      claim.generation,
      deliveryId,
      pullRequestNumber,
      5,
      v2HumanMutation(),
    );
    await stub.persistPreparedPlan(
      claim.generation,
      claim.leaseToken,
      60_000,
      prepared,
    );
    await expect(
      stub.beginNextMutation(
        claim.generation,
        claim.leaseToken,
        60_000,
      ),
    ).resolves.toEqual({
      status: 'human-mutation-fence-capacity',
      limit: coordinatorHumanMutationFenceLimit,
    });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: coordinatorHumanMutationFenceLimit,
      latest: {
        generation: claim.generation,
        state: 'prepared',
      },
    });
  });

  it('expires an alarm and fences the stale generation after reclaim', async () => {
    const stub = coordinator(1_298_587_318, 102);
    const first = await stub.claim('delivery-alarm', 60_000);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') {
      throw new Error('Expected the first generation to be claimed.');
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE coordinator_state SET lease_expires_at = 0 WHERE singleton = 1',
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.snapshot()).toMatchObject({
      dirty: true,
      failureCode: 'lease-expired',
      generation: 1,
      lease: null,
      phase: 'followup',
    });

    const second = await stub.claim('delivery-alarm', 60_000);
    expect(second.status).toBe('claimed');
    if (second.status !== 'claimed') {
      throw new Error('Expected the expired delivery to be reclaimed.');
    }
    expect(second.generation).toBe(2);

    expect(
      await stub.complete(first.generation, first.leaseToken),
    ).toEqual({ status: 'stale' });
    expect(
      await stub.complete(second.generation, second.leaseToken),
    ).toEqual({ generation: 2, status: 'completed' });
  });

  it('uses one logical time for an early alarm and sidecar audit', async () => {
    const pullRequestNumber = 217;
    const deliveryId = 'delivery-sidecar-early-alarm';
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const claim = await stub.claim(deliveryId, 60_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected the early-alarm delivery to be claimed.');
    }
    const prepared = await v2PreparedReceipt(
      claim.generation,
      deliveryId,
      pullRequestNumber,
    );
    await stub.persistPreparedPlan(
      claim.generation,
      claim.leaseToken,
      60_000,
      prepared,
    );
    await stub.beginNextMutation(
      claim.generation,
      claim.leaseToken,
      60_000,
    );

    const expiresAt = Date.now() + 60_000;
    const observed = await runInDurableObject(
      stub,
      async (instance, state) => {
        state.storage.sql.exec(
          `UPDATE coordinator_state
           SET lease_expires_at = ?
           WHERE singleton = 1`,
          expiresAt,
        );
        const now = vi
          .spyOn(Date, 'now')
          .mockReturnValueOnce(expiresAt - 1)
          .mockReturnValueOnce(expiresAt);
        try {
          await instance.alarm();
          return {
            alarmAt: await state.storage.getAlarm(),
            base: state.storage.sql
              .exec<{ phase: string; lease_expires_at: number | null }>(
                `SELECT phase, lease_expires_at
                 FROM coordinator_state
                 WHERE singleton = 1`,
              )
              .one(),
            intent: state.storage.sql
              .exec<{ state: string }>(
                `SELECT state
                 FROM coordinator_mutation_intents
                 WHERE generation = 1 AND ordinal = 0`,
              )
              .one(),
            plan: state.storage.sql
              .exec<{ state: string }>(
                `SELECT state
                 FROM coordinator_mutation_plans
                 WHERE generation = 1`,
              )
              .one(),
          };
        } finally {
          now.mockRestore();
        }
      },
    );

    expect(observed).toEqual({
      alarmAt: expiresAt,
      base: { phase: 'leased', lease_expires_at: expiresAt },
      intent: { state: 'applying' },
      plan: { state: 'applying' },
    });
  });

  it('maps an applying side effect to unknown when its alarm loses the lease', async () => {
    const pullRequestNumber = 202;
    const deliveryId = 'delivery-sidecar-alarm';
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const claim = await stub.claim(deliveryId, 60_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected the sidecar alarm delivery to be claimed.');
    }
    const prepared = await v2PreparedReceipt(
      claim.generation,
      deliveryId,
      pullRequestNumber,
    );
    await stub.persistPreparedPlan(
      claim.generation,
      claim.leaseToken,
      60_000,
      prepared,
    );
    await stub.beginNextMutation(
      claim.generation,
      claim.leaseToken,
      60_000,
    );

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE coordinator_state SET lease_expires_at = 0 WHERE singleton = 1',
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const states = await runInDurableObject(
      stub,
      (_instance, state) => ({
        base: state.storage.sql
          .exec<{ phase: string; failure_code: string | null }>(
            `SELECT phase, failure_code
             FROM coordinator_state
             WHERE singleton = 1`,
          )
          .one(),
        plan: state.storage.sql
          .exec<{ state: string; terminal_at: number | null }>(
            `SELECT state, terminal_at
             FROM coordinator_mutation_plans
             WHERE generation = 1`,
          )
          .one(),
        intent: state.storage.sql
          .exec<{ state: string; dispatch_count: number }>(
            `SELECT state, dispatch_count
             FROM coordinator_mutation_intents
             WHERE generation = 1 AND ordinal = 0`,
          )
          .one(),
      }),
    );
    expect(states).toEqual({
      base: { phase: 'followup', failure_code: 'lease-expired' },
      plan: { state: 'unknown', terminal_at: null },
      intent: { state: 'unknown', dispatch_count: 1 },
    });
  });

  it('audits an old v1 base-only rollback and atomically recovers it', async () => {
    const pullRequestNumber = 203;
    const deliveryId = 'delivery-sidecar-old-rollback';
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const first = await stub.claim(deliveryId, 60_000);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') {
      throw new Error('Expected the rollback delivery to be claimed.');
    }
    const prepared = await v2PreparedReceipt(
      first.generation,
      deliveryId,
      pullRequestNumber,
    );
    await stub.persistPreparedPlan(
      first.generation,
      first.leaseToken,
      60_000,
      prepared,
    );
    await stub.beginNextMutation(
      first.generation,
      first.leaseToken,
      60_000,
    );

    // Simulate the old Coordinator version rolling back after deployment and
    // releasing only the schema-v1 base lease. It knows nothing about the
    // additive mutation tables.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE coordinator_state
        SET
          phase = 'followup',
          dirty = 1,
          lease_delivery_id = NULL,
          lease_generation = NULL,
          lease_kind = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          failure_code = 'lease-expired'
        WHERE singleton = 1
      `);
      state.storage.sql.exec(`
        UPDATE coordinator_deliveries
        SET covered_generation = NULL
        WHERE status = 'pending'
      `);
    });
    await evictDurableObject(stub);

    await stub.snapshot();
    const audited = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.sql
        .exec<{ plan_state: string; intent_state: string }>(`
          SELECT
            plans.state AS plan_state,
            intents.state AS intent_state
          FROM coordinator_mutation_plans AS plans
          JOIN coordinator_mutation_intents AS intents
            ON intents.generation = plans.generation
          WHERE plans.generation = 1 AND intents.ordinal = 0
        `)
        .one(),
    );
    expect(audited).toEqual({
      plan_state: 'unknown',
      intent_state: 'unknown',
    });

    const recoveryDeliveryId = 'delivery-sidecar-recovery-new-event';
    const recovery = await stub.claim(recoveryDeliveryId, 60_000);
    expect(recovery.status).toBe('claimed');
    if (recovery.status !== 'claimed') {
      throw new Error('Expected the rollback delivery to be reclaimed.');
    }
    expect(recovery.generation).toBe(2);
    await expect(
      stub.beginRecovery(
        recovery.generation,
        recovery.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      planGeneration: 1,
      intent: { state: 'unknown', ordinal: 0 },
    });
    await expect(
      stub.recordRecoveryResultAndComplete(
        recovery.generation,
        recovery.leaseToken,
        1,
        await v2RecoveryReceipt(
          prepared,
          recovery.generation,
          recoveryDeliveryId,
        ),
      ),
    ).resolves.toEqual({ generation: 2, status: 'followup' });

    const recovered = await runInDurableObject(
      stub,
      (_instance, state) => ({
        base: state.storage.sql
          .exec<{ phase: string; lease_token: string | null }>(
            `SELECT phase, lease_token
             FROM coordinator_state
             WHERE singleton = 1`,
          )
          .one(),
        plan: state.storage.sql
          .exec<{ state: string; recovery_generation: number | null }>(
            `SELECT state, recovery_generation
             FROM coordinator_mutation_plans
             WHERE generation = 1`,
          )
          .one(),
        receipt: state.storage.sql
          .exec<{ result: string; source: string }>(
            `SELECT result, source
             FROM coordinator_mutation_receipts
             WHERE generation = 1 AND ordinal = 0`,
          )
          .one(),
      }),
    );
    expect(recovered).toEqual({
      base: { phase: 'followup', lease_token: null },
      plan: { state: 'pending-external', recovery_generation: null },
      receipt: { result: 'converged', source: 'recovery' },
    });
  });

  it('blocks a new plan and write dispatch until the unknown plan recovers', async () => {
    const pullRequestNumber = 204;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const firstDeliveryId = 'delivery-sidecar-fence-first';
    const first = await stub.claim(firstDeliveryId, 60_000);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') {
      throw new Error('Expected the first fenced delivery to be claimed.');
    }
    const firstPrepared = await v2PreparedReceipt(
      first.generation,
      firstDeliveryId,
      pullRequestNumber,
      1,
    );
    await stub.persistPreparedPlan(
      first.generation,
      first.leaseToken,
      60_000,
      firstPrepared,
    );
    await stub.beginNextMutation(
      first.generation,
      first.leaseToken,
      60_000,
    );
    await expect(
      stub.recordUnknownAndFail(
        first.generation,
        first.leaseToken,
        firstPrepared.plan.mutations[0]!,
      ),
    ).resolves.toEqual({ generation: 1, status: 'followup' });

    const recoveryDeliveryId = 'delivery-sidecar-fence-recovery';
    const recovery = await stub.claim(recoveryDeliveryId, 60_000);
    expect(recovery.status).toBe('claimed');
    if (recovery.status !== 'claimed') {
      throw new Error('Expected the recovery delivery to be claimed.');
    }
    const blockedPrepared = await v2PreparedReceipt(
      recovery.generation,
      recoveryDeliveryId,
      pullRequestNumber,
      2,
    );
    await expect(
      stub.persistPreparedPlan(
        recovery.generation,
        recovery.leaseToken,
        60_000,
        blockedPrepared,
      ),
    ).resolves.toEqual({
      status: 'recovery-required',
      planGeneration: first.generation,
    });
    await expect(
      stub.beginNextMutation(
        recovery.generation,
        recovery.leaseToken,
        60_000,
      ),
    ).resolves.toEqual({ status: 'recovery-required' });
    await expect(
      stub.beginRecovery(
        recovery.generation,
        recovery.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      planGeneration: first.generation,
      intent: { ordinal: 0, state: 'unknown' },
    });
    await expect(
      stub.recordRecoveryResultAndComplete(
        recovery.generation,
        recovery.leaseToken,
        first.generation,
        await v2RecoveryReceipt(
          firstPrepared,
          recovery.generation,
          recoveryDeliveryId,
        ),
      ),
    ).resolves.toEqual({
      generation: recovery.generation,
      status: 'followup',
    });

    const nextDeliveryId = 'delivery-sidecar-fence-next';
    const next = await stub.claim(nextDeliveryId, 60_000);
    expect(next.status).toBe('claimed');
    if (next.status !== 'claimed') {
      throw new Error('Expected the post-recovery delivery to be claimed.');
    }
    await expect(
      stub.persistPreparedPlan(
        next.generation,
        next.leaseToken,
        60_000,
        await v2PreparedReceipt(
          next.generation,
          nextDeliveryId,
          pullRequestNumber,
          3,
        ),
      ),
    ).resolves.toMatchObject({
      status: 'persisted',
      generation: next.generation,
    });
  });

  it('recovers multiple legacy unknown plans oldest-first before reopening writes', async () => {
    const pullRequestNumber = 205;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    const firstDeliveryId = 'delivery-sidecar-multi-first';
    const first = await stub.claim(firstDeliveryId, 60_000);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') {
      throw new Error('Expected the first legacy delivery to be claimed.');
    }
    const firstPrepared = await v2PreparedReceipt(
      first.generation,
      firstDeliveryId,
      pullRequestNumber,
      4,
    );
    await stub.persistPreparedPlan(
      first.generation,
      first.leaseToken,
      60_000,
      firstPrepared,
    );
    await stub.beginNextMutation(
      first.generation,
      first.leaseToken,
      60_000,
    );
    await stub.recordUnknownAndFail(
      first.generation,
      first.leaseToken,
      firstPrepared.plan.mutations[0]!,
    );

    // Simulate a pre-fence deployment that admitted another plan while the
    // first unknown was unresolved. The rows are restored to a valid unknown
    // state before recovery begins.
    await runInDurableObject(stub, (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `UPDATE coordinator_mutation_plans
         SET state = 'abandoned', terminal_at = ?, updated_at = ?
         WHERE generation = ?`,
        now,
        now,
        first.generation,
      );
      state.storage.sql.exec(
        `UPDATE coordinator_mutation_intents
         SET state = 'cancelled', cancel_reason = 'not-attempted'
         WHERE generation = ?`,
        first.generation,
      );
    });

    const secondDeliveryId = 'delivery-sidecar-multi-second';
    const second = await stub.claim(secondDeliveryId, 60_000);
    expect(second.status).toBe('claimed');
    if (second.status !== 'claimed') {
      throw new Error('Expected the second legacy delivery to be claimed.');
    }
    const secondPrepared = await v2PreparedReceipt(
      second.generation,
      secondDeliveryId,
      pullRequestNumber,
      5,
    );
    await stub.persistPreparedPlan(
      second.generation,
      second.leaseToken,
      60_000,
      secondPrepared,
    );
    await stub.beginNextMutation(
      second.generation,
      second.leaseToken,
      60_000,
    );
    await stub.recordUnknownAndFail(
      second.generation,
      second.leaseToken,
      secondPrepared.plan.mutations[0]!,
    );
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE coordinator_mutation_plans
         SET state = 'unknown', recovery_generation = NULL, terminal_at = NULL
         WHERE generation = ?`,
        first.generation,
      );
      state.storage.sql.exec(
        `UPDATE coordinator_mutation_intents
         SET state = 'unknown', cancel_reason = NULL
         WHERE generation = ?`,
        first.generation,
      );
    });

    const firstRecoveryDeliveryId = 'delivery-sidecar-multi-recovery-one';
    const firstRecovery = await stub.claim(
      firstRecoveryDeliveryId,
      60_000,
    );
    expect(firstRecovery.status).toBe('claimed');
    if (firstRecovery.status !== 'claimed') {
      throw new Error('Expected the first recovery claim.');
    }
    const blockedPrepared = await v2PreparedReceipt(
      firstRecovery.generation,
      firstRecoveryDeliveryId,
      pullRequestNumber,
      6,
    );
    await expect(
      stub.persistPreparedPlan(
        firstRecovery.generation,
        firstRecovery.leaseToken,
        60_000,
        blockedPrepared,
      ),
    ).resolves.toEqual({
      status: 'recovery-required',
      planGeneration: first.generation,
    });
    const oldest = await stub.beginRecovery(
      firstRecovery.generation,
      firstRecovery.leaseToken,
      60_000,
    );
    expect(oldest).toMatchObject({
      status: 'ready',
      planGeneration: first.generation,
    });
    await expect(
      stub.beginRecovery(
        firstRecovery.generation,
        firstRecovery.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      planGeneration: first.generation,
    });
    await expect(
      stub.recordRecoveryResultAndComplete(
        firstRecovery.generation,
        firstRecovery.leaseToken,
        first.generation,
        await v2RecoveryReceipt(
          firstPrepared,
          firstRecovery.generation,
          firstRecoveryDeliveryId,
        ),
      ),
    ).resolves.toEqual({
      generation: firstRecovery.generation,
      status: 'followup',
    });

    const secondRecoveryDeliveryId = 'delivery-sidecar-multi-recovery-two';
    const secondRecovery = await stub.claim(
      secondRecoveryDeliveryId,
      60_000,
    );
    expect(secondRecovery.status).toBe('claimed');
    if (secondRecovery.status !== 'claimed') {
      throw new Error('Expected the second recovery claim.');
    }
    await expect(
      stub.beginRecovery(
        secondRecovery.generation,
        secondRecovery.leaseToken,
        60_000,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      planGeneration: second.generation,
    });
    await expect(
      stub.recordRecoveryResultAndComplete(
        secondRecovery.generation,
        secondRecovery.leaseToken,
        second.generation,
        await v2RecoveryReceipt(
          secondPrepared,
          secondRecovery.generation,
          secondRecoveryDeliveryId,
        ),
      ),
    ).resolves.toEqual({
      generation: secondRecovery.generation,
      status: 'followup',
    });

    const finalDeliveryId = 'delivery-sidecar-multi-final';
    const finalClaim = await stub.claim(finalDeliveryId, 60_000);
    expect(finalClaim.status).toBe('claimed');
    if (finalClaim.status !== 'claimed') {
      throw new Error('Expected the final post-recovery claim.');
    }
    await expect(
      stub.persistPreparedPlan(
        finalClaim.generation,
        finalClaim.leaseToken,
        60_000,
        await v2PreparedReceipt(
          finalClaim.generation,
          finalDeliveryId,
          pullRequestNumber,
          7,
        ),
      ),
    ).resolves.toMatchObject({
      status: 'persisted',
      generation: finalClaim.generation,
    });
  });

  it('deletes expired terminal ledger history before inserting a new plan', async () => {
    const pullRequestNumber = 206;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    await stub.snapshot();
    await seedV2MutationLedger(
      stub,
      pullRequestNumber,
      1,
      'pending-external',
      0,
    );

    const deliveryId = 'delivery-sidecar-retention-expired';
    const claim = await stub.claim(deliveryId, 60_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected the expired-retention claim.');
    }
    await expect(
      stub.persistPreparedPlan(
        claim.generation,
        claim.leaseToken,
        60_000,
        await v2PreparedReceipt(
          claim.generation,
          deliveryId,
          pullRequestNumber,
          9,
        ),
      ),
    ).resolves.toMatchObject({
      status: 'persisted',
      generation: 2,
    });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      planCount: 1,
      latest: { generation: 2, state: 'prepared' },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM coordinator_mutation_plans
           WHERE generation = 1`,
        )
        .one().count),
    ).resolves.toBe(0);
  });

  it('evicts the oldest terminal plan when the ledger reaches capacity', async () => {
    const pullRequestNumber = 207;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    await stub.snapshot();
    await seedV2MutationLedger(
      stub,
      pullRequestNumber,
      128,
      'pending-external',
      Date.now(),
    );

    const deliveryId = 'delivery-sidecar-retention-capacity';
    const claim = await stub.claim(deliveryId, 60_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected the terminal-capacity claim.');
    }
    await expect(
      stub.persistPreparedPlan(
        claim.generation,
        claim.leaseToken,
        60_000,
        await v2PreparedReceipt(
          claim.generation,
          deliveryId,
          pullRequestNumber,
          10,
        ),
      ),
    ).resolves.toMatchObject({
      status: 'persisted',
      generation: 129,
    });
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      planCount: 128,
      latest: { generation: 129, state: 'prepared' },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.sql
        .exec<{ minimum_generation: number }>(
          `SELECT MIN(generation) AS minimum_generation
           FROM coordinator_mutation_plans`,
        )
        .one().minimum_generation),
    ).resolves.toBe(2);
  });

  it('retains 128 unresolved unknown plans and fails a new plan closed', async () => {
    const pullRequestNumber = 208;
    const stub = coordinator(1_298_587_318, pullRequestNumber);
    await stub.snapshot();
    await seedV2MutationLedger(
      stub,
      pullRequestNumber,
      128,
      'unknown',
      null,
    );

    const deliveryId = 'delivery-sidecar-unknown-capacity';
    const claim = await stub.claim(deliveryId, 60_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('Expected the unknown-capacity claim.');
    }
    await expect(
      stub.persistPreparedPlan(
        claim.generation,
        claim.leaseToken,
        60_000,
        await v2PreparedReceipt(
          claim.generation,
          deliveryId,
          pullRequestNumber,
          11,
        ),
      ),
    ).resolves.toEqual({
      status: 'recovery-required',
      planGeneration: 1,
    });
    expect(await stub.mutationLedgerSnapshot()).toEqual({
      schemaVersion: 1,
      planCount: 128,
      humanMutationFenceCount: 0,
      unresolvedUnknownCount: 128,
      latest: expect.objectContaining({
        generation: 128,
        state: 'unknown',
      }),
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM coordinator_mutation_plans
           WHERE generation = 129`,
        )
        .one().count),
    ).resolves.toBe(0);
  });

  it('reports independent per-message acknowledgements and retries', async () => {
    const base = workItem('delivery-queue-workerd', 1_298_587_319);
    const valid: StewardRuntimeWorkItemV2 = {
      ...base,
      schemaVersion: 2,
      operation: 'pull-request-reconcile',
      cause: {
        kind: 'github-webhook',
        deliveryId: base.cause.deliveryId,
        event: 'pull_request_review_thread',
        action: 'resolved',
        receivedAt: base.cause.receivedAt,
      },
    };
    const messages = [
      {
        id: 'queue-valid',
        timestamp: new Date('2026-07-23T18:00:00.000Z'),
        attempts: 1,
        body: canonicalStewardRuntimeWorkItemJson(valid),
      },
      {
        id: 'queue-malformed',
        timestamp: new Date('2026-07-23T18:00:01.000Z'),
        attempts: 1,
        body: '{"schemaVersion":1}',
      },
    ];
    const batch = createMessageBatch('steward-events', messages);
    const ctx = createExecutionContext();
    const controlFetch = vi.fn(
      async (_input: Request | string | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          binding: {
            generation: number;
            workItem: StewardRuntimeWorkItemV2;
          };
        };
        return new Response(
          await canonicalStewardRuntimeControlPreparedReceiptV2Json(
            await v2GovernancePreparedReceipt(
              request.binding.workItem,
              request.binding.generation,
              false,
            ),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );
    const coordinatorEnv: CoordinatorEnv = {
      PR_COORDINATOR: workerdEnv.PR_COORDINATOR,
      CONTROL: { fetch: controlFetch },
      EVENT_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
      },
    };

    await coordinatorWorker.queue(batch, coordinatorEnv);

    const result = await getQueueResult(batch, ctx);
    expect(result.outcome).toBe('ok');
    expect(result.ackAll).toBe(false);
    expect(result.retryBatch.retry).toBe(false);
    expect(result.explicitAcks).toEqual(['queue-valid']);
    expect(result.retryMessages).toEqual([{ msgId: 'queue-malformed' }]);
    expect(controlFetch).toHaveBeenCalledOnce();
    const forwarded = JSON.parse(
      String(controlFetch.mock.calls[0]?.[1]?.body),
    ) as { binding: { workItem: StewardRuntimeWorkItem } };
    expect(forwarded.binding.workItem).toEqual(valid);
  });

  it('runs a persisted v2 mutation and recovers an uncertain response without replay', async () => {
    const repositoryId = 1_298_587_323;
    const pullRequestNumber = 109;
    const base = workItem(
      'delivery-v2-runner-workerd',
      repositoryId,
      pullRequestNumber,
    );
    const item: StewardRuntimeWorkItemV2 = {
      ...base,
      schemaVersion: 2,
      operation: 'pull-request-reconcile',
      cause: {
        kind: 'github-webhook',
        deliveryId: base.cause.deliveryId,
        event: 'pull_request_review',
        action: 'submitted',
        receivedAt: base.cause.receivedAt,
      },
    };
    let unknownPrepared: StewardRuntimeControlPreparedReceiptV2 | undefined;
    let prepareCalls = 0;
    let applyCalls = 0;
    let recoveryCalls = 0;
    const controlFetch = vi.fn(
      async (_input: Request | string | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          phase: 'prepare' | 'apply-next' | 'recover';
          binding: {
            generation: number;
            workItem: StewardRuntimeWorkItemV2;
          };
        };
        if (request.phase === 'prepare') {
          prepareCalls += 1;
          const prepared = await v2GovernancePreparedReceipt(
            request.binding.workItem,
            request.binding.generation,
            prepareCalls === 1,
          );
          if (prepareCalls === 1) unknownPrepared = prepared;
          return new Response(
            await canonicalStewardRuntimeControlPreparedReceiptV2Json(
              prepared,
            ),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        if (request.phase === 'apply-next') {
          applyCalls += 1;
          throw new Error('Control response lost after dispatch');
        }
        recoveryCalls += 1;
        if (unknownPrepared === undefined) {
          throw new Error('Missing persisted prepared receipt');
        }
        return new Response(
          await canonicalStewardRuntimeControlRecoveryReceiptV2Json(
            await v2RecoveryReceipt(
              unknownPrepared,
              request.binding.generation,
              request.binding.workItem.cause.deliveryId,
            ),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );
    const coordinatorEnv: CoordinatorEnv = {
      PR_COORDINATOR: workerdEnv.PR_COORDINATOR,
      CONTROL: { fetch: controlFetch },
      EVENT_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
      },
    };

    const firstBatch = createMessageBatch('steward-events', [{
      id: 'queue-v2-runner-first',
      timestamp: new Date('2026-07-23T18:00:00.000Z'),
      attempts: 1,
      body: canonicalStewardRuntimeWorkItemJson(item),
    }]);
    await coordinatorWorker.queue(firstBatch, coordinatorEnv);
    const firstResult = await getQueueResult(
      firstBatch,
      createExecutionContext(),
    );
    expect(firstResult.explicitAcks).toEqual([]);
    expect(firstResult.retryMessages).toEqual([
      { msgId: 'queue-v2-runner-first' },
    ]);
    expect(applyCalls).toBe(1);
    expect(recoveryCalls).toBe(0);
    expect(prepareCalls).toBe(1);
    expect(await coordinator(repositoryId, pullRequestNumber)
      .mutationLedgerSnapshot()).toMatchObject({
      unresolvedUnknownCount: 1,
      latest: { state: 'unknown' },
    });

    const retryBatch = createMessageBatch('steward-events', [{
      id: 'queue-v2-runner-retry',
      timestamp: new Date('2026-07-23T18:00:01.000Z'),
      attempts: 2,
      body: canonicalStewardRuntimeWorkItemJson(item),
    }]);
    await coordinatorWorker.queue(retryBatch, coordinatorEnv);
    const retryResult = await getQueueResult(
      retryBatch,
      createExecutionContext(),
    );
    expect(retryResult.explicitAcks).toEqual(['queue-v2-runner-retry']);
    expect(retryResult.retryMessages).toEqual([]);
    expect(applyCalls).toBe(1);
    expect(recoveryCalls).toBe(1);
    expect(prepareCalls).toBe(2);
    expect(await coordinator(repositoryId, pullRequestNumber)
      .mutationLedgerSnapshot()).toMatchObject({
      unresolvedUnknownCount: 0,
      latest: { state: 'ignored' },
    });
  });

  it('terminates a same-head human fence as action-required without Queue retry', async () => {
    const repositoryId = 1_298_587_324;
    const pullRequestNumber = 110;
    const stub = coordinator(repositoryId, pullRequestNumber);
    const seedDeliveryId = 'delivery-v2-runner-human-fence-seed';
    const seed = await stub.claim(seedDeliveryId, 60_000);
    expect(seed.status).toBe('claimed');
    if (seed.status !== 'claimed') {
      throw new Error('Expected the human fence seed claim.');
    }
    const seedPrepared = await v2PreparedReceipt(
      seed.generation,
      seedDeliveryId,
      pullRequestNumber,
      7,
      v2HumanMutation(),
      { repositoryId },
    );
    await stub.persistPreparedPlan(
      seed.generation,
      seed.leaseToken,
      60_000,
      seedPrepared,
    );
    await stub.beginNextMutation(
      seed.generation,
      seed.leaseToken,
      60_000,
    );
    await stub.recordMutationResult(
      seed.generation,
      seed.leaseToken,
      await v2MutationReceipt(seedPrepared),
    );
    await stub.completeMutationPlan(seed.generation, seed.leaseToken);

    const base = workItem(
      'delivery-v2-runner-human-fenced',
      repositoryId,
      pullRequestNumber,
    );
    const item: StewardRuntimeWorkItemV2 = {
      ...base,
      schemaVersion: 2,
      operation: 'pull-request-reconcile',
      cause: {
        kind: 'github-webhook',
        deliveryId: base.cause.deliveryId,
        event: 'pull_request_review',
        action: 'submitted',
        receivedAt: base.cause.receivedAt,
      },
    };
    const controlFetch = vi.fn(
      async (_input: Request | string | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          phase: 'prepare';
          binding: {
            generation: number;
            workItem: StewardRuntimeWorkItemV2;
          };
        };
        expect(request.phase).toBe('prepare');
        return new Response(
          await canonicalStewardRuntimeControlPreparedReceiptV2Json(
            await v2GovernancePreparedReceipt(
              request.binding.workItem,
              request.binding.generation,
              true,
            ),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );
    const batch = createMessageBatch('steward-events', [{
      id: 'queue-v2-runner-human-fenced',
      timestamp: new Date('2026-07-23T18:00:02.000Z'),
      attempts: 1,
      body: canonicalStewardRuntimeWorkItemJson(item),
    }]);

    await coordinatorWorker.queue(batch, {
      PR_COORDINATOR: workerdEnv.PR_COORDINATOR,
      CONTROL: { fetch: controlFetch },
      EVENT_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks).toEqual(['queue-v2-runner-human-fenced']);
    expect(result.retryMessages).toEqual([]);
    expect(controlFetch).toHaveBeenCalledOnce();
    expect(await stub.mutationLedgerSnapshot()).toMatchObject({
      humanMutationFenceCount: 1,
      unresolvedUnknownCount: 0,
      latest: {
        state: 'action-required',
      },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.sql
        .exec<{ state: string; dispatch_count: number }>(
          `SELECT state, dispatch_count
           FROM coordinator_mutation_intents
           ORDER BY generation DESC, ordinal
           LIMIT 1`,
        )
        .one()),
    ).resolves.toEqual({
      state: 'action-required',
      dispatch_count: 0,
    });
  });

  it('coalesces more than the persisted delivery window without false DLQ retries', async () => {
    const repositoryId = 1_298_587_320;
    const pullRequestNumber = 106;
    const stub = coordinator(repositoryId, pullRequestNumber);
    let releaseFirstControl!: () => void;
    const firstControlGate = new Promise<void>((resolve) => {
      releaseFirstControl = resolve;
    });
    const controlFetch = vi.fn(
      async (_input: Request | string | URL, init?: RequestInit) => {
        if (controlFetch.mock.calls.length === 1) {
          await firstControlGate;
        }
        const request = JSON.parse(String(init?.body)) as {
          generation: number;
          workItem: StewardRuntimeWorkItem;
        };
        return new Response(
          canonicalStewardRuntimeControlReceiptJson(
            buildStewardRuntimeControlReceipt({
              subject: request.workItem.subject,
              deliveryId: request.workItem.cause.deliveryId,
              generation: request.generation,
              controlRevision: {
                stewardCommit: 'a'.repeat(40),
                workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
                workerVersionTag: `steward-${'a'.repeat(40)}`,
                workerVersionCreatedAt: '2026-07-23T18:00:00.000Z',
              },
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );
    const coordinatorEnv: CoordinatorEnv = {
      PR_COORDINATOR: workerdEnv.PR_COORDINATOR,
      CONTROL: { fetch: controlFetch },
      EVENT_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
      },
    };
    const messages = Array.from({ length: 140 }, (_unused, index) => {
      const item = {
        ...workItem(`delivery-burst-${index}`, repositoryId),
        subject: {
          repositoryId,
          repositoryFullName: 'splrad/steward-sandbox-install-e2e',
          pullRequestNumber,
        },
      };
      return {
        id: `queue-burst-${index}`,
        timestamp: new Date('2026-07-23T18:00:00.000Z'),
        attempts: 1,
        body: canonicalStewardRuntimeWorkItemJson(item),
      };
    });
    const batches = Array.from({ length: 14 }, (_unused, index) =>
      createMessageBatch(
        'steward-events',
        messages.slice(index * 10, index * 10 + 10),
      ));
    const contexts = batches.map(() => createExecutionContext());

    const processing = Promise.all(
      batches.map((batch) => coordinatorWorker.queue(batch, coordinatorEnv)),
    );

    await vi.waitFor(async () => {
      expect(await stub.snapshot()).toMatchObject({
        dirty: true,
        pendingDeliveryCount: 128,
        phase: 'leased',
      });
    });
    releaseFirstControl();
    await processing;

    const results = await Promise.all(
      batches.map((batch, index) => {
        const context = contexts[index];
        if (context === undefined) {
          throw new Error('Missing execution context for Queue batch.');
        }
        return getQueueResult(batch, context);
      }),
    );
    let acknowledged = 0;
    for (const result of results) {
      expect(result.retryMessages).toEqual([]);
      acknowledged += result.explicitAcks.length;
    }
    expect(acknowledged).toBe(140);
    expect(controlFetch).toHaveBeenCalledTimes(2);
    expect(await stub.snapshot()).toMatchObject({
      dirty: false,
      pendingDeliveryCount: 0,
      phase: 'idle',
    });
  });

  it('chains durable wakeups across more work than one Queue retry budget', async () => {
    const repositoryId = 1_298_587_321;
    const pullRequestNumber = 107;
    const stub = coordinator(repositoryId, pullRequestNumber);
    const root = workItem(
      'delivery-paced-root',
      repositoryId,
      pullRequestNumber,
    );
    const wakeupBodies: string[] = [];
    let controlCalls = 0;
    const controlFetch = vi.fn(
      async (_input: Request | string | URL, init?: RequestInit) => {
        controlCalls += 1;
        if (controlCalls <= 40) {
          await expect(
            stub.claim(`delivery-paced-${controlCalls}`, 120_000),
          ).resolves.toMatchObject({ status: 'coalesced' });
        }
        const request = JSON.parse(String(init?.body)) as {
          generation: number;
          workItem: StewardRuntimeWorkItem;
        };
        return new Response(
          canonicalStewardRuntimeControlReceiptJson(
            buildStewardRuntimeControlReceipt({
              subject: request.workItem.subject,
              deliveryId: request.workItem.cause.deliveryId,
              generation: request.generation,
              controlRevision: {
                stewardCommit: 'a'.repeat(40),
                workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
                workerVersionTag: `steward-${'a'.repeat(40)}`,
                workerVersionCreatedAt: '2026-07-23T18:00:00.000Z',
              },
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );
    const wakeupSend = vi.fn(async (body: string) => {
      wakeupBodies.push(body);
    });
    const coordinatorEnv: CoordinatorEnv = {
      PR_COORDINATOR: workerdEnv.PR_COORDINATOR,
      CONTROL: { fetch: controlFetch },
      EVENT_QUEUE: { send: wakeupSend },
    };

    let nextBody: string | undefined =
      canonicalStewardRuntimeWorkItemJson(root);
    let processedRoots = 0;
    while (nextBody !== undefined) {
      const batch = createMessageBatch('steward-events', [
        {
          id: `queue-paced-root-${processedRoots}`,
          timestamp: new Date('2026-07-23T18:00:00.000Z'),
          attempts: 1,
          body: nextBody,
        },
      ]);
      const context = createExecutionContext();
      await coordinatorWorker.queue(batch, coordinatorEnv);
      const result = await getQueueResult(batch, context);
      expect(result.explicitAcks).toHaveLength(1);
      expect(result.retryMessages).toEqual([]);
      processedRoots += 1;
      if (processedRoots > 10) {
        throw new Error('Coordinator wakeup chain did not converge.');
      }
      nextBody = wakeupBodies.shift();
    }

    expect(controlCalls).toBe(41);
    expect(wakeupSend).toHaveBeenCalledTimes(4);
    expect(processedRoots).toBe(5);
    expect(await stub.snapshot()).toMatchObject({
      dirty: false,
      pendingDeliveryCount: 0,
      phase: 'idle',
    });
  });
});
