import { randomBytes } from 'node:crypto';
import {
  buildStewardRuntimeDiagnosticsTransportRequest,
  canonicalStewardRuntimeDiagnosticsTransportRequestJson,
  parseStewardRuntimeDiagnosticsEnvelope,
  parseStewardRuntimeDiagnosticsTransportResponse,
  type StewardRuntimeDiagnosticsEnvelopeV1,
  type StewardRuntimeDiagnosticsSubjectV1,
} from '../../core/src/index.js';

export const PRIVATE_CONTROL_DIAGNOSTICS_SOURCE = 'private-control-diagnostics';
export const AUTHENTICATED_RUNTIME_DIAGNOSTICS_ENDPOINT =
  'https://steward-diagnostics.alearner-5ef.workers.dev/v1/runtime-diagnostics';
export const RUNTIME_DIAGNOSTICS_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RUNTIME_DIAGNOSTICS_RESPONSE_BYTES = 64 * 1024;

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
      | 'transport-error'
      | 'invalid-response';
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

class InvalidRuntimeDiagnosticsResponseError extends Error {}

class RuntimeDiagnosticsResponseTransportError extends Error {}

function providerUnknown(
  reason: Extract<RuntimeDiagnosticsProviderResult, { status: 'unknown' }>['reason'],
): RuntimeDiagnosticsProviderResult {
  return { status: 'unknown', reason };
}

function hasJsonContentType(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  return contentType !== null
    && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim());
}

async function readBoundedResponseBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
      throw new InvalidRuntimeDiagnosticsResponseError();
    }
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)
      || declaredLength > MAX_RUNTIME_DIAGNOSTICS_RESPONSE_BYTES) {
      throw new InvalidRuntimeDiagnosticsResponseError();
    }
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await (async () => {
        try {
          return await reader.read();
        } catch {
          throw new RuntimeDiagnosticsResponseTransportError();
        }
      })();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RUNTIME_DIAGNOSTICS_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The response is already invalid; cancellation is best effort only.
        }
        throw new InvalidRuntimeDiagnosticsResponseError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createAuthenticatedRuntimeDiagnosticsProvider(
  env: NodeJS.ProcessEnv,
  fetchImplementation: typeof fetch = globalThis.fetch,
): RuntimeDiagnosticsProvider | undefined {
  const clientId = String(
    env.STEWARD_RUNTIME_DIAGNOSTICS_ACCESS_CLIENT_ID ?? '',
  ).trim();
  const clientSecret = String(
    env.STEWARD_RUNTIME_DIAGNOSTICS_ACCESS_CLIENT_SECRET ?? '',
  ).trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error(
      'STEWARD_RUNTIME_DIAGNOSTICS_ACCESS_CLIENT_ID and '
      + 'STEWARD_RUNTIME_DIAGNOSTICS_ACCESS_CLIENT_SECRET must be configured together',
    );
  }

  return {
    async read(target) {
      const nonce = randomBytes(32).toString('hex');
      const request = buildStewardRuntimeDiagnosticsTransportRequest({
        nonce,
        subject: target,
      });
      try {
        const response = await fetchImplementation(
          AUTHENTICATED_RUNTIME_DIAGNOSTICS_ENDPOINT,
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'CF-Access-Client-Id': clientId,
              'CF-Access-Client-Secret': clientSecret,
            },
            body: canonicalStewardRuntimeDiagnosticsTransportRequestJson(request),
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.timeout(RUNTIME_DIAGNOSTICS_REQUEST_TIMEOUT_MS),
          },
        );

        if (response.status === 401 || response.status === 403) {
          return providerUnknown('permission-denied');
        }
        if (response.status === 404) {
          return providerUnknown('runtime-metadata-unavailable');
        }
        if (response.status === 429 || response.status >= 500) {
          return providerUnknown('transport-error');
        }
        if (response.status !== 200 || !hasJsonContentType(response)) {
          return providerUnknown('invalid-response');
        }

        try {
          const bytes = await readBoundedResponseBody(response);
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          const wire = parseStewardRuntimeDiagnosticsTransportResponse(
            JSON.parse(text) as unknown,
          );
          if (wire.nonce !== nonce) return providerUnknown('invalid-response');
          return { status: 'response', body: wire.envelope };
        } catch (error) {
          return providerUnknown(
            error instanceof RuntimeDiagnosticsResponseTransportError
              ? 'transport-error'
              : 'invalid-response',
          );
        }
      } catch {
        return providerUnknown('transport-error');
      }
    },
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
          && result.reason !== 'transport-error'
          && result.reason !== 'invalid-response')) {
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
