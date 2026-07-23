import {
  assertDeliveryId,
  assertFailureCode,
  assertGeneration,
  assertLeaseDurationMs,
  assertLeaseToken,
  assertPullNumber,
  assertTimestamp,
  completedDeliveryRetentionLimit,
  completedDeliveryRetentionMs,
  normalizeRepositoryId,
  pendingDeliveryRetentionLimit,
  type CoordinatorAlarmResult,
  type CoordinatorClaimResult,
  type CoordinatorCompleteResult,
  type CoordinatorFailResult,
  type CoordinatorFailureCode,
  type CoordinatorLeaseKind,
  type CoordinatorRenewResult,
  type PullRequestCoordinatorPhase,
  type PullRequestCoordinatorSnapshot,
  type PullRequestCoordinatorSubject,
} from './contracts.js';

export interface CoordinatorDeliveryRecord {
  acceptedAt: number;
  completedAt: number | null;
  coveredGeneration: number | null;
  deliveryId: string;
  status: 'pending' | 'completed';
}

export interface CoordinatorLeaseRecord {
  deliveryId: string;
  expiresAt: number;
  generation: number;
  kind: CoordinatorLeaseKind;
  token: string;
}

export interface PullRequestCoordinatorStoredState {
  deliveries: CoordinatorDeliveryRecord[];
  dirty: boolean;
  failureCode: CoordinatorFailureCode | null;
  generation: number;
  lease: CoordinatorLeaseRecord | null;
  phase: PullRequestCoordinatorPhase;
  subject: PullRequestCoordinatorSubject;
}

export function createPullRequestCoordinatorState(
  subject: PullRequestCoordinatorSubject,
): PullRequestCoordinatorStoredState {
  return {
    deliveries: [],
    dirty: false,
    failureCode: null,
    generation: 0,
    lease: null,
    phase: 'idle',
    subject: normalizeSubject(subject),
  };
}

/**
 * Pure, storage-independent state machine. Production persists the exported
 * state in a single Durable Object SQL transaction; Node tests exercise this
 * class without loading the Workers virtual module.
 */
export class PullRequestCoordinatorStateMachine {
  readonly #state: PullRequestCoordinatorStoredState;

  constructor(state: PullRequestCoordinatorStoredState) {
    this.#state = cloneAndValidateState(state);
  }

