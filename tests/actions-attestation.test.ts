import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ActionsAttestationValidationError,
  canonicalActionsAttestationPayloadJson,
  parseActionsAttestationEnvelope,
  parseActionsAttestationPayload,
  parseSshEd25519PublicKey,
  parseSshSignature,
  STEWARD_ACTIONS_ATTESTATION_NAMESPACE,
  verifyActionsAttestation,
  type ActionsAttestationEnvelopeV1,
  type ActionsAttestationPayloadV1,
} from '../packages/core/src/actions-attestation.js';

const sshEd25519 = 'ssh-ed25519';
const sshSignatureMagic = Buffer.from('SSHSIG', 'ascii');

function sshString(value: string | Uint8Array): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'ascii') : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function rawEd25519PublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('Ed25519 JWK did not contain x');
  return Buffer.from(jwk.x, 'base64url');
}

function publicKeyBlob(publicKey: KeyObject, algorithm = sshEd25519): Buffer {
  return Buffer.concat([
    sshString(algorithm),
    sshString(rawEd25519PublicKey(publicKey)),
  ]);
}

function armor(bytes: Uint8Array): string {
  const body = Buffer.from(bytes).toString('base64').match(/.{1,70}/g)?.join('\n');
  if (!body) throw new Error('Cannot armor an empty signature');
  return `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----\n`;
}

function openSshPublicKey(publicKey: KeyObject): string {
  return `${sshEd25519} ${publicKeyBlob(publicKey).toString('base64')} owner@example.test`;
}

interface SignatureOptions {
  readonly hashAlgorithm?: 'sha256' | 'sha512';
  readonly namespace?: string;
  readonly reserved?: Uint8Array;
  readonly publicKeyAlgorithm?: string;
  readonly signatureAlgorithm?: string;
}

function sshsig(
  payload: ActionsAttestationPayloadV1,
  publicKey: KeyObject,
  privateKey: KeyObject,
  options: SignatureOptions = {},
): string {
  const hashAlgorithm = options.hashAlgorithm ?? 'sha512';
  const namespace = options.namespace ?? STEWARD_ACTIONS_ATTESTATION_NAMESPACE;
  const reserved = options.reserved ?? new Uint8Array();
  const messageDigest = createHash(hashAlgorithm)
    .update(canonicalActionsAttestationPayloadJson(payload))
    .digest();
  const signedData = Buffer.concat([
    sshSignatureMagic,
    sshString(namespace),
    sshString(reserved),
    sshString(hashAlgorithm),
    sshString(messageDigest),
  ]);
  const rawSignature = sign(null, signedData, privateKey);
  const signatureBlob = Buffer.concat([
    sshString(options.signatureAlgorithm ?? sshEd25519),
    sshString(rawSignature),
  ]);
  return armor(Buffer.concat([
    sshSignatureMagic,
    uint32(1),
    sshString(publicKeyBlob(publicKey, options.publicKeyAlgorithm)),
    sshString(namespace),
    sshString(reserved),
    sshString(hashAlgorithm),
    sshString(signatureBlob),
  ]));
}

function payload(): ActionsAttestationPayloadV1 {
  return {
    organization: 'splrad',
    repositoryId: 123456,
    repositoryFullName: 'splrad/example',
    propertyDigest: '1'.repeat(64),
    contractVersion: 's66-v2',
    contractDigest: '2'.repeat(64),
    inventoryVersion: 'actions-v1',
    inventoryDigest: '3'.repeat(64),
    policyDigest: '4'.repeat(64),
    mode: 'active',
    policyCount: 2,
    issuedAt: '2026-07-23T10:00:00.000Z',
    observedAt: '2026-07-23T09:59:30.000Z',
    expiresAt: '2026-07-23T10:15:00.000Z',
    nonce: '019f4f4f-40ad-7471-b40c-9838f254503c',
    attestor: {
      login: 'organization-owner',
      id: 987654,
    },
  };
}

