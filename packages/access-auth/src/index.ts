import {
  createRemoteJWKSet,
  customFetch,
  importJWK,
  jwksCache,
  jwtVerify,
  type JWK,
  type JWKSCacheInput,
} from 'jose';

const accessAssertionHeader = 'cf-access-jwt-assertion';
const accessJwksTimeoutMs = 5_000;
const maximumAccessJwksResponseBytes = 256 * 1024;
const accessTeamDomainPattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const accessJwksCaches = new WeakMap<
  typeof fetch,
  Map<string, JWKSCacheInput>
>();

export type CloudflareAccessDecision =
  | 'authorized'
  | 'denied'
  | 'unavailable';

export interface CloudflareAccessEnvironment {
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_POLICY_AUD?: string;
  readonly ACCESS_EXPECTED_CLIENT_ID?: string;
}

export interface CloudflareAccessServicePrincipal {
  readonly type: 'service';
  readonly clientId: string;
}

export type CloudflareAccessPrincipalResult =
  | {
      readonly decision: 'authorized';
      readonly principal: CloudflareAccessServicePrincipal;
    }
  | {
      readonly decision: 'denied' | 'unavailable';
    };

class AccessJwksUnavailableError extends Error {
  constructor() {
    super('Cloudflare Access JWKS are unavailable');
    this.name = 'AccessJwksUnavailableError';
  }
}

function contentTypeIsJson(headers: Headers): boolean {
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
    headers.get('content-type') ?? '',
  );
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function boundedSignal(
  parent: AbortSignal,
  timeoutMs: number,
  additional?: AbortSignal | null,
): AbortSignal {
  const signals = [parent, AbortSignal.timeout(timeoutMs)];
  if (additional !== undefined && additional !== null) {
    signals.push(additional);
  }
  return AbortSignal.any(signals);
}

async function readBoundedStreamJson(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    declaredLength !== null
    && (!/^(?:0|[1-9]\d*)$/.test(declaredLength)
      || Number(declaredLength) > maximumBytes)
  ) {
    throw new AccessJwksUnavailableError();
  }
  if (body === null) throw new AccessJwksUnavailableError();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new AccessJwksUnavailableError();
    }
    let rejectOnAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(new AccessJwksUnavailableError());
      signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await Promise.race([reader.read(), aborted]);
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new AccessJwksUnavailableError();
    } finally {
      if (rejectOnAbort !== undefined) {
        signal.removeEventListener('abort', rejectOnAbort);
      }
    }
    const { done, value } = chunk;
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AccessJwksUnavailableError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new AccessJwksUnavailableError();
  }
}

function accessConfiguration(env: CloudflareAccessEnvironment): {
  readonly teamDomain: string;
  readonly audience: string;
  readonly clientId: string;
} {
  const teamDomain = String(env.ACCESS_TEAM_DOMAIN ?? '').toLowerCase();
  const audience = String(env.ACCESS_POLICY_AUD ?? '');
  const clientId = String(env.ACCESS_EXPECTED_CLIENT_ID ?? '');
  if (
    !accessTeamDomainPattern.test(teamDomain)
    || !/^[A-Za-z0-9_-]{20,128}$/.test(audience)
    || !/^[\x21-\x7e]{1,256}$/.test(clientId)
    || clientId !== clientId.trim()
  ) {
    throw new AccessJwksUnavailableError();
  }
  return { teamDomain, audience, clientId };
}

function accessJwksCache(
  fetchImplementation: typeof fetch,
  teamDomain: string,
): JWKSCacheInput {
  let byTeamDomain = accessJwksCaches.get(fetchImplementation);
  if (byTeamDomain === undefined) {
    byTeamDomain = new Map();
    accessJwksCaches.set(fetchImplementation, byTeamDomain);
  }
  let cache = byTeamDomain.get(teamDomain);
  if (cache === undefined) {
    cache = {};
    byTeamDomain.set(teamDomain, cache);
  }
  return cache;
}