  claim(
    deliveryId: string,
    leaseDurationMs: number,
    now: number,
    leaseToken: string,
  ): CoordinatorClaimResult {
    const normalizedDeliveryId = assertDeliveryId(deliveryId);
    const duration = assertLeaseDurationMs(leaseDurationMs);
    const timestamp = assertTimestamp(now, 'now');
    const token = assertLeaseToken(leaseToken);

    this.#pruneCompleted(timestamp);

    this.#expireLeaseIfNeeded(timestamp);
    const knownDelivery = this.#findDelivery(normalizedDeliveryId);

    if (this.#state.phase === 'leased') {
      const lease = requireLease(this.#state);

      if (knownDelivery?.status === 'completed') {
        return { status: 'duplicate' };
      }
      if (knownDelivery !== undefined) {
        return {
          expiresAt: lease.expiresAt,
          generation: lease.generation,
          status: lease.deliveryId === normalizedDeliveryId
            ? 'busy'
            : 'coalesced',
        };
      }

      // Queue redelivery is the durable trigger. Once the bounded diagnostic
      // set is full, dirty still records that a later level-triggered
      // reconciliation is required without allowing SQL state to grow
      // without limit.
      if (this.#pendingDeliveryCount() < pendingDeliveryRetentionLimit) {
        this.#appendPendingDelivery(normalizedDeliveryId, timestamp);
      }
      this.#state.dirty = true;

      return {
        expiresAt: lease.expiresAt,
        generation: lease.generation,
        status: 'coalesced',
      };
    }

    const followupClaim = this.#state.phase === 'followup';
    if (knownDelivery?.status === 'completed' && !followupClaim) {
      return { status: 'duplicate' };
    }

    if (knownDelivery === undefined) {
      this.#makeRoomForClaimedDelivery();
      this.#appendPendingDelivery(normalizedDeliveryId, timestamp);
    }

    const generation = nextGeneration(this.#state.generation);
    for (const delivery of this.#state.deliveries) {
      if (delivery.status === 'pending') {
        delivery.coveredGeneration = generation;
      }
    }

    const expiresAt = addDuration(timestamp, duration);
    this.#state.generation = generation;
    this.#state.phase = 'leased';
    this.#state.dirty = false;
    this.#state.failureCode = null;
    this.#state.lease = {
      deliveryId: normalizedDeliveryId,
      expiresAt,
      generation,
      kind: followupClaim ? 'followup' : 'delivery',
      token,
    };

    return {
      expiresAt,
      generation,
      leaseToken: token,
      status: 'claimed',
    };
  }

  renew(
    generation: number,
    leaseToken: string,
    leaseDurationMs: number,
    now: number,
  ): CoordinatorRenewResult {
    const expectedGeneration = assertGeneration(generation);
    const token = assertLeaseToken(leaseToken);
    const duration = assertLeaseDurationMs(leaseDurationMs);
    const timestamp = assertTimestamp(now, 'now');

    if (this.#expireLeaseIfNeeded(timestamp)) {
      return { status: 'stale' };
    }

    if (!this.#matchesLease(expectedGeneration, token)) {
      return { status: 'stale' };
    }

    const lease = requireLease(this.#state);
    lease.expiresAt = addDuration(timestamp, duration);

    return {
      expiresAt: lease.expiresAt,
      generation: lease.generation,
      status: 'renewed',
    };
  }

  complete(
    generation: number,
    leaseToken: string,
    now: number,
  ): CoordinatorCompleteResult {
    const expectedGeneration = assertGeneration(generation);
    const token = assertLeaseToken(leaseToken);
    const timestamp = assertTimestamp(now, 'now');

    if (this.#expireLeaseIfNeeded(timestamp)) {
      return { status: 'stale' };
    }

    if (!this.#matchesLease(expectedGeneration, token)) {
      return { status: 'stale' };
    }

    const wasDirty = this.#state.dirty;
    for (const delivery of this.#state.deliveries) {
      if (
        delivery.status === 'pending' &&
        delivery.coveredGeneration === expectedGeneration
      ) {
        delivery.status = 'completed';
        delivery.completedAt = timestamp;
        delivery.coveredGeneration = null;
      }
    }

    this.#state.lease = null;
    this.#state.failureCode = null;

    const hasPendingDelivery = this.#state.deliveries.some(
      (delivery) => delivery.status === 'pending',
    );
    const needsFollowup = wasDirty || hasPendingDelivery;
    this.#state.phase = needsFollowup ? 'followup' : 'idle';
    this.#state.dirty = needsFollowup;
    this.#pruneCompleted(timestamp);

    return {
      generation: expectedGeneration,
      status: needsFollowup ? 'followup' : 'completed',
    };
  }

  fail(
    generation: number,
    leaseToken: string,
    failureCode: CoordinatorFailureCode,
    now: number,
  ): CoordinatorFailResult {
    const expectedGeneration = assertGeneration(generation);
    const token = assertLeaseToken(leaseToken);
    const code = assertFailureCode(failureCode);
    const timestamp = assertTimestamp(now, 'now');

    if (this.#expireLeaseIfNeeded(timestamp)) {
      return { status: 'stale' };
    }

    if (!this.#matchesLease(expectedGeneration, token)) {
      return { status: 'stale' };
    }

    this.#releaseCoveredDeliveries(expectedGeneration);
    this.#state.lease = null;
    this.#state.phase = 'followup';
    this.#state.dirty = true;
    this.#state.failureCode = code;

    return {
      generation: expectedGeneration,
      status: 'followup',
    };
  }

  alarm(now: number): CoordinatorAlarmResult {
    const timestamp = assertTimestamp(now, 'now');
    const generation = this.#state.lease?.generation;

    if (generation !== undefined && this.#expireLeaseIfNeeded(timestamp)) {
      return {
        generation,
        status: 'expired',
      };
    }

    return { status: 'unchanged' };
  }

  snapshot(): PullRequestCoordinatorSnapshot {
    let pendingDeliveryCount = 0;
    let completedDeliveryCount = 0;
    for (const delivery of this.#state.deliveries) {
      if (delivery.status === 'pending') {
        pendingDeliveryCount += 1;
      } else {
        completedDeliveryCount += 1;
      }
    }

    return {
      completedDeliveryCount,
      dirty: this.#state.dirty,
      failureCode: this.#state.failureCode,
      generation: this.#state.generation,
      lease:
        this.#state.lease === null
          ? null
          : {
              deliveryId: this.#state.lease.deliveryId,
              expiresAt: this.#state.lease.expiresAt,
              generation: this.#state.lease.generation,
            },
      pendingDeliveryCount,
      phase: this.#state.phase,
      subject: { ...this.#state.subject },
    };
  }

  alarmAt(): number | null {
    return this.#state.lease?.expiresAt ?? null;
  }

  exportState(): PullRequestCoordinatorStoredState {
    return cloneState(this.#state);
  }

  #expireLeaseIfNeeded(now: number): boolean {
    const lease = this.#state.lease;
    if (lease === null || lease.expiresAt > now) {
      return false;
    }

    this.#releaseCoveredDeliveries(lease.generation);
    this.#state.lease = null;
    this.#state.phase = 'followup';
    this.#state.dirty = true;
    this.#state.failureCode = 'lease-expired';
    return true;
  }

  #findDelivery(deliveryId: string): CoordinatorDeliveryRecord | undefined {
    return this.#state.deliveries.find(
      (delivery) => delivery.deliveryId === deliveryId,
    );
  }

