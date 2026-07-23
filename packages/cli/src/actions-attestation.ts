import {
  ActionsAttestationValidationError,
  parseActionsAttestationEnvelope,
  parseSshEd25519PublicKey,
  parseSshSignature,
  verifyActionsAttestation,
  type ActionsAttestationEnvelopeV1,
} from '../../core/src/index.js';
import {
  fetchPullRequestPages,
  GitHubApiError,
  GitHubPaginationError,
  GitHubTransportError,
  type GitHubActionsExecutionProtections,
  type GitHubReadEvidence,
  type GitHubReadResult,
  type GitHubTransport,
  type GitHubUnknownReason,
} from '../../github/src/index.js';

interface GitHubIdentity {
  readonly login: string;
  readonly id: number;
}

interface GitHubOrganizationMembership {
  readonly state: string;
  readonly role: string;
  readonly user: GitHubIdentity;
}

interface GitHubSigningKey {
  readonly id: number;
  readonly key: string;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, subject: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${subject} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${subject} must be a positive integer`);
  }
  return Number(value);
}

function identity(value: unknown, subject: string): GitHubIdentity {
  const item = object(value, subject);
  return {
    login: nonEmptyString(item.login, `${subject}.login`),
    id: positiveInteger(item.id, `${subject}.id`),
  };
}

function membership(value: unknown): GitHubOrganizationMembership {
  const item = object(value, 'GitHub organization membership');
  return {
    state: nonEmptyString(item.state, 'GitHub organization membership.state'),
    role: nonEmptyString(item.role, 'GitHub organization membership.role'),
    user: identity(item.user, 'GitHub organization membership.user'),
  };
}

function signingKeys(value: unknown): readonly GitHubSigningKey[] {
  if (!Array.isArray(value)) throw new TypeError('GitHub SSH signing keys must be an array');
  return value.map((candidate, index) => {
    const item = object(candidate, `GitHub SSH signing key[${index}]`);
    return {
      id: positiveInteger(item.id, `GitHub SSH signing key[${index}].id`),
      key: nonEmptyString(item.key, `GitHub SSH signing key[${index}].key`),
    };
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function attestationEvidence(
  transport: GitHubTransport,
  envelope: ActionsAttestationEnvelopeV1 | undefined,
  observedAt: string,
  blockedEndpoint?: string,
): GitHubReadEvidence {
  const organization = envelope?.payload.organization;
  const login = envelope?.payload.attestor.login;
  const relatedEndpoints = organization && login
    ? [
      '/user',
      `/orgs/${segment(organization)}/memberships/${segment(login)}`,
      `/users/${segment(login)}/ssh_signing_keys`,
    ]
    : undefined;
  return {
    source: 'github-ui-attestation',
    endpoint: organization
      ? `https://github.com/organizations/${segment(organization)}/settings/actions/policies`
      : 'owner-signed-actions-attestation',
    observedAt,
    ...(transport.restApiVersion ? { apiVersion: transport.restApiVersion } : {}),
    ...(relatedEndpoints ? { relatedEndpoints } : {}),
    ...(blockedEndpoint ? { blockedEndpoint } : {}),
  };
}

function unknown(
  reason: GitHubUnknownReason,
  evidence: GitHubReadEvidence,
  options: {
    readonly httpStatus?: number;
    readonly retryable?: boolean;
    readonly retryAfterSeconds?: number;
    readonly requestId?: string;
  } = {},
): GitHubReadResult<never> {
  return { status: 'unknown', reason, evidence, ...options };
}

