import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalActionsAttestationPayloadJson,
  STEWARD_ACTIONS_ATTESTATION_NAMESPACE,
  type ActionsAttestationEnvelopeV1,
  type ActionsAttestationPayloadV1,
} from '../packages/core/src/index.js';
import { verifyActionsExecutionProtectionAttestation } from '../packages/cli/src/actions-attestation.js';
import {
  MAX_ACTIONS_ATTESTATION_BYTES,
  readActionsAttestationFile,
  type OpenActionsAttestationFile,
} from '../packages/cli/src/main.js';
import {
  GitHubApiError,
  type GitHubRequest,
  type GitHubTransport,
} from '../packages/github/src/index.js';

const sshEd25519 = 'ssh-ed25519';
const sshSignatureMagic = Buffer.from('SSHSIG', 'ascii');

function sshString(value: string | Uint8Array): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'ascii') : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function rawPublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('Ed25519 JWK is missing x');
  return Buffer.from(jwk.x, 'base64url');
}

function publicKeyBlob(publicKey: KeyObject): Buffer {
  return Buffer.concat([sshString(sshEd25519), sshString(rawPublicKey(publicKey))]);
}

function publicKeyLine(publicKey: KeyObject): string {
  return `${sshEd25519} ${publicKeyBlob(publicKey).toString('base64')} owner@example.test`;
}

function signature(
  payload: ActionsAttestationPayloadV1,
  publicKey: KeyObject,
  privateKey: KeyObject,
): string {
  const digest = createHash('sha512')
    .update(canonicalActionsAttestationPayloadJson(payload))
    .digest();
  const signedData = Buffer.concat([
    sshSignatureMagic,
    sshString(STEWARD_ACTIONS_ATTESTATION_NAMESPACE),
    sshString(new Uint8Array()),
    sshString('sha512'),
    sshString(digest),
  ]);
  const rawSignature = sign(null, signedData, privateKey);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const binary = Buffer.concat([
    sshSignatureMagic,
    version,
    sshString(publicKeyBlob(publicKey)),
    sshString(STEWARD_ACTIONS_ATTESTATION_NAMESPACE),
    sshString(new Uint8Array()),
    sshString('sha512'),
    sshString(Buffer.concat([sshString(sshEd25519), sshString(rawSignature)])),
  ]);
  const body = binary.toString('base64').match(/.{1,70}/g)?.join('\n');
  if (!body) throw new Error('Cannot armor signature');
  return `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----\n`;
}

function fixture(): {
  readonly envelope: ActionsAttestationEnvelopeV1;
  readonly publicKey: string;
} {
  const pair = generateKeyPairSync('ed25519');
  const payload: ActionsAttestationPayloadV1 = {
    organization: 'splrad',
    repositoryId: 7,
    repositoryFullName: 'splrad/example',
    propertyDigest: '1'.repeat(64),
    contractVersion: 's66-v2',
    contractDigest: '2'.repeat(64),
    inventoryVersion: 's66-actions-v1',
    inventoryDigest: '3'.repeat(64),
    policyDigest: '4'.repeat(64),
    mode: 'active',
    policyCount: 1,
    issuedAt: '2026-07-23T10:00:00.000Z',
    observedAt: '2026-07-23T09:59:30.000Z',
    expiresAt: '2026-07-23T10:15:00.000Z',
    nonce: '019f4f4f-40ad-7471-b40c-9838f254503c',
    attestor: { login: 'organization-owner', id: 42 },
  };
  return {
    envelope: {
      schemaVersion: 1,
      payload,
      signature: signature(payload, pair.publicKey, pair.privateKey),
    },
    publicKey: publicKeyLine(pair.publicKey),
  };
}

function transport(
  key: string,
  overrides: Partial<Record<string, unknown>> = {},
): { readonly value: GitHubTransport; readonly requests: GitHubRequest[] } {
  const requests: GitHubRequest[] = [];
  return {
    requests,
    value: {
      restApiVersion: '2026-03-10',
      async request<T>(request: GitHubRequest): Promise<T> {
        requests.push(structuredClone(request));
        const hasOverride = Object.prototype.hasOwnProperty.call(overrides, request.path);
        const override = hasOverride ? overrides[request.path] : undefined;
        const response = hasOverride
          ? typeof override === 'function'
            ? await (override as (current: GitHubRequest) => unknown)(request)
            : override
          : request.path === '/user'
            ? { login: 'organization-owner', id: 42 }
            : request.path === '/orgs/splrad/memberships/organization-owner'
              ? {
                state: 'active',
                role: 'admin',
                user: { login: 'organization-owner', id: 42 },
              }
              : request.path === '/users/organization-owner/ssh_signing_keys'
                ? [{ id: 9, key }]
                : undefined;
        if (response === undefined) throw new Error(`Unexpected request ${request.path}`);
        if (response instanceof Error) throw response;
        return structuredClone(response) as T;
      },
    },
  };
}

