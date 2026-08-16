import { minimatch } from 'minimatch';

export interface PublicLabelDefinition { name: string; color: string; description: string }
export interface ReleaseCategory { title: string; icon: string; releaseLabel: string; labels: string[]; textPatterns: string[]; installOrPackage: boolean; fallback: boolean }
export interface ClassificationProfile {
  name: string;
  areas: { name: string; patterns: string[] }[];
  decisions: { kindOrder: string[]; conventionalTypes: string[]; typeToKind: Record<string, string>; breakingPatterns: string[]; securityPatterns: string[]; fallbackKind: string };
  runtimeRelease: { includePrefixes: string[]; includeFiles: string[]; excludePrefixes: string[]; excludeFiles: string[] };
  installOrPackage: { includeFiles: string[] };
  labels: { public: PublicLabelDefinition[]; release: string[]; internalPrefixes: string[] };
  releaseCategories: ReleaseCategory[];
}

export interface ClassificationFacts { title: string; body: string; files: string[]; currentLabels: string[] }
export interface ClassificationResult { areas: string[]; kind: string; publicLabels: string[]; releaseLabels: string[]; runtimeRelease: boolean; installOrPackage: boolean }
export interface ManagedLabelPlan { ensure: PublicLabelDefinition[]; add: string[]; remove: string[]; keep: string[] }

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true, nocase: false }));
}

function patternHit(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, 'iu').test(text));
}

export function classifyPullRequest(profile: ClassificationProfile, facts: ClassificationFacts): ClassificationResult {
  if (!facts.files.length) throw new Error('分类需要完整文件集合');
  const areas = profile.areas.filter((area) => facts.files.some((file) => matchesAny(file, area.patterns))).map((area) => area.name);
  const text = `${facts.title}\n${facts.body}`;
  let kind: string | undefined;
  if (patternHit(text, profile.decisions.breakingPatterns)) kind = 'breaking-change';
  else if (patternHit(text, profile.decisions.securityPatterns)) kind = 'security';
  else {
    const conventional = /^([a-z]+)(?:\([a-z0-9-]+\))?!?:/iu.exec(facts.title)?.[1]?.toLowerCase();
    if (conventional && profile.decisions.conventionalTypes.includes(conventional)) kind = profile.decisions.typeToKind[conventional];
  }
  if (!kind && facts.files.every((file) => matchesAny(file, ['README*', 'SECURITY*', 'CONTRIBUTING*', 'docs/**']))) kind = 'documentation';
  if (!kind && profile.labels.public.some((item) => item.name === 'workflow') && facts.files.every((file) => matchesAny(file, ['.github/workflows/**']))) kind = 'workflow';
  kind ??= profile.decisions.fallbackKind;
  if (!profile.decisions.kindOrder.includes(kind)) throw new Error(`分类类型不在固定顺序中: ${kind}`);
  const publicLabels = [kind];
  const releaseLabels = profile.labels.release.includes(kind) ? [kind] : [];
  const runtimeRelease = facts.files.some((file) =>
    !profile.runtimeRelease.excludeFiles.includes(file)
    && !profile.runtimeRelease.excludePrefixes.some((prefix) => file.startsWith(prefix))
    && (profile.runtimeRelease.includeFiles.includes(file) || profile.runtimeRelease.includePrefixes.some((prefix) => file.startsWith(prefix))));
  const installOrPackage = facts.files.some((file) => profile.installOrPackage.includeFiles.includes(file));
  return { areas, kind, publicLabels, releaseLabels, runtimeRelease, installOrPackage };
}

export function reconcileManagedLabels(profile: ClassificationProfile, current: readonly string[], result: ClassificationResult): ManagedLabelPlan {
  const managed = new Set(profile.labels.public.map((item) => item.name));
  const desired = new Set(result.publicLabels);
  const currentSet = new Set(current);
  return {
    ensure: profile.labels.public,
    add: [...desired].filter((name) => !currentSet.has(name)).sort(),
    remove: [...currentSet].filter((name) => managed.has(name) && !desired.has(name)).sort(),
    keep: [...currentSet].filter((name) => !managed.has(name)).sort(),
  };
}

export function classifyReleasePullRequest(profile: ClassificationProfile, facts: ClassificationFacts, classification: ClassificationResult): ReleaseCategory | null {
  if (!classification.runtimeRelease) return null;
  const text = `${facts.title}\n${facts.body}`;
  const labels = new Set([...facts.currentLabels, ...classification.releaseLabels]);
  return profile.releaseCategories.find((category) =>
    category.labels.some((label) => labels.has(label))
    || patternHit(text, category.textPatterns)
    || (category.installOrPackage && classification.installOrPackage))
    ?? profile.releaseCategories.find((category) => category.fallback)
    ?? null;
}
