import { createHash } from 'node:crypto';
import type { FrozenRelease } from './release-note-receipt.js';

export interface PersonalSection { id: string; type: 'asset-table' | 'bullet-list'; slot: 'beforeActions' | 'afterChanges'; title: string; items: string[] }
export interface FrozenPersonalization { repositoryId: number; fullName: string; enabled: boolean; sections: PersonalSection[]; digest: string }
const fail = () => { throw new Error('RN_PERSONALIZATION_INVALID'); };
const stable = (v: any): string => JSON.stringify(v, (_k, x) => x && !Array.isArray(x) && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const digest = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex');
const exact = (v: any, keys: string[]) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== keys.sort().join()) fail(); };
const prose = (v: unknown) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 1000 && !/[\x00-\x1f<>\[\]`|#\\]|https?:/i.test(v);
export function freezePersonalization(repositoryId: number, fullName: string, profile?: any): FrozenPersonalization {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) fail();
  if (profile && (profile.repository?.id !== repositoryId || profile.repository?.fullName !== fullName)) fail();
  const config = profile?.releaseNotes?.personalization ?? { enabled: false, sections: [] };
  exact(config, ['enabled', 'sections']);
  if (typeof config.enabled !== 'boolean' || !Array.isArray(config.sections) || config.sections.length > 16 || (config.enabled ? !config.sections.length : config.sections.length)) fail();
  const ids = new Set<string>(), titles = new Set<string>();
  for (const s of config.sections) {
    exact(s, ['id', 'type', 'slot', 'title', 'items']);
    if (!/^[a-z][a-z0-9-]*$/.test(s.id) || ids.has(s.id) || titles.has(s.title) || !prose(s.title)
      || !['asset-table', 'bullet-list'].includes(s.type) || !['beforeActions', 'afterChanges'].includes(s.slot)
      || s.type === 'asset-table' && s.slot !== 'beforeActions'
      || !Array.isArray(s.items) || !s.items.length || s.items.length > 64 || new Set(s.items).size !== s.items.length) fail();
    ids.add(s.id); titles.add(s.title);
    for (const item of s.items) if (s.type === 'asset-table' ? !/^[a-z][a-z0-9-]*$/.test(item) : !prose(item)) fail();
  }
  const value = { repositoryId, fullName, enabled: config.enabled, sections: structuredClone(config.sections) };
  return { ...value, digest: digest(value) };
}
export function validatePersonalization(p: FrozenPersonalization, repositoryId: number, fullName: string): void {
  exact(p, ['repositoryId', 'fullName', 'enabled', 'sections', 'digest']);
  const expected = freezePersonalization(repositoryId, fullName, { repository: { id: p.repositoryId, fullName: p.fullName }, releaseNotes: { personalization: { enabled: p.enabled, sections: p.sections } } });
  if (stable(p) !== stable(expected)) fail();
}
export function assertPersonalizationConfiguration(f: FrozenRelease, configuration: any, profiles: Record<string, any>): void {
  const name = configuration.delivery?.githubRelease?.profile;
  if (name && !profiles[name]) fail();
  const expected = freezePersonalization(f.repositoryId, f.fullName, name ? profiles[name] : undefined);
  // Older disabled receipts retain their original digest; enabling always requires a new freeze.
  const actual = f.personalization ?? freezePersonalization(f.repositoryId, f.fullName);
  validatePersonalization(actual, f.repositoryId, f.fullName);
  if (stable(actual) !== stable(expected)) fail();
}
export function personalizedSections(f: FrozenRelease): { slot: PersonalSection['slot']; markdown: string; links: string[] }[] {
  if (!f.personalization) return [];
  validatePersonalization(f.personalization, f.repositoryId, f.fullName);
  return f.personalization.sections.map(s => {
    const links: string[] = [];
    const lines = s.type === 'bullet-list' ? s.items.map(t => `- ${t}`).join('\n') : '| 文件 | 大小（字节） |\n| --- | ---: |\n' + s.items.map(id => {
      const found = f.manifests.flatMap(m => m.artifacts).filter(a => a.id === id && a.kind === 'file');
      if (found.length !== 1 || found[0]!.kind !== 'file') fail();
      const a = found[0]!;
      if (a.kind !== 'file' || !f.assets.some(x => x.name === a.file && x.size === a.size && x.sha256 === a.sha256)) return fail();
      const url = `https://github.com/${f.fullName}/releases/download/${f.targetTag}/${encodeURIComponent(a.file)}`;
      links.push(url); return `| [${a.file}](${url}) | ${a.size} |`;
    }).join('\n');
    return { slot: s.slot, markdown: `### ${s.title}\n\n${lines}\n\n`, links };
  });
}
/** Rebuild revisions update only centrally rendered asset details, retaining human prose. */
export function refreshPersonalizedSections(notes: string, previous: FrozenRelease, next: FrozenRelease): string {
  if (stable(previous.personalization) !== stable(next.personalization)) fail();
  const before = personalizedSections(previous), after = personalizedSections(next);
  for (let i = 0; i < before.length; i++) {
    if (notes.split(before[i]!.markdown).length !== 2) fail();
    notes = notes.replace(before[i]!.markdown, after[i]!.markdown);
  }
  return notes;
}
