import { createHash } from 'node:crypto';
import type { StewardManifest } from './types.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function normalizeManifest(manifest: StewardManifest): StewardManifest {
  const normalized = structuredClone(manifest);
  normalized.automation.githubApp.slug = normalized.automation.githubApp.slug.toLowerCase();
  if (normalized.automation.maintainers.source === 'organization-team') {
    normalized.automation.maintainers.teamSlug = normalized.automation.maintainers.teamSlug.toLowerCase();
  } else {
    normalized.automation.maintainers.logins = [...new Set(
      normalized.automation.maintainers.logins.map((login) => login.toLowerCase()),
    )].sort(compareText);
  }
  return canonicalize(normalized as unknown as JsonValue) as unknown as StewardManifest;
}

export function canonicalManifestJson(manifest: StewardManifest): string {
  return JSON.stringify(normalizeManifest(manifest));
}

export function digestCanonicalManifestJson(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

export function manifestDigest(manifest: StewardManifest): string {
  return digestCanonicalManifestJson(canonicalManifestJson(manifest));
}