function signedEnvelope(
  options: SignatureOptions = {},
): {
  readonly envelope: ActionsAttestationEnvelopeV1;
  readonly publicKey: string;
} {
  const pair = generateKeyPairSync('ed25519');
  const value = payload();
  return {
    envelope: {
      schemaVersion: 1,
      payload: value,
      signature: sshsig(value, pair.publicKey, pair.privateKey, options),
    },
    publicKey: openSshPublicKey(pair.publicKey),
  };
}

// Generated and independently verified with Windows OpenSSH ssh-keygen -Y
// sign/verify. It intentionally tests protocol interoperability, not the
// current policy digest or freshness.
const openSshFixturePayloadJson =
  '{"organization":"splrad","repositoryId":123456,"repositoryFullName":"splrad/example","propertyDigest":"1111111111111111111111111111111111111111111111111111111111111111","contractVersion":"s66-v2","contractDigest":"1ea41642eb3aefa0e780c4c8ce6c7556a055f7dc3fc61d1d2c120e57a1bd995d","inventoryVersion":"s66-actions-v1","inventoryDigest":"1b8109f7e3f9ddb52b8f3f4c40803fe93c6edce18cb5cbcf4b9331ab38141f8b","policyDigest":"c7b0e1a932722b25951c1e4782673d1f04deac930b84a2d7fd44d8dfad1e2ef7","mode":"active","policyCount":1,"issuedAt":"2026-07-23T10:00:00.000Z","observedAt":"2026-07-23T09:59:30.000Z","expiresAt":"2026-07-23T10:15:00.000Z","nonce":"019f4f4f-40ad-7471-b40c-9838f254503c","attestor":{"login":"fixture-owner","id":987654}}';
const openSshFixturePublicKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHbH6CjXQObt1/N9XAn/J9B7Rcb7bmKr92QUnwdQv6is steward-actions-attestation-fixture';
const openSshFixtureSignature = `-----BEGIN SSH SIGNATURE-----
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgdsfoKNdA5u3X831cCf8n0HtFxv
tuYqv3ZBSfB1C/qKwAAAAZc3BscmFkLXN0ZXdhcmQtYWN0aW9ucy92MQAAAAAAAAAGc2hh
NTEyAAAAUwAAAAtzc2gtZWQyNTUxOQAAAEBpNYWsIoz2SO0Ef1Ah/MBMP7hmyMEbFDhKGt
MsBnkYYaRJcmNasCVBTPM9l6XJ/VtwrJYxZQaz+MK3Fhyc3jUF
-----END SSH SIGNATURE-----
`;

