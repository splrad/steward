import {
  buildStewardRuntimeControlReceipt,
  canonicalStewardRuntimeControlReceiptJson,
  parseStewardRuntimeControlRequest,
  type StewardRuntimeControlRevisionV1,
} from '../../core/src/index.js';

const protocolPath = '/v1/reconcile';
export const maximumControlRequestBytes = 128 * 1024;
const internalProtocolHeader = 'x-steward-internal-protocol';

export interface ControlRuntimeVersionMetadata {
  readonly id: string;
  readonly tag: string;
  readonly timestamp: string;
}

export interface ControlRuntimeEnv {
  readonly CF_VERSION_METADATA: ControlRuntimeVersionMetadata;
}

export interface ControlRuntimeHandler {
  fetch(request: Request, env: ControlRuntimeEnv): Promise<Response>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function contentTypeIsJson(request: Request): boolean {
  const contentType = request.headers.get('content-type');
  return contentType !== null
    && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null
    && (!/^(?:0|[1-9]\d*)$/.test(declaredLength)
      || Number(declaredLength) > maximumControlRequestBytes)
  ) {
    throw new Error('request-body-too-large');
  }

  if (request.body === null) {
    throw new Error('request-body-empty');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumControlRequestBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('request-body-too-large');
    }
    chunks.push(value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  return JSON.parse(text) as unknown;
}

function controlRevision(
  env: ControlRuntimeEnv,
): StewardRuntimeControlRevisionV1 {
  const tagMatch = /^steward-([0-9a-f]{40})$/.exec(
    env.CF_VERSION_METADATA.tag,
  );
  if (tagMatch === null) {
    throw new Error('control-runtime-version-tag-unbound');
  }
  return {
    stewardCommit: tagMatch[1] ?? '',
    workerVersionId: env.CF_VERSION_METADATA.id,
    workerVersionTag: env.CF_VERSION_METADATA.tag,
    workerVersionCreatedAt: env.CF_VERSION_METADATA.timestamp,
  };
}

export function createControlRuntimeHandler(): ControlRuntimeHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname !== protocolPath || request.method !== 'POST') {
        return new Response('Not Found', { status: 404 });
      }
      if (request.headers.get(internalProtocolHeader) !== '1') {
        return jsonResponse(403, { error: 'internal-protocol-required' });
      }
      if (!contentTypeIsJson(request)) {
        return jsonResponse(415, { error: 'application-json-required' });
      }

      let parsed: unknown;
      try {
        parsed = await readBoundedJson(request);
      } catch (error) {
        const status = error instanceof Error && error.message === 'request-body-too-large'
          ? 413
          : 400;
        return jsonResponse(status, { error: status === 413 ? 'request-too-large' : 'invalid-json' });
      }

      let input;
      try {
        input = parseStewardRuntimeControlRequest(parsed);
      } catch {
        return jsonResponse(400, { error: 'invalid-control-request' });
      }

      // The first runtime slice intentionally proves transport and coordination
      // without acknowledging any real governance operation as complete.
      if (
        input.workItem.operation !== 'runtime-probe'
        || input.workItem.cause.kind !== 'internal-probe'
      ) {
        return jsonResponse(501, { error: 'control-operation-not-implemented' });
      }

      try {
        const receipt = buildStewardRuntimeControlReceipt({
          subject: input.workItem.subject,
          deliveryId: input.workItem.cause.deliveryId,
          generation: input.generation,
          controlRevision: controlRevision(env),
        });
        return new Response(canonicalStewardRuntimeControlReceiptJson(receipt), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      } catch {
        return jsonResponse(503, { error: 'control-revision-unavailable' });
      }
    },
  };
}

export default createControlRuntimeHandler();