  #appendPendingDelivery(deliveryId: string, acceptedAt: number): void {
    this.#state.deliveries.push({
      acceptedAt,
      completedAt: null,
      coveredGeneration: null,
      deliveryId,
      status: 'pending',
    });
  }

  #makeRoomForClaimedDelivery(): void {
    if (this.#pendingDeliveryCount() < pendingDeliveryRetentionLimit) {
      return;
    }

    const oldestPendingIndex = this.#state.deliveries.findIndex(
      (delivery) => delivery.status === 'pending',
    );
    if (oldestPendingIndex < 0) {
      throw new Error('Coordinator pending-delivery limit invariant violated.');
    }

    // Every work item is level-triggered for one PR. The evicted delivery's
    // Queue message remains retryable, while the generation being claimed now
    // observes the same live PR truth.
    this.#state.deliveries.splice(oldestPendingIndex, 1);
  }

  #pendingDeliveryCount(): number {
    return this.#state.deliveries.reduce(
      (count, delivery) => count + (delivery.status === 'pending' ? 1 : 0),
      0,
    );
  }

  #matchesLease(generation: number, token: string): boolean {
    const lease = this.#state.lease;
    return (
      this.#state.phase === 'leased' &&
      lease !== null &&
      lease.generation === generation &&
      lease.token === token
    );
  }

  #pruneCompleted(now: number): void {
    const pending = this.#state.deliveries.filter(
      (delivery) => delivery.status === 'pending',
    );
    const cutoff = Math.max(0, now - completedDeliveryRetentionMs);
    const completed = this.#state.deliveries
      .filter(
        (delivery) =>
          delivery.status === 'completed' &&
          delivery.completedAt !== null &&
          delivery.completedAt >= cutoff,
      )
      .sort(compareCompletedNewestFirst)
      .slice(0, completedDeliveryRetentionLimit);

    // Redelivery after pruning is intentionally treated as fresh work. The
    // runner performs a live, level-triggered reconcile, so replay is safe.
    this.#state.deliveries = [...pending, ...completed];
  }

  #releaseCoveredDeliveries(generation: number): void {
    for (const delivery of this.#state.deliveries) {
      if (
        delivery.status === 'pending' &&
        delivery.coveredGeneration === generation
      ) {
        delivery.coveredGeneration = null;
      }
    }
  }
}

function normalizeSubject(
  subject: PullRequestCoordinatorSubject,
): PullRequestCoordinatorSubject {
  return {
    pullNumber: assertPullNumber(subject.pullNumber),
    repositoryId: normalizeRepositoryId(subject.repositoryId),
  };
}

