import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeControlApplyNextRequestV2,
  buildStewardRuntimeControlMutationReceiptV2,
  buildStewardRuntimeControlPreparedReceiptV2,
  buildStewardRuntimeControlPrepareRequestV2,
  buildStewardRuntimeControlRecoverRequestV2,
  buildStewardRuntimeControlRecoveryReceiptV2,
  buildStewardRuntimeScopeWorkItemV1,
  buildStewardRuntimeWorkItemV3,
  canonicalStewardRuntimeControlApplyNextRequestV2Json,
  canonicalStewardRuntimeControlMutationReceiptV2Json,
  canonicalStewardRuntimeControlPreparedReceiptV2Json,
  canonicalStewardRuntimeControlPrepareRequestV2Json,
  canonicalStewardRuntimeControlRecoverRequestV2Json,
  canonicalStewardRuntimeControlRecoveryReceiptV2Json,
  canonicalControlJson,
  controlJsonDigest,
  deriveStewardRuntimeFanoutDeliveryId,
  parseStewardRuntimeControlApplyNextRequestV2,
  parseStewardRuntimeControlMutationReceiptV2,
  parseStewardRuntimeControlPreparedReceiptV2,
  parseStewardRuntimeControlPrepareRequestV2,
  parseStewardRuntimeControlRecoverRequestV2,
  parseStewardRuntimeControlRecoveryReceiptV2,
  RuntimeControlProtocolValidationError,
  STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES,
  STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_ENVELOPE_BYTES,
  STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_MUTATIONS,
  type StewardRuntimeControlBindingV2,
  type StewardRuntimeControlMutationBindingV2,
  type StewardRuntimeControlPlanBindingV2,
  type StewardRuntimeControlResolvedContextV2,
  type StewardRuntimeControlRevisionV1,
} from '../packages/core/src/index.js';

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
function canonicalJson(value: Json): string {
  return canonicalControlJson(value);
}

function utf8Base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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
        deliveryId: '33f08dc0-7caf-11f1-8d3a-340f601f41b1',
        event: 'pull_request',
        action: 'synchronize',
        receivedAt: '2026-07-23T16:00:00.000Z',
      },
    },
    generation,
    objective: 'dco-advisory',
  };
}

