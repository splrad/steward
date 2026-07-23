export const STEWARD_ACTIONS_ATTESTATION_SCHEMA_VERSION = 1 as const;
// The schema version is cryptographically bound through the SSHSIG namespace.
// A future envelope schema must use a new namespace and verifier path.
export const STEWARD_ACTIONS_ATTESTATION_NAMESPACE = 'splrad-steward-actions/v1' as const;

const sshEd25519 = 'ssh-ed25519';
const sshSignatureMagic = 'SSHSIG';
const digestPattern = /^[0-9a-f]{64}$/;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/;
const noncePattern = /^[A-Za-z0-9._:-]{16,128}$/;
const rfc3339Pattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const utf8Encoder = new TextEncoder();

export interface ActionsAttestationPayloadV1 {
  readonly organization: string;
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly propertyDigest: string;
  readonly contractVersion: string;
  readonly contractDigest: string;
  readonly inventoryVersion: string;
  readonly inventoryDigest: string;
  readonly policyDigest: string;
  readonly mode: 'evaluate' | 'active';
  readonly policyCount: number;
  readonly issuedAt: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly attestor: {
    readonly login: string;
    readonly id: number;
  };
}

export interface ActionsAttestationEnvelopeV1 {
  readonly schemaVersion: typeof STEWARD_ACTIONS_ATTESTATION_SCHEMA_VERSION;
  readonly payload: ActionsAttestationPayloadV1;
  readonly signature: string;
}

export interface ParsedSshEd25519PublicKey {
  readonly blob: Uint8Array<ArrayBuffer>;
  readonly raw: Uint8Array<ArrayBuffer>;
}

export interface ParsedSshSignature {
  readonly publicKey: ParsedSshEd25519PublicKey;
  readonly hashAlgorithm: 'sha256' | 'sha512';
  readonly signature: Uint8Array<ArrayBuffer>;
}

export class ActionsAttestationValidationError extends Error {
  constructor(message: string) {
    super(`Invalid Actions attestation: ${message}`);
    this.name = 'ActionsAttestationValidationError';
  }
}

function invalid(message: string): never {
  throw new ActionsAttestationValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  subject: string,
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length
    || actual.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    invalid(`${subject} contains missing or unknown fields`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  return value;
}

function requireNonEmptyText(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!text || text !== text.trim() || /[\u0000-\u001f\u007f]/.test(text)) {
    invalid(`${field} must be canonical non-empty text without control characters`);
  }
  return text;
}

