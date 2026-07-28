import {
  verifyCloudflareAccessPrincipal,
  type CloudflareAccessEnvironment,
  type CloudflareAccessPrincipalResult,
} from '../../access-auth/src/index.js';
import {
  assertFreshRuntimePromotionCommand,
  assertFreshRuntimePromotionResolution,
  canonicalRuntimePromotionDeployment,
  desiredRuntimePromotionDeployment,
  maximumRuntimePromotionRequestBytes,
  minimumRuntimePromotionResolutionQuietMs,
  parseRuntimePromotionCommand,
  parseRuntimePromotionUnknownResolution,
  runtimePromotionDispatchLeaseMs,
  sameRuntimePromotionTraffic,
  type RuntimePromotionAbandonResult,
  type RuntimePromotionCommandV1,
  type RuntimePromotionBeginResult,
  type RuntimePromotionDeployment,
  type RuntimePromotionLedgerEntry,
  type RuntimePromotionLedgerState,
  type RuntimePromotionUnknownResolutionV1,
  type RuntimePromotionWorker,
} from './contracts.js';

const promotionPath = '/v1/runtime-promotion';
const promotionResolutionPath = '/v1/runtime-promotion/resolve-unknown';
const cloudflareApiOrigin = 'https://api.cloudflare.com';
const accountIdPattern = /^[0-9a-f]{32}$/;
const apiTokenPattern = /^[\x21-\x7e]{20,512}$/;
const maximumCloudflareResponseBytes = 256 * 1024;
const cloudflareRequestTimeoutMs = 10_000;

export interface RuntimePromotionLedgerStub {
  begin(value: {
    readonly command: unknown;
    readonly principal: string;
    readonly before: RuntimePromotionDeployment;
    readonly desired: RuntimePromotionDeployment;
    readonly now: string;
  }): Promise<RuntimePromotionBeginResult>;
  settle(value: {
    readonly commandId: string;
    readonly state: Exclude<
      RuntimePromotionLedgerState,
      'dispatching' | 'unknown'
    >;
    readonly after: RuntimePromotionDeployment | null;
    readonly now: string;
  }): Promise<RuntimePromotionLedgerEntry>;
  markUnknown(value: {
    readonly commandId: string;
    readonly after: RuntimePromotionDeployment | null;
    readonly now: string;
  }): Promise<RuntimePromotionLedgerEntry>;
  abandonUnknown(value: {
    readonly commandId: string;
    readonly worker: string;
    readonly principal: string;
    readonly before: RuntimePromotionDeployment;
    readonly now: string;
  }): Promise<RuntimePromotionAbandonResult>;
  inspect(commandId: string): Promise<RuntimePromotionLedgerEntry | null>;
}

export interface RuntimePromotionLedgerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): RuntimePromotionLedgerStub;
}

export interface RuntimePromotionEnv extends CloudflareAccessEnvironment {
  readonly RUNTIME_PROMOTION_LEDGER: RuntimePromotionLedgerNamespace;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  readonly CLOUDFLARE_WORKERS_WRITE_TOKEN?: string;
}

export interface RuntimePromotionDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly verifyAccess: (
    request: Request,
    env: RuntimePromotionEnv,
  ) => Promise<CloudflareAccessPrincipalResult>;
}

export interface RuntimePromotionHandler {
  fetch(request: Request, env: RuntimePromotionEnv): Promise<Response>;
}

class RequestError extends Error {
  constructor(readonly kind: 'invalid' | 'too-large') {
    super(kind);
  }
}

class CloudflareUnavailableError extends Error {}
class CloudflareRejectedError extends Error {}
class PromotionPreconditionError extends Error {}
class PromotionVersionProvenanceError extends Error {}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function contentTypeIsJson(headers: Headers): boolean {
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
    String(headers.get('content-type') ?? '').trim(),
  );
}

type StreamReadResult = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>
>;

async function readBoundedChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  unavailable: () => Error,
): Promise<StreamReadResult> {
  if (signal.aborted) throw unavailable();
  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(unavailable());
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (rejectOnAbort !== undefined) {
      signal.removeEventListener('abort', rejectOnAbort);
    }
  }
}

