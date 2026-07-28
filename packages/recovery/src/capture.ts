import {
  canonicalStewardRuntimeScopeWorkItemJson,
  canonicalStewardRuntimeInstallationRepositoryChildV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json,
  canonicalStewardRuntimeWorkItemJson,
  deriveStewardRuntimeFanoutDeliveryId,
  deriveStewardRuntimeFanoutDeliveryIdV2,
  deriveStewardRuntimeFanoutDeliveryIdV3,
  parseStewardRuntimeInstallationRepositoryChildV1,
  parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  parseStewardRuntimeScopeWorkItem,
  parseStewardRuntimeScopeWorkItemV1,
  parseStewardRuntimeScopeWorkItemV2,
  parseStewardRuntimeWorkItem,
  type StewardRuntimeWorkItem,
} from '../../core/src/index.js';

export const maximumCapturedDeadLetterBodyBytes = 127_000;

export type CapturedEnvelopeKind =
  | 'scope-work-item-v1'
  | 'scope-work-item-v2'
  | 'installation-repository-child-v1'
  | 'installation-index-bootstrap-v1'
  | 'work-item-v1'
  | 'work-item-v2'
  | 'work-item-v3'
  | 'work-item-v4'
  | 'work-item-v5'
  | 'quarantined';

export interface ClassifiedDeadLetterBody {
  readonly entryId: string;
  readonly bodyDigest: string;
  readonly body: string;
  readonly byteLength: number;
  readonly eligible: boolean;
  readonly envelopeKind: CapturedEnvelopeKind;
  readonly deliveryId: string | null;
  readonly repositoryId: number | null;
  readonly pullRequestNumber: number | null;
  readonly quarantineReason: string | null;
}

function hex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

async function sha256(value: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)));
}

function quarantined(
  body: string,
  byteLength: number,
  bodyDigest: string,
  reason: string,
): ClassifiedDeadLetterBody {
  return {
    entryId: bodyDigest,
    bodyDigest,
    body,
    byteLength,
    eligible: false,
    envelopeKind: 'quarantined',
    deliveryId: null,
    repositoryId: null,
    pullRequestNumber: null,
    quarantineReason: reason,
  };
}

async function assertFanoutProvenance(
  envelope: StewardRuntimeWorkItem,
): Promise<void> {
  const cause = envelope.cause;
  if (cause.kind === 'scope-fanout') {
    const root = parseStewardRuntimeScopeWorkItemV1({
      schemaVersion: 1,
      operation: 'scope-reconcile',
      target: {
        scope: 'repository',
        mode: 'refresh',
        installationId: envelope.installationId,
        repositoryId: envelope.subject.repositoryId,
        pullRequests: 'all-open',
      },
      cause: {
        kind: 'github-webhook',
        deliveryId: cause.rootDeliveryId,
        event: cause.event,
        action: cause.action,
        receivedAt: cause.receivedAt,
      },
    });
    const expected = await deriveStewardRuntimeFanoutDeliveryId(
      root,
      cause.fanoutGeneration,
      envelope.subject.pullRequestNumber,
    );
    if (cause.deliveryId !== expected) {
      throw new TypeError('Work item V3 fan-out delivery ID is not derivable.');
    }
    return;
  }
  if (cause.kind === 'scope-fanout-2') {
    const root = parseStewardRuntimeScopeWorkItemV2({
      schemaVersion: 2,
      operation: 'scope-reconcile',
      target: {
        scope: 'repository',
        mode: 'refresh',
        installationId: envelope.installationId,
        repositoryId: envelope.subject.repositoryId,
        pullRequests: 'all-open',
      },
      cause: {
        kind: 'github-webhook',
        deliveryId: cause.rootDeliveryId,
        event: cause.event,
        action: cause.action,
        ref: cause.ref,
        receivedAt: cause.receivedAt,
      },
    });
    const expected = await deriveStewardRuntimeFanoutDeliveryIdV2(
      root,
      cause.fanoutGeneration,
      envelope.subject.pullRequestNumber,
    );
    if (cause.deliveryId !== expected) {
      throw new TypeError('Work item V4 fan-out delivery ID is not derivable.');
    }
    return;
  }
  if (cause.kind !== 'scope-fanout-3') return;

  const child = await parseStewardRuntimeInstallationRepositoryChildV1(
    cause.installationChild,
  );
  if (
    envelope.installationId !== child.installationId
    || envelope.subject.repositoryId !== child.repositoryId
    || cause.rootDeliveryId !== child.rootDeliveryId
    || cause.event !== child.cause.event
    || cause.action !== child.cause.action
    || cause.ref !== child.cause.ref
    || cause.receivedAt !== child.cause.receivedAt
  ) {
    throw new TypeError(
      'Work item V5 evidence does not match its installation child.',
    );
  }
  const expected = await deriveStewardRuntimeFanoutDeliveryIdV3(
    child,
    cause.repositoryFanoutGeneration,
    envelope.subject.pullRequestNumber,
  );
  if (cause.deliveryId !== expected) {
    throw new TypeError('Work item V5 fan-out delivery ID is not derivable.');
  }
}