function chunkedFile(
  contents: Buffer,
  chunkSize: number,
): {
  readonly openFile: OpenActionsAttestationFile;
  readonly positions: number[];
  readonly closed: () => boolean;
} {
  const positions: number[] = [];
  let closed = false;
  return {
    positions,
    closed: () => closed,
    async openFile() {
      return {
        async read(buffer, offset, length, position) {
          positions.push(position);
          const bytesRead = Math.min(
            chunkSize,
            length,
            Math.max(0, contents.length - position),
          );
          if (bytesRead > 0) {
            contents.copy(buffer, offset, position, position + bytesRead);
          }
          return { bytesRead };
        },
        async close() {
          closed = true;
        },
      };
    },
  };
}

describe('CLI Actions attestation file reader', () => {
  it('continues after short reads until the complete JSON reaches EOF', async () => {
    const current = chunkedFile(Buffer.from('{"schemaVersion":1}', 'utf8'), 3);

    await expect(readActionsAttestationFile('actions.json', current.openFile))
      .resolves.toEqual({ schemaVersion: 1 });
    expect(current.positions.length).toBeGreaterThan(2);
    expect(current.positions.at(-1)).toBe(19);
    expect(current.closed()).toBe(true);
  });

  it('rejects the first byte beyond the limit even when every read is short', async () => {
    const current = chunkedFile(
      Buffer.alloc(MAX_ACTIONS_ATTESTATION_BYTES + 1, 0x20),
      4_097,
    );

    await expect(readActionsAttestationFile('actions.json', current.openFile))
      .rejects.toThrow(`exceeds ${MAX_ACTIONS_ATTESTATION_BYTES} bytes`);
    expect(current.positions.length).toBeGreaterThan(2);
    expect(current.closed()).toBe(true);
  });
});