function requirePositiveId(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireString(value, field);
  if (!digestPattern.test(digest)) invalid(`${field} must be a lowercase SHA-256 digest`);
  return digest;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function requireRfc3339(value: unknown, field: string): string {
  const timestamp = requireString(value, field);
  const match = rfc3339Pattern.exec(timestamp);
  if (!match) invalid(`${field} must be an RFC 3339 timestamp`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[7]!;
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 60
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    invalid(`${field} must be an RFC 3339 timestamp`);
  }
  return timestamp;
}

function requireGitHubLogin(value: unknown, field: string): string {
  const login = requireString(value, field);
  if (!githubLoginPattern.test(login)) invalid(`${field} must be a canonical GitHub login`);
  return login;
}

function parseRepositoryFullName(value: unknown, organization: string): string {
  const fullName = requireString(value, 'payload.repositoryFullName');
  const parts = fullName.split('/');
  if (
    parts.length !== 2
    || parts[0]?.toLowerCase() !== organization.toLowerCase()
    || !repositoryNamePattern.test(parts[1] ?? '')
  ) {
    invalid('payload.repositoryFullName must bind a repository in payload.organization');
  }
  return fullName;
}

export function parseActionsAttestationPayload(value: unknown): ActionsAttestationPayloadV1 {
  if (!isRecord(value)) invalid('payload must be an object');
  requireExactKeys(value, [
    'organization',
    'repositoryId',
    'repositoryFullName',
    'propertyDigest',
    'contractVersion',
    'contractDigest',
    'inventoryVersion',
    'inventoryDigest',
    'policyDigest',
    'mode',
    'policyCount',
    'issuedAt',
    'observedAt',
    'expiresAt',
    'nonce',
    'attestor',
  ], 'payload');

  const organization = requireGitHubLogin(value.organization, 'payload.organization');
  const mode = value.mode;
  if (mode !== 'evaluate' && mode !== 'active') {
    invalid('payload.mode must be "evaluate" or "active"');
  }
  if (!Number.isSafeInteger(value.policyCount) || Number(value.policyCount) < 0) {
    invalid('payload.policyCount must be a non-negative safe integer');
  }
  if (!isRecord(value.attestor)) invalid('payload.attestor must be an object');
  requireExactKeys(value.attestor, ['login', 'id'], 'payload.attestor');

  return {
    organization,
    repositoryId: requirePositiveId(value.repositoryId, 'payload.repositoryId'),
    repositoryFullName: parseRepositoryFullName(value.repositoryFullName, organization),
    propertyDigest: requireDigest(value.propertyDigest, 'payload.propertyDigest'),
    contractVersion: requireNonEmptyText(value.contractVersion, 'payload.contractVersion'),
    contractDigest: requireDigest(value.contractDigest, 'payload.contractDigest'),
    inventoryVersion: requireNonEmptyText(value.inventoryVersion, 'payload.inventoryVersion'),
    inventoryDigest: requireDigest(value.inventoryDigest, 'payload.inventoryDigest'),
    policyDigest: requireDigest(value.policyDigest, 'payload.policyDigest'),
    mode,
    policyCount: Number(value.policyCount),
    issuedAt: requireRfc3339(value.issuedAt, 'payload.issuedAt'),
    observedAt: requireRfc3339(value.observedAt, 'payload.observedAt'),
    expiresAt: requireRfc3339(value.expiresAt, 'payload.expiresAt'),
    nonce: (() => {
      const nonce = requireNonEmptyText(value.nonce, 'payload.nonce');
      if (!noncePattern.test(nonce)) {
        invalid('payload.nonce must be 16-128 canonical ASCII identifier characters');
      }
      return nonce;
    })(),
    attestor: {
      login: requireGitHubLogin(value.attestor.login, 'payload.attestor.login'),
      id: requirePositiveId(value.attestor.id, 'payload.attestor.id'),
    },
  };
}

export function canonicalActionsAttestationPayloadJson(value: unknown): string {
  const payload = parseActionsAttestationPayload(value);
  return JSON.stringify({
    organization: payload.organization,
    repositoryId: payload.repositoryId,
    repositoryFullName: payload.repositoryFullName,
    propertyDigest: payload.propertyDigest,
    contractVersion: payload.contractVersion,
    contractDigest: payload.contractDigest,
    inventoryVersion: payload.inventoryVersion,
    inventoryDigest: payload.inventoryDigest,
    policyDigest: payload.policyDigest,
    mode: payload.mode,
    policyCount: payload.policyCount,
    issuedAt: payload.issuedAt,
    observedAt: payload.observedAt,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
    attestor: {
      login: payload.attestor.login,
      id: payload.attestor.id,
    },
  });
}

function canonicalBase64Bytes(value: string, subject: string): Uint8Array<ArrayBuffer> {
  if (
    !value
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    invalid(`${subject} must use canonical padded standard base64`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return invalid(`${subject} must use canonical padded standard base64`);
  }
  if (btoa(binary) !== value) {
    invalid(`${subject} must use canonical padded standard base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function asciiBytes(value: string): Uint8Array<ArrayBuffer> {
  return utf8Encoder.encode(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

class SshReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array<ArrayBuffer>) {}

  readBytes(length: number, subject: string): Uint8Array<ArrayBuffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.offset) {
      invalid(`${subject} is truncated`);
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readUint32(subject: string): number {
    const bytes = this.readBytes(4, subject);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  }

  readString(subject: string): Uint8Array<ArrayBuffer> {
    return this.readBytes(this.readUint32(`${subject} length`), subject);
  }

  expectEnd(subject: string): void {
    if (this.offset !== this.bytes.length) invalid(`${subject} contains trailing bytes`);
  }
}

function requireAsciiBytes(value: Uint8Array, expected: string, subject: string): void {
  if (!equalBytes(value, asciiBytes(expected))) invalid(`${subject} must be "${expected}"`);
}

function parseEd25519KeyBlob(
  blob: Uint8Array<ArrayBuffer>,
  subject: string,
): ParsedSshEd25519PublicKey {
  const reader = new SshReader(blob);
  requireAsciiBytes(reader.readString(`${subject} algorithm`), sshEd25519, `${subject} algorithm`);
  const raw = reader.readString(`${subject} key`);
  if (raw.length !== 32) invalid(`${subject} must contain a 32-byte Ed25519 key`);
  reader.expectEnd(subject);
  return { blob: blob.slice(), raw };
}

export function parseSshEd25519PublicKey(value: unknown): ParsedSshEd25519PublicKey {
  const text = requireString(value, 'public key');
  if (text !== text.trim() || text.includes('\r') || text.includes('\n') || text.includes('\t')) {
    invalid('public key must be one canonical OpenSSH line');
  }
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: ([^\u0000-\u001f\u007f]+))?$/.exec(text);
  if (!match) invalid('public key must use ssh-ed25519 OpenSSH format');
  return parseEd25519KeyBlob(
    canonicalBase64Bytes(match[1]!, 'public key blob'),
    'public key blob',
  );
}

function armorBody(value: unknown): Uint8Array<ArrayBuffer> {
  const text = requireString(value, 'signature');
  if (text.includes('\r') && text.replaceAll('\r\n', '').includes('\r')) {
    invalid('signature armor contains invalid line endings');
  }
  const withoutFinalNewline = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = withoutFinalNewline.split(text.includes('\r\n') ? '\r\n' : '\n');
  if (
    lines.length < 3
    || lines[0] !== '-----BEGIN SSH SIGNATURE-----'
    || lines.at(-1) !== '-----END SSH SIGNATURE-----'
  ) {
    invalid('signature must use OpenSSH SSHSIG armor');
  }
  const bodyLines = lines.slice(1, -1);
  if (
    bodyLines.some((line) => !line || !/^[A-Za-z0-9+/]*={0,2}$/.test(line))
    || bodyLines.slice(0, -1).some((line) => line.includes('='))
  ) {
    invalid('signature armor body is not canonical base64');
  }
  return canonicalBase64Bytes(bodyLines.join(''), 'signature armor body');
}

export function parseSshSignature(value: unknown): ParsedSshSignature {
  const reader = new SshReader(armorBody(value));
  requireAsciiBytes(
    reader.readBytes(sshSignatureMagic.length, 'SSHSIG magic'),
    sshSignatureMagic,
    'SSHSIG magic',
  );
  const version = reader.readUint32('SSHSIG version');
  if (version !== 1) invalid('SSHSIG version must be 1');

  const publicKey = parseEd25519KeyBlob(reader.readString('SSHSIG public key'), 'SSHSIG public key');
  requireAsciiBytes(
    reader.readString('SSHSIG namespace'),
    STEWARD_ACTIONS_ATTESTATION_NAMESPACE,
    'SSHSIG namespace',
  );
  if (reader.readString('SSHSIG reserved').length !== 0) {
    invalid('SSHSIG reserved field must be empty');
  }

  const hashAlgorithmBytes = reader.readString('SSHSIG hash algorithm');
  let hashAlgorithm: 'sha256' | 'sha512';
  if (equalBytes(hashAlgorithmBytes, asciiBytes('sha256'))) hashAlgorithm = 'sha256';
  else if (equalBytes(hashAlgorithmBytes, asciiBytes('sha512'))) hashAlgorithm = 'sha512';
  else invalid('SSHSIG hash algorithm must be sha256 or sha512');

  const signatureReader = new SshReader(reader.readString('SSHSIG signature'));
  requireAsciiBytes(
    signatureReader.readString('SSHSIG signature algorithm'),
    sshEd25519,
    'SSHSIG signature algorithm',
  );
  const signature = signatureReader.readString('SSHSIG Ed25519 signature');
  if (signature.length !== 64) invalid('SSHSIG Ed25519 signature must contain 64 bytes');
  signatureReader.expectEnd('SSHSIG signature');
  reader.expectEnd('SSHSIG');
  return { publicKey, hashAlgorithm, signature };
}

export function parseActionsAttestationEnvelope(value: unknown): ActionsAttestationEnvelopeV1 {
  if (!isRecord(value)) invalid('envelope must be an object');
  requireExactKeys(value, ['schemaVersion', 'payload', 'signature'], 'envelope');
  if (value.schemaVersion !== STEWARD_ACTIONS_ATTESTATION_SCHEMA_VERSION) {
    invalid('envelope.schemaVersion must be 1');
  }
  const payload = parseActionsAttestationPayload(value.payload);
  const signature = requireString(value.signature, 'envelope.signature');
  parseSshSignature(signature);
  return {
    schemaVersion: STEWARD_ACTIONS_ATTESTATION_SCHEMA_VERSION,
    payload,
    signature,
  };
}

function sshString(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(4 + value.length);
  new DataView(result.buffer).setUint32(0, value.length, false);
  result.set(value, 4);
  return result;
}

function concatenate(values: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

export async function verifyActionsAttestation(
  envelopeValue: unknown,
  publicKeyValue: unknown,
): Promise<boolean> {
  const envelope = parseActionsAttestationEnvelope(envelopeValue);
  const expectedPublicKey = parseSshEd25519PublicKey(publicKeyValue);
  const sshSignature = parseSshSignature(envelope.signature);
  if (!equalBytes(sshSignature.publicKey.blob, expectedPublicKey.blob)) return false;

  const message = utf8Encoder.encode(canonicalActionsAttestationPayloadJson(envelope.payload));
  const webHashAlgorithm = sshSignature.hashAlgorithm === 'sha256' ? 'SHA-256' : 'SHA-512';
  const messageDigest = new Uint8Array(
    await globalThis.crypto.subtle.digest(webHashAlgorithm, message),
  );
  const signedData = concatenate([
    asciiBytes(sshSignatureMagic),
    sshString(asciiBytes(STEWARD_ACTIONS_ATTESTATION_NAMESPACE)),
    sshString(new Uint8Array()),
    sshString(asciiBytes(sshSignature.hashAlgorithm)),
    sshString(messageDigest),
  ]);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    expectedPublicKey.raw,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return globalThis.crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    sshSignature.signature,
    signedData,
  );
}