async function readBoundedStreamJson(
  body: ReadableStream<Uint8Array> | null,
  declared: string | null,
  maximumBytes: number,
  signal: AbortSignal,
  invalid: () => Error,
  tooLarge: () => Error = invalid,
): Promise<unknown> {
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declared)) {
      await body?.cancel().catch(() => undefined);
      throw invalid();
    }
    if (Number(declared) > maximumBytes) {
      await body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
  }
  if (body === null) throw invalid();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await readBoundedChunk(reader, signal, invalid);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) throw tooLarge();
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  return await readBoundedStreamJson(
    request.body,
    request.headers.get('content-length'),
    maximumRuntimePromotionRequestBytes,
    request.signal,
    () => new RequestError('invalid'),
    () => new RequestError('too-large'),
  );
}

function cloudflareConfig(env: RuntimePromotionEnv): {
  readonly accountId: string;
  readonly token: string;
} {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID ?? '');
  const token = String(env.CLOUDFLARE_WORKERS_WRITE_TOKEN ?? '');
  if (
    !accountIdPattern.test(accountId)
    || !apiTokenPattern.test(token)
    || token !== token.trim()
  ) {
    throw new CloudflareUnavailableError();
  }
  return { accountId, token };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

async function readResponseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!contentTypeIsJson(response.headers)) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudflareUnavailableError();
  }
  return await readBoundedStreamJson(
    response.body,
    response.headers.get('content-length'),
    maximumCloudflareResponseBytes,
    signal,
    () => new CloudflareUnavailableError(),
  );
}

function parseDeployment(value: unknown): RuntimePromotionDeployment {
  const deployment = plainRecord(value);
  const versions = deployment?.versions;
  if (
    deployment === null
    || deployment.strategy !== 'percentage'
    || !Array.isArray(versions)
  ) {
    throw new CloudflareUnavailableError();
  }
  try {
    return canonicalRuntimePromotionDeployment({
      id: String(deployment.id ?? ''),
      versions: versions.map((candidate) => {
        const item = plainRecord(candidate);
        return {
          versionId: String(item?.version_id ?? ''),
          percentage: item?.percentage as number,
        };
      }),
    });
  } catch {
    throw new CloudflareUnavailableError();
  }
}

