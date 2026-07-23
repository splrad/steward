import type { JWK } from 'jose';
import {
  buildStewardRuntimeDiagnosticsControlReceipt,
  canonicalStewardRuntimeDiagnosticsControlReceiptJson,
  parseStewardRuntimeDiagnosticsControlProbe,
} from '../packages/core/src/index.js';

export const diagnosticsFixture = {
  accountId: '5efbba9a3813a37ac45e70cfa9f01cb5',
  eventQueueId: 'b957c244a4bf478887da90ad3fe10909',
  deadLetterQueueId: '7fb7d65f37774837ae7a22f71f7dde4c',
  deploymentId: '7b85e57e-9ef3-4271-9625-7884e4ddbc1c',
  stableVersionId: '32b8936f-bbf7-4342-946c-ac9b730eb497',
  candidateVersionId: 'c2312517-bd5c-4041-a9cd-b6642dbf7e21',
  stewardCommit: 'e'.repeat(40),
  teamDomain: 'diagnostics-test.cloudflareaccess.com',
  audience: 'z'.repeat(64),
  clientId: 'diagnostics-workerd-client.access',
  workersToken: 'diagnostics-workers-read-token',
  queuesToken: 'diagnostics-queues-read-token',
  keyId: 'diagnostics-workerd-access-key',
  subject: {
    repositoryId: 1_298_587_318,
    repositoryFullName: 'splrad/steward-sandbox-install-e2e',
  },
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function cloudflareResult(result: unknown): Response {
  return jsonResponse({ success: true, result });
}

function unexpectedRequest(): Response {
  return jsonResponse({
    success: false,
    errors: [{ code: 10_000, message: 'Unexpected diagnostics test request' }],
    result: null,
  }, 500);
}

export async function diagnosticsControlService(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = request.headers;
  if (
    request.method !== 'POST'
    || url.origin !== 'https://control.internal'
    || url.pathname !== '/v1/runtime-diagnostics'
    || url.search !== ''
    || headers.get('content-type') !== 'application/json'
    || headers.get('x-steward-internal-protocol') !== '1'
    || headers.get('cloudflare-workers-version-key')
      !== `steward-repository-${diagnosticsFixture.subject.repositoryId}`
    || headers.has('authorization')
    || headers.has('cf-access-jwt-assertion')
  ) {
    return jsonResponse({ error: 'invalid-control-test-request' }, 400);
  }

  let probe;
  try {
    probe = parseStewardRuntimeDiagnosticsControlProbe(
      JSON.parse(await request.text()) as unknown,
    );
  } catch {
    return jsonResponse({ error: 'invalid-control-test-probe' }, 400);
  }
  if (
    probe.environment !== 'production'
    || probe.subject.repositoryId
      !== diagnosticsFixture.subject.repositoryId
    || probe.subject.repositoryFullName
      !== diagnosticsFixture.subject.repositoryFullName
  ) {
    return jsonResponse({ error: 'unexpected-control-test-subject' }, 400);
  }

  return new Response(
    canonicalStewardRuntimeDiagnosticsControlReceiptJson(
      buildStewardRuntimeDiagnosticsControlReceipt({
        nonce: probe.nonce,
        subject: probe.subject,
        environment: probe.environment,
        controlRevision: {
          stewardCommit: diagnosticsFixture.stewardCommit,
          workerVersionId: diagnosticsFixture.stableVersionId,
          workerVersionTag:
            `steward-${diagnosticsFixture.stewardCommit}`,
          workerVersionCreatedAt: '2026-07-24T01:00:00.000Z',
        },
      }),
    ),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}

export function createDiagnosticsOutboundService(
  publicJwk: JWK,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (
      request.method === 'GET'
      && url.origin === `https://${diagnosticsFixture.teamDomain}`
      && url.pathname === '/cdn-cgi/access/certs'
      && url.search === ''
    ) {
      return jsonResponse({
        keys: [{
          ...publicJwk,
          kid: diagnosticsFixture.keyId,
          alg: 'RS256',
          use: 'sig',
        }],
      });
    }

    if (
      request.method !== 'GET'
      || url.origin !== 'https://api.cloudflare.com'
      || url.search !== ''
    ) {
      return unexpectedRequest();
    }

    const accountPrefix =
      `/client/v4/accounts/${diagnosticsFixture.accountId}`;
    const authorization = request.headers.get('authorization');
    if (
      url.pathname
        === `${accountPrefix}/workers/scripts/steward-control/deployments`
      && authorization === `Bearer ${diagnosticsFixture.workersToken}`
    ) {
      return cloudflareResult({
        deployments: [{
          id: diagnosticsFixture.deploymentId,
          created_on: '2026-07-24T01:30:00.000Z',
          strategy: 'percentage',
          versions: [
            {
              version_id: diagnosticsFixture.stableVersionId,
              percentage: 100,
            },
            {
              version_id: diagnosticsFixture.candidateVersionId,
              percentage: 0,
            },
          ],
        }],
      });
    }

    const eventQueuePath =
      `${accountPrefix}/queues/${diagnosticsFixture.eventQueueId}`;
    const deadLetterQueuePath =
      `${accountPrefix}/queues/${diagnosticsFixture.deadLetterQueueId}`;
    if (authorization !== `Bearer ${diagnosticsFixture.queuesToken}`) {
      return unexpectedRequest();
    }
    if (url.pathname === eventQueuePath) {
      return cloudflareResult({
        queue_id: diagnosticsFixture.eventQueueId,
        queue_name: 'steward-events',
        producers: [
          { type: 'worker', script: 'steward-ingress' },
          { type: 'worker', script: 'steward-coordinator' },
        ],
        producers_total_count: 2,
        settings: {
          delivery_delay: 0,
          delivery_paused: false,
          message_retention_period: 86_400,
        },
      });
    }
    if (url.pathname === `${eventQueuePath}/consumers`) {
      return cloudflareResult([{
        type: 'worker',
        script_name: 'steward-coordinator',
        dead_letter_queue: 'steward-events-dlq',
        settings: {
          batch_size: 10,
          max_wait_time_ms: 1_000,
          max_retries: 3,
          retry_delay: 5,
        },
      }]);
    }
    if (url.pathname === deadLetterQueuePath) {
      return cloudflareResult({
        queue_id: diagnosticsFixture.deadLetterQueueId,
        queue_name: 'steward-events-dlq',
        producers: [],
        producers_total_count: 0,
        settings: {
          delivery_delay: 0,
          delivery_paused: false,
          message_retention_period: 86_400,
        },
      });
    }
    if (url.pathname === `${deadLetterQueuePath}/consumers`) {
      return cloudflareResult([]);
    }
    if (url.pathname === `${deadLetterQueuePath}/metrics`) {
      return cloudflareResult({
        backlog_count: 0,
        backlog_bytes: 0,
        oldest_message_timestamp_ms: 0,
      });
    }
    return unexpectedRequest();
  };
}
