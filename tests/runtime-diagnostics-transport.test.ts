import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeDiagnosticsControlProbe,
  buildStewardRuntimeDiagnosticsControlReceipt,
  buildStewardRuntimeDiagnosticsTransportRequest,
  buildStewardRuntimeDiagnosticsTransportResponse,
  canonicalStewardRuntimeDiagnosticsControlProbeJson,
  canonicalStewardRuntimeDiagnosticsControlReceiptJson,
  canonicalStewardRuntimeDiagnosticsTransportRequestJson,
  canonicalStewardRuntimeDiagnosticsTransportResponseJson,
  parseStewardRuntimeDiagnosticsControlProbe,
  parseStewardRuntimeDiagnosticsControlReceipt,
  parseStewardRuntimeDiagnosticsTransportRequest,
  parseStewardRuntimeDiagnosticsTransportResponse,
  RuntimeDiagnosticsTransportValidationError,
  type StewardRuntimeDiagnosticsControlProbeV1,
  type StewardRuntimeDiagnosticsControlReceiptV1,
  type StewardRuntimeDiagnosticsTransportRequestV1,
  type StewardRuntimeDiagnosticsTransportResponseV1,
} from '../packages/core/src/runtime-diagnostics-transport.js';

const nonce = 'a'.repeat(64);
const subject = {
  repositoryId: 1_298_587_318,
  repositoryFullName: 'splrad/steward-sandbox-install-e2e',
} as const;
const controlRevision = {
  stewardCommit: 'b'.repeat(40),
  workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
  workerVersionTag: `steward-${'b'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-24T06:00:00.000Z',
} as const;
const envelope = {
  schemaVersion: 1,
  subject,
  observedAt: '2026-07-24T06:01:02.345Z',
  diagnostics: {
    controlRevision: {
      stewardCommit: 'b'.repeat(40),
      workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
      workerDeploymentId: '7b85e57e-9ef3-4271-9625-7884e4ddbc1c',
      environment: 'production',
    },
    queue: 'ready',
    control: 'ready',
    deadLetterQueue: 'clear',
  },
} as const;

function request(): StewardRuntimeDiagnosticsTransportRequestV1 {
  return {
    transportVersion: 1,
    audience: 'steward-runtime-diagnostics',
    nonce,
    subject,
  };
}

function response(): StewardRuntimeDiagnosticsTransportResponseV1 {
  return {
    transportVersion: 1,
    audience: 'steward-runtime-diagnostics',
    nonce,
    envelope,
  };
}

function probe(): StewardRuntimeDiagnosticsControlProbeV1 {
  return {
    transportVersion: 1,
    audience: 'steward-runtime-diagnostics',
    nonce,
    subject,
    environment: 'production',
  };
}

function receipt(): StewardRuntimeDiagnosticsControlReceiptV1 {
  return {
    transportVersion: 1,
    audience: 'steward-runtime-diagnostics',
    nonce,
    subject,
    environment: 'production',
    controlRevision,
  };
}

const protocols = [
  {
    name: 'external request',
    value: request,
    parse: parseStewardRuntimeDiagnosticsTransportRequest as (value: unknown) => unknown,
  },
  {
    name: 'external response',
    value: response,
    parse: parseStewardRuntimeDiagnosticsTransportResponse as (value: unknown) => unknown,
  },
  {
    name: 'Control probe',
    value: probe,
    parse: parseStewardRuntimeDiagnosticsControlProbe as (value: unknown) => unknown,
  },
  {
    name: 'Control receipt',
    value: receipt,
    parse: parseStewardRuntimeDiagnosticsControlReceipt as (value: unknown) => unknown,
  },
] as const;

describe('runtime diagnostics transport protocol', () => {
  it('builds and parses the exact external request and response', () => {
    expect(parseStewardRuntimeDiagnosticsTransportRequest(request())).toEqual(request());
    expect(buildStewardRuntimeDiagnosticsTransportRequest({
      nonce,
      subject,
    })).toEqual(request());

    expect(parseStewardRuntimeDiagnosticsTransportResponse(response())).toEqual(response());
    expect(buildStewardRuntimeDiagnosticsTransportResponse({
      nonce,
      envelope,
    })).toEqual(response());
  });

  it('builds and parses the exact internal Control probe and receipt', () => {
    expect(parseStewardRuntimeDiagnosticsControlProbe(probe())).toEqual(probe());
    expect(buildStewardRuntimeDiagnosticsControlProbe({
      nonce,
      subject,
      environment: 'production',
    })).toEqual(probe());

    expect(parseStewardRuntimeDiagnosticsControlReceipt(receipt())).toEqual(receipt());
    expect(buildStewardRuntimeDiagnosticsControlReceipt({
      nonce,
      subject,
      environment: 'production',
      controlRevision,
    })).toEqual(receipt());
  });

  it('canonicalizes all four objects in their protocol key order', () => {
    expect(canonicalStewardRuntimeDiagnosticsTransportRequestJson(request())).toBe(
      `{"transportVersion":1,"audience":"steward-runtime-diagnostics","nonce":"${nonce}","subject":{"repositoryId":1298587318,"repositoryFullName":"splrad/steward-sandbox-install-e2e"}}`,
    );
    expect(canonicalStewardRuntimeDiagnosticsTransportResponseJson(response())).toBe(
      `{"transportVersion":1,"audience":"steward-runtime-diagnostics","nonce":"${nonce}","envelope":{"schemaVersion":1,"subject":{"repositoryId":1298587318,"repositoryFullName":"splrad/steward-sandbox-install-e2e"},"observedAt":"2026-07-24T06:01:02.345Z","diagnostics":{"controlRevision":{"stewardCommit":"${'b'.repeat(40)}","workerVersionId":"d61f54f6-b30a-4e42-8184-c9e7e1cb495d","workerDeploymentId":"7b85e57e-9ef3-4271-9625-7884e4ddbc1c","environment":"production"},"queue":"ready","control":"ready","deadLetterQueue":"clear"}}}`,
    );
    expect(canonicalStewardRuntimeDiagnosticsControlProbeJson(probe())).toBe(
      `{"transportVersion":1,"audience":"steward-runtime-diagnostics","nonce":"${nonce}","subject":{"repositoryId":1298587318,"repositoryFullName":"splrad/steward-sandbox-install-e2e"},"environment":"production"}`,
    );
    expect(canonicalStewardRuntimeDiagnosticsControlReceiptJson(receipt())).toBe(
      `{"transportVersion":1,"audience":"steward-runtime-diagnostics","nonce":"${nonce}","subject":{"repositoryId":1298587318,"repositoryFullName":"splrad/steward-sandbox-install-e2e"},"environment":"production","controlRevision":{"stewardCommit":"${'b'.repeat(40)}","workerVersionId":"d61f54f6-b30a-4e42-8184-c9e7e1cb495d","workerVersionTag":"steward-${'b'.repeat(40)}","workerVersionCreatedAt":"2026-07-24T06:00:00.000Z"}}`,
    );
  });

  it.each(protocols)('rejects non-plain $name objects', ({ parse }) => {
    for (const value of [null, [], new Date(), Object.create({ transportVersion: 1 })]) {
      expect(() => parse(value)).toThrow(RuntimeDiagnosticsTransportValidationError);
    }
  });

  it.each(protocols)('rejects missing, extra, and symbol keys on $name', ({ value, parse }) => {
    const missing = structuredClone(value()) as unknown as Record<PropertyKey, unknown>;
    delete missing.transportVersion;
    expect(() => parse(missing)).toThrow(RuntimeDiagnosticsTransportValidationError);

    const extra = structuredClone(value()) as unknown as Record<PropertyKey, unknown>;
    extra.source = 'cached';
    expect(() => parse(extra)).toThrow(RuntimeDiagnosticsTransportValidationError);

    const symbol = structuredClone(value()) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(symbol, Symbol('hidden'), { value: true, enumerable: true });
    expect(() => parse(symbol)).toThrow(RuntimeDiagnosticsTransportValidationError);
  });

  it.each(protocols)('rejects the wrong transport binding on $name', ({ value, parse }) => {
    expect(() => parse({ ...value(), transportVersion: 2 }))
      .toThrow(RuntimeDiagnosticsTransportValidationError);
    expect(() => parse({ ...value(), audience: 'steward-control' }))
      .toThrow(RuntimeDiagnosticsTransportValidationError);
  });

  it.each([
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    ` ${'a'.repeat(63)}`,
    123,
  ])('rejects invalid nonce %s across all transport objects', (invalidNonce) => {
    for (const protocol of protocols) {
      expect(() => protocol.parse({ ...protocol.value(), nonce: invalidNonce }))
        .toThrow(RuntimeDiagnosticsTransportValidationError);
    }
  });

  it('rejects invalid nested objects without leaking their validation error type', () => {
    const badSubject = structuredClone(subject) as unknown as Record<PropertyKey, unknown>;
    badSubject[Symbol('hidden')] = true;
    expect(() => parseStewardRuntimeDiagnosticsTransportRequest({
      ...request(),
      subject: badSubject,
    })).toThrow(RuntimeDiagnosticsTransportValidationError);

    expect(() => parseStewardRuntimeDiagnosticsTransportResponse({
      ...response(),
      envelope: { ...envelope, cached: true },
    })).toThrow(RuntimeDiagnosticsTransportValidationError);

    expect(() => parseStewardRuntimeDiagnosticsControlReceipt({
      ...receipt(),
      controlRevision: { ...controlRevision, workerVersionId: 'not-a-uuid' },
    })).toThrow(RuntimeDiagnosticsTransportValidationError);
  });

  it.each(['development', 'stable', 'candidate ', null])(
    'rejects unsupported Control environment %s',
    (environment) => {
      expect(() => parseStewardRuntimeDiagnosticsControlProbe({
        ...probe(),
        environment,
      })).toThrow(RuntimeDiagnosticsTransportValidationError);
      expect(() => parseStewardRuntimeDiagnosticsControlReceipt({
        ...receipt(),
        environment,
      })).toThrow(RuntimeDiagnosticsTransportValidationError);
    },
  );

  it('rejects extra builder input instead of silently stripping it', () => {
    expect(() => buildStewardRuntimeDiagnosticsTransportRequest({
      nonce,
      subject,
      cached: true,
    } as never)).toThrow(RuntimeDiagnosticsTransportValidationError);
    expect(() => buildStewardRuntimeDiagnosticsTransportResponse({
      nonce,
      envelope,
      cached: true,
    } as never)).toThrow(RuntimeDiagnosticsTransportValidationError);
    expect(() => buildStewardRuntimeDiagnosticsControlProbe({
      nonce,
      subject,
      environment: 'production',
      cached: true,
    } as never)).toThrow(RuntimeDiagnosticsTransportValidationError);
    expect(() => buildStewardRuntimeDiagnosticsControlReceipt({
      nonce,
      subject,
      environment: 'production',
      controlRevision,
      cached: true,
    } as never)).toThrow(RuntimeDiagnosticsTransportValidationError);
  });
});
