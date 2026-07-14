const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', {
  fatal: true,
  // For TextDecoder, true includes a leading BOM code point in the decoded text.
  ignoreBOM: true,
});
const binaryChunkSize = 0x8000;

export interface Base64DecodeOptions {
  allowUrlSafe?: boolean;
  allowUnpadded?: boolean;
}

export function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(utf8Encoder.encode(value));
}

function binaryFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += binaryChunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + binaryChunkSize));
  }
  return binary;
}

function invalidBase64(): never {
  throw new TypeError('Invalid base64 text');
}

export function encodeBase64Utf8(value: string): string {
  return btoa(binaryFromBytes(utf8Bytes(value)));
}

export function decodeBase64Utf8(value: string, options: Base64DecodeOptions = {}): string {
  const compact = value.replaceAll(/\s/g, '');
  const alphabet = options.allowUrlSafe
    ? /^[A-Za-z0-9+/_-]*={0,2}$/
    : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!compact) return '';
  if (!alphabet.test(compact)) invalidBase64();

  let normalized = compact.replaceAll('-', '+').replaceAll('_', '/');
  if (normalized.includes('=')) {
    if (normalized.length % 4 !== 0) invalidBase64();
  } else {
    const remainder = normalized.length % 4;
    if (remainder !== 0) {
      if (!options.allowUnpadded || remainder === 1) invalidBase64();
      normalized += '='.repeat(4 - remainder);
    }
  }

  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    return invalidBase64();
  }
  if (btoa(binary) !== normalized) invalidBase64();

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new TypeError('Invalid UTF-8 text');
  }
}
