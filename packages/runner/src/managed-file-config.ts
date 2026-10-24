import { safeManagedPath, type SourceRule } from './managed-sync-preview.js';

type ConfiguredRule = Omit<SourceRule, 'sourceSha'> & { sourceSha?: string };
export interface ManagedFileConfig { schemaVersion: 1; repositories: Record<string, ConfiguredRule[]> }
function fail(): never { throw new Error('MANAGED_FILE_CONFIG: invalid ownership or source contract'); }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(value: Record<string, any>, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail();
}
/** The policy owns paths and renderers; callers may supply only the adopted commit. */
export function parseManagedFileConfig(input: unknown, repositoryIds?: readonly string[]): ManagedFileConfig {
  if (!object(input)) fail();
  keys(input, ['schemaVersion', 'repositories']);
  if (input.schemaVersion !== 1 || !object(input.repositories) || !Object.keys(input.repositories).length) fail();
  for (const [id, rules] of Object.entries(input.repositories)) {
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) || repositoryIds && !repositoryIds.includes(id) || !Array.isArray(rules) || !rules.length) fail();
    const destinations = new Set<string>();
    for (const rule of rules) {
      if (!object(rule)) fail();
      keys(rule, ['source', 'destination', 'mode', 'dependencyFields', 'sourceRepository'], ['sourceSha', 'renderer', 'profile', 'startMarker', 'endMarker', 'adoptionBeforeBlob']);
      if (typeof rule.source !== 'string' || typeof rule.destination !== 'string') fail();
      safeManagedPath(rule.source); safeManagedPath(rule.destination);
      if (destinations.has(rule.destination.toLowerCase()) || rule.destination === '.github/steward-adoption.json') fail();
      destinations.add(rule.destination.toLowerCase());
      if (rule.sourceRepository === 'splrad/steward') { if (Object.hasOwn(rule, 'sourceSha')) fail(); }
      else if (rule.sourceRepository !== 'splrad/.github' || !/^[a-f0-9]{40}$/.test(rule.sourceSha ?? '')) fail();
      if (!['whole', 'section'].includes(rule.mode) || !Array.isArray(rule.dependencyFields)) fail();
      if (rule.mode === 'section') {
        if (typeof rule.startMarker !== 'string' || typeof rule.endMarker !== 'string' || !rule.startMarker || !rule.endMarker || rule.startMarker === rule.endMarker
          || /[\r\n]/.test(rule.startMarker + rule.endMarker) || rule.dependencyFields.length) fail();
      } else if (Object.hasOwn(rule, 'startMarker') || Object.hasOwn(rule, 'endMarker')) fail();
      const fields = new Set<string>();
      for (const field of rule.dependencyFields) {
        if (!object(field)) fail(); keys(field, ['jobId', 'stepId', 'path']);
        if (![field.jobId, field.stepId].every(v => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(v)) || !Array.isArray(field.path)
          || !(field.path.length === 1 && field.path[0] === 'uses' || field.path.length === 2 && field.path[0] === 'with' && typeof field.path[1] === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(field.path[1]))) fail();
        const key = JSON.stringify([field.jobId, field.stepId, field.path]); if (fields.has(key)) fail(); fields.add(key);
      }
      if (Object.hasOwn(rule, 'adoptionBeforeBlob') && (rule.renderer !== 'review' || rule.destination !== 'AGENTS.md' || rule.mode !== 'section' || !/^[a-f0-9]{40}$/.test(rule.adoptionBeforeBlob))) fail();
      if (rule.renderer !== undefined && !['review', 'policy-ref', 'release-please'].includes(rule.renderer)) fail();
      if (rule.renderer === 'review') {
        if (rule.sourceRepository !== 'splrad/steward' || rule.source !== 'config/review/rules.json' || !['steward', 'layerscape', 'github'].includes(rule.profile)) fail();
      } else if (Object.hasOwn(rule, 'profile')) fail();
      if (rule.renderer === 'release-please' && (rule.sourceRepository !== 'splrad/steward' || rule.source !== 'config/release/defaults.json' || rule.destination !== 'release-please-config.json' || rule.mode !== 'whole' || rule.dependencyFields.length)) fail();
      if (rule.renderer === 'policy-ref' && (rule.sourceRepository !== 'splrad/steward' || rule.destination !== '.github/workflows/steward-release-publish.yml')) fail();
    }
  }
  return structuredClone(input) as ManagedFileConfig;
}
