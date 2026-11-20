import { decodeBuildJson } from './build-manifest.js';
import { createHash } from 'node:crypto';

export const repositoryPolicyPath = 'configuration/repository.json';
export const repositoryPolicyBranch = 'steward/governance-state';
const workflow = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const pagesWorkflow = '.github/workflows/pages.yml';
const check = (condition: unknown) => { if (!condition) throw Error('REPOSITORY_POLICY_PROJECTION_INVALID'); };

export type RepositoryPolicySelection = {
  schemaVersion: 1;
  repositoryId: number;
  adoption: 'legacy' | 'paused' | 'central';
  productCi: string[];
  site: null | { workflow: string; mode: 'build-only' | 'build-and-deploy'; source: 'default-branch' | 'release'; unit?: string };
};

export function repositoryPolicyDigest(value: RepositoryPolicySelection): string {
  const site = value.site && [value.site.workflow, value.site.mode, value.site.source, value.site.unit ?? null];
  return createHash('sha256').update(JSON.stringify([value.schemaVersion, value.repositoryId, value.adoption, value.productCi, site])).digest('hex');
}

export function decodeRepositoryPolicyProjection(bytes: Uint8Array, repositoryId: number) {
  const value = decodeBuildJson(bytes) as RepositoryPolicySelection & { sourceDigest: string };
  check(value && Object.keys(value).sort().join(',') === 'adoption,productCi,repositoryId,schemaVersion,site,sourceDigest'
    && value.schemaVersion === 1 && Number.isSafeInteger(repositoryId) && repositoryId > 0 && value.repositoryId === repositoryId
    && ['legacy', 'paused', 'central'].includes(value.adoption) && Array.isArray(value.productCi)
    && new Set(value.productCi).size === value.productCi.length
    && value.productCi.every(path => typeof path === 'string' && path !== '.github/workflows/pr-validation-native.yml' && workflow.test(path)));
  if (value.site !== null) {
    const site = value.site;
    check(site && site.workflow === pagesWorkflow && ['build-only', 'build-and-deploy'].includes(site.mode)
      && ['default-branch', 'release'].includes(site.source)
      && Object.keys(site).sort().join(',') === (site.source === 'release' ? 'mode,source,unit,workflow' : 'mode,source,workflow')
      && (site.source !== 'release' || typeof site.unit === 'string' && /^[a-z][a-z0-9-]*$/.test(site.unit)));
  }
  check(value.sourceDigest === repositoryPolicyDigest(value));
  return value;
}