describe('CLI Actions owner attestation verifier', () => {
  it('requires one current GitHub identity to be token principal, active owner, and signer', async () => {
    const current = fixture();
    const github = transport(current.publicKey);
    const result = await verifyActionsExecutionProtectionAttestation(
      current.envelope,
      github.value,
      '2026-07-23T10:00:00.000Z',
    );

    expect(result).toMatchObject({
      status: 'known',
      value: {
        attestor: { login: 'organization-owner', id: 42 },
        verification: {
          method: 'github-ssh-signing-key',
          signingKeyId: 9,
          authenticatedPrincipal: { login: 'organization-owner', id: 42 },
          organizationMembership: { state: 'active', role: 'admin' },
        },
      },
      evidence: {
        source: 'github-ui-attestation',
        observedAt: current.envelope.payload.observedAt,
        relatedEndpoints: [
          '/user',
          '/orgs/splrad/memberships/organization-owner',
          '/users/organization-owner/ssh_signing_keys',
        ],
      },
    });
    expect(github.requests.every(({ method }) => !method || method === 'GET')).toBe(true);
  });

  it.each([
    {
      name: 'different authenticated principal',
      overrides: { '/user': { login: 'other-owner', id: 99 } },
    },
    {
      name: 'non-owner membership',
      overrides: {
        '/orgs/splrad/memberships/organization-owner': {
          state: 'active',
          role: 'member',
          user: { login: 'organization-owner', id: 42 },
        },
      },
    },
    {
      name: 'inactive owner membership',
      overrides: {
        '/orgs/splrad/memberships/organization-owner': {
          state: 'pending',
          role: 'admin',
          user: { login: 'organization-owner', id: 42 },
        },
      },
    },
    {
      name: 'membership for a different numeric identity',
      overrides: {
        '/orgs/splrad/memberships/organization-owner': {
          state: 'active',
          role: 'admin',
          user: { login: 'organization-owner', id: 43 },
        },
      },
    },
  ])('keeps $name unknown', async ({ overrides }) => {
    const current = fixture();
    const github = transport(current.publicKey, overrides);
    await expect(verifyActionsExecutionProtectionAttestation(
      current.envelope,
      github.value,
      '2026-07-23T10:00:00.000Z',
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'conflicting-observations',
      retryable: false,
    });
  });

  it('finds the signing key on a later complete page', async () => {
    const current = fixture();
    const filler = Array.from({ length: 100 }, (_, index) => ({
      id: 1_000 + index,
      key: 'ssh-rsa AAAA',
    }));
    const github = transport(current.publicKey, {
      '/users/organization-owner/ssh_signing_keys': (request: GitHubRequest) => (
        request.query?.page === 1 ? filler : [{ id: 9, key: current.publicKey }]
      ),
    });

    await expect(verifyActionsExecutionProtectionAttestation(
      current.envelope,
      github.value,
      '2026-07-23T10:00:00.000Z',
    )).resolves.toMatchObject({
      status: 'known',
      value: {
        verification: { signingKeyId: 9 },
      },
    });
    expect(github.requests
      .filter(({ path }) => path === '/users/organization-owner/ssh_signing_keys')
      .map(({ query }) => query?.page)).toEqual([1, 2]);
  });

  it('selects the SSHSIG embedded key from multiple registered Ed25519 keys', async () => {
    const current = fixture();
    const otherA = fixture();
    const otherB = fixture();
    const github = transport(current.publicKey, {
      '/users/organization-owner/ssh_signing_keys': [
        { id: 10, key: otherA.publicKey },
        { id: 11, key: otherB.publicKey },
        { id: 9, key: current.publicKey },
      ],
    });

    await expect(verifyActionsExecutionProtectionAttestation(
      current.envelope,
      github.value,
      '2026-07-23T10:00:00.000Z',
    )).resolves.toMatchObject({
      status: 'known',
      value: {
        verification: { signingKeyId: 9 },
      },
    });
  });

  it('fails closed when the signing-key inventory never reaches a terminal page', async () => {
    const current = fixture();
    const github = transport(current.publicKey, {
      '/users/organization-owner/ssh_signing_keys': (request: GitHubRequest) => (
        Array.from({ length: 100 }, (_, index) => ({
          id: Number(request.query?.page) * 100 + index + 1,
          key: 'ssh-rsa AAAA',
        }))
      ),
    });

    await expect(verifyActionsExecutionProtectionAttestation(
      current.envelope,
      github.value,
      '2026-07-23T10:00:00.000Z',
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'incomplete-pagination',
      retryable: false,
    });
    expect(github.requests
      .filter(({ path }) => path === '/users/organization-owner/ssh_signing_keys'))
      .toHaveLength(30);
  });

  it('preserves a later signing-key page failure as unknown evidence', async () => {
    const current = fixture();
    const unavailable = new GitHubApiError({
      status: 503,
      method: 'GET',
      path: '/users/organization-owner/ssh_signing_keys',
      message: 'Service unavailable',
    });
    const github = transport(current.publicKey, {
      '/users/organization-owner/ssh_signing_keys': (request: GitHubRequest) => (
        request.query?.page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
            id: 1_000 + index,
            key: 'ssh-rsa AAAA',
          }))
          : unavailable
      ),
    });

    await expect(verifyActionsExecutionProtectionAttestation(
      current.envelope,
      github.value,
      '2026-07-23T10:00:00.000Z',
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'api-error',
      httpStatus: 503,
      retryable: true,
      evidence: {
        blockedEndpoint: '/users/organization-owner/ssh_signing_keys',
      },
    });
  });

  it('keeps an envelope signed by an unregistered key unknown', async () => {
    const current = fixture();
    const other = fixture();
    const github = transport(other.publicKey);
    await expect(verifyActionsExecutionProtectionAttestation(
      current.envelope,
      github.value,
      '2026-07-23T10:00:00.000Z',
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'conflicting-observations',
    });
  });

  it('maps GitHub owner-read denial to permission-denied evidence', async () => {
    const current = fixture();
    const denied = new GitHubApiError({
      status: 403,
      method: 'GET',
      path: '/orgs/splrad/memberships/organization-owner',
      message: 'Resource not accessible',
    });
    const github = transport(current.publicKey, {
      '/orgs/splrad/memberships/organization-owner': denied,
    });
    await expect(verifyActionsExecutionProtectionAttestation(
      current.envelope,
      github.value,
      '2026-07-23T10:00:00.000Z',
    )).resolves.toMatchObject({
      status: 'unknown',
      reason: 'permission-denied',
      httpStatus: 403,
      evidence: {
        blockedEndpoint: '/orgs/splrad/memberships/organization-owner',
      },
    });
  });

  it('rejects malformed envelopes without making GitHub requests', async () => {
    const github = transport('unused');
    const result = await verifyActionsExecutionProtectionAttestation(
      { schemaVersion: 1 },
      github.value,
      '2026-07-23T10:00:00.000Z',
    );
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'invalid-response',
      retryable: false,
    });
    expect(github.requests).toEqual([]);
  });
});
