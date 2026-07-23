import {
  parseStewardRuntimeDiagnosticsEnvelope,
  type StewardRuntimeDiagnosticsEnvelopeV1,
  type StewardRuntimeDiagnosticsSubjectV1,
} from '../../core/src/index.js';

export const PRIVATE_CONTROL_DIAGNOSTICS_SOURCE = 'private-control-diagnostics';

export type RuntimeDiagnosticsProviderResult =
  | {
    readonly status: 'response';
    readonly body: unknown;
  }
  | {
    readonly status: 'unknown';
    readonly reason:
      | 'runtime-metadata-unavailable'
      | 'permission-denied'
      | 'transport-error';
  };

export interface RuntimeDiagnosticsProvider {
  read(
    target: StewardRuntimeDiagnosticsSubjectV1,
  ): Promise<RuntimeDiagnosticsProviderResult>;
}

export type RuntimeDiagnosticsObservation =
  | {
    readonly status: 'known';
    readonly envelope: StewardRuntimeDiagnosticsEnvelopeV1;
    readonly source: typeof PRIVATE_CONTROL_DIAGNOSTICS_SOURCE;
  }
  | {
    readonly status: 'unknown';
    readonly reason:
      | 'runtime-metadata-unavailable'
      | 'permission-denied'
      | 'transport-error'
      | 'invalid-response'
      | 'repository-identity-mismatch'
      | 'snapshot-changed';
    readonly source: typeof PRIVATE_CONTROL_DIAGNOSTICS_SOURCE;
    readonly observedAt: string;
  };

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key));
}

function unknown(
  reason: Extract<RuntimeDiagnosticsObservation, { status: 'unknown' }>['reason'],
  observedAt: string,
): RuntimeDiagnosticsObservation {
  return {
    status: 'unknown',
    reason,
    source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
    observedAt,
  };
}

export async function readRuntimeDiagnostics(
  provider: RuntimeDiagnosticsProvider | undefined,
  target: StewardRuntimeDiagnosticsSubjectV1,
  fallbackObservedAt: string,
): Promise<RuntimeDiagnosticsObservation> {
  if (!provider) return unknown('runtime-metadata-unavailable', fallbackObservedAt);

  const expectedTarget = {
    repositoryId: target.repositoryId,
    repositoryFullName: target.repositoryFullName,
  } as const;
  const providerTarget = Object.freeze({ ...expectedTarget });
  let result: unknown;
  try {
    result = await provider.read(providerTarget);
  } catch {
    return unknown('transport-error', fallbackObservedAt);
  }

  try {
    if (!isPlainObject(result) || typeof result.status !== 'string') {
      return unknown('invalid-response', fallbackObservedAt);
    }
    if (result.status === 'unknown') {
      if (!hasExactKeys(result, ['status', 'reason'])
        || (result.reason !== 'runtime-metadata-unavailable'
          && result.reason !== 'permission-denied'
          && result.reason !== 'transport-error')) {
        return unknown('invalid-response', fallbackObservedAt);
      }
      return unknown(result.reason, fallbackObservedAt);
    }
    if (result.status !== 'response' || !hasExactKeys(result, ['status', 'body'])) {
      return unknown('invalid-response', fallbackObservedAt);
    }
    const envelope = parseStewardRuntimeDiagnosticsEnvelope(result.body);
    if (envelope.subject.repositoryId !== expectedTarget.repositoryId
      || envelope.subject.repositoryFullName.toLowerCase()
        !== expectedTarget.repositoryFullName.toLowerCase()) {
      return unknown('repository-identity-mismatch', fallbackObservedAt);
    }
    return {
      status: 'known',
      envelope,
      source: PRIVATE_CONTROL_DIAGNOSTICS_SOURCE,
    };
  } catch {
    return unknown('invalid-response', fallbackObservedAt);
  }
}
