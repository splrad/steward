// Historical frozen-record types and pure byte/identity helpers. No receipt creation or approval state machine.
import { type BuildManifest } from './build-manifest.js';
import { createHash } from 'node:crypto';

export const receiptDigest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function canonicalReleaseJson(value: unknown): string {
  const visit = (v: any): any => Array.isArray(v) ? v.map(visit) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, visit(v[k])])) : v;
  return JSON.stringify(visit(value)) + '\n';
}
export const releaseAssert: (condition: unknown, reason: string) => asserts condition = (condition, reason) => {
  if (!condition) throw new Error(`RN_RECEIPT_${reason}`);
};
export const releaseSha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
export const releaseDigest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const positiveId = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
export interface ReleaseAssetIdentity { name: string; size: number; sha256: string }
export interface FrozenRelease {
  repositoryId: number; fullName: string; defaultBranch: string; productTargetSha: string; productTree: string;
  policySha: string; targetTag: string; title: string; sourceDigest: string; evidenceDigest: string; templateDigest: string;
  boundary: { kind: 'full-tree' } | { kind: 'tag' | 'baseline'; sha: string; reference: string };
  assets: ReleaseAssetIdentity[];
  build: { runId: number; artifactId: number; artifactName: string; headSha: string } | null;
  toolchainDigest?: string;
  personalization?: { repositoryId: number; fullName: string; enabled: boolean; sections: { id: string; type: 'asset-table' | 'bullet-list'; slot: 'beforeActions' | 'afterChanges'; title: string; items: string[] }[]; digest: string };
  manifests: BuildManifest[];
  authorIds: number[]; contributors: { id: number; login: string }[];
  allowedLinks: string[]; compareUrl: string | null;
}