function cloneAndValidateState(
  state: PullRequestCoordinatorStoredState,
): PullRequestCoordinatorStoredState {
  const clone = cloneState(state);
  clone.subject = normalizeSubject(clone.subject);

  if (
    !Number.isSafeInteger(clone.generation) ||
    clone.generation < 0 ||
    !['idle', 'leased', 'followup'].includes(clone.phase)
  ) {
    throw new TypeError('Stored coordinator state is invalid.');
  }

  if ((clone.phase === 'leased') !== (clone.lease !== null)) {
    throw new TypeError('Stored coordinator lease and phase are inconsistent.');
  }

  if (clone.lease !== null) {
    assertGeneration(clone.lease.generation);
    assertDeliveryId(clone.lease.deliveryId);
    assertLeaseToken(clone.lease.token);
    assertTimestamp(clone.lease.expiresAt, 'lease.expiresAt');
    if (clone.lease.kind !== 'delivery' && clone.lease.kind !== 'followup') {
      throw new TypeError('Stored lease kind is invalid.');
    }
    if (clone.lease.generation !== clone.generation) {
      throw new TypeError('Stored lease generation is not current.');
    }
  }

  const deliveryIds = new Set<string>();
  for (const delivery of clone.deliveries) {
    assertDeliveryId(delivery.deliveryId);
    assertTimestamp(delivery.acceptedAt, 'delivery.acceptedAt');
    if (deliveryIds.has(delivery.deliveryId)) {
      throw new TypeError('Stored delivery identifiers must be unique.');
    }
    deliveryIds.add(delivery.deliveryId);

    if (delivery.status === 'completed') {
      if (
        delivery.completedAt === null ||
        delivery.coveredGeneration !== null
      ) {
        throw new TypeError('Stored completed delivery is invalid.');
      }
      assertTimestamp(delivery.completedAt, 'delivery.completedAt');
    } else {
      if (delivery.completedAt !== null) {
        throw new TypeError('Stored pending delivery cannot have completedAt.');
      }
      if (delivery.coveredGeneration !== null) {
        assertGeneration(delivery.coveredGeneration);
      }
    }
  }

  if (clone.failureCode !== null) {
    assertFailureCode(clone.failureCode);
    if (clone.phase !== 'followup') {
      throw new TypeError(
        'Stored failure code is only valid in follow-up state.',
      );
    }
  }

  const pending = clone.deliveries.filter(
    (delivery) => delivery.status === 'pending',
  );
  if (pending.length > pendingDeliveryRetentionLimit) {
    throw new TypeError('Stored pending delivery retention limit is exceeded.');
  }
  if (clone.phase === 'idle') {
    if (clone.dirty || pending.length !== 0) {
      throw new TypeError('Stored idle state cannot contain pending work.');
    }
  } else if (clone.phase === 'followup') {
    if (
      !clone.dirty ||
      pending.some((delivery) => delivery.coveredGeneration !== null)
    ) {
      throw new TypeError('Stored follow-up state is inconsistent.');
    }
  } else {
    const lease = requireLease(clone);
    const currentDelivery = pending.find(
      (delivery) => delivery.deliveryId === lease.deliveryId,
    );
    if (
      (
        lease.kind === 'delivery'
        && currentDelivery?.coveredGeneration !== lease.generation
      ) ||
      pending.some(
        (delivery) =>
          delivery.coveredGeneration !== null &&
          delivery.coveredGeneration !== lease.generation,
      ) ||
      (
        !clone.dirty
        && pending.some((delivery) => delivery.coveredGeneration === null)
      )
    ) {
      throw new TypeError('Stored leased work coverage is inconsistent.');
    }
  }

  return clone;
}

function cloneState(
  state: PullRequestCoordinatorStoredState,
): PullRequestCoordinatorStoredState {
  return {
    deliveries: state.deliveries.map((delivery) => ({ ...delivery })),
    dirty: state.dirty,
    failureCode: state.failureCode,
    generation: state.generation,
    lease: state.lease === null ? null : { ...state.lease },
    phase: state.phase,
    subject: { ...state.subject },
  };
}

function requireLease(
  state: PullRequestCoordinatorStoredState,
): CoordinatorLeaseRecord {
  if (state.lease === null) {
    throw new Error('Coordinator lease invariant violated.');
  }
  return state.lease;
}

function nextGeneration(current: number): number {
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError('Coordinator generation is exhausted.');
  }
  return next;
}

function addDuration(now: number, duration: number): number {
  const result = now + duration;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Lease expiration exceeds safe integer range.');
  }
  return result;
}

function compareCompletedNewestFirst(
  left: CoordinatorDeliveryRecord,
  right: CoordinatorDeliveryRecord,
): number {
  const leftCompletedAt = left.completedAt ?? -1;
  const rightCompletedAt = right.completedAt ?? -1;
  return (
    rightCompletedAt - leftCompletedAt ||
    right.deliveryId.localeCompare(left.deliveryId)
  );
}
