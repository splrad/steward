import { utf8Bytes } from './encoding.js';
import { canonicalManifestJson } from './normalize.js';
import type { StewardManifest } from './types.js';

function lowercaseHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256HexUtf8(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', utf8Bytes(value));
  return lowercaseHex(digest);
}

export function digestCanonicalManifestJson(canonicalJson: string): Promise<string> {
  return sha256HexUtf8(canonicalJson);
}

export function manifestDigest(manifest: StewardManifest): Promise<string> {
  return digestCanonicalManifestJson(canonicalManifestJson(manifest));
}