async function cloudflareRequest(
  dependencies: RuntimePromotionDependencies,
  config: ReturnType<typeof cloudflareConfig>,
  worker: RuntimePromotionWorker,
  path: 'deployments' | `versions/${string}`,
  method: 'GET' | 'POST',
  parentSignal: AbortSignal,
  body?: string,
): Promise<{ readonly response: Response; readonly signal: AbortSignal }> {
  const signal = AbortSignal.any([
    parentSignal,
    AbortSignal.timeout(cloudflareRequestTimeoutMs),
  ]);
  try {
    const response = await dependencies.fetch(
      `${cloudflareApiOrigin}/client/v4/accounts/${config.accountId}`
      + `/workers/scripts/${worker}/${path}`,
      {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${config.token}`,
          'cache-control': 'no-store',
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json; charset=utf-8' }),
          'user-agent': 'splrad-steward-runtime-promotion',
        },
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal,
      },
    );
    return { response, signal };
  } catch {
    throw new CloudflareUnavailableError();
  }
}

async function readActiveDeployment(
  dependencies: RuntimePromotionDependencies,
  config: ReturnType<typeof cloudflareConfig>,
  worker: RuntimePromotionWorker,
  parentSignal: AbortSignal,
): Promise<RuntimePromotionDeployment> {
  const { response, signal } = await cloudflareRequest(
    dependencies,
    config,
    worker,
    'deployments',
    'GET',
    parentSignal,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudflareUnavailableError();
  }
  const envelope = plainRecord(await readResponseJson(response, signal));
  const result = plainRecord(envelope?.result);
  const deployments = result?.deployments;
  if (
    envelope?.success !== true
    || !Array.isArray(deployments)
    || deployments.length === 0
  ) {
    throw new CloudflareUnavailableError();
  }
  return parseDeployment(deployments[0]);
}

async function assertCandidateVersionProvenance(
  dependencies: RuntimePromotionDependencies,
  config: ReturnType<typeof cloudflareConfig>,
  command: RuntimePromotionCommandV1,
  parentSignal: AbortSignal,
): Promise<void> {
  const { response, signal } = await cloudflareRequest(
    dependencies,
    config,
    command.worker,
    `versions/${command.candidateVersionId}`,
    'GET',
    parentSignal,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudflareUnavailableError();
  }
  const envelope = plainRecord(await readResponseJson(response, signal));
  const version = plainRecord(envelope?.result);
  const annotations = plainRecord(version?.annotations);
  if (
    envelope?.success !== true
    || version === null
    || version.id !== command.candidateVersionId
    || annotations?.['workers/tag'] !== `steward-${command.stewardCommit}`
  ) {
    throw new PromotionVersionProvenanceError();
  }
}

async function writeDeployment(
  dependencies: RuntimePromotionDependencies,
  config: ReturnType<typeof cloudflareConfig>,
  worker: RuntimePromotionWorker,
  desired: RuntimePromotionDeployment,
  commandId: string,
  parentSignal: AbortSignal,
): Promise<void> {
  const { response, signal } = await cloudflareRequest(
    dependencies,
    config,
    worker,
    'deployments',
    'POST',
    parentSignal,
    JSON.stringify({
      strategy: 'percentage',
      versions: desired.versions.map((version) => ({
        version_id: version.versionId,
        percentage: version.percentage,
      })),
      annotations: {
        'workers/message':
          `SPLRAD Steward protected runtime promotion ${commandId}`,
      },
    }),
  );
  if (response.status >= 400 && response.status < 500) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudflareRejectedError();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudflareUnavailableError();
  }
  const envelope = plainRecord(await readResponseJson(response, signal));
  if (envelope?.success !== true) throw new CloudflareUnavailableError();
}

function versionPercentage(
  deployment: RuntimePromotionDeployment,
  versionId: string,
): number | undefined {
  return deployment.versions.find(
    (version) => version.versionId === versionId,
  )?.percentage;
}

function assertTransition(
  command: RuntimePromotionCommandV1,
  before: RuntimePromotionDeployment,
): void {
  const stable = versionPercentage(before, command.stableVersionId);
  if (command.stableVersionId === command.candidateVersionId) {
    if (
      stable !== 100
      || before.versions.length !== 1
    ) {
      throw new PromotionPreconditionError();
    }
    return;
  }
  const candidate = versionPercentage(before, command.candidateVersionId);
  const other = before.versions.some(
    (version) =>
      version.versionId !== command.stableVersionId
      && version.versionId !== command.candidateVersionId,
  );
  if (other || stable === undefined) throw new PromotionPreconditionError();
  if (command.operation === 'stage') {
    if (stable !== 100 || (candidate !== undefined && candidate !== 0)) {
      throw new PromotionPreconditionError();
    }
    return;
  }
  if (
    command.operation === 'rollback'
    && candidate === undefined
    && stable === 100
    && before.versions.length === 1
  ) {
    return;
  }
  if (candidate === undefined) throw new PromotionPreconditionError();
  if (
    command.operation === 'promote'
    && candidate > command.candidatePercentage
  ) {
    throw new PromotionPreconditionError();
  }
}

function finalState(
  operation: RuntimePromotionCommandV1['operation'],
): Exclude<RuntimePromotionLedgerState, 'dispatching' | 'unknown'> {
  if (operation === 'stage') return 'staged';
  if (operation === 'promote') return 'promoted';
  if (operation === 'canary-stop') return 'canary-stopped';
  return 'rolled-back';
}

function sameRuntimePromotionDeployment(
  left: RuntimePromotionDeployment,
  right: RuntimePromotionDeployment,
): boolean {
  return left.id === right.id && sameRuntimePromotionTraffic(left, right);
}

function terminalHttpStatus(entry: RuntimePromotionLedgerEntry): number {
  if (
    entry.state === 'staged'
    || entry.state === 'promoted'
    || entry.state === 'canary-stopped'
    || entry.state === 'rolled-back'
  ) {
    return 200;
  }
  if (entry.state === 'rejected') return 502;
  if (entry.state === 'unknown') return 503;
  return 409;
}

function publicEntry(entry: RuntimePromotionLedgerEntry): unknown {
  return {
    schemaVersion: 1,
    commandId: entry.command.commandId,
    operation: entry.command.operation,
    state: entry.state,
    worker: entry.command.worker,
    stewardCommit: entry.command.stewardCommit,
    before: entry.before,
    desired: entry.desired,
    after: entry.after,
    updatedAt: entry.updatedAt,
  };
}

async function reconcileActiveIntent(
  dependencies: RuntimePromotionDependencies,
  config: ReturnType<typeof cloudflareConfig>,
  ledger: RuntimePromotionLedgerStub,
  entry: RuntimePromotionLedgerEntry,
  parentSignal: AbortSignal,
  now: string,
): Promise<Response> {
  let after: RuntimePromotionDeployment;
  try {
    after = await readActiveDeployment(
      dependencies,
      config,
      entry.command.worker,
      parentSignal,
    );
  } catch {
    if (entry.state !== 'dispatching') {
      return json(503, publicEntry(entry));
    }
    const unknown = await ledger.markUnknown({
      commandId: entry.command.commandId,
      after: null,
      now,
    });
    return json(503, publicEntry(unknown));
  }
  if (sameRuntimePromotionTraffic(after, entry.desired)) {
    const settled = await ledger.settle({
      commandId: entry.command.commandId,
      state: finalState(entry.command.operation),
      after,
      now,
    });
    return json(200, publicEntry(settled));
  }
  if (after.id !== entry.before.id) {
    const superseded = await ledger.settle({
      commandId: entry.command.commandId,
      state: 'superseded',
      after,
      now,
    });
    return json(409, publicEntry(superseded));
  }
  if (entry.state === 'dispatching') {
    const unknown = await ledger.markUnknown({
      commandId: entry.command.commandId,
      after,
      now,
    });
    return json(503, publicEntry(unknown));
  }
  return json(503, publicEntry(entry));
}

const defaultDependencies: RuntimePromotionDependencies = {
  fetch,
  now: () => new Date(),
  verifyAccess: (request, env) =>
    verifyCloudflareAccessPrincipal(request, env, fetch, request.signal),
};

export function createRuntimePromotionHandler(
  dependencies: RuntimePromotionDependencies = defaultDependencies,
): RuntimePromotionHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const isPromotion = url.pathname === promotionPath;
      const isResolution = url.pathname === promotionResolutionPath;
      if (
        (!isPromotion && !isResolution)
        || url.search !== ''
        || request.method !== 'POST'
      ) {
        return new Response('Not Found', { status: 404 });
      }
      const access = await dependencies.verifyAccess(request, env);
      if (access.decision !== 'authorized') {
        return json(
          access.decision === 'denied' ? 403 : 503,
          { error: access.decision === 'denied' ? 'access-denied' : 'promotion-unavailable' },
        );
      }
      if (!contentTypeIsJson(request.headers)) {
        return json(415, { error: 'application-json-required' });
      }
      const currentNow = dependencies.now();
      const now = currentNow.toISOString();

      if (isResolution) {
        let resolution: RuntimePromotionUnknownResolutionV1;
        try {
          resolution = parseRuntimePromotionUnknownResolution(
            await readBoundedJson(request),
          );
          assertFreshRuntimePromotionResolution(resolution, currentNow);
        } catch (error) {
          return json(
            error instanceof RequestError && error.kind === 'too-large'
              ? 413
              : 400,
            { error: 'invalid-promotion-resolution' },
          );
        }
        let config: ReturnType<typeof cloudflareConfig>;
        try {
          config = cloudflareConfig(env);
        } catch {
          return json(503, { error: 'promotion-unavailable' });
        }
        const ledger = env.RUNTIME_PROMOTION_LEDGER.get(
          env.RUNTIME_PROMOTION_LEDGER.idFromName('global-v1'),
        );
        const existing = await ledger.inspect(resolution.commandId);
        if (
          existing === null
          || existing.principal !== access.principal.clientId
          || existing.command.worker !== resolution.worker
          || !sameRuntimePromotionDeployment(
            existing.before,
            resolution.expectedBefore,
          )
        ) {
          return json(409, { error: 'promotion-resolution-conflict' });
        }
        if (existing.state !== 'unknown') {
          return json(terminalHttpStatus(existing), publicEntry(existing));
        }
        const quietMs = currentNow.getTime() - Date.parse(existing.updatedAt);
        if (
          !Number.isFinite(quietMs)
          || quietMs < minimumRuntimePromotionResolutionQuietMs
        ) {
          return json(409, { error: 'promotion-resolution-too-early' });
        }
        let active: RuntimePromotionDeployment;
        try {
          active = await readActiveDeployment(
            dependencies,
            config,
            resolution.worker,
            request.signal,
          );
        } catch {
          return json(503, { error: 'promotion-unavailable' });
        }
        if (sameRuntimePromotionTraffic(active, existing.desired)) {
          const settled = await ledger.settle({
            commandId: resolution.commandId,
            state: finalState(existing.command.operation),
            after: active,
            now,
          });
          return json(200, publicEntry(settled));
        }
        if (active.id !== existing.before.id) {
          const superseded = await ledger.settle({
            commandId: resolution.commandId,
            state: 'superseded',
            after: active,
            now,
          });
          return json(409, publicEntry(superseded));
        }
        if (!sameRuntimePromotionDeployment(active, existing.before)) {
          return json(409, { error: 'promotion-resolution-conflict' });
        }
        let abandoned: RuntimePromotionAbandonResult;
        try {
          abandoned = await ledger.abandonUnknown({
            commandId: resolution.commandId,
            worker: resolution.worker,
            principal: access.principal.clientId,
            before: resolution.expectedBefore,
            now,
          });
        } catch {
          return json(409, { error: 'promotion-resolution-conflict' });
        }
        if (abandoned.status === 'too-early') {
          return json(409, { error: 'promotion-resolution-too-early' });
        }
        if (abandoned.status === 'completed') {
          return json(
            terminalHttpStatus(abandoned.entry),
            publicEntry(abandoned.entry),
          );
        }
        return json(200, publicEntry(abandoned.entry));
      }

      let command: RuntimePromotionCommandV1;
      try {
        command = parseRuntimePromotionCommand(await readBoundedJson(request));
      } catch (error) {
        return json(
          error instanceof RequestError && error.kind === 'too-large'
            ? 413
            : 400,
          { error: 'invalid-promotion-command' },
        );
      }

      let config: ReturnType<typeof cloudflareConfig>;
      try {
        config = cloudflareConfig(env);
      } catch {
        return json(503, { error: 'promotion-unavailable' });
      }
      const ledger = env.RUNTIME_PROMOTION_LEDGER.get(
        env.RUNTIME_PROMOTION_LEDGER.idFromName('global-v1'),
      );
      const existing = await ledger.inspect(command.commandId);
      if (existing !== null) {
        if (
          existing.principal !== access.principal.clientId
          || JSON.stringify(existing.command) !== JSON.stringify(command)
        ) {
          return json(409, { error: 'promotion-command-conflict' });
        }
        if (existing.state === 'dispatching') {
          const dispatchAgeMs = currentNow.getTime()
            - Date.parse(existing.updatedAt);
          if (
            !Number.isFinite(dispatchAgeMs)
            || dispatchAgeMs < runtimePromotionDispatchLeaseMs
          ) {
            return json(409, { error: 'promotion-in-progress' });
          }
        }
        if (
          existing.state !== 'unknown'
          && existing.state !== 'dispatching'
        ) {
          return json(terminalHttpStatus(existing), publicEntry(existing));
        }
        return await reconcileActiveIntent(
          dependencies,
          config,
          ledger,
          existing,
          request.signal,
          now,
        );
      }

      try {
        assertFreshRuntimePromotionCommand(command, currentNow);
      } catch {
        return json(400, { error: 'invalid-promotion-command' });
      }
      let before: RuntimePromotionDeployment;
      try {
        before = await readActiveDeployment(
          dependencies,
          config,
          command.worker,
          request.signal,
        );
      } catch {
        return json(503, { error: 'promotion-unavailable' });
      }
      const desired = desiredRuntimePromotionDeployment(command);
      if (before.id !== command.expectedDeploymentId) {
        const intentNow = dependencies.now().toISOString();
        const begun = await ledger.begin({
          command,
          principal: access.principal.clientId,
          before,
          desired,
          now: intentNow,
        });
        if (begun.status !== 'begun') {
          return json(409, { error: 'promotion-in-progress' });
        }
        const superseded = await ledger.settle({
          commandId: command.commandId,
          state: 'superseded',
          after: before,
          now: intentNow,
        });
        return json(409, publicEntry(superseded));
      }
      try {
        assertTransition(command, before);
      } catch {
        return json(409, { error: 'promotion-precondition-failed' });
      }
      try {
        await assertCandidateVersionProvenance(
          dependencies,
          config,
          command,
          request.signal,
        );
      } catch (error) {
        return json(
          error instanceof PromotionVersionProvenanceError ? 409 : 503,
          {
            error: error instanceof PromotionVersionProvenanceError
              ? 'promotion-version-provenance-mismatch'
              : 'promotion-unavailable',
          },
        );
      }

      // The durable dispatch lease starts when intent is committed, not when
      // the request entered. The two bounded preflight reads above may consume
      // most or all of the lease window.
      const intentNow = dependencies.now().toISOString();
      const begun = await ledger.begin({
        command,
        principal: access.principal.clientId,
        before,
        desired,
        now: intentNow,
      });
      if (begun.status !== 'begun') {
        return json(409, { error: 'promotion-in-progress' });
      }
      let revalidatedBefore: RuntimePromotionDeployment;
      try {
        revalidatedBefore = await readActiveDeployment(
          dependencies,
          config,
          command.worker,
          request.signal,
        );
      } catch {
        const rejected = await ledger.settle({
          commandId: command.commandId,
          state: 'rejected',
          after: null,
          now: dependencies.now().toISOString(),
        });
        return json(503, publicEntry(rejected));
      }
      if (!sameRuntimePromotionDeployment(revalidatedBefore, before)) {
        const superseded = await ledger.settle({
          commandId: command.commandId,
          state: 'superseded',
          after: revalidatedBefore,
          now: dependencies.now().toISOString(),
        });
        return json(409, publicEntry(superseded));
      }
      if (sameRuntimePromotionTraffic(revalidatedBefore, desired)) {
        const settled = await ledger.settle({
          commandId: command.commandId,
          state: finalState(command.operation),
          after: revalidatedBefore,
          now,
        });
        return json(200, publicEntry(settled));
      }

      let rejected = false;
      try {
        await writeDeployment(
          dependencies,
          config,
          command.worker,
          desired,
          command.commandId,
          request.signal,
        );
      } catch (error) {
        rejected = error instanceof CloudflareRejectedError;
      }

      let after: RuntimePromotionDeployment | null = null;
      try {
        after = await readActiveDeployment(
          dependencies,
          config,
          command.worker,
          request.signal,
        );
      } catch {
        // The durable intent remains recoverable when terminal readback fails.
      }
      if (
        after !== null
        && sameRuntimePromotionTraffic(after, desired)
      ) {
        const settled = await ledger.settle({
          commandId: command.commandId,
          state: finalState(command.operation),
          after,
          now: dependencies.now().toISOString(),
        });
        return json(200, publicEntry(settled));
      }
      if (
        rejected
        && after !== null
        && sameRuntimePromotionDeployment(after, before)
      ) {
        const settled = await ledger.settle({
          commandId: command.commandId,
          state: 'rejected',
          after,
          now: dependencies.now().toISOString(),
        });
        return json(502, publicEntry(settled));
      }
      const unknown = await ledger.markUnknown({
        commandId: command.commandId,
        after,
        now: dependencies.now().toISOString(),
      });
      return json(503, publicEntry(unknown));
    },
  };
}

export default createRuntimePromotionHandler();
