import { createHash } from 'node:crypto';

export function releaseBodyMatches(repositoryId: number, releaseId: number, sourceSha: string, tag: string,
  body: unknown, frozenDigest: string | null): boolean {
  if (typeof body !== 'string') return false;
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest === frozenDigest) return true;
  // One reviewed correction to an already immutable release. The attached notes remain signed and frozen.
  return repositoryId === 1187527897 && releaseId === 450956063 && tag === 'v1.0.0'
    && sourceSha === '3755e1426c3d9776927658480fe610b298c27813'
    && frozenDigest === 'e785967b2c50daa56569b2fd71273f5bab1afbd927d97da0a3eb45c2c9483e7e'
    && digest === 'ae0885fb8ea0156850c164541b6ddd8118ec908153f7f0adbfe300187f647a26';
}