export async function classifyDeadLetterBody(
  value: unknown,
): Promise<ClassifiedDeadLetterBody> {
  if (typeof value !== 'string') {
    const diagnosticBody = JSON.stringify({
      unsupportedBodyType:
        value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    });
    const bytes = new TextEncoder().encode(diagnosticBody);
    const bodyDigest = await sha256(bytes);
    return quarantined(
      diagnosticBody,
      bytes.byteLength,
      bodyDigest,
      'queue-body-not-text',
    );
  }

  const bytes = new TextEncoder().encode(value);
  const bodyDigest = await sha256(bytes);
  if (bytes.byteLength === 0) {
    return quarantined(value, 0, bodyDigest, 'queue-body-empty');
  }
  if (bytes.byteLength > maximumCapturedDeadLetterBodyBytes) {
    const diagnosticBody = JSON.stringify({
      quarantineReason: 'queue-body-too-large',
      originalBodyDigest: bodyDigest,
      originalByteLength: bytes.byteLength,
    });
    const diagnosticBytes = new TextEncoder().encode(diagnosticBody);
    const diagnosticDigest = await sha256(diagnosticBytes);
    return quarantined(
      diagnosticBody,
      diagnosticBytes.byteLength,
      diagnosticDigest,
      'queue-body-too-large',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return quarantined(
      value,
      bytes.byteLength,
      bodyDigest,
      'queue-body-invalid-json',
    );
  }

  try {
    if (
      parsed !== null
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).operation
        === 'installation-index-bootstrap'
    ) {
      const envelope =
        parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1(parsed);
      if (
        canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(
          envelope,
        ) !== value
      ) {
        return quarantined(
          value,
          bytes.byteLength,
          bodyDigest,
          'installation-index-bootstrap-noncanonical',
        );
      }
      return {
        entryId: bodyDigest,
        bodyDigest,
        body: value,
        byteLength: bytes.byteLength,
        eligible: true,
        envelopeKind: 'installation-index-bootstrap-v1',
        deliveryId: null,
        repositoryId: null,
        pullRequestNumber: null,
        quarantineReason: null,
      };
    }
    if (
      parsed !== null
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).operation
        === 'installation-repository-fanout'
    ) {
      const envelope =
        await parseStewardRuntimeInstallationRepositoryChildV1(parsed);
      if (
        await canonicalStewardRuntimeInstallationRepositoryChildV1Json(
          envelope,
        ) !== value
      ) {
        return quarantined(
          value,
          bytes.byteLength,
          bodyDigest,
          'installation-repository-child-noncanonical',
        );
      }
      return {
        entryId: bodyDigest,
        bodyDigest,
        body: value,
        byteLength: bytes.byteLength,
        eligible: true,
        envelopeKind: 'installation-repository-child-v1',
        deliveryId: envelope.deliveryId,
        repositoryId: envelope.repositoryId,
        pullRequestNumber: null,
        quarantineReason: null,
      };
    }
    if (
      parsed !== null
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).operation === 'scope-reconcile'
    ) {
      const envelope = parseStewardRuntimeScopeWorkItem(parsed);
      if (canonicalStewardRuntimeScopeWorkItemJson(envelope) !== value) {
        return quarantined(
          value,
          bytes.byteLength,
          bodyDigest,
          'scope-work-item-noncanonical',
        );
      }
      return {
        entryId: bodyDigest,
        bodyDigest,
        body: value,
        byteLength: bytes.byteLength,
        eligible: true,
        envelopeKind: `scope-work-item-v${envelope.schemaVersion}`,
        deliveryId: envelope.cause.deliveryId,
        repositoryId: envelope.target.scope === 'repository'
          ? envelope.target.repositoryId
          : null,
        pullRequestNumber: null,
        quarantineReason: null,
      };
    }

    const envelope = parseStewardRuntimeWorkItem(parsed);
    await assertFanoutProvenance(envelope);
    if (canonicalStewardRuntimeWorkItemJson(envelope) !== value) {
      return quarantined(
        value,
        bytes.byteLength,
        bodyDigest,
        'work-item-noncanonical',
      );
    }
    return {
      entryId: bodyDigest,
      bodyDigest,
      body: value,
      byteLength: bytes.byteLength,
      eligible: true,
      envelopeKind: `work-item-v${envelope.schemaVersion}`,
      deliveryId: envelope.cause.deliveryId,
      repositoryId: envelope.subject.repositoryId,
      pullRequestNumber: envelope.subject.pullRequestNumber,
      quarantineReason: null,
    };
  } catch {
    return quarantined(
      value,
      bytes.byteLength,
      bodyDigest,
      'unsupported-queue-envelope',
    );
  }
}