function requestFailure(
  error: unknown,
  transport: GitHubTransport,
  envelope: ActionsAttestationEnvelopeV1,
  observedAt: string,
  endpoint: string,
): GitHubReadResult<never> {
  const evidence = attestationEvidence(transport, envelope, observedAt, endpoint);
  if (error instanceof GitHubApiError) {
    if (error.rateLimited || error.status === 429) {
      return unknown('rate-limited', evidence, {
        httpStatus: error.status,
        retryable: true,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
        ...(error.requestId ? { requestId: error.requestId } : {}),
      });
    }
    if (error.status === 401 || error.status === 403) {
      return unknown('permission-denied', evidence, {
        httpStatus: error.status,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      });
    }
    if (error.status === 404) {
      return unknown('not-found-or-hidden', evidence, {
        httpStatus: 404,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      });
    }
    return unknown('api-error', evidence, {
      httpStatus: error.status,
      ...(error.status >= 500 ? { retryable: true } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
    });
  }
  if (error instanceof GitHubTransportError) {
    return unknown('api-error', evidence, { retryable: error.retryable });
  }
  if (error instanceof GitHubPaginationError) {
    return unknown('incomplete-pagination', evidence, { retryable: false });
  }
  if (error instanceof TypeError || error instanceof ActionsAttestationValidationError) {
    return unknown('invalid-response', evidence, { retryable: false });
  }
  throw error;
}

async function listSigningKeys(
  transport: GitHubTransport,
  endpoint: string,
): Promise<readonly GitHubSigningKey[]> {
  return await fetchPullRequestPages(async (page, pageSize) => signingKeys(
    await transport.request<unknown>({
      path: endpoint,
      query: { page, per_page: pageSize },
    }),
  ));
}

/**
 * Converts an owner-signed, UI-derived observation into a trusted Doctor fact.
 *
 * Trust requires one identity to satisfy all three bindings at verification
 * time: the diagnostic token principal, an active organization owner
 * membership, and a current GitHub SSH signing key that validates the SSHSIG.
 */
export async function verifyActionsExecutionProtectionAttestation(
  envelopeValue: unknown,
  transport: GitHubTransport,
  verifiedAt = new Date().toISOString(),
): Promise<GitHubReadResult<GitHubActionsExecutionProtections>> {
  let envelope: ActionsAttestationEnvelopeV1;
  try {
    envelope = parseActionsAttestationEnvelope(envelopeValue);
  } catch (error) {
    if (error instanceof ActionsAttestationValidationError) {
      return unknown(
        'invalid-response',
        attestationEvidence(transport, undefined, verifiedAt),
        { retryable: false },
      );
    }
    throw error;
  }

  const login = envelope.payload.attestor.login;
  const organization = envelope.payload.organization;
  const membershipEndpoint = `/orgs/${segment(organization)}/memberships/${segment(login)}`;
  const signingKeysEndpoint = `/users/${segment(login)}/ssh_signing_keys`;

  let authenticated: GitHubIdentity;
  let ownerMembership: GitHubOrganizationMembership;
  let keys: readonly GitHubSigningKey[];
  try {
    authenticated = identity(
      await transport.request<unknown>({ path: '/user' }),
      'GitHub authenticated user',
    );
  } catch (error) {
    return requestFailure(error, transport, envelope, verifiedAt, '/user');
  }
  try {
    ownerMembership = membership(await transport.request<unknown>({ path: membershipEndpoint }));
  } catch (error) {
    return requestFailure(error, transport, envelope, verifiedAt, membershipEndpoint);
  }
  try {
    keys = await listSigningKeys(transport, signingKeysEndpoint);
  } catch (error) {
    return requestFailure(error, transport, envelope, verifiedAt, signingKeysEndpoint);
  }

  const attestorMatches = authenticated.login.toLowerCase() === login.toLowerCase()
    && authenticated.id === envelope.payload.attestor.id
    && ownerMembership.user.login.toLowerCase() === login.toLowerCase()
    && ownerMembership.user.id === envelope.payload.attestor.id;
  if (
    !attestorMatches
    || ownerMembership.state !== 'active'
    || ownerMembership.role !== 'admin'
  ) {
    return unknown(
      'conflicting-observations',
      attestationEvidence(transport, envelope, verifiedAt),
      { retryable: false },
    );
  }

  const signaturePublicKey = parseSshSignature(envelope.signature).publicKey.blob;
  let registeredSigningKey: GitHubSigningKey | undefined;
  for (const candidate of keys) {
    if (!candidate.key.startsWith('ssh-ed25519 ')) continue;
    try {
      if (equalBytes(
        parseSshEd25519PublicKey(candidate.key).blob,
        signaturePublicKey,
      )) {
        registeredSigningKey = candidate;
        break;
      }
    } catch (error) {
      if (!(error instanceof ActionsAttestationValidationError)) throw error;
    }
  }
  if (registeredSigningKey === undefined) {
    return unknown(
      'conflicting-observations',
      attestationEvidence(transport, envelope, verifiedAt),
      { retryable: false },
    );
  }

  let signatureVerified: boolean;
  try {
    signatureVerified = await verifyActionsAttestation(envelope, registeredSigningKey.key);
  } catch (error) {
    if (!(error instanceof ActionsAttestationValidationError)) throw error;
    signatureVerified = false;
  }
  if (!signatureVerified) {
    return unknown(
      'conflicting-observations',
      attestationEvidence(transport, envelope, verifiedAt),
      { retryable: false },
    );
  }

  const payload = envelope.payload;
  return {
    status: 'known',
    value: {
      ...payload,
      schemaVersion: 1,
      verification: {
        method: 'github-ssh-signing-key',
        signingKeyId: registeredSigningKey.id,
        signingKeyAlgorithm: 'ssh-ed25519',
        authenticatedPrincipal: authenticated,
        organizationMembership: {
          state: 'active',
          role: 'admin',
        },
      },
    },
    evidence: attestationEvidence(transport, envelope, payload.observedAt),
  };
}