export async function verifyCloudflareAccessPrincipal(
  request: Request,
  env: CloudflareAccessEnvironment,
  fetchImplementation: typeof fetch = fetch,
  parentSignal: AbortSignal = request.signal,
): Promise<CloudflareAccessPrincipalResult> {
  if (parentSignal.aborted) return { decision: 'unavailable' };
  let config: ReturnType<typeof accessConfiguration>;
  try {
    config = accessConfiguration(env);
  } catch {
    return { decision: 'unavailable' };
  }

  const assertion = request.headers.get(accessAssertionHeader);
  if (assertion === null || assertion.length < 32 || assertion.length > 16_384) {
    return { decision: 'denied' };
  }

  try {
    const jwks = createRemoteJWKSet(
      new URL(`https://${config.teamDomain}/cdn-cgi/access/certs`),
      {
        timeoutDuration: accessJwksTimeoutMs,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
        // Recreate the resolver so its custom fetch keeps this request's
        // cancellation signal, while the jose-managed JWKS bytes and refresh
        // timestamp persist safely across requests in the same isolate.
        [jwksCache]: accessJwksCache(
          fetchImplementation,
          config.teamDomain,
        ),
        [customFetch]: async (url, options) => {
          try {
            const jwksSignal = boundedSignal(
              parentSignal,
              accessJwksTimeoutMs,
              options.signal,
            );
            const response = await fetchImplementation(url, {
              ...options,
              // Cloudflare Workers implements "follow" and "manual", but not
              // the browser-only "error" mode. Keep redirects observable and
              // reject every 3xx through the response.ok check below.
              redirect: 'manual',
              signal: jwksSignal,
            });
            if (!response.ok) throw new AccessJwksUnavailableError();
            if (!contentTypeIsJson(response.headers)) {
              throw new AccessJwksUnavailableError();
            }
            const jwksPayload = plainRecord(await readBoundedStreamJson(
              response.clone().body,
              response.headers.get('content-length'),
              maximumAccessJwksResponseBytes,
              jwksSignal,
            ));
            const keys = Array.isArray(jwksPayload?.keys)
              ? jwksPayload.keys.map((candidate) => plainRecord(candidate))
              : [];
            if (
              jwksPayload === null
              || keys.length === 0
              || !keys.every((key) =>
                key !== null
                  && key.kty === 'RSA'
                  && key.alg === 'RS256'
                  && key.use === 'sig'
                  && typeof key.kid === 'string'
                  && /^[A-Za-z0-9_-]{1,256}$/.test(key.kid)
                  && typeof key.n === 'string'
                  && /^[A-Za-z0-9_-]{32,2048}$/.test(key.n)
                  && typeof key.e === 'string'
                  && /^[A-Za-z0-9_-]{1,16}$/.test(key.e))
              || new Set(keys.map((key) => key?.kid)).size !== keys.length
            ) {
              throw new AccessJwksUnavailableError();
            }
            await Promise.all(keys.map(
              (key) => importJWK(key as JWK, 'RS256'),
            ));
            return response;
          } catch (error) {
            if (error instanceof AccessJwksUnavailableError) throw error;
            throw new AccessJwksUnavailableError();
          }
        },
      },
    );
    const verified = await jwtVerify(assertion, jwks, {
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
      algorithms: ['RS256'],
      clockTolerance: 30,
      requiredClaims: ['iat', 'exp', 'iss', 'aud'],
    });
    // A fresh jose JWKS cache may satisfy verification without invoking the
    // custom fetch where cancellation is normally observed.
    if (parentSignal.aborted) return { decision: 'unavailable' };
    if (
      verified.protectedHeader.alg === 'RS256'
      && verified.payload.type === 'app'
      && verified.payload.sub === ''
      && verified.payload.common_name === config.clientId
      && Number.isSafeInteger(verified.payload.iat)
    ) {
      return {
        decision: 'authorized',
        principal: {
          type: 'service',
          clientId: config.clientId,
        },
      };
    }
    return { decision: 'denied' };
  } catch (error) {
    return {
      decision: error instanceof AccessJwksUnavailableError
        ? 'unavailable'
        : 'denied',
    };
  }
}

export async function verifyCloudflareAccessRequest(
  request: Request,
  env: CloudflareAccessEnvironment,
  fetchImplementation: typeof fetch = fetch,
  parentSignal: AbortSignal = request.signal,
): Promise<CloudflareAccessDecision> {
  return (
    await verifyCloudflareAccessPrincipal(
      request,
      env,
      fetchImplementation,
      parentSignal,
    )
  ).decision;
}