describe('Actions owner attestation', () => {
  it('verifies a fixed SSHSIG produced by the independent OpenSSH implementation', async () => {
    const fixturePayload = JSON.parse(openSshFixturePayloadJson) as unknown;
    expect(canonicalActionsAttestationPayloadJson(fixturePayload))
      .toBe(openSshFixturePayloadJson);
    await expect(verifyActionsAttestation({
      schemaVersion: 1,
      payload: fixturePayload,
      signature: openSshFixtureSignature,
    }, openSshFixturePublicKey)).resolves.toBe(true);
  });

  it.each(['sha256', 'sha512'] as const)(
    'verifies a Node crypto Ed25519 SSHSIG using %s',
    async (hashAlgorithm) => {
      const fixture = signedEnvelope({ hashAlgorithm });
      expect(parseActionsAttestationEnvelope(fixture.envelope)).toEqual(fixture.envelope);
      expect(parseSshEd25519PublicKey(fixture.publicKey).raw).toHaveLength(32);
      expect(parseSshSignature(fixture.envelope.signature)).toMatchObject({ hashAlgorithm });
      await expect(verifyActionsAttestation(fixture.envelope, fixture.publicKey)).resolves.toBe(true);
    },
  );

  it('uses a fixed canonical payload field order and rejects unknown fields', () => {
    const value = payload();
    expect(canonicalActionsAttestationPayloadJson(value)).toBe(JSON.stringify(value));
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(canonicalActionsAttestationPayloadJson(reordered)).toBe(JSON.stringify(value));
    expect(() => parseActionsAttestationPayload({ ...value, futureField: true }))
      .toThrow(ActionsAttestationValidationError);

    const fixture = signedEnvelope();
    expect(() => parseActionsAttestationEnvelope({ ...fixture.envelope, futureField: true }))
      .toThrow(ActionsAttestationValidationError);
    expect(() => parseActionsAttestationPayload({
      ...value,
      attestor: { ...value.attestor, role: 'admin' },
    })).toThrow(ActionsAttestationValidationError);
  });

  it('returns false when a signed payload or expected public key is substituted', async () => {
    const fixture = signedEnvelope();
    await expect(verifyActionsAttestation({
      ...fixture.envelope,
      payload: { ...fixture.envelope.payload, policyCount: 3 },
    }, fixture.publicKey)).resolves.toBe(false);

    const other = generateKeyPairSync('ed25519');
    await expect(verifyActionsAttestation(
      fixture.envelope,
      openSshPublicKey(other.publicKey),
    )).resolves.toBe(false);
  });

  it('rejects the wrong namespace, non-empty reserved field, and non-Ed25519 algorithms', () => {
    expect(() => parseActionsAttestationEnvelope(
      signedEnvelope({ namespace: 'file' }).envelope,
    )).toThrow(/namespace/);
    expect(() => parseActionsAttestationEnvelope(
      signedEnvelope({ reserved: Uint8Array.of(1) }).envelope,
    )).toThrow(/reserved/);
    expect(() => parseActionsAttestationEnvelope(
      signedEnvelope({ publicKeyAlgorithm: 'ssh-rsa' }).envelope,
    )).toThrow(/ssh-ed25519/);
    expect(() => parseActionsAttestationEnvelope(
      signedEnvelope({ signatureAlgorithm: 'rsa-sha2-512' }).envelope,
    )).toThrow(/ssh-ed25519/);
    expect(() => parseSshEd25519PublicKey(
      `ssh-rsa ${Buffer.from('not-an-ed25519-key').toString('base64')}`,
    )).toThrow(/ssh-ed25519/);
  });

  it('rejects URL-safe or missing-padding base64 and trailing SSHSIG bytes', () => {
    const fixture = signedEnvelope();
    const urlSafe = fixture.envelope.signature.replace(
      /(?<=\n)[A-Za-z0-9+/]/,
      '-',
    );
    expect(urlSafe).not.toBe(fixture.envelope.signature);
    expect(() => parseSshSignature(urlSafe)).toThrow(/base64/);

    const oneTrailingByte = Buffer.concat([
      Buffer.from(
        fixture.envelope.signature
          .split('\n')
          .slice(1, -2)
          .join(''),
        'base64',
      ),
      Buffer.of(0),
    ]);
    const paddedArmor = armor(oneTrailingByte);
    expect(() => parseSshSignature(paddedArmor)).toThrow(/trailing bytes/);
    expect(() => parseSshSignature(paddedArmor.replace(/=+(?=\n-----END)/, '')))
      .toThrow(/padded standard base64/);
  });

  it('rejects malformed payload values without applying freshness policy', () => {
    const value = payload();
    expect(() => parseActionsAttestationPayload({
      ...value,
      observedAt: '2026-02-30T10:00:00Z',
    })).toThrow(/RFC 3339/);
    expect(() => parseActionsAttestationPayload({
      ...value,
      repositoryFullName: 'other/example',
    })).toThrow(/payload.organization/);
    expect(() => parseActionsAttestationPayload({
      ...value,
      nonce: '   ',
    })).toThrow(/nonce/);
    expect(() => parseActionsAttestationPayload({
      ...value,
      nonce: 'too-short',
    })).toThrow(/16-128/);

    expect(parseActionsAttestationPayload({
      ...value,
      issuedAt: '2000-01-01T00:00:00Z',
      expiresAt: '2000-01-01T00:00:01Z',
    })).toMatchObject({ issuedAt: '2000-01-01T00:00:00Z' });
  });
});