async function fanoutBinding(
  generation = 7,
): Promise<StewardRuntimeControlBindingV2> {
  const scopeWorkItem = buildStewardRuntimeScopeWorkItemV1({
    operation: 'scope-reconcile',
    target: {
      scope: 'repository',
      mode: 'refresh',
      installationId: 145_952_003,
      repositoryId,
      pullRequests: 'all-open',
    },
    cause: {
      kind: 'github-webhook',
      deliveryId: '33f08dc0-7caf-11f1-8d3a-340f601f41b1',
      event: 'repository',
      action: 'renamed',
      receivedAt: '2026-07-23T16:00:00.000Z',
    },
  });
  const deliveryId = await deriveStewardRuntimeFanoutDeliveryId(
    scopeWorkItem,
    generation,
    pullRequestNumber,
  );
  return {
    workItem: buildStewardRuntimeWorkItemV3({
      operation: 'pull-request-reconcile',
      installationId: scopeWorkItem.target.installationId,
      subject: {
        repositoryId: scopeWorkItem.target.repositoryId,
        repositoryFullName,
        pullRequestNumber,
      },
      cause: {
        kind: 'scope-fanout',
        deliveryId,
        rootDeliveryId: scopeWorkItem.cause.deliveryId,
        scopeSchemaVersion: scopeWorkItem.schemaVersion,
        fanoutGeneration: generation,
        event: scopeWorkItem.cause.event,
        action: scopeWorkItem.cause.action,
        receivedAt: scopeWorkItem.cause.receivedAt,
      },
    }),
    generation,
    objective: 'governance',
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
  ordinal = 0,
  recoveryPolicy: StewardRuntimeControlMutationBindingV2['recoveryPolicy'] =
    'live-evidence',
): StewardRuntimeControlMutationBindingV2 {
  return {
    ordinal,
    key: `dco-comment.${ordinal}`,
    mutationType: 'issue-comment.delete',
    principal: 'installation',
    recoveryPolicy,
    desiredDigest: mutationDesiredDigests[ordinal]!,
  };
}

function mutationIntent(ordinal: number): Json {
  return {
    type: 'issue-comment.delete',
    key: `dco-comment.${ordinal}`,
    principal: 'installation',
    commentId: 1_000 + ordinal,
    expectedOwnerId: 4_243_096,
    expectedOwnerLogin: 'splrad-steward[bot]',
    observedBodyDigest: (ordinal % 16).toString(16).repeat(64),
  };
}

const mutationDesiredDigests = await Promise.all(
  Array.from(
    { length: STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_MUTATIONS + 1 },
    (_, ordinal) => controlJsonDigest(mutationIntent(ordinal)),
  ),
);

function canonicalPlanValue(
  context: StewardRuntimeControlResolvedContextV2,
  mutations: readonly StewardRuntimeControlMutationBindingV2[],
  overrides: Record<string, Json> = {},
): Json {
  const [owner, name] = context.repositoryFullName.split('/');
  return {
    contractVersion: 1,
    snapshotDigest: '9'.repeat(64),
    pullRequestDigest: context.pullRequestDigest,
    objective: 'dco-advisory',
    subject: {
      repository: {
        id: context.repositoryId,
        owner: owner!,
        name: name!,
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
    mutations: mutations.map((item) => ({
      ...(mutationIntent(item.ordinal) as Record<string, Json>),
      type: item.mutationType,
      key: item.key,
      principal: item.principal,
      desiredDigest: item.desiredDigest,
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
    ...overrides,
  };
}

async function planBinding(
  mutations: readonly StewardRuntimeControlMutationBindingV2[] = [mutation()],
  planValue = canonicalPlanValue(resolvedContext(), mutations),
): Promise<StewardRuntimeControlPlanBindingV2> {
  const withoutId = planValue as Record<string, Json>;
  const derivedPlanId = await controlJsonDigest(withoutId);
  const text = canonicalJson({
    ...withoutId,
    planId: derivedPlanId,
  });
  const bytes = new TextEncoder().encode(text);
  return {
    contractVersion: 1,
    planId: derivedPlanId,
    planDigest: await sha256(bytes),
    preparedGeneration: 7,
    terminalOutcome: 'pending-external',
    canonicalPlanByteLength: bytes.byteLength,
    canonicalPlanBase64: utf8Base64(bytes),
    mutationCount: mutations.length,
    mutations,
  };
}

async function preparedReceipt() {
  return {
    schemaVersion: 2 as const,
    phase: 'prepared' as const,
    binding: binding(),
    resolvedContext: resolvedContext(),
    plan: await planBinding(),
    controlRevision: revision(),
  };
}

async function applyNextRequest() {
  const prepared = await preparedReceipt();
  return {
    schemaVersion: 2 as const,
    phase: 'apply-next' as const,
    binding: prepared.binding,
    expectedControlRevision: prepared.controlRevision,
    resolvedContext: prepared.resolvedContext,
    plan: prepared.plan,
    mutation: prepared.plan.mutations[0]!,
  };
}

async function recoverRequest(generation = 8) {
  const apply = await applyNextRequest();
  return {
    ...apply,
    phase: 'recover' as const,
    binding: binding(generation),
  };
}

async function expectRejected(
  promise: Promise<unknown>,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(
    RuntimeControlProtocolValidationError,
  );
}

describe('runtime Control v2 phased protocol', () => {
  it('builds, parses, and writes the exact canonical prepare request', async () => {
    const value = {
      schemaVersion: 2 as const,
      phase: 'prepare' as const,
      binding: binding(),
    };
    await expect(parseStewardRuntimeControlPrepareRequestV2(value))
      .resolves.toEqual(value);
    await expect(buildStewardRuntimeControlPrepareRequestV2({
      binding: value.binding,
    })).resolves.toEqual(value);
    await expect(canonicalStewardRuntimeControlPrepareRequestV2Json(value))
      .resolves.toBe(JSON.stringify(value));
  });

  it('round-trips all prepared, mutation, and recovery envelopes', async () => {
    const prepared = await preparedReceipt();
    const apply = await applyNextRequest();
    const recover = await recoverRequest();
    const mutationReceipt = {
      schemaVersion: 2 as const,
      phase: 'mutation-result' as const,
      binding: apply.binding,
      resolvedContext: apply.resolvedContext,
      planId: apply.plan.planId,
      planDigest: apply.plan.planDigest,
      mutation: apply.mutation,
      result: {
        state: 'applied' as const,
        resourceId: 987,
        retryAfterSeconds: null,
      },
      controlRevision: revision(),
    };
    const recoveryReceipt = {
      schemaVersion: 2 as const,
      phase: 'recovery-result' as const,
      binding: recover.binding,
      resolvedContext: recover.resolvedContext,
      planId: recover.plan.planId,
      planDigest: recover.plan.planDigest,
      mutation: recover.mutation,
      result: {
        state: 'converged' as const,
        resourceId: 987,
      },
      controlRevision: revision(),
    };

    await expect(parseStewardRuntimeControlPreparedReceiptV2(prepared))
      .resolves.toEqual(prepared);
    await expect(buildStewardRuntimeControlPreparedReceiptV2({
      binding: prepared.binding,
      resolvedContext: prepared.resolvedContext,
      plan: prepared.plan,
      controlRevision: prepared.controlRevision,
    })).resolves.toEqual(prepared);
    await expect(parseStewardRuntimeControlApplyNextRequestV2(apply))
      .resolves.toEqual(apply);
    await expect(buildStewardRuntimeControlApplyNextRequestV2({
      binding: apply.binding,
      expectedControlRevision: apply.expectedControlRevision,
      resolvedContext: apply.resolvedContext,
      plan: apply.plan,
      mutation: apply.mutation,
    })).resolves.toEqual(apply);
    await expect(parseStewardRuntimeControlRecoverRequestV2(recover))
      .resolves.toEqual(recover);
    await expect(buildStewardRuntimeControlRecoverRequestV2({
      binding: recover.binding,
      expectedControlRevision: recover.expectedControlRevision,
      resolvedContext: recover.resolvedContext,
      plan: recover.plan,
      mutation: recover.mutation,
    })).resolves.toEqual(recover);
    await expect(parseStewardRuntimeControlMutationReceiptV2(mutationReceipt))
      .resolves.toEqual(mutationReceipt);
    await expect(buildStewardRuntimeControlMutationReceiptV2({
      binding: mutationReceipt.binding,
      resolvedContext: mutationReceipt.resolvedContext,
      planId: mutationReceipt.planId,
      planDigest: mutationReceipt.planDigest,
      mutation: mutationReceipt.mutation,
      result: mutationReceipt.result,
      controlRevision: mutationReceipt.controlRevision,
    })).resolves.toEqual(mutationReceipt);
    await expect(parseStewardRuntimeControlRecoveryReceiptV2(recoveryReceipt))
      .resolves.toEqual(recoveryReceipt);
    await expect(buildStewardRuntimeControlRecoveryReceiptV2({
      binding: recoveryReceipt.binding,
      resolvedContext: recoveryReceipt.resolvedContext,
      planId: recoveryReceipt.planId,
      planDigest: recoveryReceipt.planDigest,
      mutation: recoveryReceipt.mutation,
      result: recoveryReceipt.result,
      controlRevision: recoveryReceipt.controlRevision,
    })).resolves.toEqual(recoveryReceipt);

    await expect(canonicalStewardRuntimeControlPreparedReceiptV2Json(prepared))
      .resolves.toBe(JSON.stringify(prepared));
    await expect(canonicalStewardRuntimeControlApplyNextRequestV2Json(apply))
      .resolves.toBe(JSON.stringify(apply));
    await expect(canonicalStewardRuntimeControlRecoverRequestV2Json(recover))
      .resolves.toBe(JSON.stringify(recover));
    await expect(canonicalStewardRuntimeControlMutationReceiptV2Json(mutationReceipt))
      .resolves.toBe(JSON.stringify(mutationReceipt));
    await expect(canonicalStewardRuntimeControlRecoveryReceiptV2Json(recoveryReceipt))
      .resolves.toBe(JSON.stringify(recoveryReceipt));
  });

  it('strictly rejects unknown, symbol, missing, and inherited fields', async () => {
    const prepare = {
      schemaVersion: 2,
      phase: 'prepare',
      binding: binding(),
    };
    await expectRejected(parseStewardRuntimeControlPrepareRequestV2({
      ...prepare,
      route: 'candidate',
    }));
    await expectRejected(parseStewardRuntimeControlPrepareRequestV2({
      schemaVersion: 2,
      phase: 'prepare',
    }));
    const symbol = structuredClone(prepare) as Record<PropertyKey, unknown>;
    Object.defineProperty(symbol.binding as object, Symbol('hidden'), {
      enumerable: true,
      value: true,
    });
    await expectRejected(parseStewardRuntimeControlPrepareRequestV2(symbol));
    await expectRejected(parseStewardRuntimeControlPrepareRequestV2(
      Object.create(prepare),
    ));
  });

  it('accepts only current explicit objective values and webhook PR work', async () => {
    const valid = {
      schemaVersion: 2,
      phase: 'prepare',
      binding: binding(),
    };
    for (const objective of ['governance', 'classification', 'dco-advisory']) {
      await expect(parseStewardRuntimeControlPrepareRequestV2({
        ...valid,
        binding: { ...valid.binding, objective },
      })).resolves.toMatchObject({ binding: { objective } });
    }
    await expectRejected(parseStewardRuntimeControlPrepareRequestV2({
      ...valid,
      binding: { ...valid.binding, objective: 'semantic-governance' },
    }));
    await expectRejected(parseStewardRuntimeControlPrepareRequestV2({
      ...valid,
      binding: {
        ...valid.binding,
        workItem: {
          ...valid.binding.workItem,
          operation: 'runtime-probe',
          cause: {
            kind: 'internal-probe',
            deliveryId: 'probe:runtime:1',
            receivedAt: '2026-07-23T16:00:00.000Z',
          },
        },
      },
    }));
  });

  it('accepts only cryptographically derivable scope fan-out PR work', async () => {
    const valid = {
      schemaVersion: 2,
      phase: 'prepare',
      binding: await fanoutBinding(),
    };
    await expect(parseStewardRuntimeControlPrepareRequestV2(valid))
      .resolves.toEqual(valid);
    const cause = valid.binding.workItem.cause;
    if (cause.kind !== 'scope-fanout') {
      throw new Error('fan-out test fixture must use a scope-fanout cause');
    }

    const changedPull = {
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
    };
    await expectRejected(
      parseStewardRuntimeControlPrepareRequestV2(changedPull),
    );

    const changedGeneration = {
      ...valid,
      binding: {
        ...valid.binding,
        workItem: {
          ...valid.binding.workItem,
          cause: {
            ...cause,
            fanoutGeneration: cause.fanoutGeneration + 1,
          },
        },
      },
    };
    await expectRejected(
      parseStewardRuntimeControlPrepareRequestV2(changedGeneration),
    );

    const changedRoot = {
      ...valid,
      binding: {
        ...valid.binding,
        workItem: {
          ...valid.binding.workItem,
          cause: {
            ...cause,
            rootDeliveryId: 'different-root',
          },
        },
      },
    };
    await expectRejected(
      parseStewardRuntimeControlPrepareRequestV2(changedRoot),
    );
  });

  it('binds live head, default branch, Manifest, config, and PR input digest', async () => {
    const prepared = await preparedReceipt();
    const mutations = [
      {
        ...prepared,
        resolvedContext: {
          ...prepared.resolvedContext,
          headSha: 'B'.repeat(40),
        },
      },
      {
        ...prepared,
        resolvedContext: {
          ...prepared.resolvedContext,
          defaultBranch: 'refs/heads/main',
        },
      },
      {
        ...prepared,
        resolvedContext: {
          ...prepared.resolvedContext,
          manifestBlobSha: 'C'.repeat(40),
        },
      },
      {
        ...prepared,
        resolvedContext: {
          ...prepared.resolvedContext,
          configDigest: 'D'.repeat(64),
        },
      },
      {
        ...prepared,
        resolvedContext: {
          ...prepared.resolvedContext,
          pullRequestDigest: 'E'.repeat(64),
        },
      },
    ];
    for (const invalid of mutations) {
      await expectRejected(parseStewardRuntimeControlPreparedReceiptV2(invalid));
    }

    const changedContext = {
      ...prepared.resolvedContext,
      defaultBranch: 'trunk',
    };
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      resolvedContext: changedContext,
    }));

    for (const resolvedContext of [
      {
        ...prepared.resolvedContext,
        repositoryId: prepared.resolvedContext.repositoryId + 1,
      },
      {
        ...prepared.resolvedContext,
        pullRequestNumber: prepared.resolvedContext.pullRequestNumber + 1,
      },
    ]) {
      await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
        ...prepared,
        resolvedContext,
      }));
    }

    const renamedContext = {
      ...prepared.resolvedContext,
      repositoryFullName: 'splrad/steward-renamed',
    };
    const renamedPlan = await planBinding(
      prepared.plan.mutations,
      canonicalPlanValue(renamedContext, prepared.plan.mutations),
    );
    await expect(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      resolvedContext: renamedContext,
      plan: renamedPlan,
    })).resolves.toMatchObject({
      resolvedContext: { repositoryFullName: 'splrad/steward-renamed' },
    });
  });

  it('binds terminal outcome and every persisted intent field to canonical plan bytes', async () => {
    const prepared = await preparedReceipt();
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: {
        ...prepared.plan,
        terminalOutcome: 'settled',
      },
    }));
    for (const changed of [
      { mutationType: 'repository-label.ensure' },
      { principal: 'human' },
      { desiredDigest: '1'.repeat(64) },
      { key: 'other-key' },
    ]) {
      await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
        ...prepared,
        plan: {
          ...prepared.plan,
          mutations: [{ ...prepared.plan.mutations[0]!, ...changed }],
        },
      }));
    }
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: {
        ...prepared.plan,
        mutations: [{
          ...prepared.plan.mutations[0]!,
          recoveryPolicy: 'unsupported',
        }],
      },
    }));

    const failedPlan = await planBinding(
      prepared.plan.mutations,
      canonicalPlanValue(
        prepared.resolvedContext,
        prepared.plan.mutations,
        {
          outcome: {
            state: 'failed',
            summary: 'Policy is conclusively blocking this pull request.',
          },
        },
      ),
    );
    await expect(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: {
        ...failedPlan,
        terminalOutcome: 'settled',
      },
    })).resolves.toMatchObject({
      plan: { terminalOutcome: 'settled' },
    });
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: {
        ...failedPlan,
        terminalOutcome: 'action-required',
      },
    }));

    const wrongObjectivePlan = await planBinding(
      prepared.plan.mutations,
      canonicalPlanValue(
        prepared.resolvedContext,
        prepared.plan.mutations,
        { objective: 'governance' },
      ),
    );
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: wrongObjectivePlan,
    }));

    const wrongPreconditionValue = canonicalPlanValue(
      prepared.resolvedContext,
      prepared.plan.mutations,
    ) as Record<string, Json>;
    const decodedMutations = wrongPreconditionValue.mutations as Json[];
    const decodedMutation = decodedMutations[0] as Record<string, Json>;
    decodedMutation.preconditions = {
      ...(decodedMutation.preconditions as Record<string, Json>),
      configDigest: '0'.repeat(64),
    };
    const wrongPreconditionPlan = await planBinding(
      prepared.plan.mutations,
      wrongPreconditionValue,
    );
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: wrongPreconditionPlan,
    }));
  });

  it('requires canonical padded base64, byte length, UTF-8, JSON, and full-plan digest', async () => {
    const prepared = await preparedReceipt();
    const encoded = prepared.plan.canonicalPlanBase64;
    for (const canonicalPlanBase64 of [
      `${encoded.slice(0, -1)}-`,
      'SGVsbG8',
      `${encoded}\n`,
    ]) {
      await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
        ...prepared,
        plan: { ...prepared.plan, canonicalPlanBase64 },
      }));
    }

    const bomText = `\uFEFF${canonicalJson(
      canonicalPlanValue(prepared.resolvedContext, prepared.plan.mutations),
    )}`;
    const bomBytes = new TextEncoder().encode(bomText);
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: {
        ...prepared.plan,
        planDigest: await sha256(bomBytes),
        canonicalPlanByteLength: bomBytes.byteLength,
        canonicalPlanBase64: utf8Base64(bomBytes),
      },
    }));
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: {
        ...prepared.plan,
        canonicalPlanByteLength: prepared.plan.canonicalPlanByteLength + 1,
      },
    }));
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: { ...prepared.plan, planDigest: '0'.repeat(64) },
    }));

    const nonCanonicalText = JSON.stringify(
      canonicalPlanValue(prepared.resolvedContext, prepared.plan.mutations),
    );
    const nonCanonicalBytes = new TextEncoder().encode(nonCanonicalText);
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: {
        ...prepared.plan,
        planDigest: await sha256(nonCanonicalBytes),
        canonicalPlanByteLength: nonCanonicalBytes.byteLength,
        canonicalPlanBase64: utf8Base64(nonCanonicalBytes),
      },
    }));
  });

  it('recomputes Control plan and intent identities instead of trusting aliases', async () => {
    const prepared = await preparedReceipt();
    const decoded = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(
        atob(prepared.plan.canonicalPlanBase64),
        (character) => character.charCodeAt(0),
      )),
    ) as Record<string, Json>;

    const aliasedPlanId = '7'.repeat(64);
    const aliasedPlanText = canonicalJson({
      ...decoded,
      planId: aliasedPlanId,
    });
    const aliasedPlanBytes = new TextEncoder().encode(aliasedPlanText);
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: {
        ...prepared.plan,
        planId: aliasedPlanId,
        planDigest: await sha256(aliasedPlanBytes),
        canonicalPlanByteLength: aliasedPlanBytes.byteLength,
        canonicalPlanBase64: utf8Base64(aliasedPlanBytes),
      },
    }));

    const withoutPlanId = structuredClone(decoded);
    delete withoutPlanId.planId;
    const decodedMutations = withoutPlanId.mutations as Json[];
    const changedDesiredDigest = '8'.repeat(64);
    (decodedMutations[0] as Record<string, Json>).desiredDigest =
      changedDesiredDigest;
    const reboundPlanId = await controlJsonDigest(withoutPlanId);
    const reboundPlanText = canonicalJson({
      ...withoutPlanId,
      planId: reboundPlanId,
    });
    const reboundPlanBytes = new TextEncoder().encode(reboundPlanText);
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: {
        ...prepared.plan,
        planId: reboundPlanId,
        planDigest: await sha256(reboundPlanBytes),
        canonicalPlanByteLength: reboundPlanBytes.byteLength,
        canonicalPlanBase64: utf8Base64(reboundPlanBytes),
        mutations: [{
          ...prepared.plan.mutations[0]!,
          desiredDigest: changedDesiredDigest,
        }],
      },
    }));
  });

  it('enforces the 64-intent and 64-KiB raw canonical plan limits', async () => {
    expect(STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_MUTATIONS).toBe(64);
    expect(STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES)
      .toBe(64 * 1_024);
    expect(STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_ENVELOPE_BYTES)
      .toBe(128 * 1_024);

    const maximum = Array.from(
      { length: STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_MUTATIONS },
      (_, ordinal) => mutation(ordinal),
    );
    const maximumPlan = await planBinding(
      maximum,
      canonicalPlanValue(resolvedContext(), maximum),
    );
    await expect(parseStewardRuntimeControlPreparedReceiptV2({
      ...(await preparedReceipt()),
      plan: maximumPlan,
    })).resolves.toMatchObject({ plan: { mutationCount: 64 } });

    const overflow = [...maximum, mutation(maximum.length)];
    const overflowPlan = await planBinding(
      overflow,
      canonicalPlanValue(resolvedContext(), overflow),
    );
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...(await preparedReceipt()),
      plan: overflowPlan,
    }));

    const emptyPaddingPlan = canonicalPlanValue(
      resolvedContext(),
      [mutation()],
      {
        outcome: {
          state: 'pending',
          summary: '',
        },
      },
    ) as Record<string, Json>;
    const emptyPaddingText = canonicalJson({
      ...emptyPaddingPlan,
      planId: await controlJsonDigest(emptyPaddingPlan),
    });
    const exactPaddingLength =
      STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES
      - new TextEncoder().encode(emptyPaddingText).byteLength;
    const maximumPlanValue = canonicalPlanValue(
      resolvedContext(),
      [mutation()],
      {
        outcome: {
          state: 'pending',
          summary: 'x'.repeat(exactPaddingLength),
        },
      },
    );
    const maximumBytePlan = await planBinding(
      [mutation()],
      maximumPlanValue,
    );
    const maximumBytes = Uint8Array.from(
      atob(maximumBytePlan.canonicalPlanBase64),
      (character) => character.charCodeAt(0),
    );
    expect(maximumBytes.byteLength)
      .toBe(STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES);
    const maximumByteEnvelope = {
      ...(await preparedReceipt()),
      plan: maximumBytePlan,
    };
    await expect(parseStewardRuntimeControlPreparedReceiptV2(
      maximumByteEnvelope,
    )).resolves.toMatchObject({
      plan: {
        canonicalPlanByteLength:
          STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES,
      },
    });
    expect(new TextEncoder().encode(
      await canonicalStewardRuntimeControlPreparedReceiptV2Json(
        maximumByteEnvelope,
      ),
    ).byteLength).toBeLessThanOrEqual(
      STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_ENVELOPE_BYTES,
    );

    const oversizedPlanValue = canonicalPlanValue(
      resolvedContext(),
      [mutation()],
      {
        outcome: {
          state: 'pending',
          summary: 'x'.repeat(
            STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES,
          ),
        },
      },
    );
    const oversizedPlan = await planBinding(
      [mutation()],
      oversizedPlanValue,
    );
    const oversizedBytes = Uint8Array.from(
      atob(oversizedPlan.canonicalPlanBase64),
      (character) => character.charCodeAt(0),
    );
    expect(oversizedBytes.byteLength)
      .toBeGreaterThan(STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES);
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...(await preparedReceipt()),
      plan: {
        ...oversizedPlan,
      },
    }));
  });

  it('requires contiguous unique intents and an exact selected mutation', async () => {
    const prepared = await preparedReceipt();
    const duplicate = [mutation(0), { ...mutation(1), key: mutation(0).key }];
    const duplicatePlan = await planBinding(
      duplicate,
      canonicalPlanValue(resolvedContext(), duplicate),
    );
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: duplicatePlan,
    }));

    const nonContiguous = [{ ...mutation(0), ordinal: 1 }];
    const nonContiguousPlan = await planBinding(
      nonContiguous,
      canonicalPlanValue(resolvedContext(), nonContiguous),
    );
    await expectRejected(parseStewardRuntimeControlPreparedReceiptV2({
      ...prepared,
      plan: nonContiguousPlan,
    }));

    const apply = await applyNextRequest();
    await expectRejected(parseStewardRuntimeControlApplyNextRequestV2({
      ...apply,
      mutation: { ...apply.mutation, desiredDigest: '1'.repeat(64) },
    }));
  });

  it('fences apply to the prepared lease and recovery to a strictly newer lease', async () => {
    const apply = await applyNextRequest();
    await expectRejected(parseStewardRuntimeControlApplyNextRequestV2({
      ...apply,
      binding: binding(8),
    }));
    await expectRejected(parseStewardRuntimeControlRecoverRequestV2({
      ...(await recoverRequest(8)),
      binding: binding(7),
    }));
    await expectRejected(parseStewardRuntimeControlRecoverRequestV2(
      await recoverRequest(6),
    ));
    await expect(parseStewardRuntimeControlRecoverRequestV2(
      await recoverRequest(8),
    )).resolves.toMatchObject({ binding: { generation: 8 } });
  });

  it('requires a complete prepared Control revision on mutation phases', async () => {
    const apply = await applyNextRequest();
    await expectRejected(parseStewardRuntimeControlApplyNextRequestV2({
      ...apply,
      expectedControlRevision: {
        ...apply.expectedControlRevision,
        workerVersionTag: `steward-${'0'.repeat(40)}`,
      },
    }));
  });

  it('enforces result-state fields and recovery policy without guessing from keys', async () => {
    const apply = await applyNextRequest();
    const receipt = {
      schemaVersion: 2,
      phase: 'mutation-result',
      binding: apply.binding,
      resolvedContext: apply.resolvedContext,
      planId: apply.plan.planId,
      planDigest: apply.plan.planDigest,
      mutation: apply.mutation,
      result: {
        state: 'not-attempted',
        resourceId: null,
        retryAfterSeconds: 30,
      },
      controlRevision: revision(),
    };
    await expect(parseStewardRuntimeControlMutationReceiptV2(receipt))
      .resolves.toMatchObject({ result: { state: 'not-attempted' } });
    await expectRejected(parseStewardRuntimeControlMutationReceiptV2({
      ...receipt,
      result: { state: 'applied', resourceId: 42, retryAfterSeconds: 1 },
    }));
    await expectRejected(parseStewardRuntimeControlMutationReceiptV2({
      ...receipt,
      result: {
        state: 'not-attempted',
        resourceId: 42,
        retryAfterSeconds: 30,
      },
    }));
    await expectRejected(parseStewardRuntimeControlMutationReceiptV2({
      ...receipt,
      result: { state: 'unknown', resourceId: null, retryAfterSeconds: 1 },
    }));
    await expectRejected(parseStewardRuntimeControlMutationReceiptV2({
      ...receipt,
      mutation: {
        ...receipt.mutation,
        recoveryPolicy: 'live-evidence-or-action-required',
      },
    }));
    await expectRejected(parseStewardRuntimeControlMutationReceiptV2({
      ...receipt,
      mutation: {
        ...receipt.mutation,
        principal: 'human',
      },
    }));

    const recover = await recoverRequest();
    const recoveryReceipt = {
      schemaVersion: 2,
      phase: 'recovery-result',
      binding: recover.binding,
      resolvedContext: recover.resolvedContext,
      planId: recover.plan.planId,
      planDigest: recover.plan.planDigest,
      mutation: recover.mutation,
      result: { state: 'action-required', resourceId: null },
      controlRevision: revision(),
    };
    await expectRejected(parseStewardRuntimeControlRecoveryReceiptV2(
      recoveryReceipt,
    ));
    await expect(parseStewardRuntimeControlRecoveryReceiptV2({
      ...recoveryReceipt,
      mutation: {
        ...recoveryReceipt.mutation,
        principal: 'human',
        recoveryPolicy: 'live-evidence-or-action-required',
      },
    })).resolves.toMatchObject({ result: { state: 'action-required' } });
  });
});
