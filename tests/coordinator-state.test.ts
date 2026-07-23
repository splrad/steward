import { describe, expect, it } from 'vitest';
import {
  completedDeliveryRetentionLimit,
  pendingDeliveryRetentionLimit,
  pullRequestCoordinatorName,
} from '../packages/coordinator/src/contracts.js';
import {
  createPullRequestCoordinatorState,
  PullRequestCoordinatorStateMachine,
} from '../packages/coordinator/src/state.js';

const subject = {
  pullNumber: 17,
  repositoryId: '4243096',
};

const tokenOne = 'lease-token-generation-one';
const tokenTwo = 'lease-token-generation-two';

function createMachine(
  repositoryId = subject.repositoryId,
  pullNumber = subject.pullNumber,
): PullRequestCoordinatorStateMachine {
  return new PullRequestCoordinatorStateMachine(
    createPullRequestCoordinatorState({ pullNumber, repositoryId }),
  );
}

describe('PullRequestCoordinatorStateMachine', () => {
  it('deduplicates a retained completed delivery', () => {
    const machine = createMachine();
    expect(machine.claim('delivery-1', 1_000, 100, tokenOne)).toEqual({
      expiresAt: 1_100,
      generation: 1,
      leaseToken: tokenOne,
      status: 'claimed',
    });
    expect(machine.complete(1, tokenOne, 200)).toEqual({
      generation: 1,
      status: 'completed',
    });

    expect(machine.claim('delivery-1', 1_000, 300, tokenTwo)).toEqual({
      status: 'duplicate',
    });
    expect(machine.snapshot()).toMatchObject({
      completedDeliveryCount: 1,
      generation: 1,
      pendingDeliveryCount: 0,
      phase: 'idle',
    });
  });

  it('coalesces dirty work into exactly one follow-up generation', () => {
    const machine = createMachine();
    machine.claim('delivery-1', 1_000, 100, tokenOne);

    expect(machine.claim('delivery-2', 1_000, 200, tokenTwo)).toEqual({
      expiresAt: 1_100,
      generation: 1,
      status: 'coalesced',
    });
    expect(machine.claim('delivery-2', 1_000, 300, tokenTwo)).toEqual({
      expiresAt: 1_100,
      generation: 1,
      status: 'coalesced',
    });
    expect(machine.snapshot()).toMatchObject({
      dirty: true,
      generation: 1,
      pendingDeliveryCount: 2,
      phase: 'leased',
    });

    expect(machine.complete(1, tokenOne, 400)).toEqual({
      generation: 1,
      status: 'followup',
    });
    expect(machine.snapshot()).toMatchObject({
      completedDeliveryCount: 1,
      dirty: true,
      pendingDeliveryCount: 1,
      phase: 'followup',
    });

    expect(machine.claim('delivery-2', 1_000, 500, tokenTwo)).toEqual({
      expiresAt: 1_500,
      generation: 2,
      leaseToken: tokenTwo,
      status: 'claimed',
    });
    expect(machine.complete(2, tokenTwo, 600)).toEqual({
      generation: 2,
      status: 'completed',
    });
    expect(machine.snapshot()).toMatchObject({
      completedDeliveryCount: 2,
      dirty: false,
      generation: 2,
      pendingDeliveryCount: 0,
      phase: 'idle',
    });
  });

  it('lets a completed root delivery immediately own durable follow-up state', () => {
    const machine = createMachine();
    machine.claim('delivery-root', 1_000, 100, tokenOne);
    machine.claim('delivery-coalesced', 1_000, 200, tokenTwo);
    expect(machine.complete(1, tokenOne, 300)).toEqual({
      generation: 1,
      status: 'followup',
    });

    const followup = machine.claim('delivery-root', 1_000, 400, tokenTwo);
    expect(followup).toEqual({
      expiresAt: 1_400,
      generation: 2,
      leaseToken: tokenTwo,
      status: 'claimed',
    });
    expect(
      new PullRequestCoordinatorStateMachine(machine.exportState()).complete(
        2,
        tokenTwo,
        500,
      ),
    ).toEqual({
      generation: 2,
      status: 'completed',
    });
  });

  it('fences a stale worker after an expired lease is reclaimed', () => {
    const machine = createMachine();
    machine.claim('delivery-1', 100, 1_000, tokenOne);
    expect(machine.alarm(1_100)).toEqual({
      generation: 1,
      status: 'expired',
    });
    expect(machine.claim('delivery-1', 100, 1_101, tokenTwo)).toEqual({
      expiresAt: 1_201,
      generation: 2,
      leaseToken: tokenTwo,
      status: 'claimed',
    });

    expect(machine.renew(1, tokenOne, 100, 1_102)).toEqual({
      status: 'stale',
    });
    expect(machine.complete(1, tokenOne, 1_103)).toEqual({
      status: 'stale',
    });
    expect(
      machine.fail(1, tokenOne, 'runtime-error', 1_104),
    ).toEqual({ status: 'stale' });

    expect(machine.snapshot()).toMatchObject({
      generation: 2,
      lease: {
        deliveryId: 'delivery-1',
        expiresAt: 1_201,
        generation: 2,
      },
      phase: 'leased',
    });
    expect(machine.complete(2, tokenTwo, 1_105)).toEqual({
      generation: 2,
      status: 'completed',
    });
  });

  it('renews a lease and idempotently handles early and expired alarms', () => {
    const machine = createMachine();
    machine.claim('delivery-1', 100, 1_000, tokenOne);

    expect(machine.renew(1, tokenOne, 250, 1_050)).toEqual({
      expiresAt: 1_300,
      generation: 1,
      status: 'renewed',
    });
    expect(machine.alarm(1_100)).toEqual({ status: 'unchanged' });
    expect(machine.alarm(1_300)).toEqual({
      generation: 1,
      status: 'expired',
    });
    expect(machine.alarm(1_301)).toEqual({ status: 'unchanged' });
    expect(machine.snapshot()).toMatchObject({
      dirty: true,
      failureCode: 'lease-expired',
      lease: null,
      phase: 'followup',
    });
  });

  it('moves failed work to follow-up and requires a new generation', () => {
    const machine = createMachine();
    machine.claim('delivery-1', 1_000, 100, tokenOne);
    expect(machine.fail(1, tokenOne, 'control-error', 200)).toEqual({
      generation: 1,
      status: 'followup',
    });
    expect(machine.snapshot()).toMatchObject({
      dirty: true,
      failureCode: 'control-error',
      pendingDeliveryCount: 1,
      phase: 'followup',
    });
    expect(machine.claim('delivery-1', 1_000, 300, tokenTwo)).toEqual({
      expiresAt: 1_300,
      generation: 2,
      leaseToken: tokenTwo,
      status: 'claimed',
    });
  });

  it('isolates identical deliveries by repository and pull request object name', () => {
    const first = createMachine('100', 7);
    const second = createMachine('200', 7);

    first.claim('same-delivery', 1_000, 100, tokenOne);
    second.claim('same-delivery', 1_000, 100, tokenTwo);
    first.complete(1, tokenOne, 200);

    expect(first.snapshot()).toMatchObject({
      completedDeliveryCount: 1,
      subject: { pullNumber: 7, repositoryId: '100' },
    });
    expect(second.snapshot()).toMatchObject({
      completedDeliveryCount: 0,
      phase: 'leased',
      subject: { pullNumber: 7, repositoryId: '200' },
    });
    expect(pullRequestCoordinatorName('100', 7)).not.toBe(
      pullRequestCoordinatorName('200', 7),
    );
  });

  it('bounds completed-delivery retention and safely reclaims a pruned replay', () => {
    const machine = createMachine();
    let now = 1_000;

    for (
      let index = 0;
      index < completedDeliveryRetentionLimit + 1;
      index += 1
    ) {
      const token = `lease-token-retention-${index}`;
      const claim = machine.claim(`delivery-${index}`, 100, now, token);
      expect(claim.status).toBe('claimed');
      machine.complete(index + 1, token, now + 1);
      now += 2;
    }

    expect(machine.snapshot().completedDeliveryCount).toBe(
      completedDeliveryRetentionLimit,
    );

    const replay = machine.claim('delivery-0', 100, now, tokenOne);
    expect(replay).toMatchObject({
      generation: completedDeliveryRetentionLimit + 2,
      status: 'claimed',
    });
  });

  it('bounds pending diagnostics without losing a dirty follow-up trigger', () => {
    const machine = createMachine();
    machine.claim('delivery-root', 10_000, 100, tokenOne);

    for (let index = 0; index < pendingDeliveryRetentionLimit; index += 1) {
      expect(
        machine.claim(
          `delivery-pending-${index}`,
          10_000,
          101 + index,
          tokenTwo,
        ).status,
      ).toBe('coalesced');
    }
    expect(
      machine.claim('delivery-overflow', 10_000, 500, tokenTwo),
    ).toMatchObject({ status: 'coalesced' });
    expect(machine.snapshot()).toMatchObject({
      dirty: true,
      pendingDeliveryCount: pendingDeliveryRetentionLimit,
      phase: 'leased',
    });

    expect(machine.complete(1, tokenOne, 600)).toEqual({
      generation: 1,
      status: 'followup',
    });
    expect(machine.snapshot()).toMatchObject({
      dirty: true,
      pendingDeliveryCount: pendingDeliveryRetentionLimit - 1,
      phase: 'followup',
    });

    expect(
      machine.claim('delivery-overflow', 10_000, 700, tokenTwo),
    ).toMatchObject({
      generation: 2,
      status: 'claimed',
    });
    expect(machine.snapshot()).toMatchObject({
      dirty: false,
      pendingDeliveryCount: pendingDeliveryRetentionLimit,
      phase: 'leased',
    });
  });

  it('preserves follow-up state when overflow is untracked during a lease', () => {
    const machine = createMachine();
    machine.claim('delivery-root', 10_000, 100, tokenOne);

    for (let index = 0; index < pendingDeliveryRetentionLimit - 1; index += 1) {
      machine.claim(
        `delivery-pending-${index}`,
        10_000,
        101 + index,
        tokenTwo,
      );
    }

    const followup = machine.claim(
      'delivery-last-tracked',
      10_000,
      500,
      tokenTwo,
    );
    expect(followup.status).toBe('coalesced');
    machine.complete(1, tokenOne, 600);

    const generationTwo = machine.claim(
      'delivery-last-tracked',
      10_000,
      700,
      tokenTwo,
    );
    expect(generationTwo.status).toBe('claimed');

    expect(
      machine.claim('delivery-untracked', 10_000, 800, tokenOne),
    ).toMatchObject({ status: 'coalesced' });
    const rehydrated = new PullRequestCoordinatorStateMachine(
      machine.exportState(),
    );
    expect(rehydrated.complete(2, tokenTwo, 900)).toEqual({
      generation: 2,
      status: 'followup',
    });
    expect(rehydrated.snapshot()).toMatchObject({
      dirty: true,
      pendingDeliveryCount: 0,
      phase: 'followup',
    });

    expect(
      rehydrated.claim('delivery-untracked', 10_000, 1_000, tokenOne),
    ).toMatchObject({
      generation: 3,
      status: 'claimed',
    });
  });

  it('never exposes the opaque lease token in its public snapshot', () => {
    const machine = createMachine();
    machine.claim('delivery-1', 1_000, 100, tokenOne);

    const snapshot = machine.snapshot();
    expect(snapshot.lease).toEqual({
      deliveryId: 'delivery-1',
      expiresAt: 1_100,
      generation: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain(tokenOne);
  });

  it('rejects non-string RPC values before they can enter persisted state', () => {
    const machine = createMachine();
    expect(() => machine.claim(
      42 as unknown as string,
      1_000,
      100,
      tokenOne,
    )).toThrow(TypeError);
    expect(() => machine.claim(
      'delivery-1',
      1_000,
      100,
      { token: tokenOne } as unknown as string,
    )).toThrow(TypeError);
  });
});
