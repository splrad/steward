import {
  canonicalStewardRuntimeScopeWorkItemJson,
  canonicalStewardRuntimeWorkItemJson,
  parseStewardRuntimeScopeWorkItemV1,
  parseStewardRuntimeWorkItem,
} from '../../core/src/index.js';

export const maximumCapturedDeadLetterBodyBytes = 127_000;

export type CapturedEnvelopeKind =
  | 'scope-work-item-v1'
  | 'work-item-v1'
  | 'work-item-v2'
  | 'work-item-v3'
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
      && (parsed as Record<string, unknown>).operation === 'scope-reconcile'
    ) {
      const envelope = parseStewardRuntimeScopeWorkItemV1(parsed);
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
        envelopeKind: 'scope-work-item-v1',
        deliveryId: envelope.cause.deliveryId,
        repositoryId: envelope.target.repositoryId,
        pullRequestNumber: null,
        quarantineReason: null,
      };
    }

    const envelope = parseStewardRuntimeWorkItem(parsed);
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
